/**
 * Run: npx tsx --test src/runtime/harness/loop.test.ts
 *
 * Contracts the harness loop must keep:
 *   - completed run snapshots history + lastResponseId on the session
 *     and emits run_completed
 *   - kill switch set before the call short-circuits and emits
 *     kill_requested + cancelled status
 *   - ToolCallsLimitExceeded raised by the bracket bubbles up as
 *     a guardrail_tripped event + limit_exceeded status
 *   - interruption (approval pause) saves serialized RunState to the
 *     session and returns awaiting_approval
 *   - generic run error emits run_failed and marks the session failed
 *   - turn number increments across calls
 *   - previousResponseId is passed back into opts on the next turn
 *
 * No real Runner is constructed for these tests; we inject makeRunner
 * (returns a Node EventEmitter stub) and runRunner (synthesizes a
 * RunOutcome). That keeps the loop test fast and offline.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-loop-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.COMPOSIO_BACKEND = 'sdk';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
mkdirSync(path.join(TMP_HOME, 'vault', '02-Projects'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'vault', '02-Projects', 'salesforce-prospecting.md'),
  [
    '# Salesforce prospecting',
    '',
    'User has durable Salesforce prospecting context: prioritize stale untouched accounts, use Salesforce CLI data first, enrich with SEO signals, and draft careful outbound sequences only after reviewing the source account facts.',
  ].join('\n'),
  'utf-8',
);

// v0.5.19 F4 — the new default behavior on stall-retry exhaustion is
// to convert into a synthetic `ask_user_question` (status flips to
// 'awaiting_user_input'). The existing tests in this file exercise
// the LEGACY terminate-on-stall path (`sub_agent_stalled` reason,
// status='completed') which is still supported via the revert flag.
// Set the flag here so the legacy assertions remain valid AND set
// MAX_STALL_RETRIES=1 (the pre-v0.5.19 default) so the retry-count
// tests stay accurate. End-to-end coverage of the NEW default lives
// in scripts/verify-long-running.mjs → stall-converts-to-question.
process.env.HARNESS_STALL_ASK_USER = 'off';
process.env.HARNESS_MAX_STALL_RETRIES = '1';
// Determinism: cross-family judging is now DEFAULT ON (2026-07-13), but this
// suite tests delivery/completion mechanics, NOT judge routing. On a dev machine
// with Claude Code logged in, judge availability falls back to ~/.claude creds
// (NOT isolated by CLEMENTINE_HOME), so a cross-family judge would resolve LIVE
// and make a real, nondeterministic call. Pin =off for a deterministic same-family
// judge. Cross-family routing is covered in boundary-judge.test.ts.
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
// This suite drives the loop with SCRIPTED runners that simulate tool calls by
// emitting agent_tool_start events (no real wrapped-tool invoke). Tool-call
// counting for those simulated calls comes from the loop's event-based fallback
// counter, which only registers when tool-brackets are OFF (when ON, the wrapped
// tool owns the counter — see loop.ts:1938). Brackets are now default-ON in
// production (24/7 keystone); pin them OFF here so the simulated-tool stall/judge
// tests keep counting. Brackets-ON behavior is covered by brackets.test.ts.
process.env.HARNESS_TOOL_BRACKETS = 'off';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent, RunContext, RunState, type AgentInputItem, type Runner } from '@openai/agents';

const {
  resetEventLog,
  requestKill,
  listEvents,
  createSession,
  appendEvent,
  openEventLog,
  writeToolOutput,
  beginRunAttempt,
  finishRunAttempt,
} = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runTurn, runConversation, resumePendingApproval, runConversationFromResume, isCodexAuthRevoked, normalizeError, buildStallRetryMessage, goalObjectiveString, toOrchestratorDecision, recordOrphanedToolInFlight, claimOrphanedToolCompletions, drainOrphanedToolCompletions, recipientGroundingNote, _testOnly_strictStructuredNoToolResultText } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;
const { BoundaryError } = await import('../boundary-error.js');
const { ToolCallsLimitExceeded, harnessRunContextStorage, wrapToolForHarness } = await import('./brackets.js');
const { listEvents: listEventsForConv } = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const { getPlanScope } = await import('../../agents/plan-scope.js');
const { rememberFact } = await import('../../memory/facts.js');
const { recordStepResult, takeStepResult, clearStepResult } = await import('../../tools/step-result-tool.js');
const artifactLedger = await import('./artifact-ledger.js');
const { getPendingAction, pendingActionPayloadHash, queuePendingAction } = await import('./pending-actions.js');
const { pendingActionApprovalView } = await import('./pending-action-view.js');
const { executeApprovedPendingActionCall } = await import('../../execution/pending-action-executor.js');
const { toolCallCorrelationFingerprint } = await import('./tool-correlation.js');
const { workingMemoryPathForSession } = await import('../../memory/working-memory.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('./public-presentation.js');
const { buildCallTool } = await import('../../tools/call-tool.js');

function seedArtifactVerification(sessionId: string, callId: string, resourceId: string): void {
  const called = appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_called',
    data: { callId, tool: 'fixture_provider_get', effect: 'read' },
  });
  writeToolOutput({
    sessionId,
    callId,
    invocationNonce: `nonce-${callId}`,
    tool: 'fixture_provider_get',
    output: JSON.stringify({ resource: { id: resourceId } }),
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: { callId, tool: 'fixture_provider_get', effect: 'read', result: 'stored separately' },
  });
}
const { _setCodeModeToolsForTests } = await import('../../tools/code-mode-tool.js');

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Returns a Node EventEmitter cast to Runner. The loop only uses its
// on/off shape, so this stands in for a real Runner.
function makeRunnerStub(): Runner {
  const ee = new EventEmitter();
  return ee as unknown as Runner;
}

// A minimal Agent stub. The loop never inspects its internals; only
// the runRunner sees the agent.
function makeAgentStub(): import('@openai/agents').Agent<any, any> {
  return {} as import('@openai/agents').Agent<any, any>;
}

function makeApprovalRunState(agent: import('@openai/agents').Agent<any, any>, toolName: string): string {
  return makeApprovalRunStateWithInterruptions(agent, [
    { toolName, argumentsJson: '{}', callId: `${toolName}_call` },
  ]);
}

function makeApprovalRunStateWithInterruptions(
  agent: import('@openai/agents').Agent<any, any>,
  interruptions: Array<{ toolName: string; argumentsJson?: string; callId?: string }>,
): string {
  const state = new RunState(new RunContext({}), 'approve this', agent, null);
  const json = state.toJSON() as Record<string, unknown>;
  json.currentStep = {
    type: 'next_step_interruption',
    data: {
      interruptions: interruptions.map((interruption, index) => ({
        rawItem: {
          type: 'function_call',
          name: interruption.toolName,
          callId: interruption.callId ?? `${interruption.toolName}_call_${index}`,
          arguments: interruption.argumentsJson ?? '{}',
        },
        toolName: interruption.toolName,
      })),
    },
  };
  return JSON.stringify(json);
}

test('fresh and approval-resume runs return unknown tools to the model with deferred-dispatch guidance', async () => {
  resetEventLog();
  const fresh = HarnessSession.create({ kind: 'chat' });
  let freshOpts: Record<string, unknown> | null = null;
  await runTurn({
    agent: makeAgentStub(),
    sessionId: fresh.id,
    input: 'Use the deferred file writer.',
    makeRunner: makeRunnerStub,
    runRunner: async (_runner, _agent, items, opts) => {
      freshOpts = opts;
      return { history: items, lastResponseId: undefined, finalOutput: 'Done.' };
    },
  });

  const agent = new Agent({ name: 'ResumeToolRecovery', instructions: 'test' });
  const resumed = HarnessSession.create({ kind: 'chat' });
  resumed.saveInterruptState(makeApprovalRunState(agent, 'approved_tool'));
  approvalRegistry.register({
    sessionId: resumed.id,
    subject: 'approve exact tool recovery',
    tool: 'approved_tool',
    args: {},
  });
  let resumeOpts: Record<string, unknown> | null = null;
  await resumePendingApproval({
    agent,
    sessionId: resumed.id,
    decision: 'approve',
    makeRunner: makeRunnerStub,
    runRunner: async (_runner, _agent, items, opts) => {
      resumeOpts = opts;
      return { history: items, lastResponseId: undefined, finalOutput: { ok: true } };
    },
  });

  for (const [lane, opts] of [['fresh', freshOpts], ['resume', resumeOpts]] as const) {
    assert.equal(opts?.toolNotFoundBehavior, 'return_error_to_model', `${lane} run must stay alive`);
    const formatter = opts?.toolErrorFormatter as ((input: Record<string, unknown>) => unknown) | undefined;
    assert.equal(typeof formatter, 'function', `${lane} run carries actionable recovery guidance`);
    const message = String(await formatter?.({
      kind: 'tool_not_found',
      toolType: 'function',
      toolName: 'write_file',
      callId: 'missing-1',
      defaultMessage: "Tool 'write_file' not found.",
    }));
    assert.match(message, /tool_search/);
    assert.match(message, /call_tool/);
    assert.match(message, /do not retry .* directly/i);
  }
});

const COMPLEX_INPUT =
  'Pull my unread Outlook emails and the open Salesforce leads, then update each Airtable contact record and draft outreach for the warm ones';

test('buildStallRetryMessage: after a draft-only-skill block, steers to PRESENT the drafts — NOT "call a tool, no text"', () => {
  // Fix 4(b): the false stall-nudge gagged the model exactly when it should
  // present the drafts. After a present-for-approval refusal, the nudge must
  // tell it to reply with the drafts, not forbid text.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_returned',
    data: { tool: 'composio_execute_tool', result: 'Tool call refused by harness: GOAL_FIDELITY_CHECK_FAILED: ... PRESENT the drafted item(s) to the user as your reply now ... then ask "Good to send?"' },
  });
  const msg = buildStallRetryMessage(sess.id, { signal: 'A_zero_tools', userVisibleMessage: '', detail: {} } as never);
  assert.match(msg, /Reply to the user NOW with the drafted/i);
  assert.doesNotMatch(msg, /do not emit any text/i);
});

test('buildStallRetryMessage: a normal stall (no draft-only block) still demands a tool call', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const msg = buildStallRetryMessage(sess.id, { signal: 'A_zero_tools', userVisibleMessage: '', detail: {} } as never);
  assert.match(msg, /call a tool/i);
});

test('W1a characterization: a transient model error with NO fallover factory surfaces the infra-recovery ask (today behavior)', async () => {
  // Pins the EXACT current behavior that the chat step-boundary fallover must
  // preserve when fallover does NOT apply (no rebuildAgentForBrain provided):
  // a transient BoundaryError → awaiting_user_input, source 'infra_error_recovery',
  // session stays active (not failed).
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    throw BoundaryError.from(new Error('backend 529 overloaded'), {
      kind: 'model.overloaded', retryable: true, userMessage: 'The model backend hit a transient error (overloaded).',
    });
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do a thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'transient error surfaces the ask when fallover does not apply');
  const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.ok(
    asks.some((e) => (e.data as { source?: string } | undefined)?.source === 'infra_error_recovery'),
    'the ask is tagged infra_error_recovery',
  );
  assert.notEqual(sess.status, 'failed', 'session stays recoverable, not failed');
});

test('infra retry context selects the canonical native MCP call, not its later sparse mirror', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let attempt = 0;
  const runRunner: RunRunnerFn = async () => {
    attempt += 1;
    const canonicalId = `toolu-retry-${attempt}`;
    appendEvent({
      sessionId: sess.id,
      turn: attempt,
      role: 'Clem',
      type: 'tool_called',
      data: { tool: 'composio_execute_tool', callId: canonicalId, accounting: 'top_level', arguments: JSON.stringify({ tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: { to: 'firm@example.com' } }) },
    });
    // More than the old bounded tail: recovery must query past any volume of
    // later raw transport mirrors rather than silently losing canonical args.
    for (let mirrorIndex = 0; mirrorIndex < 520; mirrorIndex += 1) {
      appendEvent({
        sessionId: sess.id,
        turn: attempt,
        role: 'Clem',
        type: 'tool_called',
        data: { tool: 'composio_execute_tool', callId: `mcp-retry-${attempt}-${mirrorIndex}`, accounting: 'transport_mirror', args: { tool_slug: 'OUTLOOK_SEND_EMAIL' } },
      });
    }
    throw BoundaryError.from(new Error('backend 529 overloaded'), {
      kind: 'model.overloaded', retryable: true, userMessage: 'The model backend hit a transient error.',
    });
  };

  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'send the approved email',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const ask = listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).at(-1);
  const retry = ask?.data.retry_context as Record<string, unknown> | undefined;
  assert.equal(retry?.failed_call_id, `toolu-retry-${attempt}`);
  assert.match(String(retry?.failed_args ?? ''), /firm@example\.com/);
});

test('W1a: a transient error falls over to the next brain and completes (no ask)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const agentFor = (id: string) => ({ __brain: id }) as unknown as import('@openai/agents').Agent<any, any>;
  const rebuilt: string[] = [];
  const runRunner: RunRunnerFn = async (_runner, agent, items) => {
    if ((agent as { __brain?: string }).__brain !== 'brain-2') {
      throw BoundaryError.from(new Error('backend 529'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
    }
    return { history: items, lastResponseId: undefined, finalOutput: { summary: 'done on brain 2', reply: 'Answer from brain 2', done: true, nextAction: 'completed', reason: null } } as never;
  };
  const result = await runConversation({
    agent: agentFor('brain-1'),
    sessionId: sess.id,
    input: 'do a thing',
    makeRunner: makeRunnerStub,
    runRunner,
    falloverModelIds: ['brain-2'],
    rebuildAgentForBrain: async (id) => { rebuilt.push(id); return agentFor(id); },
  });
  assert.equal(result.status, 'completed', 'completes on the fallover brain');
  assert.deepEqual(rebuilt, ['brain-2'], 'rebuilt the agent once on the next brain');
  assert.equal(listEventsForConv(sess.id, { types: ['brain_fallover'] }).length, 1, 'one brain_fallover advisory');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'no ask when fallover succeeds');
});

test('runConversation refreshes working memory after the terminal reply is durable', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'Terminal WM test' });
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: items,
    lastResponseId: undefined,
    finalOutput: {
      summary: 'WM terminal summary',
      reply: 'WM-TERMINAL-REPLY is now durable.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  } as never);

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Remember WM-TERMINAL-USER in this turn.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const snapshot = readFileSync(workingMemoryPathForSession(sess.id), 'utf-8');
  assert.match(snapshot, /WM-TERMINAL-USER/);
  assert.match(snapshot, /WM-TERMINAL-REPLY/, 'writeback includes the current assistant reply, not a one-turn-late snapshot');
});

test('W1a: when every brain hits the transient error, fall through to the infra-recovery ask', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const agentFor = (id: string) => ({ __brain: id }) as unknown as import('@openai/agents').Agent<any, any>;
  const runRunner: RunRunnerFn = async () => {
    throw BoundaryError.from(new Error('backend 529'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
  };
  const result = await runConversation({
    agent: agentFor('brain-1'),
    sessionId: sess.id,
    input: 'do a thing',
    makeRunner: makeRunnerStub,
    runRunner,
    falloverModelIds: ['brain-2', 'brain-3'],
    rebuildAgentForBrain: async (id) => agentFor(id),
  });
  assert.equal(result.status, 'awaiting_user_input', 'exhausted brains → ask the user');
  assert.equal(listEventsForConv(sess.id, { types: ['brain_fallover'] }).length, 2, 'tried both fallover brains once each');
  const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.ok(asks.some((e) => (e.data as { source?: string } | undefined)?.source === 'infra_error_recovery'), 'emits the same infra ask on exhaustion');
  const accepted = listEventsForConv(sess.id, { types: ['user_input_received'] })[0];
  assert.equal(result.publicPresentation?.kind, 'question');
  assert.equal(result.publicPresentation?.status, 'needs_input');
  assert.equal(result.publicPresentation?.identity.sourceUserSeq, accepted.seq);
  assert.equal(result.publicPresentation?.identity.turn, accepted.turn, 'the public terminal belongs to the accepted request, not the final fallover attempt');
  const terminals = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, 'fallover exhaustion settles the accepted request exactly once');
  assert.equal((terminals[0].data.presentation as { kind?: string }).kind, 'question');
});

// ─── Unattended infra self-heal (workflow/background) ──────────────────────
test('unattended self-heal: a transient infra error auto-retries and recovers (no awaiting_user_input)', async () => {
  resetEventLog();
  // A background run session (id prefix is the unattended signal).
  const sess = HarnessSession.create({ id: 'background:auto-recover-ok', kind: 'execution' });
  let calls = 0;
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    calls += 1;
    if (calls === 1) {
      throw BoundaryError.from(new Error('backend 529'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
    }
    return { history: items, lastResponseId: undefined, finalOutput: { summary: 'recovered', reply: 'Done after the auto-retry', done: true, nextAction: 'completed', reason: null } } as never;
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'run the enrichment step',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed', 'the run self-healed and completed');
  assert.equal(listEventsForConv(sess.id, { types: ['infra_auto_recover'] }).length, 1, 'the self-heal is visible in the trace');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'never asked an absent human');
});

test('unattended self-heal: a persistent infra error auto-retries twice then FAILS honestly (never asks, never fakes success)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ id: 'workflow:sched-x:enrich_missing_seo_once', kind: 'workflow' });
  const runRunner: RunRunnerFn = async () => {
    throw BoundaryError.from(new Error('backend 529 persistent'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'enrich missing seo',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'failed', 'exhausted budget → the run fails honestly');
  assert.equal(listEventsForConv(sess.id, { types: ['infra_auto_recover'] }).length, 2, 'exactly two bounded auto-retries');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'never wrote an awaiting_user_input');
  const failed = listEventsForConv(sess.id, { types: ['run_failed'] });
  assert.ok(failed.some((e) => (e.data as { reason?: string }).reason === 'infra_transient_unrecovered'), 'fails with the infra error named, not fake success');
});

test('attended quiet retry: a transient blip retries ONCE silently, THEN asks on the second failure', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let calls = 0;
  const runRunner: RunRunnerFn = async () => {
    calls += 1;
    throw BoundaryError.from(new Error('backend 529'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do a thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  // First failure → ONE silent retry (no ask); second failure → the ask.
  assert.equal(listEventsForConv(sess.id, { types: ['infra_auto_recover'] }).length, 1, 'exactly one silent quiet-retry');
  assert.equal(calls, 2, 'the turn was retried once before asking');
  assert.equal(result.status, 'awaiting_user_input', 'a human IS present — ask after the quiet retry fails');
  assert.ok(
    listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).some((e) => (e.data as { source?: string }).source === 'infra_error_recovery'),
    'the infra ask still fires (byte-identical) on the second failure',
  );
});

test('unattended self-heal: CLEMMY_UNATTENDED_AUTO_RECOVER=off restores the ask even in a background run', async () => {
  resetEventLog();
  const prev = process.env.CLEMMY_UNATTENDED_AUTO_RECOVER;
  process.env.CLEMMY_UNATTENDED_AUTO_RECOVER = 'off';
  try {
    const sess = HarnessSession.create({ id: 'background:killswitch-off', kind: 'execution' });
    const runRunner: RunRunnerFn = async () => {
      throw BoundaryError.from(new Error('backend 529'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
    };
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'run the step',
      makeRunner: makeRunnerStub,
      runRunner,
    });
    assert.equal(result.status, 'awaiting_user_input', 'kill-switch off ⇒ legacy ask behavior');
    assert.equal(listEventsForConv(sess.id, { types: ['infra_auto_recover'] }).length, 0, 'no auto-recover when disabled');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_UNATTENDED_AUTO_RECOVER; else process.env.CLEMMY_UNATTENDED_AUTO_RECOVER = prev;
  }
});

test('W1a: a transient error AFTER an external_write does NOT switch brains (no double-act) — it asks', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const agentFor = (id: string) => ({ __brain: id }) as unknown as import('@openai/agents').Agent<any, any>;
  let rebuilds = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, _items) => {
    // Simulate a side effect committing this turn, then a transient failure.
    appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'external_write', data: { tool: 'send_email' } });
    throw BoundaryError.from(new Error('backend 529 after the send'), { kind: 'model.overloaded', retryable: true, userMessage: 'transient' });
  };
  const result = await runConversation({
    agent: agentFor('brain-1'),
    sessionId: sess.id,
    input: 'send the email',
    makeRunner: makeRunnerStub,
    runRunner,
    falloverModelIds: ['brain-2'],
    rebuildAgentForBrain: async (id) => { rebuilds += 1; return agentFor(id); },
  });
  assert.equal(result.status, 'awaiting_user_input', 'must NOT re-run a turn that already wrote externally');
  assert.equal(rebuilds, 0, 'no brain rebuild after an external write');
  assert.equal(listEventsForConv(sess.id, { types: ['brain_fallover'] }).length, 0, 'no fallover advisory');
});

test('W1a: an exact proven-no-effect write failure still permits brain fallover', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const agentFor = (id: string) => ({ __brain: id }) as unknown as import('@openai/agents').Agent<any, any>;
  let rebuilds = 0;
  const runRunner: RunRunnerFn = async (_runner, agent, items) => {
    if ((agent as { __brain?: string }).__brain === 'brain-1') {
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'system',
        type: 'external_write',
        data: { tool: 'send_email', callId: 'failed-send-1', preDispatch: true },
      });
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'system',
        type: 'external_write_failed',
        data: { tool: 'send_email', callId: 'failed-send-1', effect: 'none' },
      });
      throw BoundaryError.from(new Error('backend 529 after rejected dispatch'), {
        kind: 'model.overloaded',
        retryable: true,
        userMessage: 'transient',
      });
    }
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'recovered',
        reply: 'Recovered on brain 2.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: agentFor('brain-1'),
    sessionId: sess.id,
    input: 'send the email',
    makeRunner: makeRunnerStub,
    runRunner,
    falloverModelIds: ['brain-2'],
    rebuildAgentForBrain: async (id) => {
      rebuilds += 1;
      return agentFor(id);
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(rebuilds, 1);
  assert.equal(listEventsForConv(sess.id, { types: ['brain_fallover'] }).length, 1);
});

test('runTurn replays eventlog transcript when a Claude-only session has no SDK snapshot', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Draft the Acme renewal update and ask me before sending.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'claude_agent_sdk_brain',
      reply: 'I drafted the Acme renewal update and am waiting for your approval before sending.',
    },
  });

  let seenItems: AgentInputItem[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    seenItems = items;
    return {
      history: [...items, { role: 'assistant', content: 'Continuing from the Acme draft.' } as AgentInputItem],
      lastResponseId: undefined,
      finalOutput: 'Continuing from the Acme draft.',
    };
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'pick this back up',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const replay = seenItems.find((item) => {
    const record = item as { role?: unknown; content?: unknown };
    return record.role === 'system' &&
      typeof record.content === 'string' &&
      record.content.includes('[SESSION REPLAY]');
  }) as { content?: string } | undefined;
  assert.ok(replay?.content, 'standard harness lane injects the canonical eventlog replay');
  assert.match(replay.content, /USER: Draft the Acme renewal update/);
  assert.match(replay.content, /YOU: I drafted the Acme renewal update/);
  assert.doesNotMatch(replay.content, /USER: pick this back up/, 'current input is not duplicated into prior history');
});

test('runTurn replays only newer Claude turns missing from an older OpenAI snapshot', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Summarize the Atlas kickoff notes.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'openai_agents_harness', reply: 'Atlas kickoff summary is saved.' },
  });
  sess.recordTurnResult({
    history: [
      { role: 'user', content: 'Summarize the Atlas kickoff notes.' } as AgentInputItem,
      { role: 'assistant', content: 'Atlas kickoff summary is saved.' } as AgentInputItem,
    ],
    lastResponseId: undefined,
    turn: 1,
  });
  appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Now draft the renewal email from that summary.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'claude_agent_sdk_brain',
      reply: 'I drafted the renewal email but did not send it.',
    },
  });

  let seenItems: AgentInputItem[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    seenItems = items;
    return {
      history: [...items, { role: 'assistant', content: 'Continuing with the unsent renewal draft.' } as AgentInputItem],
      lastResponseId: undefined,
      finalOutput: 'Continuing with the unsent renewal draft.',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'pick up the renewal draft',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const replay = seenItems.find((item) => {
    const record = item as { role?: unknown; content?: unknown };
    return record.role === 'system' &&
      typeof record.content === 'string' &&
      record.content.includes('[SESSION REPLAY]');
  }) as { content?: string } | undefined;
  assert.ok(replay?.content, 'newer Claude turn missing from the snapshot is replayed');
  assert.match(replay.content, /USER: Now draft the renewal email/);
  assert.match(replay.content, /YOU: I drafted the renewal email but did not send it/);
  assert.doesNotMatch(replay.content, /Summarize the Atlas kickoff notes/, 'older snapshot-backed user turn is not duplicated');
  assert.doesNotMatch(replay.content, /Atlas kickoff summary is saved/, 'older snapshot-backed assistant turn is not duplicated');
  assert.doesNotMatch(replay.content, /USER: pick up the renewal draft/, 'current input is not duplicated into prior history');
});

test('runTurn replays an unpaired awaiting_user_input question into a later brain turn', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Deploy the staging build.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: 'Which target should I deploy: staging or production?' },
  });

  let seenItems: AgentInputItem[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    seenItems = items;
    return {
      history: [...items, { role: 'assistant', content: 'Continuing after deployment target answer.' } as AgentInputItem],
      lastResponseId: undefined,
      finalOutput: 'Continuing after deployment target answer.',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'use staging',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const replay = seenItems.find((item) => {
    const record = item as { role?: unknown; content?: unknown };
    return record.role === 'system' &&
      typeof record.content === 'string' &&
      record.content.includes('[SESSION REPLAY]');
  }) as { content?: string } | undefined;
  assert.ok(replay?.content, 'the prior pause question is replayed');
  assert.match(replay.content, /USER: Deploy the staging build/);
  assert.match(replay.content, /YOU: Which target should I deploy/);
  assert.doesNotMatch(replay.content, /USER: use staging/, 'current answer is not duplicated into prior history');
});

test('normalizeError: a non-Error object never renders as "[object Object]" (the run_failed crash)', () => {
  // The exact class that produced "Something went wrong: [object Object]": a raw
  // provider error envelope thrown late in a model stream.
  assert.equal(normalizeError({ statusCode: 529 }), 'error (status 529)');
  assert.equal(normalizeError({ message: 'overloaded' }), 'overloaded');
  assert.equal(normalizeError({ error: 'rate limited' }), 'rate limited');
  assert.equal(normalizeError({ reason: 'upstream blip' }), 'upstream blip');
  // A bare object with no known field → JSON, never "[object Object]".
  assert.equal(normalizeError({ foo: 'bar' }), '{"foo":"bar"}');
  // Real Errors keep their message; primitives stringify normally.
  assert.equal(normalizeError(new Error('boom')), 'boom');
  assert.equal(normalizeError('plain string'), 'plain string');
  // The headline invariant: nothing the helper returns is the literal garbage.
  for (const v of [{ statusCode: 529 }, { a: 1 }, {}, null, undefined]) {
    assert.notEqual(normalizeError(v), '[object Object]');
  }
});

// ── FIX 1: goalObjectiveString — the continuation classifier input ──────────
test('goalObjectiveString: builds objective + success criteria from the parked plan', () => {
  const goal = {
    plan: {
      objective: 'Build outbound emails for every priority-account prospect',
      successCriteria: ['One email drafted per usable row', 'Rows without contacts skipped and listed'],
    },
  } as any;
  const out = goalObjectiveString(goal);
  assert.ok(out!.includes('Build outbound emails'), 'carries the objective');
  assert.ok(out!.includes('One email drafted per usable row'), 'carries the criteria (the multi-domain signal)');
});

test('goalObjectiveString: prefers approvedPlan over plan, and the CURRENT stage criteria when staged', () => {
  const goal = {
    plan: { objective: 'OLD', successCriteria: ['old'] },
    approvedPlan: { objective: 'Pull each prospect and draft outreach', successCriteria: ['all crit'] },
    stages: [
      { id: 's1', title: 'Stage 1', status: 'done', criteria: ['done crit'] },
      { id: 's2', title: 'Stage 2', status: 'pending', criteria: ['pull the sheet rows'] },
    ],
  } as any;
  const out = goalObjectiveString(goal);
  assert.ok(out!.startsWith('Pull each prospect'), 'uses approvedPlan objective');
  assert.ok(out!.includes('pull the sheet rows'), 'uses the CURRENT (pending) stage criteria');
  assert.ok(!out!.includes('done crit'), 'does not include a completed stage');
});

test('goalObjectiveString: null-safe when the plan has no objective (caller falls back to the literal input)', () => {
  assert.equal(goalObjectiveString({ plan: { objective: '', successCriteria: [] } } as any), undefined);
  assert.equal(goalObjectiveString({ plan: {} } as any), undefined);
  assert.equal(goalObjectiveString({} as any), undefined);
});

test('dynamic reasoning effort: real runTurn injects effort per turn (simple→none; interactive chat caps complex at medium)', async () => {
  // Exercises the ACTUAL loop.ts injection (not a hand-port). The explicit-flag
  // contract is owned by buildOrchestratorAgent (asserted in orchestrator.test);
  // here we verify the per-turn effort + the human-waiting cap.
  resetEventLog();
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
    lastResponseId: 'resp',
    finalOutput: { ok: true },
  });

  // Simple chat turn → none (byte-identical fastest path)
  const simpleAgent = makeAgentStub() as any;
  const s1 = HarnessSession.create({ kind: 'chat', title: 'effort-simple' });
  await runTurn({ agent: simpleAgent, sessionId: s1.id, input: "what's on my calendar today?", makeRunner: makeRunnerStub, runRunner });
  assert.equal(simpleAgent.modelSettings?.reasoning?.effort, 'none', 'simple → none');
  assert.equal(simpleAgent.modelSettings?.text?.verbosity, 'low', 'gpt-5 verbosity default preserved');
  assert.equal(listEvents(s1.id, { types: ['reasoning_effort'] })[0].data.effort, 'none');

  // Complex INTERACTIVE chat turn → capped at medium (a human is waiting)
  const chatAgent = makeAgentStub() as any;
  const s2 = HarnessSession.create({ kind: 'chat', title: 'effort-chat-complex' });
  await runTurn({ agent: chatAgent, sessionId: s2.id, input: COMPLEX_INPUT, makeRunner: makeRunnerStub, runRunner });
  assert.equal(chatAgent.modelSettings?.reasoning?.effort, 'medium', 'complex chat → medium (capped)');
  assert.equal(listEvents(s2.id, { types: ['reasoning_effort'] })[0].data.kind, 'chat');
});

test('dynamic reasoning effort: background (workflow) complex turn → high (no human waiting)', async () => {
  resetEventLog();
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
    lastResponseId: 'resp',
    finalOutput: { ok: true },
  });
  const wfAgent = makeAgentStub() as any;
  const sess = HarnessSession.create({ kind: 'workflow', title: 'effort-wf-complex' });
  await runTurn({ agent: wfAgent, sessionId: sess.id, input: COMPLEX_INPUT, makeRunner: makeRunnerStub, runRunner });
  assert.equal(wfAgent.modelSettings?.reasoning?.effort, 'high', 'complex workflow → high');
  assert.equal(listEvents(sess.id, { types: ['reasoning_effort'] })[0].data.effort, 'high');
});

test('dynamic reasoning effort: kill-switch off leaves the agent untouched (SDK default rides)', async () => {
  resetEventLog();
  const prev = process.env.CLEMMY_DYNAMIC_REASONING;
  process.env.CLEMMY_DYNAMIC_REASONING = 'off';
  try {
    const agent = makeAgentStub() as any;
    const sess = HarnessSession.create({ kind: 'chat', title: 'effort-off' });
    const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
      history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
      lastResponseId: 'resp',
      finalOutput: { ok: true },
    });
    await runTurn({ agent, sessionId: sess.id, input: 'research and build a full audit of everything', makeRunner: makeRunnerStub, runRunner });
    assert.equal(agent.modelSettings, undefined, 'no modelSettings set when disabled');
    assert.equal(agent._modelSettingsExplicitlyConfigured, undefined, 'flag untouched when disabled');
    assert.equal(listEvents(sess.id, { types: ['reasoning_effort'] }).length, 0);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_DYNAMIC_REASONING;
    else process.env.CLEMMY_DYNAMIC_REASONING = prev;
  }
});

test('completed chat run snapshots conversation, emits run_completed, leaves session active', async () => {
  // Chat sessions are inherently multi-turn — the user types again. The
  // loop emits run_completed + conversation_completed (the chat dock
  // watches for those to clear THINKING…), but the session row status
  // stays 'active' so the next user message can run a new turn under
  // the same session. Before this fix the row flipped to 'completed'
  // on every turn end, stranding the chat dock.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'completed' });

  const runRunner: RunRunnerFn = async (_runner, _agent, items, _opts) => {
    return {
      history: [
        ...items,
        {
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'done' }],
        },
      ],
      lastResponseId: 'resp_1',
      finalOutput: { ok: true },
    };
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.turn, 1);
  assert.deepEqual(result.finalOutput, { ok: true });

  const completions = listEvents(sess.id, { types: ['run_completed'] });
  assert.equal(completions.length, 1);

  const reloaded = HarnessSession.load(sess.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.previousResponseId(), 'resp_1');
  assert.equal(reloaded!.sessionRow.status, 'active', 'chat sessions stay active between turns');
  // user turn input was recorded
  const userInputs = listEvents(sess.id, { types: ['user_input_received'] });
  assert.equal(userInputs.length, 1);
  assert.equal(userInputs[0].data.text, 'do the thing');
});

test('runTurn persists latest native Codex compaction item for replay when flag is enabled', async () => {
  resetEventLog();
  const previousFlag = process.env.CLEMMY_CODEX_NATIVE_COMPACTION;
  process.env.CLEMMY_CODEX_NATIVE_COMPACTION = '1';
  try {
    const sess = HarnessSession.create({ kind: 'chat', title: 'native compaction' });
    const runRunner: RunRunnerFn = async (_runner, _agent, items, _opts) => {
      const assistantMessage = {
        id: 'msg_after_compaction',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'I will continue from the compacted state.' }],
      } as unknown as AgentInputItem;
      return {
        history: [
          ...items,
          {
            id: 'fc_1',
            type: 'function_call',
            callId: 'call_1',
            name: 'expensive_tool',
            arguments: '{}',
            status: 'completed',
          } as unknown as AgentInputItem,
          {
            type: 'function_call_result',
            callId: 'call_1',
            output: { type: 'text', text: 'large tool result' },
            status: 'completed',
          } as unknown as AgentInputItem,
          assistantMessage,
        ],
        lastResponseId: 'resp_compacted',
        finalOutput: { done: false, nextAction: 'completed', summary: 'compacted' },
        rawResponses: [
          { output: [{ type: 'compaction', id: 'cmp_old', encrypted_content: 'old-state' }] },
          { output: [{ type: 'compaction', id: 'cmp_new', encrypted_content: 'new-state' }] },
        ],
      };
    };

    const result = await runTurn({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'continue the long run',
      makeRunner: makeRunnerStub,
      runRunner,
    });

    assert.equal(result.status, 'completed');
    const replay = HarnessSession.load(sess.id)?.toInputItems() ?? [];
    assert.equal(replay.length, 2);
    assert.equal((replay[0] as { type?: string }).type, 'compaction');
    assert.equal((replay[0] as { id?: string }).id, 'cmp_new');
    assert.equal((replay[0] as { encrypted_content?: string }).encrypted_content, 'new-state');
    assert.equal((replay[1] as { role?: string }).role, 'assistant');

    const events = listEvents(sess.id, { types: ['native_compaction_applied'] });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.previousItems, 4);
    assert.equal(events[0].data.nextItems, 2);
    assert.equal(events[0].data.compactionItemsSeen, 2);
    assert.equal(events[0].data.latestCompactionId, 'cmp_new');
  } finally {
    if (previousFlag == null) {
      delete process.env.CLEMMY_CODEX_NATIVE_COMPACTION;
    } else {
      process.env.CLEMMY_CODEX_NATIVE_COMPACTION = previousFlag;
    }
  }
});

test('completed workflow run flips session status to completed (one-shot)', async () => {
  // Workflow / execution / agent sessions represent a single step or
  // task. Marking the row 'completed' here is correct so the dashboard's
  // Live Runs filter doesn't keep showing them.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'workflow', title: 'workflow-step' });

  const runRunner: RunRunnerFn = async (_runner, _agent, items, _opts) => ({
    history: [
      ...items,
      {
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done' }],
      },
    ],
    lastResponseId: 'resp_w',
    finalOutput: { ok: true },
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the workflow step',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const reloaded = HarnessSession.load(sess.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.sessionRow.status, 'completed', 'workflow sessions are one-shot');
});

// P0-4: even for one-shot workflow sessions, the row must NOT flip to
// 'completed' while an approval is still pending. Otherwise the reaper
// false-reaps the paused approval and the user-action surface
// disappears mid-flight. The shipped guard at loop.ts:1080 + :1394 is
// `kind !== 'chat' && !approvalRegistry.hasPending(sessionId)`.
test('workflow run with a pending approval stays active (P0-4 guard)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'workflow', title: 'paused-workflow' });

  // Register a pending approval BEFORE the turn ends, mimicking a
  // tool call that handed off to the approval bus mid-turn.
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'mock approval gate',
    tool: 'request_approval',
  });

  const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: [
      ...items,
      { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] },
    ],
    lastResponseId: 'resp_paused',
    finalOutput: { ok: true },
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'kick off workflow',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const reloaded = HarnessSession.load(sess.id);
  assert.ok(reloaded);
  assert.equal(
    reloaded!.sessionRow.status,
    'active',
    'pending approval must keep workflow session active; do not mark completed mid-pause',
  );
});

test('previousResponseId is NOT passed to the SDK (codex requires full history each turn)', async () => {
  // Codex enforces `store: false`, so the server never persists
  // responses we could refer back to. Passing previousResponseId
  // to the SDK opt would flip it into delta-only mode
  // (ServerConversationTracker), and codex would 400 every
  // continuation call with "No tool call found for function call
  // output". Instead the harness inlines the full conversation
  // history into `items` every turn.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const seenOpts: Record<string, unknown>[] = [];

  const runRunner: RunRunnerFn = async (_r, _a, items, opts) => {
    seenOpts.push({ ...opts });
    return {
      history: [
        ...items,
        { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
      ],
      lastResponseId: `resp_${seenOpts.length}`,
      finalOutput: 'ok',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'first',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  const after1 = HarnessSession.load(sess.id)!;
  const { updateSession } = await import('./eventlog.js');
  updateSession(after1.id, { status: 'active' });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'second',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(seenOpts.length, 2);
  assert.equal(seenOpts[0].previousResponseId, undefined, 'first turn never sets prior');
  assert.equal(seenOpts[1].previousResponseId, undefined, 'second turn also never sets prior — full history is inlined into items instead');
});

test('runTurn injects a transient memory primer before the first model response', async () => {
  resetEventLog();
  rememberFact({
    kind: 'project',
    content: 'Salesforce prospecting should prioritize stale untouched accounts before enrichment.',
  });
  const sess = HarnessSession.create({ kind: 'chat' });
  let filteredInput: AgentInputItem[] = [];

  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    const filter = opts.callModelInputFilter as
      | ((args: { modelData: { input: AgentInputItem[]; instructions?: string } }) => { input: AgentInputItem[]; instructions?: string })
      | undefined;
    assert.equal(typeof filter, 'function', 'expected harness to pass callModelInputFilter');
    filteredInput = filter!({ modelData: { input: items, instructions: 'base instructions' } }).input;
    return {
      history: [
        ...items,
        { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
      ],
      lastResponseId: undefined,
      finalOutput: 'ok',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'can you help me with some Salesforce prospecting',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const primer = filteredInput.find((item) =>
    (item as { role?: unknown }).role === 'system'
    && typeof (item as { content?: unknown }).content === 'string'
    && ((item as { content: string }).content.includes('[MEMORY PRIMER]')),
  ) as { content: string } | undefined;
  assert.ok(primer, 'expected memory primer to be appended to model input');
  assert.match(primer.content, /Use relevant hits/i);
  assert.match(primer.content, /Salesforce prospecting/i);
  assert.match(primer.content, /stale untouched accounts/i);

  const primerEvents = listEvents(sess.id, { types: ['turn_memory_primer'] });
  assert.equal(primerEvents.length, 1);
  assert.equal(primerEvents[0].data.injected, true);
  assert.ok((primerEvents[0].data.hitCount as number) > 0);
  assert.equal(primerEvents[0].data.source, 'unified');
  assert.match(String(primerEvents[0].data.recallId), /^mr-/);
  assert.equal(typeof primerEvents[0].data.omittedCount, 'number');
  assert.equal(primerEvents[0].data.includedCount, primerEvents[0].data.hitCount);
});

test('runTurn compacts oversized same-turn tool results only in model-facing input', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let filteredInput: AgentInputItem[] = [];
  let activeInputJson = '';
  let observedPromptComponents: Record<string, number> | undefined;
  const priorEnv = {
    trigger: process.env.CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS,
    budget: process.env.CLEMMY_INFLIGHT_RESULT_BUDGET_TOKENS,
    min: process.env.CLEMMY_INFLIGHT_MIN_RETAIN_PAIRS,
    max: process.env.CLEMMY_INFLIGHT_MAX_RETAIN_PAIRS,
  };
  process.env.CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS = '1000';
  process.env.CLEMMY_INFLIGHT_RESULT_BUDGET_TOKENS = '2000';
  process.env.CLEMMY_INFLIGHT_MIN_RETAIN_PAIRS = '2';
  process.env.CLEMMY_INFLIGHT_MAX_RETAIN_PAIRS = '4';

  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    const activeInput: AgentInputItem[] = [...items];
    for (let i = 0; i < 10; i++) {
      const callId = `same_turn_${i}`;
      const output = `result ${i} ${'q'.repeat(4000)}`;
      activeInput.push({
        type: 'function_call',
        callId,
        name: 'research.target',
        arguments: `{"target":${i}}`,
        status: 'completed',
      } as unknown as AgentInputItem);
      activeInput.push({
        type: 'function_call_result',
        callId,
        output: { type: 'text', text: output },
        status: 'completed',
      } as unknown as AgentInputItem);
      writeToolOutput({ sessionId: sess.id, callId, tool: 'research.target', output });
    }
    activeInputJson = JSON.stringify(activeInput);
    const filter = opts.callModelInputFilter as
      | ((args: { modelData: { input: AgentInputItem[]; instructions?: string } }) => { input: AgentInputItem[]; instructions?: string })
      | undefined;
    filteredInput = filter!({ modelData: { input: activeInput, instructions: 'base' } }).input;
    observedPromptComponents = harnessRunContextStorage.getStore()?.promptComponents;
    assert.equal(JSON.stringify(activeInput), activeInputJson, 'filter must not mutate Runner history');
    return {
      history: [
        ...items,
        { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] },
      ],
      finalOutput: 'done',
    };
  };

  try {
    await runTurn({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'research these ten targets',
      makeRunner: makeRunnerStub,
      runRunner,
    });
  } finally {
    if (priorEnv.trigger === undefined) delete process.env.CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS;
    else process.env.CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS = priorEnv.trigger;
    if (priorEnv.budget === undefined) delete process.env.CLEMMY_INFLIGHT_RESULT_BUDGET_TOKENS;
    else process.env.CLEMMY_INFLIGHT_RESULT_BUDGET_TOKENS = priorEnv.budget;
    if (priorEnv.min === undefined) delete process.env.CLEMMY_INFLIGHT_MIN_RETAIN_PAIRS;
    else process.env.CLEMMY_INFLIGHT_MIN_RETAIN_PAIRS = priorEnv.min;
    if (priorEnv.max === undefined) delete process.env.CLEMMY_INFLIGHT_MAX_RETAIN_PAIRS;
    else process.env.CLEMMY_INFLIGHT_MAX_RETAIN_PAIRS = priorEnv.max;
  }

  const modelJson = JSON.stringify(filteredInput);
  assert.match(modelJson, /summary of older completed tool activity/);
  assert.doesNotMatch(modelJson, /"callId":"same_turn_0"/);
  assert.match(modelJson, /"callId":"same_turn_8"/);
  assert.match(modelJson, /"callId":"same_turn_9"/);
  assert.ok((observedPromptComponents?.history ?? 0) > 0);
  assert.ok((observedPromptComponents?.instructions ?? 0) > 0);
  assert.ok((observedPromptComponents?.contextPacket ?? 0) > 0);
  const event = listEvents(sess.id, { types: ['condenser_applied'] })
    .find((row) => row.data.inFlight === true);
  assert.ok(event, 'same-turn compaction should be visible in harness telemetry');
  assert.equal(event.data.retainedToolPairs, 2);
});

test('turn numbers monotonically increment across runs', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({
    history: items,
    lastResponseId: undefined,
    finalOutput: '',
  });

  const r1 = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'a',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  const { updateSession } = await import('./eventlog.js');
  updateSession(sess.id, { status: 'active' });
  const r2 = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'b',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  updateSession(sess.id, { status: 'active' });
  const r3 = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'c',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(r1.turn, 1);
  assert.equal(r2.turn, 2);
  assert.equal(r3.turn, 3);
});

test('kill switch set before the call short-circuits with kill_requested', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  requestKill(sess.id, 'test stop');

  const runRunner: RunRunnerFn = async () => {
    throw new Error('should not be called');
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do work',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'killed');
  const killEvents = listEvents(sess.id, { types: ['kill_requested'] });
  assert.equal(killEvents.length, 1);
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.sessionRow.status, 'cancelled');

  // The honored kill is one-shot: the latch is consumed, so the user's
  // next message on the same session runs normally instead of being
  // assassinated by the stale row (stale-event regression: a
  // post-Stop follow-up died on the leftover kill).
  const { isKillRequested, updateSession } = await import('./eventlog.js');
  assert.equal(isKillRequested(sess.id), false);
  updateSession(sess.id, { status: 'active' });
  let secondRunRan = false;
  const okRunner: RunRunnerFn = async (_r, _a, items) => {
    secondRunRan = true;
    return { history: items, lastResponseId: undefined, finalOutput: 'done' };
  };
  const second = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'follow-up after stop',
    makeRunner: makeRunnerStub,
    runRunner: okRunner,
  });
  assert.equal(secondRunRan, true);
  assert.notEqual(second.status, 'killed');
});

test('SDK-wrapped KillRequested during the run ends as a clean killed turn', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  // A kill that lands while a function tool is executing is thrown by the
  // tool bracket INSIDE the SDK, which re-wraps it as a plain Error — the
  // same envelope that hid ToolTimeout and ToolGuardrailEscalated. The
  // instanceof check alone misses it and the raw string reached the user.
  // Latch the kill INSIDE the run (after pre-flight) like a real Stop press.
  const runRunner: RunRunnerFn = async () => {
    requestKill(sess.id, 'stop pressed mid-tool');
    throw new Error(
      `Failed to run function tools: KillRequested: session ${sess.id} has a pending kill request`,
    );
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'scan everything',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'killed');
  const killEvents = listEvents(sess.id, { types: ['kill_requested'] });
  assert.ok(killEvents.some((ev) => (ev.data as { reason?: unknown }).reason === 'during run'));
  // No run_failed — the user sees Stopped, not the raw wrapped error.
  assert.equal(listEvents(sess.id, { types: ['run_failed'] }).length, 0);
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.sessionRow.status, 'cancelled');
  // The latch is consumed here too.
  const { isKillRequested } = await import('./eventlog.js');
  assert.equal(isKillRequested(sess.id), false);
});

test('ToolCallsLimitExceeded thrown by run surfaces as guardrail_tripped', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => {
    throw new ToolCallsLimitExceeded(8);
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'busy loop',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'limit_exceeded');
  // Filter to the specific kind — v0.5.18 preflight gate now emits
  // an additional guardrail_tripped(kind:preflight_budget_check) per
  // turn for observability, so a length:1 assertion is too tight.
  const tripped = listEvents(sess.id, { types: ['guardrail_tripped'] })
    .filter((ev) => (ev.data as { kind?: unknown }).kind === 'tool_calls_limit');
  assert.equal(tripped.length, 1);
  assert.equal(tripped[0].data.kind, 'tool_calls_limit');
  assert.equal(tripped[0].data.limit, 8);
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.sessionRow.status, 'failed');
});

test('interruption saves serialized RunState and returns awaiting_approval', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: '{"$schema":1,"items":[]}',
  });

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'deploy now',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.loadInterruptState(), '{"$schema":1,"items":[]}');
  const paused = listEvents(sess.id, { types: ['run_paused'] });
  assert.equal(paused.length, 1);
});

test('interruption emits approval_requested per interrupted tool call with parsed args', async () => {
  // The SDK skips a tool's execute() when needsApproval=true, so the
  // loop — not the tool body — must record approval_requested. Drive
  // a fake interruption shaped like a real RunToolApprovalItem.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: '{"$schema":1,"items":[]}',
    interruptions: [
      {
        toolName: 'request_approval',
        rawArgs: '{"subject":"deploy to prod","destructive":true}',
        args: { subject: 'deploy to prod', destructive: true },
      },
    ],
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'ship it',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const approvals = listEvents(sess.id, { types: ['approval_requested'] });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].data.tool, 'request_approval');
  assert.equal(approvals[0].data.subject, 'deploy to prod');
  assert.deepEqual(approvals[0].data.args, { subject: 'deploy to prod', destructive: true });
});

test('queue-only action → request_approval interruption pins the immutable action; approval executes once and tampering stays inert', async () => {
  resetEventLog();
  const requestCard = async (
    sessionId: string,
    recipient: string,
  ) => {
    const sess = HarnessSession.create({ id: sessionId, kind: 'chat' });
    const record = queuePendingAction({
      title: `Send reviewed note to ${recipient}`,
      summary: 'The exact send was prepared queue-only and is now being presented for approval.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: JSON.stringify({
          to: recipient,
          subject: 'Reviewed note',
          body: 'Exact approved body.',
        }),
        connected_account_id: 'ca_gmail_owner',
      },
      targetSummary: recipient,
      sessionId,
    });
    const interruptionArgs = {
      subject: record.title,
      reason: record.summary,
      pendingActionId: record.id,
    };
    await runTurn({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'Present the staged action for approval now.',
      makeRunner: makeRunnerStub,
      runRunner: async () => ({
        history: [],
        lastResponseId: undefined,
        finalOutput: undefined,
        hasInterruptions: true,
        serializedState: '{"$schema":1,"items":[]}',
        interruptions: [{
          toolName: 'request_approval',
          rawArgs: JSON.stringify(interruptionArgs),
          args: interruptionArgs,
        }],
      }),
    });
    const [row] = approvalRegistry.listPending({ sessionId, status: 'pending' });
    assert.ok(row);
    assert.deepEqual(row.args?.pendingAction, pendingActionApprovalView(record));
    const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test');
    assert.equal(resolved.ok, true);
    assert.equal(getPendingAction(record.id)?.status, 'approved');
    return record;
  };

  const executable = await requestCard('sess-loop-exact-card-execute', 'proof@example.com');
  let dispatches = 0;
  const executed = await executeApprovedPendingActionCall(executable.id, {
    sessionId: executable.sessionId!,
    dispatch: async () => {
      dispatches += 1;
      return 'OK sent exact staged payload';
    },
  });
  assert.equal(executed.status, 'executed');
  assert.equal(dispatches, 1);

  const tampered = await requestCard('sess-loop-exact-card-tamper', 'original@example.com');
  const recordFile = path.join(TMP_HOME, 'pending-actions', `${tampered.id}.json`);
  const changed = JSON.parse(readFileSync(recordFile, 'utf8')) as {
    toolName: string;
    payload: Record<string, unknown>;
    payloadHash: string;
  };
  changed.payload = {
    ...changed.payload,
    arguments: JSON.stringify({
      to: 'attacker@example.com',
      subject: 'Changed after approval',
      body: 'This must never dispatch.',
    }),
  };
  // Re-hashing the mutable queue record cannot outrun the independent card
  // snapshot stored by registerAndEmitApprovals.
  changed.payloadHash = pendingActionPayloadHash(changed.toolName, changed.payload);
  writeFileSync(recordFile, JSON.stringify(changed), 'utf8');

  let tamperedDispatches = 0;
  const refused = await executeApprovedPendingActionCall(tampered.id, {
    sessionId: tampered.sessionId!,
    dispatch: async () => {
      tamperedDispatches += 1;
      return 'must never run';
    },
  });
  assert.equal(refused.status, 'failed');
  assert.equal(tamperedDispatches, 0);
  assert.match(refused.resultSummary, /approval-authority|approval card|snapshot|does not pin/i);
});

test('an identical pending-action interruption reuses its linked card, but a re-hashed changed payload cannot', async () => {
  resetEventLog();
  const sessionId = 'sess-loop-linked-card-replay';
  const sess = HarnessSession.create({ id: sessionId, kind: 'chat' });
  const record = queuePendingAction({
    title: 'Send the exact reviewed replay proof',
    summary: 'The immutable queued payload should own one approval card.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: JSON.stringify({
        to: 'proof@example.com',
        subject: 'Replay proof',
        body: 'Original exact body.',
      }),
      connected_account_id: 'ca_gmail_owner',
    },
    targetSummary: 'proof@example.com',
    sessionId,
  });
  const interruptionArgs = {
    subject: record.title,
    reason: record.summary,
    pendingActionId: record.id,
  };
  const surfaceInterruption = async (input: string) => runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input,
    makeRunner: makeRunnerStub,
    runRunner: async () => ({
      history: [],
      lastResponseId: undefined,
      finalOutput: undefined,
      hasInterruptions: true,
      serializedState: '{"$schema":1,"items":[]}',
      interruptions: [{
        toolName: 'request_approval',
        rawArgs: JSON.stringify(interruptionArgs),
        args: interruptionArgs,
      }],
    }),
  });

  await surfaceInterruption('Present the exact staged action for approval.');
  const [firstCard] = approvalRegistry.listPending({ sessionId, status: 'pending' });
  assert.ok(firstCard);
  const firstArgs = JSON.parse(JSON.stringify(firstCard.args)) as Record<string, unknown>;
  const firstSnapshot = firstArgs.pendingAction as { payloadHash: string };

  await surfaceInterruption('The same unresolved interruption surfaced again.');
  let pendingCards = approvalRegistry.listPending({ sessionId, status: 'pending' });
  assert.equal(pendingCards.length, 1, 'link-time display fields cannot create a duplicate card');
  assert.equal(pendingCards[0].approvalId, firstCard.approvalId);
  assert.deepEqual(pendingCards[0].args, firstArgs, 'replay reuses the card-owned immutable snapshot');

  const recordFile = path.join(TMP_HOME, 'pending-actions', `${record.id}.json`);
  const changed = JSON.parse(readFileSync(recordFile, 'utf8')) as {
    toolName: string;
    payload: Record<string, unknown>;
    payloadHash: string;
  };
  changed.payload = {
    ...changed.payload,
    arguments: JSON.stringify({
      to: 'different@example.com',
      subject: 'Changed after first card',
      body: 'This is a different authority and needs a different card.',
    }),
  };
  changed.payloadHash = pendingActionPayloadHash(changed.toolName, changed.payload);
  writeFileSync(recordFile, JSON.stringify(changed), 'utf8');

  await surfaceInterruption('The same id now points at a changed, re-hashed payload.');
  pendingCards = approvalRegistry.listPending({ sessionId, status: 'pending' });
  assert.equal(pendingCards.length, 2, 'a changed payload must never inherit the old card');
  const pinnedHashes = pendingCards.map((row) =>
    (row.args?.pendingAction as { payloadHash?: unknown } | undefined)?.payloadHash);
  assert.deepEqual(
    new Set(pinnedHashes),
    new Set([firstSnapshot.payloadHash, changed.payloadHash]),
  );
  assert.deepEqual(
    approvalRegistry.get(firstCard.approvalId)?.args,
    firstArgs,
    'minting the changed authority cannot mutate the original card snapshot',
  );
});

test('interruption registers Discord channel id for approval routing', async () => {
  resetEventLog();
  const sess = HarnessSession.create({
    kind: 'chat',
    channel: 'discord',
    metadata: { channelId: 'discord-channel-123' },
  });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: '{"$schema":1,"items":[]}',
    interruptions: [
      {
        toolName: 'request_approval',
        rawArgs: '{"subject":"send outreach"}',
        args: { subject: 'send outreach' },
      },
    ],
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'send it',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const rows = approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'discord');
  assert.equal(rows[0].channelId, 'discord-channel-123');
});

test('resume resolves the approval rows present before the resumed run requests a new approval', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-approval' });
  sess.saveInterruptState(makeApprovalRunState(agent, 'old_tool'));
  const oldApproval = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'old pending approval',
    tool: 'old_tool',
    args: {},
  });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: makeApprovalRunState(agent, 'new_tool'),
    interruptions: [
      {
        toolName: 'new_tool',
        rawArgs: '{"subject":"new pending approval"}',
        args: { subject: 'new pending approval' },
      },
    ],
  });

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  const allRows = approvalRegistry.listPending({ sessionId: sess.id, status: 'any' });
  const resolvedOld = allRows.find((row) => row.approvalId === oldApproval.approvalId);
  assert.equal(resolvedOld?.status, 'resolved');
  assert.equal(resolvedOld?.resolution, 'approved');
  assert.equal(resolvedOld?.resolver, 'unit-test');

  const pendingRows = approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' });
  assert.equal(pendingRows.length, 1);
  assert.equal(pendingRows[0].tool, 'new_tool');
  assert.equal(pendingRows[0].subject, 'new_tool: new pending approval');

  const approvalEvents = listEvents(sess.id, { types: ['approval_resolved', 'approval_requested'] });
  assert.deepEqual(approvalEvents.map((event) => event.type), [
    'approval_resolved',
    'approval_requested',
  ]);
});

test('runConversationFromResume publishes the exact new approval requested by the resumed SDK state', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeTerminalApprovalTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume terminal approval' });
  sess.saveInterruptState(makeApprovalRunState(agent, 'old_tool'));
  const oldApproval = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'old exact action',
    tool: 'old_tool',
    args: {},
  });
  const newArgs = { subject: 'Authorize the newly discovered exact action.' };
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: items,
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: makeApprovalRunStateWithInterruptions(agent, [{
      toolName: 'new_tool',
      callId: 'new-call',
      argumentsJson: JSON.stringify(newArgs),
    }]),
    interruptions: [{
      toolName: 'new_tool',
      args: newArgs,
      rawArgs: JSON.stringify(newArgs),
    }],
  });

  const result = await runConversationFromResume({
    agent,
    sessionId: sess.id,
    approvalId: oldApproval.approvalId,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  assert.equal(approvalRegistry.get(oldApproval.approvalId)?.status, 'resolved');
  const pending = approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, 'new_tool');
  assert.equal(result.publicPresentation?.kind, 'approval');
  assert.equal(result.publicPresentation?.approvalId, pending[0].approvalId);
  const accepted = listEventsForConv(sess.id, { types: ['user_input_received'] })
    .find((event) => event.data.source === 'approval_resume')!;
  assert.equal(result.publicPresentation?.identity.sourceUserSeq, accepted.seq);
  assert.equal(result.publicPresentation?.identity.turn, accepted.turn);
  assert.equal(Object.hasOwn(result.publicPresentation?.identity ?? {}, 'runId'), false);
  assert.equal(listEventsForConv(sess.id, { types: ['conversation_completed'] }).length, 1);
});

test('runConversationFromResume continuation publishes its exact SDK approval instead of the resolved prior card', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeContinuationApprovalTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume continuation approval' });
  sess.saveInterruptState(makeApprovalRunState(agent, 'old_tool'));
  const oldApproval = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'old exact action',
    tool: 'old_tool',
    args: {},
  });
  const continuationArgs = { subject: 'Authorize the continuation action only.' };
  let calls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    if (calls === 1) {
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          done: false,
          nextAction: 'awaiting_handoff_result',
          reply: 'The approved step returned an intermediate result.',
          summary: 'The resumed SDK step completed and the graph has another edge.',
          reason: null,
        },
      };
    }
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: undefined,
      hasInterruptions: true,
      serializedState: makeApprovalRunStateWithInterruptions(agent, [{
        toolName: 'continuation_tool',
        callId: 'continuation-call',
        argumentsJson: JSON.stringify(continuationArgs),
      }]),
      interruptions: [{
        toolName: 'continuation_tool',
        args: continuationArgs,
        rawArgs: JSON.stringify(continuationArgs),
      }],
    };
  };

  const result = await runConversationFromResume({
    agent,
    sessionId: sess.id,
    approvalId: oldApproval.approvalId,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(calls, 2);
  assert.equal(result.status, 'awaiting_approval');
  const pending = approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, 'continuation_tool');
  assert.equal(result.publicPresentation?.kind, 'approval');
  assert.equal(result.publicPresentation?.approvalId, pending[0].approvalId);
  assert.notEqual(result.publicPresentation?.approvalId, oldApproval.approvalId);
  assert.equal(listEventsForConv(sess.id, { types: ['conversation_completed'] }).length, 1);
});

test('runConversationFromResume rejection settles the accepted control edge as one cancellation', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeCancellationTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume cancellation' });
  sess.saveInterruptState(makeApprovalRunState(agent, 'send_tool'));
  const approval = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'send the exact draft',
    tool: 'send_tool',
    args: {},
  });
  const result = await runConversationFromResume({
    agent,
    sessionId: sess.id,
    approvalId: approval.approvalId,
    decision: 'reject',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner: async (_runner, _agent, items) => ({
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        done: true,
        nextAction: 'completed',
        reply: 'The action was not executed.',
        summary: 'Rejected.',
        reason: null,
      },
    }),
  });

  assert.equal(approvalRegistry.get(approval.approvalId)?.resolution, 'rejected');
  assert.equal(result.publicPresentation?.status, 'cancelled');
  assert.equal(result.publicPresentation?.kind, 'stopped');
  const accepted = listEventsForConv(sess.id, { types: ['user_input_received'] })
    .find((event) => event.data.source === 'approval_resume')!;
  assert.equal(result.publicPresentation?.identity.sourceUserSeq, accepted.seq);
  assert.equal(listEventsForConv(sess.id, { types: ['conversation_completed'] }).length, 1);
  const graphs = listEventsForConv(sess.id, { types: ['turn_graph_compiled'] });
  assert.equal(graphs.length, 1, 'approval resume observes the accepted control edge once');
  assert.equal(graphs[0].parentEventId, accepted.id);
  assert.equal(graphs[0].data.sourceUserSeq, accepted.seq);
  assert.equal((graphs[0].data.graph as { source?: { surface?: unknown } }).source?.surface, 'approval_resume');
});

test('an exact approval ID resolves only its matching interruption and leaves a different pending write inert', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ExactApprovalResumeTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'exact approval resume' });
  const approvedArgs = {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: { to: 'approved@example.com', subject: 'Approved', body: 'A' },
  };
  const otherArgs = {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: { to: 'other@example.com', subject: 'Other', body: 'B' },
  };
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [
    {
      toolName: 'composio_execute_tool',
      callId: 'call-approved',
      argumentsJson: JSON.stringify(approvedArgs),
    },
    {
      toolName: 'composio_execute_tool',
      callId: 'call-other',
      argumentsJson: JSON.stringify(otherArgs),
    },
  ]));
  const approvedCard = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'Send approved email',
    tool: 'composio_execute_tool',
    args: approvedArgs,
  });
  const otherCard = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'Send other email',
    tool: 'composio_execute_tool',
    args: otherArgs,
  });

  let approvedCallIds: string[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, state) => {
    const serialized = (state as unknown as RunState).toJSON() as {
      context?: { approvals?: Record<string, { approved?: string[] }> };
    };
    approvedCallIds = serialized.context?.approvals?.composio_execute_tool?.approved ?? [];
    return {
      history: [],
      lastResponseId: undefined,
      finalOutput: undefined,
      hasInterruptions: true,
      serializedState: makeApprovalRunStateWithInterruptions(agent, [{
        toolName: 'composio_execute_tool',
        callId: 'call-other',
        argumentsJson: JSON.stringify(otherArgs),
      }]),
      interruptions: [{
        toolName: 'composio_execute_tool',
        rawArgs: JSON.stringify(otherArgs),
        args: otherArgs,
      }],
    };
  };

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    approvalId: approvedCard.approvalId,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  assert.deepEqual(approvedCallIds, ['call-approved'], 'the different recipient never receives SDK execution authority');
  assert.equal(approvalRegistry.get(approvedCard.approvalId)?.resolution, 'approved');
  assert.equal(approvalRegistry.get(otherCard.approvalId)?.status, 'pending');
  const pendingOther = approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' })
    .filter((row) => row.tool === 'composio_execute_tool'
      && (row.args as { arguments?: { to?: string } } | null)?.arguments?.to === 'other@example.com');
  assert.equal(pendingOther.length, 1, 'the existing different-write card is reused, not resolved or duplicated');
});

test('an approval ID that does not match the serialized interruption executes nothing and remains pending', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'MismatchedApprovalResumeTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'mismatched approval resume' });
  const cardArgs = { to: 'approved@example.com', body: 'approved payload' };
  const interruptedArgs = { to: 'different@example.com', body: 'different payload' };
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'gmail_send_email',
    callId: 'call-different',
    argumentsJson: JSON.stringify(interruptedArgs),
  }]));
  const card = approvalRegistry.register({
    sessionId: sess.id,
    subject: 'Send approved payload',
    tool: 'gmail_send_email',
    args: cardArgs,
  });
  let executions = 0;

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    approvalId: card.approvalId,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner: async () => {
      executions += 1;
      return { history: [], lastResponseId: undefined, finalOutput: { ok: true } };
    },
  });

  assert.equal(result.status, 'awaiting_approval');
  assert.equal(executions, 0, 'mismatched approval authority never reaches the SDK runner');
  assert.equal(approvalRegistry.get(card.approvalId)?.status, 'pending');
  assert.ok(HarnessSession.load(sess.id)?.loadInterruptState(), 'the paused state remains recoverable');
});

test('a bare resume cannot turn multiple Composio cards into a batch-wide approval scope', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeBatchApprovalTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-batch-approval' });
  const draftArgs = [
    { tool_slug: 'SALESFORCE_CREATE_TASK', arguments: JSON.stringify({ account_id: 'a', subject: 'A' }) },
    { tool_slug: 'SALESFORCE_CREATE_TASK', arguments: JSON.stringify({ account_id: 'b', subject: 'B' }) },
  ];
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, draftArgs.map((args, index) => ({
    toolName: 'composio_execute_tool',
    callId: `draft_call_${index}`,
    argumentsJson: JSON.stringify(args),
  }))));
  for (const [index, args] of draftArgs.entries()) {
    approvalRegistry.register({
      sessionId: sess.id,
      subject: `Create Outlook draft ${index + 1}`,
      tool: 'composio_execute_tool',
      args,
    });
  }

  let executions = 0;
  const runRunner: RunRunnerFn = async () => {
    executions += 1;
    return { history: [], lastResponseId: undefined, finalOutput: { ok: true } };
  };

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  assert.equal(executions, 0);
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 2);
  assert.equal(getPlanScope(sess.id), null);
});

test('a bare resume cannot turn multiple direct writes into a tool-wide approval scope', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeDirectExternalBatchTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-direct-external-batch' });
  const toolName = 'slack_post_message';
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [
    { toolName, callId: 'slack_call_1', argumentsJson: JSON.stringify({ channel: 'sales', text: 'A' }) },
    { toolName, callId: 'slack_call_2', argumentsJson: JSON.stringify({ channel: 'sales', text: 'B' }) },
  ]));
  for (let index = 0; index < 2; index++) {
    approvalRegistry.register({
      sessionId: sess.id,
      subject: `Post Slack message ${index + 1}`,
      tool: toolName,
      args: { channel: 'sales', text: String(index) },
    });
  }

  let executions = 0;
  const runRunner: RunRunnerFn = async () => {
    executions += 1;
    return { history: [], lastResponseId: undefined, finalOutput: { ok: true } };
  };

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  assert.equal(executions, 0);
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 2);
  assert.equal(getPlanScope(sess.id), null);
});

test('resume does not open a scoped plan scope for non-external or single-call approvals', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeSingleApprovalTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-single-approval' });
  const args = { tool_slug: 'OUTLOOK_CREATE_DRAFT', arguments: JSON.stringify({ to: 'a@example.com', subject: 'A' }) };
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool',
    callId: 'draft_call_1',
    argumentsJson: JSON.stringify(args),
  }]));
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'Create one Outlook draft',
    tool: 'composio_execute_tool',
    args,
  });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: { ok: true },
  });

  const result = await resumePendingApproval({
    agent,
    sessionId: sess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(getPlanScope(sess.id), null);

  resetEventLog();
  const shellSess = HarnessSession.create({ kind: 'chat', title: 'resume-shell-batch' });
  shellSess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [
    { toolName: 'run_shell_command', callId: 'shell_call_1', argumentsJson: JSON.stringify({ command: 'touch a' }) },
    { toolName: 'run_shell_command', callId: 'shell_call_2', argumentsJson: JSON.stringify({ command: 'touch b' }) },
  ]));
  for (let index = 0; index < 2; index++) {
    approvalRegistry.register({
      sessionId: shellSess.id,
      subject: `Run shell command ${index + 1}`,
      tool: 'run_shell_command',
      args: { command: `touch ${index === 0 ? 'a' : 'b'}` },
    });
  }

  const shellResult = await resumePendingApproval({
    agent,
    sessionId: shellSess.id,
    decision: 'approve',
    resolver: 'unit-test',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(shellResult.status, 'awaiting_approval');
  assert.equal(getPlanScope(shellSess.id), null);
});

test('interruption with no rich args falls back to the tool name as subject', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => ({
    history: [],
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: '{}',
    interruptions: [{ toolName: 'cx_zendesk_create_ticket', rawArgs: 'not json', args: null }],
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'open the ticket',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const approvals = listEvents(sess.id, { types: ['approval_requested'] });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].data.subject, 'cx_zendesk_create_ticket');
});

test('generic run error emits run_failed and marks the session failed', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => {
    // A genuinely non-transient error (no transport/HTTP-status signal) — must
    // still terminate as 'failed', NOT get routed to the retry prompt.
    throw new Error('unexpected null in planner output');
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /unexpected null/);
  const failed = listEvents(sess.id, { types: ['run_failed'] });
  assert.equal(failed.length, 1);
  assert.match(String(failed[0].data.error), /unexpected null/);
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.sessionRow.status, 'failed');
});

test('A2#3: an UNHANDLED model HTTP status (422) becomes a recoverable ask + brain-switch, not a dead session', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // A model-backend HTTP error the classifier doesn't specifically handle (not
    // 401/403/429/5xx). Previously → terminal run_failed (a dead turn). Now → recoverable
    // model.unknown → retry/switch/stop ask (fallover-eligible), session stays ACTIVE.
    throw { statusCode: 422, message: 'Unprocessable request' };
  };
  const result = await runTurn({
    agent: makeAgentStub(), sessionId: sess.id, input: 'do thing',
    makeRunner: makeRunnerStub, runRunner,
  });
  // Recoverable: the first attended infra error queues a silent quiet-retry
  // (infraAutoRetry) — not a dead session. (The retry→ask flow is exercised at
  // the runConversation level.)
  assert.ok(result.infraAutoRetry, 'recoverable — a quiet-retry is queued, not a dead session');
  const reloaded = HarnessSession.load(sess.id);
  assert.notEqual(reloaded!.sessionRow.status, 'failed', 'session is NOT marked failed');
});

test('a NON-Error transient throw (the [object Object] class) becomes a retry prompt, not a crash', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });

  const runRunner: RunRunnerFn = async () => {
    // Exactly the failure that produced "Something went wrong: [object Object]":
    // a raw provider envelope (NOT an Error) thrown late in the stream.
    throw { statusCode: 529, message: 'Overloaded' };
  };

  const result = await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do thing',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  // Fix 2: a transient infra error is RECOVERABLE instead of dying — the first
  // attended failure queues a silent quiet-retry (infraAutoRetry). No crash.
  assert.ok(result.infraAutoRetry, 'a transient error is recoverable (quiet-retry), not a crash');
  // Fix 1: whatever is surfaced is READABLE — never the literal "[object Object]".
  assert.ok(!/\[object Object\]/.test(result.error ?? ''), 'error must be readable, not [object Object]');
  const failed = listEvents(sess.id, { types: ['run_failed'] });
  assert.equal(failed.length, 0, 'a recoverable transient error does NOT emit a terminal run_failed');
});

test('throws when sessionId does not exist', async () => {
  resetEventLog();
  await assert.rejects(
    () =>
      runTurn({
        agent: makeAgentStub(),
        sessionId: 'sess-unknown',
        input: 'x',
        makeRunner: makeRunnerStub,
        runRunner: async () => ({ history: [], lastResponseId: undefined, finalOutput: '' }),
      }),
    /unknown session/,
  );
});

test('the agent input passed to runRunner includes user input + replay', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // pre-seed a prior turn snapshot
  sess.recordTurnResult({
    history: [{ role: 'user', content: 'prior turn' }],
    lastResponseId: 'resp_prior',
    turn: 0,
  });
  // re-activate so the loop will run
  const { updateSession } = await import('./eventlog.js');
  updateSession(sess.id, { status: 'active' });

  let captured: AgentInputItem[] = [];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    captured = items;
    return {
      history: items,
      lastResponseId: 'resp_next',
      finalOutput: '',
    };
  };

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'follow-up',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  // Two items: prior + new user input.
  assert.equal(captured.length, 2);
  const last = captured[captured.length - 1];
  assert.ok('role' in last && last.role === 'user');
  assert.equal('content' in last ? last.content : '', 'follow-up');
});

test('hooks are detached after the run (no listener leak)', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });

  const ee = new EventEmitter();
  const makeRunner = (): Runner => ee as unknown as Runner;
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({
    history: items,
    lastResponseId: undefined,
    finalOutput: '',
  });

  await runTurn({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'hi',
    makeRunner,
    runRunner,
  });

  // After the run, no listeners should remain.
  for (const name of [
    'agent_start',
    'agent_end',
    'agent_handoff',
    'agent_tool_start',
    'agent_tool_end',
  ]) {
    assert.equal(ee.listenerCount(name), 0, `${name} listeners leaked`);
  }
});

// ---------- runConversation (auto-continuation) ----------
//
// runConversation wraps runTurn() in a loop that recurses when the
// Orchestrator's structured decision sets done=false. These tests
// drive the wrapper with scripted RunRunner outputs so each "turn"
// returns whatever decision shape the scenario needs, without
// touching the SDK or the model.

interface ScriptedTurn {
  finalOutput?: unknown;
  status?: 'completed' | 'interrupt' | 'throw';
  delayMs?: number;
}

function scriptedRunner(turns: ScriptedTurn[]): RunRunnerFn {
  let i = 0;
  return async () => {
    const turn = turns[i++] ?? turns[turns.length - 1];
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (turn.status === 'throw') throw new Error('scripted_throw');
    if (turn.status === 'interrupt') {
      return {
        history: [],
        lastResponseId: undefined,
        finalOutput: undefined,
        hasInterruptions: true,
        serializedState: '{}',
      };
    }
    return {
      history: [],
      lastResponseId: undefined,
      finalOutput: turn.finalOutput,
    };
  };
}

test('standard lane parks unresolved provider artifacts and carries exact pending evidence in the typed terminal', async () => {
  resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  const sess = HarnessSession.create({ kind: 'chat' });
  const documentId = 'doc_standard_pending_123456789';
  let rootScopeId = '';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const source = listEvents(sess.id, { types: ['user_input_received'] }).at(-1)!;
    rootScopeId = artifactLedger.resolveArtifactRunScopeId(
      sess.id,
      `${sess.id}::turn:1`,
      source.seq,
    );
    const intent = {
      kind: 'google_doc',
      provider: 'Google Docs',
      slotKey: 'google_doc:primary',
      title: 'Standard lane report',
      createShape: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
    } as const;
    // F-artifact (2026-07-23): the claim stays UNBOUND — dispatch outcome
    // genuinely unknown. (A BOUND claim is now the deliverable and completes
    // green; see the bound-completion test below.)
    artifactLedger.claimArtifactSlot(sess.id, intent, 'create-standard-doc', rootScopeId);
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Created the requested report.',
        reply: 'Done — I created the Google Doc.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Create a Google Doc report for me',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_user_input', 'unverified binding can never return a green completion');
  const terminals = listEvents(sess.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, 'the false success terminal is replaced, not followed by a corrective duplicate');
  const terminal = terminals[0];
  assert.equal(terminal.data.reason, 'awaiting_user_input');
  assert.equal(terminal.data.delivered, false);
  assert.equal(terminal.data.artifactRunScopeId, rootScopeId);
  const verification = terminal.data.artifactVerification as {
    status?: string;
    pending?: number;
    artifacts?: Array<{ resourceId?: string; status?: string }>;
  };
  assert.equal(verification.status, 'pending');
  assert.equal(verification.pending, 1);
  assert.equal(verification.artifacts?.[0]?.status, 'pending');
  const ask = listEvents(sess.id, { types: ['awaiting_user_input'] }).at(-1)!;
  assert.equal(ask.data.source, 'artifact_verification_pending');
  assert.match(String(ask.data.question), /unresolved|cannot honestly confirm/i);
});

// SELF-RESOLVE (2026-07-31, owner directive): before ANY unresolved-claim
// park reaches the user, the model gets one continuation teaching it to
// verify + settle ITSELF (artifact_claim_resolve / execution_reconcile_write).
// The park stays as the fallback when the model still can't resolve.
test('a local call_tool carrier rejection cannot manufacture ambiguity or replace a verified answer', async () => {
  const previousBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat' });
  const verifiedAnswer = [
    'The most recent workspace cadence workflow run succeeded.',
    'Evidence: its durable run record is complete and the weekday two-hour schedule is active.',
  ].join('\n');
  let modelSteps = 0;
  let providerDispatches = 0;
  _setCodeModeToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async () => {
      providerDispatches += 1;
      return 'provider must remain untouched';
    },
  }]]));
  const wrappedCallTool = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']) }) as never,
  ) as unknown as {
    invoke: (context: unknown, input: string, details: unknown) => Promise<unknown>;
  };
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    modelSteps += 1;
    if (modelSteps === 1) {
      const refusal = await wrappedCallTool.invoke(
        { context: { sessionId: session.id } },
        JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            slug: 'GOOGLESHEETS_BATCH_GET',
            args: { spreadsheet_id: 'sheet-fixture-cadence', ranges: ['Log!A1:I10'] },
          }),
        }),
        { toolCall: { callId: 'call-workspace-cadence-loop-replay' } },
      );
      assert.match(String(refusal), /non-empty tool_slug/);
    }
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: verifiedAnswer,
        reply: verifiedAnswer,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
      toolCalls: 1,
    } as never;
  };

  try {
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: session.id,
      input: 'Find and verify the latest workspace cadence workflow run. Do not narrate tool calls.',
      makeRunner: makeRunnerStub,
      runRunner,
    });

    assert.equal(result.status, 'completed');
    assert.equal(modelSteps, 1, 'a proven pre-dispatch refusal never starts a reconciliation model turn');
    assert.equal(providerDispatches, 0);
    assert.equal(listEvents(session.id, { types: ['external_write_orphaned'] }).length, 0);
    const [failed] = listEvents(session.id, { types: ['external_write_failed'] });
    assert.equal(failed?.data.callId, 'call-workspace-cadence-loop-replay');
    assert.equal(failed?.data.sourceUserSeq, listEvents(session.id, { types: ['user_input_received'] })[0]?.seq);
    const selfResolve = listEvents(session.id, { types: ['guardrail_tripped'] })
      .filter((event) => event.data.kind === 'self_resolve_nudge');
    assert.equal(selfResolve.length, 0);
    const [terminal] = listEvents(session.id, { types: ['conversation_completed'] });
    assert.equal(terminal?.data.reply, verifiedAnswer);
  } finally {
    _setCodeModeToolsForTests(null);
    if (previousBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = previousBrackets;
  }
});

test('an unresolved create claim first gets the SELF-RESOLVE continuation — the user beat is the fallback, not the default', async () => {
  resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  const sess = HarnessSession.create({ kind: 'chat' });
  const rootScopeId = `${sess.id}::turn:1`;
  const inputs: string[] = [];
  let srCalls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const last = items.at(-1) as { content?: string } | undefined;
    if (typeof last?.content === 'string') inputs.push(last.content);
    srCalls += 1;
    if (srCalls === 1) {
      artifactLedger.claimArtifactSlot(sess.id, {
        kind: 'google_doc',
        provider: 'Google Docs',
        slotKey: 'google_doc:selfresolve',
        title: 'Self-resolve report',
        createShape: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
      }, 'create-selfresolve-doc', rootScopeId);
    }
    return {
      history: [],
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Created the requested report.',
        reply: 'Done — I created the Google Doc.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Create a Google Doc report for me',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  // 1. The model was told to settle it ITSELF, with the exact verbs, before
  //    any user-facing park.
  const selfResolveInput = inputs.find((i) => i.includes('[self-resolve]'));
  assert.ok(selfResolveInput, 'the self-resolve continuation fired before parking');
  assert.match(selfResolveInput!, /Do NOT hand this uncertainty to the user/i);
  assert.match(selfResolveInput!, /artifact_claim_resolve/);
  assert.equal(inputs.filter((i) => i.includes('[self-resolve]')).length, 1, 'one-shot per request');
  // 2. The stub never resolves it, so the honest park remains the FALLBACK.
  assert.equal(result.status, 'awaiting_user_input', 'still never a green completion on an unresolved claim');
  const nudges = listEvents(sess.id, { types: ['guardrail_tripped'] })
    .filter((e) => (e.data as { kind?: string }).kind === 'self_resolve_nudge');
  assert.equal(nudges.length, 1, 'the nudge is recorded in telemetry');
});

test('artifact reconciliation cannot use a bound sibling slot to settle the unresolved logical deliverable', async () => {
  resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  const sess = HarnessSession.create({ kind: 'chat' });
  const rootScopeId = `${sess.id}::turn:1`;
  let calls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    if (calls === 1) {
      artifactLedger.claimArtifactSlot(sess.id, {
        kind: 'google_doc',
        provider: 'Fixture Docs',
        slotKey: 'google_doc:primary-report',
        title: 'Primary report',
        createShape: 'FIXTURE_CREATE_DOCUMENT',
      }, 'create-primary-report', rootScopeId);
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          summary: 'The primary report is ready.',
          reply: 'The primary report is ready.',
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      } as never;
    }
    const siblingSlot = 'google_doc:appendix';
    artifactLedger.claimArtifactSlot(sess.id, {
      kind: 'google_doc',
      provider: 'Fixture Docs',
      slotKey: siblingSlot,
      title: 'Appendix',
      createShape: 'FIXTURE_CREATE_DOCUMENT',
    }, 'create-appendix', rootScopeId);
    artifactLedger.bindArtifactSlot(
      sess.id,
      siblingSlot,
      { resourceId: 'fixture-doc-appendix' },
      'create-appendix',
      rootScopeId,
    );
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'done=true / nextAction=completed',
        reply: 'done=true / nextAction=completed',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Create the primary report.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_user_input');
  const blocked = listEvents(sess.id, { types: ['guardrail_tripped'] })
    .find((event) => event.data.kind === 'self_reconciliation_blocked');
  assert.equal(blocked?.data.reason, 'artifact_reconciliation_remains_unresolved');
  const terminals = listEvents(sess.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.notEqual(terminals[0]?.data.delivered, true);
});

test('effect/artifact self-reconciliation preserves the verified public candidate when durable evidence settles', async () => {
  resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  const sess = HarnessSession.create({ kind: 'chat' });
  const verifiedAnswer = [
    'The workspace cadence report is ready and its workflow run completed successfully.',
    'Its durable record is complete and the two-hour schedule remains active.',
  ].join('\n');
  let calls = 0;
  let artifactId = '';
  const inputs: string[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    const input = items.at(-1) as { content?: string } | undefined;
    if (typeof input?.content === 'string') inputs.push(input.content);
    const sourceUserSeq = listEvents(sess.id, { types: ['user_input_received'] })[0]!.seq;
    if (calls <= 2) {
      if (calls === 1) {
        const claim = artifactLedger.claimArtifactSlot(sess.id, {
          kind: 'google_doc',
          provider: 'Fixture Docs',
          slotKey: 'google_doc:workspace-cadence',
          title: 'Workspace cadence report',
          createShape: 'FIXTURE_CREATE_DOCUMENT',
        }, 'create-workspace-cadence-report', `${sess.id}::turn:1`);
        artifactId = claim.artifact.id;
        const write = {
          sourceUserSeq,
          callId: 'effect-reconcile-write-1',
          actionKey: 'fixture:effect-write',
          shapeKey: 'FIXTURE_EFFECT_WRITE',
          targets: ['workspace-cadence'],
          correlationFingerprint: 'workspace-cadence:summary',
        };
        appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'external_write', data: write });
        appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'external_write_orphaned', data: write });
      }
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          summary: verifiedAnswer,
          reply: '',
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      } as never;
    }
    seedArtifactVerification(sess.id, 'verify-workspace-cadence', 'fixture-doc-workspace-cadence');
    const artifactSettlement = artifactLedger.resolveUncertainArtifactClaim(
      sess.id,
      artifactId,
      {
        kind: 'bind',
        resourceId: 'fixture-doc-workspace-cadence',
        verificationCallId: 'verify-workspace-cadence',
      },
    );
    assert.equal(artifactSettlement.ok, true);
    appendEvent({
      sessionId: sess.id,
      turn: calls,
      role: 'system',
      type: 'external_write_succeeded',
      data: {
        sourceUserSeq,
        callId: 'effect-reconcile-write-1',
        actionKey: 'fixture:effect-write',
        shapeKey: 'FIXTURE_EFFECT_WRITE',
        targets: ['workspace-cadence'],
        correlationFingerprint: 'workspace-cadence:summary',
        reason: 'reconciled_present',
      },
    });
    const internalProtocol = 'done=true / nextAction=completed';
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: internalProtocol,
        reply: internalProtocol,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Create the workspace cadence report, verify its workflow run, and give me the result.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 3, 'one missing-reply retry precedes the single reconciliation turn');
  assert.ok(inputs.some((input) => input.includes('[self-resolve]')));
  const terminals = listEvents(sess.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, 'one accepted request has one public terminal');
  assert.equal(terminals[0]?.data.reply, verifiedAnswer);
  assert.doesNotMatch(String(terminals[0]?.data.reply), /done\s*=|nextAction\s*=/i);
});

test('a completed reconciliation turn that asks a question pauses before the saved candidate can finalize', async () => {
  resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  const sess = HarnessSession.create({ kind: 'chat' });
  const savedCandidate = 'The requested report is ready.';
  const exactQuestion = 'Which verified report should I attach to the team summary?';
  let calls = 0;
  let artifactId = '';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    if (calls === 1) {
      const claim = artifactLedger.claimArtifactSlot(sess.id, {
        kind: 'google_doc',
        provider: 'Fixture Docs',
        slotKey: 'google_doc:question-before-reconciliation',
        title: 'Question ordering report',
        createShape: 'FIXTURE_CREATE_DOCUMENT',
      }, 'create-question-ordering-report', `${sess.id}::turn:1`);
      artifactId = claim.artifact.id;
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          summary: savedCandidate,
          reply: savedCandidate,
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      } as never;
    }

    seedArtifactVerification(sess.id, 'verify-question-ordering', 'fixture-doc-question-ordering');
    const settlement = artifactLedger.resolveUncertainArtifactClaim(
      sess.id,
      artifactId,
      {
        kind: 'bind',
        resourceId: 'fixture-doc-question-ordering',
        verificationCallId: 'verify-question-ordering',
      },
    );
    assert.equal(settlement.ok, true, 'the evidence is settled so the old ordering would falsely finalize');
    appendEvent({
      sessionId: sess.id,
      turn: 2,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: { question: exactQuestion, source: 'ask_user_question' },
    });
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'done=true / nextAction=completed',
        reply: 'done=true / nextAction=completed',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Create the report and attach the verified result to my team summary.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(calls, 2, 'the second completed SDK turn is the reconciliation node');
  assert.equal(result.status, 'awaiting_user_input', 'the typed question owns the terminal boundary');
  const terminals = listEvents(sess.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, 'the saved completion candidate is never committed first');
  assert.equal(terminals[0]?.data.reason, 'awaiting_user_input');
  assert.equal(terminals[0]?.data.reply, exactQuestion);
  assert.notEqual(terminals[0]?.data.reply, savedCandidate);
});

test('effect self-reconciliation that remains ambiguous returns one deterministic blocked terminal', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const verifiedAnswer = 'The workspace cadence workflow run completed successfully and its durable record is complete.';
  let calls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    const sourceUserSeq = listEvents(sess.id, { types: ['user_input_received'] })[0]!.seq;
    if (calls === 1) {
      const write = {
        sourceUserSeq,
        callId: 'effect-reconcile-write-unresolved',
        actionKey: 'fixture:effect-write',
        shapeKey: 'FIXTURE_EFFECT_WRITE',
        targets: ['workspace-cadence'],
        correlationFingerprint: 'workspace-cadence:unresolved',
      };
      appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'external_write', data: write });
      appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'external_write_orphaned', data: write });
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          summary: verifiedAnswer,
          reply: verifiedAnswer,
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      } as never;
    }
    const internalProtocol = 'done=true / nextAction=completed';
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: internalProtocol,
        reply: internalProtocol,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Check the latest workspace cadence workflow run and give me the verified result.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(calls, 2, 'the reconciliation attempt is bounded to one model continuation');
  const terminals = listEvents(sess.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, 'the ambiguous effect never gets a green terminal first');
  assert.equal(terminals[0]?.data.reason, 'blocked');
  assert.equal(terminals[0]?.data.delivered, false);
  assert.match(String(terminals[0]?.data.reply), /ambiguous external-write outcome|cannot honestly confirm/i);
  assert.doesNotMatch(String(terminals[0]?.data.reply), /done\s*=|nextAction\s*=/i);
});

test('non-reconciliation completion correction still replaces a rejected public candidate', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const rejected = 'The report is ready even though I have not created or verified it yet.';
  const corrected = 'The report is now created and verified at /tmp/workspace-cadence-report.html.';
  let calls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    const reply = calls === 1 ? rejected : corrected;
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: { summary: reply, reply, done: true, nextAction: 'completed', reason: null },
      toolCalls: calls === 2 ? 1 : 0,
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Create and verify the workspace cadence report.',
    judgeCompletion: true,
    judgeFn: async (_objective, response) => response.includes('/tmp/workspace-cadence-report.html')
      ? { done: true, reason: 'verified artifact is present' }
      : { done: false, reason: 'the artifact has not been created' },
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 2);
  const terminals = listEvents(sess.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.data.reply, corrected);
  assert.notEqual(terminals[0]?.data.reply, rejected);
});

// F-artifact (live 2026-07-23, the owner's own acceptance run): a BOUND claim
// — provider returned the resource, URI recorded, VALUES_UPDATE already
// writing to it — parked the run behind an unanswerable "reply retry" loop.
// Bound = deliverable: the run completes green; read-back verification rides
// as an advisory, never a wall.
test('standard lane completes green when the provider create is BOUND', async () => {
  resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  const sess = HarnessSession.create({ kind: 'chat' });
  const sheetUri = 'https://docs.google.com/spreadsheets/d/fixture_sheet_00000001/edit';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const source = listEvents(sess.id, { types: ['user_input_received'] }).at(-1)!;
    const rootScopeId = artifactLedger.resolveArtifactRunScopeId(sess.id, `${sess.id}::turn:1`, source.seq);
    const intent = {
      kind: 'google_sheet',
      provider: 'Google Sheets',
      slotKey: 'google_sheet:primary',
      title: 'Firm Outreach Drafts — Jul 23',
      createShape: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    } as const;
    artifactLedger.claimArtifactSlot(sess.id, intent, 'create-sheet', rootScopeId);
    artifactLedger.bindArtifactSlot(sess.id, intent.slotKey, { uri: sheetUri }, 'create-sheet', rootScopeId);
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Sheet created with all 20 drafts.',
        reply: `Done — all 20 drafts are in the sheet: ${sheetUri}`,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    };
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'put 20 firm outreach drafts in a google sheet',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed', 'a bound create never parks the completion');
  const asks = listEvents(sess.id, { types: ['awaiting_user_input'] })
    .filter((e) => e.data.source === 'artifact_verification_pending');
  assert.equal(asks.length, 0, 'no unanswerable retry check-in');
});

test('standard artifact pause lineage is inherited only by the immediate reply', async () => {
  resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  const sess = HarnessSession.create({ kind: 'chat' });
  const request = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the provider report.' },
  });
  const rootScopeId = artifactLedger.resolveArtifactRunScopeId(sess.id, 'standard:paused', request.seq);
  const intent = {
    kind: 'google_doc',
    provider: 'Google Docs',
    slotKey: 'google_doc:primary',
    title: 'Provider report',
    createShape: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
  } as const;
  artifactLedger.claimArtifactSlot(sess.id, intent, 'create-paused-doc', rootScopeId);
  artifactLedger.bindArtifactSlot(sess.id, intent.slotKey, {
    resourceId: 'doc_pause_lineage_123456789',
  }, 'create-paused-doc', rootScopeId);
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'awaiting_user_input',
      artifactRunScopeId: rootScopeId,
      artifactVerification: { status: 'pending' },
      summary: 'Reply retry to verify the exact provider resource.',
    },
  });

  const immediate = appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'retry' },
  });
  assert.equal(
    artifactLedger.resolveArtifactRunScopeId(sess.id, 'standard:immediate-reply', immediate.seq),
    rootScopeId,
    'the immediate reply inherits the exact typed pause root',
  );

  appendEvent({
    sessionId: sess.id,
    turn: 3,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Actually, hold that thought.' },
  });
  const later = appendEvent({
    sessionId: sess.id,
    turn: 4,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Start a separate unrelated report.' },
  });
  assert.notEqual(
    artifactLedger.resolveArtifactRunScopeId(sess.id, 'standard:after-intervening-input', later.seq),
    rootScopeId,
    'an intervening user input breaks the typed pause lineage',
  );
});

test('runConversation: stops on first completed decision', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'Answered the user directly',
        reply: 'The README should include setup, usage, and test commands.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'write a README',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(result.lastDecision?.done, true);

  const events = listEventsForConv(sess.id, { types: ['conversation_step', 'conversation_completed'] });
  assert.equal(events.filter((e) => e.type === 'conversation_step').length, 1);
  assert.equal(events.filter((e) => e.type === 'conversation_completed').length, 1);
  const source = listEventsForConv(sess.id, { types: ['user_input_received'] })[0];
  const graphs = listEventsForConv(sess.id, { types: ['turn_graph_compiled'] });
  assert.equal(graphs.length, 1, 'the direct standard lane observes its accepted source once');
  assert.equal(graphs[0].parentEventId, source.id);
  assert.equal(graphs[0].data.sourceUserSeq, source.seq);
  assert.equal((graphs[0].data.graph as { source?: { surface?: unknown } }).source?.surface, 'direct');
});

test('runConversation: an answer reaches the standard lane with non-coercive convergence state', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: 'Win-back queue or loss diagnosis?', source: 'decision_awaiting' },
  });
  let modelInput = '';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const last = items.at(-1) as { content?: unknown } | undefined;
    modelInput = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: 'Built the win-back queue and verified the saved workspace.',
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Use the win-back queue.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.match(modelInput, /CONVERGE/);
  assert.match(modelInput, /never re-ask the resolved point/);
  assert.match(modelInput, /not automatic permission for external writes or durable execution/);
  assert.doesNotMatch(modelInput, /EXECUTE the work this turn/);
  const recordedInputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.equal(recordedInputs.at(-1)?.data.text, 'Use the win-back queue.');
  assert.ok(recordedInputs.every((event) => !String(event.data.text ?? '').includes('CONVERGE')), 'internal convergence text never enters durable user history');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 1, 'no second question emitted');
  assert.equal(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length, 0);
});

test('runConversation: completed decision with empty reply is retried, not shown as an internal bug bubble', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let calls = 0;
  const inputs: string[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const last = items.at(-1) as { content?: string } | undefined;
    if (typeof last?.content === 'string') inputs.push(last.content);
    calls += 1;
    if (calls === 1) {
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          summary: 'Greeted user; awaiting their request.',
          reply: null,
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      };
    }
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Greeted the user.',
        reply: 'Hey - what would you like to work on?',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'hey hey',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2, 'one retry should recover the missing reply');
  assert.match(inputs.at(-1) ?? '', /NO visible answer/);
  const guardrails = listEventsForConv(sess.id, { types: ['guardrail_tripped'] });
  assert.ok(guardrails.some((e) => (e.data as { kind?: string }).kind === 'completed_without_reply'));
  const stepEvents = listEventsForConv(sess.id, { types: ['conversation_step'] });
  assert.equal(stepEvents.length, 1, 'the invalid empty-reply completion is retried before a visible step event');
  assert.doesNotMatch(JSON.stringify(stepEvents), /Greeted user; awaiting their request/);
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.summary, 'Hey - what would you like to work on?');
  assert.doesNotMatch(String(completed.data.summary), /marked the turn complete|Internal log|Greeted user/);
});

test('runConversation: exhausted empty-reply completion uses safe fallback, not internal diagnostic text', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'Greeted user; awaiting their request.',
        reply: null,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'hey hey',
    maxSteps: 1,
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.ok(['completed', 'awaiting_user_input'].includes(result.status));
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.summary, "I didn't produce a visible reply there. Please send that again and I'll retry.");
  assert.equal(completed.data.internalSummary, undefined, 'internal model summaries do not share the public terminal row');
  assert.equal((completed.data.turnOutcome as { status?: string }).status, 'done');
  assert.equal(completed.data.missingReply, true);
  const step = listEventsForConv(sess.id, { types: ['conversation_step'] }).at(-1)!;
  assert.equal((step.data.decision as { summary?: string }).summary, "I didn't produce a visible reply there. Please send that again and I'll retry.");
  assert.doesNotMatch(String(completed.data.summary), /marked the turn complete|Internal log|Greeted user/);
});

test('runConversation: reuseRecordedUserInput skips a duplicate user_input row on provider fallover', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'retry this turn' },
  });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'Recovered on fallback',
        reply: 'Recovered on fallback.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'retry this turn',
    makeRunner: makeRunnerStub,
    runRunner: runner,
    reuseRecordedUserInput: true,
  });

  assert.equal(result.status, 'completed');
  const inputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.equal(inputs.length, 1, 'fallback reused the Claude-recorded user input instead of duplicating it');
  assert.equal((inputs[0].data as { text?: string }).text, 'retry this turn');
});

test('runConversation: YOLO auto-resolved ask (autonomy_note + stray nextAction:awaiting_user_input) CONTINUES, never stuck', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let call = 0;
  const runRunner: RunRunnerFn = async () => {
    call += 1;
    if (call === 1) {
      // Simulate the ask_user_question tool auto-resolving under YOLO this turn:
      // it emits a non-halting autonomy_note (NOT awaiting_user_input)…
      appendEvent({
        sessionId: sess.id, turn: 1, role: 'Clem', type: 'autonomy_note',
        data: { autoResolved: 'yolo-standing-approval', question: 'send the rest?' },
      });
      // …but the model STILL sets nextAction:awaiting_user_input (the stray).
      return { history: [], lastResponseId: undefined, finalOutput: {
        summary: 'asked for sign-off (auto-resolved under YOLO)', reply: null,
        done: false, nextAction: 'awaiting_user_input', reason: null } };
    }
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'sent the remaining emails', reply: 'Sent the rest of the R&R emails.',
      done: true, nextAction: 'completed', reason: null } };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'send the rest',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed', 'must NOT strand on awaiting_user_input after a YOLO auto-proceed');
  assert.ok(call >= 2, 'the loop ran a second turn instead of halting');
  const reconciled = listEventsForConv(sess.id, { types: ['heartbeat'] })
    .some((e) => (e.data as { kind?: string } | undefined)?.kind === 'yolo_proceed_reconciled');
  assert.equal(reconciled, true, 'emits the yolo_proceed_reconciled telemetry');
});

test('runConversation: a GENUINE awaiting_user_input (no autonomy_note) still HALTS (no over-suppression)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // Genuine clarification: emits the halting event, NO autonomy_note.
    appendEvent({
      sessionId: sess.id, turn: 1, role: 'Clem', type: 'awaiting_user_input',
      data: { question: 'staging or prod?' },
    });
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'need to know which environment', reply: 'Staging or prod?',
      done: false, nextAction: 'awaiting_user_input', reason: null } };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'deploy it',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'genuine clarification must still halt');
});

test('runConversation: a DECISION-level awaiting (done:true + awaiting, NO ask_user_question) SYNTHESIZES the question event so surfaces deliver it (2026-06-14 Discord stranded-user fix)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // The model asks via its DECISION (reply carries the question) and sets
    // done:true + awaiting — but does NOT call ask_user_question, so it emits
    // NO awaiting_user_input event. Before the fix, Discord/SSE got nothing.
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'confirming which site', reply: 'Still on Stonemill Bakehouse, or another design?',
      done: true, nextAction: 'awaiting_user_input', reason: null } };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'finalize the website',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'still halts for the user');
  // The loop must have SYNTHESIZED an awaiting_user_input event carrying the
  // question so event-stream surfaces (Discord, desktop SSE) can render it.
  const askEvents = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(askEvents.length, 1, 'exactly one synthesized awaiting_user_input event');
  assert.match((askEvents[0].data as { question: string }).question, /Stonemill Bakehouse/);
  assert.equal((askEvents[0].data as { source?: string }).source, 'decision_awaiting');
});

test('runConversation: a DECISION-level awaiting_approval (no SDK interrupt) SYNTHESIZES a delivery event so surfaces are not stranded', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // The model self-reports awaiting_approval in its DECISION without an SDK
    // interrupt, so NO approval_requested event fires. Before the fix, every
    // event-stream surface rendered nothing (the symmetric awaiting hole).
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'need sign-off to send the batch', reply: 'Ready to send 12 emails — approve to proceed or tell me to stop?',
      done: true, nextAction: 'awaiting_approval', reason: null } };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'send the outreach batch',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_approval', 'still halts for approval');
  const askEvents = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(askEvents.length, 1, 'exactly one synthesized delivery event');
  assert.match((askEvents[0].data as { question: string }).question, /approve to proceed/);
  assert.equal((askEvents[0].data as { source?: string }).source, 'decision_awaiting_approval');
  assert.equal(result.publicPresentation?.kind, 'question', 'self-reporting approval cannot mint execution authority');
  assert.equal(result.publicPresentation?.status, 'needs_input');
  assert.equal(result.publicPresentation?.approvalId, undefined);
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' }).length, 0);
  assert.equal(listEventsForConv(sess.id, { types: ['conversation_completed'] }).length, 1);
});

test('runConversation: done:true + awaiting_handoff_result WITH prior tool work surfaces an ask, NOT a silent re-loop (Step 2 dead-end fix)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    // Real (non-probe) tool work this turn → toolCalls > 0, so the stall
    // detectors do NOT fire (they only catch the ZERO-meaningful-tools case).
    // This is EXACTLY the dead-end they miss — without the Step 2 handler it
    // would fall through to CONTINUATION_INPUT and re-loop until a budget cap.
    ee.emit('agent_start', runContext, { name: 'Orchestrator' });
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, { name: 'write_file' },
      { toolCall: { callId: 'call_1', arguments: '{"path":"/tmp/x"}' } });
    const decision = {
      summary: 'wrote the file, now waiting on the executor',
      reply: 'I prepared the changes — should I apply them or adjust first?',
      done: true,
      nextAction: 'awaiting_handoff_result',
      reason: null,
    };
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'apply the change', makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'surfaces an ask instead of silently re-looping');
  const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(asks.length, 1, 'exactly one synthesized ask');
  assert.equal((asks[0].data as { source?: string }).source, 'decision_awaiting_handoff_terminal');
  assert.match((asks[0].data as { question: string }).question, /prepared the changes/);
  // And it was NOT treated as a stall (no retry into the tool-only nudge).
  assert.equal(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length, 0);
});

test('runConversation: a tool-driven ask (ask_user_question already emitted the event) is NOT double-emitted', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async () => {
    // ask_user_question tool already emitted the halting event this turn.
    appendEvent({ sessionId: sess.id, turn: 1, role: 'Clem', type: 'awaiting_user_input', data: { question: 'staging or prod?' } });
    return { history: [], lastResponseId: undefined, finalOutput: {
      summary: 'asked', reply: 'Staging or prod?', done: false, nextAction: 'awaiting_user_input', reason: null } };
  };
  await runConversation({ agent: makeAgentStub(), sessionId: sess.id, input: 'deploy it', makeRunner: makeRunnerStub, runRunner });
  const askEvents = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.equal(askEvents.length, 1, 'no double-emit — the tool-emitted event is the only one');
});

test('runConversation: a tool-driven ask with an unparsed prose tail stops without retrying or re-asking', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let runs = 0;
  const runRunner: RunRunnerFn = async () => {
    runs += 1;
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: { question: 'Which audience should the brief target?' },
    });
    return {
      history: [],
      lastResponseId: undefined,
      finalOutput: "Waiting on your audience choice. I won't touch the file until you answer.",
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'write the brief after asking for its audience',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(runs, 1, 'the durable ask is terminal; no parse-recovery model turn');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 1);
  assert.equal(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length, 0);
});

test('runConversation: a completed-tagged ask_user_question tool result parks before validation or another turn', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let runs = 0;
  let judgeInvoked = false;
  const question = 'Railway authentication is missing. Run railway login, then reply continue so I can resume this same task.';
  const runRunner: RunRunnerFn = async () => {
    runs += 1;
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: { question },
    });
    return {
      history: [],
      lastResponseId: undefined,
      finalOutput: `Question posted: ${question}. Awaiting user reply.`,
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'prepare the Railway app, then deploy it',
    judgeCompletion: true,
    judgeFn: async () => {
      judgeInvoked = true;
      return { done: false, reason: 'deployment is waiting on authentication' };
    },
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(runs, 1, 'the terminal tool ask does not trigger another model turn');
  assert.equal(judgeInvoked, false, 'completion validation never sees a task that is durably waiting on the user');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 1);
});

test('objective judge: gates premature completion and continues (action intent)', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'Said what I would do', reply: 'Here is what I would do to build the report.', done: true, nextAction: 'completed', reason: null } },
    { finalOutput: { summary: 'Built the report', reply: 'Done — report saved to /tmp/report.md', done: true, nextAction: 'completed', reason: null } },
  ]);
  const judgeCalls: string[] = [];
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build me a research report on solar adoption',
    judgeCompletion: true,
    judgeFn: async (_objective, response) => {
      judgeCalls.push(response);
      return judgeCalls.length === 1 ? { done: false, reason: 'no artifact produced yet' } : { done: true, reason: 'report saved' };
    },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2, 'judge forced a second step before completing');
  assert.equal(judgeCalls.length, 2);
});

test('objective judge continuation does not quarantine a draft that later succeeds', async () => {
  const { loadSkill, writeDistilledSkill } = await import('../../memory/skill-store.js');
  const skillName = 'loop-continuation-draft';
  writeDistilledSkill({
    name: skillName,
    description: 'Build a research report from captured evidence.',
    body: 'Build the report and verify the final artifact.',
    origin: { kind: 'chat', sourceId: 'older-run' },
  });
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'assistant',
    type: 'tool_called',
    data: {
      tool: 'skill_read',
      callId: 'skill-loop-continuation',
      arguments: JSON.stringify({ name: skillName }),
    },
  });
  writeToolOutput({
    sessionId: sess.id,
    callId: 'skill-loop-continuation',
    tool: 'skill_read',
    output: `Loaded ${skillName}\n---\nBuild the report and verify the final artifact.`,
  });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'first pass', reply: 'The draft is not saved yet.', done: true, nextAction: 'completed', reason: null } },
    { finalOutput: { summary: 'finished', reply: 'Done — report saved to /tmp/final-report.md', done: true, nextAction: 'completed', reason: null } },
  ]);
  let judgeCalls = 0;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build me a research report',
    judgeCompletion: true,
    judgeFn: async () => {
      judgeCalls += 1;
      return judgeCalls === 1
        ? { done: false, reason: 'the report artifact is not saved yet' }
        : { done: true, reason: 'the report exists' };
    },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(result.status, 'completed');
  assert.equal(loadSkill(skillName)!.frontmatter.failureCount, 0);
  assert.equal(loadSkill(skillName)!.frontmatter.quarantined ?? false, false);
});

test('objective judge: a successful read cannot certify a claimed build', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  let judgeInvoked = false;
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    const tool = { name: 'read_file' };
    const details = { toolCall: { callId: 'read-only-1', arguments: '{"path":"README.md"}' } };
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, tool, details);
    ee.emit('agent_tool_end', runContext, { name: 'Orchestrator' }, tool, 'README contents', details);
    const decision = { summary: 'built', reply: 'Built the app.', done: true, nextAction: 'completed', reason: null };
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build the app',
    judgeCompletion: true,
    judgeFn: async () => { judgeInvoked = true; return { done: true, reason: 'verified by test' }; },
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(judgeInvoked, true);
});

test('objective judge: a successful concrete send slug is completion evidence', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  let judgeInvoked = false;
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    const tool = { name: 'composio_execute_tool' };
    const details = { toolCall: { callId: 'send-1', arguments: '{"tool_slug":"GMAIL_SEND_EMAIL"}' } };
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, tool, details);
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'system',
      type: 'external_write',
      data: { shapeKey: 'GMAIL_SEND_EMAIL', targets: ['fixture@example.invalid'] },
    });
    ee.emit('agent_tool_end', runContext, { name: 'Orchestrator' }, tool, 'sent', details);
    const decision = { summary: 'sent', reply: 'Sent the email.', done: true, nextAction: 'completed', reason: null };
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'send the email',
    judgeCompletion: true,
    judgeFn: async () => { judgeInvoked = true; return { done: false, reason: 'unexpected' }; },
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(judgeInvoked, false);
});

test('objective judge: schema-on-demand execution_complete preview is an accepted request-bound certificate', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let judgeCalls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    // call_tool dispatch records the inner execution as a transport-mirror
    // tool_returned event. Its exact controller result lives in `preview`, not
    // `result`; this is the shape emitted by a real live Sheets run.
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'system',
      type: 'tool_returned',
      data: {
        tool: 'execution_complete',
        callId: 'batch-execution-complete',
        batchMode: true,
        accounting: 'transport_mirror',
        preview: 'Execution exec-release-proof completed. Created the requested resource and verified the exact readback.',
      },
    });
    const decision = {
      summary: 'request completed and verified',
      reply: 'Completed the requested resource creation, population, and exact readback verification.',
      done: true,
      nextAction: 'completed',
      reason: null,
    };
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Create the resource, populate all requested records, and read them back exactly.',
    judgeCompletion: true,
    judgeFn: async () => {
      judgeCalls += 1;
      return { done: false, reason: 'should not re-judge an accepted execution certificate' };
    },
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(judgeCalls, 0, 'the execution controller already performed the completion judgment');
});

test('objective judge: one successful send does not certify a plural objective', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  let judgeInvoked = false;
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    const tool = { name: 'composio_execute_tool' };
    const details = { toolCall: { callId: 'send-1', arguments: '{"tool_slug":"GMAIL_SEND_EMAIL"}' } };
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, tool, details);
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'system',
      type: 'external_write',
      data: { shapeKey: 'GMAIL_SEND_EMAIL', targets: ['fixture@example.invalid'] },
    });
    ee.emit('agent_tool_end', runContext, { name: 'Orchestrator' }, tool, 'sent', details);
    const decision = { summary: 'sent', reply: 'Sent the emails.', done: true, nextAction: 'completed', reason: null };
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'send the 3 emails',
    judgeCompletion: true,
    judgeFn: async () => {
      judgeInvoked = true;
      return { done: true, reason: 'verified by test' };
    },
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(judgeInvoked, true);
});

test('objective judge: an upper-bound result count is not a quota after one meaningful lookup', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  let judgeInvoked = false;
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    const tool = { name: 'call_tool' };
    const details = {
      toolCall: {
        callId: 'bounded-lookup-1',
        arguments: JSON.stringify({
          name: 'dataforseo__dataforseo_labs_google_keyword_suggestions',
          args_json: '{"keyword":"clementine ai assistant","limit":3}',
        }),
      },
    };
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, tool, details);
    ee.emit(
      'agent_tool_end',
      runContext,
      { name: 'Orchestrator' },
      tool,
      '{"status_code":20000,"status_message":"Ok.","items":[]}',
      details,
    );
    const decision = {
      summary: 'zero verified suggestions',
      reply: 'The one permitted DataForSEO call completed successfully and returned zero suggestions.',
      done: true,
      nextAction: 'completed',
      reason: null,
    };
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Make one real read-only call and return up to three real suggestions. Do not retry.',
    judgeCompletion: true,
    judgeFn: async () => {
      judgeInvoked = true;
      return { done: false, reason: 'try another endpoint' };
    },
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(judgeInvoked, false, '"up to three" is a ceiling, so one verified lookup is concrete completion evidence');
});

test('objective judge: a false verdict cannot widen an exhausted one-attempt contract', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  let runs = 0;
  let judgeInvoked = false;
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    runs += 1;
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    const tool = { name: 'call_tool' };
    const details = {
      toolCall: {
        callId: 'exact-one-lookup',
        arguments: JSON.stringify({
          name: 'dataforseo__dataforseo_labs_google_keyword_suggestions',
          args_json: '{"keyword":"clementine ai assistant","limit":3}',
        }),
      },
    };
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, tool, details);
    ee.emit(
      'agent_tool_end',
      runContext,
      { name: 'Orchestrator' },
      tool,
      '{"status_code":20000,"status_message":"Ok.","items":[]}',
      details,
    );
    const decision = {
      summary: 'zero verified suggestions',
      reply: 'The endpoint returned zero suggestions for the exact query after the one allowed call.',
      done: true,
      nextAction: 'completed',
      reason: null,
    };
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Make exactly one read-only call and return exactly three suggestions. Do not retry.',
    judgeCompletion: true,
    judgeFn: async () => {
      judgeInvoked = true;
      return { done: false, reason: 'Try an alternate tool to find three suggestions.' };
    },
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(runs, 1, 'the verifier cannot authorize a second model/tool turn');
  assert.equal(judgeInvoked, true, 'the plural exact-count objective is still audited');
  const completion = listEventsForConv(sess.id, { types: ['verdict_recorded'] })
    .find((event) => event.data.door === 'completion');
  assert.equal(completion?.data.pass, true);
  assert.match(String(completion?.data.reason), /verification cannot authorize another attempt/i);
});

test('request-bound write evidence: stale execution receipts cannot certify a fresh external write', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'GOOGLESHEETS_VALUES_UPDATE', targets: ['Sheet1!E1:G5'], receipt: 'old-write-123' },
  });
  let runs = 0;
  const modelInputs: string[] = [];
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    runs += 1;
    const last = items.at(-1) as { content?: unknown } | undefined;
    modelInputs.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''));
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    if (runs === 1) {
      const tool = { name: 'execution_get' };
      const details = { toolCall: { callId: 'stale-exec-get', arguments: '{"id":"exec-old"}' } };
      ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, tool, details);
      ee.emit(
        'agent_tool_end',
        runContext,
        { name: 'Orchestrator' },
        tool,
        'Execution exec-old completed with receipt old-write-123 and readback old-read-456.',
        details,
      );
      const decision = {
        summary: 'PASS using prior receipts',
        reply: 'PASS — write old-write-123 and readback old-read-456 prove the range is correct.',
        done: true,
        nextAction: 'completed',
        reason: null,
      };
      ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
      return { history: items, lastResponseId: undefined, finalOutput: decision };
    }

    const writeTool = { name: 'composio_execute_tool' };
    const writeDetails = {
      toolCall: {
        callId: 'fresh-sheet-write',
        arguments: '{"tool_slug":"GOOGLESHEETS_VALUES_UPDATE","arguments":{"range":"Sheet1!E1:G5"}}',
      },
    };
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, writeTool, writeDetails);
    appendEvent({
      sessionId: sess.id,
      turn: 2,
      role: 'system',
      type: 'external_write',
      data: { shapeKey: 'GOOGLESHEETS_VALUES_UPDATE', targets: ['Sheet1!E1:G5'], receipt: 'fresh-write-789' },
    });
    ee.emit('agent_tool_end', runContext, { name: 'Orchestrator' }, writeTool, 'fresh write receipt fresh-write-789', writeDetails);
    const readDetails = {
      toolCall: {
        callId: 'fresh-sheet-read',
        arguments: '{"tool_slug":"GOOGLESHEETS_BATCH_GET","arguments":{"ranges":["Sheet1!E1:G5"]}}',
      },
    };
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, writeTool, readDetails);
    ee.emit('agent_tool_end', runContext, { name: 'Orchestrator' }, writeTool, 'fresh readback receipt fresh-read-987 exact match', readDetails);
    const decision = {
      summary: 'fresh write verified',
      reply: 'PASS — fresh write receipt fresh-write-789 and readback fresh-read-987 match exactly.',
      done: true,
      nextAction: 'completed',
      reason: null,
    };
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Perform exactly one fresh Google Sheets value write to Sheet1!E1:G5 and read it back.',
    judgeCompletion: true,
    judgeFn: async () => ({ done: true, reason: 'the cited receipts look valid' }),
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(runs, 2, 'the stale PASS must be bounced exactly once');
  assert.match(modelInputs[1] ?? '', /no external-write receipt exists after source user event/i);
  const requestWrites = listEventsForConv(sess.id, { types: ['external_write'] });
  assert.equal(requestWrites.length, 2, 'one historical fixture + exactly one fresh write');
  const completionVerdicts = listEventsForConv(sess.id, { types: ['verdict_recorded'] })
    .filter((event) => event.data.door === 'completion');
  assert.equal(completionVerdicts[0]?.data.pass, false, 'the language-model PASS is deterministically overridden');
  assert.match(String(completionVerdicts[0]?.data.reason ?? ''), /historical execution summaries/i);
  const deliveryVerdicts = listEventsForConv(sess.id, { types: ['verdict_recorded'] })
    .filter((event) => event.data.door === 'delivery');
  assert.equal(deliveryVerdicts.at(-1)?.data.pass, true);
});

test('request-bound write evidence: exhausted verification never false-greens a stale PASS', async () => {
  resetEventLog();
  const prev = process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
  process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = '0';
  try {
    const sess = HarnessSession.create({ kind: 'chat' });
    const runner = scriptedRunner([
      {
        finalOutput: {
          summary: 'PASS using an old execution',
          reply: 'PASS — prior receipt old-write-123 proves the new Sheet write completed.',
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      },
    ]);
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'Perform one fresh Google Sheets write now.',
      judgeCompletion: true,
      judgeFn: async () => ({ done: true, reason: 'accepted stale claim' }),
      makeRunner: makeRunnerStub,
      runRunner: runner,
    });
    assert.equal(result.status, 'awaiting_user_input');
    const terminal = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
    assert.equal(terminal.data.delivered, false);
    assert.match(String(terminal.data.summary), /no write receipt exists after your current request/i);
    assert.doesNotMatch(String(terminal.data.reply), /^PASS\b/);
    const trips = listEventsForConv(sess.id, { types: ['guardrail_tripped'] });
    assert.ok(trips.some((event) => event.data.kind === 'request_bound_external_write_missing'));
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
    else process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = prev;
  }
});

test('request-bound write evidence: a direct communication command requires a current receipt', async () => {
  resetEventLog();
  const prev = process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
  process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = '0';
  try {
    const sess = HarnessSession.create({ kind: 'chat' });
    const runner = scriptedRunner([{
      finalOutput: {
        summary: 'email sent',
        reply: 'Done — I emailed the prospect.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    }]);
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'Email the prospect.',
      judgeCompletion: true,
      judgeFn: async () => ({ done: true, reason: 'accepted unsupported claim' }),
      makeRunner: makeRunnerStub,
      runRunner: runner,
    });
    assert.equal(result.status, 'awaiting_user_input');
    const terminal = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
    assert.equal(terminal.data.delivered, false);
    assert.match(String(terminal.data.summary), /no write receipt exists after your current request/i);
    const trips = listEventsForConv(sess.id, { types: ['guardrail_tripped'] });
    assert.ok(trips.some((event) => event.data.kind === 'request_bound_external_write_missing'));
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
    else process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = prev;
  }
});

test('request-bound write evidence: a direct invitation response cannot false-complete without a receipt', async () => {
  resetEventLog();
  const prev = process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
  process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = '0';
  try {
    const sess = HarnessSession.create({ kind: 'chat' });
    const runner = scriptedRunner([{
      finalOutput: {
        summary: 'invitation accepted',
        reply: 'Done — I RSVP’d yes to the invitation.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    }]);
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'RSVP yes to the invitation.',
      judgeCompletion: true,
      judgeFn: async () => ({ done: true, reason: 'accepted unsupported claim' }),
      makeRunner: makeRunnerStub,
      runRunner: runner,
    });
    assert.equal(result.status, 'awaiting_user_input');
    const terminal = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
    assert.equal(terminal.data.delivered, false);
    assert.match(String(terminal.data.summary), /no write receipt exists after your current request/i);
    const trips = listEventsForConv(sess.id, { types: ['guardrail_tripped'] });
    assert.ok(trips.some((event) => event.data.kind === 'request_bound_external_write_missing'));
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
    else process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = prev;
  }
});

test('request-bound write evidence: an overlapping request completion cannot certify this request', async () => {
  resetEventLog();
  const prev = process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
  process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = '0';
  try {
    const sess = HarnessSession.create({ kind: 'chat' });
    const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
      const foreignSource = appendEvent({
        sessionId: sess.id,
        turn: 2,
        role: 'user',
        type: 'user_input_received',
        data: { text: 'Unrelated overlapping request B.' },
      });
      appendEvent({
        sessionId: sess.id,
        turn: 2,
        role: 'tool',
        type: 'tool_returned',
        data: {
          sourceUserSeq: foreignSource.seq,
          tool: 'execution_complete',
          callId: 'foreign-execution-complete',
          preview: 'Execution exec-b completed. Request B has verified receipts.',
        },
      });
      assert.notEqual(
        foreignSource.seq,
        (opts.context as { sourceUserSeq?: number }).sourceUserSeq,
      );
      const decision = {
        summary: 'PASS using request B',
        reply: 'PASS — the execution certificate proves the requested write completed.',
        done: true,
        nextAction: 'completed',
        reason: null,
      };
      return { history: items, lastResponseId: undefined, finalOutput: decision };
    };

    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'Perform one fresh Google Sheets write for request A.',
      judgeCompletion: true,
      judgeFn: async () => ({ done: true, reason: 'accepted foreign execution certificate' }),
      makeRunner: makeRunnerStub,
      runRunner,
    });

    assert.equal(result.status, 'awaiting_user_input');
    const terminal = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
    assert.equal(terminal.data.delivered, false);
    assert.match(String(terminal.data.summary), /no write receipt exists after your current request/i);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
    else process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = prev;
  }
});

test('request-bound write evidence: an accepted execution cannot hide a mixed orphaned write', async () => {
  resetEventLog();
  const prev = process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
  process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = '0';
  try {
    const sess = HarnessSession.create({ kind: 'chat' });
    const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'system',
        type: 'external_write',
        data: {
          callId: 'send-a',
          shapeKey: 'OUTLOOK_SEND_EMAIL',
          targets: ['a@example.com'],
        },
      });
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'system',
        type: 'external_write',
        data: {
          callId: 'send-b',
          shapeKey: 'OUTLOOK_SEND_EMAIL',
          targets: ['b@example.com'],
        },
      });
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'system',
        type: 'external_write_orphaned',
        data: {
          callId: 'send-b',
          shapeKey: 'OUTLOOK_SEND_EMAIL',
          targets: ['b@example.com'],
        },
      });
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'system',
        type: 'tool_returned',
        data: {
          tool: 'execution_complete',
          callId: 'execution-complete-mixed',
          preview: 'Execution exec-mixed completed. All requested sends passed validation.',
        },
      });
      const decision = {
        summary: 'sent both emails',
        reply: 'Sent both emails successfully.',
        done: true,
        nextAction: 'completed',
        reason: null,
      };
      return { history: items, lastResponseId: undefined, finalOutput: decision };
    };

    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'Send one email to a@example.com and one email to b@example.com.',
      judgeCompletion: true,
      judgeFn: async () => ({ done: true, reason: 'accepted execution certificate' }),
      makeRunner: makeRunnerStub,
      runRunner,
    });

    assert.equal(result.status, 'awaiting_user_input');
    const terminal = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
    assert.equal(terminal.data.delivered, false);
    assert.match(String(terminal.data.summary), /ambiguous outcome/i);
    assert.doesNotMatch(String(terminal.data.reply), /Sent both emails successfully/i);
    const trip = listEventsForConv(sess.id, { types: ['guardrail_tripped'] })
      .find((event) => event.data.kind === 'request_bound_external_write_missing');
    assert.equal(trip?.data.status, 'ambiguous');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
    else process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = prev;
  }
});

test('objective judge: fail-open accepted completions are tagged in conversation_completed', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'done', reply: 'Done — report saved to /tmp/report.md', done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build me a research report on solar adoption',
    judgeCompletion: true,
    judgeFn: async () => ({ done: true, reason: 'judge timed out — accepting completion', failedOpen: true }),
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.delivered, true);
  assert.equal((completed.data.verification as { failedOpen?: boolean } | undefined)?.failedOpen, true);
});

test('objective judge: does NOT fire for a non-action (lookup) intent', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'answered', reply: 'Paris.', done: true, nextAction: 'completed', reason: null } },
  ]);
  let judgeInvoked = false;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'what is the capital of France',
    judgeCompletion: true,
    judgeFn: async () => { judgeInvoked = true; return { done: false, reason: 'x' }; },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(judgeInvoked, false, 'lookup intent must not invoke the objective judge');
});

test('honest-completion: a blocked/error-stub final reply does NOT bank as completed', async () => {
  // The Done? trust-killer: a turn that ends "I can't proceed without your
  // approval" previously returned status=completed (false green). The ungated
  // blocked-text backstop converts it to the honest awaiting_user_input.
  const sess = HarnessSession.create({ kind: 'workflow' }); // non-opted-in lane (judge never runs)
  const runner = scriptedRunner([
    { finalOutput: { summary: 'blocked', reply: 'I cannot complete this task — I need your approval to send.', done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'send the campaign',
    makeRunner: makeRunnerStub, runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'blocked reply must not report completed');
  const completed = listEvents(sess.id, { types: ['conversation_completed'] });
  assert.equal(completed.at(-1)!.data.delivered, false, 'event marked not-delivered');
  assert.ok(completed.at(-1)!.data.blockedReason, 'blockedReason recorded');
});

test('honest-completion: a promise-shaped final reply is judged before banking completion', async () => {
  const sess = HarnessSession.create({ kind: 'workflow' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'promised', reply: "I'll prep those contacts and get them over next.", done: true, nextAction: 'completed', reason: null } },
  ]);
  const judgeCalls: Array<{ objective: string; response: string }> = [];
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'prep the contacts',
    judgeFn: async (objective, response) => {
      judgeCalls.push({ objective, response });
      return { done: false, reason: 'no artifact produced' };
    },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'promise-shaped reply must not false-green');
  assert.equal(judgeCalls.length, 1, 'promise-shaped completion used the delivery judge');
  assert.match(judgeCalls[0].objective, /prep the contacts/i);
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.delivered, false);
  assert.match(String(completed.data.blockedReason), /no artifact produced/i);
});

test('honest-completion: promise-shaped fail-open acceptance is tagged, not silently green', async () => {
  const sess = HarnessSession.create({ kind: 'workflow' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'promised', reply: "I'll prep those contacts and get them over next.", done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'prep the contacts',
    judgeFn: async () => ({ done: true, reason: 'judge timed out — accepting completion', failedOpen: true }),
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.delivered, true);
  assert.equal((completed.data.verification as { failedOpen?: boolean } | undefined)?.failedOpen, true);
});

test('done-invariant: done:true + nextAction:awaiting_user_input does NOT bank completed', async () => {
  // `done` and `nextAction` are independent schema fields; a contradictory
  // done:true + awaiting_user_input must honor the conservative awaiting state.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'contradiction', reply: 'All set!', done: true, nextAction: 'awaiting_user_input', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'do the thing',
    makeRunner: makeRunnerStub, runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'contradiction → honor awaiting, not completed');
  const trips = listEvents(sess.id, { types: ['guardrail_tripped'] }).filter((e) => e.data.kind === 'done_invariant');
  assert.equal(trips.length, 1, 'done_invariant guardrail recorded');
});

test('honest-completion: a normal delivered reply still completes (delivered:true)', async () => {
  const sess = HarnessSession.create({ kind: 'workflow' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'done', reply: 'Done — report saved to /tmp/report.md', done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'build the report',
    makeRunner: makeRunnerStub, runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!.data.delivered, true);
});

test('honest-completion: the live RESUME path (runConversationFromResume) also guards blocked replies', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeBlockedTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-blocked' });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'send the approved draft' },
  });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'one draft',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'X', arguments: '{}' },
  });
  const runRunner: RunRunnerFn = async () => ({
    history: [], lastResponseId: undefined,
    finalOutput: { done: true, nextAction: 'completed', reply: 'I am blocked — I need your approval to proceed.', summary: 'blocked', reason: null },
  });
  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'resume blocked reply must not bank completed');
  assert.equal(listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!.data.delivered, false);
});

test('runConversationFromResume: completed decision with empty reply is retried before surfacing', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeMissingReplyTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-missing-reply' });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'one draft',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'X', arguments: '{}' },
  });
  let calls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    if (calls === 1) {
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          done: true,
          nextAction: 'completed',
          reply: null,
          summary: 'Resumed approval; awaiting user request.',
          reason: null,
        },
      };
    }
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        done: true,
        nextAction: 'completed',
        reply: 'Approved - continuing with the next step.',
        summary: 'Recovered missing reply.',
        reason: null,
      },
    };
  };

  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2);
  const guardrails = listEvents(sess.id, { types: ['guardrail_tripped'] });
  assert.ok(guardrails.some((e) => (e.data as { kind?: string; path?: string }).kind === 'completed_without_reply'
    && (e.data as { path?: string }).path === 'resume'));
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.summary, 'Approved - continuing with the next step.');
  assert.doesNotMatch(String(completed.data.summary), /marked the turn complete|Internal log|Resumed approval/);
});

test('runConversationFromResume retains one outer attempt through the approved state and continuations', async () => {
  resetEventLog();
  const previousBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const agent = new Agent({ name: 'ResumeAttemptIdentityTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-attempt-identity' });
  const attempt = beginRunAttempt(sess.id, { runId: 'workflow-step-attempt-identity' });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool',
    callId: 'c1',
    argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'one exact action',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'X', arguments: '{}' },
  });
  const observedAttemptIds: Array<string | undefined> = [];
  let calls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    observedAttemptIds.push(harnessRunContextStorage.getStore()?.runAttemptId);
    calls += 1;
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: calls === 1
        ? {
            done: false,
            nextAction: 'awaiting_handoff_result',
            reply: 'Approved — continuing.',
            summary: 'Approval resumed.',
            reason: null,
          }
        : {
            done: true,
            nextAction: 'completed',
            reply: 'The approved action and follow-up are complete.',
            summary: 'Completed after approval.',
            reason: null,
          },
    };
  };

  try {
    const result = await runConversationFromResume({
      agent,
      sessionId: sess.id,
      runAttemptId: attempt.attemptId,
      decision: 'approve',
      resolver: 'unit-test',
      makeRunner: makeRunnerStub,
      runRunner,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(
      observedAttemptIds,
      [attempt.attemptId, attempt.attemptId],
      'the resumed SDK state and its synthetic continuation retain the same outer attempt',
    );
  } finally {
    finishRunAttempt(attempt, 'completed');
    if (previousBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = previousBrackets;
  }
});

test('honest-completion: RESUME path judges promise-shaped final replies before banking completion', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumePromiseTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-promise' });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'pull the latest records' },
  });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'one draft',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'X', arguments: '{}' },
  });
  const runRunner: RunRunnerFn = async () => ({
    history: [], lastResponseId: undefined,
    finalOutput: { done: true, nextAction: 'completed', reply: "I'll pull those records next.", summary: 'promised', reason: null },
  });
  const judgeCalls: Array<{ objective: string; response: string }> = [];
  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    judgeFn: async (objective, response) => {
      judgeCalls.push({ objective, response });
      return { done: false, reason: 'no records were returned' };
    },
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'resume promise-shaped reply must not bank completed');
  assert.equal(judgeCalls.length, 1);
  assert.match(judgeCalls[0].objective, /pull the latest records/i);
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.delivered, false);
  assert.match(String(completed.data.blockedReason), /no records were returned/i);
});

test('resume budget exit emits the PAIRED conversation_completed (bare limit event hangs the chat dock / Discord)', async () => {
  resetEventLog();
  const agent = new Agent({ name: 'ResumeBudgetTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-budget' });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'one draft',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'X', arguments: '{}' },
  });
  // The resumed turn (and every continuation) keeps working → the loop runs to maxSteps.
  const recurseForever = scriptedRunner([
    { finalOutput: { summary: 'still working', done: false, nextAction: 'awaiting_handoff_result', reason: null } },
  ]);
  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    maxSteps: 3,
    makeRunner: makeRunnerStub, runRunner: recurseForever,
  });
  assert.equal(result.status, 'limit_exceeded');
  // The audit event AND the paired user-facing completion must BOTH be present —
  // the clients (chat.ts isTerminalEvent, console.ts SSE, Discord) treat a bare
  // conversation_limit_exceeded as NON-terminal and wait for the pair, so a bare
  // emit on the resume path hangs the surface until its idle/safety timeout.
  assert.ok(listEventsForConv(sess.id, { types: ['conversation_limit_exceeded'] }).length >= 1, 'audit limit event present');
  const paired = listEventsForConv(sess.id, { types: ['conversation_completed'] })
    .find((e) => (e.data as { reason?: unknown }).reason === 'awaiting_continue');
  assert.ok(paired, 'resume budget exit MUST emit a paired conversation_completed(reason=awaiting_continue)');
});

test('resume path: narration-deferral in a continuation turn is force-corrected (was an UNGUARDED path)', async () => {
  // Audit 2026-06-16, headline gap: runConversationFromResumeCore never called
  // evaluateStructuredDecisionStall, so EVERY stall detector (narration-deferral,
  // zero-tool false-completion) was bypassed the moment a user approved an action.
  // A post-approval continuation turn that narration-defers (awaiting_handoff_result,
  // zero tools) must now be force-corrected in the resume path too.
  resetEventLog();
  const agent = new Agent({ name: 'ResumeDeferralTest', instructions: 'test' });
  const sess = HarnessSession.create({ kind: 'chat', title: 'resume-deferral' });
  sess.saveInterruptState(makeApprovalRunStateWithInterruptions(agent, [{
    toolName: 'composio_execute_tool', callId: 'c1', argumentsJson: JSON.stringify({ tool_slug: 'X', arguments: '{}' }),
  }]));
  approvalRegistry.register({
    sessionId: sess.id,
    subject: 'the pull',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'X', arguments: '{}' },
  });
  let i = 0;
  const scripted: unknown[] = [
    // #1 the approved turn resumes; not done yet → drives the continuation loop.
    { done: false, nextAction: 'awaiting_handoff_result', reply: 'Approved — continuing.', summary: 'resumed after approval', reason: null },
    // #2 CONTINUATION narration-deferral with zero tools — must be caught in the resume path.
    { done: false, nextAction: 'awaiting_handoff_result', reply: 'On it — running the pull now. One sec.', summary: 'about to pull', reason: null },
    // #3 forced retry → clean completion (neutral reply that trips no detector).
    { done: true, nextAction: 'completed', reply: 'Here are the 12 records.', summary: 'Returned the records.', reason: null },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const o = scripted[i] ?? scripted[scripted.length - 1]; i += 1;
    return { history: items, lastResponseId: undefined, finalOutput: o };
  };
  const result = await runConversationFromResume({
    agent, sessionId: sess.id, decision: 'approve', resolver: 'unit-test',
    makeRunner: makeRunnerStub, runRunner,
  });
  const stuck = listEvents(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuck.length >= 1, 'resume continuation narration-deferral must be caught');
  assert.equal((stuck[0].data as { kind: string }).kind, 'structured_narration_deferral');
  const resumeRetry = listEvents(sess.id, { types: ['stall_retry_attempted'] })
    .filter((e) => (e.data as { path?: string }).path === 'resume');
  assert.ok(resumeRetry.length >= 1, 'a resume-path stall retry fired');
  assert.equal(result.status, 'completed');
});

test('honest-completion: kill-switch off leaves blocked text completing (byte-identical)', async () => {
  const prev = process.env.CLEMMY_VERIFY_DELIVERED;
  process.env.CLEMMY_VERIFY_DELIVERED = 'off';
  try {
    const sess = HarnessSession.create({ kind: 'workflow' });
    const runner = scriptedRunner([
      { finalOutput: { summary: 'blocked', reply: 'I cannot complete this task without approval.', done: true, nextAction: 'completed', reason: null } },
    ]);
    const result = await runConversation({
      agent: makeAgentStub(), sessionId: sess.id, input: 'send it',
      makeRunner: makeRunnerStub, runRunner: runner,
    });
    assert.equal(result.status, 'completed', 'disabled → prior behavior');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_VERIFY_DELIVERED;
    else process.env.CLEMMY_VERIFY_DELIVERED = prev;
  }
});

test('objective judge: off by default for non-promise answer (no judgeCompletion opt-in)', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'said what I would do', reply: 'Here is what I would do.', done: true, nextAction: 'completed', reason: null } },
  ]);
  let judgeInvoked = false;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build me a research report on solar adoption',
    judgeFn: async () => { judgeInvoked = true; return { done: false, reason: 'x' }; },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(judgeInvoked, false, 'plain delivered reply must not invoke the judge unless judgeCompletion is opted in');
});

test('objective judge: continuation budget caps retries, then delivery verifier blocks a remaining promise', async () => {
  // Pin the budget explicitly (default dropped 3→2 for token thrift, Phase 3) so
  // this is hermetic against the live .env and documents the knob.
  const prevMax = process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
  process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = '2';
  try {
    const sess = HarnessSession.create({ kind: 'chat' });
    const premature = { finalOutput: { summary: 'promised again', reply: 'I will do it.', done: true, nextAction: 'completed', reason: null } };
    const runner = scriptedRunner([premature, premature, premature, premature, premature]);
    let judgeCalls = 0;
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'build me a research report on solar adoption',
      judgeCompletion: true,
      judgeFn: async () => { judgeCalls++; return { done: false, reason: 'still nothing produced' }; },
      makeRunner: makeRunnerStub,
      runRunner: runner,
    });
    assert.equal(result.status, 'awaiting_user_input');
    assert.equal(judgeCalls, 3, '2 judge-forced continuations + 1 final delivery verification');
    assert.equal(result.steps, 3, '2 judge-forced continuations + the final not-delivered boundary');
    const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
    assert.equal(completed.data.delivered, false);
    assert.match(String(completed.data.blockedReason), /still nothing produced/i);
  } finally {
    if (prevMax === undefined) delete process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS;
    else process.env.CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS = prevMax;
  }
});

test('runConversation: recurses through done=false steps until done=true', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'handed off to Researcher for step 1',
        done: false,
        nextAction: 'awaiting_handoff_result',
        reason: null,
      },
    },
    {
      finalOutput: {
        summary: 'handed off to Executor for step 2',
        done: false,
        nextAction: 'awaiting_handoff_result',
        reason: null,
      },
    },
    {
      finalOutput: {
        summary: 'all three steps complete, sheet created',
        reply: 'All three steps complete; sheet created.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'find 20 accounts, scrape, build a sheet',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 3);
  assert.equal(result.lastDecision?.done, true);

  const stepEvents = listEventsForConv(sess.id, { types: ['conversation_step'] });
  assert.equal(stepEvents.length, 3);
  assert.equal(stepEvents[0].data.step, 1);
  assert.equal(stepEvents[1].data.step, 2);
  assert.equal(stepEvents[2].data.step, 3);
});

test('runConversation: stops with awaiting_user_input when the orchestrator asks', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'need clarification before I can proceed',
        done: false,
        nextAction: 'awaiting_user_input',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do something ambiguous',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(result.steps, 1);
});

test('runConversation: a queued approval-bound question materializes one linked card without another model turn', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let calls = 0;
  let pendingActionId = '';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    if (calls === 1) {
      const source = listEvents(sess.id, { types: ['user_input_received'] }).at(-1)!;
      const record = queuePendingAction({
        title: 'Proof send',
        summary: 'Queue one exact external send before approval.',
        kind: 'external_send',
        toolName: 'composio_execute_tool',
        payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
        targetSummary: 'proof@example.com',
        sessionId: sess.id,
      });
      pendingActionId = record.id;
      appendEvent({
        sessionId: sess.id,
        turn: 0,
        role: 'Clem',
        type: 'autonomy_note',
        data: {
          kind: 'pending_action_queued',
          pendingActionId,
          actionKind: 'external_send',
          approvalRequired: true,
          sourceUserSeq: source.seq,
          payloadHash: record.payloadHash,
        },
      });
      assert.ok(source.seq > 0);
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          summary: 'The exact send is queued. Should I proceed?',
          reply: 'The exact send is queued. Should I proceed?',
          done: false,
          nextAction: 'awaiting_user_input',
          reason: null,
        },
      } as never;
    }
    throw new Error('the graph edge must not spend another model turn');
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Queue this email and ask whether I want it sent.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  assert.equal(calls, 1);
  assert.equal(
    listEvents(sess.id, { types: ['heartbeat'] })
      .filter((event) => event.data.kind === 'pending_action_transition_materialized').length,
    1,
  );
  const approvals = listEvents(sess.id, { types: ['approval_requested'] });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].data.tool, 'request_approval');
  assert.equal((approvals[0].data.args as { pendingActionId?: string }).pendingActionId, pendingActionId);
  assert.equal(getPendingAction(pendingActionId)?.status, 'approval_requested');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' }).length, 1);
  assert.equal(listEvents(sess.id, { types: ['approval_parked'] }).length, 1);
});

test('runConversation: one request materializes distinct queued payloads and collapses an exact retry in one model turn', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let calls = 0;
  let calendarId = '';
  let calendarRetryId = '';
  let airtableId = '';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    const source = listEvents(sess.id, { types: ['user_input_received'] }).at(-1)!;
    const calendarInput = {
      title: 'Create launch review calendar event',
      summary: 'Create the exact reviewed launch event.',
      kind: 'external_write' as const,
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GOOGLECALENDAR_CREATE_EVENT',
        arguments: { title: 'Launch review', start: '2026-08-01T09:00:00-07:00' },
      },
      sessionId: sess.id,
    };
    const calendar = queuePendingAction(calendarInput);
    const calendarRetry = queuePendingAction({
      ...calendarInput,
      title: 'Retry create launch review calendar event',
    });
    const airtable = queuePendingAction({
      title: 'Create launch review Airtable record',
      summary: 'Create the exact reviewed launch record.',
      kind: 'external_write',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'AIRTABLE_CREATE_RECORD',
        arguments: { table: 'Content Calendar', title: 'Launch review', status: 'Planned' },
      },
      sessionId: sess.id,
    });
    calendarId = calendar.id;
    calendarRetryId = calendarRetry.id;
    airtableId = airtable.id;
    for (const record of [calendar, calendarRetry, airtable]) {
      appendEvent({
        sessionId: sess.id,
        turn: 0,
        role: 'Clem',
        type: 'autonomy_note',
        data: {
          kind: 'pending_action_queued',
          pendingActionId: record.id,
          actionKind: record.kind,
          approvalRequired: true,
          sourceUserSeq: source.seq,
          payloadHash: record.payloadHash,
        },
      });
    }
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Both exact actions are queued. Should I proceed?',
        reply: 'Both exact actions are queued. Should I proceed?',
        done: false,
        nextAction: 'awaiting_user_input',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Add the launch review to Calendar and Airtable.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  assert.equal(calls, 1, 'all distinct approval edges materialize without another model turn');
  assert.equal(
    listEvents(sess.id, { types: ['heartbeat'] })
      .filter((event) => event.data.kind === 'pending_action_transition_materialized').length,
    2,
  );
  assert.equal(listEvents(sess.id, { types: ['approval_requested'] }).length, 2);
  assert.equal(listEvents(sess.id, { types: ['approval_parked'] }).length, 2);
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' }).length, 2);
  assert.equal(getPendingAction(calendarId)?.status, 'approval_requested');
  assert.equal(getPendingAction(calendarRetryId)?.status, 'cancelled');
  assert.equal(getPendingAction(airtableId)?.status, 'approval_requested');
  const linkedIds = new Set(
    approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' })
      .map((row) => row.args?.pendingActionId),
  );
  assert.deepEqual(linkedIds, new Set([calendarId, airtableId]));
});

test('runConversation: a missing-scope question keeps a prematurely queued payload inert', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let pendingActionId = '';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const source = listEvents(sess.id, { types: ['user_input_received'] }).at(-1)!;
    const record = queuePendingAction({
      title: 'Premature account send',
      summary: 'The sending account is not resolved yet.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'guessed@example.com' } },
      sessionId: sess.id,
    });
    pendingActionId = record.id;
    appendEvent({
      sessionId: sess.id,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId,
        toolName: record.toolName,
        actionKind: record.kind,
        approvalRequired: true,
        sourceUserSeq: source.seq,
        payloadHash: record.payloadHash,
      },
    });
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Which account should I use to send it?',
        reply: 'Which account should I use to send it?',
        done: false,
        nextAction: 'awaiting_user_input',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Prepare this message, but I have two sending accounts.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(getPendingAction(pendingActionId)?.status, 'queued');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' }).length, 0);
  assert.equal(listEvents(sess.id, { types: ['approval_requested'] }).length, 0);
});

test('runConversation: a declarative queue-only completion does not mint an approval card', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let calls = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    const source = listEvents(sess.id, { types: ['user_input_received'] }).at(-1)!;
    const record = queuePendingAction({
      title: 'Queue-only proof send',
      summary: 'Prepare this exact send but do not request approval yet.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
      targetSummary: 'proof@example.com',
      sessionId: sess.id,
    });
    appendEvent({
      sessionId: sess.id,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId: record.id,
        actionKind: 'external_send',
        approvalRequired: true,
        sourceUserSeq: source.seq,
        payloadHash: record.payloadHash,
      },
    });
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Queued exactly for later review. I did not request approval or execute it.',
        reply: 'Queued exactly for later review. I did not request approval or execute it.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Queue the exact send.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' }).length, 0);
  assert.equal(listEvents(sess.id, { types: ['approval_requested'] }).length, 0);
});

test('runConversation: a typed queue-only edge stays inert even when closing prose asks to execute', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let pendingActionId = '';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const source = listEvents(sess.id, { types: ['user_input_received'] }).at(-1)!;
    const record = queuePendingAction({
      title: 'Stage launch send',
      summary: 'Store the launch send for a later review turn.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: JSON.stringify({ to: 'proof@example.com', body: 'Staged only.' }),
        connected_account_id: null,
      },
      sessionId: sess.id,
    });
    pendingActionId = record.id;
    appendEvent({
      sessionId: sess.id,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId: record.id,
        actionKind: record.kind,
        approvalRequired: true,
        approvalIntent: 'queue_only',
        autoMaterialize: false,
        sourceUserSeq: source.seq,
        payloadHash: record.payloadHash,
      },
    });
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'The staged email is ready. Should I execute it?',
        reply: 'The staged email is ready. Should I execute it?',
        done: false,
        nextAction: 'awaiting_user_input',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Stage this exact launch send only.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(getPendingAction(pendingActionId)?.status, 'queued');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' }).length, 0);
  assert.equal(listEvents(sess.id, { types: ['approval_requested'] }).length, 0);
});

test('runConversation: a typed propose-to-approval edge auto-materializes without magic closing words', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let calls = 0;
  let pendingActionId = '';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    calls += 1;
    const source = listEvents(sess.id, { types: ['user_input_received'] }).at(-1)!;
    const record = queuePendingAction({
      title: 'Approve launch batch',
      summary: 'Execute the exact proposed launch batch.',
      kind: 'external_write',
      toolName: 'run_batch',
      payload: { action: 'execute', batchId: 'batch-proof-auto' },
      sessionId: sess.id,
    });
    pendingActionId = record.id;
    appendEvent({
      sessionId: sess.id,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId: record.id,
        actionKind: record.kind,
        approvalRequired: true,
        sourceUserSeq: source.seq,
        payloadHash: record.payloadHash,
        approvalIntent: 'request_now',
      },
    });
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Queued — nothing was sent. **Should I execute it and send to proof@example.com?**',
        reply: 'Queued — nothing was sent. **Should I execute it and send to proof@example.com?**',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Prepare the launch batch for approval.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_approval');
  assert.equal(calls, 1);
  assert.equal(getPendingAction(pendingActionId)?.status, 'approval_requested');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' }).length, 1);
  assert.equal(listEvents(sess.id, { types: ['approval_requested'] }).length, 1);
  assert.equal(
    listEvents(sess.id, { types: ['heartbeat'] })
      .filter((event) => event.data.kind === 'pending_action_transition_materialized'
        && event.data.approvalIntent === 'request_now').length,
    1,
  );
});

test('runConversation: an older request cannot claim a later request queued action', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let laterActionId = '';
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const laterUser = appendEvent({
      sessionId: sess.id,
      turn: 2,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'A newer independent request.' },
    });
    const record = queuePendingAction({
      title: 'Later request send',
      summary: 'This belongs only to the newer user request.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'later@example.com' } },
      sessionId: sess.id,
    });
    laterActionId = record.id;
    appendEvent({
      sessionId: sess.id,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId: record.id,
        actionKind: 'external_send',
        approvalRequired: true,
        sourceUserSeq: laterUser.seq,
        payloadHash: record.payloadHash,
      },
    });
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'Should I execute it?',
        reply: 'Should I execute it?',
        done: false,
        nextAction: 'awaiting_user_input',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Original request A.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(getPendingAction(laterActionId)?.status, 'queued');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' }).length, 0);
});

test('runConversation: propagates SDK-level awaiting_approval status from runTurn', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const args = { subject: 'Deploy the verified release to production.' };
  const runner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: items,
    lastResponseId: undefined,
    finalOutput: undefined,
    hasInterruptions: true,
    serializedState: '{}',
    interruptions: [{
      toolName: 'request_approval',
      args,
      rawArgs: JSON.stringify(args),
    }],
  });
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'deploy to prod',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_approval');
  assert.equal(result.steps, 1);
  const pending = approvalRegistry.listPending({ sessionId: sess.id, status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(result.publicPresentation?.kind, 'approval');
  assert.equal(result.publicPresentation?.approvalId, pending[0].approvalId, 'the presentation carries the exact registry authority');
  const accepted = listEventsForConv(sess.id, { types: ['user_input_received'] })[0];
  assert.deepEqual(result.publicPresentation?.identity, {
    sessionId: sess.id,
    turn: accepted.turn,
    sourceUserSeq: accepted.seq,
  });
  const terminals = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal((terminals[0].data.presentation as { approvalId?: string }).approvalId, pending[0].approvalId);
});

test('runConversation: bails out at maxSteps when the orchestrator keeps recursing', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const recurseForever = scriptedRunner([
    {
      finalOutput: {
        summary: 'still working',
        done: false,
        nextAction: 'awaiting_handoff_result',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the thing',
    maxSteps: 3,
    makeRunner: makeRunnerStub,
    runRunner: recurseForever,
  });
  assert.equal(result.status, 'limit_exceeded');
  assert.equal(result.steps, 3);
  const limitEvents = listEventsForConv(sess.id, { types: ['conversation_limit_exceeded'] });
  assert.equal(limitEvents.length, 1);
  assert.equal(limitEvents[0].data.reason, 'max_steps');
});

test('runConversation: bails out at maxWallClockMs', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  // Each turn sleeps 20ms; with maxWallClockMs=10 the first turn
  // already exceeds the budget, so the loop should stop after one
  // step.
  const slow = scriptedRunner([
    {
      delayMs: 20,
      finalOutput: {
        summary: 'still working',
        done: false,
        nextAction: 'awaiting_handoff_result',
        reason: null,
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the thing',
    maxSteps: 99,
    maxWallClockMs: 10,
    makeRunner: makeRunnerStub,
    runRunner: slow,
  });
  assert.equal(result.status, 'limit_exceeded');
  const limitEvents = listEventsForConv(sess.id, { types: ['conversation_limit_exceeded'] });
  assert.equal(limitEvents[0].data.reason, 'wall_clock');
});

test('runConversation: abandoned nextAction marks the conversation completed', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'the request is impossible without admin access',
        done: false,
        nextAction: 'abandoned',
        reason: 'no admin role',
      },
    },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do an impossible thing',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completedEvents[0].data.reason, 'abandoned_by_orchestrator');
});

test('runConversation: a non-envelope plain-text final output is a VALID completed reply (fail-open)', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'a plain string, not a Decision' }]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'whatever',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  // NEW CONTRACT (plain-text marker): any non-empty text without a marker is a
  // valid completed reply — never dropped as 'no_structured_output', never
  // retried as D_decision_unparsed.
  assert.equal(result.status, 'completed');
  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.notEqual(completedEvents[0].data.reason, 'no_structured_output');
  assert.equal(completedEvents[0].data.reply, 'a plain string, not a Decision');
  const retries = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(
    retries.filter((e) => (e.data as { signal?: string }).signal === 'D_decision_unparsed').length,
    0,
    'non-empty output must never fire the D_decision_unparsed retry',
  );
});

test('runConversation: captured workflow_step_result terminates despite punt-shaped final prose and leaves payload for runner', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'workflow' });
  clearStepResult(sess.id);
  let calls = 0;
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    calls += 1;
    recordStepResult(sess.id, { rows: [{ id: 1 }], total: 1 });
    return { history: items, lastResponseId: undefined, finalOutput: 'Done.' };
  };
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'run one workflow step',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(calls, 1, 'captured step result must not trigger a repair/retry turn');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completed.at(-1)?.data.reason, 'workflow_step_result_captured');
  const retries = listEventsForConv(sess.id, { types: ['stall_retry_attempted', 'guardrail_tripped'] });
  assert.equal(retries.length, 0, 'step result capture bypasses missing-reply/stall repair');
  assert.deepEqual(
    takeStepResult(sess.id),
    { found: true, value: { rows: [{ id: 1 }], total: 1 } },
    'runConversation must peek only; workflow runner still owns the payload',
  );
});

test('runConversation: fake workflow_step_result transcript is materialized into the structural result channel', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'workflow' });
  clearStepResult(sess.id);
  let calls = 0;
  const fakeCall = [
    'Calling `workflow_step_result` with the required payload now.',
    '',
    '<function_calls>',
    '<invoke name="workflow_step_result">',
    '<parameter name="report">ok</parameter>',
    '</invoke>',
    '</function_calls>',
    '',
    'Done.',
  ].join('\n');
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    calls += 1;
    return { history: items, lastResponseId: undefined, finalOutput: fakeCall };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'run one workflow step',
    maxSteps: 3,
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 1, 'structural fake transcript is safe to materialize without another model turn');
  const captured = listEventsForConv(sess.id, { types: ['heartbeat'] })
    .filter((event) => event.data.kind === 'workflow_step_result_transcript_captured');
  assert.equal(captured.length, 1);
  const retries = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retries.length, 0);
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(completed.at(-1)?.data.reason, 'workflow_step_result_captured');
  assert.deepEqual(
    takeStepResult(sess.id),
    { found: true, value: { report: 'ok' } },
  );
});

// ─── Plain-text marker contract: parse table ──────────────────────────────
test('toOrchestratorDecision: plain-text marker parse table (ASK / CONTINUE / no-marker / case / whitespace)', () => {
  // No marker → the whole text is the completed, user-facing reply (fail-open).
  const plain = toOrchestratorDecision('Here is your answer: 42.');
  assert.equal(plain?.done, true);
  assert.equal(plain?.nextAction, 'completed');
  assert.equal(plain?.reply, 'Here is your answer: 42.');

  // ASK: marker → pause for the user; body is the question.
  const ask = toOrchestratorDecision('ASK: Which environment — staging or prod?');
  assert.equal(ask?.done, false);
  assert.equal(ask?.nextAction, 'awaiting_user_input');
  assert.equal(ask?.reply, 'Which environment — staging or prod?');

  // CONTINUE: marker → keep looping (not done, no user-facing reply).
  const cont = toOrchestratorDecision('CONTINUE: scraped page 1, fetching page 2');
  assert.equal(cont?.done, false);
  assert.equal(cont?.nextAction, 'awaiting_handoff_result');
  assert.equal(cont?.reply, null);

  // Lowercase marker (case-insensitive).
  const lower = toOrchestratorDecision('ask: what timezone?');
  assert.equal(lower?.nextAction, 'awaiting_user_input');
  assert.equal(lower?.reply, 'what timezone?');

  // Leading whitespace/newlines before the marker.
  const pad = toOrchestratorDecision('\n\n   CONTINUE: still working');
  assert.equal(pad?.nextAction, 'awaiting_handoff_result');
  assert.equal(pad?.done, false);

  // A model still emitting the JSON envelope is parsed as the decision (back-compat).
  const json = toOrchestratorDecision('{"summary":"s","reply":"Done.","done":true,"nextAction":"completed","reason":null}');
  assert.equal(json?.done, true);
  assert.equal(json?.reply, 'Done.');
});

test('toOrchestratorDecision: a 40KB no-marker body is ONE valid completed reply (never unparseable)', () => {
  const huge = 'The full report follows.\n\n' + 'x'.repeat(40_000);
  const decision = toOrchestratorDecision(huge);
  assert.ok(decision, 'a giant body must never parse to null');
  assert.equal(decision?.done, true);
  assert.equal(decision?.nextAction, 'completed');
  assert.equal(decision?.reply, huge, 'the entire body is the reply — not truncated, not dropped');
  // Summary is derived IN CODE (first sentence / ≤200 chars), never demanded.
  assert.ok((decision?.summary?.length ?? 0) <= 200);
});

test('toOrchestratorDecision: empty / recovery-sentinel output stays null (stall-retry path unchanged)', () => {
  assert.equal(toOrchestratorDecision(''), null);
  assert.equal(toOrchestratorDecision('   \n  '), null);
  assert.equal(
    toOrchestratorDecision("Clementine produced a response that couldn't be structured. Please ask again."),
    null,
    'the empty-turn sentinel stays null so the existing stall-retry path handles it',
  );
});

test('runConversation: synthetic parse retry classifies against the original tool-backed ask', async () => {
  resetEventLog();
  // The "acme" shorthand only scopes Outlook because the user has a
  // pinned-calendar constraint naming that label — seed it so this test
  // proves the full data-driven chain (constraint fact → label → tool scope).
  rememberFact({
    kind: 'constraint',
    content: 'For Acme calendar lookups, use Outlook connection ca_LoopTestRoute1 as the Acme calendar connection.',
  });
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: "Clementine produced a response that couldn't be structured. Please ask again." },
    {
      finalOutput: {
        summary: 'Recovered the Acme calendar check.',
        reply: 'Recovered with Outlook calendar tools available.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Check my acme for tomorrow',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });

  assert.equal(result.status, 'completed');
  const packets = listEventsForConv(sess.id, { types: ['agent_context_packet'] });
  assert.ok(packets.length >= 2, 'expected original turn plus synthetic retry turn');
  const retryPacket = packets[1].data as {
    inputPreview?: string;
    toolScope?: { allowedServerSlugs?: string[]; reason?: string };
  };
  assert.match(retryPacket.inputPreview ?? '', /Check my acme for tomorrow/i);
  assert.ok(
    (retryPacket.toolScope?.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)),
    'retry must preserve Outlook calendar reach from the original user ask',
  );
});

test('runConversation: malformed decision AFTER real tool work RETRIES instead of dying (D_decision_unparsed)', async () => {
  // Repro from a live website build+deploy: the Orchestrator did real
  // tool work (loaded skills, wrote files) and then emitted the
  // deliverable (HTML) inline, breaking the structured-decision shape.
  // Before the fix the run died with reason 'no_structured_output' and
  // the user saw "produced a response that couldn't be structured" with
  // no recourse — even though work was in flight. The did-work-then-
  // malformed case must RETRY (re-prompt for the decision + next action)
  // so the task actually finishes. (Zero-tool malformed nulls still go
  // straight to no_structured_output — covered by the test above.)
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let call = 0;
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    call += 1;
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    if (call === 1) {
      // Real tool work, then a malformed (non-Decision) finalOutput.
      ee.emit('agent_start', runContext, { name: 'Orchestrator' });
      ee.emit(
        'agent_tool_start',
        runContext,
        { name: 'Orchestrator' },
        { name: 'skill_read' },
        { toolCall: { callId: 'call_1', arguments: '{"name":"taste-skill"}' } },
      );
      ee.emit(
        'agent_tool_start',
        runContext,
        { name: 'Orchestrator' },
        { name: 'write_file' },
        { toolCall: { callId: 'call_2', arguments: '{"path":"/tmp/site/index.html"}' } },
      );
      const output = '<!doctype html><html><body>the whole site inlined instead of a decision</body></html>';
      ee.emit('agent_end', runContext, { name: 'Orchestrator' }, output);
      return { history: items, lastResponseId: undefined, finalOutput: output };
    }
    // Retry turn: now it issues the proper structured decision and finishes.
    const decision = {
      summary: 'Built and deployed the site',
      reply: 'Done — deployed to https://example.netlify.app',
      done: true,
      nextAction: 'completed',
      reason: null,
    };
    ee.emit('agent_start', runContext, { name: 'Orchestrator' });
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
    return { history: items, lastResponseId: undefined, finalOutput: decision };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build and deploy a website',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  // NEW CONTRACT: the inline deliverable IS a valid reply — the run completes on
  // the FIRST turn with ZERO D_decision_unparsed retries (this is the exact
  // landing-page failure class the plain-text contract eliminates).
  const retries = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  const unparsed = retries.filter((e) => (e.data as { signal?: string }).signal === 'D_decision_unparsed');
  assert.equal(unparsed.length, 0, 'no unparseable-decision retry — inline output is delivered as the reply');

  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.notEqual(
    completed[0].data.reason,
    'no_structured_output',
    'did-work-then-inline-deliverable completes, never dies with no_structured_output',
  );
  assert.match(String(completed[0].data.reply ?? ''), /the whole site inlined/);
});

test('runConversation: sub-agent stall ("Continuing." with zero tool calls) is flagged as sub_agent_stalled', async () => {
  // Repro: Orchestrator hands off to Executor, Executor returns the
  // single word "Continuing." and makes zero tool calls. Without the
  // detector the user sees "Continuing." as the bot's reply and waits
  // forever. With it, the conversation_completed event reports the
  // stall privately so the bridge can recover or commit one blocked terminal.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'Continuing.' }]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'continue this',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_recovery_candidate'] });
  assert.equal(completedEvents[0].data.reason, 'sub_agent_stalled');
  assert.match(
    completedEvents[0].data.summary as string,
    /sub-agent ended its turn without taking any action/,
  );
  assert.equal(
    (completedEvents[0].data.stallDetail as { rawOutput: string }).rawOutput,
    'Continuing.',
  );
});

test('runConversation: future-tense sub-agent stall after discovery tools is flagged', async () => {
  // Repro from Discord "what desktop version are you running":
  // Orchestrator made discovery/memory tool calls, handed off to
  // Executor, then Executor only said "I'll check..." and made zero
  // post-handoff tool calls. Total run tool calls were non-zero, so
  // the older detector missed it and the user saw a promise that never
  // completed.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    ee.emit('agent_start', runContext, { name: 'Orchestrator' });
    ee.emit(
      'agent_tool_start',
      runContext,
      { name: 'Orchestrator' },
      { name: 'local_cli_list' },
      { toolCall: { callId: 'call_1', arguments: '{"filter":"defaults"}' } },
    );
    ee.emit(
      'agent_tool_start',
      runContext,
      { name: 'Orchestrator' },
      { name: 'tool_choice_remember' },
      { toolCall: { callId: 'call_2', arguments: '{"intent":"local.desktop.version"}' } },
    );
    ee.emit('agent_handoff', runContext, { name: 'Orchestrator' }, { name: 'Executor' });
    ee.emit('agent_start', runContext, { name: 'Executor' });
    const output = 'I\u2019ll check the installed desktop app version from the local app bundle metadata.';
    ee.emit('agent_end', runContext, { name: 'Executor' }, output);
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: output,
    };
  };

  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'what desktop version are you running',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_recovery_candidate'] });
  assert.equal(completedEvents[0].data.reason, 'sub_agent_stalled');
  assert.match(
    completedEvents[0].data.summary as string,
    /announced work it was about to do but didn't actually call the tool/,
  );
  const detail = completedEvents[0].data.stallDetail as {
    totalToolCalls: number;
    afterHandoff: { to: string; toolCallsAfterHandoff: number };
  };
  assert.equal(detail.totalToolCalls, 2);
  assert.equal(detail.afterHandoff.to, 'Executor');
  assert.equal(detail.afterHandoff.toolCallsAfterHandoff, 0);
});

test('runConversation: a short SUBSTANTIVE reply is NOT flagged as a stall', async () => {
  // Counter-test: short reply but not on the stall whitelist. Should be
  // surfaced as a normal summary so we don't drown real terse answers
  // in the same "agent gave up" message.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'Added 5 rows to the sheet.' }]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'add the rows',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const completedEvents = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  // NEW CONTRACT: a substantive terse reply is delivered as the completed reply,
  // not routed through the malformed 'no_structured_output' path.
  assert.notEqual(completedEvents[0].data.reason, 'sub_agent_stalled');
  assert.equal(completedEvents[0].data.reply, 'Added 5 rows to the sheet.');
  assert.equal(completedEvents[0].data.summary, 'Added 5 rows to the sheet.');
});

// ─── T2.2 — generalized stall detector signals ─────────────────

test('runConversation: stuck_detected fires Signal A when zero tools + generic ack', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'OK.' }]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do work',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  // The harness retries once on stall (HARNESS_MAX_STALL_RETRIES=1
  // default); the retry stalls too with this scripted runner, so the
  // detector fires twice. What matters here is that the FIRST signal
  // is correctly classified — that's the detector's contract.
  assert.ok(stuckEvents.length >= 1, 'expected at least one stuck_detected event');
  assert.equal((stuckEvents[0].data as { signal: string }).signal, 'A_zero_tools');
});

test('runConversation: a generic acknowledgement after successful tool work completes once', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let modelTurns = 0;
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    modelTurns += 1;
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    const tool = { name: 'memory_remember' };
    const details = {
      toolCall: {
        callId: `remember-${modelTurns}`,
        arguments: '{"kind":"project","content":"Falcon codeword is tangerine-osprey-42"}',
      },
    };
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, tool, details);
    ee.emit('agent_tool_end', runContext, { name: 'Orchestrator' }, tool, 'Remembered (project): Falcon codeword is tangerine-osprey-42', details);
    ee.emit('agent_end', runContext, { name: 'Orchestrator' }, 'Noted.');
    return { history: items, lastResponseId: undefined, finalOutput: 'Noted.' };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Remember the Falcon codeword and just confirm you noted it.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1, 'successful work plus acknowledgement must not self-retry');
  assert.equal(modelTurns, 1, 'the completed mutation must not be repeated');
  assert.equal(result.lastDecision?.reply, 'Noted.');
  assert.equal(
    listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length,
    0,
    'tool-backed acknowledgement never enters decision-parse recovery',
  );
});

test('runConversation: a generic acknowledgement after durable auto-capture completes without a forced tool', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let modelTurns = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    modelTurns += 1;
    return { history: items, lastResponseId: undefined, finalOutput: 'Noted.' };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Remember this: my durable harness marker is AUTO-CAPTURE-ACK-42.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const capture = listEventsForConv(sess.id, { types: ['memory_signals_captured'] }).at(-1);
  assert.ok(Number((capture?.data as { queuedCandidateCount?: number } | undefined)?.queuedCandidateCount ?? 0) > 0);
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(modelTurns, 1);
  assert.equal(result.lastDecision?.reply, 'Noted.');
  assert.equal(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length, 0);
  assert.equal(listEventsForConv(sess.id, { types: ['tool_called'] }).length, 0);
});

test('runConversation: a zero-tool ACKNOWLEDGMENT turn is NOT flagged as a stall', async () => {
  // Success-payload regression: the user gave correction feedback;
  // the model correctly replied "You're right … going forward I'll treat SEO as
  // raw metrics" with done=true, nextAction=completed, 0 tool calls. The stray
  // "I'll" tripped STALL_ANNOUNCEMENT_PATTERN and the harness force-injected
  // "prose, not an action — call a tool now", derailing the alignment turn. The
  // reflection suppressor must let a genuine conversational reply through.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: {
      summary: 'Acknowledged the two corrections and aligned on next steps',
      reply: "You're right on both. I put them in the wrong table, and going forward I'll treat SEO as raw metrics first.",
      done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'two issues to correct: wrong table, and that seo data is too light',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1, 'an acknowledgment reply must complete in one step, not retry');
  const falseClaims = listEventsForConv(sess.id, { types: ['stuck_detected'] })
    .filter((e) => (e.data as { kind?: string }).kind === 'structured_zero_tool_claim');
  assert.equal(falseClaims.length, 0, 'a conversational acknowledgment must not be a zero-tool claim stall');
});

test('runConversation: a zero-tool FALSE completion claim still fires the stall (no over-suppression)', async () => {
  // Positive control: a real fake-completion ("Sent the email …") carries none
  // of the reflection markers, so the suppressor must NOT shield it.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: {
      summary: 'claimed the email was sent', reply: 'Sent the email to the team.',
      done: true, nextAction: 'completed', reason: null } },
  ]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'send the email',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const claims = listEventsForConv(sess.id, { types: ['stuck_detected'] })
    .filter((e) => (e.data as { kind?: string }).kind === 'structured_zero_tool_claim');
  assert.ok(claims.length >= 1, 'a false completion claim with zero tools must still be flagged');
});

test("runConversation: a zero-tool reflective TEXT reply is NOT flagged as a Signal A' stall", async () => {
  // Parity fix: when the model returns a PLAIN STRING (not an
  // OrchestratorDecision object) that is a reflective/alignment turn carrying
  // a stray future-tense "I'll", the TEXT-path detector (evaluateProgress
  // Signal A') must apply the same reflection suppression the structured path
  // already did. Before the fix this false-fired "announced work but didn't
  // call the tool" and forced a needless retry on a legitimate reply.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: "You're right — going forward I'll treat SEO data as raw metrics first." },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'correction: that seo data was too light',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.steps, 1, 'a reflective text reply must complete in one step, not retry');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 0, "a reflective text reply must not trip Signal A'");
});

test("runConversation: a zero-tool false-claim TEXT reply still fires Signal A' (no over-suppression)", async () => {
  // Positive control for the text path: a real fake-completion string ("Sent
  // the email …") carries no reflection markers, so the suppressor must NOT
  // shield it — the announcement stall must still fire.
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: 'Sent the email to the team.' },
  ]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'send the email',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuckEvents.length >= 1, 'a false completion claim in plain text must still be flagged');
  assert.equal((stuckEvents[0].data as { signal: string }).signal, 'A_zero_tools');
});

test('runConversation: Signal D fires when sub-agent emits OrchestratorDecision JSON', async () => {
  // Pattern: model over-conforms to schema and the SDK passes the
  // JSON through as a plain string. Today extractFallbackSummary
  // recovered the reply silently; the detector now ALSO flags it so
  // ops can see how often this happens.
  const sess = HarnessSession.create({ kind: 'chat' });
  const decisionJson = JSON.stringify({
    summary: 'I drafted a workflow but did not finalize',
    reply: 'Here is the draft — want me to ship it?',
    done: false,
    nextAction: 'awaiting_user_input',
  });
  const runner = scriptedRunner([{ finalOutput: decisionJson }]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'draft something',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  // NEW CONTRACT: a model still emitting the JSON envelope is PARSED into the
  // decision (a graceful transition), not flagged as a stall. Here the decision
  // is awaiting_user_input, so the run surfaces the question and pauses.
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(
    !stuckEvents.some((e) => (e.data as { signal?: string }).signal === 'D_decision_json'),
    'a valid JSON decision is used, not flagged as a stall',
  );
  assert.equal(result.status, 'awaiting_user_input');
  const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
  assert.ok(asks.length >= 1, 'the question was surfaced');
  assert.match(String((asks[0].data as { question?: string }).question ?? ''), /draft|ship it/i);
});

test('runConversation: a real "Added 5 rows" reply does NOT fire any stall signal', async () => {
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'Added 5 rows to the sheet.' }]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'go',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 0);
});

test('runConversation: "Transferred to Executor" false claim is flagged', async () => {
  // False-executor-claim regression: after the
  // stall_retry_attempted hook re-prompted the Executor for a multi-
  // step Composio + Salesforce chain, the model emitted:
  //   "Transferred to Executor to run the actual workflow now."
  // The first broadened pattern landed in v0.4.32 caught "Handed off"
  // but missed "Transferred to" — the model just swapped synonyms.
  // The user saw a fabricated reply that lied about doing the work.
  // The pattern set now covers transfer/route/dispatch/delegate/
  // launch/trigger/forward verbs in both past- and present-progressive
  // tense; this test pins one of them.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput: 'Transferred to Executor to run the actual workflow now.',
    },
  ]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the multi-step thing',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuckEvents.length >= 1, 'expected "Transferred to" false claim to fire stuck_detected');
  assert.equal((stuckEvents[0].data as { signal: string }).signal, 'A_zero_tools');
});

test('runConversation: past-tense FALSE CLAIM with zero tools is flagged', async () => {
  // Zero-tool false-claim regression:
  // After the retry hook re-prompted the Executor with a clear
  // "act now" directive, the model produced past-tense narrative
  // claiming the work was done without calling a tool:
  //   "Handed off the exact Outlook action for execution with the
  //    required tool slug and arguments."
  // The original future-tense-only regex missed this and surfaced
  // the false claim to the user as a real reply. Broadening
  // STALL_ANNOUNCEMENT_PATTERN to past-tense verbs catches it
  // honestly so the user sees a failure message instead of a lie.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    {
      finalOutput:
        'Handed off the exact Outlook action for execution with the required tool slug and arguments.',
    },
  ]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'find that email',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuckEvents.length >= 1, 'expected past-tense false claim to fire stuck_detected');
  assert.equal((stuckEvents[0].data as { signal: string }).signal, 'A_zero_tools');

  const completed = listEventsForConv(sess.id, { types: ['conversation_recovery_candidate'] });
  assert.equal(completed[0].data.reason, 'sub_agent_stalled');
});

test('runConversation: stall triggers one auto-retry; retry success completes conversation normally', async () => {
  // Regression trace shape:
  // Orchestrator did discovery + tool_choice_remember + handoff with
  // structured toolCall, Executor announced "I'll search Outlook..."
  // with zero post-handoff tool calls. Detector caught it, but the
  // conversation died with sub_agent_stalled and the user saw the
  // "announced work but didn't call the tool" error message.
  //
  // Fix E hooks the stall detector to one auto-retry with a private
  // "act now" model input. If the retry succeeds (model emits a tool call
  // on the second pass), the conversation completes normally and the
  // user never sees the stall failure.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // Pre-seed an Orchestrator handoff event so buildStallRetryMessage()
  // can find the structured toolCall and surface it in the retry.
  const { appendEvent } = await import('./eventlog.js');
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'orchestrator',
    type: 'handoff',
    data: {
      to: 'Executor',
      input: {
        directive: 'Search Alex’s Outlook for emails from Marlow today.',
        toolCall: {
          slug: 'OUTLOOK_LIST_MESSAGES',
          args: '{"user_id":"me","folder":"allfolders","search":"Marlow","top":25}',
          rationale: 'Pre-resolved by Orchestrator after discovery.',
        },
      },
    },
  });

  // First turn stalls (announcement, zero tools). Second turn returns
  // a real reply — simulates the retry working. The scripted runner
  // walks turns sequentially, so the retry hits the second entry.
  let scriptIndex = 0;
  const modelInputs: string[] = [];
  const scripted = [
    'I’ll search Outlook for “Marlow” and check whether anything came in today.',
    'Found 1 email from Marlowe Rary today, subject "Account question".',
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const last = items.at(-1) as { content?: unknown } | undefined;
    modelInputs.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''));
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'A prospect emailed me today Marlow can you find that',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  // The conversation completed (NOT stalled out).
  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.notEqual(completed[0].data.reason, 'sub_agent_stalled', 'retry should have prevented sub_agent_stalled');

  // The retry event was logged for observability.
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1, 'expected exactly one stall_retry_attempted event');
  const retryData = retryEvents[0].data as {
    attempt: number;
    maxRetries: number;
    signal: string;
    rawOutput: string;
  };
  assert.equal(retryData.attempt, 1);
  assert.equal(retryData.signal, 'A_zero_tools');
  assert.match(retryData.rawOutput, /search Outlook for/);

  // The retry input that drove turn 2 should mention the slug the
  // Orchestrator pre-resolved — the model gets the action inlined without
  // manufacturing a second accepted-user authority event.
  const userInputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.equal(userInputs.length, 1, 'the private retry never becomes a second accepted user event');
  assert.match(modelInputs[1], /OUTLOOK_LIST_MESSAGES/, 'retry message should inline the pre-resolved slug');
});

test('runConversation: existing-work stall retry forces focus and memory before asking user', async () => {
  // Referenced-output regression: the user referenced a
  // known prior creative project ("gala silet acution animation post"),
  // but the first model response asked for a file/path without trying
  // focus or memory. On the retry, that shape should be treated as a
  // reference to existing work, so ask_user_question is only allowed
  // after focus/memory fail to find a target.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const outputs = [
    'I’ll edit the gala silent auction animation post now.',
    'I found the gala-reel project in memory and loaded it.',
  ];
  const modelInputs: string[] = [];
  let outputIndex = 0;
  const runner: RunRunnerFn = async (_runner, _agent, items) => {
    const last = items.at(-1) as { content?: unknown } | undefined;
    modelInputs.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''));
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: outputs[outputIndex++] ?? outputs.at(-1),
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Hey can we work on edits for the gala silet acution animation post please',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });

  assert.equal(result.status, 'completed');
  const userInputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.equal(userInputs.length, 1, 'the retry remains a private continuation');
  const retryText = modelInputs[1];
  assert.match(retryText, /existing work/i);
  assert.match(retryText, /gala silet acution animation post/i);
  assert.match(retryText, /focus_get/);
  assert.match(retryText, /memory_recall_all/);
  assert.doesNotMatch(
    retryText,
    /call ask_user_question instead of producing announcement text/,
    'existing-work retry must not use the generic ask-user escape hatch first',
  );
});

test('runConversation: fresh stall retry keeps generic ask-user fallback', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const outputs = ['I’ll write a quick greeting now.', 'Hello there.'];
  const modelInputs: string[] = [];
  let outputIndex = 0;
  const runner: RunRunnerFn = async (_runner, _agent, items) => {
    const last = items.at(-1) as { content?: unknown } | undefined;
    modelInputs.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''));
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: outputs[outputIndex++] ?? outputs.at(-1),
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'write a quick greeting',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });

  assert.equal(result.status, 'completed');
  const userInputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.equal(userInputs.length, 1, 'the retry remains a private continuation');
  const retryText = modelInputs[1];
  assert.match(retryText, /call ask_user_question instead of producing announcement text/);
  assert.doesNotMatch(retryText, /existing work/i);
  assert.doesNotMatch(retryText, /memory_recall_all/);
});

test('runConversation: stall retry that ALSO stalls falls through to sub_agent_stalled', async () => {
  // Negative case: scripted runner stalls on every turn, so the retry
  // also stalls. Budget exhausts, the original failure surfaces as
  // today's behavior. Documents that the retry doesn't mask genuine
  // model failure — it only absorbs intermittent ones.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ finalOutput: 'I’ll do that now.' }]);
  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'go',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  const completed = listEventsForConv(sess.id, { types: ['conversation_recovery_candidate'] });
  assert.equal(completed[0].data.reason, 'sub_agent_stalled');
  // Retry attempted once, then the recovery-summary turn (2026-07-23) — whose
  // repeated punt is vetted and rejected — then the terminal.
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 2);
  assert.equal((retryEvents[1].data as { attempt?: unknown }).attempt, 'recovery_summary');
});

test('runConversation: structured false tool-unavailable decision is retried', async () => {
  // Repro from the native compaction desktop smoke, 2026-05-27:
  // Clem had file/shell/search tools on the agent, but returned a
  // structured OrchestratorDecision saying it needed a "tool-enabled
  // run" and asked the user to resend continue. That strands long
  // autonomous tasks in a user-input state even though the runtime is
  // healthy. Treat that as the same zero-tool stall class and retry
  // with an action-only nudge.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const modelInputs: string[] = [];
  const scripted: unknown[] = [
    {
      summary: 'Need to continue the local file test but no tools are available.',
      reply:
        'I need tool access in this turn to create/read the local files. Please resend continue in a tool-enabled run.',
      done: false,
      nextAction: 'awaiting_user_input',
      reason: 'No commentary/tool calls were available in this turn.',
    },
    {
      summary: 'All set after retry.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const last = items.at(-1) as { content?: unknown } | undefined;
    modelInputs.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''));
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'create the native-compaction proof files',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_tool_unavailable');

  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);

  const userInputs = listEventsForConv(sess.id, { types: ['user_input_received'] });
  assert.equal(userInputs.length, 1, 'the retry does not invent a new user authority edge');
  assert.match(modelInputs[1], /tool surface is available/i);
});

test('runConversation: structured tool-unavailable after only probe tools is retried', async () => {
  // Live desktop repro, 2026-05-27: after native compaction Clem called
  // workspace_roots, then claimed local/file tools were unavailable and
  // asked the user to continue in another tool-enabled turn. A single
  // probe call is not meaningful progress; retry instead of stranding.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary:
        'Could not continue tool execution because the available tool surface in this turn does not include the required local/file tools.',
      reply:
        'I am blocked because the local/file tool surface I need to write the markdown report is not available in this turn.',
      done: false,
      nextAction: 'awaiting_user_input',
      reason: 'Need a follow-up turn with local/file tools available to complete the report write.',
    },
    {
      summary: 'All set after probe-only retry.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (runner, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    if (scriptIndex === 1) {
      (runner as unknown as EventEmitter).emit('agent_tool_start');
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'Clem',
        type: 'tool_called',
        data: { tool: 'workspace_roots', callId: 'call_probe', arguments: '{}' },
      });
    }
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'finish the SEO audit report',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_tool_unavailable');
  assert.equal((stuckEvents[0].data as { onlyProbeTools: boolean }).onlyProbeTools, true);
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: structured awaiting_handoff_result tool-runtime stall is retried', async () => {
  // Live desktop repro, 2026-05-27: the Orchestrator returned
  // nextAction=awaiting_handoff_result with zero tool calls and said it
  // needed the "tool runtime" / "no executable tool results". That is
  // not a legitimate handoff; retry with an action-only nudge.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary:
        'Need to run the Priority Account workflow with tools, but this turn only had a handoff summary and no executable tool results.',
      reply:
        'I need the tool runtime to continue this properly: query Salesforce, gather SEO signals, write the markdown report, then request one approval before creating drafts.',
      done: false,
      nextAction: 'awaiting_handoff_result',
      reason: 'Proceed by calling Salesforce/SEO/file/approval tools in the next tool-enabled step.',
    },
    {
      summary: 'All set after handoff retry.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'run the Priority Account workflow',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_tool_unavailable');
  assert.equal((stuckEvents[0].data as { nextAction: string }).nextAction, 'awaiting_handoff_result');
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: narration-deferral (awaiting_handoff_result + 0 tools, no "unavailable" text) is force-corrected', async () => {
  // Narration-deferral regression: user asked to pull 25 Salesforce
  // accounts (one `sf data query`). Claude replied "On it. Running the Market
  // Leader pull now — I'll pull 25." with done:false, nextAction:
  // awaiting_handoff_result, and ZERO tool calls — promising imminent action and
  // deferring to a phantom executor. The text does NOT claim tools are
  // unavailable, so the old detectors missed it and the loop auto-continued into
  // another narration turn. The narration-deferral guard must catch it and force
  // the actual tool action on the retry.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary: 'User confirmed criteria; proceeding to query Salesforce for 25 stale accounts',
      reply: 'On it. Running the Priority Account pull now — your owned accounts, no activity >15 days. I\'ll pull 25.',
      done: false,
      nextAction: 'awaiting_handoff_result',
      reason: 'Next step is querying Salesforce via the sf CLI.',
    },
    {
      summary: 'Ran sf data query and returned the 25 accounts.',
      reply: 'Pulled 25 accounts. Here they are: …',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'pull me 25 accounts from salesforce I have not contacted in 15 days',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_narration_deferral');
  assert.equal((stuckEvents[0].data as { nextAction: string }).nextAction, 'awaiting_handoff_result');
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: discover-then-defer (only tool_choice_recall/local_cli_list, no execution) is force-corrected', async () => {
  // Companion to the narration-deferral repro: the later turn did ONLY
  // discovery (tool_choice_recall ×2 + local_cli_list) and then deferred again
  // with awaiting_handoff_result. Discovery-ritual tools are probes, so a
  // probe-only turn that defers is still the deferral anti-pattern and must be
  // force-corrected, not rewarded with a bland auto-continue.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary: 'Querying Salesforce via sf CLI for 25 owned priority-account accounts',
      reply: 'Pulling them now.',
      done: false,
      nextAction: 'awaiting_handoff_result',
      reason: 'Running the confirmed pull.',
    },
    {
      summary: 'Returned the account list after retry.',
      reply: 'Here are the 25 accounts: Acme, Globex, Initech, and 22 more.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (runner, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    if (scriptIndex === 1) {
      // Discovery-only turn: two probe-classified discovery calls, no execution.
      for (const tool of ['tool_choice_recall', 'local_cli_list']) {
        (runner as unknown as EventEmitter).emit('agent_tool_start');
        appendEvent({
          sessionId: sess.id,
          turn: 1,
          role: 'Clem',
          type: 'tool_called',
          data: { tool, callId: `call_${tool}`, arguments: '{}' },
        });
      }
    }
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'continue the pull',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_narration_deferral');
  assert.equal((stuckEvents[0].data as { onlyProbeTools: boolean }).onlyProbeTools, true);
});

test('runConversation: SILENT narration-deferral (awaiting_handoff_result, all text empty, 0 tools) is caught', async () => {
  // Audit 2026-06-16: the empty-`combined` early return in evaluateStructuredDecisionStall
  // fired BEFORE the narration-deferral check, so a wordless hold turn
  // ({nextAction:awaiting_handoff_result, reply:null, summary:'   '}) escaped into a
  // bland auto-continue. The silent-defer guard now catches it before the early return.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let i = 0;
  const scripted: unknown[] = [
    { summary: '   ', reply: null, reason: null, done: false, nextAction: 'awaiting_handoff_result' },
    { summary: 'Returned the records.', reply: 'Here are the 12 records.', done: true, nextAction: 'completed', reason: null },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const o = scripted[i] ?? scripted[scripted.length - 1]; i += 1;
    return { history: items, lastResponseId: undefined, finalOutput: o };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'pull it',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const stuck = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuck.length, 1);
  assert.equal((stuck[0].data as { kind: string }).kind, 'structured_narration_deferral');
  assert.equal((stuck[0].data as { silent?: boolean }).silent, true);
});

test('runConversation: zero-tool ABANDONED claim with announcement is force-corrected (was bypassing the judge)', async () => {
  // Audit 2026-06-16: a bare "searched everywhere, abandoning" + zero tools banked as a
  // clean terminal WITHOUT the objective judge (which only runs on nextAction:completed)
  // or any blocked-text check. The zero-tool-claim branch now also fires on `abandoned`.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let i = 0;
  const scripted: unknown[] = [
    { summary: 'Could not find it; abandoning.', reply: 'I searched everywhere and am abandoning this — it is impossible to find.', done: true, nextAction: 'abandoned', reason: null },
    { summary: 'Returned the records.', reply: 'Here are the 12 records.', done: true, nextAction: 'completed', reason: null },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const o = scripted[i] ?? scripted[scripted.length - 1]; i += 1;
    return { history: items, lastResponseId: undefined, finalOutput: o };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'find the record',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const stuck = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuck.length, 1);
  assert.equal((stuck[0].data as { kind: string }).kind, 'structured_zero_tool_claim');
  assert.equal((stuck[0].data as { nextAction: string }).nextAction, 'abandoned');
});

test('runConversation: structured abandoned tool-unavailable decision is retried', async () => {
  // Same failure as above, but the model may use nextAction=abandoned
  // instead of awaiting_user_input. That should not bypass recovery
  // when the reason is a false "tool surface unavailable" claim.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary: 'Prepared to create files but local file tools are unavailable.',
      reply: 'I do not have the local file/web tool surface available in this turn.',
      done: true,
      nextAction: 'abandoned',
      reason: 'Required local file and web-search tools were not available in the active tool surface.',
    },
    {
      summary: 'All set after abandoned retry.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'create the native-compaction proof files',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_tool_unavailable');
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: structured zero-tool completion claim is retried', async () => {
  // Repro from the native compaction desktop smoke, 2026-05-27:
  // Clem returned a structured "Done — created files, searched web"
  // answer with toolCalls=0 and no artifacts on disk. Structured
  // output should not bypass the same zero-tool false-claim guard
  // used for plain-text sub-agent stalls.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    {
      summary: 'Created the local proof files, verified them, searched for a web source, and confirmed completion.',
      reply: 'Done — created 3 files and searched the web source.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
    {
      summary: 'Completed after retry with actual tool calls.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'create files and search the web',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'structured_zero_tool_claim');
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

test('runConversation: an explicit decision-only JSON contract completes without a tool-stall retry', async () => {
  // Autonomy cycles deliberately expose zero tools: the model's job is to
  // return a closed JSON action plan, then slug-bound code owns the mutations.
  // The generic "claimed completion with zero tools" detector must not replace
  // a valid JSON payload with "you MUST call a tool" when the caller opted into
  // this exact contract. The outer autonomy layer still validates every field,
  // delegation id, and result before executing anything.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'execution' });
  const decisionJson = JSON.stringify({
    summary: 'Completed the assigned checklist.',
    commitments: [],
    actions: [
      { type: 'claim_delegation', delegationId: 'day-ops-1' },
      {
        type: 'complete_delegation',
        delegationId: 'day-ops-1',
        result: '1. Unlock doors\\n2. Start brewers\\n3. Count tills\\n4. Check pastry case',
      },
    ],
  });
  let modelTurns = 0;
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    modelTurns += 1;
    return {
      history: items,
      lastResponseId: undefined,
      // This is the actual provider shape the autonomy caller requests: raw
      // JSON text, not a harness decision envelope.
      finalOutput: decisionJson,
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Return the strict JSON autonomy decision.',
    acceptStructuredNoToolResult: true,
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(modelTurns, 1, 'the valid zero-tool decision is not overwritten by a stall retry');
  assert.equal(result.lastDecision?.reply, decisionJson, 'the caller receives the exact JSON it must validate');
  assert.equal(listEventsForConv(sess.id, { types: ['stuck_detected'] }).length, 0);
  assert.equal(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length, 0);
  assert.equal(listEventsForConv(sess.id, { types: ['tool_called'] }).length, 0);
});

test('decision-only JSON recognition is exact and autonomy-shaped, never repaired or inferred', () => {
  const valid = JSON.stringify({
    summary: 'Completed owned work.',
    commitments: [],
    actions: [{ type: 'complete_delegation', delegationId: 'owned-1', result: 'actual result' }],
  });
  assert.equal(_testOnly_strictStructuredNoToolResultText(valid), valid);
  assert.equal(
    _testOnly_strictStructuredNoToolResultText({
      summary: 'Harness wrapper.',
      reply: valid,
      done: true,
      nextAction: 'completed',
    }),
    valid,
    'provider wrappers may carry the exact autonomy JSON in reply',
  );

  const rejected: unknown[] = [
    '{"summary":"broken","commitments":[],"actions":[',
    `\`\`\`json\n${valid}\n\`\`\``,
    '{"ok":true}',
    JSON.stringify({
      summary: 'Sent the email.',
      reply: 'Sent the email.',
      done: true,
      nextAction: 'completed',
      reason: null,
    }),
    {
      summary: 'Sent the email.',
      reply: 'Sent the email.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  for (const candidate of rejected) {
    assert.equal(
      _testOnly_strictStructuredNoToolResultText(candidate),
      null,
      `must reject ${typeof candidate === 'string' ? candidate.slice(0, 60) : JSON.stringify(candidate)}`,
    );
  }
});

test('runConversation: structured-result recognition is disabled after any tool call', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'execution' });
  const decisionJson = JSON.stringify({
    summary: 'Returned a decision after unexpected tool work.',
    commitments: [],
    actions: [],
  });
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    const ee = runner as unknown as EventEmitter;
    const runContext = { context: opts.context };
    const tool = { name: 'memory_status' };
    const details = {
      toolCall: { callId: 'unexpected-tool', arguments: '{}' },
    };
    ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, tool, details);
    ee.emit('agent_tool_end', runContext, { name: 'Orchestrator' }, tool, 'ok', details);
    return { history: items, lastResponseId: undefined, finalOutput: decisionJson };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Return the strict JSON autonomy decision.',
    acceptStructuredNoToolResult: true,
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.notEqual(
    result.lastDecision?.reason,
    'structured_no_tool_result',
    'the exemption is recognized only when the turn made exactly zero tool calls',
  );
});

test('runConversation: decision-only opt-in never exempts a prose completion claim', async () => {
  // Positive control: the capability is not a broad "zero tools are fine"
  // switch. Only strict JSON is eligible; ordinary action narration keeps the
  // same fail-closed stall behavior.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'execution' });
  const runner = scriptedRunner([
    {
      finalOutput: {
        summary: 'Claimed an external action without evidence.',
        reply: 'Sent the email to the whole team.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  ]);

  await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Return the strict JSON autonomy decision.',
    acceptStructuredNoToolResult: true,
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });

  const claims = listEventsForConv(sess.id, { types: ['stuck_detected'] })
    .filter((event) => (event.data as { kind?: string }).kind === 'structured_zero_tool_claim');
  assert.ok(claims.length >= 1, 'non-JSON action narration still trips the zero-tool guard');
});

test('runConversation: plain self-reported no-tool-access completion is retried', async () => {
  // Missing-tool-access background regression: the model returned a
  // plain-text "this environment has no tool access" answer. The markerless
  // text parser treated it as a completed reply, so the background task banked
  // a hollow done. This must route through the same zero-tool retry path.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let scriptIndex = 0;
  const scripted: unknown[] = [
    'Nothing new - this environment has no tool access (Composio, Google Sheets, DataForSEO, or file I/O are not exposed to me here), so I cannot fetch search volumes, create a Google Sheet, or verify anything.',
    {
      summary: 'All set after retry.',
      reply: 'Done after retry.',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[scriptIndex] ?? scripted[scripted.length - 1];
    scriptIndex += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'create the SEO volume tracker sheet',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  const stuckEvents = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.equal(stuckEvents.length, 1);
  assert.equal((stuckEvents[0].data as { kind: string }).kind, 'tool_unavailable_self_report');
  const retryEvents = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.equal(retryEvents.length, 1);
});

// Synthetic Casey email-find regression: a done:true completion that REPORTS the
// result of work done in PRIOR turns must NOT be flagged a zero-tool prose claim.
test('runConversation: done:true completion reporting PRIOR tool work is NOT a zero-tool stall', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // Prior-turn substantive (non-probe) tool work — synthetic mailbox searches.
  appendEvent({
    sessionId: sess.id, turn: 0, role: 'Clem', type: 'tool_called',
    data: { tool: 'outlook_email_search', callId: 'call-mailbox-fixture', arguments: '{"query":"Casey"}' },
  });
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({
    history: items, lastResponseId: undefined,
    finalOutput: {
      summary: 'Searched the fixture inbox and mailbox for Casey; no results.',
      reply: "I searched the fixture mailbox and didn't find any email from Casey — the only result was a sample notification at noon.",
      done: true, nextAction: 'completed', reason: null,
    },
  });
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'find the fixture email from Casey',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  // The false zero-tool stall must NOT fire (prior real work exists).
  assert.equal(listEventsForConv(sess.id, { types: ['stuck_detected'] }).length, 0);
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0);
  // And the model's answer is delivered.
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.ok(completed.length >= 1);
  assert.match(String((completed.at(-1)!.data as { summary?: string }).summary ?? ''), /Casey/);
});

// BUG 2: a coherent answer that failed the STRICT decision parse is DELIVERED,
// not turned into the confusing "unable to make progress" prompt.
test('runConversation: a coherent reply that failed strict parse is salvaged + delivered (not a stuck prompt)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // A valid answer emitted as a JSON STRING — the strict parser rejects it
  // (typeof !== 'object') → D_decision_json carries the model's own reply.
  // Wording deliberately avoids past-tense action verbs so Signal A' (the
  // announcement-stall, checked first) does not pre-empt Signal D.
  const jsonString = JSON.stringify({
    summary: 'No email from Casey is present in the fixture inbox.',
    reply: "There's no email from Casey in the fixture mailbox — the only item is a sample notification.",
    done: true, nextAction: 'completed', reason: null,
  });
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: jsonString });
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'find the fixture email from Casey',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  // NEW CONTRACT: the JSON envelope is parsed directly into the decision and its
  // reply delivered — no 'salvage' detour, no confusing "unable to make progress".
  assert.match(String(completed[0].data.reply ?? completed[0].data.summary ?? ''), /Casey/);
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

test('runConversation: a GENUINE punt (announcement, zero tools, no answer) is NEVER salvaged', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // An announcement with zero tools → A_zero_tools, NOT D_decision_json → the
  // salvage (gated on D_decision_json with a real reply) must never deliver it.
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: "I'll run the Outlook search now." });
  await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'do the thing',
    makeRunner: makeRunnerStub, runRunner,
  });
  const stuck = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuck.some((e) => (e.data as { signal?: string }).signal === 'A_zero_tools'), 'a genuine punt is detected as a stall');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.ok(!completed.some((e) => (e.data as { reason?: string }).reason === 'decision_json_salvaged'), 'an announcement punt is never salvaged');
});

// Regression: the draft-present stall retry
// says "Do NOT call another tool. Reply to the user NOW with the drafted
// item(s)". The model complied — full draft, zero tools — but the announcement
// heuristic matched "checking"/"I'll" INSIDE the email body and flagged the
// compliant reply as a stall, three times, until the "unable to make progress"
// banner replaced the answer. A zero-tool text reply to a plain-text-contract
// directive is FULFILLMENT and must be delivered.
// Deliberately in the 200–300 char window: long enough for the consistency
// salvage, short enough that the (now length-bounded) announcement heuristic
// still flags it — so these tests exercise the stall machinery, not the
// parser fast-path. A LONGER draft now parses straight through (tested below).
const PRESENTED_DRAFT =
  'To: casey@example.com\nSubject: Quick market visibility question\n\n' +
  'Casey, the piece worth checking now is whether your reputation carries into ' +
  "AI-driven results. I'll include the full report link so you can see where " +
  'you show up across Google.\n\nGood to send?';

const STALL_DRAFT = PRESENTED_DRAFT.replace(
  'Good to send?',
  'This draft is ready for your review.',
);

test('runConversation: a substantive reply ending in a concrete question is delivered directly', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({
    history: items,
    lastResponseId: undefined,
    finalOutput: PRESENTED_DRAFT,
  });
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'send the outreach batch',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.ok(completed.some((e) => String(e.data.reply ?? e.data.summary ?? '').includes('Good to send?')));
  assert.equal(listEventsForConv(sess.id, { types: ['stuck_detected'] }).length, 0);
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

test('runConversation: a zero-tool text reply to the draft-present directive is DELIVERED (plain-text contract)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // Seed the draft-only-skill block so buildStallRetryMessage picks the
  // draft-present directive on retry.
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_returned',
    data: { tool: 'composio_execute_tool', result: 'Tool call refused by harness: GOAL_FIDELITY_CHECK_FAILED: ... PRESENT the drafted item(s) to the user as your reply now ... then ask "Good to send?"' },
  });
  // The model presents the draft (announcement-verb-laden text, zero tools)
  // every turn — exactly the live failure shape.
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: STALL_DRAFT });
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'send the outreach batch',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  // 2026-07-23: "ready for your review" is awaits-user-material, so the draft
  // now delivers on the FIRST turn (no stall, no retries) — the plain-text
  // contract path remains the backstop for shapes the suppressor misses.
  const delivered = completed.find((e) => /ready for your review/.test(String((e.data as { reply?: string }).reply ?? '')));
  assert.ok(delivered, 'the compliant draft reply is delivered');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'no "unable to make progress" banner');
});

// 2026-07-13 (F1 runaway): "Reply with just the word: ok" → the model correctly
// replies "ok" (zero tools), but STALL_OUTPUT_PATTERN nulls it as a generic ack and
// the stall steer ("you MUST call a tool") makes the model flail call_tool ~51× for
// a request that needs no tool. The verbatim-echo salvage delivers the exact literal
// the user explicitly requested and the steer never fires.
test('runConversation: an exact reply to a verbatim request is DELIVERED, no stall steer (F1 runaway fix)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // The model complies exactly — "ok", zero tools — the correct deliverable.
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: 'ok' });
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'Reply with just the word: ok',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  const delivered = completed.find((e) => (e.data as { reason?: string }).reason === 'verbatim_reply_fulfilled');
  assert.ok(delivered, 'the exact requested reply is delivered as verbatim fulfillment');
  assert.match(String((delivered!.data as { reply?: string }).reply ?? ''), /^ok$/);
  // The RETURN-VALUE lane must carry the reply too: respondViaHarness builds its
  // text from lastDecision, and an unset one shipped "(no reply produced)" on the
  // API/Discord surfaces (pre-patch review finding — class fix across all salvages).
  assert.equal(result.lastDecision?.reply, 'ok', 'the salvaged reply is mirrored into lastDecision for the respond-bridge lane');
  // The whole point: the stall steer that provokes the flail NEVER fires.
  assert.equal(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length, 0, 'no stall steer → no call_tool flail');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0);
});

// Guard the other side of the equality gate: a lazy generic ack on an OPEN task is
// NOT a verbatim request, so it must still fall through to the stall machinery and
// never be salvaged by the verbatim path.
test('runConversation: a bare "ok" on an OPEN task is NOT verbatim-salvaged (equality gate holds)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: 'ok' });
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'Analyze these 50 deals and summarize the risks',
    makeRunner: makeRunnerStub, runRunner,
  });
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(
    completed.filter((e) => (e.data as { reason?: string }).reason === 'verbatim_reply_fulfilled').length,
    0,
    'a lazy ack on an open task is never delivered as verbatim fulfillment',
  );
  // It IS treated as a stall (the deliberate lazy-punt rejection is intact).
  assert.ok(listEventsForConv(sess.id, { types: ['stuck_detected'] }).length > 0, 'a bare ack on an open task still stalls');
});

test('runConversation: a substantive answer repeated identically across stall retries is SALVAGED, not replaced by the banner', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // NO draft-only block seeded → the generic retry directive (demands a tool
  // call) is used, so the plain-text-contract exemption never applies and the
  // retries genuinely exhaust. The model confidently repeats the same
  // substantive text — the prose IS the deliverable.
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: STALL_DRAFT });
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'can I see the full draft please',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  // 2026-07-23: the awaits-user-material suppressor now delivers this reply on
  // the FIRST turn — zero retries burned. The consistent-repeat salvage stays
  // as the backstop for substantive answers with no user-material cue.
  const salvaged = completed.find((e) => /ready for your review/.test(String((e.data as { reply?: string }).reply ?? '')));
  assert.ok(salvaged, 'the consistent substantive reply is delivered');
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'no "unable to make progress" banner');
});

// Long-draft regression ("can i see 1 email example"): the announcement
// heuristic nulled the model's REAL plain-text answer ("Here's one example:
// To: casey@…") because the quoted draft contained "checking"/"I'll" — two
// full re-runs, 5 minutes, then the banner. The heuristic must only fire on
// SHORT text; a substantive reply that happens to contain a future-tense verb
// parses straight through as the completed reply.
test('toOrchestratorDecision: a LONG reply containing announcement verbs parses as the completed answer (not nulled)', () => {
  const longDraft =
    "Here's one example:\n\nTo: casey@example.com\nSubject: Harbor Law Group and AI search\n\n" +
    'Casey, your firm already has the kind of reputation most firms want. The piece worth checking now is ' +
    "whether that reputation carries into AI-driven results when clients ask full legal questions. I'll " +
    'include the full report link so you can see where you show up across Google, local search, and the ' +
    'new AI answers surface.\n\nGood to send?';
  assert.ok(longDraft.length > 300, 'fixture must exceed the announcement bound');
  const d = toOrchestratorDecision(longDraft);
  assert.ok(d && d.done === true && d.nextAction === 'completed', 'a substantive reply is never a zero-work punt');
  assert.match(d!.reply ?? '', /casey@example\.com/);
  // A SHORT future-tense punt is still nulled to the stall path.
  assert.equal(toOrchestratorDecision("I'll run the Outlook search now."), null);
});

test('toOrchestratorDecision: a hallucinated tool transcript AFTER a lead-in sentence is still a PUNT', () => {
  const fake =
    'Let me find the correct file path.\n\n**Tool Call: run_shell_command**\nStatus: Completed\n\nTerminal:\n' +
    '```\nfind /Users/n/.clementine-next -iname "*priority-account*"\n```';
  assert.equal(toOrchestratorDecision(fake), null, 'a lead-in sentence must not launder a fake transcript into a reply');
  assert.equal(
    toOrchestratorDecision('Calling `workflow_step_result` now with the required payload.'),
    null,
    'a short tool-call announcement with no payload is still a punt',
  );
  // A real reply with an "Options:"-style heading before a fence still completes.
  const real = 'Options:\n\n```\nnpm run build\n```\nRun the first one and the site rebuilds.';
  const d = toOrchestratorDecision(real);
  assert.ok(d && d.done === true, 'a plain heading before a fence is a real reply, not a transcript');
});

test('runConversation: a "**Tool: read**" missing-argument transcript is retried as a fake tool call, not completed', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const fake = "**Tool: read**\n\n*(No `path` provided in the assistant's tool call — the harness will supply required params.)*";
  const runRunner: RunRunnerFn = async (_agent, items) => ({
    history: items as never,
    lastResponseId: undefined,
    finalOutput: fake,
    toolCalls: 0,
  } as never);

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Read the transcript file and save the analysis JSON.',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.completedReason, 'sub_agent_stalled');
  const stuck = listEventsForConv(sess.id, { types: ['stuck_detected'] });
  assert.ok(stuck.length >= 1, 'fake tool transcript must be detected before completion');
  assert.equal((stuck[0].data as { fakeToolTranscript?: boolean }).fakeToolTranscript, true);
  assert.equal((stuck[0].data as { toolName?: string }).toolName, 'read');
});

test('runConversation: a SHORT announcement repeated across retries is still a stall — never salvaged', async () => {
  // This file pins HARNESS_STALL_ASK_USER=off; restore the production default
  // here so the test asserts the real exhaustion behavior (course-correct ask).
  const prev = process.env.HARNESS_STALL_ASK_USER;
  process.env.HARNESS_STALL_ASK_USER = 'on';
  try {
    resetEventLog();
    const sess = HarnessSession.create({ kind: 'chat' });
    // A genuine punt: one short future-tense line, repeated verbatim. The
    // consistency salvage must NOT deliver it (length guard) — the user still
    // gets the course-correct ask.
    const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: "I'll run the Outlook search now." });
    const result = await runConversation({
      agent: makeAgentStub(), sessionId: sess.id, input: 'do the thing',
      makeRunner: makeRunnerStub, runRunner,
    });
    assert.equal(result.status, 'awaiting_user_input');
    const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
    assert.ok(!completed.some((e) => (e.data as { reason?: string }).reason === 'stall_consistent_reply_salvaged'), 'a repeated short punt is never salvaged');
    assert.ok(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length >= 1, 'the course-correct ask still fires');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_STALL_ASK_USER; else process.env.HARNESS_STALL_ASK_USER = prev;
  }
});

// Synthetic Casey mailbox regression: an EMPTY/unstructured turn (items:1,
// lastResponseId:null, zero tools) dropped straight to "couldn't be structured.
// Please ask again." with no retry. It must be re-prompted instead.
test('runConversation: an EMPTY zero-tool turn is RETRIED, then recovers (not dropped as "couldn\'t be structured")', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // The empty-response sentinel runTurn synthesizes for an items:1/lastResponseId:null model turn.
  const EMPTY_SENTINEL = "Clementine produced a response that couldn't be structured. Please ask again.";
  let i = 0;
  const scripted: unknown[] = [
    EMPTY_SENTINEL, // turn 1: empty model response
    { summary: 'Located the fixture message.', reply: 'Found it — the email from Casey arrived at 10:00am.', done: true, nextAction: 'completed', reason: null },
  ];
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    const output = scripted[i] ?? scripted[scripted.length - 1];
    i += 1;
    return { history: items, lastResponseId: undefined, finalOutput: output };
  };
  const result = await runConversation({ agent: makeAgentStub(), sessionId: sess.id, input: 'find the fixture email from Casey', makeRunner: makeRunnerStub, runRunner });
  assert.equal(result.status, 'completed');
  const retries = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] });
  assert.ok(retries.some((e) => (e.data as { emptyOutput?: boolean }).emptyOutput === true), 'the empty turn was retried');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.match(String((completed.at(-1)!.data as { summary?: string }).summary ?? ''), /Casey/);
  assert.ok(!completed.some((e) => (e.data as { reason?: string }).reason === 'no_structured_output'), 'did not give up with "couldn\'t be structured"');
});

test('runConversation: a PERSISTENTLY empty response exhausts retries then completes (bounded — no infinite loop)', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const EMPTY_SENTINEL = "Clementine produced a response that couldn't be structured. Please ask again.";
  const runRunner: RunRunnerFn = async (_r, _a, items) => ({ history: items, lastResponseId: undefined, finalOutput: EMPTY_SENTINEL });
  const result = await runConversation({ agent: makeAgentStub(), sessionId: sess.id, input: 'do the thing', makeRunner: makeRunnerStub, runRunner });
  assert.equal(result.status, 'completed');
  assert.ok(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length >= 1, 'it retried before giving up');
  const candidates = listEventsForConv(sess.id, { types: ['conversation_recovery_candidate'] });
  assert.ok(candidates.some((e) => (e.data as { reason?: string }).reason === 'no_structured_output'), 'the private recovery candidate stands after retries exhaust');
  assert.equal(listEventsForConv(sess.id, { types: ['conversation_completed'] }).length, 0, 'the exhausted proposal is never published as a terminal');
  assert.ok(HarnessSession.load(sess.id)?.runInFlightSince(), 'the bridge-recoverable candidate leaves restart recovery armed');
});

test('runConversation: a durable terminal commit failure throws and leaves restart recovery armed', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const db = openEventLog();
  db.exec(`
    CREATE TRIGGER reject_test_terminal_commit
    BEFORE INSERT ON events
    WHEN NEW.type = 'conversation_completed'
    BEGIN
      SELECT RAISE(ABORT, 'injected terminal commit failure');
    END;
  `);
  try {
    await assert.rejects(
      runConversation({
        agent: makeAgentStub(),
        sessionId: sess.id,
        input: 'Finish this request.',
        makeRunner: makeRunnerStub,
        runRunner: async (_runner, _agent, items) => ({
          history: items,
          lastResponseId: undefined,
          finalOutput: {
            done: true,
            nextAction: 'completed',
            reply: 'The requested work is complete.',
            summary: 'Completed.',
            reason: null,
          },
        }),
      }),
      /injected terminal commit failure/,
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_test_terminal_commit');
  }
  assert.equal(listEventsForConv(sess.id, { types: ['conversation_completed'] }).length, 0);
  assert.ok(HarnessSession.load(sess.id)?.runInFlightSince(), 'an uncommitted public result remains restart-recoverable');
});

test('runConversation: accepted source and restart ownership exist before the first model call', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let acceptedAtModelStart: ReturnType<typeof listEventsForConv> = [];
  let markerAtModelStart: string | null = null;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Prove acceptance is crash-safe.',
    makeRunner: makeRunnerStub,
    runRunner: async (_runner, _agent, items) => {
      acceptedAtModelStart = listEventsForConv(sess.id, { types: ['user_input_received'] });
      markerAtModelStart = HarnessSession.load(sess.id)?.runInFlightSince() ?? null;
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: {
          done: true,
          nextAction: 'completed',
          reply: 'Acceptance is durable.',
          summary: 'Acceptance is durable.',
          reason: null,
        },
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(acceptedAtModelStart.length, 1, 'the accepted logical source predates execution');
  assert.equal(typeof markerAtModelStart, 'string', 'restart ownership is armed in the acceptance transaction');
  assert.equal(HarnessSession.load(sess.id)?.runInFlightSince(), null, 'the durable terminal settles ownership');
});

test('runConversation: a foreign active attempt keeps the shared recovery marker after this terminal', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const foreign = beginRunAttempt(sess.id, { runId: 'foreign-concurrent-owner' });
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Complete without clearing the other run marker.',
    makeRunner: makeRunnerStub,
    runRunner: async (_runner, _agent, items) => ({
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        done: true,
        nextAction: 'completed',
        reply: 'This logical turn completed.',
        summary: 'Completed.',
        reason: null,
      },
    }),
  });

  assert.equal(result.status, 'completed');
  assert.ok(HarnessSession.load(sess.id)?.runInFlightSince(), 'foreign recovery ownership survives this terminal');
  finishRunAttempt(foreign, 'completed');
  HarnessSession.load(sess.id)?.clearRunInFlight();
});

test('runConversation: a pre-flight stop publishes one typed cancellation for the accepted request', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  requestKill(sess.id, 'user pressed stop');
  let executed = false;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'stop this run',
    makeRunner: makeRunnerStub,
    runRunner: async () => {
      executed = true;
      throw new Error('must not execute');
    },
  });

  assert.equal(executed, false);
  assert.equal(result.status, 'killed');
  assert.equal(result.publicPresentation?.status, 'cancelled');
  assert.equal(result.publicPresentation?.kind, 'stopped');
  const accepted = listEventsForConv(sess.id, { types: ['user_input_received'] })[0];
  assert.equal(result.publicPresentation?.identity.sourceUserSeq, accepted.seq);
  assert.equal(result.publicPresentation?.identity.turn, accepted.turn);
  assert.equal(listEventsForConv(sess.id, { types: ['conversation_completed'] }).length, 1);
  assert.equal(HarnessSession.load(sess.id)?.runInFlightSince(), null, 'a committed cancellation clears restart recovery');
});

test('runConversation: propagates run_failed status when a turn throws', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([{ status: 'throw' }]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'do the thing',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /scripted_throw/);
  assert.equal(result.publicPresentation?.status, 'failed');
  assert.equal(result.publicPresentation?.kind, 'error');
  assert.equal(result.publicPresentation?.text, PUBLIC_RUN_FAILURE_TEXT);
});

test('runConversation: failure replay returns the persisted stable error and never duplicates the terminal', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const accepted = appendEvent({
    sessionId: sess.id,
    turn: 7,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Run the same accepted request.' },
  });
  const privateDetail = 'provider-secret diagnostic 529 upstream trace';
  const runRunner: RunRunnerFn = async () => {
    throw new Error(privateDetail);
  };
  const run = () => runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'Run the same accepted request.',
    sourceUserSeq: accepted.seq,
    reuseRecordedUserInput: true,
    makeRunner: makeRunnerStub,
    runRunner,
  });

  const first = await run();
  const replay = await run();

  assert.equal(first.status, 'failed');
  assert.equal(replay.status, 'failed');
  assert.equal(first.publicPresentation?.text, PUBLIC_RUN_FAILURE_TEXT);
  assert.deepEqual(replay.publicPresentation, first.publicPresentation, 'the replay returns the already-persisted public winner');
  assert.doesNotMatch(first.publicPresentation?.text ?? '', /provider-secret|529|upstream/i);
  assert.deepEqual(first.publicPresentation?.identity, {
    sessionId: sess.id,
    turn: accepted.turn,
    sourceUserSeq: accepted.seq,
  }, 'logical terminal identity comes from the accepted event, not either physical failed turn');
  const failures = listEventsForConv(sess.id, { types: ['run_failed'] });
  assert.equal(failures.length, 2, 'each executor attempt remains privately observable');
  assert.ok(failures.some((event) => JSON.stringify(event.data).includes(privateDetail)));
  const terminals = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, 'the logical request has exactly one public terminal');
  assert.equal(terminals[0].turn, accepted.turn);
  assert.equal(HarnessSession.load(sess.id)?.runInFlightSince(), null, 'the persisted terminal settles restart recovery after replay');
});

test('isCodexAuthRevoked: a real revoke marker is terminal; a BARE model 401 is NOT (refresh-and-retry, no brick)', async () => {
  const { markCodexAuthDead, clearCodexAuthDead, isCodexAuthDead } = await import('../auth-store.js');
  clearCodexAuthDead();
  assert.equal(isCodexAuthDead(), false, 'precondition: auth not latched dead');

  // Real revoke markers ARE terminal (these genuinely mean re-login).
  assert.equal(isCodexAuthRevoked(new Error('Encountered invalidated oauth token for user, failing request'), 'Encountered invalidated oauth token for user, failing request'), true);
  assert.equal(isCodexAuthRevoked({}, 'token_revoked'), true);
  assert.equal(isCodexAuthRevoked({ status: 401 }, 'Codex /responses returned 401: invalid_grant'), true, 'a 401 carrying a revoke marker is terminal');

  // THE FIX: a marker-less model 401 (access-token expiry / edge reject) must
  // NOT be classified as a revoke — streamCodex already force-refreshed+retried
  // it, so latching DEAD here is the bug that bricked users on a transient blip.
  assert.equal(isCodexAuthRevoked({ status: 401 }, 'Codex /responses returned 401 Unauthorized'), false, 'a bare 401 no longer bricks auth');

  // …unless auth is genuinely DEAD (the refresh token itself was rejected, which
  // latches DEAD inside refreshStoredNativeOAuth) — then even a bare 401 is terminal.
  markCodexAuthDead('refresh token revoked');
  assert.equal(isCodexAuthRevoked({ status: 401 }, 'Codex /responses returned 401 Unauthorized'), true, 'once DEAD-latched, surface re-auth');

  // 2026-07-07 regression: the DEAD latch is a fact about CODEX auth, not a
  // verdict on every error. While latched, a DIFFERENT brain's unrelated
  // failure must NOT be rebranded as "Codex sign-in expired" (observed live:
  // a GLM/Together run hard-failed with the Codex re-auth message while the
  // real error was a Together credit-limit 402 — terminal + cause masked).
  assert.equal(
    isCodexAuthRevoked({ status: 402 }, '402 Credit limit exceeded, please add credits'),
    false,
    'latched + non-auth-shaped (BYO 402) stays recoverable',
  );
  assert.equal(
    isCodexAuthRevoked(new Error('model backend timeout'), 'model backend timeout'),
    false,
    'latched + generic model error stays recoverable',
  );
  // …while codex-lane / auth-shaped errors still hit the latch.
  assert.equal(
    isCodexAuthRevoked({ status: 403 }, 'forbidden'),
    true,
    'latched + auth-shaped (403) surfaces re-auth',
  );
  clearCodexAuthDead();

  // Not auth: a 429 rate limit or a generic failure must NOT be misclassified.
  assert.equal(isCodexAuthRevoked({ status: 429 }, 'Codex /responses returned 429'), false);
  assert.equal(isCodexAuthRevoked(new Error('scripted_throw'), 'scripted_throw'), false);
  assert.equal(isCodexAuthRevoked(null, 'some tool failed'), false);
});

// ─── 2026-06-12: async workflow dispatch is a complete deliverable ───────────

test('dispatchedBackgroundWorkflowRun: detects a queued workflow_run this turn, not other turns/tools', async () => {
  const { dispatchedBackgroundWorkflowRun } = await import('./loop.js');
  const { writeToolOutput } = await import('./eventlog.js');
  const sess = createSession({ kind: 'chat' });

  // No calls at all → false.
  assert.equal(dispatchedBackgroundWorkflowRun(sess.id, 1), false);

  // A queued dispatch on turn 1.
  const queuedCall = appendEvent({
    sessionId: sess.id, turn: 1, role: 'system', type: 'tool_called',
    data: { tool: 'workflow_run', callId: 'call_wfrun_1', arguments: '{"name":"x"}' },
  });
  writeToolOutput({
    sessionId: sess.id, callId: 'call_wfrun_1', tool: 'workflow_run',
    invocationNonce: 'queued-success',
    output: 'Queued "x" (run 123-abc) — it is now running in the BACKGROUND. Tell the user…',
  });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'tool', type: 'tool_returned',
    parentEventId: queuedCall.id,
    data: { tool: 'workflow_run', callId: 'call_wfrun_1', ok: true },
  });
  assert.equal(dispatchedBackgroundWorkflowRun(sess.id, 1), true, 'queued dispatch this turn is detected');
  assert.equal(dispatchedBackgroundWorkflowRun(sess.id, 2), false, 'a different turn does not inherit the dispatch');

  // A workflow_run whose output is NOT a queue success (e.g. validation refusal) → false.
  const sess2 = createSession({ kind: 'chat' });
  const refusedCall = appendEvent({
    sessionId: sess2.id, turn: 1, role: 'system', type: 'tool_called',
    data: { tool: 'workflow_run', callId: 'call_wfrun_2', arguments: '{"name":"y"}' },
  });
  writeToolOutput({
    sessionId: sess2.id, callId: 'call_wfrun_2', tool: 'workflow_run',
    invocationNonce: 'refused-dispatch',
    output: 'Workflow "y" is disabled.',
  });
  appendEvent({
    sessionId: sess2.id, turn: 1, role: 'tool', type: 'tool_returned',
    parentEventId: refusedCall.id,
    data: { tool: 'workflow_run', callId: 'call_wfrun_2', ok: false },
  });
  assert.equal(dispatchedBackgroundWorkflowRun(sess2.id, 1), false, 'a refused dispatch still gets judged');

  // Reused SDK ids cannot let an older queue success settle a later/refused
  // dispatch. Two exact invocation rows make the authority deliberately
  // ambiguous even though the legacy longest-output slot contains success.
  const sess3 = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess3.id, turn: 1, role: 'system', type: 'tool_called',
    data: { tool: 'workflow_run', callId: 'call_wfrun_reused', arguments: '{"name":"z"}' },
  });
  writeToolOutput({
    sessionId: sess3.id,
    callId: 'call_wfrun_reused',
    invocationNonce: 'older-success',
    tool: 'workflow_run',
    output: 'Queued "z" (run stale) — it is now running in the BACKGROUND. Tell the user…',
  });
  writeToolOutput({
    sessionId: sess3.id,
    callId: 'call_wfrun_reused',
    invocationNonce: 'current-refusal',
    tool: 'workflow_run',
    output: 'Workflow "z" is disabled.',
  });
  assert.equal(
    dispatchedBackgroundWorkflowRun(sess3.id, 1),
    false,
    'a reused call id cannot inherit an older queue receipt',
  );
});

test('runConversation: a receipt-backed structured workflow handoff parks after one turn without polling', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let runs = 0;
  const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
    runs += 1;
    const runContext = { context: opts.context };
    const details = {
      toolCall: {
        callId: 'call_workflow_dispatch',
        arguments: '{"name":"social-manager-rc"}',
      },
    };
    (runner as unknown as EventEmitter).emit(
      'agent_tool_start',
      runContext,
      { name: 'Orchestrator' },
      { name: 'workflow_run' },
      details,
    );
    writeToolOutput({
      sessionId: sess.id,
      callId: 'call_workflow_dispatch',
      tool: 'workflow_run',
      output:
        'Queued "social-manager-rc" (run run-123) — it is now running in the BACKGROUND. '
        + 'Its outcome will be delivered to this chat automatically.',
    });
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'The social-manager workflow is running in the background.',
        reply: 'It is running in the background. I’ll report back here when it finishes.',
        done: false,
        nextAction: 'awaiting_handoff_result',
        reason: 'Waiting for the automatic workflow report-back.',
      },
    };
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'run the social-manager workflow',
    makeRunner: makeRunnerStub,
    runRunner,
    judgeFn: async () => {
      throw new Error('a queued workflow must not invoke the completion judge');
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(runs, 1, 'the foreground model is not called again while the daemon owns the run');
  assert.equal(result.lastDecision?.done, true);
  assert.equal(result.lastDecision?.nextAction, 'completed');
  assert.equal(result.lastDecision?.reason, 'queued_workflow_owns_continuation');
  assert.equal(listEventsForConv(sess.id, { types: ['stuck_detected'] }).length, 0);
  const calls = listEventsForConv(sess.id, { types: ['tool_called'] });
  assert.deepEqual(
    calls.map((event) => (event.data as { tool?: string }).tool),
    ['workflow_run'],
    'no workflow_run_status poll is generated',
  );
});

test('speed: a hanging embeddings provider cannot gate model dispatch (fire-and-forget recall vector)', async () => {
  // Live incident 2026-07-03: the OpenAI embeddings endpoint degraded (6s fetch
  // timeouts + retries) and, because the turn awaited Promise.all(primer,
  // primeTurnRecallVector), EVERY turn paid the full embed wait before the
  // model dispatched — 9.9s pre-brain on a greeting. The recall vector is an
  // opportunistic enrichment (TTL'd slot read at fact-recall time; late arrival
  // still helps, absence just drops the relevance term), so it must be
  // fire-and-forget. This pins that: an embed that NEVER resolves must not
  // delay the model beyond the primer's own bounded budget.
  resetEventLog();
  const { _setEmbeddingProviderForTest } = await import('../../memory/embeddings.js');
  const sess = HarnessSession.create({ kind: 'chat' });
  _setEmbeddingProviderForTest({
    name: 'hang',
    model: 'hang-test',
    dim: 4,
    embed: () => new Promise(() => { /* never resolves */ }),
  } as never);
  try {
    let modelDispatchedAtMs = 0;
    const startedAtMs = Date.now();
    const runRunner: RunRunnerFn = async (_agent, items) => {
      modelDispatchedAtMs = Date.now();
      return {
        history: items as never,
        lastResponseId: undefined,
        finalOutput: { summary: 'fast', reply: 'hi', done: true, nextAction: 'completed', reason: null },
      } as never;
    };
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'hello there',
      makeRunner: makeRunnerStub,
      runRunner,
    });
    assert.equal(result.status, 'completed');
    assert.ok(modelDispatchedAtMs > 0, 'model was dispatched');
    const preBrainMs = modelDispatchedAtMs - startedAtMs;
    // Pre-fix this waited on the hanging embed until the 15s assembly outer
    // race fired. Post-fix the wait is the primer's own bounded budget (800ms
    // hybrid race + fts overhead). 5s = generous CI headroom, far below 15s.
    assert.ok(preBrainMs < 5_000, `pre-brain wait gated by hanging embed: ${preBrainMs}ms`);
  } finally {
    _setEmbeddingProviderForTest(undefined as never);
  }
});

