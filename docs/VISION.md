# Vision

## The problem

Genetic algorithms are usually taught as a chart: a fitness value creeping upward across a
line graph. That's correct but it's boring, and it hides the actual thing that makes evolution
compelling — that *dumb, undirected, random variation plus selection pressure produces
competent design*. The best way to make that legible is to evolve something you can watch move:
a car. Several "evolving cars" demos exist already; nearly all of them show you one run, once,
with no way to go back, reshape the course, or share the one weird car you liked. Darwin's Garage
is built to fix exactly those three gaps.

## Who it's for

People who find genetic algorithms interesting but have never watched one run against something
physical. No ML/GA background required — the payoff (bad shapes get visibly better) reads
immediately. Casual enough to work one-handed on a phone at a slider, deep enough that someone
who *does* know GAs can see real selection/crossover/mutation happening, not a canned animation.

## The core idea

1. A **genome** is plain data: a polygon chassis (4-8 vertices) plus 2-4 wheels, each wheel
   attached at a chassis vertex with its own radius, torque, and polygon outline. New cars start
   with five chassis vertices and round wheel outlines of varied vertex counts; mutation can add,
   remove, and move vertices in either outline. See `src/genome.js`.
2. A **population** of genomes (generation 0: pure random) is checked for useful chassis and
   wheel geometry before it is built into Matter.js bodies and dropped on a seeded, adjustable
   track. Unviable designs are recorded, skipped, and never selected as parents or carried into
   the next population. A viable chassis needs at least 1,800 px² of convex-hull area and 30 px
   in both dimensions; each wheel needs at least 0.5 square units of normalized hull area.
3. **Fitness** is horizontal distance traveled toward the finish. Each generation records
   finishers, stalls, flips, timeouts, unviable designs, and offspring rejected for degenerate
   geometry, so progress and failure are visible alongside the fitness curve.
4. The next generation is bred from the current one: fitness-weighted random **selection** of
   parents, **crossover** that shuffles individual chassis, wheel-trait, and wheel-outline genes
   from the run's seeded RNG and alternates contiguous segments,
   **mutation** that nudges chassis and wheel-outline points and wheel parameters, and adds or
   removes vertices from either outline. Every generation is stored (not just the current one), so
   a generation slider can jump anywhere in history and replay it exactly.
5. **Replay is the shareable unit.** A genome plus its generation number plus the track it ran on
   fully determines a run — physics is deterministic given a fixed timestep — so that triple
   encodes to a URL and reconstructs the exact same run for anyone who opens the link.

## Key design decisions

- **Determinism over realism.** The physics and RNG must be seedable and reproducible, because
  shareable replay links only work if the same genome+track always plays out the same way. The run
  seed drives both population and terrain generation. Matter.js's fixed-timestep stepping (rather
  than wall-clock-driven) makes this possible.
- **Data-first genome.** The genome is plain JSON-serializable data, not classes tied to
  Matter.js bodies. That's what makes crossover/mutation simple (they're just object
  transforms) and what makes replay links possible (the genome *is* the shareable state).
- **No server.** Everything — evolution, physics, rendering, the track editor, replay decoding —
  runs client-side. Sharing a car means sharing a URL with the genome encoded in it, not a
  database row. This is also why the whole thing has to build to one static directory.
- **Track is data too.** A track is a list of terrain segments/heights generated from the seed,
  length, roughness, steepness, and obstacle-frequency controls, same spirit as the genome:
  serializable and independent of the evolution engine.
- **Mobile-first.** Every control (generation slider, playback speed, track editor) is built
  touch-first; mouse/keyboard is the fallback, not the primary target.

## What "v1 done" looks like

- Generation 0 is visibly bad (cars flail/flip/stall); by generation ~40 on the default track, a
  four-wheel-ish shape reliably climbs the hill and completes most of the course.
- The generation slider scrubs to any past generation and replays its best individual (or lets
  you pick any individual in that generation) with the exact same physics outcome every time.
- Any car can be exported as a URL; opening that URL on a fresh device replays that exact run.
- A simple track editor lets you place/drag terrain control points and re-run evolution against
  the edited track.
- The whole thing works on a phone: touch-drag the slider, tap to select a car, pinch/scroll the
  camera, tap to edit the track.
- `npm run build` produces a self-contained `dist/` deployable to any static host at any subpath.
