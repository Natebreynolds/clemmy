/**
 * Run: npx tsx --test src/runtime/harness/settled-read-repeat.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRIOR_HOME = process.env.CLEMENTINE_HOME;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-settled-read-repeat-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_GUARDRAIL_PERSIST = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import test from 'node:test';
import assert from 'node:assert/strict';

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const {
  SETTLED_READ_REPEAT_REPLAY_KIND,
  acceptedSourceRequestsPolling,
  classifySettledDirectComposioRead,
  composioReadHasPollSemantics,
  formatSettledReadRepeatAdvisory,
  formatSettledReadSuccessAdvisory,
  resolveSettledReadForInfraRecovery,
  resolveSettledReadRepeat,
  settledReadRepeatEnabled,
  settledReadRepeatReplayDisposition,
  settledReadRepeatReplayMarker,
  stripSettledReadHarnessAdvisory,
} = await import('./settled-read-repeat.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_HOME;
});

const TOOL = 'composio_execute_tool';
const SLUG = 'PROOF_LIST_TASKS';

function readArgs(slug = SLUG, inner = '{}'): Record<string, unknown> {
  return { tool_slug: slug, arguments: inner, connected_account_id: null };
}

function settledOutput(revision = 2): string {
  return `${JSON.stringify({
    successful: true,
    data: {
      sourceMarker: 'PROOF_RELEASE_QUEUE:LOCAL_ONLY',
      revision,
      items: [{ id: 'proof-release-1', title: 'Review the release proof', status: 'done' }],
      count: 1,
    },
  }, null, 2)}\n\n[account-route] Read through the authenticated provider.`;
}

function freshSession(label: string): { sessionId: string; sourceUserSeq: number } {
  eventlog.resetEventLog();
  const sessionId = `settled-repeat-${label}`;
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Refresh the proof release queue now.' },
  });
  return { sessionId, sourceUserSeq: source.seq };
}

function startCall(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  runScopeId: string;
  args?: Record<string, unknown>;
  tool?: string;
  effect?: string;
  toolSlug?: string;
  argumentsValue?: unknown;
  attemptId?: string;
  turn?: number;
}) {
  const args = input.args ?? readArgs(input.toolSlug ?? SLUG);
  const tool = input.tool ?? TOOL;
  const slug = input.toolSlug ?? String(args.tool_slug ?? '');
  return eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn ?? 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: input.sourceUserSeq,
      runScopeId: input.runScopeId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      accounting: 'top_level',
      effect: input.effect ?? 'read',
      effectiveTool: slug,
      toolSlug: slug,
      arguments: input.argumentsValue ?? JSON.stringify(args),
    },
  });
}

function completeCall(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  runScopeId: string;
  called: ReturnType<typeof eventlog.appendEvent>;
  output: string;
  tool?: string;
  effect?: string;
  toolSlug?: string;
  invocationNonce?: string;
  attemptId?: string;
  turn?: number;
}) {
  const tool = input.tool ?? TOOL;
  const slug = input.toolSlug ?? SLUG;
  eventlog.writeToolOutput({
    sessionId: input.sessionId,
    callId: input.callId,
    invocationNonce: input.invocationNonce ?? `nonce-${input.callId}`,
    tool,
    output: input.output,
  });
  return eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn ?? 1,
    role: 'Clem',
    type: 'tool_returned',
    parentEventId: input.called.id,
    data: {
      sourceUserSeq: input.sourceUserSeq,
      runScopeId: input.runScopeId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      accounting: 'top_level',
      effect: input.effect ?? 'read',
      effectiveTool: slug,
      toolSlug: slug,
      result: input.output,
    },
  });
}

function completedRead(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  runScopeId: string;
  args?: Record<string, unknown>;
  output?: string;
  attemptId?: string;
  turn?: number;
}) {
  const called = startCall(input);
  const returned = completeCall({
    ...input,
    called,
    output: input.output ?? settledOutput(),
  });
  return { called, returned };
}

test('infra recovery returns the latest settled read only for its exact bound attempt', () => {
  eventlog.resetEventLog();
  const sessionId = 'settled-repeat-infra-recovery';
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(sessionId, { runId: 'infra-recovery' });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Refresh the proof release queue now.' },
  });
  const output = settledOutput(9);
  const turn = 2;
  completedRead({
    sessionId,
    sourceUserSeq: source.seq,
    callId: 'call-before-model-failure',
    runScopeId: `${sessionId}::turn:${turn}`,
    attemptId: attempt.attemptId,
    turn,
    output,
  });

  const resolved = resolveSettledReadForInfraRecovery({
    sessionId,
    sourceUserSeq: source.seq,
    runAttemptId: attempt.attemptId,
    failedTurn: turn,
  });
  assert.ok(resolved);
  assert.equal(resolved.sourceCallId, 'call-before-model-failure');
  assert.equal(resolved.toolSlug, SLUG);
  assert.equal(resolved.output, output, 'the durable provider bytes are reused exactly');

  assert.equal(resolveSettledReadForInfraRecovery({
    sessionId,
    sourceUserSeq: source.seq,
    runAttemptId: 'foreign-attempt',
    failedTurn: turn,
  }), null, 'a foreign or missing attempt cannot borrow the settled bytes');

  startCall({
    sessionId,
    sourceUserSeq: source.seq,
    callId: 'later-unsettled-call',
    runScopeId: `${sessionId}::turn:${turn}`,
    attemptId: attempt.attemptId,
    turn,
    tool: 'recall_tool_result',
    toolSlug: 'recall_tool_result',
    effect: 'read',
    args: { call_id: 'another-call' },
  });
  assert.equal(resolveSettledReadForInfraRecovery({
    sessionId,
    sourceUserSeq: source.seq,
    runAttemptId: attempt.attemptId,
    failedTurn: turn,
  }), null, 'an unfinished later canonical call remains the real recovery target');
});

test('infra recovery redeems one canonical non-mutating settlement without provider-name policy', () => {
  eventlog.resetEventLog();
  const sessionId = 'settled-repeat-canonical-provider-neutral';
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(sessionId, { runId: 'canonical-provider-neutral' });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Inspect the current generated inventory once.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn },
  }));

  const turn = 2;
  const callId = 'generated-carrier-call';
  const tool = 'qxv_inventory_probe';
  const args = { partition: 'current' };
  const output = {
    successful: true,
    data: { marker: 'GENERATED_PROVIDER_NEUTRAL_RESULT', records: [{ id: 'qxv-1' }] },
  };
  const called = startCall({
    sessionId,
    sourceUserSeq: source.seq,
    callId,
    runScopeId: `${sessionId}::source:${source.seq}`,
    attemptId: attempt.attemptId,
    turn,
    tool,
    toolSlug: tool,
    args,
    effect: 'read',
  });
  const acceptedTaskId = identities.acceptedTaskIdFor(sessionId, source.seq);
  const logicalToolCallId = 'logical:generated-provider-neutral';
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId,
      sourceUserSeq: source.seq,
      turn,
      acceptedTaskId,
      logicalToolCallId,
      physicalDispatchId: 'dispatch:generated-provider-neutral',
      ordinal: 0,
    },
    tool,
    args,
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({
    identity: { sessionId, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId },
    contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' },
    result: { payload: output },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'native_mcp', callId, turn },
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  completeCall({
    sessionId,
    sourceUserSeq: source.seq,
    callId,
    runScopeId: `${sessionId}::source:${source.seq}`,
    called,
    output: JSON.stringify(output),
    attemptId: attempt.attemptId,
    turn,
    tool,
    toolSlug: tool,
    effect: 'read',
  });

  const resolved = resolveSettledReadForInfraRecovery({
    sessionId,
    sourceUserSeq: source.seq,
    runAttemptId: attempt.attemptId,
    failedTurn: turn,
  });
  assert.ok(resolved);
  assert.equal(resolved.sourceCallId, callId);
  assert.equal(resolved.toolSlug, tool);
  assert.match(resolved.output, /GENERATED_PROVIDER_NEUTRAL_RESULT/);

  const writeTurn = 3;
  const writeCallId = 'generated-mutating-call';
  const writeTool = 'qxv_inventory_mutator';
  const writeArgs = { value: 'changed' };
  const writeCalled = startCall({
    sessionId,
    sourceUserSeq: source.seq,
    callId: writeCallId,
    runScopeId: `${sessionId}::source:${source.seq}`,
    attemptId: attempt.attemptId,
    turn: writeTurn,
    tool: writeTool,
    toolSlug: writeTool,
    args: writeArgs,
    effect: 'external_write',
  });
  const writeLogicalToolCallId = 'logical:generated-mutating';
  const writeBegun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId,
      sourceUserSeq: source.seq,
      turn: writeTurn,
      acceptedTaskId,
      logicalToolCallId: writeLogicalToolCallId,
      physicalDispatchId: 'dispatch:generated-mutating',
      ordinal: 0,
    },
    tool: writeTool,
    args: writeArgs,
  });
  assert.equal(writeBegun.status, 'inserted', JSON.stringify(writeBegun));
  if (writeBegun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: writeBegun.identity,
    tool: writeTool,
    outcome: 'returned',
  }).status, 'inserted');
  const writeOutput = { successful: true, data: { id: 'changed-qxv-1' } };
  assert.equal(settlements.commitLogicalCallSettlement({
    identity: {
      sessionId,
      sourceUserSeq: source.seq,
      acceptedTaskId,
      logicalToolCallId: writeLogicalToolCallId,
    },
    contract: { toolName: writeTool, args: writeArgs },
    execution: { kind: 'provider_execution' },
    result: { payload: writeOutput },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true, acknowledged: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'native_mcp', callId: writeCallId, turn: writeTurn },
  }).status, 'committed');
  completeCall({
    sessionId,
    sourceUserSeq: source.seq,
    callId: writeCallId,
    runScopeId: `${sessionId}::source:${source.seq}`,
    called: writeCalled,
    output: JSON.stringify(writeOutput),
    attemptId: attempt.attemptId,
    turn: writeTurn,
    tool: writeTool,
    toolSlug: writeTool,
    effect: 'external_write',
  });
  assert.equal(resolveSettledReadForInfraRecovery({
    sessionId,
    sourceUserSeq: source.seq,
    runAttemptId: attempt.attemptId,
    failedTurn: writeTurn,
  }), null, 'a successful write is never injected into automatic read recovery');
});

function resolveCurrent(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  runScopeId: string;
  args?: Record<string, unknown>;
}) {
  const args = input.args ?? readArgs();
  startCall({ ...input, args });
  return resolveSettledReadRepeat({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    currentCallId: input.callId,
    toolName: TOOL,
    args,
    currentBehaviorScopeId: input.runScopeId,
  });
}

test('same accepted source recovers one exact settled read across behavior-scope retry', () => {
  const { sessionId, sourceUserSeq } = freshSession('recovery');
  completedRead({ sessionId, sourceUserSeq, callId: 'call-source', runScopeId: `${sessionId}::turn:2` });

  const resolved = resolveCurrent({
    sessionId,
    sourceUserSeq,
    callId: 'call-retry',
    runScopeId: `${sessionId}::turn:3`,
  });

  assert.ok(resolved);
  assert.equal(resolved.sourceCallId, 'call-source');
  assert.equal(resolved.output, settledOutput());
  assert.equal(resolved.toolSlug, SLUG);
  assert.equal(resolved.sourceBehaviorScopeId, `${sessionId}::turn:2`);
  assert.equal(resolved.recoveredAcrossBehaviorScope, true);
});

test('same behavior scope resolves too, while a new accepted source or different args stays fresh', () => {
  const first = freshSession('identity');
  const scope = `${first.sessionId}::turn:1`;
  completedRead({ ...first, callId: 'call-source', runScopeId: scope });
  const same = resolveCurrent({ ...first, callId: 'call-same', runScopeId: scope });
  assert.ok(same);
  assert.equal(same.recoveredAcrossBehaviorScope, false);

  const nextSource = eventlog.appendEvent({
    sessionId: first.sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Refresh it again now.' },
  });
  assert.equal(resolveCurrent({
    sessionId: first.sessionId,
    sourceUserSeq: nextSource.seq,
    callId: 'call-new-source',
    runScopeId: `${first.sessionId}::turn:2`,
  }), null, 'a new accepted user source owns a genuinely fresh read');

  const second = freshSession('different-args');
  completedRead({ ...second, callId: 'call-page-1', runScopeId: `${second.sessionId}::turn:1` });
  assert.equal(resolveCurrent({
    ...second,
    callId: 'call-page-2',
    runScopeId: `${second.sessionId}::turn:1`,
    args: readArgs(SLUG, '{"page":2}'),
  }), null, 'pagination/different canonical arguments still dispatch');
});

test('intervening mutation or user steering invalidates the settled snapshot', () => {
  for (const variant of ['write', 'steer'] as const) {
    const { sessionId, sourceUserSeq } = freshSession(`invalidate-${variant}`);
    const scope = `${sessionId}::turn:1`;
    completedRead({ sessionId, sourceUserSeq, callId: 'call-source', runScopeId: scope });
    if (variant === 'write') {
      startCall({
        sessionId,
        sourceUserSeq,
        callId: 'call-write',
        runScopeId: scope,
        toolSlug: 'PROOFAPP_CREATE_RECORD',
        args: readArgs('PROOFAPP_CREATE_RECORD', '{"name":"changed"}'),
        effect: 'external_write',
      });
    } else {
      eventlog.appendEvent({
        sessionId,
        turn: 1,
        role: 'user',
        type: 'user_steer_note',
        data: { text: 'Check once more after the provider update.' },
      });
    }
    assert.equal(resolveCurrent({ sessionId, sourceUserSeq, callId: 'call-current', runScopeId: scope }), null);
  }
});

test('failed, async, poll-semantic, and non-Composio prior results never resolve', () => {
  const cases: Array<{
    label: string;
    slug?: string;
    tool?: string;
    output: string;
  }> = [
    { label: 'failure', output: 'ERROR: provider timeout' },
    {
      label: 'async-receipt',
      slug: 'SOMEAPP_LIST_THINGS',
      output: JSON.stringify({ successful: true, data: { id: 'job-1', status: 'running' } }),
    },
    {
      label: 'poll-slug',
      slug: 'FIRECRAWL_BATCH_STATUS',
      output: JSON.stringify({ successful: true, data: { status: 'completed', items: [{ id: 1 }] } }),
    },
    { label: 'carrier', tool: 'call_tool', output: settledOutput() },
  ];
  for (const row of cases) {
    const { sessionId, sourceUserSeq } = freshSession(row.label);
    const scope = `${sessionId}::turn:1`;
    const slug = row.slug ?? SLUG;
    const args = readArgs(slug);
    const called = startCall({
      sessionId,
      sourceUserSeq,
      callId: 'call-source',
      runScopeId: scope,
      args,
      tool: row.tool,
      toolSlug: slug,
    });
    completeCall({
      sessionId,
      sourceUserSeq,
      callId: 'call-source',
      runScopeId: scope,
      called,
      output: row.output,
      tool: row.tool,
      toolSlug: slug,
    });
    startCall({ sessionId, sourceUserSeq, callId: 'call-current', runScopeId: scope, args, toolSlug: slug });
    assert.equal(resolveSettledReadRepeat({
      sessionId,
      sourceUserSeq,
      currentCallId: 'call-current',
      toolName: TOOL,
      args,
      currentBehaviorScopeId: scope,
    }), null, row.label);
  }
});

test('a replay marker prevents replay-of-replay and keeps the original provider output authoritative', () => {
  const { sessionId, sourceUserSeq } = freshSession('marker');
  const sourceScope = `${sessionId}::turn:1`;
  const retryScope = `${sessionId}::turn:2`;
  completedRead({ sessionId, sourceUserSeq, callId: 'call-physical', runScopeId: sourceScope });

  const replayCalled = startCall({
    sessionId,
    sourceUserSeq,
    callId: 'call-replay',
    runScopeId: retryScope,
  });
  eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'guardrail_tripped',
    data: settledReadRepeatReplayMarker({
      replayCallId: 'call-replay',
      replayCalledEventId: replayCalled.id,
      sourceCallId: 'call-physical',
      sourceUserSeq,
      toolSlug: SLUG,
      sourceBehaviorScopeId: sourceScope,
      replayBehaviorScopeId: retryScope,
    }),
  });
  completeCall({
    sessionId,
    sourceUserSeq,
    callId: 'call-replay',
    runScopeId: retryScope,
    called: replayCalled,
    output: `${settledOutput()}\n\n[same-source read resolved once] replay`,
  });

  const resolved = resolveCurrent({
    sessionId,
    sourceUserSeq,
    callId: 'call-current',
    runScopeId: `${sessionId}::turn:3`,
  });
  assert.ok(resolved);
  assert.equal(resolved.sourceCallId, 'call-physical');
  assert.equal(resolved.output, settledOutput());
});

test('ambiguous lifecycle and clipped argument previews fail open', () => {
  const ambiguous = freshSession('ambiguous');
  const scope = `${ambiguous.sessionId}::turn:1`;
  for (const nonce of ['one', 'two']) {
    const called = startCall({ ...ambiguous, callId: 'call-reused', runScopeId: scope });
    completeCall({
      ...ambiguous,
      callId: 'call-reused',
      runScopeId: scope,
      called,
      output: settledOutput(),
      invocationNonce: nonce,
    });
  }
  assert.equal(resolveCurrent({ ...ambiguous, callId: 'call-current', runScopeId: scope }), null);

  const clipped = freshSession('clipped');
  const clippedScope = `${clipped.sessionId}::turn:1`;
  const called = startCall({
    ...clipped,
    callId: 'call-source',
    runScopeId: clippedScope,
    argumentsValue: '{"tool_slug":"PROOF_LIST_TASKS"…[+9000 chars]',
  });
  completeCall({
    ...clipped,
    callId: 'call-source',
    runScopeId: clippedScope,
    called,
    output: settledOutput(),
  });
  assert.equal(resolveCurrent({ ...clipped, callId: 'call-current', runScopeId: clippedScope }), null);
});

test('classifier, formatter, and replay marker stay narrow and actionable', () => {
  const settled = classifySettledDirectComposioRead({
    toolName: TOOL,
    args: readArgs(),
    output: settledOutput(),
  });
  assert.equal(settled?.toolSlug, SLUG);
  assert.equal(composioReadHasPollSemantics('FIRECRAWL_BATCH_STATUS'), true);
  assert.equal(composioReadHasPollSemantics(SLUG), false);
  assert.equal(classifySettledDirectComposioRead({
    toolName: TOOL,
    args: readArgs('OUTLOOK_SEND_EMAIL'),
    output: JSON.stringify({ successful: true, data: { id: 'message-1' } }),
  }), null);
  assert.equal(classifySettledDirectComposioRead({
    toolName: TOOL,
    args: readArgs('SOMEAPP_LIST_THINGS'),
    output: JSON.stringify({ successful: true, data: { id: 'job-1', status: 'pending' } }),
  }), null);

  const advisory = formatSettledReadRepeatAdvisory({
    toolSlug: SLUG,
    sourceCallId: 'call-source',
    recoveredAcrossBehaviorScope: true,
  });
  assert.match(advisory, /same accepted request/i);
  assert.match(advisory, /no provider call was repeated/i);
  assert.match(advisory, /call-source/);
  assert.match(advisory, /next step or answer naturally/i);
  assert.match(advisory, /^\[harness settled-read replay\]/);

  const successAdvisory = formatSettledReadSuccessAdvisory(SLUG);
  assert.match(successAdvisory, /^\[harness settled-read\]/);
  assert.match(successAdvisory, /next step or answer naturally/i);

  const priorFeature = process.env.CLEMMY_SETTLED_READ_REPEAT;
  const priorGuardrail = process.env.CLEMMY_TOOL_GUARDRAIL;
  try {
    delete process.env.CLEMMY_SETTLED_READ_REPEAT;
    process.env.CLEMMY_TOOL_GUARDRAIL = 'warn';
    assert.equal(settledReadRepeatEnabled(), true);
    process.env.CLEMMY_SETTLED_READ_REPEAT = 'off';
    assert.equal(settledReadRepeatEnabled(), false);
    process.env.CLEMMY_SETTLED_READ_REPEAT = 'on';
    process.env.CLEMMY_TOOL_GUARDRAIL = 'off';
    assert.equal(settledReadRepeatEnabled(), false);
  } finally {
    if (priorFeature === undefined) delete process.env.CLEMMY_SETTLED_READ_REPEAT;
    else process.env.CLEMMY_SETTLED_READ_REPEAT = priorFeature;
    if (priorGuardrail === undefined) delete process.env.CLEMMY_TOOL_GUARDRAIL;
    else process.env.CLEMMY_TOOL_GUARDRAIL = priorGuardrail;
  }

  const marker = settledReadRepeatReplayMarker({
    replayCallId: 'call-replay',
    replayCalledEventId: 'event-replay',
    sourceCallId: 'call-source',
    sourceUserSeq: 42,
    toolSlug: SLUG,
    sourceBehaviorScopeId: 'turn:1',
    replayBehaviorScopeId: 'turn:2',
  });
  assert.equal(marker.kind, SETTLED_READ_REPEAT_REPLAY_KIND);
  assert.equal(marker.replayCallId, 'call-replay');
  assert.equal(marker.replayCalledEventId, 'event-replay');
  assert.equal(
    stripSettledReadHarnessAdvisory(`provider bytes\n\n${formatSettledReadSuccessAdvisory(SLUG)}\n\n[next rail] keep going`),
    'provider bytes\n\n[next rail] keep going',
  );
});

test('source monitoring intent, task getters, and nested pending state stay on the live poll rail', () => {
  const { sessionId, sourceUserSeq } = freshSession('source-poll');
  eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Monitor the export until it finishes.' },
  });
  const pollSource = eventlog.listEvents(sessionId, { types: ['user_input_received'] }).at(-1)!;
  assert.equal(acceptedSourceRequestsPolling(sessionId, sourceUserSeq), false);
  assert.equal(acceptedSourceRequestsPolling(sessionId, pollSource.seq), true);
  const multiSource = eventlog.appendEvent({
    sessionId,
    turn: 3,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Run it twice and compare the two independent samples.' },
  });
  assert.equal(acceptedSourceRequestsPolling(sessionId, multiSource.seq), true);
  const checkAgainSource = eventlog.appendEvent({
    sessionId,
    turn: 4,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Check the export now, then check it again.' },
  });
  assert.equal(acceptedSourceRequestsPolling(sessionId, checkAgainSource.seq), true);
  assert.equal(composioReadHasPollSemantics('DATAFORSEO_SERP_TASK_GET'), true);
  assert.equal(classifySettledDirectComposioRead({
    toolName: TOOL,
    args: readArgs('OPENAI_CREATE_CHAT_COMPLETION'),
    output: JSON.stringify({ successful: true, data: { choices: [{ text: 'variant one' }] } }),
  }), null, 'generative compute is not a replayable snapshot read');
  assert.equal(classifySettledDirectComposioRead({
    toolName: TOOL,
    args: readArgs('SOMEAPP_LIST_THINGS'),
    output: JSON.stringify({
      successful: true,
      data: { items: [{ id: 'job-1', lifecycle: { status: 'processing' } }] },
    }),
  }), null);
});

test('hook replay disposition resolves exactly one durable sidecar marker', () => {
  const { sessionId, sourceUserSeq } = freshSession('disposition');
  const replayCalled = startCall({
    sessionId,
    sourceUserSeq,
    callId: 'call-replay',
    runScopeId: 'turn:2',
  });
  const replayCalledEventId = replayCalled.id;
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'guardrail_tripped',
    data: settledReadRepeatReplayMarker({
      replayCallId: 'call-replay',
      replayCalledEventId,
      sourceCallId: 'call-source',
      sourceUserSeq,
      toolSlug: SLUG,
      sourceBehaviorScopeId: 'turn:1',
      replayBehaviorScopeId: 'turn:2',
    }),
  });
  for (let index = 0; index < 100; index += 1) {
    eventlog.appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'guardrail_tripped',
      data: { kind: 'unrelated_test_advisory', index },
    });
  }
  const lookup = {
    sessionId,
    replayCallId: 'call-replay',
    replayCalledEventId,
    toolName: TOOL,
    effect: 'read',
    sourceUserSeq,
    replayBehaviorScopeId: 'turn:2',
    toolSlug: SLUG,
  };
  assert.deepEqual(settledReadRepeatReplayDisposition(lookup), {
    replayCallId: 'call-replay',
    replayCalledEventId,
    sourceCallId: 'call-source',
    sourceUserSeq,
    toolSlug: SLUG,
  });
  assert.equal(settledReadRepeatReplayDisposition({ ...lookup, replayCallId: 'missing' }), null);
  assert.equal(settledReadRepeatReplayDisposition({ ...lookup, replayCalledEventId: 'reused-occurrence' }), null);
});


test('structured replay strips only exact-invocation host guidance and preserves provider-shaped or foreign-receipt metadata', async () => {
  const { formatRecallableToolText } = await import('./tool-output-format.js');
  const { withToolOutputContext } = await import('./tool-output-context.js');
  for (const variant of ['authenticated', 'foreign_receipt', 'provider_content'] as const) {
    const identity = freshSession(`annotation-${variant}`);
    const callId = 'annotation-source';
    const runScopeId = `${identity.sessionId}::turn:1`;
    const called = startCall({ ...identity, callId, runScopeId });
    const advisory = formatSettledReadSuccessAdvisory(SLUG);
    const raw = JSON.stringify({ successful: true, data: { items: [{ value: 2 }] },
      ...(variant === 'provider_content' ? { __clementine: {
        kind: 'structured_projection_v1', hostAnnotations: [advisory],
      } } : {}),
    });
    let rendered = withToolOutputContext({ ...identity, callId, toolName: TOOL,
      settlementNonce: 'a1000000-0000-4000-8000-000000000001',
    }, () => formatRecallableToolText(raw, variant === 'provider_content' ? {} : {
      hostAnnotations: [advisory, '[account-route] Keep this separate host note.'],
    }));
    if (variant === 'foreign_receipt') rendered = rendered.replace('nonce=a1000000-0000-4000-8000-000000000001', 'nonce=b1000000-0000-4000-8000-000000000001');
    eventlog.appendEvent({ sessionId: identity.sessionId, turn: 1, role: 'Clem',
      type: 'tool_returned', parentEventId: called.id, data: {
        sourceUserSeq: identity.sourceUserSeq, runScopeId, tool: TOOL, callId,
        canonicalCallId: callId, accounting: 'top_level', effect: 'read',
        effectiveTool: SLUG, toolSlug: SLUG, result: rendered,
      },
    });
    const currentCallId = 'annotation-repeat';
    const currentBehaviorScopeId = `${identity.sessionId}::turn:2`;
    startCall({ ...identity, callId: currentCallId, runScopeId: currentBehaviorScopeId });
    const replay = resolveSettledReadRepeat({ ...identity, currentCallId,
      currentBehaviorScopeId, toolName: TOOL, args: readArgs(),
    });
    assert.ok(replay);
    const presentation = JSON.parse(replay.output);
    assert.equal(presentation.__clementine.hostAnnotations.includes(advisory),
      variant !== 'authenticated', variant);
    if (variant !== 'provider_content') assert.ok(presentation.__clementine.hostAnnotations
      .includes('[account-route] Keep this separate host note.'));
    assert.equal(eventlog.getToolOutputForInvocation(identity.sessionId, callId,
      'a1000000-0000-4000-8000-000000000001')!.output, raw, 'replay never rewrites original provider evidence');
  }
});