test('plain-text decision: a hallucinated tool call as markdown is a PUNT, not a completed reply (2026-07-08 Joshua Tree deploy)', () => {
  const fake = '**run_shell_command**\n```\ncd /Users/n/Projects/site && netlify deploy --dir "." --prod\n```';
  assert.equal(toOrchestratorDecision(fake), null, 'tool-shaped heading + fence must route to the stall nudge');
  const xmlFake = [
    'Calling `workflow_step_result` with the required payload now.',
    '<function_calls>',
    '<invoke name="workflow_step_result">',
    '<parameter name="report">GENERIC_HARNESS_STEP</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n');
  assert.equal(toOrchestratorDecision(xmlFake), null, 'Claude-style XML function_calls must route to the stall nudge');
  // A real reply that mentions a command inline (longer, prose-led) still completes.
  const real = `The site is live at https://example.netlify.app — I deployed it with netlify deploy after building all sections. ${'Detail. '.repeat(300)}`;
  const d = toOrchestratorDecision(real);
  assert.ok(d && d.done === true && (d.reply ?? '').includes('live'), 'prose replies keep completing');
});

// ─── Stranded-tool reunification: a turn dies mid-tool, the tool completes later ─
test('orphaned tool: a turn death with a tool IN FLIGHT registers it; a completed batch drains into a report turn (once)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' }).id;
  // A run_batch call was issued on turn 3 and never returned (the turn died on an
  // infra timeout while it kept executing).
  appendEvent({ sessionId: sess, turn: 3, role: 'Clem', type: 'tool_called', data: { tool: 'run_batch', callId: 'c-batch-1', arguments: '{}' } });
  recordOrphanedToolInFlight(sess, 3);
  assert.equal(listEvents(sess, { types: ['orphaned_tool_inflight'] }).length, 1, 'the in-flight tool was registered at death');

  // Not yet complete → drain produces nothing.
  assert.equal(drainOrphanedToolCompletions(sess).length, 0, 'nothing to report until the tool completes');

  // The batch finishes (7/8) minutes later — its own event lands on the session.
  appendEvent({ sessionId: sess, turn: 3, role: 'system', type: 'batch_completed', data: { batchId: 'batch-xyz', total: 8, succeeded: 7, failed: 1, halted: false } });

  const reports = drainOrphanedToolCompletions(sess);
  assert.equal(reports.length, 1, 'the completed batch drains into ONE report');
  assert.equal(reports[0].toolName, 'run_batch');
  assert.match(reports[0].directive, /7\/8 succeeded/, 'the report carries the real result');
  assert.match(reports[0].directive, /Report the actual outcome to the user/i);
  assert.equal(listEvents(sess, { types: ['orphaned_tool_reported'] }).length, 1, 'marked reported');

  // No double-fire: a second drain reports nothing.
  assert.equal(drainOrphanedToolCompletions(sess).length, 0, 'already reported — no double-fire');
});

