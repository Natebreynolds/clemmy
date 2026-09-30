import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-efficiency-source-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1' });
const { BASE_DIR } = await import('../config.js');
const usageDir = path.join(BASE_DIR, 'state', 'token-usage');
const { recordModelUsage, usageEfficiencyForTurn } = await import('./usage-log.js');
const { closeEventLog } = await import('./harness/eventlog.js');
after(() => { closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('efficiency readout does not mix recorded requests with the same sequence in another session', () => {
  for (const sessionId of ['efficiency-owner', 'efficiency-other']) {
    recordModelUsage({ sessionId, sourceUserSeq: 123, model: 'fixture-efficiency-model',
      cacheDialect: 'none', inputTokens: 100, outputTokens: 10 });
  }
  const measured = usageEfficiencyForTurn('efficiency-owner', 123);
  assert.equal(measured.frames, 1);
  assert.equal(measured.inputTokens, 100);
});

test('exact trace wins; legacy turn ids need their session and cannot override a different source', () => {
  const rows = [
    { source: 'owner:7', trace: { acceptedSource: 'other:7', logicalTurnId: 'turn:7' } },
    { source: 'legacy-alias', trace: { acceptedSource: 'owner:7', logicalTurnId: 'turn:7' } },
    { source: 'owner:7' },
    { source: 'owner', trace: { logicalTurnId: 'turn:7' } },
    { source: 'other', trace: { logicalTurnId: 'turn:7' } },
    { source: 'owner:8', trace: { logicalTurnId: 'turn:7' } },
  ].map(row => ({ at: '2026-01-10T12:00:00.000Z', kind: 'chat', model: 'fixture-efficiency-model',
    cacheDialect: 'none', inputTokens: 100, outputTokens: 10, totalTokens: 110, ...row }));
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(path.join(usageDir, '2026-01-10.ndjson'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const measured = usageEfficiencyForTurn('owner', 7, new Date(2026, 0, 10, 12));
  assert.equal(measured.frames, 3);
  assert.equal(measured.inputTokens, 300);
});
