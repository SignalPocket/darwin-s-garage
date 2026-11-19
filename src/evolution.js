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
 * Recombine chassis-vertex and wheel genes using alternating segments in a
 * seeded, shuffled gene order. The first parent supplies the child's structure;
 * one to three crossover points switch which parent's genes fill each segment.
 */
export function crossover(parentA, parentB, rng) {
  const a = normalizeGenome(parentA);
  const b = normalizeGenome(parentB);
  const base = rng() < 0.5 ? a : b;
  const other = base === a ? b : a;
  const chromosome = [
    ...base.chassis.map((_, index) => ({ kind: 'chassis', index })),
    ...base.wheels.map((_, index) => ({ kind: 'wheel', index })),
  ];
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

  const child = {
    chassis: Array(base.chassis.length),
    wheels: Array(base.wheels.length),
  };
  let useBase = rng() < 0.5;
  for (const [locus, gene] of chromosome.entries()) {
    if (crossoverPoints.has(locus)) useBase = !useBase;
    const source = useBase ? base : other;
    const fallback = useBase ? other : base;
    const sourceGenes = source[gene.kind === 'chassis' ? 'chassis' : 'wheels'];
    const fallbackGenes = fallback[gene.kind === 'chassis' ? 'chassis' : 'wheels'];
    const value = sourceGenes[gene.index] ?? fallbackGenes[gene.index];
    if (gene.kind === 'chassis') {
      child.chassis[gene.index] = { x: value.x, y: value.y };
    } else {
      child.wheels[gene.index] = {
        ...value,
        shape: value.shape.map((point) => ({ x: point.x, y: point.y })),
      };
    }
  }

  // Mixing vertex genes can rarely make a degenerate chassis. Preserve the
  // chosen parent's valid chassis in that case; wheel genes remain recombined.
  if (!isValidGenome(child)) {
    child.chassis = base.chassis.map((point) => ({ x: point.x, y: point.y }));
  }
  return normalizeGenome(child);
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
