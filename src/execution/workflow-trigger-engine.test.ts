/**
 * T2.1 — trigger engine: registry sync + system-event/webhook fire + dedupe.
 *
 * Per-test temp dir via CLEMENTINE_HOME (BINDING) so we never touch real
 * state — set BEFORE any src import so BASE_DIR resolves into the temp home.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-trigger-engine-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const {
  syncWorkflowTriggerRegistry,
  fireWorkflowSystemEvent,
  fireWorkflowWebhook,
  workflowTriggerFilterMatches,
  workflowInputsFromTriggerPayload,
} = await import('./workflow-trigger-engine.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

function writeWorkflow(name: string, frontmatterLines: string[]): void {
  const dir = path.join(WORKFLOWS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: test workflow ${name}`, 'enabled: true', ...frontmatterLines, '---', '', '## step: only', 'Do the thing.', ''].join('\n'),
    'utf-8',
  );
}

function queuedRuns(): Array<{ workflow: string; inputs?: Record<string, string> }> {
  let files: string[] = [];
  try { files = readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')));
}

test('sync + system_event fire: a subscribed workflow queues a run; same dedupe key never fires twice', () => {
  writeWorkflow('on-new-lead', [
    'trigger:',
    '  events:',
    '    - type: crm.lead.created',
    '      dedupeKey: "lead-{{payload.id}}"',
    'steps:',
    '  - id: only',
    '    prompt: Handle the new lead {{input.name}}.',
    'inputs:',
    '  name:',
    '    type: string',
  ]);
  const synced = syncWorkflowTriggerRegistry();
  assert.ok(synced.synced >= 1, 'trigger row synced');

  const first = fireWorkflowSystemEvent('crm.lead.created', { id: 'L-1', name: 'Acme' });
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'queued');
  assert.ok(first[0].runId);
  const runs = queuedRuns().filter((r) => r.workflow === 'on-new-lead');
  assert.equal(runs.length, 1);
  // declared input bound from the payload — code-level, no LLM
  assert.equal(runs[0].inputs?.name, 'Acme');

  // same dedupe key (payload id) → deduped at the EVENT layer, even with a different payload body
  const second = fireWorkflowSystemEvent('crm.lead.created', { id: 'L-1', name: 'Acme Renamed' });
  assert.equal(second[0].status, 'deduped_event');
  assert.equal(queuedRuns().filter((r) => r.workflow === 'on-new-lead').length, 1);

  // a NEW lead fires again
  const third = fireWorkflowSystemEvent('crm.lead.created', { id: 'L-2', name: 'Globex' });
  assert.equal(third[0].status, 'queued');
});

test('filter mismatch → filtered, no run; unsubscribed event type → no results', () => {
  writeWorkflow('on-vip-lead', [
    'trigger:',
    '  events:',
    '    - type: crm.lead.scored',
    '      filter:',
    '        tier: vip',
    'steps:',
    '  - id: only',
    '    prompt: Greet the VIP.',
  ]);
  syncWorkflowTriggerRegistry();

  const miss = fireWorkflowSystemEvent('crm.lead.scored', { id: 'L-9', tier: 'standard' });
  assert.equal(miss.find((r) => r.workflowName === 'on-vip-lead')?.status, 'filtered');
  assert.equal(queuedRuns().filter((r) => r.workflow === 'on-vip-lead').length, 0);

  const hit = fireWorkflowSystemEvent('crm.lead.scored', { id: 'L-10', tier: 'vip' });
  assert.equal(hit.find((r) => r.workflowName === 'on-vip-lead')?.status, 'queued');

  assert.deepEqual(fireWorkflowSystemEvent('nobody.subscribes', { x: 1 }), []);
});

test('sync preserves multiple filters for the same workflow event type', () => {
  writeWorkflow('on-regional-lead', [
    'trigger:',
    '  events:',
    '    - type: crm.lead.regional',
    '      filter:',
    '        region: east',
    '      dedupeKey: "east-{{payload.id}}"',
    '    - type: crm.lead.regional',
    '      filter:',
    '        region: west',
    '      dedupeKey: "west-{{payload.id}}"',
    'steps:',
    '  - id: only',
    '    prompt: Handle {{input.region}} lead.',
    'inputs:',
    '  region:',
    '    type: string',
  ]);
  syncWorkflowTriggerRegistry();

  const east = fireWorkflowSystemEvent('crm.lead.regional', { id: 'R-1', region: 'east' })
    .filter((r) => r.workflowName === 'on-regional-lead');
  assert.equal(east.filter((r) => r.status === 'queued').length, 1);
  assert.equal(east.filter((r) => r.status === 'filtered').length, 1);

  const west = fireWorkflowSystemEvent('crm.lead.regional', { id: 'R-2', region: 'west' })
    .filter((r) => r.workflowName === 'on-regional-lead');
  assert.equal(west.filter((r) => r.status === 'queued').length, 1);
  assert.equal(west.filter((r) => r.status === 'filtered').length, 1);
});

test('webhook fire: matches trigger.webhookPath; registry removes triggers when the workflow is disabled', () => {
  writeWorkflow('on-form-submit', [
    'trigger:',
    '  webhookPath: form-submit',
    'steps:',
    '  - id: only',
    '    prompt: Process the form.',
  ]);
  syncWorkflowTriggerRegistry();

  const fired = fireWorkflowWebhook('form-submit', { email: 'a@b.co' });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, 'queued');

  // disable the workflow → sync removes the trigger → the hook stops firing
  const dir = path.join(WORKFLOWS_DIR, 'on-form-submit');
  const skill = readFileSync(path.join(dir, 'SKILL.md'), 'utf-8').replace('enabled: true', 'enabled: false');
  writeFileSync(path.join(dir, 'SKILL.md'), skill, 'utf-8');
  const after = syncWorkflowTriggerRegistry();
  assert.ok(after.removed >= 1, 'disabled workflow trigger removed');
  assert.deepEqual(fireWorkflowWebhook('form-submit', { email: 'c@d.co' }), []);
});

test('workflowTriggerFilterMatches: dot-paths and strict equality', () => {
  assert.equal(workflowTriggerFilterMatches({ 'lead.tier': 'vip' }, { lead: { tier: 'vip' } }), true);
  assert.equal(workflowTriggerFilterMatches({ 'lead.tier': 'vip' }, { lead: { tier: 'std' } }), false);
  assert.equal(workflowTriggerFilterMatches({ count: 3 }, { count: 3 }), true);
  assert.equal(workflowTriggerFilterMatches({ count: 3 }, { count: '3' }), false);
  assert.equal(workflowTriggerFilterMatches({}, { anything: true }), true);
});

test('workflowInputsFromTriggerPayload: binds declared inputs only; `payload` input gets the JSON', () => {
  const def = {
    name: 'x', description: '', enabled: true, trigger: {}, steps: [],
    inputs: { url: { type: 'string' as const }, payload: {}, missing: {} },
  };
  const inputs = workflowInputsFromTriggerPayload(def, { url: 'https://a.co', extra: 'ignored', nested: { no: 1 } });
  assert.equal(inputs.url, 'https://a.co');
  assert.equal(typeof inputs.payload, 'string');
  assert.ok(inputs.payload.includes('https://a.co'));
  assert.equal('missing' in inputs, false);
  assert.equal('extra' in inputs, false);
});
