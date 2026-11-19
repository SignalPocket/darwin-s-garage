// A track is plain data: an ordered list of control points that the physics
// builder turns into static terrain segments and the editor lets you drag.
// Same spirit as the genome — serializable, swappable, and independent of
// Matter.js. Y grows downward (canvas convention), so lower y is higher ground.

import { createRng, randomFloat } from './rng.js';

export const TRACK_LIMITS = Object.freeze({
  minPoints: 2,
  maxPoints: 1024,
  minX: 0,
  maxX: 300000,
  minY: -1200,
  maxY: 1200,
});

export const DEFAULT_TRACK_ID = 'default-hill';
export const DEFAULT_COURSE_LENGTH = 1200;
export const COURSE_LIMITS = Object.freeze({
  minLength: 100,
  maxLength: 30000,
  minTerrainSetting: 0,
  maxTerrainSetting: 100,
});
export const DEFAULT_TERRAIN_SETTING = 50;

/**
 * The built-in hill-climb course. Deliberately shaped as a story: a flat run-up
 * where generation 0 can't even get moving, a rubble field that filters out the
 * shapes that only topple forward, then the climb, and finally a sharp lip at
 * the crest — evolution never has to handle it to score well, which is why the
 * champion so often noses over there.
 */
export function createDefaultTrack({
  length = DEFAULT_COURSE_LENGTH,
  roughness = DEFAULT_TERRAIN_SETTING,
  steepness = DEFAULT_TERRAIN_SETTING,
  obstacleFrequency = DEFAULT_TERRAIN_SETTING,
  seed = 1,
} = {}) {
  if (
    !Number.isInteger(length) ||
    length < COURSE_LIMITS.minLength ||
    length > COURSE_LIMITS.maxLength
  ) {
    throw new RangeError(
      `createDefaultTrack: length must be an integer from ${COURSE_LIMITS.minLength} to ${COURSE_LIMITS.maxLength} meters`,
    );
  }
  for (const [name, value] of Object.entries({ roughness, steepness, obstacleFrequency })) {
    if (
      !Number.isInteger(value) ||
      value < COURSE_LIMITS.minTerrainSetting ||
      value > COURSE_LIMITS.maxTerrainSetting
    ) {
      throw new RangeError(`createDefaultTrack: ${name} must be an integer from 0 to 100`);
    }
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('createDefaultTrack: seed must be an integer from 0 to 4294967295');
  }

  const roughnessScale = terrainScale(roughness);
  const steepnessScale = terrainScale(steepness);
  const frequencyScale = 0.25 + (obstacleFrequency / 100) * 1.5;
  const rng = createRng(seed);
  // Keep the tuned seed-1 benchmark unchanged while letting all other seeds
  // perturb the same terrain points deterministically.
  const baselineRng = createRng(1);
  const finish = length * 10;
  const basePoints = [
    { x: -400, y: 0 },
    { x: 150, y: 0 },
    { x: 300, y: 35 },
    { x: 440, y: -58 },
    { x: 580, y: 35 },
    { x: 720, y: -58 },
    { x: 860, y: 35 },
    { x: 1000, y: -58 },
    { x: 1140, y: 35 },
    { x: 1280, y: -58 },
    { x: 1600, y: 0 },
    { x: 2190, y: -39 },
    { x: 2480, y: -88 },
    { x: 2770, y: -148 },
    { x: 3060, y: -218 },
    { x: 3350, y: -297 },
    { x: 3640, y: -388 },
    { x: 3930, y: -488 },
    { x: 4220, y: -598 },
    { x: 4510, y: -719 },
    { x: 4800, y: -850 },
    { x: 5000, y: -820 },
    { x: 5200, y: -670 },
    { x: 5700, y: -430 },
    { x: 6400, y: -290 },
    { x: 7200, y: -250 },
  ].map((point) => {
    const terrainSetting = point.x <= 1600 ? roughnessScale : steepnessScale;
    const varied =
      point.x >= 300
        ? (randomFloat(rng, -1, 1) - randomFloat(baselineRng, -1, 1)) * terrainSetting * 24
        : 0;
    return { x: point.x, y: point.y * terrainSetting + varied };
  });
  const points = basePoints.filter((point) => point.x < finish);

  if (finish <= 7200) {
    const last = basePoints.find((point) => point.x === finish);
    if (last) {
      points.push(last);
    } else {
      const endIndex = basePoints.findIndex((point) => point.x > finish);
      const a = basePoints[endIndex - 1];
      const b = basePoints[endIndex];
      const ratio = (finish - a.x) / (b.x - a.x);
      points.push({ x: finish, y: a.y + (b.y - a.y) * ratio });
    }
  } else {
    const remaining = finish - 7200;
    const intervalCount = Math.ceil((remaining / 600) * frequencyScale);
    const interval = remaining / intervalCount;
    for (let i = 1; i < intervalCount; i += 1) {
      const x = 7200 + i * interval;
      const section = (x - 7200) / 600;
      const rolling = Math.sin(section * 0.82 * frequencyScale) * 145 * steepnessScale;
      const rubble = Math.sin(section * 2.37 * frequencyScale) * 54 * roughnessScale;
      const longClimb =
        Math.max(0, Math.sin((section - 2) * 0.28 * frequencyScale)) *
        -90 *
        steepnessScale;
      const variation =
        (randomFloat(rng, -1, 1) - randomFloat(baselineRng, -1, 1)) * roughnessScale * 30;
      points.push({ x, y: -250 * steepnessScale + rolling + rubble + longClimb + variation });
    }
    points.push({
      x: finish,
      y: -250 * steepnessScale,
    });
  }
  const id = `hill-${length}-r${roughness}-s${steepness}-o${obstacleFrequency}-q${seed}`;
  return {
    id,
    name: 'The Hill',
    builtIn: true,
    length,
    roughness,
    steepness,
    obstacleFrequency,
    seed,
    points,
  };
}

