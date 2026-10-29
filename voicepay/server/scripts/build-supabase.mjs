// Generates the Supabase Edge Function from the normal server source (single source of truth).
//   npm run build:supabase   ->   ../supabase/functions/voicepay/*.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const out = path.join(here, '..', '..', 'supabase', 'functions', 'voicepay');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const SKIP = new Set(['index.ts']); // the Node entry point
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith('.ts') || SKIP.has(f)) continue;
  let s = fs.readFileSync(path.join(src, f), 'utf8');
  s = s
    .replace(/from '(\.\/[^']+)\.js'/g, "from '$1.ts'")
    .replace(/from 'hono\/cors'/g, "from 'npm:hono@4/cors'")
    .replace(/from 'hono'/g, "from 'npm:hono@4'")
    .replace(/from 'zod'/g, "from 'npm:zod@4'");
  fs.writeFileSync(path.join(out, f), s);
}
fs.copyFileSync(path.join(here, 'supabase-entry.ts'), path.join(out, 'index.ts'));
console.log('Wrote', fs.readdirSync(out).join(', '), '->', out);
