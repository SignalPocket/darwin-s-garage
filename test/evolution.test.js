import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/rng.js';
import {
  createRandomGenome,
  isValidGenome,
  isViableGenome,
  normalizeGenome,
} from '../src/genome.js';
import {
  createPopulation,
  selectParent,
  crossover,
  mutate,
  evolvePopulation,
  evolvePopulationWithStats,
  rankedIndices,
  bestIndex,
  EVOLUTION_DEFAULTS,
} from '../src/evolution.js';

const pop = (n, seed = 0) => createPopulation(createRng(seed), n);

test('createPopulation returns the requested number of valid genomes', () => {
  const population = pop(24);
  assert.equal(population.length, 24);
  assert.ok(population.every(isValidGenome));
  assert.ok(population.every(isViableGenome));
});

test('createPopulation is deterministic for a seed and varied within a generation', () => {
  assert.deepEqual(pop(8, 5), pop(8, 5));
  const population = pop(8, 5);
  const shapes = new Set(population.map((g) => JSON.stringify(g)));
  assert.ok(shapes.size > 1, 'generation 0 should not be 8 identical cars');
});

test('createPopulation rejects sizes below two or non-integers', () => {
  for (const bad of [1, 0, -5, 2.5, NaN, 257]) {
    assert.throws(() => createPopulation(createRng(1), bad), RangeError);
  }
});

test('selectParent returns a member of the population', () => {
  const population = pop(10);
  const fitnesses = population.map((_, i) => i * 10);
  const rng = createRng(2);
  for (let i = 0; i < 200; i += 1) {
    assert.ok(population.includes(selectParent(population, fitnesses, rng)));
  }
});

test('selectParent gives fitter individuals higher odds while keeping all eligible', () => {
  const population = pop(10);
  const fitnesses = population.map((_, i) => (i === 9 ? 1000 : 0));
  const rng = createRng(4);
  const counts = population.map(() => 0);
  for (let i = 0; i < 10000; i += 1) {
    const selected = selectParent(population, fitnesses, rng);
    counts[population.indexOf(selected)] += 1;
  }
  assert.ok(counts[9] > counts[0] * 5, `fitness did not meaningfully weight odds: ${counts}`);
  assert.ok(counts.slice(0, 9).every((count) => count > 0), 'low-fitness cars should stay eligible');
});

test('selectParent samples equal fitness uniformly', () => {
  const population = pop(4);
  const fitnesses = [0, 0, 0, 0];
  const rng = createRng(6);
  const counts = population.map(() => 0);
  for (let i = 0; i < 4000; i += 1) {
    const selected = selectParent(population, fitnesses, rng);
    counts[population.indexOf(selected)] += 1;
  }
  assert.ok(counts.every((count) => count > 850 && count < 1150), `expected uniform selection, got ${counts}`);
});

test('selectParent is reproducible and supports negative fitness values', () => {
  const population = pop(4);
  const fitnesses = [-10, -5, 0, 5];
  const rngA = createRng(12);
  const rngB = createRng(12);
  const sequenceA = Array.from({ length: 20 }, () => selectParent(population, fitnesses, rngA));
  const sequenceB = Array.from({ length: 20 }, () => selectParent(population, fitnesses, rngB));

  assert.deepEqual(sequenceA, sequenceB);
});

test('selectParent rejects mismatched or malformed inputs', () => {
  const population = pop(3);
  const rng = createRng(1);
  assert.throws(() => selectParent([], [], rng), TypeError);
  assert.throws(() => selectParent(population, [1, 2], rng), TypeError);
  assert.throws(() => selectParent(population, [1, 2, NaN], rng), TypeError);
  assert.throws(() => selectParent(population, [1, 2, 3], null), TypeError);
});

test("crossover gives the child one of its parents' vertex counts, never an invented one", () => {
  const rng = createRng(8);
  for (let seed = 0; seed < 200; seed += 1) {
    const a = createRandomGenome(createRng(seed));
    const b = createRandomGenome(createRng(seed + 1000));
    const child = crossover(a, b, rng);
    assert.ok(
      child.chassis.length === a.chassis.length || child.chassis.length === b.chassis.length,
      `child had ${child.chassis.length} vertices; parents had ${a.chassis.length} and ${b.chassis.length}`,
    );
  }
});

test('crossover always produces a structurally valid child', () => {
  const rng = createRng(9);
  for (let seed = 0; seed < 300; seed += 1) {
    const child = crossover(
      createRandomGenome(createRng(seed)),
      createRandomGenome(createRng(seed + 500)),
      rng,
    );
    assert.ok(isValidGenome(child));
    for (const wheel of child.wheels) {
      assert.ok(wheel.vertexIndex >= 0 && wheel.vertexIndex < child.chassis.length);
    }
  }
});

