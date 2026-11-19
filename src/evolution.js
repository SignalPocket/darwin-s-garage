// Selection, crossover, and mutation. Pure data transforms over genomes — no
// physics, no Matter, no canvas. Every random choice comes from an injected
// seeded rng so a whole evolution run reproduces from its seed.

import {
  createRandomGenome,
  normalizeGenome,
  cloneGenome,
  isValidGenome,
  GENOME_LIMITS,
  clamp,
} from './genome.js';
import { randomInt, randomFloat } from './rng.js';

export const EVOLUTION_DEFAULTS = Object.freeze({
  populationSize: 24,
  // Fraction of the population copied into the next generation untouched. Without
  // it a lucky champion can be lost to a bad mutation and best-fitness regresses,
  // which reads as broken to someone scrubbing the generation slider.
  eliteCount: 2,
  mutationRate: 0.18,
  // Probability a breeding pair is actually spliced rather than the first
  // parent being cloned. Recombination is a source of novelty in its own right,
  // separate from mutation, so it gets its own dial.
  crossoverRate: 0.9,
  vertexJitter: 14,
  radiusJitter: 5,
  torqueJitter: 0.02,
  // Chance a mutation rewires a wheel to a different chassis vertex rather than
  // nudging a number — the structural move that finds four-wheel layouts.
  rewireChance: 0.25,
  vertexCountMutationChance: 0.2,
  wheelShapeMutationChance: 0.25,
  wheelShapeJitter: 0.2,
  tournamentSize: 3,
});

/** A generation-0 population of pure random genomes. */
export function createPopulation(rng, size = EVOLUTION_DEFAULTS.populationSize) {
  if (!Number.isInteger(size) || size < 2) {
    throw new RangeError(`createPopulation: size must be an integer >= 2, got ${size}`);
  }
  return Array.from({ length: size }, () => createRandomGenome(rng));
}

/**
 * Pick one parent by tournament: sample k individuals, return the fittest.
 * Tournament rather than fitness-proportionate selection because fitness here is
 * a raw distance — proportionate selection would barely distinguish 900 from
 * 1000, and would divide by zero when a whole generation scores 0.
 */
export function selectParent(population, fitnesses, rng, k = EVOLUTION_DEFAULTS.tournamentSize) {
  assertPopulation(population, fitnesses, 'selectParent');
  let bestIndex = randomInt(rng, 0, population.length - 1);
  for (let i = 1; i < k; i += 1) {
    const challenger = randomInt(rng, 0, population.length - 1);
    if (fitnesses[challenger] > fitnesses[bestIndex]) bestIndex = challenger;
  }
  return population[bestIndex];
}

/**
 * Recombine structural counts, chassis vertices, and individual wheel genes in
 * alternating segments of a seeded, shuffled gene order. One to three crossover
 * points switch which parent's genes fill each segment.
 */
export function crossover(parentA, parentB, rng) {
  const a = normalizeGenome(parentA);
  const b = normalizeGenome(parentB);
  const base = rng() < 0.5 ? a : b;
  const other = base === a ? b : a;
  const chromosome = crossoverGenes(a, b);
  for (let index = chromosome.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(rng, 0, index);
    [chromosome[index], chromosome[swapIndex]] = [chromosome[swapIndex], chromosome[index]];
  }
  const maxCrossovers = Math.min(3, chromosome.length - 1);
  const crossoverCount = randomInt(rng, 1, maxCrossovers);
  const crossoverPoints = new Set();
  while (crossoverPoints.size < crossoverCount) {
    crossoverPoints.add(randomInt(rng, 1, chromosome.length - 1));
  }

  const inherited = new Map();
  let useBase = rng() < 0.5;
  for (const [locus, gene] of chromosome.entries()) {
    if (crossoverPoints.has(locus)) useBase = !useBase;
    const source = useBase ? base : other;
    const fallback = useBase ? other : base;
    const value = geneValue(source, gene) ?? geneValue(fallback, gene);
    inherited.set(geneKey(gene), value);
  }

  const chassisCount = inherited.get(geneKey({ kind: 'chassisCount' }));
  const wheelCount = inherited.get(geneKey({ kind: 'wheelCount' }));
  const child = {
    chassis: Array.from({ length: chassisCount }, (_, index) =>
      inherited.get(geneKey({ kind: 'chassisVertex', index })),
    ),
    wheels: Array.from({ length: wheelCount }, (_, wheelIndex) => {
      const shapeCount = inherited.get(geneKey({ kind: 'wheelShapeCount', wheelIndex }));
      return {
        vertexIndex: inherited.get(geneKey({ kind: 'wheelVertex', wheelIndex })),
        radius: inherited.get(geneKey({ kind: 'wheelRadius', wheelIndex })),
        torque: inherited.get(geneKey({ kind: 'wheelTorque', wheelIndex })),
        shape: Array.from({ length: shapeCount }, (_, index) =>
          inherited.get(geneKey({ kind: 'wheelShapePoint', wheelIndex, index })),
        ),
      };
    }),
  };

  // Repair independently recombined outlines without discarding unrelated genes.
  if (!isValidGenome({ chassis: child.chassis, wheels: base.wheels })) {
    child.chassis = base.chassis.map((point) => ({ x: point.x, y: point.y }));
  }
  for (const [wheelIndex, wheel] of child.wheels.entries()) {
    if (!isValidGenome({ chassis: child.chassis, wheels: [wheel, wheel] })) {
      const fallbackWheel = base.wheels[wheelIndex] ?? other.wheels[wheelIndex];
      wheel.shape = fallbackWheel.shape.map((point) => ({ x: point.x, y: point.y }));
    }
  }
  return normalizeGenome(child);
}

