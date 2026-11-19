import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultTrack,
  validateTrack,
  isValidTrack,
  normalizeTrack,
  finishX,
  heightAt,
  trackSegments,
  DEFAULT_TRACK_ID,
  DEFAULT_COURSE_LENGTH,
  DEFAULT_TERRAIN_SETTING,
  courseSettingsFromTrackId,
  TRACK_LIMITS,
} from '../src/track.js';

test('the default track is valid and identifiable', () => {
  const track = createDefaultTrack();
  assert.deepEqual(validateTrack(track), []);
  assert.equal(track.length, DEFAULT_COURSE_LENGTH);
  assert.equal(track.seed, 1);
  assert.deepEqual(courseSettingsFromTrackId(track.id), {
    length: DEFAULT_COURSE_LENGTH,
    roughness: DEFAULT_TERRAIN_SETTING,
    steepness: DEFAULT_TERRAIN_SETTING,
    obstacleFrequency: DEFAULT_TERRAIN_SETTING,
    seed: 1,
  });
  assert.equal(track.builtIn, true);
});

test('the default track ascends left to right and gains real elevation', () => {
  const { points } = createDefaultTrack();
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i].x > points[i - 1].x, `x not ascending at index ${i}`);
  }
  const peak = Math.min(...points.map((p) => p.y));
  assert.ok(peak <= -400, `expected a climb of at least 400px, peak was ${peak}`);
});

test('createDefaultTrack returns a fresh object each call', () => {
  const a = createDefaultTrack();
  const b = createDefaultTrack();
  assert.deepEqual(a, b);
  a.points[0].x = 12345;
  assert.notEqual(a.points[0].x, b.points[0].x);
});

test('course length settings produce valid, longer deterministic courses', () => {
  for (const length of [100, 720, 1200, 2400, 30000]) {
    const track = createDefaultTrack({ length });
    assert.deepEqual(validateTrack(track), []);
    assert.equal(finishX(track), length * 10);
    assert.ok(track.points.length <= TRACK_LIMITS.maxPoints);
    assert.deepEqual(track, createDefaultTrack({ length }));
  }
  assert.ok(finishX(createDefaultTrack({ length: 2400 })) > finishX(createDefaultTrack()));
});

test('terrain controls change generated geometry while preserving its length', () => {
  const tracks = [
    createDefaultTrack({ length: 1200 }),
    createDefaultTrack({ length: 1200, roughness: 10 }),
    createDefaultTrack({ length: 1200, steepness: 90 }),
    createDefaultTrack({ length: 1200, obstacleFrequency: 90 }),
  ];
  assert.ok(tracks.every((track) => finishX(track) === 12000));
  assert.equal(new Set(tracks.map((track) => JSON.stringify(track.points))).size, 4);
  assert.ok(tracks.every((track) => isValidTrack(track)));
});

test('course identifiers round-trip continuous settings and legacy links', () => {
  assert.deepEqual(courseSettingsFromTrackId(DEFAULT_TRACK_ID), {
    length: 720,
    roughness: 50,
    steepness: 50,
    obstacleFrequency: 50,
    seed: 1,
  });
  assert.deepEqual(courseSettingsFromTrackId('hill-2400-hard'), {
    length: 2400,
    roughness: 77,
    steepness: 77,
    obstacleFrequency: 50,
    seed: 1,
  });
  for (const length of [100, 1200, 30000]) {
    for (const setting of [0, 50, 100]) {
      const options = {
        length,
        roughness: setting,
        steepness: 100 - setting,
        obstacleFrequency: setting,
        seed: setting * 1234,
      };
      const track = createDefaultTrack(options);
      assert.deepEqual(courseSettingsFromTrackId(track.id), options);
    }
  }
  assert.equal(courseSettingsFromTrackId('other-course'), null);
});

test('createDefaultTrack rejects unsupported course settings', () => {
  for (const length of [99, 30001, 100.5]) {
    assert.throws(() => createDefaultTrack({ length }), RangeError);
  }
  for (const setting of [-1, 101, 50.5]) {
    assert.throws(() => createDefaultTrack({ roughness: setting }), RangeError);
  }
  for (const seed of [-1, 0x100000000, 1.5]) {
    assert.throws(() => createDefaultTrack({ seed }), RangeError);
  }
});

test('the same seed reproduces the same terrain and a different seed changes it', () => {
  const options = { length: 2400, roughness: 72, steepness: 31, obstacleFrequency: 88 };
  const track = createDefaultTrack({ ...options, seed: 123 });
  assert.deepEqual(track, createDefaultTrack({ ...options, seed: 123 }));
  assert.notDeepEqual(track.points, createDefaultTrack({ ...options, seed: 124 }).points);
});

test('validateTrack rejects a track with too few points', () => {
  const problems = validateTrack({ points: [{ x: 0, y: 0 }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /at least 2 points/);
});

test('validateTrack rejects duplicate x coordinates', () => {
  const problems = validateTrack({
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: -50 },
    ],
  });
  assert.ok(problems.some((p) => /share x/.test(p)));
});

