import 'dotenv/config';
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { Db } from './db.js';
import { llmEnabled } from './llm.js';
import { razorpayEnabled } from './payments.js';

const port = Number(process.env.PORT || 4000);
const db = new Db(path.resolve(process.env.DATA_FILE || 'data/db.json'));
const { app } = createApp(db);

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
  console.log('\n  VoicePay server running');
  console.log(`  Local:   http://localhost:${port}/api/health`);
  for (const ip of ips) console.log(`  Network: http://${ip}:${port}/api/health   <- phone uses this`);
  console.log(`\n  LLM + voice (Groq): ${llmEnabled() ? 'ON' : 'OFF (rule parser; add GROQ_API_KEY for voice)'}`);
  console.log(`  Gateway: ${razorpayEnabled() ? 'Razorpay TEST mode' : 'Built-in demo gateway (add Razorpay test keys to use Razorpay)'}\n`);
});

if (!process.env.API_KEY) console.warn('  WARNING: API_KEY is not set. Anyone who can reach this server can use it. Set API_KEY before exposing it to the internet.');

// Finish in-flight requests, then exit (deploys and Ctrl+C no longer cut a payment in half).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`  ${sig}: shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