test('crossover of a genome with itself reproduces that genome', () => {
  const parent = createRandomGenome(createRng(21));
  const child = crossover(parent, parent, createRng(3));
  assert.deepEqual(child, parent);
});

test('crossover randomizes individual gene order from the seeded rng', () => {
  const parentA = normalizeGenome({
    chassis: [
      { x: 60, y: 0 },
      { x: 20, y: 57 },
      { x: -48, y: 35 },
      { x: -48, y: -35 },
      { x: 20, y: -57 },
    ],
    wheels: [
      { vertexIndex: 0, radius: 12, torque: 0.02, shape: 'circle' },
      { vertexIndex: 2, radius: 12, torque: 0.02, shape: 'circle' },
    ],
  });
  const parentB = normalizeGenome({
    chassis: parentA.chassis.map((point) => ({ x: -point.x, y: point.y })),
    wheels: parentA.wheels.map((wheel) => ({
      ...wheel,
      radius: 33,
      torque: 0.1,
    })),
  });
  const lineagePattern = (child) => {
    const sourceOf = (valueA, valueB, value) =>
      JSON.stringify(value) === JSON.stringify(valueA)
        ? 'A'
        : JSON.stringify(value) === JSON.stringify(valueB)
          ? 'B'
          : '?';
    return [
      ...child.chassis.map((point, index) =>
        sourceOf(parentA.chassis[index], parentB.chassis[index], point),
      ),
      ...child.wheels.flatMap((wheel, index) => {
        const wheelA = parentA.wheels[index];
        const wheelB = parentB.wheels[index];
        return [
          sourceOf(wheelA.vertexIndex, wheelB.vertexIndex, wheel.vertexIndex),
          sourceOf(wheelA.radius, wheelB.radius, wheel.radius),
          sourceOf(wheelA.torque, wheelB.torque, wheel.torque),
          ...wheel.shape.map((point, pointIndex) =>
            sourceOf(wheelA.shape[pointIndex], wheelB.shape[pointIndex], point),
          ),
        ];
      }),
    ];
  };
  const children = Array.from({ length: 20 }, (_, seed) =>
    crossover(parentA, parentB, createRng(seed + 31)),
  );
  assert.ok(children.every(isValidGenome));
  assert.ok(children.some((child) => new Set(lineagePattern(child)).size > 1));
  assert.ok(
    new Set(children.map((child) => JSON.stringify(lineagePattern(child)))).size > 1,
    'different seeds should produce different gene order and crossover results',
  );
});

test('crossover treats wheel properties as separate genes', () => {
  const parentA = createRandomGenome(createRng(41));
  const parentB = createRandomGenome(createRng(42));
  parentA.wheels = parentA.wheels.slice(0, 2).map((wheel) => ({
    ...wheel,
    radius: 12,
    torque: 0.01,
    shape: wheel.shape.slice(0, 8),
  }));
  parentB.wheels = parentB.wheels.slice(0, 2).map((wheel) => ({
    ...wheel,
    radius: 33,
    torque: 0.11,
    shape: wheel.shape.slice(0, 8),
  }));
  const a = normalizeGenome(parentA);
  const b = normalizeGenome(parentB);

  const children = Array.from({ length: 200 }, (_, seed) =>
    crossover(a, b, createRng(seed)),
  );
  assert.ok(
    children.some((child) =>
      child.wheels.some(
        (wheel) =>
          (wheel.radius === 12 && wheel.torque === 0.11) ||
          (wheel.radius === 33 && wheel.torque === 0.01),
      ),
    ),
    'wheel radius and torque should be inherited independently',
  );
});

test('crossover is deterministic for the same parents and random seed', () => {
  const parentA = createRandomGenome(createRng(21));
  const parentB = createRandomGenome(createRng(22));
  assert.deepEqual(
    crossover(parentA, parentB, createRng(23)),
    crossover(parentA, parentB, createRng(23)),
  );
});

test('crossover does not alias its parents', () => {
  const a = createRandomGenome(createRng(1));
  const b = createRandomGenome(createRng(2));
  const snapshot = JSON.stringify(a);
  const child = crossover(a, b, createRng(5));
  child.chassis[0].x += 999;
  child.wheels[0].radius = 11;
  assert.equal(JSON.stringify(a), snapshot);
});

test('mutate at rate 0 returns the genome unchanged', () => {
  for (let seed = 0; seed < 100; seed += 1) {
    const genome = createRandomGenome(createRng(seed));
    const result = mutate(genome, createRng(seed + 7), { mutationRate: 0 });
    assert.deepEqual(result, genome);
  }
});

test('mutate at rate 1 changes the genome', () => {
  const genome = createRandomGenome(createRng(31));
  const result = mutate(genome, createRng(2), { mutationRate: 1 });
  assert.notDeepEqual(result, genome);
});

