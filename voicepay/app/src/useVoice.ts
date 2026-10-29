// Push-to-talk recorder with automatic stop when you stop speaking (simple voice-activity detection
// using the microphone level), plus spoken replies.
import { useCallback, useEffect, useRef } from 'react';
import * as Speech from 'expo-speech';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

const SPEECH_DB = -38; // louder than this = talking
const SILENCE_MS = 1300; // stop after this much quiet once you have spoken
const NO_SPEECH_MS = 6000; // give up if nothing is said
const MAX_MS = 15000;

export function useVoice(onRecorded: (uri: string) => void) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const state = useAudioRecorderState(recorder, 150);
  const heardSpeech = useRef(false);
  const quietSince = useRef<number | null>(null);
  const stopping = useRef(false);
  const cb = useRef(onRecorded);
  cb.current = onRecorded;

  useEffect(() => {
    (async () => {
      await AudioModule.requestRecordingPermissionsAsync();
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    })();
  }, []);

  const stop = useCallback(async () => {
    if (stopping.current || !recorder.isRecording) return;
    stopping.current = true;
    try {
      await recorder.stop();
      // Switch audio back to playback so the spoken reply is loud on iOS.
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      const uri = recorder.uri;
      if (uri && heardSpeech.current) cb.current(uri);
      else if (uri) cb.current(''); // nothing said
    } finally {
      stopping.current = false;
    }
  }, [recorder]);

  const start = useCallback(async () => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) throw new Error('Microphone permission is needed. Enable it in Settings, or type your command.');
    Speech.stop();
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    heardSpeech.current = false;
    quietSince.current = null;
    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [recorder]);

  // Voice activity detection from the live mic level.
  useEffect(() => {
    if (!state.isRecording) return;
    const now = Date.now();
    const level = state.metering ?? -160;
    if (level > SPEECH_DB) {
      heardSpeech.current = true;
      quietSince.current = null;
    } else if (heardSpeech.current) {
      quietSince.current ??= now;
      if (now - quietSince.current > SILENCE_MS) stop();
    }
    if (!heardSpeech.current && state.durationMillis > NO_SPEECH_MS) stop();
    if (state.durationMillis > MAX_MS) stop();
  }, [state.isRecording, state.metering, state.durationMillis, stop]);

  const speak = useCallback((text: string, onDone?: () => void) => {
    Speech.stop();
    Speech.speak(text.replace(/₹/g, 'rupees '), { language: 'en-IN', rate: 1.0, onDone, onStopped: undefined });
  }, []);

  return { start, stop, speak, isRecording: state.isRecording, level: state.metering ?? -160 };
}
