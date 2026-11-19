// A genome describes one vehicle: a polygonal chassis plus a set of wheels,
// each attached at a chassis vertex with its own radius, motor torque, and shape. The
// evolution engine, the physics builder, and the share-link encoder all consume
// this shape, so it stays plain JSON-serializable data rather than a class.

import { randomInt, randomFloat } from './rng.js';

export const GENOME_LIMITS = Object.freeze({
  minVertices: 4,
  maxVertices: 8,
  minWheels: 2,
  maxWheels: 4,
  minWheelRadius: 10,
  maxWheelRadius: 35,
  minWheelVertices: 3,
  maxWheelVertices: 36,
  // Zero is a real gene, not a floor to clamp away: an undriven wheel that just
  // rolls is often the better design, and evolution should be free to find that.
  minTorque: 0,
  maxTorque: 0.12,
  chassisRadius: 60,
  minVertexRadius: 15,
  maxVertexRadius: 110,
  // Reject pin-sized and beam-like chassis instead of rewarding their
  // accidental physics. Both chassis extents use pixels; wheel area is in
  // normalized [-1, 1] outline coordinates.
  minChassisHullArea: 1800,
  minChassisHullExtent: 30,
  minWheelHullArea: 0.5,
});

export const LEGACY_WHEEL_SHAPES = Object.freeze(['circle', 'triangle', 'square', 'hexagon']);
const DEFAULT_CIRCLE_VERTICES = 24;
const MAX_INITIAL_WHEEL_VERTICES = 12;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Genomes live on a fixed grid: whole pixels for geometry, three decimals for
// torque. This is what makes a share link lossless — physics is chaotic, so a
// link that rounded coordinates on the way out would replay a visibly different
// run from the one that was scored. Quantizing at the source instead means the
// encoded car IS the car. The grid is far finer than the mutation jitter, so it
// costs the search nothing.
// Math.round(-0.3) is -0, which survives JSON, compares unequal to 0 under
// Object.is, and would make a decoded genome differ from its original over a
// value that means nothing. Collapse it.
function unsignZero(value) {
  return value === 0 ? 0 : value;
}

export function quantizeLength(value) {
  return unsignZero(Math.round(value));
}

export function quantizeTorque(value) {
  return unsignZero(Math.round(value * 1000) / 1000);
}

export function quantizeWheelPoint(value) {
  return unsignZero(Math.round(value * 1000) / 1000);
}

/**
 * Build a random genome from a seeded rng.
 * Chassis vertices are laid out around a circle with per-vertex jitter, which
 * keeps generation 0 varied without producing degenerate slivers.
 * @param {() => number} rng
 */
export function createRandomGenome(rng) {
  assertRng(rng, 'createRandomGenome');
  const { minWheels, maxWheels, chassisRadius } = GENOME_LIMITS;

  const vertexCount = 5;
  const chassis = Array.from({ length: vertexCount }, (_, i) => {
    const angle = (i / vertexCount) * Math.PI * 2;
    const jitter = 0.5 + rng();
    return {
      x: Math.cos(angle) * chassisRadius * jitter,
      y: Math.sin(angle) * chassisRadius * jitter,
    };
  });

  const wheelCount = randomInt(rng, minWheels, maxWheels);
  const wheels = Array.from({ length: wheelCount }, () => ({
    vertexIndex: randomInt(rng, 0, vertexCount - 1),
    radius: randomFloat(rng, GENOME_LIMITS.minWheelRadius, GENOME_LIMITS.maxWheelRadius),
    torque: randomFloat(rng, GENOME_LIMITS.minTorque, GENOME_LIMITS.maxTorque),
    shape: regularWheelShape(
      randomInt(rng, GENOME_LIMITS.minWheelVertices, MAX_INITIAL_WHEEL_VERTICES),
    ),
  }));

  // Normalized on the way out so every genome in the system — random, bred, or
  // decoded from a link — is already on the canonical grid.
  return normalizeGenome({ chassis, wheels });
}

/**
 * Force a genome back inside its limits. Every operator that produces a genome
 * (crossover, mutation, share-link decoding) runs its output through this, so
 * downstream physics never has to defend against an impossible car.
 * @param {object} genome
 */
export function normalizeGenome(genome) {
  if (!genome || typeof genome !== 'object') {
    throw new TypeError('normalizeGenome: genome must be an object');
  }
  const { chassis, wheels } = genome;
  if (!Array.isArray(chassis) || !Array.isArray(wheels)) {
    throw new TypeError('normalizeGenome: genome needs chassis and wheels arrays');
  }

  const points = chassis
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => clampVertex(p));
  if (points.length < GENOME_LIMITS.minVertices) {
    throw new RangeError(
      `normalizeGenome: chassis needs at least ${GENOME_LIMITS.minVertices} valid vertices, got ${points.length}`,
    );
  }
  const nextChassis = points.slice(0, GENOME_LIMITS.maxVertices);
  if (isDegenerate(nextChassis)) {
    throw new RangeError('normalizeGenome: chassis vertices must not all fall on one line');
  }

  const nextWheels = wheels
    .filter((w) => w && Number.isFinite(w.radius) && Number.isFinite(w.vertexIndex))
    .slice(0, GENOME_LIMITS.maxWheels)
    .map((w) => {
      const radius = quantizeLength(
        clamp(w.radius, GENOME_LIMITS.minWheelRadius, GENOME_LIMITS.maxWheelRadius),
      );
      let shape;
      try {
        shape = normalizeWheelShape(w.shape);
      } catch {
        return null;
      }
      return {
        vertexIndex: clamp(Math.round(w.vertexIndex), 0, nextChassis.length - 1),
        radius,
        torque: quantizeTorque(
          clamp(
            Number.isFinite(w.torque) ? w.torque : GENOME_LIMITS.minTorque,
            GENOME_LIMITS.minTorque,
            GENOME_LIMITS.maxTorque,
          ),
        ),
        shape,
      };
    })
    .filter(Boolean);
  if (nextWheels.length < GENOME_LIMITS.minWheels) {
    throw new RangeError(
      `normalizeGenome: genome needs at least ${GENOME_LIMITS.minWheels} valid wheels, got ${nextWheels.length}`,
    );
  }

  return { chassis: nextChassis, wheels: nextWheels };
}