test('mutation can add and remove chassis vertices', () => {
  const genome = createRandomGenome(createRng(31));
  const counts = new Set();
  for (let seed = 0; seed < 100; seed += 1) {
    counts.add(
      mutate(genome, createRng(seed), {
        mutationRate: 1,
        vertexCountMutationChance: 1,
      }).chassis.length,
    );
  }
  assert.ok(counts.has(4), 'mutation should be able to remove a chassis vertex');
  assert.ok(counts.has(6), 'mutation should be able to add a chassis vertex');
});

test('mutation can change a wheel profile', () => {
  const genome = createRandomGenome(createRng(31));
  const mutated = mutate(genome, createRng(2), {
    mutationRate: 1,
    wheelShapeMutationChance: 1,
  });
  assert.ok(
    mutated.wheels.some(
      (wheel, index) => JSON.stringify(wheel.shape) !== JSON.stringify(genome.wheels[index].shape),
    ),
  );
});

test('mutate keeps every gene inside its limits even at maximum jitter', () => {
  let genome = createRandomGenome(createRng(41));
  const rng = createRng(1);
  for (let i = 0; i < 500; i += 1) {
    genome = mutate(genome, rng, { mutationRate: 1, vertexJitter: 500, radiusJitter: 100, torqueJitter: 5 });
    assert.ok(isValidGenome(genome), `genome went invalid on iteration ${i}`);
  }
});

test('mutate does not modify its input', () => {
  const genome = createRandomGenome(createRng(12));
  const snapshot = JSON.stringify(genome);
  mutate(genome, createRng(1), { mutationRate: 1 });
  assert.equal(JSON.stringify(genome), snapshot);
});

test('mutate rejects a rate outside [0, 1]', () => {
  const genome = createRandomGenome(createRng(1));
  for (const bad of [-0.1, 1.5, NaN]) {
    assert.throws(() => mutate(genome, createRng(1), { mutationRate: bad }), RangeError);
  }
});

test('evolvePopulation returns a new generation of the same size', () => {
  const population = pop(24);
  const fitnesses = population.map((_, i) => i);
  const next = evolvePopulation(population, fitnesses, createRng(3));
  assert.equal(next.length, population.length);
  assert.ok(next.every(isValidGenome));
});

test('evolvePopulation is deterministic for a given rng seed', () => {
  const population = pop(12);
  const fitnesses = population.map((_, i) => i * 3);
  assert.deepEqual(
    evolvePopulation(population, fitnesses, createRng(77)),
    evolvePopulation(population, fitnesses, createRng(77)),
  );
});

test('evolvePopulation carries the elites through untouched', () => {
  const population = pop(10);
  const fitnesses = [0, 0, 0, 0, 0, 0, 0, 0, 500, 900];
  const next = evolvePopulation(population, fitnesses, createRng(5), { eliteCount: 2 });
  assert.deepEqual(next[0], population[9]);
  assert.deepEqual(next[1], population[8]);
});

test('unviable parents cannot be selected, carried as elites, or enter a child population', () => {
  const viableA = createRandomGenome(createRng(31));
  const viableB = createRandomGenome(createRng(32));
  const unviable = normalizeGenome({
    chassis: [
      { x: 28, y: -35 },
      { x: -4, y: 19 },
      { x: 28, y: -29 },
      { x: -20, y: -21 },
    ],
    wheels: viableA.wheels.slice(0, 2),
  });
  assert.equal(isViableGenome(unviable), false);

  const result = evolvePopulationWithStats(
    [viableA, unviable, viableB, unviable],
    [10, 100000, 20, 200000],
    createRng(23),
    { mutationRate: 0, crossoverRate: 0, eliteCount: 1 },
  );
  assert.equal(result.population.length, 4);
  assert.ok(result.population.every(isViableGenome));
  assert.deepEqual(result.population[0], viableB);
});

test('a population with no viable parents is replaced with viable random cars', () => {
  const viable = createRandomGenome(createRng(34));
  const unviable = normalizeGenome({
    chassis: [
      { x: 28, y: -35 },
      { x: -4, y: 19 },
      { x: 28, y: -29 },
      { x: -20, y: -21 },
    ],
    wheels: viable.wheels.slice(0, 2),
  });
  const next = evolvePopulation([unviable, unviable], [2, 1], createRng(35));
  assert.equal(next.length, 2);
  assert.ok(next.every(isViableGenome));
});

test('evolution counts and excludes degenerate offspring candidates', () => {
  const population = pop(24, 1);
  const result = evolvePopulationWithStats(
    population,
    population.map((_, index) => index),
    createRng(2),
    {
      mutationRate: 1,
      vertexJitter: 200,
      wheelShapeJitter: 1,
      wheelShapeMutationChance: 1,
      vertexCountMutationChance: 1,
      crossoverRate: 1,
      eliteCount: 0,
    },
  );
  assert.ok(result.rejectedUnviableCount > 0);
  assert.equal(result.population.length, population.length);
  assert.ok(result.population.every(isViableGenome));
});

