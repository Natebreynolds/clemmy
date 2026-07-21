/**
 * Run: npx tsx --test src/execution/workflow-enforce.test.ts
 *
 * Author/enable-time enforcement of the typed workflow contract.
 * Validation is UNCONDITIONAL (the WORKFLOW_TYPED_CONTRACT rollout flag was
 * removed 2026-05-31 — feedback_no_rollout_flags). Every error describes a
 * workflow that would already fail at run time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkWorkflowForWrite,
  checkRunnabilityConstraints,
  autoRepairWorkflowDefinition,
  prepareWorkflowForWrite,
  stepLooksMutating,
  classifyStepSideEffect,
  workflowStepMutationReceiptContract,
  buildWorkflowMutationContractSnapshot,
  isWorkflowMutationContractSnapshot,
  stepIsTestableRead,
  workflowNeedsCreationTest,
  workflowExecutionSurfaceChanged,
} from './workflow-enforce.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

function wf(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'demo',
    description: 'demo workflow',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'do a thing' }],
    ...overrides,
  } as WorkflowDefinition;
}

test('classifyStepSideEffect: a draft-creation slug is a write — a stale `send` label cannot fabricate a send (2026-07-20 draft trap)', () => {
  // The user's incident: an outreach step switched to draft-only mode but its OLD
  // metadata still carried sideEffect: 'send', so the step classified as an external
  // SEND and the workflow stayed stuck DISABLED. A non-send slug is a write no matter
  // the label — the slug is authoritative for what the tool actually does.
  assert.equal(classifyStepSideEffect({ call: { tool: 'OUTLOOK_CREATE_DRAFT' }, sideEffect: 'send' }), 'write');
  assert.equal(classifyStepSideEffect({ call: { tool: 'OUTLOOK_CREATE_DRAFT' } }), 'write');
  // A REAL send slug is still authoritative — a declared `read` cannot hide it.
  assert.equal(classifyStepSideEffect({ call: { tool: 'OUTLOOK_SEND_EMAIL' }, sideEffect: 'read' }), 'send');
  // A declared class can still STRENGTHEN a read-slug call to write (unchanged).
  assert.equal(classifyStepSideEffect({ call: { tool: 'composio_gmail_search' }, sideEffect: 'write' }), 'write');
});

test('checkWorkflowForWrite: a clean manual workflow validates ok', () => {
  const result = checkWorkflowForWrite(wf());
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('checkWorkflowForWrite: enabled send workflow is allowed (default allowSends=true)', () => {
  // Approval gates are now opt-in. Ungated sends are allowed by default unless
  // the user explicitly sets allowSends: false (strict mode).
  const offending = wf({
    steps: [{ id: 'send', prompt: 'send the emails to the leads' }],
  });
  const result = checkWorkflowForWrite(offending);
  assert.equal(result.ok, true, 'ungated send is allowed with default allowSends=true');
  assert.equal(result.errors.length, 0, 'no errors for autonomous sends');
});

test('checkWorkflowForWrite: enabled send workflow with allowSends=false is rejected', () => {
  // Strict mode: require approval gates for any send when allowSends: false
  const offending = wf({
    enabled: true,
    allowSends: false,
    steps: [{ id: 'send', prompt: 'send the emails to the leads' }],
  });
  const result = checkWorkflowForWrite(offending);
  assert.equal(result.ok, false, 'ungated send is rejected with allowSends=false');
  assert.match(result.errors.join(' '), /requiresApproval|approval/i);
});

test('checkWorkflowForWrite: user-only notification workflow is allowed without approval gate', () => {
  const notification = wf({
    steps: [{ id: 'notify', prompt: 'notify the user with a structured summary of the outlook triage' }],
  });
  const result = checkWorkflowForWrite(notification);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('checkWorkflowForWrite: forEachNewOnly without forEach is rejected through the write seam', () => {
  const result = checkWorkflowForWrite(wf({
    steps: [{ id: 'send', prompt: 'Send each new lead.', forEachNewOnly: true }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /forEachNewOnly.*no forEach source/);
});

// ─── runnability (the "can't author an unrunnable workflow" guarantee) ───

test('checkRunnabilityConstraints: schedule-only + required non-common input with no default → warning', () => {
  // 'segment' is NOT in COMMON_WORKFLOW_INPUT_KEYS, so it has no auto-supply
  // path on a scheduled run — flagged as a warning (non-blocking per graceful degradation).
  const def = wf({
    trigger: { schedule: '0 9 * * *' }, // schedule, no manual
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  const warnings = checkRunnabilityConstraints(def);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no default and no way to be supplied/i);
  assert.match(warnings[0], /segment/);
});

test('checkRunnabilityConstraints: schedule-only + required COMMON input (url) is allowed (injectable)', () => {
  const def = wf({
    trigger: { schedule: '0 9 * * *' },
    steps: [{ id: 'a', prompt: 'audit {{input.url}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

test('checkRunnabilityConstraints: manual trigger never blocks a required input (caller supplies it)', () => {
  const def = wf({
    trigger: { manual: true },
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

test('checkRunnabilityConstraints: schedule-only + required input WITH a default is allowed', () => {
  const def = wf({
    trigger: { schedule: '0 9 * * *' },
    inputs: { segment: { type: 'string', default: 'enterprise' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

test('checkRunnabilityConstraints: schedule + manual together never blocks (a caller can pass inputs)', () => {
  const def = wf({
    trigger: { schedule: '0 9 * * *', manual: true },
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

// ─── auto-repair (creation reliability: save runnable, don't bounce) ──────

test('autoRepair: {{steps.X.output}} on a non-dependency wires the dependsOn', () => {
  // 'analyze' references fetch's output but doesn't depend on it → would
  // render empty at run time and the validator would refuse the save.
  const def = wf({
    steps: [
      { id: 'fetch', prompt: 'fetch the data' },
      { id: 'analyze', prompt: 'analyze {{steps.fetch.output}}' },
    ],
  });
  // Pre-repair: the raw definition is refused.
  assert.equal(checkWorkflowForWrite(def).ok, false);
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.deepEqual(repaired.steps[1].dependsOn, ['fetch']);
  assert.equal(repairs.length, 1);
  assert.match(repairs[0], /analyze.*fetch/);
  // Post-repair: it now validates.
  assert.equal(checkWorkflowForWrite(repaired).ok, true);
});

test('autoRepair: {{steps.X.output}} with a subpath still wires the dependsOn', () => {
  const def = wf({
    steps: [
      { id: 'fetch', prompt: 'fetch' },
      { id: 'use', prompt: 'use {{steps.fetch.output.items}}' },
    ],
  });
  const { def: repaired } = autoRepairWorkflowDefinition(def);
  assert.deepEqual(repaired.steps[1].dependsOn, ['fetch']);
});

test('autoRepair T2.4: multi-item prose with ONE array upstream gets forEach wired mechanically', () => {
  const def = wf({
    steps: [
      { id: 'gather', prompt: 'gather the prospect list', output: { type: 'array', min_items: { '': 1 } } },
      { id: 'work', prompt: 'For each of the 25 prospects, scrape their site and draft a summary one by one.', dependsOn: ['gather'] },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.equal(repaired.steps[1].forEach, 'gather');
  assert.match(repairs.join(' '), /Added forEach: "gather"/);
});

test('autoRepair T2.4: ambiguous (zero or multiple array upstreams) leaves the step alone', () => {
  // zero array upstreams — the dependency has no array-ish contract
  const zero = wf({
    steps: [
      { id: 'gather', prompt: 'gather the prospect list' },
      { id: 'work', prompt: 'For each of the 25 prospects, scrape their site and draft a summary one by one.', dependsOn: ['gather'] },
    ],
  });
  assert.equal(autoRepairWorkflowDefinition(zero).def.steps[1].forEach, undefined);

  // multiple array upstreams — can't pick mechanically
  const multi = wf({
    steps: [
      { id: 'a', prompt: 'list a', output: { type: 'array' } },
      { id: 'b', prompt: 'list b', output: { type: 'array' } },
      { id: 'work', prompt: 'For each of the 25 prospects, scrape their site and draft a summary one by one.', dependsOn: ['a', 'b'] },
    ],
  });
  assert.equal(autoRepairWorkflowDefinition(multi).def.steps[2].forEach, undefined);
});

test('autoRepair: forEach over a non-dependency wires the dependsOn', () => {
  const def = wf({
    steps: [
      { id: 'list', prompt: 'produce a list of leads' },
      { id: 'each', prompt: 'process {{item}}', forEach: 'list' },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.deepEqual(repaired.steps[1].dependsOn, ['list']);
  assert.match(repairs.join(' '), /forEach/);
  assert.equal(checkWorkflowForWrite(repaired).ok, true);
});

test('autoRepair: forEach output path over a non-dependency wires the dependsOn', () => {
  const def = wf({
    steps: [
      { id: 'list', prompt: 'produce a list of leads' },
      { id: 'each', prompt: 'process {{item}}', forEach: '{{steps.list.output.items}}' },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.deepEqual(repaired.steps[1].dependsOn, ['list']);
  assert.match(repairs.join(' '), /forEach/);
  assert.equal(checkWorkflowForWrite(repaired).ok, true);
});

test('autoRepair: undeclared {{input.X}} gets declared so the engine binds it', () => {
  const def = wf({
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  // segment is non-common + undeclared → validator error pre-repair.
  assert.equal(checkWorkflowForWrite(def).ok, false);
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.ok(repaired.inputs?.segment);
  assert.match(repairs.join(' '), /segment/);
  assert.equal(checkWorkflowForWrite(repaired).ok, true);
});

test('autoRepair: undeclared synthesis {{input.X}} gets declared too', () => {
  const def = wf({
    synthesis: { prompt: 'Summarize the workflow result for {{input.sheetId}}.' },
  });
  assert.equal(checkWorkflowForWrite(def).ok, false);
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.ok(repaired.inputs?.sheetId);
  assert.match(repairs.join(' '), /synthesis prompt.*sheetId/);
  assert.equal(checkWorkflowForWrite(repaired).ok, true);
});

test('autoRepair P0-3: derives sideEffect from the prompt when the author omitted it', () => {
  const def = wf({
    steps: [
      { id: 'pull', prompt: 'Read the leads from the CRM.' },
      { id: 'save', prompt: 'Update the Airtable records with the enriched data.', dependsOn: ['pull'] },
      { id: 'send', prompt: 'Send the outreach emails to the list.', dependsOn: ['save'], requiresApproval: true },
    ],
  });
  const { def: repaired } = autoRepairWorkflowDefinition(def);
  assert.equal(repaired.steps[0].sideEffect, 'read');
  assert.equal(repaired.steps[1].sideEffect, 'write');
  assert.equal(repaired.steps[2].sideEffect, 'send');
});

test('autoRepair P0-3: never overrides an author-declared sideEffect', () => {
  const def = wf({
    steps: [{ id: 'a', prompt: 'Send the emails.', sideEffect: 'read', requiresApproval: true } as never],
  });
  const { def: repaired } = autoRepairWorkflowDefinition(def);
  assert.equal(repaired.steps[0].sideEffect, 'read'); // declared value preserved
});

test('checkWorkflowForWrite: validator sees declared sideEffect from typed definitions', () => {
  const result = checkWorkflowForWrite(wf({
    steps: [{ id: 'send', prompt: 'Send the email summary to Alex.', sideEffect: 'read' }],
  }));
  assert.equal(result.ok, true);
  assert.ok(
    result.warnings.some((w) => /declares sideEffect: read/.test(w) && /SEND/.test(w)),
    result.warnings.join('\n'),
  );
});

test('autoRepair: declares COMMON input keys so callers/UI can supply them', () => {
  const def = wf({ steps: [{ id: 'a', prompt: 'audit {{input.url}}' }] });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.ok(repaired.inputs?.url);
  assert.match(repairs.join(' '), /url/);
  assert.equal(checkWorkflowForWrite(repaired).ok, true);
});

test('autoRepair: adds inferred output contracts and a pinned goal for deliverable workflows', () => {
  const def = wf({
    description: 'Audit a website and produce a report URL with rows of findings.',
    steps: [
      {
        id: 'deliver',
        prompt: 'Create a report URL and return rows of findings for the audit.',
      },
    ],
  });
  const before = checkWorkflowForWrite(def);
  assert.ok(before.warnings.some((w) => /output contract/.test(w)));
  assert.ok(before.warnings.some((w) => /no pinned `goal`/.test(w)));

  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);

  assert.deepEqual(repaired.steps[0].output?.required_keys?.sort(), ['rows', 'url']);
  assert.deepEqual(repaired.steps[0].output?.verify?.url_present, ['url']);
  assert.deepEqual(repaired.steps[0].output?.non_empty, ['rows']);
  assert.equal(repaired.steps[0].output?.min_items?.rows, 1);
  assert.ok(repaired.goal?.objective);
  assert.ok(repaired.goal?.successCriteria?.some((criterion) => criterion.includes('deliver')));
  assert.ok(repairs.some((repair) => /Added output contract/.test(repair)));
  assert.ok(repairs.some((repair) => /Pinned a workflow goal/.test(repair)));

  const after = checkWorkflowForWrite(repaired);
  assert.equal(after.ok, true);
  assert.equal(after.warnings.some((w) => /output contract/.test(w)), false);
  assert.equal(after.warnings.some((w) => /no pinned `goal`/.test(w)), false);
});

test('autoRepair: never overrides explicit output contracts or pinned goals', () => {
  const explicitOutput = { type: 'object' as const, required_keys: ['custom'] };
  const explicitGoal = { objective: 'Use the custom success definition.', successCriteria: ['custom must exist'], maxAttempts: 1 };
  const def = wf({
    goal: explicitGoal,
    steps: [
      {
        id: 'deliver',
        prompt: 'Create a report URL and return rows of findings.',
        output: explicitOutput,
      },
    ],
  });

  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);

  assert.equal(repaired.steps[0].output, explicitOutput);
  assert.equal(repaired.goal, explicitGoal);
  assert.equal(repairs.some((repair) => /Added output contract|Pinned a workflow goal/.test(repair)), false);
});

test('workflowExecutionSurfaceChanged: call nodes and watermarks are execution surface', () => {
  const before = wf({
    steps: [{ id: 'list', prompt: '', call: { tool: 'HUBSPOT_LIST_CONTACTS', args: { limit: 10 } } }],
  });
  const changedCall = wf({
    steps: [{ id: 'list', prompt: '', call: { tool: 'HUBSPOT_LIST_COMPANIES', args: { limit: 10 } } }],
  });
  const changedWatermark = wf({
    steps: [
      { id: 'pull', prompt: 'Pull leads.', output: { type: 'array' } },
      { id: 'send', prompt: 'Send each new lead.', dependsOn: ['pull'], forEach: 'pull', forEachNewOnly: true },
    ],
  });
  const noWatermark = wf({
    steps: [
      { id: 'pull', prompt: 'Pull leads.', output: { type: 'array' } },
      { id: 'send', prompt: 'Send each new lead.', dependsOn: ['pull'], forEach: 'pull' },
    ],
  });

  assert.equal(workflowExecutionSurfaceChanged(before, changedCall), true);
  assert.equal(workflowExecutionSurfaceChanged(noWatermark, changedWatermark), true);
});

test('autoRepair: hardens weak live-research contracts with evidence keys', () => {
  const def = wf({
    steps: [
      {
        id: 'research',
        prompt: 'Research the SEO audit with DataForSEO keywords, backlinks, SERP, and Lighthouse evidence.',
        allowedTools: ['mcp__dataforseo_labs_google_ranked_keywords'],
        output: { type: 'object', required_keys: ['domain', 'client'] },
      },
    ],
  });

  const before = checkWorkflowForWrite(def);
  assert.ok(before.warnings.some((w) => /live research tools/.test(w)), before.warnings.join('\n'));

  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  const output = repaired.steps[0].output;

  assert.ok(repairs.some((repair) => /Hardened live research output contract/.test(repair)));
  assert.deepEqual(output?.required_keys?.sort(), ['client', 'domain', 'key_findings', 'source_errors', 'sources']);
  assert.deepEqual(output?.non_empty?.sort(), ['key_findings', 'sources']);
  assert.equal(output?.min_items?.sources, 3);
  assert.equal(output?.min_items?.key_findings, 3);
  assert.equal(checkWorkflowForWrite(repaired).warnings.some((w) => /live research tools/.test(w)), false);
});

test('checkWorkflowForWrite: synthesis participates in validation', () => {
  const result = checkWorkflowForWrite(wf({
    synthesis: { prompt: 'Write the final summary for {{input.sheetId}}.' },
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /Synthesis prompt.*sheetId/);
});

test('autoRepair: refuses to introduce a cycle (leaves the error for the validator)', () => {
  // a already depends on b; b references a's output. Wiring b→a would cycle.
  const def = wf({
    steps: [
      { id: 'a', prompt: 'start {{steps.b.output}}', dependsOn: ['b'] },
      { id: 'b', prompt: 'work' },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  // b is NOT given a dependsOn on a (would cycle); no repair claimed.
  assert.equal(repaired.steps[0].dependsOn?.includes('b'), true);
  assert.equal(repairs.length, 0);
});

test('autoRepair: a clean workflow is returned unchanged (same object, no repairs)', () => {
  const def = wf({
    steps: [
      { id: 'fetch', prompt: 'fetch' },
      { id: 'analyze', prompt: 'analyze {{steps.fetch.output}}', dependsOn: ['fetch'] },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.equal(repairs.length, 0);
  assert.equal(repaired, def); // no clone when nothing changed
});

test('autoRepair: an already-transitive dependency is not re-added', () => {
  // c depends on b, b depends on a; c references a's output → a is already
  // transitively reachable, so no new direct dep is added.
  const def = wf({
    steps: [
      { id: 'a', prompt: 'a' },
      { id: 'b', prompt: 'b', dependsOn: ['a'] },
      { id: 'c', prompt: 'use {{steps.a.output}}', dependsOn: ['b'] },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.deepEqual(repaired.steps[2].dependsOn, ['b']);
  assert.equal(repairs.length, 0);
});

test('prepareWorkflowForWrite: repairs then validates, surfacing repairs', () => {
  const def = wf({
    steps: [
      { id: 'fetch', prompt: 'fetch' },
      { id: 'analyze', prompt: 'analyze {{steps.fetch.output}}' },
    ],
  });
  const prep = prepareWorkflowForWrite(def);
  assert.equal(prep.ok, true);
  assert.deepEqual(prep.def.steps[1].dependsOn, ['fetch']);
  assert.ok(prep.repairs.length >= 1);
});

test('prepareWorkflowForWrite: a genuinely broken workflow still fails after repair', () => {
  // Hand-off language is not auto-fixable → still refused.
  const def = wf({
    steps: [{ id: 'a', prompt: 'do the work; a future turn will handle the rest' }],
  });
  const prep = prepareWorkflowForWrite(def);
  assert.equal(prep.ok, false);
  assert.ok(prep.errors.length >= 1);
});

// ── Part B: creation-test eligibility (which steps run for real / get previewed) ──

test('stepLooksMutating: a send/write step is mutating; a pure read step is not', () => {
  assert.equal(stepLooksMutating({ prompt: 'send the report email to the owner' }), true);
  assert.equal(stepLooksMutating({ prompt: 'create a new record in the Airtable table' }), true);
  assert.equal(stepLooksMutating({ prompt: 'create a Salesforce opportunity report', sideEffect: 'read' }), false);
  assert.equal(stepLooksMutating({ prompt: 'summarize opportunities', sideEffect: 'write' }), true);
  assert.equal(stepLooksMutating({ prompt: 'do anything', requiresApproval: true }), true);
  assert.equal(stepLooksMutating({ prompt: 'scrape the Facebook page posts with Apify' }), false);
  assert.equal(stepLooksMutating({ prompt: 'fetch the latest SERP rankings' }), false);
  assert.equal(stepLooksMutating({ call: { tool: 'composio_gmail_send_email' } }), true);
  assert.equal(stepLooksMutating({ call: { tool: 'composio_airtable_create_record' } }), true);
  assert.equal(stepLooksMutating({ call: { tool: 'composio_hubspot_list_contacts' } }), false);
});

test('workflowStepMutationReceiptContract: only mutating structured calls have durable receipt authority', () => {
  assert.equal(workflowStepMutationReceiptContract({ id: 'plain', prompt: 'Summarize this.' }), 'non_mutating');
  assert.equal(workflowStepMutationReceiptContract({ id: 'read', prompt: 'Fetch records.', sideEffect: 'read' }), 'non_mutating');
  assert.equal(workflowStepMutationReceiptContract({
    id: 'unstructured',
    prompt: 'Update the CRM record.',
    sideEffect: 'write',
  }), 'unreceipted_mutation');
  assert.equal(workflowStepMutationReceiptContract({
    id: 'structured',
    prompt: 'Create the record.',
    call: { tool: 'AIRTABLE_CREATE_RECORD', args: {} },
  }), 'structured_call_receipt');
  assert.equal(workflowStepMutationReceiptContract({
    id: 'structured-read',
    prompt: 'List records.',
    call: { tool: 'AIRTABLE_LIST_RECORDS', args: {} },
  }), 'non_mutating');
});

test('workflow mutation contract snapshot records only exact mutating step contracts and validates strictly', () => {
  const snapshot = buildWorkflowMutationContractSnapshot([
    { id: 'read', prompt: 'Fetch records.', sideEffect: 'read' },
    { id: 'plain_write', prompt: 'Update the CRM.', sideEffect: 'write' },
    { id: 'direct_write', prompt: 'Create it.', call: { tool: 'AIRTABLE_CREATE_RECORD', args: {} } },
  ]);
  assert.deepEqual(snapshot, {
    version: 1,
    steps: {
      direct_write: 'structured_call_receipt',
      plain_write: 'unreceipted_mutation',
    },
  });
  assert.equal(isWorkflowMutationContractSnapshot(snapshot), true);
  assert.equal(isWorkflowMutationContractSnapshot({ version: 1, steps: {} }), true);
  assert.equal(isWorkflowMutationContractSnapshot({ version: 1, steps: { write: 'non_mutating' } }), false);
  assert.equal(isWorkflowMutationContractSnapshot({ version: 1, steps: [] }), false);
  assert.equal(isWorkflowMutationContractSnapshot({ version: 2, steps: {} }), false);
});

test('stepIsTestableRead: read step with an external tool surface is testable', () => {
  // The acme scrape step: read intent + a composio/shell surface → test it for real.
  assert.equal(
    stepIsTestableRead({ prompt: 'scrape the Facebook page with Apify', allowedTools: ['composio_*', 'run_shell_command'] }),
    true,
  );
  // forEach over upstream data counts as reaching external data.
  assert.equal(stepIsTestableRead({ prompt: 'process each item', forEach: '{{steps.a.output}}', allowedTools: ['*'] }), true);
  // A structured read call is a real connection/tool surface even without a prose read verb.
  assert.equal(stepIsTestableRead({ call: { tool: 'composio_hubspot_list_contacts' } }), true);
});

test('stepIsTestableRead: a mutating step is NOT testable (it gets previewed, not run)', () => {
  assert.equal(
    stepIsTestableRead({ prompt: 'create records in Airtable for each prospect', allowedTools: ['composio_*'] }),
    false,
  );
  assert.equal(stepIsTestableRead({ call: { tool: 'composio_gmail_send_email' } }), false);
  assert.equal(stepIsTestableRead({ call: { tool: 'composio_airtable_create_record' } }), false);
});

test('stepIsTestableRead: a pure-LLM read step (no external tools) is NOT worth a creation test', () => {
  assert.equal(stepIsTestableRead({ prompt: 'summarize the findings into three bullets' }), false);
  assert.equal(stepIsTestableRead({ prompt: 'read the upstream data and rank it', allowedTools: [] }), false);
});

test('workflowNeedsCreationTest: true when any step is a testable read, false otherwise', () => {
  // Scrape-then-email: the scrape step is testable → the workflow gets the gate.
  assert.equal(
    workflowNeedsCreationTest(wf({
      steps: [
        { id: 'scrape', prompt: 'scrape the page with Apify', allowedTools: ['composio_*'] },
        { id: 'send', prompt: 'send the summary email', dependsOn: ['scrape'] },
      ],
    })),
    true,
  );
  // All-mutating workflow → nothing read-only to validate → no gate.
  assert.equal(
    workflowNeedsCreationTest(wf({
      steps: [{ id: 'a', prompt: 'send the daily reminder email', requiresApproval: true }],
    })),
    false,
  );
  // Structured read calls are grounded by the same creation-test gate.
  assert.equal(
    workflowNeedsCreationTest(wf({
      steps: [{ id: 'list', prompt: '', call: { tool: 'composio_hubspot_list_contacts', args: {} } }],
    })),
    true,
  );
  // Structured mutating calls are never executed during authoring tests.
  assert.equal(
    workflowNeedsCreationTest(wf({
      steps: [{ id: 'send', prompt: '', call: { tool: 'composio_gmail_send_email', args: {} } }],
    })),
    false,
  );
  // Pure-LLM workflow → no external data to validate → no gate.
  assert.equal(
    workflowNeedsCreationTest(wf({ steps: [{ id: 'a', prompt: 'draft a motivational quote of the day' }] })),
    false,
  );
});
