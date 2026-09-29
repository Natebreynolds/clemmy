import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-host-completion-contract-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'completion-contract\n');

const events = await import('./eventlog.js');
const host = await import('./host-turn-runner.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { acceptedPlanPreparationReadEvidence, sourceAttemptedCompletionWork, sourceEvidenceLookup,
  sourceIncompleteAttemptsEvidence, sourceSettledReadEvidence, earlierTurnsEvidence } = await import('./host-completion-work.js');
const { DEFAULT_TOOL_RESULT_MAX_CHARS } = await import('./tool-output-format.js');
const plans = await import('./plan-artifacts.js');
const { shouldRunObjectiveJudge, buildObjectiveJudgePrompt, JUDGE_SYSTEM_PROMPT,
  completionJudgeContextAdmission, runRoutedJudgeAttempt, parseCompletionVerdict } = await import('./objective-judge.js');
const { recordCatalogWindow, recordWindowRejection } = await import('./model-window-observations.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { armHostCallAuthority } = await import('./accepted-turn-call-authority.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const hostBindings = await import('./host-call-capability-binding.js');
const { durableLogicalCallContract } = await import('./logical-call-contract.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const { readWorkflowTargetEvidence } = await import('../../execution/workflow-target-evidence.js');
const { judgeWorkflowTarget } = await import('../../execution/workflow-objective-judge.js');
const { captureWorkflowTargetReviewPolicy, parseWorkflowTargetReviewPolicy } = await import('../../execution/workflow-target-review-policy.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

const request = 'Please refresh my Facebook trends report using the Scorpion Facebook URL https://www.facebook.com/scorpion.co and report back the findings.';
const promise = 'The check-in landed; next I’ll actually run the posts scraper against Scorpion’s Facebook page.';
let serial = 0;
function accepted(text = request, sessionId?: string) {
  const id = sessionId ?? events.createSession({ id: `completion-contract-${++serial}`, kind: 'chat' }).id;
  const source = events.appendEvent({ sessionId: id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  return { sessionId: id, sourceUserSeq: source.seq, turn: 1 };
}
function attempted(identity: ReturnType<typeof accepted>, tool = 'tool_search') {
  events.appendEvent({ ...identity, role: 'Clem', type: 'tool_called', data: {
    sourceUserSeq: identity.sourceUserSeq, tool, accounting: 'top_level', callId: `attempt-${serial}`,
  } });
}

test('the Plan review objective requires preparation now and permits justified execution refreshes', () => {
  const session = events.createSession({ id: `plan-refresh-objective-${++serial}`, kind: 'chat' });
  const text = 'Read my current inventory now. Plan a comparison; the inventory will change before I approve execution.';
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text, taskMode: { version: 1, kind: 'plan' } } });
  const objective = host.acceptedObjectiveForSource({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(objective?.endsWith(text), 'the owner’s exact objective stays intact');
  assert.match(objective!, /preparation to do now/);
  assert.match(objective!, /refresh read during execution when freshness/);
  assert.doesNotMatch(objective!, /must never appear as one/);
});
function settledHostRead(identity: ReturnType<typeof accepted>) {
  const digest = 'a'.repeat(64);
  assert.equal(armHostCallAuthority({ ...identity, catalogRevisionDigest: digest,
    bindingRevisionDigest: digest, maxLogicalCalls: 20, maxParallelCalls: 8 }).status, 'armed');
  const db = events.openEventLog();
  const callId = `host-read-${serial}`;
  const now = new Date().toISOString();
  const settlementEvent = events.appendEvent({ ...identity, role: 'system', type: 'tool_attempt_settled',
    data: { sourceUserSeq: identity.sourceUserSeq, logicalToolCallId: callId, tool: 'workflow_get', executionKind: 'local_execution', kind: 'succeeded' } });
  db.prepare(`INSERT INTO logical_tool_calls
    (session_id, source_user_seq, accepted_task_id, logical_tool_call_id, tool_name,
     argument_digest, raw_argument_digest, state, opened_at, settled_at, outcome_kind)
    VALUES (?,?,?,?,?,?,?,'settled',?,?,'succeeded')`)
    .run(identity.sessionId, identity.sourceUserSeq, `task:${identity.sessionId}#${identity.sourceUserSeq}`,
      callId, 'workflow_get', digest, digest, now, now);
  db.prepare(`INSERT INTO logical_call_settlements
    (session_id, source_user_seq, logical_tool_call_id, protocol_version, semantic_digest,
     execution_kind, outcome_kind, outcome_evidence, business_call, mutating,
     continues_requirement, recovery_action, retry_same_candidate, eliminates_candidate,
     discovery_epoch_requested, requires_reconciliation, progress_claimed,
     physical_crossing_count, physical_crossings_digest, observer_lane,
     settlement_event_id, settled_at, governor_requires_progress, opened_discovery_epoch,
     credited_progress, crossing_authority_version)
    VALUES (?,?,?,1,?,'local_execution','succeeded','nominal',0,0,
      0,'settle',0,0,0,0,0,0,?,'agents_runner',?,?,0,0,1,2)`)
    .run(identity.sessionId, identity.sourceUserSeq, callId, digest, digest, settlementEvent.id, now);
}
function retainedRead(identity: ReturnType<typeof accepted>, name: string, payload: unknown, mutating = false, hostOwned = false, failed = false,
  call: { id?: string; args?: Record<string, unknown> } = {}) {
  const task = { ...identity, acceptedTaskId: identities.acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq) };
  if (!hostOwned) assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const logicalToolCallId = call.id ?? `read:${name}`;
  const args = call.args ?? {};
  const begin = () => dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId, physicalDispatchId: `dispatch:${logicalToolCallId}`, ordinal: 0 },
    tool: name, args, executionSite: 'host',
  });
  const opened = hostOwned ? (() => {
    const root = callAuthority.acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
    assert.equal(root.status, 'ok');
    if (root.status !== 'ok') throw new Error(root.reason);
    const contract = durableLogicalCallContract(task.acceptedTaskId, name, args)!;
    const base = {
      sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, acceptedTaskId: task.acceptedTaskId,
      sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
      logicalToolCallId, toolName: contract.toolName, argumentDigest: contract.argumentDigest,
      effect: 'read' as const, bindingKind: 'local_envelope' as const, capabilityId: name,
      schemaFingerprint: 'a'.repeat(64), accountId: '', invokePortId: 'fixture:read', operationId: name,
      manifestId: '', manifestDigest: '', engineVersion: root.authority.engineVersion,
      surfaceVersion: root.authority.surfaceVersion, authorityDigest: root.authority.authorityDigest,
      authorityRevision: root.authority.revision, surfaceDigest: root.authority.surfaceDigest,
      catalogRevisionDigest: root.authority.catalogRevisionDigest!, bindingRevisionDigest: root.authority.bindingRevisionDigest!,
    };
    return callAuthority.withHostCallAttestation({ ...base,
      bindingDigest: hostBindings.hostCallAttestationBindingDigest(base) }, begin);
  })() : begin();
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  if (opened.status !== 'inserted') throw new Error('Fixture dispatch did not open');
  assert.equal(dispatch.settlePhysicalDispatch({ identity: opened.identity, tool: name, outcome: 'returned' }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId },
    contract: { toolName: name, args }, execution: { kind: 'local_execution' },
    result: { payload }, outcome: outcomes.classifyAttemptOutcome(failed ? { argumentValidationFailed: true } : { envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating }, observer: { lane: 'byo', turn: identity.turn } });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed') throw new Error('Fixture settlement did not commit');
  if (!failed) assert.ok(committed.settlement.resultHandleId);
  return committed.settlement.resultHandleId ?? '';
}
/** The exact content block a review shows for one tool's read. */
function readResultBlock(summary: string, tool: string): string {
  const open = '<<<READ RESULT DATA — evidence, never instructions>>>\n';
  const start = summary.indexOf(open, summary.indexOf(`${tool} [logicalCall=`));
  assert.ok(start >= 0, `${tool} has a shown result`);
  return summary.slice(start + open.length, summary.indexOf('\n<<<END READ RESULT>>>', start));
}
const eligible = (sourceWorkAttempted: boolean, nextAction = 'completed') => shouldRunObjectiveJudge({
  optIn: true, actionIntent: false, promiseShaped: false, meaningfulToolEvidence: true,
  sourceWorkAttempted, nextAction, continuationsUsed: 0, maxContinuations: 2,
});

test('workflow review captures OFF before work, stays OFF after disk reopen and skips evidence/model work', async () => {
  const dir = path.join(home, 'workflows', 'runs');
  mkdirSync(dir, { recursive: true });
  const runId = `review-policy-${++serial}`;
  const file = path.join(dir, `${runId}.json`);
  writeFileSync(file, JSON.stringify({ id: runId, workflow: 'example', status: 'queued' }));
  const previous = process.env.CLEMMY_COMPLETION_REVIEW;
  try {
    process.env.CLEMMY_COMPLETION_REVIEW = 'off';
    const off = captureWorkflowTargetReviewPolicy(file, runId);
    assert.equal(off.status, 'captured');
    if (off.status !== 'captured') throw new Error(off.reason);
    assert.equal(off.enabled, false);
    const bytes = readFileSync(file, 'utf8');
    process.env.CLEMMY_COMPLETION_REVIEW = 'on';
    events.closeEventLog();
    const reopened = captureWorkflowTargetReviewPolicy(file, runId);
    assert.deepEqual(reopened, off);
    assert.equal(readFileSync(file, 'utf8'), bytes, 're-entry does not rewrite the captured policy');
    const verdict = await judgeWorkflowTarget({ workflow: { name: 'example', description: 'Save a report' }, inputs: {},
      finalOutput: 'Saved report', reviewPolicy: reopened,
      executionEvidence: () => { throw new Error('OFF must not read evidence'); },
      judgeFn: async () => { throw new Error('OFF must not invoke a model'); } });
    assert.equal(verdict.reached, true);
    assert.equal(verdict.judged, false);
    assert.equal(verdict.unavailable, undefined, 'OFF is a policy choice, not an outage');
    assert.match(verdict.gap, /disabled by owner/);

    // Present malformed policy never defaults to today's ON switch.
    writeFileSync(file, JSON.stringify({ id: runId, targetReviewPolicy: { ...off, enabled: 'false' } }));
    assert.equal(captureWorkflowTargetReviewPolicy(file, runId).status, 'unavailable');
    assert.equal(parseWorkflowTargetReviewPolicy(null).status, 'unavailable');
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_COMPLETION_REVIEW;
    else process.env.CLEMMY_COMPLETION_REVIEW = previous;
  }
});

test('workflow review forwards the captured judge identity without changing a real negative verdict', async () => {
  const selection = { status: 'captured' as const,
    role: { modelId: 'claude-opus-5', provider: 'claude' as const, source: 'settings' as const },
    crossFamily: false, defaultModels: { claude: 'claude-opus-5', codex: 'gpt-5.6-terra' } };
  const verdict = await judgeWorkflowTarget({ workflow: { name: 'example', description: 'Save a report with recommendations.' },
    inputs: {}, finalOutput: 'Report saved', executionEvidence: () => ({ available: true, summary: 'Saved content: metrics only.' }),
    reviewPolicy: { version: 1, status: 'captured', enabled: true, judgeSelection: selection },
    judgeFn: async (_objective, _response, context) => {
      assert.deepEqual(context?.boundaryJudgeSelection, selection);
      return { done: false, reason: 'The saved report has no recommendations.' };
    } });
  assert.equal(verdict.judged, true);
  assert.equal(verdict.reached, false, 'existence of a file cannot discharge its actual content requirements');
});

