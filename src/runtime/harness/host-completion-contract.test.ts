import assert from 'node:assert/strict';
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
const { sourceAttemptedCompletionWork, sourceSettledReadEvidence } = await import('./host-completion-work.js');
const { shouldRunObjectiveJudge, buildObjectiveJudgePrompt, JUDGE_SYSTEM_PROMPT,
  completionJudgeContextAdmission, runRoutedJudgeAttempt, parseCompletionVerdict } = await import('./objective-judge.js');
const { recordCatalogWindow } = await import('./model-window-observations.js');
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
function accepted(text = request) {
  const session = events.createSession({ id: `completion-contract-${++serial}`, kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}
function attempted(identity: ReturnType<typeof accepted>, tool = 'tool_search') {
  events.appendEvent({ ...identity, role: 'Clem', type: 'tool_called', data: {
    sourceUserSeq: identity.sourceUserSeq, tool, accounting: 'top_level', callId: `attempt-${serial}`,
  } });
}
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
function retainedRead(identity: ReturnType<typeof accepted>, name: string, payload: unknown, mutating = false, hostOwned = false) {
  const task = { ...identity, acceptedTaskId: identities.acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq) };
  if (!hostOwned) assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const logicalToolCallId = `read:${name}`;
  const begin = () => dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId, physicalDispatchId: `dispatch:${name}`, ordinal: 0 },
    tool: name, args: {}, executionSite: 'host',
  });
  const opened = hostOwned ? (() => {
    const root = callAuthority.acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
    assert.equal(root.status, 'ok');
    if (root.status !== 'ok') throw new Error(root.reason);
    const contract = durableLogicalCallContract(task.acceptedTaskId, name, {})!;
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
    contract: { toolName: name, args: {} }, execution: { kind: 'local_execution' },
    result: { payload }, outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating }, observer: { lane: 'byo', turn: identity.turn } });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed') throw new Error('Fixture settlement did not commit');
  assert.ok(committed.settlement.resultHandleId);
  return committed.settlement.resultHandleId;
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
  assert.ok(evidence.summary.includes(text));
  assert.ok(!evidence.summary.includes('UNRELATED_RESULT_MUST_NOT_LEAK'));
  let prompt = '';
  await judgeWorkflowTarget({ workflow: { name: 'target-proof', description: 'Create the report.' }, inputs: {},
    finalOutput: JSON.stringify({ file }), executionEvidence: () => readWorkflowTargetEvidence(runId),
    judgeFn: async (objective, response, context) => {
      prompt = buildObjectiveJudgePrompt(objective, response, context);
      return { done: true, reason: 'Report saved with the requested framework.' };
    } });
  assert.ok(prompt.includes(text));
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