test('orphaned tool: a SURVIVED turn (tool returned) registers no orphan and drains nothing', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sess, turn: 1, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'c-ok', arguments: '{}' } });
  appendEvent({ sessionId: sess, turn: 1, role: 'tool', type: 'tool_returned', data: { tool: 'composio_execute_tool', callId: 'c-ok', result: 'sent' } });
  // Even if recordOrphanedToolInFlight runs (it never does on a survived turn),
  // the returned call is not registered.
  recordOrphanedToolInFlight(sess, 1);
  assert.equal(listEvents(sess, { types: ['orphaned_tool_inflight'] }).length, 0, 'a returned call is never an orphan');
  assert.equal(drainOrphanedToolCompletions(sess).length, 0);
});

test('orphaned native MCP call registers and reports one physical transport execution', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sess, turn: 2, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'toolu-orphan', accounting: 'top_level', arguments: '{"tool_slug":"GOOGLEDOCS_CREATE_DOCUMENT"}' } });
  appendEvent({ sessionId: sess, turn: 2, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'mcp-orphan', accounting: 'transport_mirror', args: { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT' } } });

  recordOrphanedToolInFlight(sess, 2);
  const markers = listEvents(sess, { types: ['orphaned_tool_inflight'] });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].data.callId, 'mcp-orphan', 'the physical callback owns the eventual post-stream return');

  appendEvent({ sessionId: sess, turn: 2, role: 'tool', type: 'tool_returned', data: { tool: 'composio_execute_tool', callId: 'mcp-orphan', accounting: 'transport_mirror', ok: true, preview: 'created document doc-123' } });
  const reports = drainOrphanedToolCompletions(sess);
  assert.equal(reports.length, 1);
  assert.match(reports[0].directive, /created document doc-123/);
  assert.equal(drainOrphanedToolCompletions(sess).length, 0);
});

