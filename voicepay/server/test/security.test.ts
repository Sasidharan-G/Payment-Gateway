// Production hardening: rate limits, size limits, headers, API key check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import { createApp } from '../src/app.js';
import { checkRate, resetRateLimits, safeEqual } from '../src/security.js';

delete process.env.GROQ_API_KEY;
delete process.env.SARVAM_API_KEY;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

const mk = () => createApp(new Db(null)).app;

test('safeEqual compares fully and rejects different lengths', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

test('every response carries security headers and a request id', async () => {
  const res = await mk().request('/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.headers.get('x-request-id'));
  const echoed = await mk().request('/api/health', { headers: { 'x-request-id': 'abc-123' } });
  assert.equal(echoed.headers.get('x-request-id'), 'abc-123');
});

test('OTP endpoints are limited to 10 per minute per client, other clients are unaffected', async () => {
  resetRateLimits();
  const app = mk();
  const hit = (ip: string) => app.request('/api/kyc/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{}' });
  for (let i = 0; i < 10; i++) assert.equal((await hit('1.2.3.4')).status, 400); // validation error, but allowed through
  const blocked = await hit('1.2.3.4');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal((await hit('5.6.7.8')).status, 400);
  resetRateLimits();
});

test('the window slides: after a minute the client can try again', () => {
  resetRateLimits();
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) assert.equal(checkRate('9.9.9.9', '/api/kyc/verify', t0 + i), 0);
  assert.ok(checkRate('9.9.9.9', '/api/kyc/verify', t0 + 100) > 0);
  assert.equal(checkRate('9.9.9.9', '/api/kyc/verify', t0 + 61_000), 0);
  resetRateLimits();
});

test('local calls without a proxy header are never rate limited (dev and tests)', async () => {
  const app = mk();
  for (let i = 0; i < 30; i++) assert.equal((await app.request('/api/kyc/start', { method: 'POST', body: '{}' })).status, 400);
});

test('oversized request bodies are refused before they are read', async () => {
  const app = mk();
  const res = await app.request('/api/agent', { method: 'POST', headers: { 'content-length': String(1024 * 1024), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 413);
});

test('the API key is enforced when configured (health stays open)', async () => {
  process.env.API_KEY = 'secret-key-for-test';
  try {
    const app = mk();
    assert.equal((await app.request('/api/health')).status, 200);
    assert.equal((await app.request('/api/wallet')).status, 401);
    assert.equal((await app.request('/api/wallet', { headers: { 'x-api-key': 'secret-key-for-tesT' } })).status, 401);
    assert.equal((await app.request('/api/wallet', { headers: { 'x-api-key': 'secret-key-for-test' } })).status, 200);
  } finally {
    delete process.env.API_KEY;
  }
});

test('OTP is not written to the server log', async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    await mk().request('/api/kyc/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sasi Dharan', dob: '2001-05-14', pan: 'ABCPE1234F', aadhaar: '234567890124', mobile: '9876543210' }) });
  } finally {
    console.log = orig;
  }
  assert.ok(!lines.some((l) => /OTP/i.test(l)));
});
