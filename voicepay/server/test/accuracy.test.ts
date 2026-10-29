// Accuracy of the rule parser on a labelled corpus. Prints every miss, fails below the target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/parser.js';
import { CORPUS } from './corpus.js';

const norm = (s?: string | null) => (s ?? '').toLowerCase().trim();

test(`parser understands the labelled corpus (${CORPUS.length} spoken commands)`, () => {
  const misses: string[] = [];
  for (const c of CORPUS) {
    const p = parseCommand(c.say);
    const bad: string[] = [];
    if (p.intent !== c.intent) bad.push(`intent ${p.intent} ≠ ${c.intent}`);
    if ('amount' in c && (p.amount ?? null) !== (c.amount ?? null)) bad.push(`amount ${p.amount} ≠ ${c.amount}`);
    if ('name' in c && norm(p.name) !== norm(c.name)) bad.push(`name "${p.name}" ≠ "${c.name}"`);
    if ('category' in c && (p.category ?? null) !== (c.category ?? null)) bad.push(`category ${p.category} ≠ ${c.category}`);
    if (c.screen && p.screen !== c.screen) bad.push(`screen ${p.screen} ≠ ${c.screen}`);
    if (bad.length) misses.push(`"${c.say}" → ${bad.join(', ')}`);
  }
  const acc = 1 - misses.length / CORPUS.length;
  if (misses.length) console.log(`\n  ${misses.length} misses (${(acc * 100).toFixed(1)}% correct):\n  - ` + misses.join('\n  - '));
  assert.ok(acc >= 0.97, `accuracy ${(acc * 100).toFixed(1)}% is below 97%`);
});