test('orphan pairing skips a returned identical canonical before the later live native MCP call', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' }).id;
  const argumentsJson = '{"tool_slug":"GOOGLEDOCS_CREATE_DOCUMENT","arguments":{"title":"Firm brief"}}';
  appendEvent({ sessionId: sess, turn: 4, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'toolu-returned', accounting: 'top_level', arguments: argumentsJson } });
  appendEvent({ sessionId: sess, turn: 4, role: 'tool', type: 'tool_returned', data: { tool: 'composio_execute_tool', callId: 'toolu-returned', accounting: 'top_level', ok: true } });
  appendEvent({ sessionId: sess, turn: 4, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'toolu-live', accounting: 'top_level', arguments: argumentsJson } });
  appendEvent({ sessionId: sess, turn: 4, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'mcp-live', accounting: 'transport_mirror', args: { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT', arguments: { title: 'Firm brief' } } } });

  recordOrphanedToolInFlight(sess, 4);
  const markers = listEvents(sess, { types: ['orphaned_tool_inflight'] });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].data.callId, 'mcp-live');
});

test('a transport mirror arriving after canonical orphan registration reconciles into one report', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' }).id;
  const longBody = 'private-document-body '.repeat(30);
  assert.ok(longBody.length > 500);
  const fullArgs = { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT', arguments: { title: 'Late mirror', content: longBody } };
  const correlationFingerprint = toolCallCorrelationFingerprint('composio_execute_tool', fullArgs);
  appendEvent({ sessionId: sess, turn: 5, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'toolu-late', accounting: 'top_level', arguments: JSON.stringify(fullArgs), correlationFingerprint } });

  recordOrphanedToolInFlight(sess, 5);
  assert.deepEqual(
    listEvents(sess, { types: ['orphaned_tool_inflight'] }).map((event) => event.data.callId),
    ['toolu-late'],
  );

  appendEvent({ sessionId: sess, turn: 5, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'mcp-late', accounting: 'transport_mirror', args: { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT', arguments: { title: 'Late mirror', content: `${longBody.slice(0, 300)}…` } }, correlationFingerprint } });
  // A second death-path pass must not add a mirror marker for the same action.
  recordOrphanedToolInFlight(sess, 5);
  assert.equal(listEvents(sess, { types: ['orphaned_tool_inflight'] }).length, 1);

  appendEvent({ sessionId: sess, turn: 5, role: 'tool', type: 'tool_returned', data: { tool: 'composio_execute_tool', callId: 'mcp-late', accounting: 'transport_mirror', ok: true, preview: 'created document doc-late' } });
  const reports = drainOrphanedToolCompletions(sess);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].callId, 'toolu-late');
  assert.match(reports[0].directive, /created document doc-late/);
  assert.equal(drainOrphanedToolCompletions(sess).length, 0);
});

