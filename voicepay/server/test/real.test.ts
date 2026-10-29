import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db, EMPTY_SEED } from '../src/db.js';
import { createApp } from '../src/app.js';

delete process.env.GROQ_API_KEY;

async function realApp() {
  process.env.REAL_MODE = '1';
  const db = new Db(null, EMPTY_SEED);
  db.addContact({ name: 'Ramesh', upiId: 'ramesh@okaxis', type: 'person' });
  const { app, agent } = createApp(db);
  return { db, app, agent };
}
const post = (app: any, path: string, body: unknown = {}) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r: Response) => ({ status: r.status, json: await r.json() }));

test('real mode: new user starts empty, no demo money', async () => {
  const { db } = await realApp();
  assert.equal(db.data.balance, 0);
  assert.equal(db.data.savedBills.length, 0);
  process.env.REAL_MODE = '';
});

test('real mode: paying a contact needs no KYC and goes through the UPI app, not a fake gateway', async () => {
  const { app, agent } = await realApp();
  const a = await agent.handle('send 500 to ramesh');
  assert.equal(a.state, 'AWAITING_CONFIRMATION');
  const b = await agent.handle('yes');
  assert.equal(b.state, 'READY_TO_PAY');
  assert.equal(b.route?.method, 'upi');
  assert.equal((await post(app, '/api/payments/tdeadbeef0000/demo-complete')).status, 400);
  assert.equal((await post(app, '/api/reset')).status, 404);
  process.env.REAL_MODE = '';
});

test('real mode: bills are refused honestly instead of fake-paid', async () => {
  const { agent } = await realApp();
  const r = await agent.handle('jio recharge 299 for 9876543210');
  assert.notEqual(r.state, 'AWAITING_CONFIRMATION');
  process.env.REAL_MODE = '';
});