test('validateTrack rejects points that run backwards', () => {
  const problems = validateTrack({
    points: [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 100, y: 0 },
    ],
  });
  assert.ok(problems.some((p) => /ascending x/.test(p)));
});

test('validateTrack rejects non-finite coordinates', () => {
  const problems = validateTrack({
    points: [
      { x: 0, y: 0 },
      { x: NaN, y: 10 },
    ],
  });
  assert.ok(problems.some((p) => /finite/.test(p)));
});

test('validateTrack rejects malformed input without throwing', () => {
  for (const bad of [null, undefined, 42, {}, { points: 'nope' }]) {
    const problems = validateTrack(bad);
    assert.ok(problems.length > 0);
  }
});

test('validateTrack rejects more points than the limit allows', () => {
  const points = Array.from({ length: TRACK_LIMITS.maxPoints + 5 }, (_, i) => ({ x: i, y: 0 }));
  assert.ok(validateTrack({ points }).some((p) => /at most/.test(p)));
});

test('isValidTrack agrees with validateTrack', () => {
  assert.equal(isValidTrack(createDefaultTrack()), true);
  assert.equal(isValidTrack({ points: [] }), false);
});

test('normalizeTrack sorts points and removes duplicate x values', () => {
  const track = normalizeTrack({
    points: [
      { x: 300, y: -10 },
      { x: 100, y: 0 },
      { x: 300, y: 50 },
      { x: 200, y: 5 },
    ],
  });
  assert.deepEqual(
    track.points.map((p) => p.x),
    [100, 200, 300],
  );
  assert.ok(isValidTrack(track));
});

test('normalizeTrack clamps wild coordinates into the allowed span', () => {
  const track = normalizeTrack({
    points: [
      { x: -99999, y: -99999 },
      { x: 99999, y: 99999 },
    ],
  });
  for (const point of track.points) {
    assert.ok(point.x >= TRACK_LIMITS.minX - 400 && point.x <= TRACK_LIMITS.maxX);
    assert.ok(point.y >= TRACK_LIMITS.minY && point.y <= TRACK_LIMITS.maxY);
  }
});

test('normalizeTrack drops non-finite points', () => {
  const track = normalizeTrack({
    points: [
      { x: 0, y: 0 },
      { x: NaN, y: 0 },
      null,
      { x: 100, y: -20 },
    ],
  });
  assert.equal(track.points.length, 2);
});

test('normalizeTrack preserves non-point metadata', () => {
  const track = normalizeTrack({
    id: 'custom',
    name: 'My Track',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
  });
  assert.equal(track.id, 'custom');
  assert.equal(track.name, 'My Track');
});

test('normalizeTrack throws when too few distinct points survive', () => {
  assert.throws(
    () =>
      normalizeTrack({
        points: [
          { x: 5, y: 0 },
          { x: 5, y: 90 },
        ],
      }),
    RangeError,
  );
  assert.throws(() => normalizeTrack(null), TypeError);
  assert.throws(() => normalizeTrack({ points: 'x' }), TypeError);
});

test('finishX is the rightmost control point', () => {
  const track = createDefaultTrack();
  assert.equal(finishX(track), track.points[track.points.length - 1].x);
});

test('heightAt interpolates linearly between control points', () => {
  const track = {
    points: [
      { x: 0, y: 0 },
      { x: 100, y: -100 },
    ],
  };
  assert.equal(heightAt(track, 0), 0);
  assert.equal(heightAt(track, 50), -50);
  assert.equal(heightAt(track, 100), -100);
  assert.equal(heightAt(track, 25), -25);
});

test('heightAt extends the end segments flat beyond the track span', () => {
  const track = {
    points: [
      { x: 0, y: 10 },
      { x: 100, y: -90 },
    ],
  };
  assert.equal(heightAt(track, -5000), 10);
  assert.equal(heightAt(track, 5000), -90);
});

test('heightAt returns a finite height everywhere across the default track', () => {
  const track = createDefaultTrack();
  for (let x = -1000; x <= finishX(track) + 1000; x += 37) {
    assert.ok(Number.isFinite(heightAt(track, x)), `non-finite height at x=${x}`);
  }
});

test('trackSegments yields one fewer segment than points, in order', () => {
  const track = createDefaultTrack();
  const segments = trackSegments(track);
  assert.equal(segments.length, track.points.length - 1);
  assert.deepEqual(segments[0].a, track.points[0]);
  assert.deepEqual(segments[0].b, track.points[1]);
  for (const segment of segments) {
    assert.ok(segment.b.x > segment.a.x);
  }
});

test('trackSegments returns one segment for a two-point track', () => {
  const segments = trackSegments({
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
  });
  assert.equal(segments.length, 1);
});
