// The voice engine for the whole app: speak(), listen(), ask().
//  - speak(text)  → reads text aloud, resolves when finished (or interrupted)
//  - listen()     → records until you stop talking (auto-stop), sends the audio for speech-to-text, resolves with the text
//  - ask(q)       → speak a question then listen for the answer
// It lives above every screen so a spoken command can switch screens without losing the conversation.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Speech from 'expo-speech';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  AudioModule, RecordingPresets, createAudioPlayer, setAudioModeAsync, useAudioRecorder, useAudioRecorderState, type AudioPlayer, type AudioRecorder,
} from 'expo-audio';
import { isNoisy, newVad, stepVad, type Vad } from './vadCore';
import { api, defaultSettings, getReplyLang, loadSettings, saveSettings, type Settings } from './api';
import { tick } from './ui';

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

type Voice = {
  phase: Phase;
  setPhase: (p: Phase) => void;
  settings: Settings;
  ready: boolean;
  update: (patch: Partial<Settings>) => void;
  speak: (text: string) => Promise<void>;
  /** Resolves with what was said, '' when nothing was heard, or null when something else interrupted (halt). Throws on permission / network problems. */
  listen: (opts?: { patient?: boolean; expect?: string }) => Promise<string | null>;
  ask: (question: string, opts?: { patient?: boolean; expect?: string }) => Promise<string | null>;
  /** Stop talking and stop recording (used when the user taps or the app goes to the background). */
  halt: () => void;
  /** User tapped while we were recording: treat it as "I'm done speaking". */
  finishListening: () => void;
  /** The server has a natural-voice engine (Profile shows the switch only then). */
  serverTts: boolean;
  setServerTts: (on: boolean) => void;
};

const VoiceCtx = createContext<Voice | null>(null);
const LevelCtx = createContext<number>(-160);
export const useVoice = () => useContext(VoiceCtx)!;
export const useMicLevel = () => useContext(LevelCtx);


/** Two short sounds, so a user who cannot see the screen knows when to speak and when VoicePay has heard enough. */
const beeps: { start?: AudioPlayer; stop?: AudioPlayer } = {};
function beep(kind: 'start' | 'stop') {
  try {
    const p = (beeps[kind] ??= createAudioPlayer(kind === 'start' ? require('../assets/sfx/start.wav') : require('../assets/sfx/stop.wav')));
    p.seekTo(0).catch(() => {});
    p.play();
  } catch { /* sound is a bonus, never a blocker */ }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const cleanForSpeech = (t: string) =>
  t.replace(/₹\s?([\d,.]+)/g, '$1 rupees').replace(/[•·]/g, ',').replace(/\s+/g, ' ').trim();

/**
 * Microphone settings tuned for speech in noisy places: Android's "voice recognition" source (the phone's own noise
 * suppression and echo handling), 16 kHz mono (what the recognizer uses anyway: smaller upload, faster answer).
 */
const RECORD_OPTS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 48000,
  android: { ...RecordingPresets.HIGH_QUALITY.android, audioSource: 'voice_recognition' as const },
};

