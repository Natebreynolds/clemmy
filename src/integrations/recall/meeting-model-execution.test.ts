import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-pin-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off',
  AUTH_MODE: 'api_key', MODEL_ROUTING_MODE: 'all_in', BYO_MODEL_BASE_URL: 'http://127.0.0.1:9',
  BYO_MODEL_API_KEY: 'controlled-unused', BYO_MODEL_ID: 'deepseek-chat', BYO_PROVIDERS: '[]' });
const { validateMeetingModelPin } = await import('./meeting-model-execution.js');
after(() => rmSync(home, { recursive: true, force: true }));
const pin = { version: 1 as const, modelId: 'deepseek-chat', provider: 'byo' as const,
  role: 'quick' as const, profileRevision: 3, selection: 'explicit' as const, fallback: 'none' as const };

test('exact connected live and after models validate without changing routing settings', () => {
  const before = process.env.BYO_MODEL_ID;
  assert.deepEqual(validateMeetingModelPin(pin, 'quick'), pin);
  assert.deepEqual(validateMeetingModelPin({ ...pin, role: 'brain' }, 'brain'), { ...pin, role: 'brain' });
  assert.equal(process.env.BYO_MODEL_ID, before);
});
test('wrong role, provider, malformed pin and disconnected exact model refuse without a replacement', () => {
  assert.throws(() => validateMeetingModelPin(pin, 'brain'));
  assert.throws(() => validateMeetingModelPin({ ...pin, provider: 'claude' }, 'quick'));
  assert.throws(() => validateMeetingModelPin({ ...pin, fallback: 'brain' }, 'quick'));
  const original = process.env.BYO_MODEL_API_KEY;
  process.env.BYO_MODEL_API_KEY = '';
  try { assert.throws(() => validateMeetingModelPin(pin, 'quick'), /No substitute/); }
  finally { process.env.BYO_MODEL_API_KEY = original; }
});
