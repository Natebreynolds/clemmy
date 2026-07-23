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
  fixIsAutoApplicable,
  sanitizeOutputContract,
  sanitizeStepInputs,
  sanitizeAllowedTools,
  revertWorkflowFix,
  listFixBackups,
  detectSelfReportedFailure,
  deepSelfReportedFailure,
  detectProseSelfReportedFailure,
  diagnoseWorkflowBlock,
  prependRootCauseBlock,
  _testOnly_sanitizeWorkflowDiagnosisOutput,
} = mod;
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');

test('deepSelfReportedFailure: finds a failure nested below the top level; null on healthy data', () => {
  // Top-level check (parity with detectSelfReportedFailure).
  assert.ok(deepSelfReportedFailure({ ok: false }));
  // Nested one level (the live-smoke shape): error wrapped under a data key.
  assert.match(
    deepSelfReportedFailure({ records: { ok: false, error: 'Unable to retrieve tool' } }) ?? '',
    /ok=false/,
  );
  // Nested error string deeper down.
  assert.match(deepSelfReportedFailure({ a: { b: { error: 'boom' } } }) ?? '', /error="boom"/);
  assert.match(deepSelfReportedFailure({ result: { blocked: true, reason: 'tool surface missing' } }) ?? '', /blocked=true/);
  // Healthy data — no false positive (a normal records payload).
  assert.equal(deepSelfReportedFailure({ records: [{ id: 1, name: 'x' }], count: 1 }), null);
  assert.equal(deepSelfReportedFailure('just a string'), null);
  assert.equal(deepSelfReportedFailure(null), null);
  // Base detector still only sees the top level (unchanged).
  assert.equal(detectSelfReportedFailure({ records: { ok: false } }), null);
});

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

