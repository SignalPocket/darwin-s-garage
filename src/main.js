// App wiring: owns the DOM, the render loop, and the run. All of the domain
// logic lives in the modules this imports — this file is the seam between them
// and the page.

import './style.css';
import {
  createDefaultTrack,
  COURSE_LIMITS,
  DEFAULT_COURSE_LENGTH,
  DEFAULT_TERRAIN_SETTING,
  courseSettingsFromTrackId,
} from './track.js';
import {
  ELITE_COUNT_LIMITS,
  EVOLUTION_DEFAULTS,
  POPULATION_SIZE_LIMITS,
} from './evolution.js';
import { createRun, runAllAsync, bestEver, fitnessCurve } from './history.js';
import { replayGenome } from './simulate.js';
import { createRenderer, cameraTarget, PALETTE } from './render.js';
import { chassisOutline, wheelAnchors } from './car.js';
import { createAudio } from './audio.js';
import { readShare, shareUrl, SHARE_PARAM } from './share.js';
import { spawnConfetti, stepConfetti } from './confetti.js';

const el = (id) => document.getElementById(id);

const dom = {
  scene: el('scene'),
  curve: el('curve'),
  boot: el('boot'),
  bootText: document.querySelector('.boot__text'),
  verdict: el('verdict'),
  slider: el('generation'),
  sliderValue: el('generation-value'),
  progressNote: el('progress-note'),
  play: el('play'),
  playGlyph: el('play-glyph'),
  playLabel: el('play-label'),
  stepBack: el('step-back'),
  stepForward: el('step-forward'),
  share: el('share'),
  hofCard: el('hof-card'),
  hofCanvas: el('hof-canvas'),
  hofFitness: el('hof-fitness'),
  hofGen: el('hof-gen'),
  hofShare: el('hof-share'),
  hofEmpty: el('hof-empty'),
  mute: el('mute'),
  shareLabel: el('share-label'),
  population: el('population'),
  floorHint: el('floor-hint'),
  geneticsMeta: el('genetics-meta'),
  geneticsChassisSummary: el('genetics-chassis-summary'),
  geneticsVertices: el('genetics-vertices'),
  geneticsWheels: el('genetics-wheels'),
  shareError: el('share-error'),
  seedRun: el('seed-run'),
  seedInput: el('seed-input'),
  generationsInput: el('generations-input'),
  populationSizeInput: el('population-size-input'),
  eliteCountInput: el('elite-count-input'),
  continueAfterFlip: el('continue-after-flip'),
  courseLength: el('course-length'),
  courseRoughness: el('course-roughness'),
  courseSteepness: el('course-steepness'),
  courseObstacles: el('course-obstacles'),
  roughnessValue: el('roughness-value'),
  steepnessValue: el('steepness-value'),
  obstaclesValue: el('obstacles-value'),
  randomSeed: el('random-seed'),
  startRun: el('start-run'),
  statGeneration: el('stat-generation'),
  statFitness: el('stat-fitness'),
  statPopulation: el('stat-population'),
  statFinishers: el('stat-finishers'),
  statBestEver: el('stat-best-ever'),
};

const reducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const initialShare = readShare(window.location.href);
const renderer = createRenderer(dom.scene);
const audio = createAudio();
const SEED_PARAM = 'seed';
const GENERATIONS_PARAM = 'generations';
const POPULATION_SIZE_PARAM = 'populationSize';
const ELITE_COUNT_PARAM = 'eliteCount';
const CONTINUE_AFTER_FLIP_PARAM = 'continueAfterFlip';
const COURSE_LENGTH_PARAM = 'courseLength';
const ROUGHNESS_PARAM = 'roughness';
const STEEPNESS_PARAM = 'steepness';
const OBSTACLE_FREQUENCY_PARAM = 'obstacleFrequency';
const RUN_DEFAULT_SEED = 1;
const RUN_DEFAULT_GENERATIONS = 40;

function readInitialSeed() {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get(SEED_PARAM);
  if (raw === null) return RUN_DEFAULT_SEED;
  const seed = Number(raw);
  return Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff
    ? seed
    : RUN_DEFAULT_SEED;
}

function readInitialGenerations() {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get(GENERATIONS_PARAM);
  if (raw === null) return RUN_DEFAULT_GENERATIONS;
  const generations = Number(raw);
  return Number.isSafeInteger(generations) && generations >= 1
    ? generations
    : RUN_DEFAULT_GENERATIONS;
}