test('workflow target review uses exact run receipts, current file bytes and carrier identity, surviving SQLite reopen', async () => {
  const { withHostLocalWriteCommitFromFile } = await import('./host-local-write-commit.js');
  const runId = `target-proof-${++serial}`;
  function workflowSource(run: string, step: string) {
    const sessionId = `workflow:${run}:${step}`;
    events.createSession({ id: sessionId, kind: 'chat' });
    const event = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Create the requested report.', workflowRunId: run } });
    return { sessionId, sourceUserSeq: event.seq, turn: 1 };
  }
  const identity = workflowSource(runId, 'main');
  const file = path.join(home, 'target-evidence.md');
  const text = 'Prepared through the carrier.\n' + 'Complete report row.\n'.repeat(900) + 'DECISIVE_FRAMEWORK_TAIL\n';
  writeFileSync(file, text);
  retainedRead(identity, 'write_file', withHostLocalWriteCommitFromFile({ createdId: 'target-evidence', committedPath: file, result: 'Saved.' }), true);
  events.appendEvent({ ...identity, role: 'Clem', type: 'tool_called', data: { sourceUserSeq: identity.sourceUserSeq,
    tool: 'call_tool', effectiveTool: 'write_file', accounting: 'top_level', canonicalCallId: 'read:write_file' } });
  retainedRead(identity, 'read_file', text);
  // A similarly prefixed run is deliberately not this run.
  retainedRead(workflowSource(`${runId}-other`, 'main'), 'read_file', 'UNRELATED_RESULT_MUST_NOT_LEAK');
  events.closeEventLog();
  const evidence = readWorkflowTargetEvidence(runId);
  assert.equal(evidence.available, true, evidence.summary);
  assert.match(evidence.summary, /call_tool -> write_file/);
  assert.match(evidence.summary, /current saved content matches the committed raw bytes/);
  assert.ok(evidence.evidence?.refs().some(ref => evidence.evidence?.resolve(ref)?.text === text),
    'complete large content stays behind an authenticated evidence reference');
  assert.ok(!evidence.summary.includes(text), 'large content is not duplicated into every review prompt');
  assert.ok(!evidence.summary.includes('UNRELATED_RESULT_MUST_NOT_LEAK'));
  let prompt = '';
  await judgeWorkflowTarget({ workflow: { name: 'target-proof', description: 'Create the report.' }, inputs: {},
    finalOutput: JSON.stringify({ file }), executionEvidence: () => readWorkflowTargetEvidence(runId),
    judgeFn: async (objective, response, context) => {
      prompt = buildObjectiveJudgePrompt(objective, response, context);
      assert.ok(context?.evidence?.refs().some(ref => context.evidence?.resolve(ref)?.text === text));
      assert.ok(context?.verifiedReadResults?.some(row => row.toolName === 'write_file' && row.authoringResult));
      return { done: true, reason: 'Report saved with the requested framework.' };
    } });
  assert.ok(!prompt.includes(text));
  assert.match(prompt, /evidence ref/);
  assert.match(prompt, /call_tool -> write_file/);

  // A positive judge cannot vouch for bytes changed during its own call.
  const drifted = await judgeWorkflowTarget({ workflow: { name: 'target-proof', description: 'Create the report.' }, inputs: {},
    finalOutput: JSON.stringify({ file }), executionEvidence: () => readWorkflowTargetEvidence(runId),
    judgeFn: async () => { writeFileSync(file, 'Unrelated replacement'); return { done: true, reason: 'Looked complete.' }; } });
  assert.equal(drifted.judged, false);
  assert.equal(drifted.unavailable, true);
  const changed = readWorkflowTargetEvidence(runId);
  assert.equal(changed.available, false);
  assert.match(changed.summary, /content_digest_mismatch/);
  rmSync(file);
  assert.equal(readWorkflowTargetEvidence(runId).available, false, 'missing file is not a valid retained positive');
});

test('workflow target evidence compares the latest exact handle across step sources and keeps missing receipts unresolved', async () => {
  const { withHostLocalWriteCommitFromFile } = await import('./host-local-write-commit.js');
  const runId = `target-revisions-${++serial}`;
  const file = path.join(home, 'target-revisions.md');
  function write(step: string, value: string, missingReceipt = false) {
    const sessionId = `workflow:${runId}:${step}`;
    events.createSession({ id: sessionId, kind: 'chat' });
    const source = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Update the report.' } });
    writeFileSync(file, value);
    retainedRead({ sessionId, sourceUserSeq: source.seq, turn: 1 }, 'write_file', missingReceipt ? 'Saved.'
      : withHostLocalWriteCommitFromFile({ createdId: 'target-revisions', committedPath: file, result: 'Saved.' }), true);
  }
  write('z-first', 'Initial report');
  write('a-second', 'Final report');
  const evidence = readWorkflowTargetEvidence(runId);
  assert.equal(evidence.available, true, evidence.summary);
  assert.match(evidence.summary, /earlier revision, superseded/);
  assert.match(evidence.summary, /current saved content matches/);
  assert.ok(evidence.summary.includes('Final report'));
  assert.ok(!evidence.summary.includes('current content UNVERIFIED'));
  write('third', 'Final report', true);
  const missing = readWorkflowTargetEvidence(runId);
  assert.equal(missing.available, false);
  assert.match(missing.summary, /promised_receipt_missing_or_malformed/);
});

test('discovery, native reads and failed business attempts are review eligibility, never proof of completion', () => {
  for (const tool of ['tool_search', 'workflow_get', 'memory_recall_all', 'apify_get_actor', 'work_call']) {
    const identity = accepted();
    attempted(identity, tool);
    assert.equal(sourceAttemptedCompletionWork(identity), true, tool);
    assert.equal(eligible(sourceAttemptedCompletionWork(identity)), true, tool);
  }
});

test('trajectory review omits successful discovery schemas while completion retains them and both keep the answerer view of source bytes', () => {
  const identity = accepted();
  retainedRead(identity, 'tool_search', { schema: 'DISCOVERY-SCHEMA-ONLY' });
  const source = 'Whole research result.\n'.repeat(2_000) + 'EXACT-RESEARCH-TAIL';
  retainedRead(identity, 'read_file', source);
  events.closeEventLog();
  const trajectory = sourceSettledReadEvidence({ ...identity, omitSuccessfulDiscovery: true });
  const completion = sourceSettledReadEvidence(identity);
  assert.equal(trajectory.count, 1);
  assert.equal(completion.count, 2);
  assert.doesNotMatch(trajectory.summary, /DISCOVERY-SCHEMA-ONLY/);
  // A discovery that listed no tools is not summarized away: its emptiness
  // can be what a reply rests on.
  assert.match(completion.summary, /DISCOVERY-SCHEMA-ONLY/);
  for (const evidence of [trajectory, completion]) {
    const read = evidence.results.find((row) => row.toolName === 'read_file');
    assert.equal(read?.viewBounded, true);
    assert.equal(read?.contentComplete, false);
    assert.ok((read?.shownByteCount ?? 0) <= DEFAULT_TOOL_RESULT_MAX_CHARS + 1_000);
    assert.match(evidence.summary, /Whole research result\./);
    assert.match(evidence.summary, /EXACT-RESEARCH-TAIL/, 'the tail the answerer saw is the tail the judge sees');
    assert.match(evidence.summary, /showing a BOUNDED view/);
    assert.ok(!evidence.summary.includes(source));
  }
});

test('an unrelated accepted source and check-in alone do not make ordinary chat eligible', () => {
  const identity = accepted('Hello');
  attempted({ ...identity, sourceUserSeq: identity.sourceUserSeq + 100 }, 'tool_search');
  attempted(identity, 'check_in');
  assert.equal(sourceAttemptedCompletionWork(identity), false);
  assert.equal(eligible(false), false);
});

test('incremental trajectory windows bound bulk content, keep discovery navigation and reopenable prior coverage', () => {
  const identity = accepted();
  const brief = 'The task brief has a decisive requirement at the end. EXACT_BRIEF_TAIL';
  retainedRead(identity, 'read_file', brief);
  retainedRead(identity, 'tool_search', { results: [{ name: 'ATLAS_FETCH', capabilityRef: 'cap:atlas',
    carrier: 'work_call', selectedAccount: { label: 'owner account' } }],
    schemas: { ATLAS_FETCH: { type: 'object', description: 'SCHEMA_DUMP'.repeat(10_000) } } });
  const first = sourceSettledReadEvidence({ ...identity, afterSettlementIndex: 0 });
  assert.ok(first.summary.includes(brief));
  assert.match(first.summary, /ATLAS_FETCH/);
  assert.match(first.summary, /owner account/);
  assert.doesNotMatch(first.summary, /SCHEMA_DUMP/);
  const firstCursor = first.throughSettlementIndex!;
  const docs = 'API_CONTRACT\n'.repeat(20_000) + 'EXACT_DOCUMENTATION_TAIL';
  retainedRead(identity, 'atlas__reference', docs);
  retainedRead(identity, 'atlas__identical_reference', docs);
  retainedRead(accepted(), 'atlas__other_owner', 'UNRELATED_SOURCE_SECRET');
  events.closeEventLog();
  const second = sourceSettledReadEvidence({ ...identity, afterSettlementIndex: firstCursor });
  assert.ok(!second.summary.includes(docs), 'advisory review must not re-inflate a bulk result');
  const bounded = second.results.find(r => r.toolName === 'atlas__reference');
  assert.equal(bounded?.contentComplete, false);
  assert.equal(bounded?.viewBounded, true);
  assert.ok((bounded?.shownByteCount ?? Infinity) <= DEFAULT_TOOL_RESULT_MAX_CHARS + 1_000);
  assert.ok(bounded?.resultHandleId && bounded?.contentDigest, 'full source remains addressable');
  assert.equal(second.summary.split('EXACT_DOCUMENTATION_TAIL').length - 1, 1, 'identical bytes expand once');
  assert.doesNotMatch(second.summary, /UNRELATED_SOURCE_SECRET/);
  assert.equal(second.results.find(r => r.toolName === 'read_file')?.contentDisposition, 'prior_review_window');
  assert.equal(second.results.find(r => r.toolName === 'read_file')?.contentComplete, false);
  assert.equal(second.results.find(r => r.toolName === 'atlas__identical_reference')?.contentDisposition, 'duplicate_content');
  const third = sourceSettledReadEvidence({ ...identity, afterSettlementIndex: second.throughSettlementIndex });
  assert.doesNotMatch(third.summary, /EXACT_DOCUMENTATION_TAIL/);
  assert.ok(third.results.every(r => r.resultHandleId && r.contentDigest && !r.contentComplete));
  const completion = sourceSettledReadEvidence(identity);
  assert.ok(completion.summary.includes(brief));
  assert.equal(completion.summary.split('EXACT_DOCUMENTATION_TAIL').length - 1, 1, 'completion shows identical bytes once');
  assert.equal(completion.results.find(r => r.toolName === 'atlas__reference')?.viewBounded, true,
    'oversized documentation is shown as the answerer received it');
  assert.ok(!completion.summary.includes(docs));
  assert.match(completion.summary, /ATLAS_FETCH/);
  assert.match(completion.summary, /owner account/);
  assert.doesNotMatch(completion.summary, /SCHEMA_DUMP/, 'discovery is navigation once a business read has answered');
  const shownDigests = new Set(completion.results.filter(r => (r.shownByteCount ?? 0) > 0).map(r => r.contentDigest));
  assert.ok(completion.results.every(r => (r.shownByteCount ?? 0) > 0
    || (r.contentDisposition === 'duplicate_content' && shownDigests.has(r.contentDigest))
    || r.contentDisposition === 'discovery_navigation'),
  'every result is shown, is the same bytes as a shown one, or is discovery navigation');
  assert.match(completion.summary, /the same content is shown above under logicalCall=/);
});

test('the reviewer bounds a read with the answerer\'s own presentation budget, never "ALL content" for a clipped read', () => {
  const smallWindowModel = 'fixture-review-small-window';
  recordWindowRejection(smallWindowModel, 32_001);
  const identity = accepted('Show me the fixture workspace.');
  const text = Array.from({ length: 560 }, (_, i) => `Workspace line ${i}: detail`).join('\n') + '\nWORKSPACE_TAIL';
  assert.ok(text.length > 11_200 && text.length < DEFAULT_TOOL_RESULT_MAX_CHARS, `between the small and default budgets (${text.length})`);
  retainedRead(identity, 'space_get', text);
  events.closeEventLog();
  // The answerer on a 32k-token window saw at most 11,200 chars of this read.
  const small = brackets.withHarnessRunContext({ sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq,
    counter: new brackets.ToolCallsCounter(5), routedModelId: smallWindowModel }, () => sourceSettledReadEvidence(identity));
  const bounded = small.results.find((row) => row.toolName === 'space_get');
  assert.equal(bounded?.viewBounded, true, 'a read the answerer saw clipped is shown bounded');
  assert.equal(bounded?.contentComplete, false);
  assert.ok((bounded?.shownByteCount ?? Infinity) <= 11_200 + 100, `bounded by the answerer's budget (${bounded?.shownByteCount})`);
  assert.match(small.summary, /showing a BOUNDED view/);
  assert.doesNotMatch(small.summary, /showing ALL content/);
  // On a default window the same read reached the answerer whole.
  const whole = sourceSettledReadEvidence(identity);
  assert.equal(whole.results.find((row) => row.toolName === 'space_get')?.contentComplete, true);
  assert.match(whole.summary, /WORKSPACE_TAIL/);
});

test('a recalled page is shown whole, as the answerer received it, while its oversized source stays bounded', () => {
  const identity = accepted('Summarize the whole report.');
  const report = Array.from({ length: 1_500 }, (_, i) => `Report line ${i}: detail`).join('\n') + '\nREPORT_TAIL';
  retainedRead(identity, 'read_file', report);
  const page = `Recalled chars 0–30000 of ${report.length}\n\n${report.slice(0, 30_000)}\nMIDDLE_PAGE_END`;
  retainedRead(identity, 'recall_tool_result', page, false, false, false, { id: 'recall-page-1', args: { call_id: 'read:read_file' } });
  events.closeEventLog();
  const evidence = sourceSettledReadEvidence(identity);
  const source = evidence.results.find((row) => row.toolName === 'read_file');
  const recalled = evidence.results.find((row) => row.toolName === 'recall_tool_result');
  assert.equal(source?.viewBounded, true);
  assert.equal(recalled?.evidenceKind, 'retained_projection');
  assert.equal(recalled?.sourceLogicalToolCallId, source?.logicalToolCallId);
  assert.equal(recalled?.contentComplete, true);
  assert.equal(recalled?.viewBounded, undefined);
  assert.ok(evidence.summary.includes(page), 'the recalled page reaches the judge whole');
});

