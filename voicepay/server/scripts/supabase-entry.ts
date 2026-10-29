// Supabase Edge Function entry (Deno). GENERATED COPY lives in supabase/functions/voicepay/index.ts —
// edit THIS file, then run `npm run build:supabase` in server/.
//
// Every user signs in with Supabase Auth (email + password). Each request carries the user's
// access token; the user id from that token selects the user's own row in Postgres.
// Edge Functions are stateless and may run on many instances, so every request: take a row lock,
// load the user's data + conversation from Postgres, run the normal app, save everything back.
import process from 'node:process';
import postgres from 'npm:postgres@3';
import { createApp } from './app.ts';
import { Db } from './db.ts';
import { KycService } from './kyc.ts';

// Demo behaviour on purpose: demo wallet, demo gateway, simulated bills/KYC (REAL_MODE stays off, see mode.ts).
// Every signed-in user still gets their own private data, starting from the demo data.

// Users are authenticated by their Supabase login below. The old shared API_KEY secret (if still set) must not block them.
Deno.env.delete('API_KEY');

const MAX_TX = 300; // keep the JSON small
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10 });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

/** Paths that never touch user data: no database round trip, no lock. */
const STATELESS = new Set(['/api/health', '/api/stt', '/api/tts']);

// Token -> user id, remembered for a minute so we do not call Supabase Auth on every request.
const seen = new Map<string, { id: string; until: number }>();

async function userFrom(req: Request): Promise<string | null> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m) return null;
  const token = m[1];
  const hit = seen.get(token);
  if (hit && hit.until > Date.now()) return hit.id;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u?.id) return null;
  if (seen.size > 500) seen.clear();
  seen.set(token, { id: String(u.id), until: Date.now() + 60_000 });
  return String(u.id);
}

function build(data?: unknown, agentState?: unknown, kycState?: unknown) {
  const db = new Db(null);
  if (data) db.data = { ...db.data, ...(data as object) } as typeof db.data; // new fields keep their defaults for old rows
  const kyc = new KycService();
  kyc.restore(kycState);
  const built = createApp(db, { kyc });
  built.agent.restore(agentState);
  return { db, kyc, ...built };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  // The function is served under /functions/v1/voicepay (or /voicepay): strip that prefix.
  url.pathname = url.pathname.replace(/^\/functions\/v1\/voicepay/, '').replace(/^\/voicepay/, '') || '/';
  const inner = new Request(url, req);
  try {
    if (req.method === 'OPTIONS' || url.pathname === '/api/health') return await build().app.fetch(inner);

    const userId = await userFrom(req);
    if (!userId) return json({ ok: false, error: 'Please sign in again.', code: 'auth' }, 401);

    if (STATELESS.has(url.pathname)) return await build().app.fetch(inner);

    return await sql.begin(async (tx) => {
      await tx`insert into public.vp_state (user_id, data) values (${userId}, ${tx.json(new Db(null).data)}) on conflict (user_id) do nothing`;
      const [row] = await tx`select data, agent, kyc_sessions from public.vp_state where user_id = ${userId} for update`;
      const a = build(row.data, row.agent, row.kyc_sessions);
      const res = await a.app.fetch(inner);
      a.db.data.transactions = a.db.data.transactions.slice(0, MAX_TX);
      a.db.data.requests = a.db.data.requests.slice(0, 100);
      await tx`update public.vp_state
               set data = ${tx.json(a.db.data)}, agent = ${tx.json(a.agent.snapshot())},
                   kyc_sessions = ${tx.json(a.kyc.snapshot())}, updated_at = now()
               where user_id = ${userId}`;
      return res;
    });
  } catch (e) {
    console.error('[voicepay]', e);
    return json({ ok: false, error: 'Something went wrong on the server. Please try again.' }, 500);
  }
});
