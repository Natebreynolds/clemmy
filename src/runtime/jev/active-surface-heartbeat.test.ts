import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-active-surface-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { recordRunStrategy } = await import('../../memory/run-strategy-store.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');
const { rememberToolSchema, _clearToolSchemaCacheForTest } = await import('../../tools/composio-schema-cache.js');
const { readActiveToolSurface } = await import('../../memory/active-tool-surface.js');
const { tickActiveToolSurfaceHeartbeat } = await import('./active-surface-heartbeat.js');

after(() => {
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('heartbeat stages proven-tool schemas into memory without a chat model', async () => {
  _clearToolSchemaCacheForTest();
  const receipt = evaluateLearningCandidate({
    target: 'strategy',
    authority: 'background_delivery_verifier',
    sessionId: 'background:surface',
    sourceId: 'surface-1',
    terminalSuccess: true,
    controllerValidation: true,
  }).receipt!;
  recordRunStrategy({
    objective: 'whats on my calendar today',
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 12_000,
    learningReceipt: receipt,
  });
  rememberToolSchema('OUTLOOK_GET_CALENDAR_VIEW', {
    type: 'object',
    properties: { start_datetime: { type: 'string' } },
  });
  const tick = await tickActiveToolSurfaceHeartbeat();
  assert.equal(tick.tools, 1);
  const surface = readActiveToolSurface();
  assert.equal(surface.tools[0]?.name, 'outlook_get_calendar_view');
  assert.equal(surface.tools[0]?.schemaReady, true);
  assert.equal(surface.tools[0]?.source, 'strategy');
});