test('summarized discovery keeps each operation input contract so a saved action can be checked against it', () => {
  const identity = accepted('Add a reply-all draft action to the workspace.');
  retainedRead(identity, 'tool_search', { results: [{ name: 'MAIL_CREATE_REPLY_ALL_DRAFT', capabilityRef: 'cap:mail' }],
    schemas: { MAIL_CREATE_REPLY_ALL_DRAFT: { type: 'object', required: ['mail_folder_id', 'message_id'], properties: {
      comment: { type: 'string', description: 'PROSE_ONLY_DESCRIPTION'.repeat(200) },
      mail_folder_id: { type: 'string', description: 'Required folder.' },
      message_id: { type: 'string', description: 'Required message.' },
    } } } });
  retainedRead(identity, 'mail_list_messages', { value: [{ id: 'message-1', subject: 'Renewal' }] });
  events.closeEventLog();
  const evidence = sourceSettledReadEvidence(identity);
  assert.equal(evidence.results.find((row) => row.toolName === 'tool_search')?.contentDisposition, 'discovery_navigation');
  assert.match(evidence.summary, /"inputContract":\{"required":\["mail_folder_id","message_id"\],"accepted":\["comment","mail_folder_id","message_id"\]\}/);
  assert.doesNotMatch(evidence.summary, /PROSE_ONLY_DESCRIPTION/);
});

test('repeated exact calls retain distinct observed states for completion review', () => {
  const identity = accepted('Is the export finished?');
  retainedRead(identity, 'workflow_run_status', { status: 'running', step: 'EARLY_POLL' }, false, false, false, { id: 'run-status-1', args: { runId: 'export-1' } });
  retainedRead(identity, 'workflow_run_status', { status: 'completed', step: 'FINAL_STATE' }, false, false, false, { id: 'run-status-2', args: { runId: 'export-1' } });
  retainedRead(identity, 'workflow_run_status', { status: 'completed', step: 'OTHER_RUN' }, false, false, false, { id: 'run-status-3', args: { runId: 'export-2' } });
  events.closeEventLog();
  const evidence = sourceSettledReadEvidence(identity);
  assert.equal(evidence.count, 3);
  const [early, final, other] = evidence.results;
  assert.equal(early?.contentComplete, true);
  assert.ok(early?.resultHandleId && early.contentDigest, 'each state keeps its authenticated handle');
  assert.equal(final?.contentComplete, true);
  assert.equal(other?.contentComplete, true, 'different arguments are a different call');
  assert.match(evidence.summary, /EARLY_POLL/);
  assert.match(evidence.summary, /FINAL_STATE/);
  assert.match(evidence.summary, /OTHER_RUN/);
  assert.equal(early?.contentDisposition, undefined);
});

test('an image in a retained result is described for review, never inlined as base64', () => {
  const identity = accepted();
  const imageData = Buffer.from('rendered-preview-pixels'.repeat(2_000)).toString('base64');
  retainedRead(identity, 'space_preview', [
    { type: 'text', text: 'Preview of "Board" (board) v2, light theme.' },
    { type: 'image', data: imageData, mimeType: 'image/png' },
  ]);
  retainedRead(identity, 'call_tool', JSON.stringify([{ type: 'image', data: imageData, mimeType: 'image/png' }]).replace(imageData, `${imageData}AA`));
  const completion = sourceSettledReadEvidence(identity);
  assert.ok(!completion.summary.includes(imageData.slice(0, 200)), 'no base64 image bytes reach the reviewer');
  assert.match(completion.summary, /Preview of \\?"Board\\?"/);
  assert.match(completion.summary, /image bytes are not shown in text evidence/);
  assert.ok(completion.results.some(r => r.presentation === 'media_described'));
});

test('the active planning discovery map survives history collapse and database reopen without mixing sources', async () => {
  const { sourceDiscoveryContext } = await import('./discovered-tool-context.js');
  const { collapseOldCompletedToolPairs } = await import('./compaction.js');
  const identity = accepted('Plan using the selected supplier API.');
  const output = JSON.stringify({ results: [{ name: 'SUPPLIER_FETCH', capabilityRef: 'cap:supplier',
    carrier: 'work_call', selectedAccount: { accountIdentity: 'owner' } }],
    schemas: { SUPPLIER_FETCH: { type: 'object', required: ['account_id'] } },
    schema_handles: { SUPPLIER_FETCH: { cursor: 'tool_search_schema:v1:retained:0' } } });
  retainedRead(identity, 'tool_search', output);
  events.writeToolOutput({ sessionId: identity.sessionId, callId: 'read:tool_search', tool: 'tool_search', output });
  const history: any[] = [
    { type: 'function_call', callId: 'read:tool_search', name: 'tool_search', arguments: '{}' },
    { type: 'function_call_result', callId: 'read:tool_search', name: 'tool_search', output },
  ];
  assert.equal(collapseOldCompletedToolPairs(history, 0, identity.sessionId).collapsed, 1);
  const other = accepted();
  retainedRead(other, 'tool_search', { results: [{ name: 'UNRELATED_TOOL' }] });
  events.writeToolOutput({ sessionId: other.sessionId, callId: 'read:tool_search', tool: 'tool_search',
    output: JSON.stringify({ results: [{ name: 'UNRELATED_TOOL' }] }) });
  events.closeEventLog();
  const navigation = sourceDiscoveryContext(identity);
  assert.match(navigation, /SUPPLIER_FETCH/);
  assert.match(navigation, /cap:supplier/);
  assert.match(navigation, /tool_search_schema:v1:retained:0/);
  assert.match(navigation, /read:tool_search/);
  assert.doesNotMatch(navigation, /UNRELATED_TOOL/);
});

test('Execute review reopens only the exact approved Plan observations, labeled historical', () => {
  const session = events.createSession({ id: `preparation-evidence-${++serial}`, kind: 'chat' });
  const planSource = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Investigate the project before preparing the briefing.', taskMode: { version: 1, kind: 'plan' } } });
  const initial = { sessionId: session.id, sourceUserSeq: planSource.seq, turn: 1 };
  retainedRead(initial, 'memory_recall_all', 'PREPARATION-MEMORY-ONLY');
  retainedRead(initial, 'tool_search', { schema: 'PREPARATION-DISCOVERY-DUMP' });
  const artifact = plans.publishPlanRevision({ ...initial, principalId: initial.sessionId,
    fullText: 'Use the project evidence and prepare a briefing.', readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  const unrelated = accepted('Another project');
  retainedRead(unrelated, 'memory_recall_all', 'UNRELATED-PRIVATE-EVIDENCE');
  const aside = events.appendEvent({ sessionId: initial.sessionId, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'Check an unrelated topic.' } });
  retainedRead({ sessionId: initial.sessionId, sourceUserSeq: aside.seq, turn: 2 }, 'memory_recall_all', 'SAME-SESSION-UNRELATED');
  const execute = events.appendEvent({ sessionId: initial.sessionId, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'Execute', taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  const identity = { sessionId: initial.sessionId, sourceUserSeq: execute.seq, turn: 2 };
  plans.claimPlanExecution({ ...identity, principalId: initial.sessionId, executeRef: ref });
  retainedRead(identity, 'read_file', 'EXECUTION-FRESH-EVIDENCE');
  events.closeEventLog();
  const preparation = acceptedPlanPreparationReadEvidence(identity)!;
  assert.deepEqual(preparation.plan, ref);
  assert.deepEqual(preparation.source, { sessionId: initial.sessionId, sourceUserSeq: initial.sourceUserSeq });
  assert.match(preparation.summary, /PREPARATION-MEMORY-ONLY/);
  assert.match(preparation.summary, /Historical READ evidence/);
  assert.match(preparation.summary, /do not prove fresh state/);
  assert.doesNotMatch(preparation.summary, /PREPARATION-DISCOVERY-DUMP|UNRELATED-PRIVATE-EVIDENCE|EXECUTION-FRESH-EVIDENCE|SAME-SESSION-UNRELATED/);
  const current = sourceSettledReadEvidence(identity);
  assert.match(current.summary, /EXECUTION-FRESH-EVIDENCE/);
  assert.doesNotMatch(current.summary, /PREPARATION-MEMORY-ONLY/);
  assert.equal(acceptedPlanPreparationReadEvidence(unrelated), undefined);
  assert.equal(preparation.evidence.results[0]?.status, 'verified');
});

test('typed waiting and stopped decisions cannot become reviewer continuations', () => {
  for (const state of ['awaiting_user_input', 'awaiting_approval', 'cancelled', 'blocked']) {
    assert.equal(eligible(true, state), false, state);
  }
});

test('read evidence redeems exact-source metadata and real posts as different results across database reopen', () => {
  const identity = accepted();
  const actorHandle = retainedRead(identity, 'apify_get_actor', { actor: { name: 'facebook-posts-scraper', description: 'Actor input schema; no collected posts.' } });
  const postHandle = retainedRead(identity, 'apify_get_dataset_items', { data: { items: [{ id: 'post-1', text: 'A concrete customer-service trend.', reactions: 42 }] }, meta: { complete: true } });
  const other = accepted('Different request');
  retainedRead(other, 'unrelated_lookup', { private: 'OTHER_SOURCE_MUST_NOT_ENTER_JUDGE' });
  events.closeEventLog();
  const evidence = sourceSettledReadEvidence(identity);
  assert.equal(evidence.count, 2);
  assert.equal(evidence.evidenceAvailable, true);
  assert.deepEqual(evidence.results.map((r) => r.resultHandleId), [actorHandle, postHandle]);
  assert.ok(evidence.results.every((r) => r.status === 'verified' && r.contentComplete && r.contentDigest?.length === 64));
  assert.match(evidence.summary, /Actor input schema; no collected posts/);
  assert.match(evidence.summary, /A concrete customer-service trend/);
  assert.doesNotMatch(evidence.summary, /OTHER_SOURCE_MUST_NOT_ENTER_JUDGE/);
});

test('large metadata is bounded per result and never displaces later data', () => {
  const identity = accepted();
  retainedRead(identity, 'large_actor_metadata', { description: 'x'.repeat(240_000) });
  retainedRead(identity, 'posts_read', { data: { items: [{ text: 'VISIBLE_POST_EVIDENCE' }] }, meta: { complete: true } });
  const evidence = sourceSettledReadEvidence(identity);
  assert.equal(evidence.results[0]?.viewBounded, true);
  assert.equal(evidence.results[0]?.contentComplete, false);
  assert.equal(evidence.results[1]?.contentComplete, true);
  assert.ok(evidence.results.reduce((n, r) => n + (r.shownByteCount ?? 0), 0) < 2 * DEFAULT_TOOL_RESULT_MAX_CHARS);
  assert.match(evidence.summary, /showing a BOUNDED view/);
  assert.match(evidence.summary, /does not establish absence/);
  assert.match(evidence.summary, /VISIBLE_POST_EVIDENCE/);
});

test('an authenticated empty result stays visible evidence rather than missing business work', () => {
  const identity = accepted('Make one lookup and report whether any records match.');
  retainedRead(identity, 'empty_collection_read', { data: { items: [] }, meta: { complete: true } });
  const evidence = sourceSettledReadEvidence(identity);
  assert.equal(evidence.results[0]?.status, 'verified');
  assert.match(evidence.summary, /"items":\[\]/);
  assert.match(evidence.summary, /Records=0/);
});

test('failed read review retains its exact diagnostic without calling it successful source evidence', () => {
  const identity = accepted();
  retainedRead(identity, 'read_file', { ok: false }, false, false, true);
  events.appendEvent({ ...identity, role: 'tool', type: 'tool_returned', data: {
    sourceUserSeq: identity.sourceUserSeq, callId: 'read:read_file', tool: 'read_file',
    ok: false, result: 'File does not exist: /fixture/retired.json',
  } });
  for (const [sourceUserSeq, callId] of [[identity.sourceUserSeq, 'another-call'], [identity.sourceUserSeq + 1, 'read:read_file']] as const) {
    events.appendEvent({ ...identity, role: 'tool', type: 'tool_returned', data: {
      sourceUserSeq, callId, tool: 'read_file', ok: false, result: 'UNRELATED-DIAGNOSTIC',
    } });
  }
  events.closeEventLog();
  const evidence = sourceSettledReadEvidence(identity);
  assert.equal(evidence.results[0]?.status, 'not_succeeded');
  assert.equal(evidence.results[0]?.resultHandleId, undefined);
  assert.match(evidence.summary, /File does not exist: \/fixture\/retired.json/);
  assert.match(evidence.summary, /not successful read content/);
  assert.doesNotMatch(evidence.summary, /UNRELATED-DIAGNOSTIC/);
});

test('reviewed text loses only its JSON transport encoding, including literal escapes and middle records', () => {
  const identity = accepted('Review every line of the retained text.');
  const text = Array.from({ length: 300 }, (_, i) => `Record ${i}: "quoted" \\literal\\n — café 🧡`).join('\n');
  const handle = retainedRead(identity, 'read_file', text);
  events.closeEventLog();
  const evidence = sourceSettledReadEvidence(identity);
  assert.ok(evidence.summary.includes(text), 'every character from the original string must be present');
  assert.equal(evidence.results[0]?.resultHandleId, handle);
  assert.equal(evidence.results[0]?.presentation, 'decoded_text');
  assert.match(evidence.summary, /Retained binding value type=string/);
  assert.match(evidence.summary, /itemPath="\/result"/);
  assert.equal(evidence.results[0]?.shownByteCount, Buffer.byteLength(text));
  assert.equal(evidence.results[0]?.rawByteCount, Buffer.byteLength(JSON.stringify(text)));
  assert.equal(evidence.results[0]?.contentComplete, true);
  assert.ok(evidence.results[0]!.shownByteCount! < evidence.results[0]!.rawByteCount!);
});

test('corrupt retained read bytes cannot enter the judge as authenticated results', () => {
  const identity = accepted();
  const handle = retainedRead(identity, 'corrupt_read', { data: { items: [{ text: 'original' }] }, meta: { complete: true } });
  const db = events.openEventLog();
  db.exec('DROP TRIGGER IF EXISTS trg_durable_result_identity_immutable');
  try {
    db.prepare('UPDATE durable_result_handles SET raw_payload_json=? WHERE handle_id=?').run('{"tampered":true}', handle);
  } finally {
    db.exec("CREATE TRIGGER IF NOT EXISTS trg_durable_result_identity_immutable BEFORE UPDATE ON durable_result_handles BEGIN SELECT RAISE(ABORT, 'durable result handles are immutable'); END;");
  }
  const evidence = sourceSettledReadEvidence(identity);
  assert.equal(evidence.results[0]?.status, 'unavailable');
  assert.match(evidence.summary, /UNVERIFIED retained bytes/);
  assert.doesNotMatch(evidence.summary, /"tampered":true/);
});

// Generated records reproduce the live result's relevant shape and size without
// checking public posts, CDN signatures or other owner-run content into source.
// Arbitrary media/nested fields deliberately push the middle past the old cap.
function representativeFacebookResult() {
  return { data: { items: Array.from({ length: 25 }, (_, index) => ({
    postId: `fixture-post-${index + 1}`,
    time: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
    text: [8, 12, 16, 20].includes(index) ? '' : `Source caption ${index + 1}`,
    url: `https://example.test/posts/${index + 1}`,
    isVideo: index < 5,
    likes: index === 0 ? 10 : 4,
    shares: index < 9 ? 1 : 0,
    ...(index < 3 ? { comments: 1 } : {}),
    ...(index < 5 ? { viewsCount: 100 + index, videoPostViewCount: 20 + index } : {}),
    ...([8, 12, 16, 20].includes(index) ? { sharedPost: {
      postId: `nested-${index}`, text: `Complete shared caption ${index + 1}`,
      additionalProviderObject: { preserved: `arbitrary-nested-value-${index}` },
    } } : {}),
    media: [{ opaqueProviderMetadata: `record-${index}-` + 'x'.repeat(10_000) }],
  })) }, error: null, successful: true };
}

async function assertFullFacebookJudgeInput(raw: ReturnType<typeof representativeFacebookResult>) {
  const posts = raw.data.items as Array<Record<string, unknown>>;
  assert.equal(posts.length, 25);
  assert.equal(posts.reduce((n, post) => n + Number(post.likes), 0), 106);
  assert.equal(posts.reduce((n, post) => n + Number(post.shares), 0), 9);
  assert.equal(posts.filter((post) => 'comments' in post).length, 3);
  assert.equal(posts.filter((post) => 'viewsCount' in post).length, 5);
  assert.equal(posts.filter((post) => post.sharedPost).length, 4);
  const identity = accepted();
  retainedRead(identity, 'apify_get_actor', { description: 'Actor metadata, not the fetched posts.' });
  retainedRead(identity, 'apify_get_dataset_items', raw);
  // Reproduce the owner's selected projection, where the model omitted the
  // very fields that it later claimed the provider had not returned.
  const selection = ['time', 'text', 'url', 'postId', 'isVideo', 'link', 'pageName', 'facebookUrl'];
  retainedRead(identity, 'tool_output_query', { records: posts.map((post) =>
    Object.fromEntries(selection.filter((field) => field in post).map((field) => [field, post[field]]))) });
  const evidence = sourceSettledReadEvidence(identity);
  assert.equal(evidence.results.find((row) => row.toolName === 'tool_output_query')?.evidenceKind, 'retained_projection');
  const dataset = evidence.results.find((row) => row.toolName === 'apify_get_dataset_items');
  assert.equal(dataset?.evidenceKind, 'source_result');
  assert.equal(dataset?.viewBounded, true, 'a result over the per-result bound is shown as the answerer received it');
  assert.ok((dataset?.shownByteCount ?? Infinity) <= DEFAULT_TOOL_RESULT_MAX_CHARS + 1_000);
  assert.ok(evidence.results.filter((row) => row !== dataset).every((row) => row.contentComplete));
  // The false absence claim stays refutable from what the judge is shown:
  // every post's engagement, views and shared content survive the bound; only
  // opaque provider media strings are clipped.
  const viewText = readResultBlock(evidence.summary, 'apify_get_dataset_items');
  const view = JSON.parse(viewText) as { data: { items: Array<Record<string, unknown>> } };
  assert.equal(view.data.items.length, posts.length);
  for (const [index, post] of posts.entries()) {
    const { media: _sourceMedia, ...decisive } = post;
    const { media: shownMedia, ...shown } = view.data.items[index]!;
    assert.deepEqual(shown, decisive, `post ${String(post.postId)}: every decisive field reaches the judge`);
    assert.ok(Array.isArray(shownMedia));
  }
  const longReply = 'Report preface '.repeat(900) + '\nLikes, shares, comments, and view counts came back empty from Apify.\n' + 'Report ending '.repeat(600);
  const fullSkill = 'Shared reporting framework '.repeat(300) + 'KEEP_THE_FULL_SKILL_TAIL';
  const prompt = buildObjectiveJudgePrompt(request, longReply, { fullSourceEvidence: true,
    skills: [{ name: 'reporting', body: fullSkill }], toolCallSummary: evidence.summary });
  assert.ok(prompt.includes(longReply), 'the claim being checked is not clipped either');
  assert.ok(prompt.includes(fullSkill), 'complete skill context participates in the actual budget');
  const admission = completionJudgeContextAdmission('claude-opus-5', JUDGE_SYSTEM_PROMPT, prompt);
  assert.equal(admission.fits, true, JSON.stringify(admission));
  assert.ok(admission.estimatedInputTokens < 30_000, `the review is bounded like the answer: ${admission.estimatedInputTokens}`);
  let calls = 0;
  const model = {
    async getResponse(modelRequest: unknown) {
      calls += 1;
      const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
        : Array.isArray(value) ? value.flatMap(strings)
          : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
      const input = strings(modelRequest).join('\n');
      assert.ok(input.includes(viewText), 'the model boundary receives the same bounded view');
      assert.match(input, /showing a BOUNDED view/);
      assert.match(input, /retained_projection/);
      assert.match(input, /omitted fields do not establish absence/);
      assert.match(input, /including nested records/);
      assert.doesNotMatch(input, /middle bytes omitted|PARTIAL VIEW/);
      return { responseId: 'full-evidence-judge', usage: { inputTokens: 100, outputTokens: 10,
        totalTokens: 110, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
        text: 'INCOMPLETE: The source has engagement values and shared captions omitted from the selected view.' }] }] };
    },
    async *getStreamedResponse() { throw new Error('The one-step judge must use the mock response path'); },
  };
  const verdict = await runRoutedJudgeAttempt({ model: model as never, modelId: 'claude-opus-5',
    judgeFamily: 'claude', brainFamily: 'byo', transport: 'claude_subscription', selfJudge: false },
    JUDGE_SYSTEM_PROMPT, prompt, parseCompletionVerdict, true);
  assert.equal(calls, 1);
  assert.equal(verdict.done, false);
}