const ABORT = '__abort__';

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const recorder = useAudioRecorder(RECORD_OPTS);
  const [phase, setPhase] = useState<Phase>('idle');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [ready, setReady] = useState(false);
  const [level, setLevel] = useState(-160);
  const vad = useRef<Vad>(newVad());
  const stopping = useRef(false);
  const [serverTts, setServerTts] = useState(false);
  const neural = useRef(false);
  const neuralStop = useRef<(() => void) | null>(null);
  const ttsFiles = useRef(new Map<string, string>());
  const speakId = useRef(0);
  const rate = useRef(1);
  rate.current = settings.speechRate;
  neural.current = !!settings.neuralVoice && serverTts;

  useEffect(() => { loadSettings().then((s) => { setSettings(s); setReady(true); }); }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => { const n = { ...s, ...patch }; saveSettings(n); return n; });
  }, []);

  // Hands-free means the screen must stay on.
  useEffect(() => {
    if (settings.handsFree) activateKeepAwakeAsync('voicepay').catch(() => {});
    else deactivateKeepAwake('voicepay').catch(() => {});
  }, [settings.handsFree]);

  const finishRecording = useCallback(async (discard: boolean) => {
    if (stopping.current || !recorder.isRecording) return;
    stopping.current = true;
    try {
      await recorder.stop();
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }); // loud playback on iOS
      if (!discard) { beep('stop'); tick(); } // "got it, I heard you".
      const uri = recorder.uri;
      const heard = vad.current.heard && !discard;
      const done = vad.current.resolve;
      vad.current.resolve = null;
      done?.(discard ? ABORT : heard && uri ? uri : null);
    } finally {
      stopping.current = false;
    }
  }, [recorder]);

  /** Plays one natural-voice sentence. Resolves true when it played (or was interrupted), false when the phone voice should take over. */
  const playNatural = useCallback(async (text: string, id: number): Promise<boolean> => {
    try {
      const clean = cleanForSpeech(text);
      let uri = ttsFiles.current.get(clean);
      if (!uri) {
        uri = await api.tts(clean);
        if (ttsFiles.current.size > 30) ttsFiles.current.clear();
        ttsFiles.current.set(clean, uri);
      }
      if (speakId.current !== id) return true; // interrupted while it was being fetched
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      const player = createAudioPlayer({ uri });
      await new Promise<void>((resolve) => {
        const done = () => { neuralStop.current = null; resolve(); };
        neuralStop.current = () => { try { player.pause(); } catch { /* already gone */ } done(); };
        player.addListener('playbackStatusUpdate', (st: { didJustFinish?: boolean }) => { if (st.didJustFinish) done(); });
        setTimeout(done, 25000); // never hang
        player.play();
      });
      try { player.remove(); } catch { /* ignore */ }
      return true;
    } catch {
      return false;
    }
  }, []);

  const speak = useCallback((text: string) => {
    Speech.stop();
    neuralStop.current?.();
    const id = ++speakId.current;
    setPhase('speaking');
    return new Promise<void>((resolve) => {
      const end = () => { if (speakId.current === id) setPhase('idle'); resolve(); };
      const phoneVoice = () => Speech.speak(cleanForSpeech(text), { language: getReplyLang() === 'ta' ? 'ta-IN' : 'en-IN', rate: rate.current, onDone: end, onStopped: end, onError: end });
      if (neural.current && getReplyLang() !== 'ta') playNatural(text, id).then((ok) => (ok ? end() : phoneVoice()));
      else phoneVoice();
    });
  }, [playNatural]);

  const listen = useCallback(async (opts?: { patient?: boolean; expect?: string }) => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) throw new Error('Microphone permission is needed. Please allow it in the phone settings.');
    Speech.stop();
    speakId.current++;
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    vad.current = newVad(opts);
    const got = new Promise<string | null>((res) => { vad.current.resolve = res; });
    await recorder.prepareToRecordAsync(RECORD_OPTS);
    beep('start'); // "speak now"
    await sleep(240); // let the beep finish so the microphone does not record it
    recorder.record();
    setPhase('listening');
    tick();
    const uri = await got;
    setLevel(-160);
    setPhase('thinking');
    if (uri === ABORT) { setPhase('idle'); return null; }
    if (!uri) return '';
    const noisy = isNoisy(vad.current); // loud room: have the agent read money commands back before acting
    const text = await api.stt(uri, opts?.expect);
    if (noisy) api.flagLow();
    return text;
  }, [recorder]);

  const ask = useCallback(async (q: string, opts?: { patient?: boolean; expect?: string }) => {
    await speak(q);
    return listen(opts);
  }, [speak, listen]);

  const halt = useCallback(() => {
    Speech.stop();
    neuralStop.current?.();
    speakId.current++;
    finishRecording(true).catch(() => {});
    setPhase('idle');
  }, [finishRecording]);

  // A tap means "I'm done": whatever was recorded is sent, even if the level meter never saw speech.
  const finishListening = useCallback(() => { vad.current.heard = true; finishRecording(false).catch(() => {}); }, [finishRecording]);

  // Never keep the microphone open in the background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => { if (st !== 'active') halt(); });
    return () => sub.remove();
  }, [halt]);

  const value = useMemo<Voice>(
    () => ({ phase, setPhase, settings, ready, update, speak, listen, ask, halt, finishListening, serverTts, setServerTts }),
    [phase, settings, ready, update, speak, listen, ask, halt, finishListening, serverTts],
  );

  return (
    <VoiceCtx.Provider value={value}>
      <LevelCtx.Provider value={level}>
        {children}
        <VadWatcher recorder={recorder} vad={vad} onLevel={setLevel} stop={() => finishRecording(false)} />
      </LevelCtx.Provider>
    </VoiceCtx.Provider>
  );
}

/** Voice-activity detection from the live mic level: auto-stops when you stop talking. */
function VadWatcher(props: { recorder: AudioRecorder; vad: React.MutableRefObject<Vad>; onLevel: (n: number) => void; stop: () => void }) {
  const state = useAudioRecorderState(props.recorder, 150);
  const { vad, stop, onLevel } = props;
  useEffect(() => {
    if (!state.isRecording) return;
    const v = vad.current;
    const now = Date.now();
    const lvl = state.metering ?? -160;
    onLevel(lvl);
    if (stepVad(v, lvl, now, state.durationMillis) === 'stop') stop();
  }, [state.isRecording, state.metering, state.durationMillis, vad, stop, onLevel]);
  return null;
}
