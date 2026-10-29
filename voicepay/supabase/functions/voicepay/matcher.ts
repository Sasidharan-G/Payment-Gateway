// Fuzzy + phonetic contact matching, so speech-to-text spelling mistakes
// ("Rameshh", "Ramish", "Priyaa", "Murgan") still find the right contact.
import type { Contact } from './db.ts';

/** Indian-English phonetic normalisation. */
export function phonetic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/zh/g, 'l')
    .replace(/th/g, 't')
    .replace(/dh/g, 'd')
    .replace(/sh/g, 's')
    .replace(/ph/g, 'f')
    .replace(/ee|ii/g, 'i')
    .replace(/oo|uu/g, 'u')
    .replace(/w/g, 'v')
    .replace(/([bcdfgjklmnpqrstvxz])h/g, '$1')
    .replace(/(.)\1+/g, '$1')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function similarity(a: string, b: string): number {
  const x = phonetic(a);
  const y = phonetic(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

export type Match = { contact: Contact; score: number };

const THRESHOLD = 0.72;

/**
 * Returns the best matching contacts. More than one result means the
 * name is ambiguous (e.g. two "Ramesh") and the agent must ask which one.
 */
export function matchContacts(query: string, contacts: Contact[]): Match[] {
  const q = query.trim();
  if (!q) return [];
  const singleWord = !q.includes(' ');
  const scored = contacts.map((contact) => {
    const targets = [contact.name, contact.nickname ?? ''];
    if (singleWord) targets.push(...contact.name.split(/\s+/));
    const score = Math.max(...targets.filter(Boolean).map((t) => similarity(q, t)));
    return { contact, score };
  });
  const good = scored.filter((m) => m.score >= THRESHOLD).sort((a, b) => b.score - a.score);
  if (!good.length) return [];
  const best = good[0].score;
  return good.filter((m) => m.score >= best - 0.08);
}

const ORDINALS: Array<[RegExp, number]> = [
  // checked most-specific first, so "the second one" is not read as "one"
  [/\b(third|3rd|three|3|moonavathu|munavathu)\b/, 2],
  [/\b(second|2nd|two|2|rendavathu|rendavadhu|irandavathu|second one)\b/, 1],
  [/\b(first|1st|one|1|mudhal|modhal|mudhalavathu|first one)\b/, 0],
];

/** Resolve the user's answer to "Which Ramesh?" */
export function pickCandidate(answer: string, candidates: Contact[]): Contact | null {
  const text = answer.toLowerCase();
  for (const [re, idx] of ORDINALS) if (re.test(text) && candidates[idx]) return candidates[idx];
  const words = text.split(/[^a-z]+/).filter((w) => w.length > 0);
  let best: { c: Contact; s: number } | null = null;
  for (const c of candidates) {
    const parts = [c.name, ...(c.nickname ? [c.nickname] : []), ...c.name.split(/\s+/)];
    // Only the parts that make this candidate different from the others count.
    const distinct = parts.filter((p) => !candidates.some((o) => o !== c && o.name.toLowerCase().includes(p.toLowerCase())));
    for (const w of words) for (const p of distinct) {
      const s = similarity(w, p);
      if (s >= 0.75 && (!best || s > best.s)) best = { c, s };
    }
  }
  return best?.c ?? null;
}