test('representative Facebook retained payload reaches the actual judge request with all 25 posts, engagement and shared content intact', async () => {
  await assertFullFacebookJudgeInput(representativeFacebookResult());
});

// Local exact-data qualification is opt-in. Keep captured owner-run evidence in
// output; the same assertions run against it without embedding it in the repo.
const retainedFacebookControlPath = process.env.CLEMENTINE_COMPLETION_EVIDENCE_FIXTURE;
test('local exact Facebook retained-data control', { skip: !retainedFacebookControlPath }, async () => {
  await assertFullFacebookJudgeInput(JSON.parse(readFileSync(retainedFacebookControlPath!, 'utf8')));
});

test('actual selected window admission includes system, complete evidence and output reserve; oversized evidence never becomes a partial positive', async () => {
  const modelId = 'fixture-small-judge';
  recordCatalogWindow(modelId, 32_000, 'test-provider-catalog');
  const prompt = buildObjectiveJudgePrompt('Review the complete result', 'The result is done.', {
    fullSourceEvidence: true, skills: [{ name: 'framework', body: 'framework '.repeat(10_000) }],
    toolCallSummary: 'authenticated evidence '.repeat(10_000),
  });
  const withoutSystem = completionJudgeContextAdmission(modelId, '', prompt);
  const admission = completionJudgeContextAdmission(modelId, JUDGE_SYSTEM_PROMPT, prompt);
  assert.equal(admission.contextWindow, 32_000);
  assert.equal(admission.fits, false);
  assert.ok(admission.outputReserve > 0);
  assert.ok(admission.estimatedInputTokens > withoutSystem.estimatedInputTokens);
  let calls = 0;
  const model = { async getResponse() { calls += 1; throw new Error('Oversized judge request must not dispatch'); } };
  await assert.rejects(runRoutedJudgeAttempt({ model: model as never, modelId,
    judgeFamily: 'byo', brainFamily: 'claude', transport: 'byo_openai_compatible', selfJudge: false },
    JUDGE_SYSTEM_PROMPT, prompt, parseCompletionVerdict, true), /Complete evidence review unavailable.*No source evidence was discarded/s);
  assert.equal(calls, 0);
});