function crossoverGenes(a, b) {
  const genes = [{ kind: 'chassisCount' }, { kind: 'wheelCount' }];
  const chassisVertexCount = Math.max(a.chassis.length, b.chassis.length);
  for (let index = 0; index < chassisVertexCount; index += 1) {
    genes.push({ kind: 'chassisVertex', index });
  }

  const wheelCount = Math.max(a.wheels.length, b.wheels.length);
  for (let wheelIndex = 0; wheelIndex < wheelCount; wheelIndex += 1) {
    genes.push(
      { kind: 'wheelVertex', wheelIndex },
      { kind: 'wheelRadius', wheelIndex },
      { kind: 'wheelTorque', wheelIndex },
      { kind: 'wheelShapeCount', wheelIndex },
    );
    const shapeVertexCount = Math.max(
      a.wheels[wheelIndex]?.shape.length ?? 0,
      b.wheels[wheelIndex]?.shape.length ?? 0,
    );
    for (let index = 0; index < shapeVertexCount; index += 1) {
      genes.push({ kind: 'wheelShapePoint', wheelIndex, index });
    }
  }
  return genes;
}

function geneKey({ kind, wheelIndex, index }) {
  return [kind, wheelIndex, index].join(':');
}

function geneValue(genome, { kind, wheelIndex, index }) {
  switch (kind) {
    case 'chassisCount':
      return genome.chassis.length;
    case 'wheelCount':
      return genome.wheels.length;
    case 'chassisVertex': {
      const point = genome.chassis[index];
      return point && { x: point.x, y: point.y };
    }
    case 'wheelVertex':
      return genome.wheels[wheelIndex]?.vertexIndex;
    case 'wheelRadius':
      return genome.wheels[wheelIndex]?.radius;
    case 'wheelTorque':
      return genome.wheels[wheelIndex]?.torque;
    case 'wheelShapeCount':
      return genome.wheels[wheelIndex]?.shape.length;
    case 'wheelShapePoint': {
      const point = genome.wheels[wheelIndex]?.shape[index];
      return point && { x: point.x, y: point.y };
    }
    default:
      throw new TypeError(`geneValue: unknown gene kind ${kind}`);
  }
}

/**
 * Nudge a genome. Each gene mutates independently at `rate`, so at rate 0 the
 * genome comes back untouched and selection alone drives the run.
 */