function readInitialPopulationSize() {
  const url = new URL(window.location.href);
  return readIntegerParam(
    url.searchParams.get(POPULATION_SIZE_PARAM),
    EVOLUTION_DEFAULTS.populationSize,
    POPULATION_SIZE_LIMITS.min,
    POPULATION_SIZE_LIMITS.max,
  );
}

function readInitialEliteCount() {
  const url = new URL(window.location.href);
  return readIntegerParam(
    url.searchParams.get(ELITE_COUNT_PARAM),
    EVOLUTION_DEFAULTS.eliteCount,
    ELITE_COUNT_LIMITS.min,
    initialPopulationSize,
  );
}

function readInitialContinueAfterFlip() {
  const url = new URL(window.location.href);
  return url.searchParams.get(CONTINUE_AFTER_FLIP_PARAM) !== '0';
}

function readInitialCourse() {
  if (initialShare?.ok) {
    const sharedSettings = courseSettingsFromTrackId(initialShare.value.trackId);
    if (sharedSettings) return sharedSettings;
  }
  const url = new URL(window.location.href);
  const legacyDifficulty = url.searchParams.get('difficulty');
  const legacySetting = { easy: 30, standard: 50, hard: 77 }[legacyDifficulty];
  return {
    length: readIntegerParam(
      url.searchParams.get(COURSE_LENGTH_PARAM),
      DEFAULT_COURSE_LENGTH,
      COURSE_LIMITS.minLength,
      COURSE_LIMITS.maxLength,
    ),
    roughness: readIntegerParam(
      url.searchParams.get(ROUGHNESS_PARAM),
      legacySetting ?? DEFAULT_TERRAIN_SETTING,
      COURSE_LIMITS.minTerrainSetting,
      COURSE_LIMITS.maxTerrainSetting,
    ),
    steepness: readIntegerParam(
      url.searchParams.get(STEEPNESS_PARAM),
      legacySetting ?? DEFAULT_TERRAIN_SETTING,
      COURSE_LIMITS.minTerrainSetting,
      COURSE_LIMITS.maxTerrainSetting,
    ),
    obstacleFrequency: readIntegerParam(
      url.searchParams.get(OBSTACLE_FREQUENCY_PARAM),
      DEFAULT_TERRAIN_SETTING,
      COURSE_LIMITS.minTerrainSetting,
      COURSE_LIMITS.maxTerrainSetting,
    ),
    seed: initialSeed,
  };
}

