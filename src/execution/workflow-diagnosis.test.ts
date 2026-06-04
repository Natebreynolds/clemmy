/**
 * Run: npx tsx --test src/execution/workflow-diagnosis.test.ts
 *
 * Covers the pure + persistence pieces of workflow self-heal. The
 * diagnosis agent (LLM) and the full edit_step apply (writeWorkflow) are
 * verified live, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect state to a throwaway home BEFORE importing the module so
// FIXES_DIR (under STATE_DIR) doesn't touch the real ~/.clementine-next.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clemmy-diag-'));
process.env.CLEMENTINE_HOME = path.join(TMP_HOME, '.clementine-next');
fs.mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

const mod = await import('./workflow-diagnosis.js');
const {
  detectBlockedSteps,
  humanizeStepOutput,
  renderLegibleOutcome,
  renderSuccessBody,
  recordProposedFix,
  loadProposedFix,
  listProposedFixes,
  dismissProposedFix,
  applyProposedFix,
} = mod;

test('detectBlockedSteps finds blocked results (object + JSON string), skips synthesis', () => {
  const blocked = detectBlockedSteps({
    a: { ok: true, value: 1 },
    b: { blocked: true, reason: 'missing sheet id' },
    c: '{"blocked":true,"reason":"drive error"}',
    d: 'plain text output',
    __synthesis__: { blocked: true, reason: 'should be ignored' },
  });
  const ids = blocked.map((b) => b.stepId).sort();
  assert.deepEqual(ids, ['b', 'c']);
  assert.equal(blocked.find((b) => b.stepId === 'b')?.reason, 'missing sheet id');
});

test('detectBlockedSteps catches PROSE blocks (root no longer missed)', () => {
  const blocked = detectBlockedSteps({
    a: 'Blocked the workflow step because the Google Drive connection is expired.',
    b: { ok: true },
    c: 'Could not find any results, but here is a summary.', // NOT a block (no block prefix)
  });
  const ids = blocked.map((x) => x.stepId);
  assert.deepEqual(ids, ['a']);
  assert.match(blocked[0].reason, /Drive connection is expired/);
});

test('detectBlockedSteps orders by stepOrder so the ROOT (earliest) is first', () => {
  const stepOutputs = {
    // detected in this object order, but DAG order is tracker → contact
    select_best_contact: { blocked: true, reason: 'shell needs approval (a guess)' },
    find_or_create_tracker: 'Blocked the workflow step because Drive is expired.',
  };
  const blocked = detectBlockedSteps(stepOutputs, ['find_or_create_tracker', 'select_best_contact']);
  assert.equal(blocked[0].stepId, 'find_or_create_tracker'); // root first
  assert.equal(blocked[1].stepId, 'select_best_contact');
});

test('detectBlockedSteps: forEach aggregate (real {itemKey,output} string) with polite blocks → needs attention', () => {
  // The runner stores a forEach aggregate as an array of {itemKey, output}
  // wrappers (per-item result nested in .output), JSON.stringified. Without
  // unwrapping + array-awareness, a fan-out where items quietly blocked reads
  // as a clean "completed" run. (This is the exact shape the live engine
  // produces — caught by the runtime smoke, not the original unit test.)
  const blocked = detectBlockedSteps({
    fanout: JSON.stringify([
      { itemKey: 'idx-0', output: { ok: true, lead: 'acme' } },
      { itemKey: 'idx-1', output: '{"blocked":true,"reason":"no contact email found"}' },
      { itemKey: 'idx-2', output: { ok: false } },
    ]),
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].stepId, 'fanout');
  assert.equal(blocked[0].kind, 'self_reported_failure'); // not routed to the prompt Doctor
  assert.match(blocked[0].reason, /2 of 3 items/);
  assert.match(blocked[0].reason, /no contact email found/);
});

test('detectBlockedSteps: raw item objects (no wrapper) are inspected too', () => {
  const blocked = detectBlockedSteps({
    fanout: [{ ok: true }, { someStatus: 'fail' }],
  });
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].reason, /1 of 2 items/);
});

test('detectBlockedSteps: a healthy forEach aggregate is NOT flagged', () => {
  const blocked = detectBlockedSteps({
    fanout: JSON.stringify([
      { itemKey: 'idx-0', output: { ok: true, lead: 'acme' } },
      { itemKey: 'idx-1', output: { ok: true, lead: 'globex', error: null } }, // error:null is healthy
      { itemKey: 'idx-2', output: 'done' },
    ]),
    plainArray: JSON.stringify([1, 2, 3]),
  });
  assert.deepEqual(blocked, []);
});

test('humanizeStepOutput surfaces human content, not raw JSON', () => {
  assert.equal(humanizeStepOutput({ notified: true, body: 'Good morning, Nate.' }), 'Good morning, Nate.');
  assert.equal(humanizeStepOutput({ summary: 'Scanned 10 emails.' }), 'Scanned 10 emails.');
  assert.match(humanizeStepOutput({ blocked: true, reason: 'drive error' }), /^⚠️ blocked: drive error/);
  assert.equal(humanizeStepOutput('already a string'), 'already a string');
});

test('humanizeStepOutput renders bookkeeping as a terse status line, not JSON', () => {
  const out = humanizeStepOutput({ ok: true, source: 'sf', recordsFound: 100, digestShown: 10, readOnly: true });
  assert.match(out, /✓ done/);
  assert.match(out, /recordsFound: 100/);
  assert.doesNotMatch(out, /[{}]/); // no JSON braces
});

test('renderSuccessBody prefers synthesis prose, else humanizes steps (no JSON dump)', () => {
  // with synthesis
  assert.equal(
    renderSuccessBody({ steps: [{ id: 'a' }], stepOutputs: { a: { ok: true } }, finalOutput: 'Here is your summary.', hasSynthesis: true }),
    'Here is your summary.',
  );
  // single step, no synthesis -> humanized, not JSON
  const body = renderSuccessBody({
    steps: [{ id: 'main' }],
    stepOutputs: { main: { ok: true, recordsFound: 100 } },
    finalOutput: '## main\n{"ok":true,"recordsFound":100}',
    hasSynthesis: false,
  });
  assert.match(body, /✓ done/);
  assert.doesNotMatch(body, /\{/);
});

test('renderLegibleOutcome: clean completion when nothing blocked', () => {
  const out = renderLegibleOutcome({ workflowName: 'wf', blockedSteps: [], fallbackBody: 'all good' });
  assert.equal(out.needsAttention, false);
  assert.equal(out.title, 'Workflow completed: wf');
  assert.equal(out.body, 'all good');
});

test('renderLegibleOutcome: blocked + auto-applicable diagnosis offers the fix command', () => {
  const out = renderLegibleOutcome({
    workflowName: 'morning-prospect-prep',
    blockedSteps: [{ stepId: 'find_or_create_tracker', reason: 'Drive search failed', kind: 'blocked' as const }],
    diagnosis: {
      summary: 'The tracker sheet could not be found.',
      rootCause: 'The Drive query syntax was wrong.',
      fix: { kind: 'edit_step', stepId: 'find_or_create_tracker', description: 'Use the correct Drive search.', newStepPrompt: 'NEW PROMPT', service: null, autoApplicable: true },
      confidence: 'high',
    },
    fixId: 'fix-abc123',
    fallbackBody: 'irrelevant',
  });
  assert.equal(out.needsAttention, true);
  assert.match(out.title, /needs attention/i);
  assert.match(out.body, /couldn't finish/);
  assert.match(out.body, /apply fix fix-abc123/);
});

test('recordProposedFix → load → list → dismiss round-trips', () => {
  const diagnosis = {
    summary: 's', rootCause: 'r',
    fix: { kind: 'edit_step' as const, stepId: 'main', description: 'd', newStepPrompt: 'P', service: null, autoApplicable: true },
    confidence: 'high' as const,
  };
  const fix = recordProposedFix('wf', 'run-1', diagnosis);
  assert.match(fix.id, /^fix-/);
  assert.equal(loadProposedFix(fix.id)?.workflow, 'wf');
  assert.ok(listProposedFixes().some((f) => f.id === fix.id));
  assert.equal(dismissProposedFix(fix.id), true);
  assert.equal(loadProposedFix(fix.id), null);
});

test('applyProposedFix refuses unknown id and non-auto-applicable fixes', () => {
  assert.equal(applyProposedFix('fix-nope').ok, false);

  const reconnect = recordProposedFix('wf', 'run-2', {
    summary: 's', rootCause: 'r',
    fix: { kind: 'reconnect_service' as const, stepId: 'main', description: 'Reconnect Google Drive.', newStepPrompt: null, service: 'Google Drive', autoApplicable: false },
    confidence: 'high' as const,
  });
  const res = applyProposedFix(reconnect.id);
  assert.equal(res.ok, false);
  assert.match(res.message, /Reconnect Google Drive/);
});