test('orphaned tool: the sweep driver fires ONE report turn per completed orphan', async () => {
  resetEventLog();
  const { sweepOrphanedToolReports } = await import('../../execution/orphan-tool-reports.js');
  const sess = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sess, turn: 2, role: 'Clem', type: 'tool_called', data: { tool: 'run_batch', callId: 'c-sweep', arguments: '{}' } });
  recordOrphanedToolInFlight(sess, 2);
  appendEvent({ sessionId: sess, turn: 2, role: 'system', type: 'batch_completed', data: { batchId: 'b1', total: 3, succeeded: 3, failed: 0 } });

  const fired: Array<{ sessionId: string; directive: string }> = [];
  const result = sweepOrphanedToolReports({
    now: () => Date.now(),
    recentSessionIds: () => [sess],
    drain: (id) => drainOrphanedToolCompletions(id),
    fire: (sessionId, report) => { fired.push({ sessionId, directive: report.directive }); },
  });
  assert.equal(result.fired, 1, 'one report turn fired');
  assert.equal(fired[0].sessionId, sess);
  assert.match(fired[0].directive, /3\/3 succeeded/);
  // Idempotent across ticks: a second sweep fires nothing.
  assert.equal(sweepOrphanedToolReports({ now: () => Date.now(), recentSessionIds: () => [sess], drain: (id) => drainOrphanedToolCompletions(id), fire: () => { throw new Error('should not fire'); } }).fired, 0);
});