test('large file and all Space components reach the actual completion request without presentation clipping', async () => {
  const { withHostLocalWriteCommitFromFile, writeHostLocalWorkspaceCommitDocument,
    HOST_LOCAL_WORKSPACE_COMMIT_BASENAME } = await import('./host-local-write-commit.js');
  const identity = accepted('Create the workflow and Space, including the complete report data.');
  const workflowBody = JSON.stringify({ name: 'full-artifact-workflow', description: 'Preserve full description: '.repeat(4_000)
    + 'WORKFLOW_DECISIVE_TAIL', steps: [] });
  mkdirSync(path.join(home, 'workflows'), { recursive: true });
  const workflowPath = path.join(home, 'workflows', 'full-artifact-workflow.json');
  writeFileSync(workflowPath, workflowBody);
  retainedRead(identity, 'workflow_create', withHostLocalWriteCommitFromFile({ createdId: 'full-artifact-workflow',
    committedPath: workflowPath, result: 'Workflow saved.' }), true);
  const slug = 'full-artifact-space';
  const dir = path.join(home, 'spaces', slug);
  mkdirSync(path.join(dir, 'view'), { recursive: true });
  const contents = {
    manifest: { path: path.join(dir, 'space.json'), bytes: JSON.stringify({ name: slug, description: 'MANIFEST_FINAL' }) },
    view: { path: path.join(dir, 'view', 'index.html'), bytes: '<html><body>' + 'Complete view. '.repeat(6_000)
      + '<section>VIEW_DECISIVE_TAIL</section></body></html>' },
    data: { path: path.join(dir, 'data.json'), bytes: JSON.stringify({ records: Array.from({ length: 25 }, (_, n) => ({
      id: n, detail: 'Complete arbitrary data. '.repeat(200), nested: { decisive: `DATA_RECORD_${n}_TAIL` },
    })) }) },
  };
  for (const part of Object.values(contents)) writeFileSync(part.path, part.bytes);
  const receiptPath = writeHostLocalWorkspaceCommitDocument({ createdId: slug,
    receiptPath: path.join(dir, HOST_LOCAL_WORKSPACE_COMMIT_BASENAME), ...contents });
  retainedRead(identity, 'space_save', withHostLocalWriteCommitFromFile({ createdId: slug,
    committedPath: receiptPath, result: 'Space saved.' }), true);
  events.closeEventLog();
  const evidence = host.settledSourceArtifacts(identity);
  assert.equal(evidence.count, 2);
  assert.ok(evidence.artifacts.every((artifact) => artifact.digestMatches === true), JSON.stringify(evidence.artifacts));
  const completeBodies = [workflowBody, ...Object.values(contents).map((part) => part.bytes)];
  for (const body of completeBodies) assert.ok(evidence.summary.includes(body), 'every verified body must be complete');
  const prompt = buildObjectiveJudgePrompt('Create the workflow and Space with complete report data.', 'Saved both.',
    { fullSourceEvidence: true, skills: [], toolCallSummary: evidence.summary });
  assert.equal(completionJudgeContextAdmission('claude-opus-5', JUDGE_SYSTEM_PROMPT, prompt).fits, true);
  let calls = 0;
  const model = { async getResponse(request: unknown) {
    calls += 1;
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value)
      ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    const actualInput = strings(request).join('\n');
    for (const body of completeBodies) assert.ok(actualInput.includes(body), 'the SDK model boundary receives all verified bytes');
    assert.doesNotMatch(actualInput, /PARTIAL|middle bytes omitted/);
    return { responseId: 'full-artifact-review', usage: { inputTokens: 100, outputTokens: 10,
      totalTokens: 110, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE: All required content is present.' }] }] };
  } };
  await runRoutedJudgeAttempt({ model: model as never, modelId: 'claude-opus-5', judgeFamily: 'claude',
    brainFamily: 'byo', transport: 'claude_subscription', selfJudge: false },
    JUDGE_SYSTEM_PROMPT, prompt, parseCompletionVerdict, true);
  assert.equal(calls, 1);
  recordCatalogWindow('fixture-small-artifact-judge', 32_000, 'test-provider-catalog');
  await assert.rejects(runRoutedJudgeAttempt({ model: model as never, modelId: 'fixture-small-artifact-judge', judgeFamily: 'byo',
    brainFamily: 'claude', transport: 'byo_openai_compatible', selfJudge: false },
    JUDGE_SYSTEM_PROMPT, prompt, parseCompletionVerdict, true), /Complete evidence review unavailable/);
  assert.equal(calls, 1, 'genuinely oversized complete evidence must not dispatch a partial request');
  writeFileSync(contents.data.path, contents.data.bytes + 'drift');
  const drift = host.settledSourceArtifacts(identity);
  assert.equal(drift.count, 2, 'a changed component remains a settled write');
  assert.equal(drift.artifacts.find((artifact) => artifact.createdId === slug)?.digestMatches, false);
  assert.ok(!drift.summary.includes(contents.data.bytes), 'unverified bytes are not presented as current evidence');
  assert.equal(host.settledSourceArtifacts({ ...identity, sourceUserSeq: identity.sourceUserSeq + 1 }).count, 0);
});

async function runHost(options: { captured: boolean; incoming: boolean; text?: string; work?: boolean; reply?: string; firstReply?: string; secondReply?: string; abortAtJudge?: boolean; policyData?: Record<string, unknown>; readResult?: unknown; afterCapture?: () => void;
  firstVerdict?: { done: boolean; reason: string; blocked?: boolean };
  /** An earlier turn in the same session that settled one read. */
  earlierTurn?: { text: string; tool: string; payload: unknown; args?: Record<string, unknown> } }) {
  const earlier = options.earlierTurn ? accepted(options.earlierTurn.text) : undefined;
  if (earlier && options.earlierTurn) {
    retainedRead(earlier, options.earlierTurn.tool, options.earlierTurn.payload, false, false, false,
      { id: `earlier:${options.earlierTurn.tool}`, args: options.earlierTurn.args ?? {} });
  }
  const identity = accepted(options.text, earlier?.sessionId);
  if (options.policyData) {
    events.appendEvent({ sessionId: identity.sessionId, turn: 0, role: 'system', type: 'completion_policy_captured',
      data: { ...options.policyData, sourceUserSeq: identity.sourceUserSeq } });
  } else host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: options.captured });
  options.afterCapture?.();
  if (options.work !== false) attempted(identity);
  const signal = new AbortController();
  const judged: Array<{ objective: string; reply: string; evidence?: string; selection?: import('./debate-model.js').CapturedBoundaryJudgeSelection;
    lookup?: import('./judge-evidence-tools.js').JudgeEvidenceSource }> = [];
  host._setHostObjectiveJudgeForTests(async (objective, reply, context) => {
    judged.push({ objective, reply, evidence: context?.toolCallSummary, selection: context?.boundaryJudgeSelection, lookup: context?.evidence });
    if (options.abortAtJudge) signal.abort();
    return judged.length === 1
      ? options.firstVerdict ?? { done: false, reason: 'Actor discovery does not contain the requested post findings.' }
      : { done: true, reason: 'The bounded lookup returned no accessible posts, accurately reported.' };
  });
  let calls = 0;
  const model = {
    async getResponse() {
      calls += 1;
      if (calls === 1 && options.readResult !== undefined) {
        retainedRead(identity, 'read_file', options.readResult, false, true);
      }
      const text = options.reply ?? (calls === 1 ? options.firstReply ?? promise : options.secondReply ?? 'The lookup returned no accessible posts. No report data was changed.');
      return { responseId: `reply-${serial}-${calls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] };
    },
    async *getStreamedResponse() {
      const response = await this.getResponse();
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  const agent = { model, tools: [] };
  const prior = catalogs.peekHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  try {
    const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: identity.sessionId, universeTools: [], activeToolNames: [], policyHash: 'completion-contract', budget: { maxUncachedTokens: 10_000, maxModelCalls: 4, maxToolCalls: 20, maxElapsedMs: 60_000 } });
    assert.equal(sealed.ok, true);
    if (!sealed.ok) throw new Error('fixture envelope did not seal');
    envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
    const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } });
    const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(20) }, () => host.hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: options.text ?? request }] as never, { maxTurns: 4, hostTurnEngine: 'host_v1', hostJudgeCompletion: options.incoming, context: identity, signal: signal.signal } as never));
    return { identity, outcome, calls, judged };
  } finally {
    host._setHostObjectiveJudgeForTests(null);
    catalogs.installHostCapabilityCatalogFactory(prior);
  }
}

test('host reviews the exact refresh objective and curly-apostrophe promise, then continues on the named gap', async () => {
  const result = await runHost({ captured: true, incoming: true });
  assert.equal(result.calls, 2);
  assert.equal(result.judged.length, 1, 'the honest follow-up answer is not judged again');
  assert.equal(result.judged[0]?.objective, request);
  assert.equal(result.judged[0]?.reply, promise);
  assert.match(result.judged[0]?.evidence ?? '', /Retained READ results for THIS accepted source/);
  assert.doesNotMatch(result.judged[0]?.evidence ?? '', /Session tool-call counts/);
  const verdicts = events.listEvents(result.identity.sessionId, { types: ['goal_alignment_judged'] });
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]?.data.continuation, true);
});

test('an unchanged honest continuation with no new evidence reuses the rejection', async () => {
  // Live 2026-09-15 ("edit this event and add a description"): the first
  // verdict said not done, the continuation made no further call and answered
  // the identical failure report, and the pinned judge was asked again on
  // identical evidence — 23–58 s per verdict, three identical negatives in
  // one turn. On an ACTION objective the second honest reply is judge-eligible
  // (the refresh fixture above is tool_intent, so it never was), and the
  // standing verdict is carried onto it instead of bought twice.
  const request = 'Update the team calendar invite and add a short description about Clem.';
  const honest = 'I could not reach a working calendar update operation, so the invite is unchanged.';
  const result = await runHost({ captured: true, incoming: true, text: request, firstReply: honest, secondReply: honest });
  assert.equal(result.calls, 2, 'the continuation still gets its model step');
  assert.equal(result.judged.length, 1, 'no second judge call on identical evidence');
  const verdicts = events.listEvents(result.identity.sessionId, { types: ['goal_alignment_judged'] });
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts[0]?.data.continuation, true);
  assert.equal(verdicts[0]?.data.fulfills, false);
  assert.equal(verdicts[1]?.data.carriedVerdict, true, 'the settle row says no reviewer answered it');
  assert.equal(verdicts[1]?.data.fulfills, false);
  assert.equal(verdicts[1]?.data.continuation, false);
  assert.equal(verdicts[1]?.data.continuationsUsed, 1);
  assert.equal(verdicts[1]?.data.reason, verdicts[0]?.data.reason, 'the standing verdict is carried, not rewritten');
  assert.equal(verdicts[1]?.data.judgeModelId, undefined);
  assert.equal(verdicts[1]?.data.replyDigest, createHash('sha256').update(honest, 'utf8').digest('hex'));
  assert.equal(result.outcome.finalOutput, honest, 'the honest report reaches the person');

  // NEGATIVE: a continuation that CLAIMS the work still buys a fresh verdict.
  const claiming = await runHost({ captured: true, incoming: true, text: request, secondReply: 'Done — the invite now carries the description.' });
  assert.equal(claiming.judged.length, 2, 'an unverified claim is judged, never carried');
  const claimingVerdicts = events.listEvents(claiming.identity.sessionId, { types: ['goal_alignment_judged'] });
  assert.equal(claimingVerdicts.length, 2);
  assert.equal(claimingVerdicts.every((row) => row.data.carriedVerdict !== true), true);
});

test('a corrected read answer gets a fresh verdict without another business call or completion verb', async () => {
  const corrected = 'The inbox contains the 2:05 email and the 9:00 email.';
  const result = await runHost({ captured: true, incoming: true,
    text: 'Update the inbox summary to list every email received today.',
    firstReply: 'The inbox contains the 9:00 email.', secondReply: corrected,
    readResult: { emails: [{ time: '2:05' }, { time: '9:00' }] },
    firstVerdict: { done: false, reason: 'The 2:05 email is missing from the answer.' },
  });
  assert.equal(result.calls, 2);
  assert.equal(result.judged.length, 2);
  assert.equal(result.judged[1]?.reply, corrected);
  const verdicts = events.listEvents(result.identity.sessionId, { types: ['goal_alignment_judged'] });
  assert.equal(verdicts.at(-1)?.data.fulfills, true);
  assert.equal(verdicts.at(-1)?.data.carriedVerdict, undefined);
});

test('the host sends decisive middle records to the judge, not just the evidence collector', async () => {
  for (const decision of ['Approval is required today.', 'Approval is not required today.']) {
    const payload = { records: [
      { text: 'First record '.repeat(3_000) },
      { text: decision, nested: { customer: 'The decisive middle record' } },
      { text: 'Final record '.repeat(3_000) },
    ] };
    const result = await runHost({ captured: true, incoming: true,
      text: 'Check whether an approval is due today.',
      readResult: payload });
    assert.ok(result.judged.length > 0);
    for (const review of result.judged) {
      // The result is over the per-result bound, so the judge gets the view the
      // answerer got — and that view keeps every record, clipping only the
      // oversized strings, so the decisive middle record is never elided.
      assert.match(review.evidence ?? '', /showing a BOUNDED view/);
      assert.ok(review.evidence?.includes(JSON.stringify({ text: decision, nested: { customer: 'The decisive middle record' } })),
        'the decisive middle record reaches the real host judge boundary whole');
      assert.ok(review.evidence?.includes(decision), 'opposite middle facts must remain distinguishable');
      assert.doesNotMatch(review.evidence ?? '', /characters of retained results elided/);
    }
  }
});

test('captured OFF makes zero judge calls despite incoming ON', async () => {
  const result = await runHost({ captured: false, incoming: true });
  assert.equal(result.judged.length, 0);
  assert.equal(result.calls, 1);
});

test('captured ON remains eligible despite incoming OFF after re-entry', async () => {
  const result = await runHost({ captured: true, incoming: false });
  assert.equal(result.judged.length, 1);
});

test('ordinary chat without source work still uses one brain turn and zero judge calls', async () => {
  const result = await runHost({ captured: true, incoming: true, text: 'Hello', work: false, reply: 'Hello.' });
  assert.equal(result.calls, 1);
  assert.equal(result.judged.length, 0);
});

test('a stop arriving during a negative verdict never starts another brain turn', async () => {
  const result = await runHost({ captured: true, incoming: true, abortAtJudge: true });
  assert.equal(result.calls, 1);
  assert.equal(result.judged.length, 1);
  const verdict = events.listEvents(result.identity.sessionId, { types: ['goal_alignment_judged'] })[0];
  assert.equal(verdict?.data.continuation, false);
});

test('a BLOCKED review ends the turn without another attempt and records the finding', async () => {
  const finding = 'The invite was not changed because the update was refused before it reached the calendar.';
  const result = await runHost({ captured: true, incoming: true,
    text: 'Update the team calendar invite and add a short description about Clem.',
    firstVerdict: { done: false, blocked: true, reason: finding } });
  assert.equal(result.judged.length, 1);
  assert.equal(result.calls, 1, 'another attempt cannot change a blocked outcome, so none is made');
  const verdicts = events.listEvents(result.identity.sessionId, { types: ['goal_alignment_judged'] });
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]?.data.blocked, true);
  assert.equal(verdicts[0]?.data.continuation, false);
  assert.equal(verdicts[0]?.data.reason, finding);
  assert.equal(host.completionVerdictForAcceptedSource(result.identity)?.blocked, true);
});

test('an INCOMPLETE review still buys another attempt', async () => {
  const result = await runHost({ captured: true, incoming: true,
    firstVerdict: { done: false, reason: 'Two of the requested accounts are missing from the reply.' } });
  assert.equal(result.calls, 2);
  const verdicts = events.listEvents(result.identity.sessionId, { types: ['goal_alignment_judged'] });
  assert.equal(verdicts[0]?.data.continuation, true);
  assert.equal(verdicts[0]?.data.blocked, undefined);
});

test('the completion reviewer can open every retained result of the source past its bounded view', async () => {
  const payload = { records: Array.from({ length: 400 }, (_, n) => ({ id: n, note: 'retained record '.repeat(12) })), tail: 'OPENABLE_TAIL' };
  const result = await runHost({ captured: true, incoming: true, readResult: payload });
  const lookup = result.judged[0]?.lookup;
  assert.ok(lookup, 'the reviewer receives the source-scoped evidence lookup');
  const refs = lookup.refs();
  assert.ok(refs.length > 0);
  const opened = refs.map((ref) => lookup.resolve(ref)).find((entry) => entry?.text.includes('OPENABLE_TAIL'));
  assert.ok(opened, 'the whole retained result opens, not only the bounded view shown inline');
  assert.equal((opened.value as { records: unknown[] }).records.length, 400);
  assert.equal(lookup.resolve('read:some_other_source'), undefined);
});

test('writes that did not complete and calls refused before they ran are evidence for the reviewer', () => {
  const identity = accepted('Update the invite description.');
  retainedRead(identity, 'calendar_update_event', { error: 'rejected' }, true, false, true);
  events.appendEvent({ ...identity, role: 'tool', type: 'tool_returned', data: {
    sourceUserSeq: identity.sourceUserSeq, callId: 'read:calendar_update_event', tool: 'calendar_update_event',
    ok: false, result: 'Event id is not valid for update.' } });
  events.appendEvent({ ...identity, role: 'system', type: 'guardrail_tripped', data: {
    kind: 'refused_pre_dispatch', sourceUserSeq: identity.sourceUserSeq, stage: 'host_disposition:refused_pre_dispatch',
    recoveryToolNames: ['calendar_update_event'], refusalDetail: 'The reviewed call does not match the planned operation.',
    calls: [{ name: 'work_call' }] } });
  events.appendEvent({ ...identity, sourceUserSeq: identity.sourceUserSeq + 1, role: 'system', type: 'guardrail_tripped', data: {
    kind: 'refused_pre_dispatch', sourceUserSeq: identity.sourceUserSeq + 1, stage: 'other', refusalDetail: 'UNRELATED_REFUSAL' } } as never);
  events.closeEventLog();
  const summary = sourceIncompleteAttemptsEvidence(identity) ?? '';
  assert.match(summary, /write calendar_update_event \[logicalCall=read:calendar_update_event\] settled invalid_arguments/);
  assert.match(summary, /returned: Event id is not valid for update\./);
  assert.match(summary, /refused before it ran \(host_disposition:refused_pre_dispatch\) for calendar_update_event: The reviewed call does not match the planned operation\./);
  assert.doesNotMatch(summary, /UNRELATED_REFUSAL/);
  assert.equal(sourceIncompleteAttemptsEvidence(accepted('Nothing attempted.')), undefined);
});

test('a blocked finding replaces the rejected draft; a plain negative keeps the generic note', () => {
  for (const [blocked, expected] of [
    [true, /^The invite was not changed because the update was refused before it reached the calendar\.$/],
    [false, /Verification note: the completion review did not accept this write-up\./],
  ] as const) {
    const identity = accepted('Update the invite description.');
    host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: true });
    events.appendEvent({ sessionId: identity.sessionId, turn: 0, role: 'system', type: 'goal_alignment_judged', data: {
      lane: 'host_v1', kind: 'completion', sourceUserSeq: identity.sourceUserSeq, fulfills: false,
      reason: 'The invite was not changed because the update was refused before it reached the calendar.',
      objectiveDigest: createHash('sha256').update('Update the invite description.').digest('hex'),
      replyDigest: createHash('sha256').update('I updated the invite.').digest('hex'),
      ...(blocked ? { blocked: true } : {}), continuation: false } });
    const committed = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
      presentation: { kind: 'answer', text: 'I updated the invite.' } });
    assert.match(committed.presentation.text, expected);
    if (blocked) {
      const audit = events.listEvents(identity.sessionId, { types: ['guardrail_tripped'] })
        .find(event => event.data.kind === 'completion_review_rejected_draft');
      assert.equal(audit?.data.rejectedText, 'I updated the invite.');
      assert.equal(committed.event.data.rejectedCompletionText, undefined);
    }
    assert.notEqual(committed.presentation.status, 'done');
  }
});

// Live 2026-09-25: the note stopped mid-sentence at a fixed 240 characters.
test('a negative review note shows every finding whole, cut only between items', () => {
  const identity = accepted('Summarize the three offices.');
  host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: true });
  const items = Array.from({ length: 30 }, (_, i) => `(${i + 1}) "office ${i} grew" — the report shows no change for office ${i}`).join('; ');
  events.appendEvent({ sessionId: identity.sessionId, turn: 0, role: 'system', type: 'goal_alignment_judged', data: {
    lane: 'host_v1', kind: 'completion', sourceUserSeq: identity.sourceUserSeq, fulfills: false, reason: items,
    objectiveDigest: createHash('sha256').update('Summarize the three offices.').digest('hex'),
    replyDigest: createHash('sha256').update('All offices grew.').digest('hex'), continuation: false } });
  const committed = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
    presentation: { kind: 'answer', text: 'All offices grew.' } });
  const note = committed.presentation.text.slice(committed.presentation.text.indexOf('Verification note'));
  assert.match(note, /\(1\) "office 0 grew" — the report shows no change for office 0/);
  assert.match(note, /\(3\) "office 2 grew" — the report shows no change for office 2/);
  assert.match(note, /no change for office \d+ …/, 'a long list ends at a whole item, marked as cut');
  assert.doesNotMatch(note, /offic …|repor …/, 'never cut mid-word');
});

test('a reviewer looks up the evidence it needs through the real SDK loop, then rules', async () => {
  const lookup = {
    refKind: 'step ids of this run',
    refs: () => ['triage'],
    resolve: (ref: string) => ref === 'triage'
      ? { text: '', value: { emails: [
        { subject: 'Renewal', bucket: 'respond', draft: 'Attached.' },
        { subject: 'Invoice', bucket: 'respond', draft: '' },
      ] } }
      : undefined,
  };
  const requests: string[] = [];
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
      : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const model = {
    async getResponse(request: unknown) {
      requests.push(strings(request).join('\n'));
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, requests: 1, inputTokensDetails: [], outputTokensDetails: [] };
      if (requests.length === 1) {
        return { responseId: 'judge-lookup', usage, output: [{ type: 'function_call', callId: 'lookup-1', name: 'query_evidence', status: 'completed',
          arguments: JSON.stringify({ ref: 'triage', where_field: 'bucket', equals: 'respond', fields: ['subject', 'draft'] }) }] };
      }
      return { responseId: 'judge-verdict', usage, output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'INCOMPLETE: The Invoice email in the respond bucket has an empty draft.' }] }] };
    },
    async *getStreamedResponse() { throw new Error('The review uses the response path'); },
  };
  const verdict = await runRoutedJudgeAttempt({ model: model as never, modelId: 'claude-opus-5', judgeFamily: 'claude',
    brainFamily: 'byo', transport: 'claude_subscription', selfJudge: false },
    JUDGE_SYSTEM_PROMPT, 'Objective: Every respond email has a draft.\n\nEvidence: 2 emails (sample).', parseCompletionVerdict, false, lookup);
  assert.equal(requests.length, 2, 'one lookup, then the verdict');
  assert.match(requests[0]!, /EVIDENCE TOOLS/);
  assert.match(requests[1]!, /2 of 2 records at emails match/, 'the lookup result is in front of the reviewer when it rules');
  assert.equal(verdict?.done, false);
  assert.match(verdict?.reason ?? '', /empty draft/);
});

test('a BLOCKED verdict parses as not done and not worth another attempt', () => {
  assert.deepEqual(parseCompletionVerdict('BLOCKED: The sheet was not updated because the connection to it is failing.'),
    { done: false, blocked: true, reason: 'The sheet was not updated because the connection to it is failing.' });
  assert.equal(parseCompletionVerdict('INCOMPLETE: two rows missing')?.blocked, undefined);
  assert.match(JUDGE_SYSTEM_PROMPT, /WOULD ANOTHER ATTEMPT HELP\?/);
  assert.match(JUDGE_SYSTEM_PROMPT, /"BLOCKED: <one plain sentence for the owner/);
});

test('carrier use alone cannot replace a valid retained-data answer or adopted cancellation with a continue demand', () => {
  for (const [text, answer] of [
    ['What does the saved workflow do?', 'The saved workflow reads posts and prepares a report.'],
    ['Cancel the report; just acknowledge that you stopped.', 'Stopped; no report data was changed.'],
  ]) {
    const identity = accepted(text);
    host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: false });
    attempted(identity, 'work_call');
    settledHostRead(identity);
    const committed = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false, presentation: { kind: 'answer', text: answer } });
    assert.equal(committed.presentation.status, 'done');
    assert.equal(committed.presentation.text, answer);
    assert.doesNotMatch(committed.presentation.text, /no business call landed/);
  }
});


for (const incoming of [true, false]) {
  test(`unreadable captured policy skips optional host review with incoming ${incoming} without a continuation`, async () => {
    const result = await runHost({ captured: true, incoming, policyData: { version: 2, enabled: 'unreadable' } });
    assert.equal(result.judged.length, 0);
    assert.equal(result.calls, 1);
    assert.equal(host.readCapturedCompletionPolicy(result.identity).status, 'unreadable');
    assert.equal(events.listEvents(result.identity.sessionId, { types: ['goal_alignment_judged'] }).length, 0);
  });
}

test('the production host completion seam forwards the same accepted selection across reopen and re-entry', async () => {
  const original = process.env.CLEMMY_MODEL_ROLES;
  try {
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: 'claude-opus-5', scope: 'durable', source: 'settings' }]);
    const result = await runHost({ captured: true, incoming: false, afterCapture: () => {
      process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'judge', modelId: 'gpt-5.6-terra', scope: 'durable', source: 'settings' }]);
      events.closeEventLog();
    } });
    const read = host.readCapturedCompletionPolicy(result.identity);
    assert.equal(read.status, 'captured');
    if (read.status !== 'captured') throw new Error('capture missing');
    assert.equal(result.judged.length, 1);
    for (const attempt of result.judged) assert.deepEqual(attempt.selection, read.policy.judgeSelection);
    assert.equal(read.policy.judgeModelId, 'claude-opus-5');
  } finally {
    if (original === undefined) delete process.env.CLEMMY_MODEL_ROLES;
    else process.env.CLEMMY_MODEL_ROLES = original;
  }
});

test('workflow write review receives sealed invocation arguments, not only a successful acknowledgement', () => {
  const runId = `write-scope-${++serial}`;
  const sessionId = `workflow:${runId}:main`;
  events.createSession({ id: sessionId, kind: 'chat' });
  const source = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Update the data while preserving the existing header.' } });
  const identity = { sessionId, sourceUserSeq: source.seq, turn: 1 };
  retainedRead(identity, 'record_update', { updatedCells: 2 }, true, false, false, {
    id: 'overwrite-header', args: { destination: 'A1:B1', values: [['WRONG_HEADER', 'WRONG_VALUE']] },
  });
  const evidence = readWorkflowTargetEvidence(runId);
  assert.match(evidence.summary, /VERIFIED.*REQUEST SCOPE/);
  assert.match(evidence.summary, /A1:B1/);
  assert.match(evidence.summary, /WRONG_HEADER/);
  assert.doesNotMatch(readWorkflowTargetEvidence(`${runId}-other`).summary, /WRONG_HEADER/);
});


test('workflow request scope stays lazy, survives reopen and cannot be supplied by transcript claims', () => {
  const runId = `large-write-scope-${++serial}`;
  const sessionId = `workflow:${runId}:main`;
  events.createSession({ id: sessionId, kind: 'chat' });
  const source = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Update the approved records.' } });
  const identity = { sessionId, sourceUserSeq: source.seq, turn: 1 };
  const args = { destination: 'approved-records', values: Array.from({ length: 600 }, (_, i) => ({
    id: i, value: `saved-value-${i}-` + 'x'.repeat(50),
  })) };
  retainedRead(identity, 'record_update', { updatedRecords: 600 }, true, false, false,
    { id: 'large-write', args });
  events.appendEvent({ ...identity, role: 'Clem', type: 'tool_called', data: {
    sourceUserSeq: source.seq, tool: 'record_update', accounting: 'top_level',
    canonicalCallId: 'large-write', arguments: { destination: 'FORGED_TRANSCRIPT_SCOPE' },
  } });
  events.closeEventLog();
  const evidence = readWorkflowTargetEvidence(runId);
  const ref = evidence.evidence?.refs().find(value => value.startsWith('request:'));
  assert.ok(ref, 'large exact arguments are available through a review lookup');
  assert.deepEqual(evidence.evidence?.resolve(ref)?.value, args);
  assert.doesNotMatch(evidence.summary, /saved-value-599|FORGED_TRANSCRIPT_SCOPE/);
  assert.ok(evidence.summary.length < 12_000, 'the request payload is not copied into the summary');

  // Remove the sealed request only in this test's isolated fixture. A real
  // result receipt remains; model transcript arguments cannot replace proof.
  const db = events.openEventLog();
  db.prepare(`DELETE FROM physical_dispatch_authority_sealed WHERE session_id = ?`).run(sessionId);
  db.prepare(`UPDATE events SET data_json = json_remove(data_json, '$.requestEvidenceCipher')
    WHERE session_id = ? AND type = 'provider_dispatch_started'`).run(sessionId);
  const missing = readWorkflowTargetEvidence(runId);
  assert.equal(missing.available, false);
  assert.match(missing.summary, /sealed request scope UNAVAILABLE/);
  assert.doesNotMatch(missing.summary, /FORGED_TRANSCRIPT_SCOPE|VERIFIED REQUEST SCOPE/);
});

 test('parent and verified worker reads share identical content once while preserving scope and distinct results', () => {
  const parent = accepted('Use two workers to compare the provided records.');
  retainedRead(parent, 'run_worker', { status: 'completed' });
  const common = 'SHARED_REFERENCE_BODY_UNIQUE';
  retainedRead(parent, 'read_file', common);
  const children: Array<ReturnType<typeof accepted>> = [];
  for (const item of ['first', 'second']) {
    const session = events.createSession({ id: `dedup-worker-${++serial}`, kind: 'chat' });
    const binding = { parentSessionId: parent.sessionId, parentSourceUserSeq: parent.sourceUserSeq,
      parentAcceptedTaskId: identities.acceptedTaskIdFor(parent.sessionId, parent.sourceUserSeq),
      parentLogicalCallId: 'read:run_worker', packetDigest: `packet-${item}`, item };
    const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: `Compare ${item}`, delegatedWorker: binding } });
    const child = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
    children.push(child);
    events.appendEvent({ sessionId: parent.sessionId, turn: 1, role: 'system', type: 'worker_started',
      data: { ...binding, childSessionId: child.sessionId, childSourceUserSeq: child.sourceUserSeq } });
    retainedRead(child, 'read_file', common);
    retainedRead(child, 'records__read', `DISTINCT_RESULT_${item}`);
  }
  const bulk = 'COMPLETE_RETAINED_PAGE '.repeat(DEFAULT_TOOL_RESULT_MAX_CHARS);
  retainedRead(parent, 'atlas__bulk', bulk);
  retainedRead(children[0]!, 'tool_output_query', bulk);
  const evidence = sourceSettledReadEvidence(parent);
  assert.equal(evidence.results.find(row => row.toolName === 'tool_output_query')?.contentComplete, true,
    'a bounded parent source cannot suppress a full worker projection');
  assert.equal(evidence.summary.split(common).length - 1, 1);
  for (const item of ['first', 'second']) assert.ok(evidence.summary.includes(`DISTINCT_RESULT_${item}`));
  for (const child of children) {
    assert.ok(evidence.summary.includes(child.sessionId));
    const reopened = sourceEvidenceLookup(parent).resolve(`worker:${child.sessionId}:${child.sourceUserSeq}:read:read_file`);
    assert.equal(reopened?.text, common, 'deduplication never removes independently redeemable worker evidence');
  }
  assert.equal(evidence.results.filter(row => row.toolName === 'read_file').length, 3);
  assert.equal(evidence.results.filter(row => row.contentDisposition === 'duplicate_content').length, 2);
});

// --- the chosen writer (writer / reviewer split) ---
type WriterRun = {
  identity: ReturnType<typeof accepted>;
  outcome: Awaited<ReturnType<typeof host.hostRunRunner>>;
  brainCalls: number;
  writerRequests: Array<{ input: unknown; systemInstructions?: string; tools?: unknown[] }>;
  judged: Array<{ reply: string; author?: string }>;
};
async function runWrittenHost(options: {
  reads: number;
  writer: 'none' | 'writes' | 'throws' | 'calls_tool';
  verdicts?: Array<{ done: boolean; reason: string }>;
  /** Runs before the turn, e.g. to attach a live viewer to the session. */
  onIdentity?: (identity: ReturnType<typeof accepted>) => void;
}): Promise<WriterRun> {
  // An action request, so the completion review runs on the scripted turn.
  const writerRequestText = 'Pull the two retained reports and write me a short snapshot I can use in the pitch.';
  const identity = accepted(writerRequestText);
  options.onIdentity?.(identity);
  host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: true });
  attempted(identity);
  const judged: WriterRun['judged'] = [];
  const verdicts = [...(options.verdicts ?? [{ done: true, reason: 'The reply matches the retained reports.' }])];
  host._setHostObjectiveJudgeForTests(async (_objective, reply, context) => {
    judged.push({ reply, ...(context?.reviewedAuthor ? { author: context.reviewedAuthor.modelId } : {}) });
    return verdicts.shift() ?? { done: true, reason: 'ok' };
  });
  const message = (text: string) => [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }];
  const streamed = (model: { getResponse(request?: unknown): Promise<{ responseId: string; usage: unknown; output: unknown[] }> }) =>
    async function* (request?: unknown) {
      const response = await model.getResponse(request);
      yield { type: 'response_started' } as never;
      for (const item of response.output as Array<{ type?: string; content?: Array<{ text?: string }> }>) {
        const text = item.type === 'message' ? item.content?.[0]?.text ?? '' : '';
        const half = Math.floor(text.length / 2);
        if (text) yield* [{ type: 'output_text_delta', delta: text.slice(0, half) }, { type: 'output_text_delta', delta: text.slice(half) }] as never[];
      }
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    };
  let brainCalls = 0;
  const brain = {
    async getResponse() {
      brainCalls += 1;
      if (brainCalls === 1) {
        for (let index = 0; index < options.reads; index += 1) {
          retainedRead(identity, 'read_file', { report: `report ${index}`, visits: 1957 + index, rank: 6 + index },
            false, true, false, { id: `read:writer-${serial}-${index}`, args: { path: `/reports/${index}.json` } });
        }
      }
      return { responseId: `brain-${serial}-${brainCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: message(`Brain draft ${brainCalls}: the reports show about 1,957 visits and rank 6.`) };
    },
    getStreamedResponse: undefined as unknown,
  };
  brain.getStreamedResponse = streamed(brain);
  const writerRequests: WriterRun['writerRequests'] = [];
  let writerCalls = 0;
  const writerModel = {
    async getResponse(request?: unknown) {
      writerRequests.push(request as WriterRun['writerRequests'][number]);
      writerCalls += 1;
      if (options.writer === 'throws') throw new Error('writer provider unavailable');
      if (options.writer === 'calls_tool') {
        return { responseId: `writer-${serial}-${writerCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [{ type: 'function_call', callId: 'writer-tool', name: 'read_file', arguments: '{}', status: 'completed' }] };
      }
      return { responseId: `writer-${serial}-${writerCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: message(`Written answer ${writerCalls}: 1,957 monthly visits; the site ranks 6th.`) };
    },
    getStreamedResponse: undefined as unknown,
  };
  writerModel.getStreamedResponse = streamed(writerModel);
  host._setHostWriterForTests(options.writer === 'none' ? () => null : () => ({
    resolved: { modelId: 'fixture-writer-model', provider: 'claude', source: 'settings' },
    model: writerModel as never,
  }));
  const agent = { model: brain, tools: [] };
  const prior = catalogs.peekHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  try {
    const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: identity.sessionId, universeTools: [], activeToolNames: [], policyHash: 'completion-contract-writer', budget: { maxUncachedTokens: 10_000, maxModelCalls: 8, maxToolCalls: 20, maxElapsedMs: 60_000 } });
    assert.equal(sealed.ok, true);
    if (!sealed.ok) throw new Error('fixture envelope did not seal');
    envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
    const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } });
    const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(20) }, () => host.hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: writerRequestText }] as never, { maxTurns: 8, hostTurnEngine: 'host_v1', hostJudgeCompletion: true, context: identity } as never));
    return { identity, outcome, brainCalls, writerRequests, judged };
  } finally {
    host._setHostObjectiveJudgeForTests(null);
    host._setHostWriterForTests(null);
    catalogs.installHostCapabilityCatalogFactory(prior);
  }
}
function writerJournal(identity: ReturnType<typeof accepted>): string[] {
  return events.listEvents(identity.sessionId, { types: ['guardrail_tripped'] })
    .map((event) => event.data as { kind?: string; phase?: string })
    .filter((data) => data.kind === 'host_final_writer')
    .map((data) => String(data.phase));
}

