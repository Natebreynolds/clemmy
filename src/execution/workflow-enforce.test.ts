/**
 * Run: npx tsx --test src/execution/workflow-enforce.test.ts
 *
 * P2 author/enable-time enforcement: flag-gated (WORKFLOW_TYPED_CONTRACT).
 * Off → no-op (today's behavior). On → a workflow whose data can't flow
 * (malformed/unbound tokens) is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { checkWorkflowForWrite, checkSendGate } from './workflow-enforce.js';

const broken: WorkflowDefinition = {
  name: 'broken',
  description: 'has a malformed token that silently drops the value',
  enabled: true,
  trigger: { manual: true },
  steps: [{ id: 'normalize', prompt: 'Normalize {{url}} into a profile.' }],
};

const clean: WorkflowDefinition = {
  name: 'clean',
  description: 'uses the proper input token',
  enabled: true,
  trigger: { manual: true },
  steps: [{ id: 'normalize', prompt: 'Normalize {{input.url}} into a profile.' }],
};

function withFlag(value: string | undefined, fn: () => void) {
  const prev = process.env.WORKFLOW_TYPED_CONTRACT;
  if (value === undefined) delete process.env.WORKFLOW_TYPED_CONTRACT;
  else process.env.WORKFLOW_TYPED_CONTRACT = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.WORKFLOW_TYPED_CONTRACT;
    else process.env.WORKFLOW_TYPED_CONTRACT = prev;
  }
}

test('flag OFF → no enforcement, even a broken workflow passes (forward-only)', () => {
  withFlag('off', () => {
    assert.deepEqual(checkWorkflowForWrite(broken), { ok: true, errors: [] });
  });
});

test('flag ON → a workflow with a malformed {{url}} token is refused', () => {
  withFlag('on', () => {
    const c = checkWorkflowForWrite(broken);
    assert.equal(c.ok, false);
    assert.ok(c.errors.some((e) => /\{\{url\}\}/.test(e)), JSON.stringify(c.errors));
  });
});

test('flag ON → a clean workflow ({{input.url}}) is allowed', () => {
  withFlag('on', () => {
    assert.equal(checkWorkflowForWrite(clean).ok, true);
  });
});

// ─── send-gate: an enabled workflow that sends must carry an enforced gate ───

const ungatedSend: WorkflowDefinition = {
  name: 'midday-outreach',
  description: 'drafts and sends outreach',
  enabled: true,
  trigger: { schedule: '0 12 * * 1-5' },
  steps: [{ id: 'main', prompt: 'Draft targeted outreach emails and then send approved emails, updating the sheet.' }],
};

const gatedSend: WorkflowDefinition = {
  name: 'midday-outreach',
  description: 'drafts and sends outreach behind a gate',
  enabled: true,
  trigger: { schedule: '0 12 * * 1-5' },
  steps: [
    { id: 'draft', prompt: 'Draft targeted outreach emails for each prospect row.' },
    { id: 'send', prompt: 'Send the approved outreach emails to each prospect.', requiresApproval: true },
  ],
};

const readsEmail: WorkflowDefinition = {
  name: 'triage',
  description: 'reads inbox, never sends',
  enabled: true,
  trigger: { schedule: '0 9 * * *' },
  steps: [{ id: 'main', prompt: 'Read my email inbox, summarize unread messages, and update the tracking sheet. Create drafts but do not send.' }],
};

test('flag ON → an ENABLED send workflow with NO enforced gate is refused', () => {
  withFlag('on', () => {
    const c = checkWorkflowForWrite(ungatedSend);
    assert.equal(c.ok, false);
    assert.ok(c.errors.some((e) => /approval gate/i.test(e)), JSON.stringify(c.errors));
  });
});

test('flag ON → a send workflow WITH an enforced requiresApproval gate is allowed', () => {
  withFlag('on', () => {
    assert.equal(checkWorkflowForWrite(gatedSend).ok, true);
  });
});

test('flag ON → a disabled send workflow is allowed (can\'t fire; disable to draft)', () => {
  withFlag('on', () => {
    assert.equal(checkWorkflowForWrite({ ...ungatedSend, enabled: false }).ok, true);
  });
});

test('flag ON → reading/creating-drafts (no actual send) is NOT flagged (no false-positive)', () => {
  withFlag('on', () => {
    assert.equal(checkWorkflowForWrite(readsEmail).ok, true);
  });
});

test('flag OFF → ungated send passes (forward-only, no enforcement)', () => {
  withFlag('off', () => {
    assert.equal(checkWorkflowForWrite(ungatedSend).ok, true);
  });
});

test('checkSendGate is flag-independent (pure): flags the ungated send directly', () => {
  assert.equal(checkSendGate(ungatedSend).length, 1);
  assert.equal(checkSendGate(gatedSend).length, 0);
  assert.equal(checkSendGate(readsEmail).length, 0);
  assert.equal(checkSendGate({ ...ungatedSend, enabled: false }).length, 0);
});
