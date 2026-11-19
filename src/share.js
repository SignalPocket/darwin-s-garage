// Share links. A genome plus its generation and track fully determines a run —
// physics is deterministic given a fixed timestep — so that triple is the whole
// shareable unit and needs no server or database row.
//
// Encoding is compact by design: a URL that wraps across three lines in a chat
// window does not get clicked. Coordinates are rounded to whole pixels (well
// under what is visible) and packed positionally rather than as JSON keys.

import {
  normalizeGenome,
  isValidGenome,
  LEGACY_WHEEL_SHAPES,
  regularWheelShape,
} from './genome.js';
import { DEFAULT_TRACK_ID } from './track.js';

export const SHARE_PARAM = 'car';
const FORMAT_VERSION = 3;

// Every way a link can arrive damaged looks identical to the person holding it,
// so they all get the one message that names the likely cause.
const UNREADABLE = "This share link isn't readable. It may have been cut short when copied.";

/**
 * Encode a run into a compact URL-safe string.
 * @param {{genome: object, generation?: number, trackId?: string}} run
 * @returns {string}
 */
export function encodeShare({ genome, generation = 0, trackId = DEFAULT_TRACK_ID }) {
  const safe = normalizeGenome(genome);
  if (!Number.isInteger(generation) || generation < 0) {
    throw new RangeError(`encodeShare: generation must be a non-negative integer, got ${generation}`);
  }
  const body = [
    FORMAT_VERSION,
    generation,
    trackId,
    safe.chassis.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';'),
    // Torque keeps three decimals: its whole gene range is 0-0.12, so rounding
    // any harder would quantize the drive away.
    safe.wheels
      .map(
        (w) =>
          `${w.vertexIndex},${Math.round(w.radius)},${w.torque.toFixed(3)},${encodeWheelShape(w.shape)}`,
      )
      .join(';'),
  ].join('|');
  return toBase64Url(`${body}|${checksum(body)}`);
}

/**
 * Decode a share string.
 * @param {string} encoded
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 *   Never throws: a bad link is a designed error state in the UI, not a crash.
 */
export function decodeShare(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    return fail('This share link is empty.');
  }
  let payload;
  try {
    payload = fromBase64Url(encoded);
  } catch {
    return fail(UNREADABLE);
  }

  const parts = payload.split('|');
  if (parts.length !== 6) {
    return fail(UNREADABLE);
  }
  // Verify the tail before trusting any field. Dropping characters off the end
  // of a link usually still parses: a four-wheel car quietly arrives as a
  // three-wheel one, which is worse than refusing it.
  const body = parts.slice(0, 5).join('|');
  if (parts[5] !== checksum(body)) {
    return fail(UNREADABLE);
  }
  const [rawVersion, rawGeneration, trackId, rawChassis, rawWheels] = parts;

  const version = Number(rawVersion);
  if (version !== 1 && version !== 2 && version !== FORMAT_VERSION) {
    return fail(`This link uses share format ${rawVersion}, which this version can't open.`);
  }
  const generation = Number(rawGeneration);
  if (!Number.isInteger(generation) || generation < 0) {
    return fail('This share link points at an impossible generation.');
  }
  if (!trackId) return fail('This share link is missing its track.');

  const chassis = rawChassis.split(';').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return { x, y };
  });
  const wheels = rawWheels.split(';').map((packedWheel) => {
    const [rawVertexIndex, rawRadius, rawTorque, rawShape] = packedWheel.split(',');
    return {
      vertexIndex: Number(rawVertexIndex),
      radius: Number(rawRadius),
      torque: Number(rawTorque),
      shape: decodeLegacyWheelShape(version, rawShape),
    };
  });

  if (!isValidGenome({ chassis, wheels })) {
    return fail("This share link describes a car that couldn't be built.");
  }
  return { ok: true, value: { genome: normalizeGenome({ chassis, wheels }), generation, trackId } };
}

function decodeLegacyWheelShape(version, rawShape) {
  if (version === 1) return 'circle';
  if (version === 2) {
    const shape = LEGACY_WHEEL_SHAPES[Number(rawShape)];
    return shape === 'circle' ? regularWheelShape(8) : shape ?? 'invalid';
  }
  return decodeWheelShape(rawShape);
}

/** Build a full shareable URL against the page's own location. */
export function shareUrl(run, base) {
  const url = new URL(base);
  url.searchParams.set(SHARE_PARAM, encodeShare(run));
  return url.toString();
}

/**
 * Read a share out of a URL. Returns null when there is no share param at all,
 * which is the ordinary case and not an error.
 */
export function readShare(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const encoded = url.searchParams.get(SHARE_PARAM);
  if (encoded === null) return null;
  return decodeShare(encoded);
}

function fail(error) {
  return { ok: false, error };
}

/**
 * FNV-1a over the payload body, in base36. This guards against a link that lost
 * its tail between a chat client and the address bar, not against tampering:
 * anyone can recompute it, and a hand-built genome still has to clear
 * isValidGenome below.
 */
function checksum(body) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function encodeWheelShape(points) {
  return points
    .map((point) => {
      const x = Math.round((point.x + 1) * 1000).toString(36).padStart(3, '0');
      const y = Math.round((point.y + 1) * 1000).toString(36).padStart(3, '0');
      return `${x}${y}`;
    })
    .join('');
}

function decodeWheelShape(encoded) {
  if (typeof encoded !== 'string' || encoded.length % 6 !== 0) return null;
  const points = [];
  for (let i = 0; i < encoded.length; i += 6) {
    const x = Number.parseInt(encoded.slice(i, i + 3), 36);
    const y = Number.parseInt(encoded.slice(i + 3, i + 6), 36);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x > 2000 || y > 2000) return null;
    points.push({ x: x / 1000 - 1, y: y / 1000 - 1 });
  }
  return points;
}

// btoa/atob only exist in the browser and only speak latin1; Buffer only exists
// in Node. Supporting both keeps the encoder unit-testable outside a browser.
function toBase64Url(text) {
  const base64 =
    typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(text)))
      : Buffer.from(text, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded) {
  if (!/^[A-Za-z0-9\-_]+$/.test(encoded)) throw new Error('not base64url');
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const text =
    typeof atob === 'function'
      ? decodeURIComponent(escape(atob(base64)))
      : Buffer.from(base64, 'base64').toString('utf8');
  if (!text) throw new Error('empty payload');
  return text;
}