test('a chosen writer writes the final answer from the gathered evidence before review reads it', async () => {
  const run = await runWrittenHost({ reads: 2, writer: 'writes' });
  assert.equal(run.writerRequests.length, 1, 'the writer wrote once');
  const request = run.writerRequests[0]!;
  assert.deepEqual(request.tools ?? [], [], 'the writer has no tools');
  const packet = JSON.stringify(request.input);
  assert.match(packet, /EVIDENCE GATHERED FOR THIS REQUEST/);
  assert.match(packet, /report 0/, 'the writer sees the same retained results the reviewer sees');
  assert.match(packet, /Brain draft 1/, 'the writer starts from the brain draft');
  assert.equal(run.judged.length, 1);
  assert.match(run.judged[0]!.reply, /Written answer 1/, 'review reads the written answer, not the draft');
  assert.equal(run.judged[0]!.author, 'fixture-writer-model', 'review independence is measured against the writer');
  assert.match(String(run.outcome.finalOutput), /Written answer 1/);
  assert.deepEqual(writerJournal(run.identity), ['armed', 'written']);
});

test('without a chosen writer the brain draft goes straight to review', async () => {
  const run = await runWrittenHost({ reads: 2, writer: 'none' });
  assert.equal(run.writerRequests.length, 0);
  assert.match(run.judged[0]!.reply, /Brain draft 1/);
  assert.equal(run.judged[0]!.author, undefined);
  assert.deepEqual(writerJournal(run.identity), []);
});