function readIntegerParam(raw, fallback, min, max) {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function syncCourseOutputs() {
  dom.roughnessValue.value = dom.courseRoughness.value;
  dom.roughnessValue.textContent = dom.courseRoughness.value;
  dom.steepnessValue.value = dom.courseSteepness.value;
  dom.steepnessValue.textContent = dom.courseSteepness.value;
  dom.obstaclesValue.value = dom.courseObstacles.value;
  dom.obstaclesValue.textContent = dom.courseObstacles.value;
}

function randomSeed() {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

const initialSeed = readInitialSeed();
const initialGenerations = readInitialGenerations();
const initialPopulationSize = readInitialPopulationSize();
const initialEliteCount = readInitialEliteCount();
const initialContinueAfterFlip = readInitialContinueAfterFlip();
const initialCourse = readInitialCourse();
const track = createDefaultTrack(initialCourse);

const state = {
  run: createRun(track, {
    seed: initialSeed,
    generations: initialGenerations,
    populationSize: initialPopulationSize,
    eliteCount: initialEliteCount,
    continueAfterFlip: initialContinueAfterFlip,
  }),
  generation: 0,
  individual: null, // null = "the best of this generation"
  playback: null,
  playing: true,
  speed: 1,
  frameTime: 0,
  bestEverFitness: -1,
  confetti: [],
  guest: null, // a car opened from a share link
  announcedFinish: false,
  announcedFail: false,
};

// Replays are deterministic, so a scrubbed generation only ever needs computing
// once. Without this, dragging the slider recomputes ~100ms of physics per step.
const replayCache = new Map();

/* ---------- selection & replay ---------- */

function currentGenome() {
  if (state.guest) return state.guest.genome;
  const generation = state.run.history[state.generation];
  if (!generation) return null;
  const index = state.individual ?? generation.bestIndex;
  return generation.population[index] ?? null;
}

function replayKey() {
  if (state.guest) return 'guest';
  return `${state.generation}:${state.individual ?? 'best'}`;
}

function loadReplay() {
  const genome = currentGenome();
  if (!genome) return;
  const key = replayKey();
  if (!replayCache.has(key)) {
    const result = replayGenome(genome, track, {
      continueAfterFlip: state.run.config.continueAfterFlip,
    });
    replayCache.set(key, {
      frames: result.frames,
      result,
      outline: chassisOutline(genome),
      anchors: wheelAnchors(genome),
    });
  }
  state.playback = { ...replayCache.get(key), tick: 0 };
  state.announcedFinish = false;
  state.announcedFail = false;
  state.playing = true;
  syncPlayButton();
  hideVerdict();
  // Scrubbing should cut straight to the new car, not sweep the camera across
  // the whole track to find it.
  const first = state.playback.frames[0];
  if (first) renderer.snapCamera(cameraTarget(first, track));
}

function selectGeneration(index, { fromUser = false } = {}) {
  const clamped = Math.max(0, Math.min(index, state.run.history.length - 1));
  if (clamped < 0) return;
  const changed = clamped !== state.generation || state.individual !== null;
  state.generation = clamped;
  state.individual = null;
  state.guest = null;
  if (fromUser && changed) audio.tick();
  loadReplay();
  renderHud();
  renderFloor();
  syncSlider();
}

function selectIndividual(index) {
  state.individual = index;
  state.guest = null;
  loadReplay();
  renderHud();
  renderFloor();
}

/* ---------- HUD ---------- */

const metres = (px) => Math.round(px / 10);

function renderHud() {
  const generation = state.run.history[state.generation];
  dom.statPopulation.textContent = state.run.config.populationSize;

  if (!generation) return;
  dom.statGeneration.textContent = generation.index;
  dom.statFinishers.textContent = generation.finishers;

  const shown = state.playback?.result;
  const fitness = state.guest ? (shown?.fitness ?? 0) : generation.bestFitness;
  dom.statFitness.innerHTML = `${metres(fitness)}<span class="stat__unit">m</span>`;

  const best = bestEver(state.run);
  if (best) {
    dom.statBestEver.textContent = `${metres(best.fitness)}m · gen ${best.generation}`;
  }
  drawCurve();
}

/** Pin the best-ever car to the hall-of-fame card, or show the empty state. */
function renderHallOfFame(best) {
  if (!best) {
    dom.hofEmpty.hidden = false;
    dom.hofCard.hidden = true;
    dom.hofShare.hidden = true;
    return;
  }
  dom.hofEmpty.hidden = true;
  dom.hofCard.hidden = false;
  dom.hofShare.hidden = false;
  dom.hofFitness.textContent = `${metres(best.fitness)}m`;
  dom.hofGen.textContent = `gen ${best.generation}`;
  // Deferred a frame so the canvas has been unhidden and laid out.
  requestAnimationFrame(() => drawSilhouette(dom.hofCanvas, best.genome, true));
}

function popStat(node) {
  if (reducedMotion) return;
  node.classList.remove('is-popped');
  // Reading offsetWidth restarts the animation; without it a repeat pop on the
  // same element is silently dropped.
  void node.offsetWidth;
  node.classList.add('is-popped');
}

function shakeHud() {
  if (reducedMotion) return;
  const hud = document.querySelector('.hud');
  hud.classList.remove('is-shaking');
  void hud.offsetWidth;
  hud.classList.add('is-shaking');
}

/** The win celebration for a new best-ever fitness: gold flash + confetti. */
function celebrateBestEver() {
  if (reducedMotion) return;
  const hud = document.querySelector('.hud');
  hud.classList.remove('is-celebrating');
  void hud.offsetWidth;
  hud.classList.add('is-celebrating');
  // Thrown from the top-right of the viewport, which sits beside the HUD.
  const { width } = renderer.size;
  state.confetti.push(...spawnConfetti(width - 40, 40, { count: 32 }));
}

function showVerdict(text, tone) {
  dom.verdict.textContent = text;
  dom.verdict.dataset.tone = tone;
  dom.verdict.classList.add('is-shown');
}

function hideVerdict() {
  dom.verdict.classList.remove('is-shown');
}

/** The fitness curve, stencilled onto the HUD plate. */
function drawCurve() {
  const canvas = dom.curve;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(72 * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, 72);

  const curve = fitnessCurve(state.run);
  if (curve.length < 2) return;
  const total = state.run.config.generations;
  const max = Math.max(...curve.map((c) => c.best), 1);
  const x = (i) => (i / Math.max(1, total - 1)) * rect.width;
  const y = (value) => 68 - (value / max) * 60;

  ctx.strokeStyle = 'rgba(242, 234, 216, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 68.5);
  ctx.lineTo(rect.width, 68.5);
  ctx.stroke();

  const drawLine = (pick, color, width) => {
    ctx.beginPath();
    curve.forEach((point, i) => {
      const px = x(i);
      const py = y(pick(point));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  drawLine((p) => p.average, 'rgba(169, 158, 136, 0.7)', 1.5);
  drawLine((p) => p.best, PALETTE.accentSupport, 2);

  // The scrub marker.
  const markerX = x(state.generation);
  ctx.strokeStyle = PALETTE.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(markerX, 2);
  ctx.lineTo(markerX, 68);
  ctx.stroke();
}

/* ---------- the floor ---------- */

function renderFloor() {
  const generation = state.run.history[state.generation];
  if (!generation) return;
  const selected = state.individual ?? generation.bestIndex;

  // Rebuild only when the generation changed; otherwise just move the classes,
  // so scrubbing does not thrash 24 canvases per frame.
  if (dom.population.dataset.generation !== String(generation.index)) {
    dom.population.dataset.generation = String(generation.index);
    dom.population.replaceChildren(
      ...generation.population.map((genome, i) => buildChip(genome, generation, i)),
    );
  }
  [...dom.population.children].forEach((chip, i) => {
    chip.classList.toggle('is-selected', i === selected && !state.guest);
    chip.classList.toggle('is-best', i === generation.bestIndex);
    chip.setAttribute('aria-pressed', String(i === selected && !state.guest));
  });
  renderGenetics(generation, selected);
}

function renderGenetics(generation, selected) {
  const genome = currentGenome();
  if (!genome) return;

  const label = state.guest
    ? `Shared car · generation ${state.guest.generation}`
    : `Generation ${generation.index} · car ${selected + 1}${
        selected === generation.bestIndex ? ' · generation best' : ''
      }`;
  dom.geneticsMeta.textContent = label;

  const xs = genome.chassis.map((point) => point.x);
  const ys = genome.chassis.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  dom.geneticsChassisSummary.textContent =
    `${genome.chassis.length} vertices · ${width} × ${height} px`;
  dom.geneticsVertices.replaceChildren(
    ...genome.chassis.map((point, index) => {
      const item = document.createElement('li');
      item.textContent = `V${index + 1}: (${point.x}, ${point.y})`;
      return item;
    }),
  );
  dom.geneticsWheels.replaceChildren(
    ...genome.wheels.map((wheel, index) => buildWheelGenes(wheel, index)),
  );
}

function buildWheelGenes(wheel, index) {
  const article = document.createElement('article');
  article.className = 'genetics__wheel';

  const heading = document.createElement('h4');
  heading.className = 'genetics__wheel-title';
  heading.textContent = `Wheel ${index + 1}`;
  article.append(heading);

  const traits = document.createElement('dl');
  traits.className = 'genetics__traits';
  for (const [label, value] of [
    ['Attached at', `chassis vertex ${wheel.vertexIndex + 1}`],
    ['Radius', `${wheel.radius} px`],
    ['Torque', wheel.torque.toFixed(3)],
    ['Outline', `${wheel.shape.length} vertices`],
  ]) {
    const row = document.createElement('div');
    row.className = 'genetics__trait';
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    row.append(term, description);
    traits.append(row);
  }
  article.append(traits);

  const outline = document.createElement('details');
  outline.className = 'genetics__outline';
  const summary = document.createElement('summary');
  summary.textContent = 'Show outline coordinates';
  const points = document.createElement('ol');
  points.className = 'genetics__vertices genetics__vertices--wheel';
  points.replaceChildren(
    ...wheel.shape.map((point, pointIndex) => {
      const item = document.createElement('li');
      item.textContent = `P${pointIndex + 1}: (${point.x.toFixed(3)}, ${point.y.toFixed(3)})`;
      return item;
    }),
  );
  outline.append(summary, points);
  article.append(outline);
  return article;
}

function buildChip(genome, generation, index) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  const fitness = generation.fitnesses[index];
  chip.setAttribute(
    'aria-label',
    `Car ${index + 1} of generation ${generation.index}, ${metres(fitness)} metres`,
  );

  const canvas = document.createElement('canvas');
  chip.append(canvas);

  const score = document.createElement('span');
  score.className = 'chip__score';
  score.textContent = `${metres(fitness)}m`;
  chip.append(score);

  chip.addEventListener('click', () => {
    audio.unlock();
    audio.tick();
    selectIndividual(index);
  });

  // Deferred a frame so the canvas has been laid out and has a real size.
  requestAnimationFrame(() => drawSilhouette(canvas, genome, index === generation.bestIndex));
  return chip;
}

function drawSilhouette(canvas, genome, isBest) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(58 * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const outline = chassisOutline(genome);
  const anchors = wheelAnchors(genome);
  const extent = Math.max(
    ...outline.map((p) => Math.hypot(p.x, p.y)),
    ...anchors.flatMap((anchor) =>
      anchor.outline.map((point) => Math.hypot(anchor.x + point.x, anchor.y + point.y)),
    ),
    1,
  );
  const scale = Math.min(rect.width, 58) / (extent * 2.35);
  ctx.translate(rect.width / 2, 29);
  ctx.scale(scale, scale);

  for (const anchor of anchors) {
    ctx.beginPath();
    anchor.outline.forEach((point, index) => {
      const x = anchor.x + point.x;
      const y = anchor.y + point.y;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = '#332d26';
    ctx.fill();
  }
  ctx.beginPath();
  outline.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = isBest ? PALETTE.accentSupport : PALETTE.accent;
  ctx.fill();
  ctx.strokeStyle = PALETTE.surface2;
  ctx.lineWidth = 2 / scale;
  ctx.stroke();
}

/* ---------- render loop ---------- */

function frame(now) {
  const dt = Math.min(64, now - (state.frameTime || now));
  state.frameTime = now;

  renderer.clear();
  renderer.drawBayMarks();
  renderer.drawTrack(track);

  if (state.confetti.length > 0) {
    state.confetti = stepConfetti(state.confetti, dt);
    renderer.drawConfetti(state.confetti);
  }

  const playback = state.playback;
  if (!playback) {
    renderer.drawEmptyState('Warming up the first generation…');
    requestAnimationFrame(frame);
    return;
  }

  if (state.playing && playback.frames.length > 0) {
    // Advance in physics ticks scaled by speed: the outcome is already decided,
    // so speed changes only how fast it is shown, never what happens.
    playback.tick += (dt / (1000 / 60)) * state.speed;
    if (playback.tick >= playback.frames.length - 1) {
      playback.tick = playback.frames.length - 1;
      state.playing = false;
      syncPlayButton();
      announceOutcome(playback.result);
    }
  }

  const pose = playback.frames[Math.floor(playback.tick)];
  if (pose) {
    renderer.moveCamera(cameraTarget(pose, track), dt, reducedMotion);
    renderer.drawCar(null, pose, { outline: playback.outline, anchors: playback.anchors });
  }
  requestAnimationFrame(frame);
}

function announceOutcome(result) {
  if (result.finished) {
    if (!state.announcedFinish) {
      state.announcedFinish = true;
      showVerdict('Finished the course', 'win');
      audio.chime();
      popStat(dom.statFinishers);
    }
    return;
  }
  if (state.announcedFail) return;
  state.announcedFail = true;
  if (result.failReason === 'stalled') {
    showVerdict('Stalled out', 'fail');
    audio.clatter();
  } else if (result.failReason === 'exploded') {
    showVerdict('Came apart', 'fail');
    audio.thud();
  } else if (result.failReason === 'flipped') {
    showVerdict('Rolled it', 'fail');
    audio.thud();
    shakeHud();
  } else {
    showVerdict('Out of time', 'fail');
  }
}

/* ---------- controls ---------- */

function syncSlider() {
  const max = Math.max(0, state.run.history.length - 1);
  dom.slider.max = String(max);
  dom.slider.value = String(state.generation);
  dom.sliderValue.textContent = state.generation;
  const fill = max === 0 ? 0 : (state.generation / max) * 100;
  dom.slider.style.setProperty('--fill', `${fill}%`);
}

function syncPlayButton() {
  const atEnd = state.playback && state.playback.tick >= state.playback.frames.length - 1;
  dom.playGlyph.textContent = state.playing ? '❚❚' : '▶';
  dom.playLabel.textContent = state.playing ? 'Pause' : atEnd ? 'Replay' : 'Play';
}

/** Point the mute button's icon, pressed state, and label at one muted flag. */
function syncMuteButton(muted) {
  dom.mute.classList.toggle('is-muted', muted);
  dom.mute.setAttribute('aria-pressed', String(muted));
  dom.mute.querySelector('.sr-only').textContent = muted
    ? 'Unmute sound effects'
    : 'Mute sound effects';
}

/** Pause playback and move exactly one recorded frame, clamped to the run. */
function stepFrame(delta) {
  if (!state.playback || state.playback.frames.length === 0) return;
  state.playing = false;
  const max = state.playback.frames.length - 1;
  state.playback.tick = Math.max(0, Math.min(max, Math.floor(state.playback.tick) + delta));
  syncPlayButton();
}

function buildShareUrl(genome, generation) {
  const url = new URL(
    shareUrl({ genome, generation, trackId: state.run.track.id }, window.location.href.split('?')[0]),
  );
  url.searchParams.set(SEED_PARAM, String(state.run.track.seed));
  url.searchParams.set(POPULATION_SIZE_PARAM, String(state.run.config.populationSize));
  url.searchParams.set(ELITE_COUNT_PARAM, String(state.run.config.eliteCount));
  url.searchParams.set(
    CONTINUE_AFTER_FLIP_PARAM,
    state.run.config.continueAfterFlip ? '1' : '0',
  );
  url.searchParams.set(COURSE_LENGTH_PARAM, String(state.run.track.length));
  url.searchParams.set(ROUGHNESS_PARAM, String(state.run.track.roughness));
  url.searchParams.set(STEEPNESS_PARAM, String(state.run.track.steepness));
  url.searchParams.set(OBSTACLE_FREQUENCY_PARAM, String(state.run.track.obstacleFrequency));
  return url.toString();
}

/** Copy a share URL to the clipboard, falling back to a prompt; reports success. */
async function writeShareLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // Clipboard access is denied in plenty of ordinary contexts (insecure
    // origin, permission prompt dismissed); fall back to showing the link.
    window.prompt('Copy this link to share the car:', url);
    return false;
  }
}

function wireControls() {
  dom.seedInput.value = String(initialSeed);
  dom.generationsInput.value = String(initialGenerations);
  dom.populationSizeInput.value = String(initialPopulationSize);
  dom.eliteCountInput.value = String(initialEliteCount);
  dom.eliteCountInput.max = String(initialPopulationSize);
  dom.continueAfterFlip.checked = initialContinueAfterFlip;
  dom.courseLength.value = String(initialCourse.length);
  dom.courseRoughness.value = String(initialCourse.roughness);
  dom.courseSteepness.value = String(initialCourse.steepness);
  dom.courseObstacles.value = String(initialCourse.obstacleFrequency);
  syncCourseOutputs();

  for (const input of [dom.courseRoughness, dom.courseSteepness, dom.courseObstacles]) {
    input.addEventListener('input', syncCourseOutputs);
  }
  dom.populationSizeInput.addEventListener('input', () => {
    dom.eliteCountInput.max = dom.populationSizeInput.value;
    dom.eliteCountInput.setCustomValidity('');
  });

  dom.randomSeed.addEventListener('click', () => {
    audio.unlock();
    dom.seedInput.value = String(randomSeed());
  });

  dom.seedRun.addEventListener('submit', (event) => {
    event.preventDefault();
    audio.unlock();
    const seed = Number(dom.seedInput.value);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      dom.seedInput.setCustomValidity('Enter a whole seed from 0 to 4294967295.');
      dom.seedInput.reportValidity();
      return;
    }
    const generations = Number(dom.generationsInput.value);
    if (!Number.isSafeInteger(generations) || generations < 1) {
      dom.generationsInput.setCustomValidity('Enter a positive whole number.');
      dom.generationsInput.reportValidity();
      return;
    }
    const populationSize = Number(dom.populationSizeInput.value);
    if (
      !Number.isInteger(populationSize) ||
      populationSize < POPULATION_SIZE_LIMITS.min ||
      populationSize > POPULATION_SIZE_LIMITS.max
    ) {
      dom.populationSizeInput.setCustomValidity(
        `Enter a whole number from ${POPULATION_SIZE_LIMITS.min} to ${POPULATION_SIZE_LIMITS.max}.`,
      );
      dom.populationSizeInput.reportValidity();
      return;
    }
    const eliteCount = Number(dom.eliteCountInput.value);
    if (
      !Number.isInteger(eliteCount) ||
      eliteCount < ELITE_COUNT_LIMITS.min ||
      eliteCount > populationSize
    ) {
      dom.eliteCountInput.setCustomValidity(
        `Enter a whole number from ${ELITE_COUNT_LIMITS.min} to the population size (${populationSize}).`,
      );
      dom.eliteCountInput.reportValidity();
      return;
    }
    const courseLength = Number(dom.courseLength.value);
    if (
      !Number.isInteger(courseLength) ||
      courseLength < COURSE_LIMITS.minLength ||
      courseLength > COURSE_LIMITS.maxLength
    ) {
      dom.courseLength.setCustomValidity(
        `Enter a whole number from ${COURSE_LIMITS.minLength} to ${COURSE_LIMITS.maxLength}.`,
      );
      dom.courseLength.reportValidity();
      return;
    }
    const roughness = Number(dom.courseRoughness.value);
    const steepness = Number(dom.courseSteepness.value);
    const obstacleFrequency = Number(dom.courseObstacles.value);
    if (
      [roughness, steepness, obstacleFrequency].some(
        (value) =>
          !Number.isInteger(value) ||
          value < COURSE_LIMITS.minTerrainSetting ||
          value > COURSE_LIMITS.maxTerrainSetting,
      )
    ) {
      dom.courseRoughness.setCustomValidity('Terrain settings must be whole numbers from 0 to 100.');
      dom.courseRoughness.reportValidity();
      return;
    }
    dom.seedInput.setCustomValidity('');
    dom.generationsInput.setCustomValidity('');
    dom.populationSizeInput.setCustomValidity('');
    dom.eliteCountInput.setCustomValidity('');
    dom.courseLength.setCustomValidity('');
    dom.courseRoughness.setCustomValidity('');
    const url = new URL(window.location.href);
    url.searchParams.set(SEED_PARAM, String(seed));
    url.searchParams.set(GENERATIONS_PARAM, String(generations));
    url.searchParams.set(POPULATION_SIZE_PARAM, String(populationSize));
    url.searchParams.set(ELITE_COUNT_PARAM, String(eliteCount));
    url.searchParams.set(
      CONTINUE_AFTER_FLIP_PARAM,
      dom.continueAfterFlip.checked ? '1' : '0',
    );
    url.searchParams.set(COURSE_LENGTH_PARAM, String(courseLength));
    url.searchParams.set(ROUGHNESS_PARAM, String(roughness));
    url.searchParams.set(STEEPNESS_PARAM, String(steepness));
    url.searchParams.set(OBSTACLE_FREQUENCY_PARAM, String(obstacleFrequency));
    url.searchParams.delete('difficulty');
    url.searchParams.delete(SHARE_PARAM);
    window.location.assign(url);
  });

  dom.slider.addEventListener('input', () => {
    audio.unlock();
    selectGeneration(Number(dom.slider.value), { fromUser: true });
  });

  dom.play.addEventListener('click', () => {
    audio.unlock();
    if (!state.playback) return;
    const atEnd = state.playback.tick >= state.playback.frames.length - 1;
    if (atEnd) {
      state.playback.tick = 0;
      state.announcedFinish = false;
      state.announcedFail = false;
      hideVerdict();
    }
    state.playing = !state.playing;
    syncPlayButton();
  });

  for (const button of document.querySelectorAll('.btn--speed')) {
    button.addEventListener('click', () => {
      audio.unlock();
      state.speed = Number(button.dataset.speed);
      for (const other of document.querySelectorAll('.btn--speed')) {
        const active = other === button;
        other.classList.toggle('is-active', active);
        other.setAttribute('aria-pressed', String(active));
      }
    });
  }

  dom.mute.addEventListener('click', () => {
    audio.unlock();
    syncMuteButton(audio.toggleMute());
  });

  dom.share.addEventListener('click', async () => {
    audio.unlock();
    const genome = currentGenome();
    if (!genome) return;
    const copied = await writeShareLink(buildShareUrl(genome, state.generation));
    dom.share.classList.add('is-copied');
    dom.shareLabel.textContent = copied ? 'Link copied' : 'Link ready';
    setTimeout(() => {
      dom.share.classList.remove('is-copied');
      dom.shareLabel.textContent = 'Share this car';
    }, 2000);
  });

  dom.stepBack.addEventListener('click', () => {
    audio.unlock();
    stepFrame(-1);
  });

  dom.stepForward.addEventListener('click', () => {
    audio.unlock();
    stepFrame(1);
  });

  dom.hofCard.addEventListener('click', () => {
    audio.unlock();
    audio.tick();
    const best = bestEver(state.run);
    if (!best) return;
    selectGeneration(best.generation);
    selectIndividual(best.individual);
  });

  dom.hofShare.addEventListener('click', async () => {
    audio.unlock();
    const best = bestEver(state.run);
    if (!best) return;
    const copied = await writeShareLink(buildShareUrl(best.genome, best.generation));
    dom.hofShare.classList.add('is-copied');
    dom.hofShare.setAttribute('aria-label', copied ? 'Link copied' : 'Link ready');
    setTimeout(() => {
      dom.hofShare.classList.remove('is-copied');
      dom.hofShare.setAttribute('aria-label', 'Share the hall-of-fame car');
    }, 2000);
  });

  // Keyboard: the slider handles arrows natively; space toggles playback.
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.target.closest('button, input')) return;
    event.preventDefault();
    dom.play.click();
  });

  const onResize = () => {
    renderer.resize();
    drawCurve();
  };
  window.addEventListener('resize', onResize);
  renderer.resize();
}