test('an unrelated accepted source and check-in alone do not make ordinary chat eligible', () => {
  const identity = accepted('Hello');
  attempted({ ...identity, sourceUserSeq: identity.sourceUserSeq + 100 }, 'tool_search');
  attempted(identity, 'check_in');
  assert.equal(sourceAttemptedCompletionWork(identity), false);
  assert.equal(eligible(false), false);
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

test('large metadata and later data both retain every byte without an arbitrary projection budget', () => {
  const identity = accepted();
  retainedRead(identity, 'large_actor_metadata', { description: 'x'.repeat(240_000) });
  retainedRead(identity, 'posts_read', { data: { items: [{ text: 'VISIBLE_POST_EVIDENCE' }] }, meta: { complete: true } });
  const evidence = sourceSettledReadEvidence(identity);
  assert.equal(evidence.results[0]?.contentComplete, true);
  assert.equal(evidence.results[1]?.contentComplete, true);
  assert.ok(evidence.results.reduce((n, r) => n + (r.shownByteCount ?? 0), 0) > 240_000);
  assert.doesNotMatch(evidence.summary, /PARTIAL VIEW|middle bytes omitted/);
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

test('reviewed text loses only its JSON transport encoding, including literal escapes and middle records', () => {
  const identity = accepted('Review every line of the retained text.');
  const text = Array.from({ length: 500 }, (_, i) => `Record ${i}: "quoted" \\literal\\n — café 🧡`).join('\n');
  const handle = retainedRead(identity, 'read_file', text);
  events.closeEventLog();
  const evidence = sourceSettledReadEvidence(identity);
  assert.ok(evidence.summary.includes(text), 'every character from the original string must be present');
  assert.equal(evidence.results[0]?.resultHandleId, handle);
  assert.equal(evidence.results[0]?.presentation, 'decoded_text');
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
  assert.equal(evidence.results.find((row) => row.toolName === 'apify_get_dataset_items')?.evidenceKind, 'source_result');
  assert.ok(evidence.results.every((row) => row.contentComplete));
  assert.ok((evidence.results.find((row) => row.toolName === 'apify_get_dataset_items')?.shownByteCount ?? 0) > 240_000);
  const longReply = 'Report preface '.repeat(900) + '\nLikes, shares, comments, and view counts came back empty from Apify.\n' + 'Report ending '.repeat(600);
  const fullSkill = 'Shared reporting framework '.repeat(300) + 'KEEP_THE_FULL_SKILL_TAIL';
  const prompt = buildObjectiveJudgePrompt(request, longReply, { fullSourceEvidence: true,
    skills: [{ name: 'reporting', body: fullSkill }], toolCallSummary: evidence.summary });
  assert.ok(prompt.includes(longReply), 'the claim being checked is not clipped either');
  assert.ok(prompt.includes(fullSkill), 'complete skill context participates in the actual budget');
  const admission = completionJudgeContextAdmission('claude-opus-5', JUDGE_SYSTEM_PROMPT, prompt);
  assert.equal(admission.fits, true, JSON.stringify(admission));
  assert.ok(admission.estimatedInputTokens > 60_000);
  let calls = 0;
  const model = {
    async getResponse(modelRequest: unknown) {
      calls += 1;
      const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
        : Array.isArray(value) ? value.flatMap(strings)
          : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
      const input = strings(modelRequest).join('\n');
      for (const post of posts) assert.ok(input.includes(JSON.stringify(post)), `entire post ${post.postId} reached the model`);
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

async function runHost(options: { captured: boolean; incoming: boolean; text?: string; work?: boolean; reply?: string; abortAtJudge?: boolean; policyData?: Record<string, unknown>; readResult?: unknown; afterCapture?: () => void }) {
  const identity = accepted(options.text);
  if (options.policyData) {
    events.appendEvent({ sessionId: identity.sessionId, turn: 0, role: 'system', type: 'completion_policy_captured',
      data: { ...options.policyData, sourceUserSeq: identity.sourceUserSeq } });
  } else host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: options.captured });
  options.afterCapture?.();
  if (options.work !== false) attempted(identity);
  const signal = new AbortController();
  const judged: Array<{ objective: string; reply: string; evidence?: string; selection?: import('./debate-model.js').CapturedBoundaryJudgeSelection }> = [];
  host._setHostObjectiveJudgeForTests(async (objective, reply, context) => {
    judged.push({ objective, reply, evidence: context?.toolCallSummary, selection: context?.boundaryJudgeSelection });
    if (options.abortAtJudge) signal.abort();
    return judged.length === 1
      ? { done: false, reason: 'Actor discovery does not contain the requested post findings.' }
      : { done: true, reason: 'The bounded lookup returned no accessible posts, accurately reported.' };
  });
  let calls = 0;
  const model = {
    async getResponse() {
      calls += 1;
      if (calls === 1 && options.readResult !== undefined) {
        retainedRead(identity, 'read_file', options.readResult, false, true);
      }
      const text = options.reply ?? (calls === 1 ? promise : 'The lookup returned no accessible posts. No report data was changed.');
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
  assert.equal(result.judged.length, 2);
  assert.equal(result.judged[0]?.objective, request);
  assert.equal(result.judged[0]?.reply, promise);
  assert.match(result.judged[0]?.evidence ?? '', /Retained READ results for THIS accepted source/);
  assert.doesNotMatch(result.judged[0]?.evidence ?? '', /Session tool-call counts/);
  const verdicts = events.listEvents(result.identity.sessionId, { types: ['goal_alignment_judged'] });
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts[0]?.data.continuation, true);
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
      assert.ok(review.evidence?.includes(JSON.stringify(payload)), 'every record reaches the real host judge boundary');
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
  assert.equal(result.judged.length, 2);
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
    assert.equal(result.judged.length, 2);
    for (const attempt of result.judged) assert.deepEqual(attempt.selection, read.policy.judgeSelection);
    assert.equal(read.policy.judgeModelId, 'claude-opus-5');
  } finally {
    if (original === undefined) delete process.env.CLEMMY_MODEL_ROLES;
    else process.env.CLEMMY_MODEL_ROLES = original;
  }
});