test('detectBlockedSteps: nested blocked/failure envelopes mark real runs needs-attention', () => {
  const blocked = detectBlockedSteps({
    find_official_page: { output: { blocked: true, reason: 'workflow runtime did not expose composio_execute_tool' } },
    scrape_and_analyze: { result: { ok: false, error: 'Unable to retrieve tool APIFY_RUN_ACTOR' } },
    healthy: { output: { rows: [{ id: 1 }] } },
  }, ['find_official_page', 'scrape_and_analyze', 'healthy']);
  assert.deepEqual(blocked.map((b) => b.stepId), ['find_official_page', 'scrape_and_analyze']);
  assert.equal(blocked[0].kind, 'self_reported_failure');
  assert.match(blocked[0].reason, /blocked=true|composio_execute_tool/);
  assert.match(blocked[1].reason, /ok=false/);
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

test('detectBlockedSteps: prose tool/runtime failures are partial success, not clean success', () => {
  assert.match(
    detectProseSelfReportedFailure('Briefing generated, but goal_list/goal_get errored out while fetching active goals.') ?? '',
    /goal_list\/goal_get errored out/,
  );
  assert.equal(
    detectProseSelfReportedFailure('Three campaigns failed to produce qualified leads this week.'),
    null,
    'ordinary business failure prose is not a runtime/tool failure',
  );
  const blocked = detectBlockedSteps({
    morning_briefing: 'The briefing is ready. Note: the goal tools errored out, so goals may be incomplete.',
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].kind, 'self_reported_failure');
  assert.match(blocked[0].reason, /tools errored out/);
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
  assert.equal(humanizeStepOutput({ notified: true, body: 'Good morning, Alex.' }), 'Good morning, Alex.');
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
      fix: { kind: 'edit_step', stepId: 'find_or_create_tracker', description: 'Use the correct Drive search.', newStepPrompt: 'NEW PROMPT', newOutputContractJson: null, service: null, autoApplicable: true },
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

test('workflow diagnosis sanitizer accepts fenced schema-drifted JSON', () => {
  const diagnosis = _testOnly_sanitizeWorkflowDiagnosisOutput('```json\n' + JSON.stringify({
    summary: 'The output contract was too strict for valid data.',
    root_cause: 'The step returned records, but not every record has a phone field.',
    fix: {
      kind: 'edit contract',
      step_id: 'fetch_records',
      description: 'Loosen the contract so phone is optional.',
      outputContract: { type: 'array', min_items: { '': 1 } },
    },
    confidence: 'HIGH',
  }) + '\n```');
  assert.ok(diagnosis);
  assert.equal(diagnosis.fix.kind, 'edit_contract');
  assert.equal(diagnosis.fix.stepId, 'fetch_records');
  assert.equal(diagnosis.confidence, 'high');
  assert.equal(diagnosis.fix.autoApplicable, true);
  assert.deepEqual(sanitizeOutputContract(diagnosis.fix.newOutputContractJson), { type: 'array', min_items: { '': 1 } });
  assert.equal(fixIsAutoApplicable(diagnosis.fix), true);
});

test('diagnoseWorkflowBlock classifies missing local MCP tools as runtime/manual, not reconnect_service', async () => {
  const diagnosis = await diagnoseWorkflowBlock({
    workflow: {
      name: 'daily-overdue-salesforce-meetings',
      description: 'Notify Alex about overdue Salesforce meetings.',
      enabled: true,
      trigger: { manual: true },
      steps: [{
        id: 'main',
        prompt: 'Use the Salesforce CLI via run_shell_command, then notify Alex.',
        sideEffect: 'send',
      }],
    } as never,
    blockedSteps: [{
      stepId: 'main',
      kind: 'blocked',
      reason: 'Clementine workflow runtime did not expose required local MCP tools: run_shell_command, notify_user. This is a runtime/tool-surface issue, not a service credential issue.',
    }],
  });

  assert.equal(diagnosis?.fix.kind, 'manual');
  assert.equal(diagnosis?.fix.service, null);
  assert.equal(diagnosis?.fix.autoApplicable, false);
  assert.match(diagnosis?.rootCause ?? '', /runtime\/tool-surface/);
});

test('recordProposedFix → load → list → dismiss round-trips', () => {
  const diagnosis = {
    summary: 's', rootCause: 'r',
    fix: { kind: 'edit_step' as const, stepId: 'main', description: 'd', newStepPrompt: 'P', newOutputContractJson: null, service: null, autoApplicable: true },
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
    fix: { kind: 'reconnect_service' as const, stepId: 'main', description: 'Reconnect Google Drive.', newStepPrompt: null, newOutputContractJson: null, service: 'Google Drive', autoApplicable: false },
    confidence: 'high' as const,
  });
  const res = applyProposedFix(reconnect.id);
  assert.equal(res.ok, false);
  assert.match(res.message, /Reconnect Google Drive/);
});

// ─── #7: rollback / revert of an applied auto-fix ────────────────────

test('applyProposedFix snapshots a backup, and revertWorkflowFix restores the prior prompt', () => {
  writeWorkflow('revert-wf', {
    name: 'revert-wf', description: 'revert test', enabled: true, trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'ORIGINAL step prompt' }],
  } as never);
  const fix = recordProposedFix('revert-wf', 'run-r', {
    summary: 's', rootCause: 'r',
    fix: { kind: 'edit_step' as const, stepId: 'main', description: 'rewrite it', newStepPrompt: 'REWRITTEN step prompt', newOutputContractJson: null, service: null, autoApplicable: true },
    confidence: 'high' as const,
  });
  const applied = applyProposedFix(fix.id);
  assert.equal(applied.ok, true, applied.message);
  assert.ok(applied.backupId, 'a backup id was returned');
  assert.match(applied.message, /revert heal/);
  assert.equal(readWorkflow('revert-wf')!.data.steps[0].prompt, 'REWRITTEN step prompt'); // fix applied
  assert.ok(listFixBackups().some((b) => b.id === applied.backupId));

  const reverted = revertWorkflowFix(applied.backupId!);
  assert.equal(reverted.ok, true, reverted.message);
  assert.equal(readWorkflow('revert-wf')!.data.steps[0].prompt, 'ORIGINAL step prompt'); // restored
  // backup consumed → a second revert is a no-op
  assert.equal(revertWorkflowFix(applied.backupId!).ok, false);
});

test('applyProposedFix keeps enabled workflows ENABLED when a fix introduces readiness gaps', () => {
  writeWorkflow('diagnosis-readiness-wf', {
    name: 'diagnosis-readiness-wf', description: 'readiness regression', enabled: true, trigger: { manual: true },
    steps: [{ id: 'main', prompt: 'Summarize the prospect list.' }],
  } as never);
  const fix = recordProposedFix('diagnosis-readiness-wf', 'run-gap', {
    summary: 's', rootCause: 'r',
    fix: {
      kind: 'edit_step' as const,
      stepId: 'main',
      description: 'rewrite into an external send step',
      newStepPrompt: 'Send the emails to the outside prospect list.',
      newOutputContractJson: null,
      service: null,
      autoApplicable: true,
    },
    confidence: 'high' as const,
  });

  const applied = applyProposedFix(fix.id);
  assert.equal(applied.ok, true, applied.message);
  // F2 (2026-07-23): FLIPPED — a doctor fix that introduces readiness
  // questions no longer silently disables the workflow; questions are
  // advisories, and any genuinely new send parks at the runtime gate.
  assert.doesNotMatch(applied.message, /stayed DISABLED/i);
  const saved = readWorkflow('diagnosis-readiness-wf')!.data;
  assert.equal(saved.enabled, true);
  assert.equal(saved.steps[0].prompt, 'Send the emails to the outside prospect list.');
});

test('revertWorkflowFix on an unknown id fails cleanly', () => {
  assert.equal(revertWorkflowFix('heal-nope').ok, false);
});

// ─── RSH-4: multi-step chain diagnosis ───────────────────────────────────────

test('prependRootCauseBlock: re-roots onto an upstream empty producer of the blocked step', () => {
  // step "draft" blocked, but it consumes "gather" which produced NOTHING → root is gather
  const blocked = [{ stepId: 'draft', reason: 'no leads to draft', kind: 'blocked' as const }];
  const empties = [{ stepId: 'gather', consumerId: 'draft', shape: 'empty array' }];
  const rerooted = prependRootCauseBlock(blocked, empties);
  assert.equal(rerooted[0].stepId, 'gather', 'the empty producer becomes the root');
  assert.match(rerooted[0].reason, /produced empty output.*starved.*draft/s);
  assert.equal(rerooted[1].stepId, 'draft', 'the symptom is kept downstream');
});

test('prependRootCauseBlock: no-op when the block is not a consumer of an empty producer, or the producer already blocked', () => {
  const blocked = [{ stepId: 'draft', reason: 'x', kind: 'blocked' as const }];
  // empty producer feeds a DIFFERENT step → no re-root
  assert.deepEqual(prependRootCauseBlock(blocked, [{ stepId: 'g', consumerId: 'other', shape: 's' }]), blocked);
  // no empties at all → unchanged
  assert.deepEqual(prependRootCauseBlock(blocked, []), blocked);
  // producer already in the blocked list → don't duplicate it
  const withProducer = [{ stepId: 'draft', reason: 'x', kind: 'blocked' as const }, { stepId: 'gather', reason: 'y', kind: 'blocked' as const }];
  assert.deepEqual(prependRootCauseBlock(withProducer, [{ stepId: 'gather', consumerId: 'draft', shape: 's' }]), withProducer);
});

// ─── RSH-1: edit_contract auto-apply ─────────────────────────────────────────

test('sanitizeOutputContract: keeps known keys, drops garbage, rejects unusable', () => {
  assert.deepEqual(sanitizeOutputContract('{"type":"object","required_keys":["name","email"]}'),
    { type: 'object', required_keys: ['name', 'email'] });
  assert.deepEqual(sanitizeOutputContract('{"type":"array","min_items":{"":1}}'),
    { type: 'array', min_items: { '': 1 } });
  // unknown keys + bad value types are stripped
  assert.deepEqual(sanitizeOutputContract('{"type":"object","required_keys":["a",5],"bogus":true,"min_items":{"x":"nope"}}'),
    { type: 'object', required_keys: ['a'] });
  // not usable → null (never written to a workflow)
  assert.equal(sanitizeOutputContract('not json'), null);
  assert.equal(sanitizeOutputContract('{}'), null);
  assert.equal(sanitizeOutputContract('[1,2,3]'), null);
  assert.equal(sanitizeOutputContract(null), null);
});

test('fixIsAutoApplicable: edit_contract needs a sanitizable contract; edit_step needs a prompt', () => {
  const base = { stepId: 's', description: 'd', service: null };
  assert.equal(fixIsAutoApplicable({ ...base, kind: 'edit_contract', newStepPrompt: null, newOutputContractJson: '{"type":"object","required_keys":["x"]}', autoApplicable: true }), true);
  // autoApplicable=false always blocks
  assert.equal(fixIsAutoApplicable({ ...base, kind: 'edit_contract', newStepPrompt: null, newOutputContractJson: '{"type":"object","required_keys":["x"]}', autoApplicable: false }), false);
  // garbage contract → not auto-applicable even if the model claims it is
  assert.equal(fixIsAutoApplicable({ ...base, kind: 'edit_contract', newStepPrompt: null, newOutputContractJson: 'garbage', autoApplicable: true }), false);
  // reconnect/manual never auto-apply
  assert.equal(fixIsAutoApplicable({ ...base, kind: 'reconnect_service', newStepPrompt: null, newOutputContractJson: null, autoApplicable: true }), false);
});

// ─── RSH-3: edit_input + edit_binding ────────────────────────────────────────

test('sanitizeStepInputs: keeps valid bindings, drops garbage, rejects unusable', () => {
  assert.deepEqual(sanitizeStepInputs('{"url":{"from":"input.url"},"limit":{"default":50}}'),
    { url: { from: 'input.url' }, limit: { default: 50 } });
  // a binding with neither `from` nor `default` resolves to nothing → dropped
  assert.deepEqual(sanitizeStepInputs('{"good":{"from":"steps.x.output"},"empty":{"description":"noop"}}'),
    { good: { from: 'steps.x.output' } });
  // unknown fields stripped, type validated
  assert.deepEqual(sanitizeStepInputs('{"n":{"from":"input.n","type":"number","bogus":1,"required":true}}'),
    { n: { from: 'input.n', type: 'number', required: true } });
  assert.equal(sanitizeStepInputs('not json'), null);
  assert.equal(sanitizeStepInputs('{}'), null);
  assert.equal(sanitizeStepInputs('[1,2]'), null);
  assert.equal(sanitizeStepInputs(null), null);
});

test('sanitizeAllowedTools: keeps non-empty strings, dedupes, rejects non-array', () => {
  assert.deepEqual(sanitizeAllowedTools('["a","b","a",""," c "]'), ['a', 'b', 'c']);
  assert.equal(sanitizeAllowedTools('"a"'), null);
  assert.equal(sanitizeAllowedTools('[]'), null);
  assert.equal(sanitizeAllowedTools('nope'), null);
});

test('fixIsAutoApplicable: edit_input needs a usable binding; edit_binding needs a usable tool list', () => {
  const base = { stepId: 's', description: 'd', newStepPrompt: null, newOutputContractJson: null, service: null, autoApplicable: true };
  assert.equal(fixIsAutoApplicable({ ...base, kind: 'edit_input', newInputsJson: '{"url":{"from":"input.url"}}', newAllowedToolsJson: null }), true);
  assert.equal(fixIsAutoApplicable({ ...base, kind: 'edit_input', newInputsJson: '{}', newAllowedToolsJson: null }), false);
  assert.equal(fixIsAutoApplicable({ ...base, kind: 'edit_binding', newInputsJson: null, newAllowedToolsJson: '["composio_gmail_search"]' }), true);
  assert.equal(fixIsAutoApplicable({ ...base, kind: 'edit_binding', newInputsJson: null, newAllowedToolsJson: '[]' }), false);
  assert.equal(fixIsAutoApplicable({ ...base, kind: 'uncodify_step', newInputsJson: null, newAllowedToolsJson: null }), true);
});

test('applyProposedFix: an edit_input fix merges corrected bindings onto the step, backed up + revertible', () => {
  writeWorkflow('input-wf', {
    name: 'input-wf', description: 'i', enabled: true, trigger: { manual: true },
    inputs: { url: { type: 'string' } },
    steps: [{ id: 'fetch', prompt: 'fetch {{input.url}}', inputs: { url: { from: 'input.wrongname' } } }],
  } as never);
  const fix = recordProposedFix('input-wf', 'run-i', {
    summary: 's', rootCause: 'binding pointed at a missing input',
    fix: {
      kind: 'edit_input' as const, stepId: 'fetch', description: 'bind url from input.url',
      newStepPrompt: null, newOutputContractJson: null, newInputsJson: '{"url":{"from":"input.url"}}',
      newAllowedToolsJson: null, service: null, autoApplicable: true,
    },
    confidence: 'high' as const,
  });
  const applied = applyProposedFix(fix.id);
  assert.equal(applied.ok, true, applied.message);
  assert.deepEqual(readWorkflow('input-wf')!.data.steps[0].inputs, { url: { from: 'input.url' } });
  const reverted = revertWorkflowFix(applied.backupId!);
  assert.equal(reverted.ok, true);
  assert.deepEqual(readWorkflow('input-wf')!.data.steps[0].inputs, { url: { from: 'input.wrongname' } });
});

test('applyProposedFix: an edit_binding fix corrects the step allowed-tools surface', () => {
  writeWorkflow('binding-wf', {
    name: 'binding-wf', description: 'b', enabled: true, trigger: { manual: true },
    steps: [{ id: 'act', prompt: 'search then send', allowedTools: ['composio_gmail_send'] }],
  } as never);
  const fix = recordProposedFix('binding-wf', 'run-b', {
    summary: 's', rootCause: 'the search tool was not in the surface',
    fix: {
      kind: 'edit_binding' as const, stepId: 'act', description: 'add the search tool',
      newStepPrompt: null, newOutputContractJson: null, newInputsJson: null,
      newAllowedToolsJson: '["composio_gmail_search","composio_gmail_send"]', service: null, autoApplicable: true,
    },
    confidence: 'high' as const,
  });
  const applied = applyProposedFix(fix.id);
  assert.equal(applied.ok, true, applied.message);
  assert.deepEqual(readWorkflow('binding-wf')!.data.steps[0].allowedTools, ['composio_gmail_search', 'composio_gmail_send']);
});

test('applyProposedFix: uncodify_step restores the preserved model step', () => {
  writeWorkflow('uncodify-wf', {
    name: 'uncodify-wf', description: 'u', enabled: true, trigger: { manual: true },
    steps: [{
      id: 'pull',
      prompt: 'Fetch as a direct call.',
      call: { tool: 'dataforseo_domain_rank_overview', args: { target: '{{input.domain}}' } },
      allowedTools: ['dataforseo_domain_rank_overview'],
      codifiedFrom: { prompt: 'Fetch the domain rank overview adaptively.', allowedTools: ['dataforseo_domain_rank_overview'] },
      output: { type: 'object' },
    }],
  } as never);
  const fix = recordProposedFix('uncodify-wf', 'run-u', {
    summary: 's', rootCause: 'the direct call failed its contract',
    fix: {
      kind: 'uncodify_step' as const, stepId: 'pull', description: 'restore model step',
      newStepPrompt: null, newOutputContractJson: null, newInputsJson: null,
      newAllowedToolsJson: null, service: null, autoApplicable: true,
    },
    confidence: 'high' as const,
  });
  const applied = applyProposedFix(fix.id);
  assert.equal(applied.ok, true, applied.message);
  const step = readWorkflow('uncodify-wf')!.data.steps[0];
  assert.equal(step.prompt, 'Fetch the domain rank overview adaptively.');
  assert.equal(step.call, undefined);
  assert.equal(step.codifiedFrom, undefined);
});

test('applyProposedFix: an edit_contract fix replaces the step output contract, backed up + revertible', () => {
  writeWorkflow('contract-wf', {
    name: 'contract-wf', description: 'c', enabled: true, trigger: { manual: true },
    steps: [{ id: 'gather', prompt: 'gather leads', output: { type: 'object', required_keys: ['name', 'email', 'phone'] } }],
  } as never);
  // the too-strict contract required `phone`; loosen it to what the data always has
  const fix = recordProposedFix('contract-wf', 'run-c', {
    summary: 's', rootCause: 'contract required phone which records legitimately omit',
    fix: {
      kind: 'edit_contract' as const, stepId: 'gather', description: 'drop phone from required_keys',
      newStepPrompt: null, newOutputContractJson: '{"type":"object","required_keys":["name","email"]}',
      service: null, autoApplicable: true,
    },
    confidence: 'high' as const,
  });
  const applied = applyProposedFix(fix.id);
  assert.equal(applied.ok, true, applied.message);
  assert.ok(applied.backupId);
  assert.deepEqual(readWorkflow('contract-wf')!.data.steps[0].output, { type: 'object', required_keys: ['name', 'email'] });

  // revert restores the original (stricter) contract
  const reverted = revertWorkflowFix(applied.backupId!);
  assert.equal(reverted.ok, true, reverted.message);
  assert.deepEqual(readWorkflow('contract-wf')!.data.steps[0].output, { type: 'object', required_keys: ['name', 'email', 'phone'] });
});
