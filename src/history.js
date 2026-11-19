// Drives the evolution loop and keeps every generation, not just the current
// one — the generation slider replays history, so history is the product here.
// Evaluating a generation is heavy (24 physics runs), so the async runner
// slices the work across physics ticks and yields on a time budget to keep the
// main thread responsive.

import { createRng } from './rng.js';
import {
  createPopulation,
  evolvePopulationWithStats,
  rankedIndices,
  EVOLUTION_DEFAULTS,
  POPULATION_SIZE_LIMITS,
  ELITE_COUNT_LIMITS,
} from './evolution.js';
import { simulateGenome, createSimulation } from './simulate.js';
import { isValidTrack, validateTrack } from './track.js';
import { assessGenomeViability, cloneGenome } from './genome.js';

export const RUN_DEFAULTS = Object.freeze({
  // Seed 1 is the shipped demo. New cars start with five chassis vertices and
  // round wheels; topology and wheel profiles can evolve through mutation.
  seed: 1,
  populationSize: EVOLUTION_DEFAULTS.populationSize,
  generations: 40,
  continueAfterFlip: true,
  // Budget plus worst-case slice overshoot has to stay under the ~50ms the
  // page can stall without feeling stuck, so the two are tuned together.
  chunkBudgetMs: 20,
  // How often the budget can be re-checked. A contact-heavy car peaks near 5ms
  // per tick, so five ticks caps a slice's overshoot at roughly 25ms.
  ticksPerSlice: 2,
});

/**
 * Create an evolution run. Nothing is computed yet; call runGeneration or
 * runAll to advance it.
 * @param {object} track
 * @param {object} [options]
 */
export function createRun(track, options = {}) {
  const problems = validateTrack(track);
  if (problems.length > 0) {
    throw new TypeError(`createRun: ${problems[0]}`);
  }
  const config = { ...RUN_DEFAULTS, ...EVOLUTION_DEFAULTS, ...options };
  if (!Number.isInteger(config.generations) || config.generations < 1) {
    throw new RangeError(`createRun: generations must be a positive integer, got ${config.generations}`);
  }
  if (typeof config.continueAfterFlip !== 'boolean') {
    throw new TypeError('createRun: continueAfterFlip must be a boolean');
  }
  if (
    !Number.isInteger(config.populationSize) ||
    config.populationSize < POPULATION_SIZE_LIMITS.min ||
    config.populationSize > POPULATION_SIZE_LIMITS.max
  ) {
    throw new RangeError(
      `createRun: populationSize must be an integer from ${POPULATION_SIZE_LIMITS.min} to ${POPULATION_SIZE_LIMITS.max}, got ${config.populationSize}`,
    );
  }
  if (
    !Number.isInteger(config.eliteCount) ||
    config.eliteCount < ELITE_COUNT_LIMITS.min ||
    config.eliteCount > config.populationSize
  ) {
    throw new RangeError(
      `createRun: eliteCount must be an integer from ${ELITE_COUNT_LIMITS.min} to ${config.populationSize}, got ${config.eliteCount}`,
    );
  }
  return {
    track,
    config,
    // One rng for the whole run: generation N's breeding consumes the stream
    // left by generation N-1, so the run reproduces end-to-end from the seed.
    rng: createRng(config.seed),
    history: [],
    pending: null,
  };
}

/** The population generation `index` will be scored on. */
function populationFor(run) {
  return run.history.length === 0
    ? createPopulation(run.rng, run.config.populationSize)
    : run.pending;
}

/**
 * Evaluate the next generation and append it to history.
 * @returns {object} the generation record just computed
 */
export function runGeneration(run) {
  const population = populationFor(run);
  const results = population.map((genome) => evaluateGenome(genome, run));
  return recordGeneration(run, population, results);
}

/**
 * Evaluate the next generation in time-boxed slices, handing control back to
 * the browser whenever the budget is spent. Chunking per individual is not
 * enough: a single contact-heavy car can cost 250ms on its own, so the slices
 * cut across the physics ticks themselves.
 */
export async function runGenerationAsync(run, options = {}) {
  const budgetMs = options.budgetMs ?? RUN_DEFAULTS.chunkBudgetMs;
  const ticksPerSlice = options.ticksPerSlice ?? RUN_DEFAULTS.ticksPerSlice;
  const yieldControl = options.yieldControl ?? defaultYield;
  const now = options.now ?? (() => Date.now());

  const population = populationFor(run);
  const results = [];
  let sliceStart = now();

  const spendBudget = async () => {
    if (now() - sliceStart >= budgetMs) {
      await yieldControl();
      sliceStart = now();
    }
  };

  for (const genome of population) {
    const viability = assessGenomeViability(genome);
    if (!viability.viable) {
      results.push(unviableResult(viability.reason));
      continue;
    }
    // Building a car and its terrain is itself ~9ms of work, so the budget is
    // checked before setup too — otherwise setup and the first ticks stack into
    // one oversized block.
    await spendBudget();
    const sim = createSimulation(genome, run.track, {
      continueAfterFlip: run.config.continueAfterFlip,
    });
    while (!sim.done) {
      sim.step(ticksPerSlice);
      await spendBudget();
    }
    results.push({ ...sim.result, viable: true, viabilityReason: null });
  }
  return recordGeneration(run, population, results);
}