test('orphaned tool: production claim is acknowledged only after durable outbox handoff', async () => {
  resetEventLog();
  const {
    _testOnly_createOrphanReportCoordinator,
    sweepOrphanedToolReports,
  } = await import('../../execution/orphan-tool-reports.js');
  const makeCompletedOrphan = (sessionId: string, callId: string): void => {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'Clem',
      type: 'tool_called',
      data: { tool: 'run_batch', callId, arguments: '{}' },
    });
    recordOrphanedToolInFlight(sessionId, 1);
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'batch_completed',
      data: { batchId: `batch-${callId}`, total: 2, succeeded: 2, failed: 0 },
    });
  };

  const failedSession = createSession({ kind: 'chat' }).id;
  makeCompletedOrphan(failedSession, 'claim-failed-outbox');
  const blockedParent = path.join(mkdtempSync(path.join(os.tmpdir(), 'clem-orphan-claim-fail-')), 'file');
  writeFileSync(blockedParent, 'not a directory');
  const failedCoordinator = _testOnly_createOrphanReportCoordinator(
    1,
    path.join(blockedParent, 'outbox.json'),
  );
  const failed = sweepOrphanedToolReports({
    now: () => Date.now(),
    recentSessionIds: () => [failedSession],
    claim: (sessionId) => claimOrphanedToolCompletions(sessionId),
    fire: () => {
      throw new Error('an unpersisted claim must never launch');
    },
  }, failedCoordinator);
  assert.equal(failed.fired, 0);
  assert.equal(
    listEvents(failedSession, { types: ['orphaned_tool_reported'] }).length,
    0,
    'an outbox failure leaves source evidence unacknowledged',
  );
  assert.equal(
    claimOrphanedToolCompletions(failedSession).reports.length,
    1,
    'the exact completion remains claimable after the failed handoff',
  );

  const successSession = createSession({ kind: 'chat' }).id;
  makeCompletedOrphan(successSession, 'claim-success');
  const outboxPath = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'clem-orphan-claim-success-')),
    'state',
    'outbox.json',
  );
  const successCoordinator = _testOnly_createOrphanReportCoordinator(1, outboxPath);
  let fireCount = 0;
  const success = sweepOrphanedToolReports({
    now: () => Date.now(),
    recentSessionIds: () => [successSession],
    claim: (sessionId) => claimOrphanedToolCompletions(sessionId),
    fire: async () => { fireCount += 1; },
  }, successCoordinator);
  assert.equal(success.fired, 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fireCount, 1);
  assert.equal(
    listEvents(successSession, { types: ['orphaned_tool_reported'] }).length,
    1,
    'a successful durable handoff acknowledges the source exactly once',
  );
  assert.equal(claimOrphanedToolCompletions(successSession).reports.length, 0);
});

