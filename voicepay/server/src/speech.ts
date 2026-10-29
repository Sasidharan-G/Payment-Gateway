// Helpers that turn what speech-to-text writes ("double five", "A B C P E 1 2 3 4 F",
// "14th May 2001") into clean values. Used by the guided voice KYC.

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', poojyam: '0', pujyam: '0', one: '1', onnu: '1', two: '2', rendu: '2', three: '3', moonu: '3',
  four: '4', naalu: '4', five: '5', anju: '5', six: '6', aaru: '6', seven: '7', ezhu: '7', eight: '8', ettu: '8',
  nine: '9', onbathu: '9', onbadhu: '9',
};
const REPEAT: Record<string, number> = { double: 2, triple: 3 };
const FILLER = new Set([
  'my', 'pan', 'aadhaar', 'aadhar', 'number', 'is', 'its', 'it', 'the', 'card', 'no', 'and', 'mobile', 'phone', 'otp',
  'code', 'sure', 'okay', 'ok', 'please', 'ah', 'um', 'uh', 'hmm',
]);

/** "A for Apple", "P for Papa", NATO words and the way Whisper writes spoken letters ("pea", "tea", "why"). */
const PHONETIC: Record<string, string> = {
  alpha: 'A', apple: 'A', bravo: 'B', boy: 'B', ball: 'B', charlie: 'C', cat: 'C', delta: 'D', dog: 'D', echo: 'E', elephant: 'E',
  foxtrot: 'F', fish: 'F', golf: 'G', goat: 'G', hotel: 'H', hat: 'H', india: 'I', ice: 'I', juliet: 'J', jug: 'J', kilo: 'K', king: 'K',
  lima: 'L', lion: 'L', mike: 'M', monkey: 'M', november: 'N', nose: 'N', oscar: 'O', orange: 'O', papa: 'P', parrot: 'P',
  quebec: 'Q', queen: 'Q', romeo: 'R', rat: 'R', sierra: 'S', sun: 'S', tango: 'T', tiger: 'T', uniform: 'U', umbrella: 'U',
  victor: 'V', van: 'V', whiskey: 'W', water: 'W', xray: 'X', yankee: 'Y', yellow: 'Y', zulu: 'Z', zebra: 'Z',
};
const HOMOPHONE: Record<string, string> = {
  ay: 'A', eh: 'A', be: 'B', bee: 'B', see: 'C', sea: 'C', cee: 'C', dee: 'D', gee: 'G', jay: 'J', kay: 'K', el: 'L', em: 'M', en: 'N',
  pea: 'P', pee: 'P', queue: 'Q', cue: 'Q', are: 'R', ar: 'R', ess: 'S', tea: 'T', tee: 'T', you: 'U', vee: 'V', ex: 'X',
  why: 'Y', wye: 'Y', zed: 'Z', zee: 'Z', eye: 'I', aye: 'I',
};

const tokens = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** "98765 43210", "nine eight seven six five double four three two one" → "9876544321" */
export function digitsFromSpeech(text: string): string {
  let out = '';
  let repeat = 1;
  for (const t of tokens(text)) {
    if (t in REPEAT) { repeat = REPEAT[t]; continue; }
    let d = '';
    if (/^\d+$/.test(t)) d = t;
    else if (t in DIGIT_WORDS) d = DIGIT_WORDS[t];
    else continue;
    out += d.length === 1 ? d.repeat(repeat) : d;
    repeat = 1;
  }
  return out;
}

/** PAN style: letters and digits one by one ("A B C P E 1 2 3 4 F") or run together. */
export function alnumFromSpeech(text: string): string {
  let out = '';
  let repeat = 1;
  const toks = tokens(text);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t in REPEAT) { repeat = REPEAT[t]; continue; }
    // "P for Papa": the letter wins, the word after "for" is skipped
    if (t.length === 1 && /[a-z]/.test(t) && toks[i + 1] === 'for') { out += t.toUpperCase().repeat(repeat); repeat = 1; i += 2; continue; }
    if (t in PHONETIC) { out += PHONETIC[t].repeat(repeat); repeat = 1; continue; }
    if (FILLER.has(t) && t.length > 1) continue;
    if (t in DIGIT_WORDS) { out += DIGIT_WORDS[t].repeat(repeat); repeat = 1; continue; }
    if (t in HOMOPHONE) { out += HOMOPHONE[t].repeat(repeat); repeat = 1; continue; }
    if (/^[a-z0-9]+$/.test(t)) { out += t.toUpperCase().repeat(t.length === 1 ? repeat : 1); repeat = 1; }
  }
  return out;
}

