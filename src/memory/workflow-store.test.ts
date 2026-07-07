/**
 * Run: npx tsx --test src/memory/workflow-store.test.ts
 *
 * The declarative approval gate must survive the YAML round-trip:
 * writeWorkflow → readWorkflow preserves requiresApproval + approvalPreview
 * (and accepts snake_case from hand-authored SKILL.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wfstore-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { writeWorkflow, readWorkflow } = await import('./workflow-store.js');
const { WORKFLOWS_DIR } = await import('./vault.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

test('requiresApproval + approvalPreview round-trip through write→read', () => {
  writeWorkflow('gate-rt', {
    name: 'gate-rt',
    description: 'round-trip test',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'prep', prompt: 'Prepare the batch.' },
      {
        id: 'send',
        prompt: 'Send the batch.',
        dependsOn: ['prep'],
        requiresApproval: true,
        approvalPreview: 'Send 25 emails',
      },
    ],
  });

  const wf = readWorkflow('gate-rt');
  assert.ok(wf, 'workflow reads back');
  const send = wf!.data.steps.find((s) => s.id === 'send');
  assert.equal(send?.requiresApproval, true);
  assert.equal(send?.approvalPreview, 'Send 25 emails');
  // The ungated step stays autonomous (no flag).
  const prep = wf!.data.steps.find((s) => s.id === 'prep');
  assert.notEqual(prep?.requiresApproval, true);
});

test('hand-authored snake_case (requires_approval / approval_preview) is parsed', () => {
  const dir = path.join(WORKFLOWS_DIR, 'gate-snake');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      'name: gate-snake',
      'description: snake-case gate',
      'enabled: true',
      'steps:',
      '  - id: send',
      '    requires_approval: true',
      '    approval_preview: Publish the post',
      '---',
      '',
      '## step: send',
      '',
      'Publish it.',
      '',
    ].join('\n'),
    'utf-8',
  );
  const wf = readWorkflow('gate-snake');
  const send = wf!.data.steps.find((s) => s.id === 'send');
  assert.equal(send?.requiresApproval, true);
  assert.equal(send?.approvalPreview, 'Publish the post');
});

test('typed step contract (inputs/output) round-trips through write→read', () => {
  writeWorkflow('contract-rt', {
    name: 'contract-rt',
    description: 'contract round-trip',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'normalize',
        prompt: 'Normalize {{input.url}}.',
        inputs: { url: { type: 'string', required: true, from: 'input.url' } },
        output: { type: 'object', required_keys: ['domain', 'clientName'] },
      },
    ],
  });
  const wf = readWorkflow('contract-rt');
  const s = wf!.data.steps.find((x) => x.id === 'normalize');
  assert.equal(s?.inputs?.url?.required, true);
  assert.equal(s?.inputs?.url?.from, 'input.url');
  assert.equal(s?.output?.type, 'object');
  assert.deepEqual(s?.output?.required_keys, ['domain', 'clientName']);
});

test('step intent round-trips through write→read for intent-routed workers', () => {
  writeWorkflow('intent-rt', {
    name: 'intent-rt',
    description: 'intent round-trip',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'design', prompt: 'Design the landing page.', intent: 'design' },
      { id: 'ship', prompt: 'Publish the files.', dependsOn: ['design'] },
    ],
  });
  const wf = readWorkflow('intent-rt');
  const design = wf!.data.steps.find((s) => s.id === 'design');
  const ship = wf!.data.steps.find((s) => s.id === 'ship');
  assert.equal(design?.intent, 'design');
  assert.equal(ship?.intent, undefined);
});

test('forEachNewOnly round-trips through write→read for recurring fan-out workflows', () => {
  writeWorkflow('new-only-rt', {
    name: 'new-only-rt',
    description: 'new-only fan-out round-trip',
    enabled: true,
    trigger: { schedule: '0 8 * * *', manual: true },
    steps: [
      { id: 'pull', prompt: 'Pull the latest leads.' },
      { id: 'send', prompt: 'Send each new lead.', dependsOn: ['pull'], forEach: 'pull', forEachNewOnly: true },
    ],
  });
  const wf = readWorkflow('new-only-rt');
  const send = wf!.data.steps.find((s) => s.id === 'send');
  assert.equal(send?.forEach, 'pull');
  assert.equal(send?.forEachNewOnly, true);
});

test('hand-authored snake_case for_each_new_only is parsed', () => {
  const dir = path.join(WORKFLOWS_DIR, 'new-only-snake');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      'name: new-only-snake',
      'description: snake-case new-only fanout',
      'enabled: true',
      'steps:',
      '  - id: send',
      '    forEach: pull',
      '    for_each_new_only: true',
      '---',
      '',
      '## step: send',
      '',
      'Send it.',
      '',
    ].join('\n'),
    'utf-8',
  );
  const send = readWorkflow('new-only-snake')!.data.steps.find((s) => s.id === 'send');
  assert.equal(send?.forEach, 'pull');
  assert.equal(send?.forEachNewOnly, true);
});

test('output.verify (verifiable handles) round-trips', () => {
  writeWorkflow('verify-rt', {
    name: 'verify-rt', description: 'verify round-trip', enabled: true, trigger: { manual: true },
    steps: [{
      id: 'deploy', prompt: 'Deploy.',
      output: { type: 'object', verify: { path_exists: ['indexPath'], url_present: ['netlifyUrl'] } },
    }],
  });
  const s = readWorkflow('verify-rt')!.data.steps.find((x) => x.id === 'deploy');
  assert.deepEqual(s?.output?.verify?.path_exists, ['indexPath']);
  assert.deepEqual(s?.output?.verify?.url_present, ['netlifyUrl']);
});

test('P0-3 sideEffect round-trips as side_effect — INCLUDING read', () => {
  writeWorkflow('side-rt', {
    name: 'side-rt', description: 'side-effect round-trip', enabled: true, trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Read the leads.', sideEffect: 'read' },
      { id: 'save', prompt: 'Write them to the sheet.', sideEffect: 'write', dependsOn: ['pull'] },
      { id: 'send', prompt: 'Email the batch.', sideEffect: 'send', dependsOn: ['save'] },
    ],
  });
  const steps = readWorkflow('side-rt')!.data.steps;
  // A declared 'read' MUST survive rewrite. Undeclared ≠ read: undeclared
  // falls back to the prose heuristic, which has misclassified read-only
  // steps as write and parked them on crash-resume (scorpion-facebook-trends
  // 2026-06-11). Dropping 'read' on rewrite silently resurrected that trap.
  assert.equal(steps.find((x) => x.id === 'pull')?.sideEffect, 'read');
  assert.equal(steps.find((x) => x.id === 'save')?.sideEffect, 'write');
  assert.equal(steps.find((x) => x.id === 'send')?.sideEffect, 'send');
});

test('P0-3 hand-authored snake_case side_effect is parsed', () => {
  const dir = path.join(WORKFLOWS_DIR, 'side-snake');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---', 'name: side-snake', 'description: snake side-effect', 'enabled: true',
      'steps:', '  - id: send', '    side_effect: send', '---', '', '## step: send', '', 'Send it.', '',
    ].join('\n'),
    'utf-8',
  );
  const send = readWorkflow('side-snake')!.data.steps.find((s) => s.id === 'send');
  assert.equal(send?.sideEffect, 'send');
});

test('P1-9 non_empty / min_items output contract round-trips', () => {
  writeWorkflow('empty-rt', {
    name: 'empty-rt', description: 'emptiness round-trip', enabled: true, trigger: { manual: true },
    steps: [{
      id: 'pull', prompt: 'Pull prospects.',
      output: { type: 'object', non_empty: ['prospects'], min_items: { prospects: 1 } },
    }],
  });
  const s = readWorkflow('empty-rt')!.data.steps.find((x) => x.id === 'pull');
  assert.deepEqual(s?.output?.non_empty, ['prospects']);
  assert.deepEqual(s?.output?.min_items, { prospects: 1 });
});

test('retryBudget round-trips as retry_budget and clamps malformed values', () => {
  writeWorkflow('retry-rt', {
    name: 'retry-rt', description: 'retry round-trip', enabled: true, trigger: { manual: true },
    steps: [
      { id: 'a', prompt: 'do a', retryBudget: 3 },
      { id: 'b', prompt: 'do b', retryBudget: 999 },  // clamps to 10
      { id: 'c', prompt: 'do c', retryBudget: 0 },     // dropped (no retry)
      { id: 'd', prompt: 'do d', retryBudget: 2.7 },   // floors to 2
    ] as never,
  });
  const steps = readWorkflow('retry-rt')!.data.steps;
  assert.equal(steps.find((x) => x.id === 'a')?.retryBudget, 3);
  assert.equal(steps.find((x) => x.id === 'b')?.retryBudget, 10);
  assert.equal(steps.find((x) => x.id === 'c')?.retryBudget, undefined);
  assert.equal(steps.find((x) => x.id === 'd')?.retryBudget, 2);
});

test('deterministic step inline source materializes to scripts/ and is stripped from frontmatter', () => {
  const body = "#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true }));";
  writeWorkflow('agent-writes-code', {
    name: 'agent-writes-code', description: 'agent authors a script', enabled: true, trigger: { manual: true },
    steps: [
      { id: 'run', deterministic: { runner: 'do-it.js', source: body } },
    ] as never,
  });

  // 1. the script file was written under the workflow's scripts/ dir
  const scriptPath = path.join(WORKFLOWS_DIR, 'agent-writes-code', 'scripts', 'do-it.js');
  assert.ok(existsSync(scriptPath), 'expected scripts/do-it.js to exist');
  assert.equal(readFileSync(scriptPath, 'utf-8'), `${body}\n`);

  // 2. inline source is NOT persisted — the on-disk step is just { runner }
  const skill = readFileSync(path.join(WORKFLOWS_DIR, 'agent-writes-code', 'SKILL.md'), 'utf-8');
  assert.ok(!skill.includes('console.log'), 'source must not leak into SKILL.md frontmatter');

  // 3. readback yields a runnable deterministic step pointing at the file
  const step = readWorkflow('agent-writes-code')!.data.steps.find((s) => s.id === 'run');
  assert.equal(step?.deterministic?.runner, 'do-it.js');
  assert.equal((step?.deterministic as { source?: string } | undefined)?.source, undefined);
});

test('an already-"scripts/"-prefixed runner is honored and a path escape is rejected', () => {
  writeWorkflow('prefixed-runner', {
    name: 'prefixed-runner', description: 'prefixed', enabled: true, trigger: { manual: true },
    steps: [{ id: 'run', deterministic: { runner: 'scripts/nested.py', source: 'print("{}")' } }] as never,
  });
  assert.ok(existsSync(path.join(WORKFLOWS_DIR, 'prefixed-runner', 'scripts', 'nested.py')));

  assert.throws(() => writeWorkflow('escape-runner', {
    name: 'escape-runner', description: 'escape', enabled: true, trigger: { manual: true },
    steps: [{ id: 'run', deterministic: { runner: '../evil.js', source: 'x' } }] as never,
  }), /inside the workflow scripts\/ dir|outside scripts/);
});
