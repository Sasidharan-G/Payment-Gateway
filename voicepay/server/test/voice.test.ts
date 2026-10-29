// The voice upgrades: vocabulary hints, "did you say…?" confidence check, optional natural voice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import { createApp } from '../src/app.js';
import { buildPrompt, cleanVocab, isLowConfidence } from '../src/llm.js';
import { verhoeffGenerate } from '../src/kyc.js';

delete process.env.GROQ_API_KEY;
delete process.env.SARVAM_API_KEY;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

async function call(app: any, path: string, body?: unknown) {
  const res = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: type.includes('json') ? await res.json() : null };
}
async function readyApp() {
  const { app, agent } = createApp(new Db(null));
  const s = await call(app, '/api/kyc/start', { name: 'Sasi Dharan', dob: '2001-05-14', pan: 'ABCPE1234F', aadhaar: verhoeffGenerate('23456789012'), mobile: '9876543210' });
  await call(app, '/api/kyc/verify', { sessionId: s.json.sessionId, otp: s.json.demoOtp });
  return { app, agent };
}
const say = async (app: any, text: string, lowConfidence = false) => (await call(app, '/api/agent', { text, lowConfidence })).json;

test('vocabulary hint: contact names go to the recognizer for commands, not for the user\'s own name or IDs', () => {
  const v = cleanVocab('Ramesh Kumar, Priya, Murugan Stores <script>');
  assert.equal(v, 'Ramesh Kumar, Priya, Murugan Stores script');
  assert.match(buildPrompt(undefined, v), /People and shops: Ramesh Kumar, Priya, Murugan Stores script/);
  assert.doesNotMatch(buildPrompt('name', v), /Ramesh/);
  assert.doesNotMatch(buildPrompt('digits', v), /Ramesh/);
  assert.equal(buildPrompt(undefined, ''), buildPrompt(undefined, ''));
  assert.ok(cleanVocab('x'.repeat(1000)).length <= 300);
});

test('confidence: low average log-probability or repetitive output means "probably misheard"', () => {
  assert.equal(isLowConfidence([{ avg_logprob: -0.2 }, { avg_logprob: -0.4 }]), false);
  assert.equal(isLowConfidence([{ avg_logprob: -1.3 }]), true);
  assert.equal(isLowConfidence([{ avg_logprob: -0.3, compression_ratio: 3.1 }]), true);
  assert.equal(isLowConfidence([]), false);
});

test('"did you say…?": an unsure payment sentence is confirmed before anything is prepared', async () => {
  const { app } = await readyApp();
  let r = await say(app, 'send 500 to ramesh kumar', true);
  assert.equal(r.state, 'NEEDS_INFO');
  assert.match(r.reply, /I heard: send 500 to ramesh kumar\. Is that right/);
  assert.equal(r.pending, undefined);
  r = await say(app, 'yes');
  assert.equal(r.state, 'AWAITING_CONFIRMATION'); // now the normal payment confirmation
  assert.equal(r.pending.amount, 500);
  await say(app, 'no');

  r = await say(app, 'send 900 to priya', true);
  assert.match(r.reply, /I heard/);
  r = await say(app, 'no');
  assert.match(r.reply, /say it again/);
  r = await say(app, 'my balance'); // nothing is left half-open
  assert.match(r.reply, /balance/i);
});

test('the check is only for money commands: balance and navigation are never questioned', async () => {
  const { app } = await readyApp();
  const r = await say(app, 'what is my balance', true);
  assert.match(r.reply, /Your balance/);
  const n = await say(app, 'scan qr', true);
  assert.equal(n.action.type, 'scan_qr');
});

test('natural voice endpoint stays off (404) until a key is set; health says so', async () => {
  const { app } = await readyApp();
  assert.equal((await call(app, '/api/health')).json.tts, false);
  const r = await call(app, '/api/tts', { text: 'hello' });
  assert.equal(r.status, 404);
});
