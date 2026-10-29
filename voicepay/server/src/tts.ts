// Optional natural voice (Sarvam AI "Bulbul", good Indian English and Tamil). Set SARVAM_API_KEY to turn it on.
// Without a key the app keeps using the phone's own voice, so nothing breaks.
import process from 'node:process';

export const ttsEnabled = () => !!process.env.SARVAM_API_KEY?.trim();

/** Returns base64 WAV audio, or null when the engine is off or failed (the app then uses the phone voice). */
export async function synthesize(textRaw: string): Promise<{ audio: string; mime: string } | null> {
  const k = process.env.SARVAM_API_KEY?.trim();
  if (!k) return null;
  const text = textRaw.replace(/\s+/g, ' ').trim().slice(0, 450);
  if (!text) return null;
  try {
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: { 'api-subscription-key': k, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: [text],
        target_language_code: process.env.SARVAM_TTS_LANG || 'en-IN',
        speaker: process.env.SARVAM_TTS_SPEAKER || 'anushka',
        model: process.env.SARVAM_TTS_MODEL || 'bulbul:v2',
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) { console.warn('[tts] HTTP', res.status); return null; }
    const json: any = await res.json();
    const audio = json?.audios?.[0];
    return typeof audio === 'string' && audio.length > 100 ? { audio, mime: 'audio/wav' } : null;
  } catch (e) {
    console.warn('[tts] failed:', (e as Error).message);
    return null;
  }
}