test('with mutation and crossover off, evolvePopulation reproduces selected parents unchanged', () => {
  // The control proving the variation operators, not selection, are the source
  // of novelty: with both dials at 0, selection can only ever hand back copies
  // of individuals that already exist.
  for (let seed = 0; seed < 40; seed += 1) {
    const population = pop(8, seed);
    const fitnesses = population.map((_, i) => i * 100);
    const next = evolvePopulation(population, fitnesses, createRng(seed + 9), {
      mutationRate: 0,
      crossoverRate: 0,
      eliteCount: 0,
    });
    const parents = new Set(population.map((g) => JSON.stringify(g)));
    for (const child of next) {
      assert.ok(
        parents.has(JSON.stringify(child)),
        `a genome absent from the parent pool appeared with both operators off (seed ${seed})`,
      );
    }
  }
});

test('mutation is the source of variation that crossover alone cannot supply', () => {
  // Same population, crossover off in both runs: rate 0 yields only copies,
  // rate 1 yields genomes new to the pool. That isolates the mutation operator.
  const population = pop(8, 3);
  const fitnesses = population.map((_, i) => i * 100);
  const parents = new Set(population.map((g) => JSON.stringify(g)));

  const withoutMutation = evolvePopulation(population, fitnesses, createRng(4), {
    mutationRate: 0,
    crossoverRate: 0,
    eliteCount: 0,
  });
  assert.ok(withoutMutation.every((g) => parents.has(JSON.stringify(g))));

  const withMutation = evolvePopulation(population, fitnesses, createRng(4), {
    mutationRate: 1,
    crossoverRate: 0,
    eliteCount: 0,
  });
  assert.ok(withMutation.some((g) => !parents.has(JSON.stringify(g))));
});

test('crossover rate 0 clones the first parent rather than splicing', () => {
  const population = pop(8);
  const fitnesses = population.map((_, i) => (i === 3 ? 1000 : 0));
  const next = evolvePopulation(population, fitnesses, createRng(9), {
    mutationRate: 0,
    crossoverRate: 0,
    eliteCount: 1,
  });
  assert.deepEqual(next[0], population[3]);
});

test('evolvePopulation rejects a crossover rate outside [0, 1]', () => {
  const population = pop(4);
  for (const bad of [-1, 2, NaN]) {
    assert.throws(
      () => evolvePopulation(population, [1, 2, 3, 4], createRng(1), { crossoverRate: bad }),
      RangeError,
    );
  }
});

test('evolvePopulation does not alias the previous generation', () => {
  const population = pop(6);
  const fitnesses = [5, 4, 3, 2, 1, 0];
  const snapshot = JSON.stringify(population);
  const next = evolvePopulation(population, fitnesses, createRng(1));
  next[0].chassis[0].x += 1000;
  next[0].wheels[0].radius = 12;
  assert.equal(JSON.stringify(population), snapshot);
});

test('evolvePopulation copes with an all-zero-fitness generation', () => {
  const population = pop(8);
  const next = evolvePopulation(population, new Array(8).fill(0), createRng(2));
  assert.equal(next.length, 8);
  assert.ok(next.every(isValidGenome));
});

test('evolvePopulation rejects an elite count larger than the population', () => {
  const population = pop(4);
  const fitnesses = [1, 2, 3, 4];
  assert.throws(
    () => evolvePopulation(population, fitnesses, createRng(1), { eliteCount: 99 }),
    RangeError,
  );
});

test('evolvePopulation rejects mismatched fitness arrays', () => {
  const population = pop(4);
  assert.throws(() => evolvePopulation(population, [1, 2], createRng(1)), TypeError);
  assert.throws(() => evolvePopulation(population, [1, 2, 3, NaN], createRng(1)), TypeError);
});

test('rankedIndices orders best first and breaks ties stably', () => {
  assert.deepEqual(rankedIndices([10, 50, 20]), [1, 2, 0]);
  assert.deepEqual(rankedIndices([7, 7, 7]), [0, 1, 2]);
  assert.deepEqual(rankedIndices([0]), [0]);
});

test('bestIndex finds the fittest individual', () => {
  assert.equal(bestIndex([1, 9, 4]), 1);
  assert.equal(bestIndex([5, 5, 5]), 0);
});

test('EVOLUTION_DEFAULTS keeps elites below the population size', () => {
  assert.ok(EVOLUTION_DEFAULTS.eliteCount < EVOLUTION_DEFAULTS.populationSize);
});
