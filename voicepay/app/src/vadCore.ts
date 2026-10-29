// End-of-speech detection from the live microphone level (dB, about -160 silence … 0 loudest).
// Pure logic with no React or native code, so it is unit-tested against simulated rooms (quiet, TV, songs).
export const NO_SPEECH_MS = 7000;
export const NO_SPEECH_YESNO_MS = 5500;
export const SILENCE_MS = 1200; // quiet this long after you spoke = you are done (no tap needed)
export const SILENCE_PATIENT_MS = 2200; // numbers and ID details come with longer pauses
export const MAX_MS = 14000; // a command is short: never keep the microphone open longer
export const MAX_PATIENT_MS = 22000; // KYC / numbers are slower
export const MAX_YESNO_MS = 6000; // "yes" or "no" never takes longer than this, even with music playing

export type Vad = {
  heard: boolean;
  quietSince: number | null;
  recent: number[];
  peak: number;
  patient: boolean;
  short: boolean;
  baseline: number | null;
  flags: boolean[];
  resolve: ((uri: string | null) => void) | null;
};

export const newVad = (o: { patient?: boolean; expect?: string } = {}): Vad => ({
  heard: false, quietSince: null, recent: [], peak: -160, patient: !!o.patient, short: o.expect === 'yesno',
  baseline: null, flags: [], resolve: null,
});

/**
 * Feed one level sample. Returns 'stop' when recording should end (the caller sends the audio only if `v.heard`).
 *
 * `baseline` = how loud the room is when nobody is talking to the phone. It follows the room, but barely follows
 * your voice. Your voice is what rises clearly above it, and "still talking" needs most of the last second above
 * it, so a beat or a bass hit alone does not count.
 */
export function stepVad(v: Vad, lvl: number, now: number, durationMs: number): 'stop' | null {
  v.recent.push(lvl);
  if (v.recent.length > 24) v.recent.shift();
  if (v.baseline === null) {
    if (v.recent.length < 3) return null;
    v.baseline = Math.min(...v.recent) + 1; // the quietest early sample, in case you start speaking at once
  }
  const margin = Math.max(8, Math.min(14, 8 + (v.baseline + 50) / 5)); // noisier room → need to be clearly louder
  const above = lvl > v.baseline + margin && lvl > -42;
  v.baseline += (lvl - v.baseline) * (above ? 0.01 : 0.12);
  v.flags.push(above);
  if (v.flags.length > 8) v.flags.shift(); // ~1.2 s at 150 ms per sample
  const recentAbove = v.flags.filter(Boolean).length;
  if (above) v.peak = v.peak === -160 ? lvl : v.peak * 0.8 + lvl * 0.2;
  const lastTwo = v.flags.slice(-2).some(Boolean); // you are talking NOW, not just a second ago
  const speaking = recentAbove >= 3 && lastTwo;
  if (recentAbove >= 2) v.heard = true;

  const silenceMs = v.patient ? SILENCE_PATIENT_MS : SILENCE_MS;
  if (speaking) v.quietSince = null;
  else if (v.heard) {
    v.quietSince ??= now;
    if (now - v.quietSince > silenceMs) return 'stop';
  }
  if (!v.heard && durationMs > (v.short ? NO_SPEECH_YESNO_MS : NO_SPEECH_MS)) return 'stop';
  if (durationMs > (v.patient ? MAX_PATIENT_MS : v.short ? MAX_YESNO_MS : MAX_MS)) {
    v.heard = v.heard || recentAbove >= 1;
    return 'stop';
  }
  return null;
}

/** A loud room (songs, TV, traffic): recognition is less reliable, so money commands get a read-back first. */
export const NOISY_BASELINE_DB = -42;
export const isNoisy = (v: Vad) => v.baseline !== null && v.baseline > NOISY_BASELINE_DB;
