// Production hardening shared by the Node server and the Supabase Edge Function:
// constant-time API key check, per-client rate limits, request size limits, security headers, request ids.
import process from 'node:process';
import type { Context, MiddlewareHandler } from 'npm:hono@4';

/** Compares two strings without leaking, through timing, how many leading characters matched. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Client address as set by the hosting proxy. `null` when there is no proxy (local development, tests). */
export function clientIp(c: Context): string | null {
  const fwd = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || c.req.header('x-real-ip');
  return fwd ? fwd.split(',')[0].trim() || null : null;
}

type Rule = { match: RegExp; limit: number; windowMs: number; name: string };

/** Most specific first. Limits are per client per minute. */
export const RATE_RULES: Rule[] = [
  { name: 'otp', match: /^\/api\/kyc\/(start|verify)$/, limit: 10, windowMs: 60_000 },
  { name: 'voice', match: /^\/api\/(stt|tts)$/, limit: 40, windowMs: 60_000 },
  { name: 'agent', match: /^\/api\/agent$/, limit: 60, windowMs: 60_000 },
  { name: 'pay', match: /^\/api\/(pay|payments)\b/, limit: 30, windowMs: 60_000 },
  { name: 'all', match: /^\/api\//, limit: 240, windowMs: 60_000 },
];

const hits = new Map<string, number[]>();
let lastSweep = 0;

/** Returns seconds to wait when the client is over the limit, otherwise 0. */
export function checkRate(ip: string, path: string, now = Date.now()): number {
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 120_000) hits.delete(k);
  }
  for (const r of RATE_RULES) {
    if (!r.match.test(path)) continue;
    const key = `${r.name}|${ip}`;
    const recent = (hits.get(key) ?? []).filter((t) => now - t < r.windowMs);
    if (recent.length >= r.limit) {
      hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + r.windowMs - now) / 1000));
    }
    recent.push(now);
    hits.set(key, recent);
  }
  return 0;
}

export function resetRateLimits() { hits.clear(); }

const MB = 1024 * 1024;
/** Largest request body per path (audio uploads are bigger than JSON). */
export function bodyLimit(path: string): number {
  return path === '/api/stt' ? 10 * MB : 64 * 1024;
}

export const rateLimit: MiddlewareHandler = async (c, next) => {
  if (process.env.RATE_LIMIT === 'off') return next();
  const ip = clientIp(c);
  if (ip) {
    const path = new URL(c.req.url).pathname;
    const wait = checkRate(ip, path);
    if (wait) {
      c.header('Retry-After', String(wait));
      return c.json({ ok: false, error: 'Too many requests. Please wait a moment and try again.' }, 429);
    }
  }
  return next();
};

export const sizeLimit: MiddlewareHandler = async (c, next) => {
  const len = Number(c.req.header('content-length') || 0);
  if (len > bodyLimit(new URL(c.req.url).pathname)) return c.json({ ok: false, error: 'Request is too large.' }, 413);
  return next();
};

/** Request id for log correlation + the standard security headers on every response. */
export const hardening: MiddlewareHandler = async (c, next) => {
  const id = c.req.header('x-request-id')?.slice(0, 64) || crypto.randomUUID();
  c.set('requestId' as never, id as never);
  await next();
  c.res.headers.set('X-Request-Id', id);
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  c.res.headers.set('Cache-Control', 'no-store');
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if ((c.res.headers.get('content-type') || '').includes('text/html')) {
    c.res.headers.set('X-Frame-Options', 'DENY');
  }
};

/** One JSON line per event: easy to search in any log viewer. Never put secrets or personal data in `extra`. */
export function log(level: 'info' | 'warn' | 'error', event: string, extra: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...extra });
  (level === 'error' ? console.error : console.log)(line);
}