export function nameFromSpeech(text: string): string {
  const t = text
    .replace(/^(?:\s*(?:my name is|name is|i am|i'm|this is|en peyar|peyar)\s+)/i, '')
    .replace(/[^A-Za-z .']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.replace(/\b\w/g, (c) => c.toUpperCase());
}

const MONTHS: Array<[RegExp, number]> = [
  [/\bjan(uary)?\b/, 1], [/\bfeb(ruary)?\b/, 2], [/\bmar(ch)?\b/, 3], [/\bapr(il)?\b/, 4], [/\bmay\b/, 5], [/\bjun(e)?\b/, 6],
  [/\bjul(y)?\b/, 7], [/\baug(ust)?\b/, 8], [/\bsep(t(ember)?)?\b/, 9], [/\boct(ober)?\b/, 10], [/\bnov(ember)?\b/, 11], [/\bdec(ember)?\b/, 12],
];

/** "14 May 2001", "14-05-2001", "2001-05-14", "14th of may two thousand one" (digits only) → "YYYY-MM-DD" */
export function parseSpokenDob(raw: string): string | null {
  const text = raw.toLowerCase().replace(/(\d+)(st|nd|rd|th)\b/g, '$1').replace(/\bof\b/g, ' ');
  const pad = (n: number) => String(n).padStart(2, '0');
  const nums = (text.match(/\d+/g) ?? []).map(Number);
  const monthHit = MONTHS.find(([re]) => re.test(text));
  let y: number | undefined, m: number | undefined, d: number | undefined;
  if (monthHit) {
    m = monthHit[1];
    y = nums.find((n) => n >= 1900 && n <= 2100);
    d = nums.find((n) => n >= 1 && n <= 31);
  } else if (nums.length >= 3) {
    if (nums[0] >= 1900) [y, m, d] = nums; // ISO order
    else [d, m, y] = nums; // Indian order dd mm yyyy
  } else if (nums.length === 1 && /^\d{8}$/.test(String(nums[0]).padStart(8, '0')) && String(nums[0]).length === 8) {
    const s = String(nums[0]);
    d = Number(s.slice(0, 2)); m = Number(s.slice(2, 4)); y = Number(s.slice(4));
  }
  if (!y || !m || !d || y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "123456" → "1 2 3 4 5 6" so text-to-speech reads each digit. */
export const spellDigits = (s: string) => s.split('').join(' ');

export const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;

/**
 * A UPI ID spoken out loud: "ramesh at okaxis", "priya dot s at ok hdfc bank", "arun one two three at ybl",
 * or already written as "ramesh@okaxis". Returns null when it does not look like a UPI ID.
 */
export function upiFromSpeech(raw: string): string | null {
  const words = raw
    .toLowerCase()
    .replace(/\bat the rate( of)?\b|\bat sign\b|\bat\b/g, ' @ ')
    .replace(/\b(dot|point|full stop)\b/g, ' . ')
    .replace(/\bunder ?score\b/g, ' _ ')
    .replace(/\b(hyphen|dash|minus)\b/g, ' - ')
    .replace(/[^a-z0-9._@\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const joined = words.map((w) => (w in DIGIT_WORDS ? DIGIT_WORDS[w] : w)).join('');
  if ((joined.match(/@/g) ?? []).length !== 1) return null;
  return UPI_RE.test(joined) ? joined : null;
}

/** "ramesh@okaxis" → "ramesh at okaxis" so text-to-speech reads it clearly. */
export const spokenUpi = (upi: string) =>
  upi.replace(/@/g, ' at ').replace(/\./g, ' dot ').replace(/_/g, ' underscore ').replace(/-/g, ' dash ');

/** IFSC code spoken letter by letter ("H D F C zero zero zero one two three four"). */
export function ifscFromSpeech(raw: string): string | null {
  const s = alnumFromSpeech(raw);
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(s) ? s : null;
}

/** A 10-digit Indian mobile number inside a sentence ("send 500 to 98765 43210"). */
export function phoneFromText(raw: string): string | null {
  const m = raw.replace(/\b(\d{5})[\s-](\d{5})\b/g, '$1$2').match(/\b[6-9]\d{9}\b/);
  return m ? m[0] : null;
}