/** Score, rank, and store one evaluated generation, then breed the next. */
function recordGeneration(run, population, results) {
  const index = run.history.length;
  const fitnesses = results.map((r) => r.fitness);
  const viableIndices = results
    .map((result, resultIndex) => (result.viable ? resultIndex : -1))
    .filter((resultIndex) => resultIndex >= 0);
  const unviableIndices = results
    .map((result, resultIndex) => (!result.viable ? resultIndex : -1))
    .filter((resultIndex) => resultIndex >= 0);
  const ranked = [
    ...rankedIndices(viableIndices.map((resultIndex) => fitnesses[resultIndex])).map(
      (viableRank) => viableIndices[viableRank],
    ),
    ...unviableIndices,
  ];
  const best = viableIndices.length > 0 ? ranked[0] : null;
  const viableCount = viableIndices.length;
  const unviableCount = unviableIndices.length;
  const outcomeCounts = {
    finishers: results.filter((result) => result.finished).length,
    stalled: results.filter((result) => result.failReason === 'stalled').length,
    flipped: results.filter((result) => result.failReason === 'flipped').length,
    exploded: results.filter((result) => result.failReason === 'exploded').length,
    timedOut: results.filter(
      (result) => result.viable && !result.finished && result.failReason === null,
    ).length,
  };
  const breeding = evolvePopulationWithStats(population, fitnesses, run.rng, run.config);

  const generation = {
    index,
    population: population.map(cloneGenome),
    fitnesses,
    results: results.map(({ fitness, finished, failed, failReason, ticks, viable, viabilityReason }) => ({
      fitness,
      finished,
      failed,
      failReason,
      ticks,
      viable,
      viabilityReason,
    })),
    ranked,
    bestIndex: best,
    bestFitness: best === null ? 0 : fitnesses[best],
    bestGenome: best === null ? null : cloneGenome(population[best]),
    averageFitness:
      viableCount === 0
        ? 0
        : viableIndices.reduce((sum, resultIndex) => sum + fitnesses[resultIndex], 0) /
          viableCount,
    viableCount,
    unviableCount,
    rejectedOffspringCount: breeding.rejectedUnviableCount,
    ...outcomeCounts,
    stats: {
      populationSize: population.length,
      viableCount,
      unviableCount,
      rejectedOffspringCount: breeding.rejectedUnviableCount,
      ...outcomeCounts,
    },
  };
  run.history.push(generation);
  run.pending = breeding.population;
  return generation;
}

function evaluateGenome(genome, run) {
  const viability = assessGenomeViability(genome);
  if (!viability.viable) return unviableResult(viability.reason);
  return {
    ...simulateGenome(genome, run.track, {
      continueAfterFlip: run.config.continueAfterFlip,
    }),
    viable: true,
    viabilityReason: null,
  };
}

function unviableResult(reason) {
  return {
    fitness: 0,
    finished: false,
    failed: true,
    failReason: 'unviable',
    ticks: 0,
    viable: false,
    viabilityReason: reason,
  };
}

/** Run every generation synchronously. Blocking — for tests and scripts. */
export function runAll(run, count = run.config.generations) {
  while (run.history.length < count) runGeneration(run);
  return run.history;
}

/**
 * Run generations in chunks, handing control back to the browser between them
 * so the page never freezes. One generation is the unit of work — it is well
 * under a frame budget at the default population size.
 * @param {object} run
 * @param {object} [options]
 * @param {(generation: object, run: object) => void} [options.onGeneration]
 * @param {() => Promise<void>} [options.yieldControl] - injectable for tests.
 * @param {{aborted: boolean}} [options.signal] - set aborted to stop early.
 */
export async function runAllAsync(run, options = {}) {
  const count = options.count ?? run.config.generations;
  const onGeneration = options.onGeneration ?? (() => {});
  const yieldControl = options.yieldControl ?? defaultYield;
  const signal = options.signal;

  while (run.history.length < count) {
    if (signal?.aborted) break;
    const generation = await runGenerationAsync(run, { ...options, yieldControl });
    onGeneration(generation, run);
    await yieldControl();
  }
  return run.history;
}

/** The generation record at an index, or null when out of range. */
export function generationAt(run, index) {
  if (!Number.isInteger(index) || index < 0 || index >= run.history.length) return null;
  return run.history[index];
}

/** The best fitness seen in any generation so far, and where it came from. */
export function bestEver(run) {
  let best = null;
  for (const generation of run.history) {
    if (!generation.bestGenome) continue;
    if (!best || generation.bestFitness > best.fitness) {
      best = {
        fitness: generation.bestFitness,
        generation: generation.index,
        genome: generation.bestGenome,
        individual: generation.bestIndex,
      };
    }
  }
  return best;
}

/** Best fitness per generation — the fitness curve the HUD graphs. */
export function fitnessCurve(run) {
  return run.history.map((generation) => ({
    generation: generation.index,
    best: generation.bestFitness,
    average: generation.averageFitness,
  }));
}

// setTimeout(0) is clamped to ~1-4ms per call by browsers, which at hundreds of
// yields per run would add seconds of pure waiting. A MessageChannel round-trip
// is a real macrotask — so rendering and input still get in — but unclamped.
function defaultYield() {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export { isValidTrack };
