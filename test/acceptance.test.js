// Guards the promise the project is built around: on the shipped default track
// and seed, evolution turns a generation of junk into cars that climb the hill.
// This is slow by nature (960 physics runs) — it is the one test that exercises
// the whole engine end to end, so it is worth the seconds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultTrack, finishX } from '../src/track.js';
import { createRun, runAll, fitnessCurve, bestEver } from '../src/history.js';
import { simulateGenome } from '../src/simulate.js';

const track = createDefaultTrack({ length: 720 });
const longTrack = createDefaultTrack({ length: 1200 });

// One 40-generation run shared by the assertions below; recomputing it per test
// would multiply an already slow suite.
const run = createRun(track, { seed: 1, generations: 40 });
runAll(run);
const curve = fitnessCurve(run);

const longRun = createRun(longTrack, { seed: 1, generations: 12 });
runAll(longRun);

test('[1.2] the default longer course is valid and seed 1 makes measurable progress', () => {
  const first = longRun.history[0].bestFitness;
  const last = longRun.history[11].bestFitness;
  assert.equal(finishX(longTrack), 12000);
  assert.ok(first > 0);
  assert.ok(last > first, `long-course progress was only ${first.toFixed(0)} -> ${last.toFixed(0)}`);
  assert.ok(longRun.history[11].finishers > longRun.history[0].finishers);
});

test('[1.1] generation 40 is fitter than generation 0', () => {
  const first = curve[0].best;
  const last = curve[curve.length - 1].best;
  assert.ok(first > 0, 'generation 0 should manage some distance');
  assert.ok(
    last > first,
    `expected fitness to improve, got ${first.toFixed(0)} -> ${last.toFixed(0)}`,
  );
});

test('[1.1] generation 0 has no finishers and the best car remains short of the finish', () => {
  const generation = run.history[0];
  assert.equal(generation.finishers, 0, 'generation 0 should not solve the track by luck');
  assert.ok(
    generation.bestFitness < finishX(track),
    `generation 0's best covered ${generation.bestFitness.toFixed(0)} of ${finishX(track)}`,
  );
});

test('[1.1] by generation 40 the best car has improved without requiring a finisher', () => {
  const generation = run.history[39];
  assert.ok(
    generation.bestFitness > run.history[0].bestFitness,
    `best distance did not improve: ${run.history[0].bestFitness.toFixed(0)} -> ${generation.bestFitness.toFixed(0)}`,
  );
});

test('[1.1] the improvement is gradual, not a single lucky jump', () => {
  // The generation slider is only interesting if there is a curve to scrub.
  // Require progress in the first ten generations and again after them.
  assert.ok(curve[10].best > curve[0].best, 'no progress in the first 10 generations');
  assert.ok(curve[39].best > curve[10].best, 'no progress after generation 10');
});

test('[1.1] best fitness never regresses across the whole run', () => {
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i].best >= curve[i - 1].best - 1e-6, `regression at generation ${i}`);
  }
});

test('[1.1] every generation is stored and replayable by index', () => {
  assert.equal(run.history.length, 40);
  for (let i = 0; i < 40; i += 1) {
    const generation = run.history[i];
    assert.equal(generation.index, i);
    assert.equal(generation.population.length, run.config.populationSize);
  }
});

test("[1.1] replaying a generation's best car reproduces its recorded fitness", () => {
  // What the generation slider does when you scrub to a generation: it re-runs
  // the stored genome. If that disagreed with the stored fitness, the HUD would
  // contradict the animation.
  for (const index of [0, 13, 27, 39]) {
    const generation = run.history[index];
    const replayed = simulateGenome(generation.bestGenome, track);
    assert.equal(
      replayed.fitness,
      generation.bestFitness,
      `generation ${index} replayed to a different fitness`,
    );
  }
});

test('[1.1] the best-ever car comes from the stored history', () => {
  const best = bestEver(run);
  assert.equal(best.fitness, Math.max(...curve.map((c) => c.best)));
  assert.equal(simulateGenome(best.genome, track).fitness, best.fitness);
});

test('[1.1] the whole 40-generation run reproduces from its seed', () => {
  const repeat = createRun(track, { seed: 1, generations: 40 });
  runAll(repeat);
  assert.deepEqual(fitnessCurve(repeat), curve);
});