// ─── Ask-first contract regression fixtures ─────────────────────────────────
// Live incident: the completion judge bounced a permission question ("want me
// to send the 55?"), the scold-continuation pushed the agent from asking into
// doing, and YOLO waved the send through. These pin the three loop-side fixes.

test('ask-first invariant: a completed-tagged direction question yields awaiting_user_input and NEVER reaches the judge', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: {
      summary: 'Resumed the email thread and asked how to proceed',
      reply: 'Yes — we’re on the 60 priority-account reactivation emails.\n\nDo you want me to pick up by sending the 55 send-ready emails now, or review the drafts first?',
      done: true, nextAction: 'completed', reason: null } },
  ]);
  let judgeInvoked = false;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'hey can we get back to those 60 emails we were working on yesterday',
    judgeCompletion: true,
    judgeFn: async () => { judgeInvoked = true; return { done: false, reason: 'Assistant only asked a follow-up question' }; },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'the question IS the deliverable — turn yields to the user');
  assert.equal(result.steps, 1, 'no scold-continuation');
  assert.equal(judgeInvoked, false, 'deterministic invariant fires BEFORE the completion judge');
  const tripped = listEvents(sess.id, { types: ['guardrail_tripped'] })
    .filter((e) => (e.data as { kind?: string }).kind === 'ask_first_invariant');
  assert.equal(tripped.length, 1, 'invariant recorded for the audit trail');
});