export function mutate(genome, rng, options = {}) {
  const config = { ...EVOLUTION_DEFAULTS, ...options };
  const rate = config.mutationRate;
  if (!(rate >= 0 && rate <= 1)) {
    throw new RangeError(`mutate: mutationRate must be within [0, 1], got ${rate}`);
  }
  for (const [name, chance] of [
    ['vertexCountMutationChance', config.vertexCountMutationChance],
    ['wheelShapeMutationChance', config.wheelShapeMutationChance],
  ]) {
    if (!(chance >= 0 && chance <= 1)) {
      throw new RangeError(`mutate: ${name} must be within [0, 1], got ${chance}`);
    }
  }
  const next = cloneGenome(normalizeGenome(genome));

  for (const point of next.chassis) {
    if (rng() < rate) point.x += randomFloat(rng, -config.vertexJitter, config.vertexJitter);
    if (rng() < rate) point.y += randomFloat(rng, -config.vertexJitter, config.vertexJitter);
  }
  if (rng() < rate * config.vertexCountMutationChance) {
    const addVertex =
      next.chassis.length === GENOME_LIMITS.minVertices ||
      (next.chassis.length < GENOME_LIMITS.maxVertices && rng() < 0.5);
    if (addVertex) {
      const angle = randomFloat(rng, 0, Math.PI * 2);
      const radius = randomFloat(rng, GENOME_LIMITS.minVertexRadius, GENOME_LIMITS.chassisRadius);
      next.chassis.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    } else {
      const removedIndex = randomInt(rng, 0, next.chassis.length - 1);
      next.chassis.splice(removedIndex, 1);
      for (const wheel of next.wheels) {
        if (wheel.vertexIndex === removedIndex) {
          wheel.vertexIndex = randomInt(rng, 0, next.chassis.length - 1);
        } else if (wheel.vertexIndex > removedIndex) {
          wheel.vertexIndex -= 1;
        }
      }
    }
  }
  for (const wheel of next.wheels) {
    if (rng() < rate) {
      wheel.radius = clamp(
        wheel.radius + randomFloat(rng, -config.radiusJitter, config.radiusJitter),
        GENOME_LIMITS.minWheelRadius,
        GENOME_LIMITS.maxWheelRadius,
      );
    }
    if (rng() < rate) {
      wheel.torque = clamp(
        wheel.torque + randomFloat(rng, -config.torqueJitter, config.torqueJitter),
        GENOME_LIMITS.minTorque,
        GENOME_LIMITS.maxTorque,
      );
    }
    for (const point of wheel.shape) {
      if (rng() < rate * config.wheelShapeMutationChance) {
        point.x += randomFloat(rng, -config.wheelShapeJitter, config.wheelShapeJitter);
        point.y += randomFloat(rng, -config.wheelShapeJitter, config.wheelShapeJitter);
      }
    }
    if (rng() < rate * config.wheelShapeMutationChance * config.vertexCountMutationChance) {
      const addPoint =
        wheel.shape.length === GENOME_LIMITS.minWheelVertices ||
        (wheel.shape.length < GENOME_LIMITS.maxWheelVertices && rng() < 0.5);
      if (addPoint) {
        const angle = randomFloat(rng, 0, Math.PI * 2);
        const radius = randomFloat(rng, 0.5, 1);
        wheel.shape.push({
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        });
      } else {
        wheel.shape.splice(randomInt(rng, 0, wheel.shape.length - 1), 1);
      }
    }
    if (rng() < rate * config.rewireChance) {
      wheel.vertexIndex = randomInt(rng, 0, next.chassis.length - 1);
    }
  }
  return normalizeGenome(next);
}

/**
 * Breed the next generation: elites survive untouched, the rest are tournament
 * -selected, crossed, and mutated.
 * @returns {object[]} a new population of the same size
 */
export function evolvePopulation(population, fitnesses, rng, options = {}) {
  assertPopulation(population, fitnesses, 'evolvePopulation');
  const config = { ...EVOLUTION_DEFAULTS, ...options };
  const eliteCount = clamp(config.eliteCount, 0, population.length);

  const next = rankedIndices(fitnesses)
    .slice(0, eliteCount)
    .map((i) => cloneGenome(population[i]));

  if (!(config.crossoverRate >= 0 && config.crossoverRate <= 1)) {
    throw new RangeError(
      `evolvePopulation: crossoverRate must be within [0, 1], got ${config.crossoverRate}`,
    );
  }

  while (next.length < population.length) {
    const parentA = selectParent(population, fitnesses, rng, config.tournamentSize);
    const parentB = selectParent(population, fitnesses, rng, config.tournamentSize);
    const child =
      rng() < config.crossoverRate
        ? crossover(parentA, parentB, rng)
        : cloneGenome(normalizeGenome(parentA));
    next.push(mutate(child, rng, config));
  }
  return next;
}

/** Population indices ordered best fitness first. */
export function rankedIndices(fitnesses) {
  return fitnesses
    .map((fitness, index) => ({ fitness, index }))
    // Tie-break on index so ranking is stable and a run stays reproducible.
    .sort((a, b) => b.fitness - a.fitness || a.index - b.index)
    .map((entry) => entry.index);
}

/** Index of the fittest individual. */
export function bestIndex(fitnesses) {
  return rankedIndices(fitnesses)[0];
}

function assertPopulation(population, fitnesses, caller) {
  if (!Array.isArray(population) || population.length === 0) {
    throw new TypeError(`${caller}: population must be a non-empty array`);
  }
  if (!Array.isArray(fitnesses) || fitnesses.length !== population.length) {
    throw new TypeError(
      `${caller}: fitnesses must be an array matching the population size (${population.length})`,
    );
  }
  if (fitnesses.some((f) => !Number.isFinite(f))) {
    throw new TypeError(`${caller}: every fitness must be a finite number`);
  }
}
