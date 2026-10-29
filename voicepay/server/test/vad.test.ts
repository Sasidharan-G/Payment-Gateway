// End-of-speech detection against simulated rooms: quiet, a speaker playing songs, speech on top of songs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNoisy, newVad, stepVad } from '../../app/src/vadCore.js';

const STEP = 150;
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) * 2 - 1; // -1..1, repeatable

/** Runs a scene; returns when it stopped and whether speech was detected. */
function run(scene: (t: number) => number, opts: { expect?: string; patient?: boolean } = {}, maxMs = 30000) {
  seed = 7;
  const v = newVad(opts);
  for (let t = 0; t < maxMs; t += STEP) {
    if (stepVad(v, scene(t), t, t) === 'stop') return { stopAt: t, heard: v.heard };
  }
  return { stopAt: maxMs, heard: v.heard };
}

const speechAt = (t: number, from: number, to: number) => t >= from && t < to && ((t - from) % 450) < 330; // syllables with small gaps
const quiet = (t: number) => -56 + rnd() * 2;
/** A song: steady ~-32 dB with a beat every 500 ms and slow swells. */
const song = (t: number) => -33 + Math.sin(t / 900) * 2 + (t % 500 < 150 ? 5 : 0) + rnd() * 2;

test('quiet room: stops about a second after you finish talking', () => {
  const r = run((t) => (speechAt(t, 600, 2400) ? -22 + rnd() * 5 : quiet(t)));
  assert.equal(r.heard, true);
  assert.ok(r.stopAt > 2400 && r.stopAt < 2400 + 1900, `stopped at ${r.stopAt}`);
});

test('quiet room, nobody talks: gives up after 7 seconds without sending anything', () => {
  const r = run(quiet);
  assert.equal(r.heard, false);
  assert.ok(r.stopAt >= 7000 && r.stopAt < 7500);
});

test('songs playing, you say a command on top: it still stops soon after you finish', () => {
  const r = run((t) => (speechAt(t, 1200, 3600) ? -14 + rnd() * 4 : song(t)));
  assert.equal(r.heard, true);
  assert.ok(r.stopAt > 3600 && r.stopAt < 3600 + 2600, `stopped at ${r.stopAt}`);
});

test('songs playing, nobody talks: the beat does not keep the microphone open', () => {
  const r = run(song);
  assert.equal(r.heard, false);
  assert.ok(r.stopAt < 7600, `stopped at ${r.stopAt}`);
});

test('songs playing, "yes" answer: ends within 6 seconds at the latest', () => {
  const r = run((t) => (speechAt(t, 800, 1300) ? -14 + rnd() * 4 : song(t)), { expect: 'yesno' });
  assert.ok(r.stopAt <= 6000, `stopped at ${r.stopAt}`);
  assert.equal(r.heard, true);
});

test('loud steady TV: treated as room noise', () => {
  const r = run((t) => -30 + Math.sin(t / 700) * 1.5 + rnd() * 1.5);
  assert.equal(r.heard, false);
  assert.ok(r.stopAt < 7600);
});

test('patient mode (numbers) waits through longer pauses', () => {
  const digits = (t: number) => (speechAt(t, 500, 1500) || speechAt(t, 3000, 4000) ? -22 + rnd() * 4 : quiet(t));
  const r = run(digits, { patient: true });
  assert.ok(r.stopAt > 4000, `stopped at ${r.stopAt}, cut the number short`);
});

test('noisy room is detected (so money commands get a read-back), a quiet room is not', () => {
  const run2 = (scene: (t: number) => number) => {
    seed = 7;
    const v = newVad();
    for (let t = 0; t < 3000; t += STEP) stepVad(v, scene(t), t, t);
    return isNoisy(v);
  };
  assert.equal(run2(song), true);
  assert.equal(run2(quiet), false);
});