test('selfJudge NOT-DONE gets exactly ONE bounce; the second disagreement is advisory', async () => {
  // Refined after adversarial review: full-advisory would disable the
  // completion net for every single-provider install, while TWO hard
  // self-bounces is what drove the regression into unapproved sends. The
  // contract is one bounce (with the ask-permitting text), then advisory.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'built it', reply: 'Done — report saved to /tmp/report.md', done: true, nextAction: 'completed', reason: null } },
    { finalOutput: { summary: 'still done', reply: 'Done — report saved to /tmp/report.md with the figures.', done: true, nextAction: 'completed', reason: null } },
  ]);
  let judgeCalls = 0;
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'build me a research report on solar adoption',
    judgeCompletion: true,
    judgeFn: async () => { judgeCalls += 1; return { done: false, reason: 'wants more evidence', selfJudge: true }; },
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.steps, 2, 'exactly one bounce — the second self-disagreement must not force a third turn');
  assert.equal(judgeCalls, 2);
  const advisories = listEvents(sess.id, { types: ['heartbeat'] })
    .filter((e) => (e.data as { kind?: string }).kind === 'self_judge_advisory');
  assert.equal(advisories.length, 1, 'second disagreement recorded as advisory');
  assert.notEqual(result.status, 'failed');
});

test('AWAITING judge verdict commits a typed needs-input presentation', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const runner = scriptedRunner([
    { finalOutput: {
      summary: 'partial progress, needs a decision',
      reply: 'Progress report: 10 of 60 sent. The remaining 50 are staged and need your go/no-go before anything else goes out.',
      done: true, nextAction: 'completed', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'finish the reactivation email batch',
    judgeCompletion: true,
    judgeFn: async () => ({ done: true, awaitingUser: true, reason: 'assistant paused for the user\'s send decision' }),
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(result.steps, 1);
  const completed = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.delivered, false, 'a pause is public but is not falsely marked done');
  assert.equal((completed.data as { awaitingUser?: boolean }).awaitingUser, true);
  assert.equal((completed.data.turnOutcome as { status?: string }).status, 'needs_input');
  assert.match(String((completed.data.presentation as { text?: string }).text), /remaining 50 are staged/i);
});

test('an old question plus a short affirmation never suppresses a new material question', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // A stale turn-0 question is not identity-bearing consent for a later choice.
  appendEvent({ sessionId: sess.id, turn: 0, role: 'Clem', type: 'awaiting_user_input', data: { question: 'Should I send the next 20?' } });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'asked mailbox', reply: 'Which mailbox should I send from?', done: false, nextAction: 'awaiting_user_input', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'yes',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(result.steps, 1);
});

test('a qualified reply still halts on a follow-up question', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({ sessionId: sess.id, turn: 0, role: 'Clem', type: 'awaiting_user_input', data: { question: 'Should I send the next 20?' } });
  const runner = scriptedRunner([
    { finalOutput: { summary: 'asked', reply: 'Which mailbox should I send from?', done: false, nextAction: 'awaiting_user_input', reason: null } },
  ]);
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'actually only send 5, and skip the law firms',
    makeRunner: makeRunnerStub,
    runRunner: runner,
  });
  assert.equal(result.status, 'awaiting_user_input', 'a qualified reply is NOT consent — the question halts');
  assert.equal(result.steps, 1);
});

test('E2E memory-credit loop: a primed fact reproduced in the reply earns recall_auto_credit', async () => {
  resetEventLog();
  const { getFact } = await import('../../memory/facts.js');
  const fact = rememberFact({
    kind: 'project',
    content: 'The Meridian invoice 8842 must be paid before July 30 or the discount lapses.',
  });
  const sess = HarnessSession.create({ kind: 'chat' });
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => ({
    history: items,
    lastResponseId: undefined,
    finalOutput: {
      summary: 'answered from memory',
      reply: 'Invoice 8842 needs to be paid before July 30 to keep the discount — want me to schedule it?',
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  }) as never;

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'anything urgent on the Meridian account?',
    makeRunner: makeRunnerStub,
    runRunner,
  });
  assert.equal(result.status, 'completed');

  const creditEvents = listEventsForConv(sess.id, { types: ['recall_auto_credit'] });
  assert.ok(creditEvents.length >= 1, 'the turn emits a recall_auto_credit event');
  const runs = (creditEvents[0].data as { runs: Array<{ refs: Array<{ ref: string; evidence: string }> }> }).runs;
  assert.ok(
    runs.some((r) => r.refs.some((ref) => ref.ref === `fact:${fact.id}`)),
    'the reproduced fact is the credited ref',
  );
  assert.equal(getFact(fact.id)?.utilityCount, 1, 'the credit reached the utility counter');
});

test('Stage 4 E2E: a run that exhausts its token budget parks with the paired continue prompt', async () => {
  resetEventLog();
  const prevCeiling = process.env.HARNESS_MAX_RUN_TOKENS;
  process.env.HARNESS_MAX_RUN_TOKENS = '1000';
  try {
    const { accrueSessionTokens } = await import('./eventlog.js');
    const sess = HarnessSession.create({ kind: 'chat' });
    let calls = 0;
    const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
      calls += 1;
      // Simulate real spend landing during the turn (what recordModelUsage does).
      accrueSessionTokens(sess.id, 600);
      return {
        history: items,
        lastResponseId: undefined,
        // toolCalls > 0 keeps the zero-tool stall machinery out of the way —
        // this test exercises the budget boundary, not stall detection.
        toolCalls: 3,
        // Plain-text marker contract: CONTINUE: keeps the loop going.
        finalOutput: `CONTINUE: enriched batch ${calls} of 40, more to do`,
      } as never;
    };
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'do a long thing',
      makeRunner: makeRunnerStub,
      runRunner,
    });
    assert.equal(result.status, 'limit_exceeded');
    assert.equal(result.limitKind, 'token_budget');
    assert.ok(calls >= 2, 'the ceiling parked the run at a boundary, not mid-first-turn');
    const limitEvents = listEventsForConv(sess.id, { types: ['conversation_limit_exceeded'] });
    assert.ok(limitEvents.some((e) => (e.data as { reason?: string }).reason === 'token_budget'));
    const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
    const park = completed.find((e) => (e.data as { reason?: string }).reason === 'awaiting_continue');
    assert.ok(park, 'the paired awaiting_continue completion fires (surfaces treat a bare limit event as non-terminal)');
    assert.match(String((park!.data as { reply?: string }).reply ?? ''), /token budget/i);
  } finally {
    if (prevCeiling === undefined) delete process.env.HARNESS_MAX_RUN_TOKENS;
    else process.env.HARNESS_MAX_RUN_TOKENS = prevCeiling;
  }
});

test('Stage 4 E2E: kill-switch off — the same over-budget run finishes without a park', async () => {
  resetEventLog();
  const prevCeiling = process.env.HARNESS_MAX_RUN_TOKENS;
  const prevSwitch = process.env.CLEMMY_RUN_TOKEN_BUDGET;
  process.env.HARNESS_MAX_RUN_TOKENS = '1000';
  process.env.CLEMMY_RUN_TOKEN_BUDGET = 'off';
  try {
    const { accrueSessionTokens } = await import('./eventlog.js');
    const sess = HarnessSession.create({ kind: 'chat' });
    let calls = 0;
    const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
      calls += 1;
      accrueSessionTokens(sess.id, 600);
      return {
        history: items,
        lastResponseId: undefined,
        toolCalls: 3,
        finalOutput: calls >= 3
          ? 'Finished the thing.'
          : `CONTINUE: batch ${calls} done, more to do`,
      } as never;
    };
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'do a long thing',
      makeRunner: makeRunnerStub,
      runRunner,
    });
    assert.equal(result.status, 'completed', 'enforcement off ⇒ no budget park');
    assert.equal(listEventsForConv(sess.id, { types: ['conversation_limit_exceeded'] }).length, 0);
  } finally {
    if (prevCeiling === undefined) delete process.env.HARNESS_MAX_RUN_TOKENS;
    else process.env.HARNESS_MAX_RUN_TOKENS = prevCeiling;
    if (prevSwitch === undefined) delete process.env.CLEMMY_RUN_TOKEN_BUDGET;
    else process.env.CLEMMY_RUN_TOKEN_BUDGET = prevSwitch;
  }
});

test('recipientGroundingNote surfaces the omission on the approval card, or nothing when clean', () => {
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  // No advisory yet → no note.
  assert.equal(recipientGroundingNote(session.id, { toolName: 'composio_execute_tool', args: {} } as any), null);
  // The recipient gate emitted an omission advisory for this send.
  appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'system',
    type: 'guardrail_tripped',
    data: {
      kind: 'recipient_set_omission_advisory',
      toolName: 'composio_execute_tool',
      recipients: ['a@x.co', 'b@x.co', 'c@x.co'],
      omittedRecipients: ['d@x.co', 'e@x.co', 'f@x.co', 'g@x.co', 'h@x.co'],
    },
  });
  const note = recipientGroundingNote(session.id, { toolName: 'composio_execute_tool', args: {} } as any);
  assert.match(note ?? '', /OMITS 5/);
  assert.match(note ?? '', /3 of 8/);
  assert.match(note ?? '', /d@x\.co/);
});

test('L1 (v2.3.0): a DONE decision with a non-completed action and no reply ALSO earns the self-retry', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let calls = 0;
  const inputs: string[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    const last = items.at(-1) as { content?: string } | undefined;
    inputs.push(String(last?.content ?? ''));
    calls += 1;
    if (calls === 1) {
      // The live 2026-07-22 shape: done stands, action isn't 'completed', no
      // user-facing reply — pre-fix this skipped the retry and surfaced the
      // fallback after the user had already nudged the run repeatedly.
      return {
        history: items as never,
        lastResponseId: undefined,
        finalOutput: {
          summary: 'Ran 8 tools; internal ledger only.',
          reply: null,
          done: true,
          nextAction: 'abandoned',
          reason: null,
        },
      } as never;
    }
    return {
      history: items as never,
      lastResponseId: undefined,
      finalOutput: {
        summary: 'All drafts recovered and placed.',
        reply: 'All 29 drafts are in your Outlook drafts folder.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    } as never;
  };

  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: sess.id,
    input: 'drop them in my drafts',
    makeRunner: makeRunnerStub,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.match(inputs.at(-1) ?? '', /NO visible answer/, 'the self-retry fired');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(completed.data.summary, 'All 29 drafts are in your Outlook drafts folder.');
});

// ---------------------------------------------------------------------------
// Stall recovery must NEVER speak harness meta-language to the user
// (live 2026-07-23 on v2.5.5: "the model produced text without taking action
// twice in a row. Should I retry, switch approach, or stop here?" reached a
// real planning conversation). Contract: retries exhaust → ONE recovery turn
// asks the model for the user-facing reply → only if THAT fails, a plain
// human floor with no jargon and no tri-choice.
// ---------------------------------------------------------------------------

const RECOVERY_SUMMARY_REPLY =
  'I was partway through pulling the prospect list for your team and hit a wall reading the Salesforce results. ' +
  'I have the first 15 accounts identified so far. Want me to keep going with those while we sort the rest?';

test('runConversation: exhausted stall retries trigger ONE recovery-summary turn whose reply is DELIVERED', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // Mirror the live incident: the session had REAL prior tool work (Outlook
  // searches) before the stall — so a summary recounting progress is honest
  // and passes the recovery vet.
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_called',
    data: { tool: 'composio_execute_tool', toolSlug: 'OUTLOOK_GET_MAIL_DELTA', args: '{}' },
  });
  let calls = 0;
  const runRunner: RunRunnerFn = async (_r, _a, items) => {
    calls += 1;
    const input = JSON.stringify(items);
    // The recovery directive is recognizable by its contract phrasing.
    const isRecoveryTurn = /do not call another tool/i.test(input) && /where you are/i.test(input);
    return {
      history: items,
      lastResponseId: undefined,
      finalOutput: isRecoveryTurn ? RECOVERY_SUMMARY_REPLY : 'Continuing.',
    };
  };
  const result = await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'find 15 prospects for my team in salesforce',
    makeRunner: makeRunnerStub, runRunner,
  });
  assert.equal(result.status, 'completed');
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.ok(
    completed.some((e) => /first 15 accounts identified/.test(String((e.data as { reply?: string }).reply ?? ''))),
    'the recovery summary IS the delivered reply',
  );
  assert.equal(listEventsForConv(sess.id, { types: ['awaiting_user_input'] }).length, 0, 'no meta-failure ask');
  const recoveryAttempts = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] })
    .filter((e) => (e.data as { attempt?: unknown }).attempt === 'recovery_summary');
  assert.equal(recoveryAttempts.length, 1, 'exactly one recovery-summary turn');
});

test('runConversation: when even the recovery turn fails, the floor is HUMAN language — no jargon, no tri-choice', async () => {
  resetEventLog();
  // This file pins HARNESS_STALL_ASK_USER=off; restore the production default
  // for the floor path (same idiom as the execute-button truth test above).
  const prev = process.env.HARNESS_STALL_ASK_USER;
  process.env.HARNESS_STALL_ASK_USER = 'on';
  try {
    const sess = HarnessSession.create({ kind: 'chat' });
    const runRunner: RunRunnerFn = async (_r, _a, items) => ({
      history: items, lastResponseId: undefined, finalOutput: 'Continuing.',
    });
    const result = await runConversation({
      agent: makeAgentStub(), sessionId: sess.id, input: 'find 15 prospects for my team in salesforce',
      makeRunner: makeRunnerStub, runRunner,
    });
    assert.equal(result.status, 'awaiting_user_input');
    const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
    assert.equal(asks.length, 1);
    const q = String((asks[0].data as { question?: string }).question ?? '');
    assert.match(q, /pick it back up fresh/, 'floor is the plain-language ask');
    for (const banned of ['unable to make progress', 'the model', 'switch approach', 'retry', 'tool']) {
      assert.ok(!q.toLowerCase().includes(banned), `floor never says "${banned}"`);
    }
    const opts = (asks[0].data as { options?: string[] }).options ?? [];
    assert.deepEqual(opts, ['Continue', 'Start over'], 'options are human actions, not harness verbs');
    const recoveryAttempts = listEventsForConv(sess.id, { types: ['stall_retry_attempted'] })
      .filter((e) => (e.data as { attempt?: unknown }).attempt === 'recovery_summary');
    assert.equal(recoveryAttempts.length, 1, 'the recovery turn was spent before the floor');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_STALL_ASK_USER; else process.env.HARNESS_STALL_ASK_USER = prev;
  }
});

// ---------------------------------------------------------------------------
// Stall judge (2026-07-24) — the verb-regex exit ramp. For AMBIGUOUS
// prose-shape stalls only, one cross-family judge question decides reply vs
// punt on first detection. Authority is one-directional: the judge can only
// override toward DELIVERY; on "stall"/failure the deterministic machinery
// (retry → recovery turn → human floor) proceeds unchanged.
// ---------------------------------------------------------------------------

test('stall judge: "deliver" verdict finalizes the ambiguous reply with no stuck event, no retries', async () => {
  const { _setStallJudgeForTests } = await import('./stall-judge.js');
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // A novel phrasing no regex knows — the class the judge exists for.
  const novelReply = 'Happy to hold here — the moment your announcement copy lands I can weave it into each of the 15 drafts.';
  let judgeCalls = 0;
  _setStallJudgeForTests(async () => { judgeCalls += 1; return 'deliver'; });
  try {
    // Force the ambiguous stall shape: zero tools + announcement-ish text.
    const runner = scriptedRunner([{ finalOutput: `I’ll weave it in. ${novelReply}` }]);
    const result = await runConversation({
      agent: makeAgentStub(), sessionId: sess.id, input: 'ill send the copy over soon',
      judgeFn: async () => ({ done: true, reason: 'the conversational reply is deliverable' }),
      makeRunner: makeRunnerStub, runRunner: runner,
    });
    assert.equal(result.status, 'completed');
    assert.equal(judgeCalls, 1, 'judge consulted exactly once');
    const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
    assert.ok(completed.some((e) => (e.data as { reason?: string }).reason === 'stall_judge_delivered'));
    assert.equal(listEventsForConv(sess.id, { types: ['stuck_detected'] }).length, 0, 'no stuck event on judge delivery');
    assert.equal(listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length, 0, 'no retries burned');
  } finally {
    _setStallJudgeForTests(null);
  }
});

test('stall judge: unstructured delivery still passes the zero-tool objective blocker before completion', async () => {
  const { _setStallJudgeForTests } = await import('./stall-judge.js');
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let runs = 0;
  let objectiveJudgeCalls = 0;
  _setStallJudgeForTests(async () => 'deliver');
  try {
    const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
      runs += 1;
      if (runs === 1) {
        return {
          history: items,
          lastResponseId: undefined,
          finalOutput: 'I’ll compile the complete launch brief now and return the validated risks and recommendations here shortly.',
        };
      }
      const ee = runner as unknown as EventEmitter;
      const runContext = { context: opts.context };
      const tool = { name: 'web_search' };
      const details = { toolCall: { callId: 'launch-research', arguments: '{"query":"launch risks"}' } };
      ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, tool, details);
      ee.emit(
        'agent_tool_end',
        runContext,
        { name: 'Orchestrator' },
        tool,
        'Verified research evidence for audience, positioning, channel risks, and mitigations.',
        details,
      );
      const decision = {
        summary: 'Launch brief completed from verified research.',
        reply: 'The launch brief now covers the audience, positioning, channel risks, and concrete mitigations.',
        done: true,
        nextAction: 'completed',
        reason: null,
      };
      ee.emit('agent_end', runContext, { name: 'Orchestrator' }, decision);
      return { history: items, lastResponseId: undefined, finalOutput: decision };
    };

    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'Research the launch and produce a complete brief with risks and recommendations.',
      judgeCompletion: true,
      judgeFn: async () => {
        objectiveJudgeCalls += 1;
        return { done: false, reason: 'Zero tool calls and no launch brief evidence were produced.' };
      },
      makeRunner: makeRunnerStub,
      runRunner,
    });

    assert.equal(result.status, 'completed');
    assert.equal(runs, 2, 'judge salvage cannot turn a zero-tool action promise into an early completion');
    assert.equal(objectiveJudgeCalls, 1, 'the ordinary objective gate audits the salvaged first turn');
    const completionVerdicts = listEventsForConv(sess.id, { types: ['verdict_recorded'] })
      .filter((event) => event.data.door === 'completion');
    assert.equal(completionVerdicts[0]?.data.pass, false);
    assert.match(String(completionVerdicts[0]?.data.reason ?? ''), /zero tool calls/i);
    const completions = listEventsForConv(sess.id, { types: ['conversation_completed'] });
    assert.equal(completions.length, 1, 'the accepted request has one public terminal across both physical turns');
    assert.equal(completions[0].data.steps, 2, 'the winner is the post-judge continuation, not the salvaged promise');
    assert.match(String((completions[0].data.presentation as { text?: unknown }).text ?? ''), /launch brief now covers/i);
    assert.doesNotMatch(String((completions[0].data.presentation as { text?: unknown }).text ?? ''), /return the validated risks.*shortly/i);
  } finally {
    _setStallJudgeForTests(null);
  }
});

test('stall judge: structured delivery cannot certify a fresh external write with only stale evidence', async () => {
  const { _setStallJudgeForTests } = await import('./stall-judge.js');
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'GOOGLESHEETS_VALUES_UPDATE', targets: ['Sheet1!E1:G5'], receipt: 'stale-write-before-request' },
  });
  let runs = 0;
  let stallJudgeCalls = 0;
  let objectiveJudgeCalls = 0;
  _setStallJudgeForTests(async () => {
    stallJudgeCalls += 1;
    return 'deliver';
  });
  try {
    const runRunner: RunRunnerFn = async (runner, _agent, items, opts) => {
      runs += 1;
      if (runs === 1) {
        const blockedDecision = {
          summary: 'Google Sheets tools are not available in this run.',
          reply: 'I cannot complete the requested Google Sheets write because its tools are not available in this run.',
          done: true,
          nextAction: 'completed',
          reason: 'Google Sheets tool access is unavailable.',
        };
        return { history: items, lastResponseId: undefined, finalOutput: blockedDecision };
      }

      const ee = runner as unknown as EventEmitter;
      const runContext = { context: opts.context };
      const writeTool = { name: 'composio_execute_tool' };
      const writeDetails = {
        toolCall: {
          callId: 'stall-salvage-fresh-write',
          arguments: '{"tool_slug":"GOOGLESHEETS_VALUES_UPDATE","arguments":{"range":"Sheet1!E1:G5"}}',
        },
      };
      ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, writeTool, writeDetails);
      appendEvent({
        sessionId: sess.id,
        turn: 2,
        role: 'system',
        type: 'external_write',
        data: { shapeKey: 'GOOGLESHEETS_VALUES_UPDATE', targets: ['Sheet1!E1:G5'], receipt: 'fresh-write-after-request' },
      });
      ee.emit(
        'agent_tool_end',
        runContext,
        { name: 'Orchestrator' },
        writeTool,
        'fresh write receipt fresh-write-after-request',
        writeDetails,
      );
      const readDetails = {
        toolCall: {
          callId: 'stall-salvage-readback',
          arguments: '{"tool_slug":"GOOGLESHEETS_BATCH_GET","arguments":{"ranges":["Sheet1!E1:G5"]}}',
        },
      };
      ee.emit('agent_tool_start', runContext, { name: 'Orchestrator' }, writeTool, readDetails);
      ee.emit(
        'agent_tool_end',
        runContext,
        { name: 'Orchestrator' },
        writeTool,
        'read-back matched the fresh write receipt',
        readDetails,
      );
      const completedDecision = {
        summary: 'Fresh Google Sheets write and read-back verified.',
        reply: 'The requested Google Sheets range now has a fresh write receipt, and the immediate read-back matched.',
        done: true,
        nextAction: 'completed',
        reason: null,
      };
      ee.emit('agent_end', runContext, { name: 'Orchestrator' }, completedDecision);
      return { history: items, lastResponseId: undefined, finalOutput: completedDecision };
    };

    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'Perform exactly one fresh Google Sheets value write to Sheet1!E1:G5 and read it back.',
      judgeCompletion: true,
      judgeFn: async () => {
        objectiveJudgeCalls += 1;
        return { done: true, reason: 'the reply claims the task is resolved' };
      },
      makeRunner: makeRunnerStub,
      runRunner,
    });

    assert.equal(result.status, 'completed');
    assert.equal(stallJudgeCalls, 1);
    assert.equal(objectiveJudgeCalls, 1, 'the structured salvage reaches the ordinary completion judge');
    assert.equal(runs, 2, 'stale evidence cannot let the structured salvage finalize');
    const completionVerdicts = listEventsForConv(sess.id, { types: ['verdict_recorded'] })
      .filter((event) => event.data.door === 'completion');
    assert.equal(completionVerdicts[0]?.data.pass, false, 'freshness overrides the language-model PASS');
    assert.match(String(completionVerdicts[0]?.data.reason ?? ''), /no external-write receipt after the user event/i);
    const completions = listEventsForConv(sess.id, { types: ['conversation_completed'] });
    assert.equal(completions.length, 1, 'the accepted request has one public terminal across both physical turns');
    assert.equal(completions[0].data.steps, 2, 'the stale structured salvage never wins the terminal race');
    assert.match(String((completions[0].data.presentation as { text?: unknown }).text ?? ''), /fresh write receipt/i);
    assert.doesNotMatch(String((completions[0].data.presentation as { text?: unknown }).text ?? ''), /tools are not available/i);
    assert.equal(listEventsForConv(sess.id, { types: ['external_write'] }).length, 2, 'one stale fixture plus one request-bound write');
  } finally {
    _setStallJudgeForTests(null);
  }
});

test('stall judge: structured delivery preserves an explicit blocked state instead of manufacturing completed', async () => {
  const { _setStallJudgeForTests } = await import('./stall-judge.js');
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let objectiveJudgeCalls = 0;
  _setStallJudgeForTests(async () => 'deliver');
  try {
    const blockedDecision = {
      summary: 'Salesforce is not connected.',
      reply: 'I cannot complete this pull because Salesforce tools are not available in this run. Connect Salesforce in the Connections screen, then I can continue.',
      done: false,
      nextAction: 'awaiting_user_input',
      reason: 'Salesforce connection is required.',
    };
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: sess.id,
      input: 'Pull the prospects from Salesforce.',
      judgeCompletion: true,
      judgeFn: async () => {
        objectiveJudgeCalls += 1;
        return { done: true, reason: 'reply is readable' };
      },
      makeRunner: makeRunnerStub,
      runRunner: scriptedRunner([{ finalOutput: blockedDecision }]),
    });

    assert.equal(result.status, 'awaiting_user_input');
    assert.equal(result.lastDecision?.nextAction, 'awaiting_user_input');
    assert.equal(objectiveJudgeCalls, 0, 'a reply judge cannot rewrite an explicit pause into a completion candidate');
    const asks = listEventsForConv(sess.id, { types: ['awaiting_user_input'] });
    assert.ok(asks.some((event) => /Connections screen/i.test(String(event.data.question ?? ''))));
    const falseGreens = listEventsForConv(sess.id, { types: ['conversation_completed'] })
      .filter((event) => event.data.delivered === true && event.data.reason === 'stall_judge_delivered');
    assert.equal(falseGreens.length, 0);
  } finally {
    _setStallJudgeForTests(null);
  }
});

test('stall judge: "stall" and "unavailable" verdicts leave the deterministic machinery unchanged', async () => {
  const { _setStallJudgeForTests } = await import('./stall-judge.js');
  for (const verdict of ['stall', 'unavailable'] as const) {
    resetEventLog();
    const sess = HarnessSession.create({ kind: 'chat' });
    _setStallJudgeForTests(async () => verdict);
    try {
      const runner = scriptedRunner([{ finalOutput: 'I’ll run the Salesforce pull now and report back shortly.' }]);
      await runConversation({
        agent: makeAgentStub(), sessionId: sess.id, input: 'pull the prospects',
        makeRunner: makeRunnerStub, runRunner: runner,
      });
      assert.ok(
        listEventsForConv(sess.id, { types: ['stuck_detected'] }).length >= 1,
        `verdict=${verdict}: the punt still stalls`,
      );
      assert.ok(
        listEventsForConv(sess.id, { types: ['stall_retry_attempted'] }).length >= 1,
        `verdict=${verdict}: retries still fire`,
      );
    } finally {
      _setStallJudgeForTests(null);
    }
  }
});

test('stall judge: detected-bad shapes never consult the judge (deterministic stays deterministic)', async () => {
  const { _setStallJudgeForTests } = await import('./stall-judge.js');
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let judgeCalls = 0;
  _setStallJudgeForTests(async () => { judgeCalls += 1; return 'deliver'; });
  try {
    // A fake tool transcript — harness-owned fact, not a prose guess.
    const fake = '**run_shell_command**\n```\nsf data query --query "SELECT Id FROM Account"\n```';
    const runner = scriptedRunner([{ finalOutput: fake }]);
    await runConversation({
      agent: makeAgentStub(), sessionId: sess.id, input: 'pull the accounts',
      makeRunner: makeRunnerStub, runRunner: runner,
    });
    assert.equal(judgeCalls, 0, 'a lying transcript is never sent to the judge');
    assert.ok(listEventsForConv(sess.id, { types: ['stuck_detected'] }).length >= 1);
  } finally {
    _setStallJudgeForTests(null);
  }
});

// Placeholder extinction, server floor (live 2026-07-24): completions with
// nothing visible rendered "(Done.)" / "(Finished without a written reply.)"
// in a real conversation. finalizeStandardConversation is the chokepoint —
// an empty completion floors to the turn report or the honest fallback.
test('an empty completion floors to visible text — the client never has to invent scaffolding', async () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  // A parsed decision whose reply AND summary are empty (the live shape-1
  // event: {"steps":1,"reply":null,"delivered":true}).
  const emptyDecision = JSON.stringify({ summary: '', reply: '', done: true, nextAction: 'completed', reason: null });
  const runner = scriptedRunner([{ finalOutput: emptyDecision }]);
  await runConversation({
    agent: makeAgentStub(), sessionId: sess.id, input: 'approve',
    makeRunner: makeRunnerStub, runRunner: runner,
  });
  const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
  assert.ok(completed.length >= 1);
  for (const e of completed) {
    const d = e.data as { reply?: string | null; summary?: string | null };
    const visible = (typeof d.reply === 'string' && d.reply.trim()) || (typeof d.summary === 'string' && d.summary.trim());
    assert.ok(visible, `every completion carries visible text: ${JSON.stringify(e.data).slice(0, 120)}`);
    assert.ok(!String(visible).includes('(Done.)'), 'no parenthetical scaffolding');
  }
});

// Robust-tool-call audit (2026-07-24): a shape-match must never kill a
// legitimate answer. Two classes the judge now rules on with tailored
// guidance; deterministic bypasses stay for genuine lies.

test('stall judge: an instructional "show me the command" answer is judged, not killed as a fake transcript', async () => {
  const { _setStallJudgeForTests } = await import('./stall-judge.js');
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let judgeCalls = 0;
  _setStallJudgeForTests(async () => { judgeCalls += 1; return 'deliver'; });
  try {
    const instructional = 'Here’s the exact command you’d run:\n\n**run_shell_command**\n```\nsf data query --query "SELECT Id, Name FROM Account LIMIT 15"\n```\nSwap the LIMIT for your batch size.';
    const runner = scriptedRunner([{ finalOutput: instructional }]);
    const result = await runConversation({
      agent: makeAgentStub(), sessionId: sess.id, input: 'can you show me the command you would run for the salesforce pull',
      makeRunner: makeRunnerStub, runRunner: runner,
    });
    assert.equal(result.status, 'completed');
    assert.equal(judgeCalls, 1, 'instructional transcript goes to the judge');
    const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
    assert.ok(completed.some((e) => /sf data query/.test(String((e.data as { reply?: string }).reply ?? ''))), 'the command answer is delivered');
  } finally {
    _setStallJudgeForTests(null);
  }
});

test('stall judge: an honest "integration not connected" report is visible but parked as blocked', async () => {
  const { _setStallJudgeForTests } = await import('./stall-judge.js');
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let judgeCalls = 0;
  _setStallJudgeForTests(async () => { judgeCalls += 1; return 'deliver'; });
  try {
    const honestGap = 'I cannot complete this Salesforce pull because there are no Salesforce tools connected in this run — connect Salesforce in the Connections screen and I’ll run it immediately after.';
    const runner = scriptedRunner([{ finalOutput: honestGap }]);
    const result = await runConversation({
      agent: makeAgentStub(), sessionId: sess.id, input: 'pull the 15 prospects from salesforce',
      makeRunner: makeRunnerStub, runRunner: runner,
    });
    assert.equal(result.status, 'awaiting_user_input');
    assert.equal(judgeCalls, 1, 'the tool-unavailable claim is judged, not auto-condemned');
    const completed = listEventsForConv(sess.id, { types: ['conversation_completed'] });
    assert.ok(completed.some((e) => /Connections screen/.test(String((e.data as { reply?: string }).reply ?? ''))), 'the honest gap report reaches the user');
    assert.ok(completed.every((e) => (e.data as { delivered?: boolean }).delivered === false), 'visible blocker is never banked as delivered');
    assert.ok(completed.every((e) => (e.data as { reason?: string }).reason !== 'stall_judge_delivered'));
  } finally {
    _setStallJudgeForTests(null);
  }
});

test('stall judge: a fake transcript on a NON-instructional ask keeps the deterministic bypass (no judge)', async () => {
  const { _setStallJudgeForTests } = await import('./stall-judge.js');
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  let judgeCalls = 0;
  _setStallJudgeForTests(async () => { judgeCalls += 1; return 'deliver'; });
  try {
    const fake = '**run_shell_command**\n```\nsf data query --query "SELECT Id FROM Account"\n```';
    const runner = scriptedRunner([{ finalOutput: fake }]);
    await runConversation({
      agent: makeAgentStub(), sessionId: sess.id, input: 'pull the accounts and put them in the sheet',
      makeRunner: makeRunnerStub, runRunner: runner,
    });
    assert.equal(judgeCalls, 0, 'a lying transcript on a do-the-work ask is never judge-eligible');
    assert.ok(listEventsForConv(sess.id, { types: ['stuck_detected'] }).length >= 1);
  } finally {
    _setStallJudgeForTests(null);
  }
});

test('primer FALLBACK facts record a session-stamped recall run — parity with the unified path (2026-07-31)', async () => {
  const { factsBlockForPrimer } = await import('./loop.js');
  const { rememberFact } = await import('../../memory/facts.js');
  const { openMemoryDb } = await import('../../memory/db.js');
  const fact = rememberFact({ kind: 'project', content: 'The Beacon rollout window is Thursday evenings.' });

  const block = factsBlockForPrimer('Beacon rollout window', 'sess-fallback-pin');
  assert.ok(block.text.includes('Beacon rollout window'), 'the fact is injected');
  assert.ok(block.recallId, 'the fallback records a run instead of injecting credit-blind (observed recallId:null live 2026-07-31)');
  const row = openMemoryDb().prepare(
    'SELECT surface, session_id FROM memory_recall_runs WHERE id = ?',
  ).get(block.recallId) as { surface: string; session_id: string | null };
  assert.equal(row.surface, 'automatic_primer_fallback');
  assert.equal(row.session_id, 'sess-fallback-pin', 'session stamp makes the fallback sweepable for post-turn credit');
  void fact;
});

test('primer recall ceiling covers measured p90 and matches the Claude lane (2026-07-31)', async () => {
  const { TURN_MEMORY_PRIMER_HYBRID_TIMEOUT_MS } = await import('./loop.js');
  // Live 7d data: unified recall p50=658ms / p90=1370ms. A ceiling under p90
  // silently downgrades ~1 in 8 turns to the lexical fallback. Both brains
  // must agree on how long good memory is worth waiting for.
  assert.ok(TURN_MEMORY_PRIMER_HYBRID_TIMEOUT_MS >= 1500,
    'the Codex-lane primer ceiling must cover measured p90 recall latency');
});