/** True when a genome satisfies every structural limit. */
export function isValidGenome(genome) {
  try {
    normalizeGenome(genome);
    return true;
  } catch {
    return false;
  }
}

/** Explain whether a genome has enough real shape to build a useful vehicle. */
export function assessGenomeViability(genome) {
  let safe;
  try {
    safe = normalizeGenome(genome);
  } catch {
    return { viable: false, reason: 'invalid-genome' };
  }

  const chassisHull = convexHull(safe.chassis);
  const chassisBounds = bounds(chassisHull);
  if (
    polygonArea(chassisHull) < GENOME_LIMITS.minChassisHullArea ||
    chassisBounds.width < GENOME_LIMITS.minChassisHullExtent ||
    chassisBounds.height < GENOME_LIMITS.minChassisHullExtent
  ) {
    return { viable: false, reason: 'chassis-too-small' };
  }

  for (const [wheelIndex, wheel] of safe.wheels.entries()) {
    if (polygonArea(convexHull(wheel.shape)) < GENOME_LIMITS.minWheelHullArea) {
      return { viable: false, reason: 'wheel-outline-too-thin', wheelIndex };
    }
  }
  return { viable: true, reason: null };
}

/** Whether the normalized chassis and every wheel outline have useful area. */
export function isViableGenome(genome) {
  return assessGenomeViability(genome).viable;
}

/** Deep copy — genomes are passed between generations and must not alias. */
export function cloneGenome(genome) {
  return {
    chassis: genome.chassis.map((p) => ({ x: p.x, y: p.y })),
    wheels: genome.wheels.map((w) => ({
      ...w,
      shape: w.shape.map((point) => ({ ...point })),
    })),
  };
}

export function regularWheelShape(vertexCount) {
  return Array.from({ length: vertexCount }, (_, i) => {
    const angle = ((i + 0.5) / vertexCount) * Math.PI * 2;
    return {
      x: quantizeWheelPoint(Math.cos(angle)),
      y: quantizeWheelPoint(Math.sin(angle)),
    };
  });
}

function normalizeWheelShape(shape) {
  if (shape === undefined || shape === 'circle') {
    return regularWheelShape(DEFAULT_CIRCLE_VERTICES);
  }
  if (typeof shape === 'string') {
    const legacySides = { triangle: 3, square: 4, hexagon: 6 }[shape];
    if (!legacySides) throw new TypeError('wheel shape is invalid');
    return regularWheelShape(legacySides);
  }
  if (!Array.isArray(shape)) throw new TypeError('wheel shape must be a point array');

  const points = shape
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice(0, GENOME_LIMITS.maxWheelVertices)
    .map((point) => ({
      x: quantizeWheelPoint(clamp(point.x, -1, 1)),
      y: quantizeWheelPoint(clamp(point.y, -1, 1)),
    }));
  if (points.length < GENOME_LIMITS.minWheelVertices || isDegenerate(points)) {
    throw new RangeError('wheel shape needs at least three non-collinear points');
  }
  return points;
}

// A chassis that hulls to zero area (every vertex on one line, or all
// coincident) divides by zero inside Matter's Vertices.centre downstream,
// which is what produces NaN outlines instead of a build failure. Chassis
// coordinates are always whole pixels by the time this runs, so any
// non-degenerate polygon has a cross product of at least 1 — no tolerance
// needed for float noise.
function isDegenerate(points) {
  const [origin] = points;
  let direction = null;
  for (const point of points.slice(1)) {
    const candidate = { x: point.x - origin.x, y: point.y - origin.y };
    if (candidate.x !== 0 || candidate.y !== 0) {
      direction = candidate;
      break;
    }
  }
  if (!direction) return true;
  return points.every((point) => {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    return direction.x * dy - direction.y * dx === 0;
  });
}

function convexHull(points) {
  const sorted = [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()]
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 1) return sorted;
  const cross = (origin, a, b) =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower = [];
  const upper = [];
  for (const point of sorted) {
    while (lower.length > 1 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  for (const point of [...sorted].reverse()) {
    while (upper.length > 1 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function polygonArea(points) {
  if (points.length < 3) return 0;
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(twiceArea) / 2;
}

function bounds(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function clampVertex(point) {
  const distance = Math.hypot(point.x, point.y);
  const { minVertexRadius, maxVertexRadius } = GENOME_LIMITS;
  if (distance >= minVertexRadius && distance <= maxVertexRadius) {
    return { x: quantizeLength(point.x), y: quantizeLength(point.y) };
  }
  // A vertex at the origin has no direction to push out along; nudge it right.
  const angle = distance === 0 ? 0 : Math.atan2(point.y, point.x);
  const target = clamp(distance, minVertexRadius, maxVertexRadius);
  return {
    x: quantizeLength(Math.cos(angle) * target),
    y: quantizeLength(Math.sin(angle) * target),
  };
}

function assertRng(rng, caller) {
  if (typeof rng !== 'function') {
    throw new TypeError(`${caller}: rng must be a function`);
  }
}
