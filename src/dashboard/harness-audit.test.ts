import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-audit-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { writeWorkflow } = await import('../memory/workflow-store.js');
const { collectHarnessAudit } = await import('./harness-audit.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function seedToolEvents(): void {
  const dir = path.join(TMP_HOME, 'state', 'tool-events');
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const events = [
    { at: now, toolName: 'read_file', kind: 'read', phase: 'start' },
    ...Array.from({ length: 5 }, () => ({
      at: now,
      sessionId: 'sess-loop',
      toolName: 'cx_rows_get',
      kind: 'read',
      phase: 'start',
    })),
  ];
  writeFileSync(
    path.join(dir, `${day}.ndjson`),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    'utf-8',
  );
}

test('collectHarnessAudit turns local harness signals into prioritized checks', () => {
  seedToolEvents();
  writeWorkflow('risky-outreach', {
    name: 'Risky Outreach',
    description: 'Send prospect updates',
    enabled: true,
    trigger: { schedule: '0 9 * * *', manual: true },
    steps: [
      { id: 'send', prompt: 'Send an email update to each prospect' },
    ],
  } as never);

  const audit = collectHarnessAudit();
  assert.ok(audit.score < 100, 'warnings reduce the overall score');
  assert.equal(audit.summary.warn > 0, true);

  const tools = audit.sections.find((section) => section.id === 'tools');
  assert.ok(tools);
  assert.equal(tools!.checks.find((check) => check.id === 'tool-session-scope')!.status, 'warn');
  assert.equal(tools!.checks.find((check) => check.id === 'loop-vs-batch')!.status, 'warn');

  const workflows = audit.sections.find((section) => section.id === 'workflows');
  assert.ok(workflows);
  assert.equal(workflows!.checks.find((check) => check.id === 'workflow-side-effects')!.status, 'warn');
  assert.equal(workflows!.checks.find((check) => check.id === 'workflow-goals')!.status, 'warn');
});