/* ---------- share links ---------- */

function loadSharedCar() {
  const share = initialShare;
  if (share === null) return false;
  if (!share.ok) {
    dom.shareError.textContent = `${share.error} Showing a fresh run instead.`;
    dom.shareError.hidden = false;
    // Drop the bad param so a reload doesn't hit the same error.
    const url = new URL(window.location.href);
    url.searchParams.delete(SHARE_PARAM);
    window.history.replaceState({}, '', url);
    return false;
  }
  if (!courseSettingsFromTrackId(share.value.trackId)) {
    dom.shareError.textContent = 'This share link refers to a course this version cannot open.';
    dom.shareError.hidden = false;
    return false;
  }
  state.guest = share.value;
  dom.floorHint.textContent =
    'You opened a shared car. Scrub the slider to leave it and explore this run.';
  loadReplay();
  return true;
}

/* ---------- boot ---------- */

async function boot() {
  wireControls();
  // The mute preference is restored from localStorage, so the button has to
  // start from whatever audio.js loaded rather than from the markup's default.
  syncMuteButton(audio.muted);
  document.body.classList.add('is-booting');
  requestAnimationFrame(frame);

  const hadGuest = loadSharedCar();

  let firstGeneration = true;
  await runAllAsync(state.run, {
    onGeneration: () => {
      if (firstGeneration) {
        firstGeneration = false;
        dom.boot.hidden = true;
        document.body.classList.remove('is-booting');
        if (!hadGuest) selectGeneration(0);
        else renderFloor();
      }
      // Let the slider reach whatever has been computed so far, so the page is
      // scrubbable long before the configured run is complete.
      syncSlider();
      renderHud();

      const best = bestEver(state.run);
      if (best && best.fitness > state.bestEverFitness) {
        const improved = state.bestEverFitness >= 0;
        state.bestEverFitness = best.fitness;
        if (improved) {
          popStat(dom.statBestEver);
          audio.fanfare();
          celebrateBestEver();
        }
      }
      renderHallOfFame(best);
      dom.progressNote.textContent = `Evolved ${state.run.history.length} of ${state.run.config.generations} generations…`;
    },
  });

  dom.progressNote.textContent = `${state.run.config.generations} generations evolved. Scrub anywhere.`;
  syncSlider();
  renderHud();
}

boot().catch((error) => {
  // A failure here means no simulation at all, so say so in the page rather
  // than leaving an empty canvas and a console stack trace.
  dom.boot.hidden = false;
  dom.bootText.textContent = "Something broke while evolving. Reload to try again.";
  dom.shareError.textContent = `Evolution failed: ${error.message}`;
  dom.shareError.hidden = false;
});
