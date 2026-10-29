import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import { createApp } from '../src/app.js';

delete process.env.GROQ_API_KEY;
test('mobile recharge asks the number, then the SIM, then the plan', async () => {
  const db = new Db(null);
  db.setKyc({ status: 'verified', name: 'Test', mobile: '9123456780' });
  const { agent } = createApp(db);
  const a = await agent.handle('enaku mobile recharge pannanum');
  assert.match(a.reply, /Which number/);
  const b = await agent.handle('my number');
  assert.match(b.reply, /Which SIM/);
  const c = await agent.handle('airtel');
  assert.ok(/plan|amount|how much|recharge/i.test(c.reply), c.reply);
  assert.equal(c.state === 'AWAITING_CONFIRMATION' || c.state === 'NEEDS_INFO', true);
});
test('operator named in the sentence skips the questions', async () => {
  const { agent } = createApp(new Db(null));
  const r = await agent.handle('jio recharge 299 for 9876543210');
  assert.ok(!/Which number/.test(r.reply), r.reply);
});

test('recharge opens the Bills screen on the recharge category', async () => {
  const { agent } = createApp(new Db(null));
  const r = await agent.handle('mobile recharge');
  assert.deepEqual(r.action, { type: 'navigate', screen: 'bills', category: 'mobile' });
});

test('own account is not a contact: bank-transfer steps, and your own name is recognised', async () => {
  const db = new Db(null);
  db.setKyc({ status: 'verified', name: 'Sasi Dharan', mobile: '9123456780' });
  const { agent } = createApp(db);
  const a = await agent.handle('send 5000 to my other account');
  assert.match(a.reply, /own other account/);
  assert.match(a.reply, /account holder/i);
  await agent.handle('cancel');
  const b = await agent.handle('send 500 to sasi dharan');
  assert.match(b.reply, /your own name/);
  const c = await agent.handle('yes');
  assert.match(c.reply, /account holder/i);
});