/** Recover adjustable course settings from a share-link track identifier. */
export function courseSettingsFromTrackId(id) {
  if (id === DEFAULT_TRACK_ID) {
    return {
      length: 720,
      roughness: DEFAULT_TERRAIN_SETTING,
      steepness: DEFAULT_TERRAIN_SETTING,
      obstacleFrequency: DEFAULT_TERRAIN_SETTING,
      seed: 1,
    };
  }
  const custom = /^hill-(\d+)-r(\d+)-s(\d+)-o(\d+)-q(\d+)$/.exec(id);
  if (custom) {
    const [, rawLength, rawRoughness, rawSteepness, rawFrequency, rawSeed] = custom;
    const settings = {
      length: Number(rawLength),
      roughness: Number(rawRoughness),
      steepness: Number(rawSteepness),
      obstacleFrequency: Number(rawFrequency),
      seed: Number(rawSeed),
    };
    try {
      createDefaultTrack(settings);
      return settings;
    } catch {
      return null;
    }
  }

  // Links from the temporary preset-based course controls remain readable.
  const legacy = /^hill-(\d+)-(easy|standard|hard)$/.exec(id);
  if (!legacy) return null;
  const length = Number(legacy[1]);
  if (length < COURSE_LIMITS.minLength || length > COURSE_LIMITS.maxLength) return null;
  const setting = { easy: 30, standard: 50, hard: 77 }[legacy[2]];
  return {
    length,
    roughness: setting,
    steepness: setting,
    obstacleFrequency: DEFAULT_TERRAIN_SETTING,
    seed: 1,
  };
}

function terrainScale(setting) {
  return 0.25 + (setting / 100) * 1.5;
}

/**
 * Check a track's structure. Returns a list of human-readable problems; empty
 * means valid. The editor renders these inline rather than throwing, so a bad
 * drag shows a message instead of a blank canvas.
 * @param {object} track
 * @returns {string[]}
 */
export function validateTrack(track) {
  const problems = [];
  if (!track || typeof track !== 'object' || !Array.isArray(track.points)) {
    return ['Track must be an object with a points array.'];
  }
  const { points } = track;
  if (points.length < TRACK_LIMITS.minPoints) {
    problems.push(`A track needs at least ${TRACK_LIMITS.minPoints} points.`);
  }
  if (points.length > TRACK_LIMITS.maxPoints) {
    problems.push(`A track can have at most ${TRACK_LIMITS.maxPoints} points.`);
  }
  if (points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    problems.push('Every point needs finite x and y coordinates.');
  } else {
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].x === points[i - 1].x) {
        problems.push(`Two points share x = ${points[i].x}; terrain can't double back.`);
        break;
      }
      if (points[i].x < points[i - 1].x) {
        problems.push('Points must run left to right in ascending x.');
        break;
      }
    }
  }
  return problems;
}

/** True when validateTrack finds no problems. */
export function isValidTrack(track) {
  return validateTrack(track).length === 0;
}

/**
 * Sort points by x and drop duplicates, producing a track the physics builder
 * can always consume. Used by the editor after a drag reorders control points.
 */
export function normalizeTrack(track) {
  const problems = validateTrack({ ...track, points: track?.points ?? [] });
  if (!track || !Array.isArray(track.points)) {
    throw new TypeError(`normalizeTrack: ${problems[0] ?? 'invalid track'}`);
  }
  const points = track.points
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({
      x: Math.min(TRACK_LIMITS.maxX, Math.max(TRACK_LIMITS.minX - 400, p.x)),
      y: Math.min(TRACK_LIMITS.maxY, Math.max(TRACK_LIMITS.minY, p.y)),
    }))
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x)
    .slice(0, TRACK_LIMITS.maxPoints);

  if (points.length < TRACK_LIMITS.minPoints) {
    throw new RangeError(
      `normalizeTrack: need at least ${TRACK_LIMITS.minPoints} distinct points, got ${points.length}`,
    );
  }
  return { ...track, points };
}

/** The x coordinate a car must reach to finish: the last control point. */
export function finishX(track) {
  return track.points[track.points.length - 1].x;
}

/**
 * Terrain surface height at a given x, linearly interpolated between control
 * points. Outside the track's span the end segments extend flat.
 */
export function heightAt(track, x) {
  const { points } = track;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return last.y;
}

/** Consecutive point pairs, as the physics builder wants them. */
export function trackSegments(track) {
  const segments = [];
  for (let i = 1; i < track.points.length; i += 1) {
    segments.push({ a: track.points[i - 1], b: track.points[i] });
  }
  return segments;
}