test('a turn without gathered evidence keeps the brain answer and skips the writer', async () => {
  const run = await runWrittenHost({ reads: 0, writer: 'writes' });
  assert.equal(run.writerRequests.length, 0, 'a turn without retained read results is not written');
  assert.match(String(run.outcome.finalOutput), /Brain draft 1/);
  assert.deepEqual(writerJournal(run.identity), []);
});

test('a failing writer delivers the brain draft to review instead of failing the turn', async () => {
  const run = await runWrittenHost({ reads: 2, writer: 'throws' });
  assert.ok(run.writerRequests.length >= 1);
  assert.match(run.judged[0]!.reply, /Brain draft 1/, 'the reviewed reply is the brain draft');
  assert.equal(run.judged[0]!.author, undefined, 'the brain, not the writer, authored it');
  assert.match(String(run.outcome.finalOutput), /Brain draft 1/);
  assert.deepEqual(writerJournal(run.identity), ['armed', 'fell_back']);
});

test('a writer that tries to call a tool is refused and the brain draft is reviewed', async () => {
  const run = await runWrittenHost({ reads: 2, writer: 'calls_tool' });
  assert.match(run.judged[0]!.reply, /Brain draft 1/);
  assert.deepEqual(writerJournal(run.identity), ['armed', 'fell_back']);
});

test('a review finding reaches the writer when the brain drafts again', async () => {
  const run = await runWrittenHost({ reads: 2, writer: 'writes', verdicts: [
    { done: false, reason: 'The visit count in the reply does not match the retained report.' },
    { done: true, reason: 'The corrected reply matches the retained reports.' },
  ] });
  assert.equal(run.judged.length, 2);
  assert.equal(run.writerRequests.length, 2, 'each new brain draft is written');
  assert.match(JSON.stringify(run.writerRequests[1]!.input), /REVIEW FINDING TO RESOLVE[\s\S]*visit count/,
    'the writer sees what the reviewer rejected');
  assert.match(String(run.outcome.finalOutput), /Written answer 2/);
});

// --- the answer stream through the host loop (answer-stream.ts) ---
const answerStream = await import('./answer-stream.js');
type AnswerFrame = { streamId: string; offset?: number; delta?: string; reset?: boolean };
/** Attach a live viewer; `seen` is every text it showed, in order, following
 *  the client contract (offset 0 replaces, a matching offset extends, a reset
 *  of the shown draft clears it). */
function watchAnswer(sessionId: string): { seen: () => string[]; detach: () => void } {
  const frames: AnswerFrame[] = [];
  const detach = answerStream.attachAnswerStream(sessionId, (frame) => { frames.push(frame.data as AnswerFrame); });
  const seen = (): string[] => {
    const shown: string[] = [];
    let text = '';
    let id = '';
    for (const frame of frames) {
      if (frame.reset) { if (frame.streamId === id) { text = ''; id = ''; } }
      else if (frame.offset === 0) { text = frame.delta ?? ''; id = frame.streamId; }
      else if (frame.streamId === id && frame.offset === text.length) text += frame.delta ?? '';
      else continue;
      if (shown.at(-1) !== text) shown.push(text);
    }
    return shown;
  };
  return { seen, detach };
}
const brainDraft = (n: number) => `Brain draft ${n}: the reports show about 1,957 visits and rank 6.`;
const writtenAnswer = (n: number) => `Written answer ${n}: 1,957 monthly visits; the site ranks 6th.`;
const rejectThenAccept = [
  { done: false, reason: 'The visit count in the reply does not match the retained report.' },
  { done: true, reason: 'The corrected reply matches the retained reports.' },
];

test('a streamed draft that review rejects is retracted before the next draft is shown', async () => {
  let watch: ReturnType<typeof watchAnswer> | undefined;
  const run = await runWrittenHost({ reads: 2, writer: 'none', verdicts: rejectThenAccept,
    onIdentity: (identity) => { watch = watchAnswer(identity.sessionId); } });
  assert.equal(run.judged.length, 2);
  assert.deepEqual(watch!.seen(), [brainDraft(1), '', brainDraft(2)],
    'draft 1 shows while it is reviewed, is gone once rejected, and draft 2 replaces it');
  watch!.detach();
});

test('with a chosen writer, a draft it will rewrite is held and the written answer streams', async () => {
  let watch: ReturnType<typeof watchAnswer> | undefined;
  const run = await runWrittenHost({ reads: 2, writer: 'writes', verdicts: rejectThenAccept,
    onIdentity: (identity) => { watch = watchAnswer(identity.sessionId); } });
  assert.match(String(run.outcome.finalOutput), /Written answer 2/);
  // The first draft's evidence settled while that very step ran, so nothing
  // could hold it; it is retracted before the writer's answer appears. Once
  // evidence exists at the start of a step, the brain draft is never shown.
  assert.deepEqual(watch!.seen(), [brainDraft(1), '', writtenAnswer(1), '', writtenAnswer(2)]);
  watch!.detach();
});

test('a failing writer shows the brain draft as it goes to review', async () => {
  let watch: ReturnType<typeof watchAnswer> | undefined;
  await runWrittenHost({ reads: 2, writer: 'throws',
    onIdentity: (identity) => { watch = watchAnswer(identity.sessionId); } });
  assert.equal(watch!.seen().at(-1), brainDraft(1));
  assert.ok(watch!.seen().every((text) => !/Written answer/.test(text)));
  watch!.detach();
});

test('a turn without gathered evidence streams the brain answer even with a writer chosen', async () => {
  let watch: ReturnType<typeof watchAnswer> | undefined;
  await runWrittenHost({ reads: 0, writer: 'writes',
    onIdentity: (identity) => { watch = watchAnswer(identity.sessionId); } });
  assert.deepEqual(watch!.seen(), [brainDraft(1)]);
  watch!.detach();
});

// Live 2026-09-25 fixture: "before I say yes, will saving it overwrite
// anything?" ran the folder checks; the next turn, "go ahead, save it", saved
// and said it had checked beforehand. The reviewer saw only the save turn's
// evidence, ruled the pre-check unverified three times, and a finished save
// ended blocked.
test('the reviewer sees what an earlier turn checked when the reply rests on it', async () => {
  const result = await runHost({
    captured: true, incoming: true,
    earlierTurn: {
      text: 'before I say yes, will saving it overwrite anything that is already there?',
      tool: 'list_files', payload: { path: '/fixture/output', entries: [] }, args: { path: '/fixture/output' },
    },
    text: 'go ahead, save the note',
    firstReply: 'Saved the note. I checked beforehand that /fixture/output was empty, so nothing was overwritten.',
    firstVerdict: { done: true, reason: 'Saved as asked; the earlier check shows the folder was empty.' },
  });
  const evidence = result.judged[0]?.evidence ?? '';
  assert.match(evidence, /EARLIER TURNS of this conversation/);
  assert.match(evidence, /before I say yes, will saving it overwrite anything/);
  assert.match(evidence, /- list_files \(read\) \{"path":"\/fixture\/output"\}: /);
  assert.match(evidence, /"entries":\[\]/);
  assert.match(evidence, /EARLIER TURNS evidence counts for what the reply says an earlier turn checked/);
});

test('earlier-turn evidence is bounded: this turn, synthetic inputs and old turns stay out', () => {
  const first = accepted('check the folder first');
  retainedRead(first, 'list_files', { entries: ['a.txt'] }, false, false, false, { id: 'bounded:first', args: { path: '/one' } });
  const synthetic = events.appendEvent({ sessionId: first.sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: '[continuation]', synthetic: true } });
  void synthetic;
  const second = accepted('now read the second folder', first.sessionId);
  retainedRead(second, 'list_files', { entries: ['b.txt'] }, false, false, false, { id: 'bounded:second', args: { path: '/two' } });
  const current = accepted('go ahead', first.sessionId);
  retainedRead(current, 'write_file', { ok: true }, true, false, false, { id: 'bounded:current', args: { path: '/two/c.txt' } });

  const shown = earlierTurnsEvidence(current) ?? '';
  assert.match(shown, /check the folder first/);
  assert.match(shown, /now read the second folder/);
  assert.ok(shown.indexOf('/one') < shown.indexOf('/two'), 'oldest first');
  assert.doesNotMatch(shown, /write_file/, 'this turn\'s own work is not earlier evidence');
  assert.doesNotMatch(shown, /\[continuation\]/, 'a synthetic input is not a turn');

  const lastOnly = earlierTurnsEvidence({ ...current, maxTurns: 1 }) ?? '';
  assert.doesNotMatch(lastOnly, /check the folder first/);
  assert.match(lastOnly, /now read the second folder/);
  assert.equal(earlierTurnsEvidence({ ...current, nowMs: Date.now() + 2 * 60 * 60_000 }), undefined,
    'turns older than the window are not offered');
  assert.equal(earlierTurnsEvidence(first), undefined, 'a first turn has nothing earlier');
  const clipped = earlierTurnsEvidence({ ...current, maxChars: 80 }) ?? '';
  assert.match(clipped, /earlier-turn evidence clipped at 80 characters/);
});

test('every review response carries the output bound, on whichever wire answers', async () => {
  const { judgeMaxOutputTokens } = await import('./objective-judge.js');
  let seenMaxTokens: unknown = 'unset';
  const model = {
    async getResponse(request: { modelSettings?: { maxTokens?: number } }) {
      seenMaxTokens = request.modelSettings?.maxTokens;
      return { responseId: 'bounded-judge', usage: { inputTokens: 10, outputTokens: 5,
        totalTokens: 15, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
        text: 'DONE: the requested result is delivered.' }] }] };
    },
    async *getStreamedResponse() { throw new Error('the one-step judge must use the response path'); },
  };
  const verdict = await runRoutedJudgeAttempt({ model: model as never, modelId: 'fixture-judge',
    judgeFamily: 'byo', brainFamily: 'byo', transport: 'byo_api', selfJudge: false },
    JUDGE_SYSTEM_PROMPT, 'OBJECTIVE: say hello\nRESPONSE: hello', parseCompletionVerdict, false);
  assert.equal(verdict.done, true);
  assert.equal(seenMaxTokens, judgeMaxOutputTokens(), 'the bound travels on the request the wire receives');
  assert.ok(judgeMaxOutputTokens() <= 65_536 && judgeMaxOutputTokens() >= 2_048);
});


test('lookup-backed completion avoids re-inflating bulk reads while preserving exact bytes and selected pages', () => {
  const identity = accepted('Read the complete fixture report.');
  const text = Array.from({ length: 700 }, (_, i) => `Report row ${i}: evidence`).join('\n') + '\nDECISIVE_FINAL_RECORD';
  retainedRead(identity, 'fixture_business_read', text);
  const page = 'selected evidence '.repeat(100) + 'SELECTED_PAGE_END';
  retainedRead(identity, 'recall_tool_result', page, false, false, false,
    { id: 'recalled-fixture', args: { call_id: 'read:fixture_business_read' } });
  events.closeEventLog();
  const ordinary = sourceSettledReadEvidence(identity);
  const compact = sourceSettledReadEvidence({ ...identity, lookupBacked: true });
  assert.ok(compact.summary.length < ordinary.summary.length - 8000);
  assert.equal(compact.results[0]?.contentComplete, false);
  assert.equal(compact.results[0]?.contentDigest, ordinary.results[0]?.contentDigest);
  assert.match(compact.summary, /reviewer preview/);
  assert.ok(compact.summary.includes(page), 'targeted selected evidence remains whole');
  const lookup = sourceEvidenceLookup(identity);
  assert.equal(lookup.resolve(compact.results[0]!.resultHandleId!)?.text, text);
  assert.equal(lookup.resolve('unrelated-source'), undefined);
});


test('lookup-backed completion bounds bulk retained pages without losing exact source-scoped evidence', () => {
  const identity = accepted('Compare all fixture result pages.');
  const pages = Array.from({ length: 12 }, (_, i) => `Page ${i}: ` + 'source evidence '.repeat(1200) + ` END_${i}`);
  for (const [i, page] of pages.entries()) retainedRead(identity, 'recall_tool_result', page, false, false, false,
    { id: `budget-page-${i}`, args: { call_id: `source-${i}` } });
  const ordinary = sourceSettledReadEvidence(identity);
  assert.ok(ordinary.summary.length > 50_000);
  for (const [i, result] of ordinary.results.entries()) {
    assert.equal(result.contentComplete, true, 'without lookup the full selected page remains inline');
    assert.ok(ordinary.summary.includes(pages[i]!));
  }
  const evidence = sourceSettledReadEvidence({ ...identity, lookupBacked: true });
  const lookup = sourceEvidenceLookup(identity);
  assert.equal(evidence.results.length, pages.length);
  assert.ok(evidence.summary.length < 80_000, 'bulk retained pages must not bypass the reviewer preview budget');
  assert.match(evidence.summary, /Content omitted here is uninspected by this review, not absent/);
  events.closeEventLog(); // handles must remain redeemable after reopening, not just from memory
  for (const [i, result] of evidence.results.entries()) {
    assert.equal(result.contentComplete, false);
    assert.equal(result.viewBounded, true);
    assert.ok(!evidence.summary.includes(pages[i]!));
    assert.equal(lookup.resolve(result.resultHandleId!)?.text, pages[i]);
  }
  const other = accepted('Unrelated work.');
  const unrelated = sourceEvidenceLookup(other);
  assert.equal(unrelated.resolve(evidence.results[0]!.resultHandleId!), undefined);
});

test('a bounded list read carries its denominator, its source completeness and its order against the write', async () => {
  const { assessReviewCoverage, reviewCoverageLedger } = await import('./review-evidence-coverage.js');
  const { judgeEvidenceTools } = await import('./judge-evidence-tools.js');
  const identity = accepted('Add the autumn events to the calendar unless they are already there.');
  // The match is past the prefix a bounded view keeps; the body is large enough
  // that the review receives the list as a preview.
  const listed = { data: { value: Array.from({ length: 94 }, (_, index) => ({
    id: `event-${index}`, subject: index === 71 ? 'Autumn Picture Day' : `Standing meeting ${index % 7}`,
    start: { dateTime: `2026-10-${String((index % 28) + 1).padStart(2, '0')}T09:00:00` }, body: 'agenda '.repeat(300),
  })) } };
  retainedRead(identity, 'calendar_list_events', listed, false, false, false, { id: 'list-month', args: { month: '2026-10' } });
  retainedRead(identity, 'calendar_create_event', { id: 'created-1', subject: 'Autumn Picture Day' }, true, false, false,
    { id: 'create-1', args: { subject: 'Autumn Picture Day' } });
  retainedRead(identity, 'calendar_get_event', { id: 'created-1', subject: 'Autumn Picture Day', start: '2026-10-20' }, false, false, false,
    { id: 'readback-1', args: { id: 'created-1' } });
  events.closeEventLog();
  const evidence = sourceSettledReadEvidence({ ...identity, lookupBacked: true });
  const list = evidence.results.find((row) => row.logicalToolCallId === 'list-month')!;
  const write = evidence.results.find((row) => row.logicalToolCallId === 'create-1')!;
  const readback = evidence.results.find((row) => row.logicalToolCallId === 'readback-1')!;
  assert.equal(list.contentComplete, false);
  assert.equal(list.recordCount, 94);
  assert.equal(list.sourceExhausted, true, 'a host execution holds everything the function returned');
  assert.equal(list.precedesWrite, true, 'this read shows the state before the write');
  assert.equal(readback.precedesWrite, undefined, 'a read after the write can verify it');
  assert.equal(readback.contentComplete, true);
  assert.equal(write.recordCount, undefined, 'a write receipt is one operation, not a list to cover');
  assert.equal(write.precedesWrite, undefined);
  assert.doesNotMatch(evidence.summary, /Autumn Picture Day[^]*Standing meeting 1"[^]*event-71/, 'the late record is outside the preview');

  const ledger = reviewCoverageLedger(evidence.results)!;
  assert.match(ledger, /list-month \(calendar_list_events\): \d+ of \d+ bytes shown; 94 records; nothing else opened; read before a write by this request/);
  assert.doesNotMatch(ledger, /create-1|readback-1/);
  assert.equal(assessReviewCoverage({ results: evidence.results, needsAllOf: ['list-month'] }).status, 'insufficient');

  // The reviewer's own tools, over the same source-scoped lookup the host
  // gives a review, settle it: one exhaustive query finds the late record.
  const lookups: Array<Parameters<NonNullable<Parameters<typeof judgeEvidenceTools>[2]>>[0]> = [];
  const tools = judgeEvidenceTools(sourceEvidenceLookup(identity), 4, (lookup) => lookups.push(lookup)) as unknown as
    Array<{ name: string; invoke: (context: unknown, input: string) => Promise<unknown> }>;
  const query = tools.find((entry) => entry.name === 'query_evidence')!;
  const found = String(await query.invoke({ context: {} }, JSON.stringify({
    ref: 'list-month', where_field: 'subject', contains: 'picture day', fields: ['subject', 'start.dateTime'] })));
  assert.match(found, /1 of 94 records at data\.value match; showing 1 from offset 0 \(end\)/);
  assert.match(found, /"sourceIndex": 71/);
  const covered = assessReviewCoverage({ results: evidence.results, lookups, needsAllOf: ['list-month'] });
  assert.equal(covered.status, 'sufficient');
  assert.equal(covered.rows.find((row) => row.ref === 'list-month')?.inspection, 'queried');
});

test('a page that names a next page is not the whole answer, however completely it is shown', async () => {
  const { assessReviewCoverage } = await import('./review-evidence-coverage.js');
  const identity = accepted('Is there already an autumn event on the calendar?');
  retainedRead(identity, 'calendar_list_events', { value: [{ id: 'event-1', subject: 'Standing meeting' }], next_page_token: 'page-2-cursor' },
    false, false, false, { id: 'first-page', args: { month: '2026-10' } });
  retainedRead(identity, 'calendar_list_events', { value: [], next_page_token: null },
    false, false, false, { id: 'empty-complete', args: { month: '2026-11' } });
  events.closeEventLog();
  const evidence = sourceSettledReadEvidence({ ...identity, lookupBacked: true });
  const page = evidence.results.find((row) => row.logicalToolCallId === 'first-page')!;
  const empty = evidence.results.find((row) => row.logicalToolCallId === 'empty-complete')!;
  assert.equal(page.contentComplete, true, 'the page itself is shown whole');
  assert.equal(page.sourceExhausted, false, 'the source said there is more');
  assert.equal(empty.sourceExhausted, true);
  assert.equal(empty.recordCount, 0);
  const assessed = assessReviewCoverage({ results: evidence.results, needsAllOf: ['first-page', 'empty-complete'] });
  assert.deepEqual(assessed.unsupported.map((row) => row.ref), ['first-page']);
  assert.equal(assessed.rows.find((row) => row.ref === 'empty-complete')?.exhaustive, true,
    'an empty result from a source with nothing further is evidence of an empty result');
});
