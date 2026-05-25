#!/usr/bin/env node
// scripts/verify-long-running.mjs
//
// Phase B smoke test for long-running durability (v0.5.19).
//
// Runs deterministic, offline sub-tests that exercise each Capacity-Aware
// Clem fix from F1–F8. The script doubles as:
//   1. Regression protection for the harness reliability surface — every
//      future change adds (or extends) a sub-test.
//   2. Hot-patch verification — `--only=<name>` runs a single sub-test
//      against the installed Clementine.app dist after `hot-patch.sh`.
//   3. Release gate — `--all` must pass before tagging.
//
// Usage:
//   node scripts/verify-long-running.mjs --all
//   node scripts/verify-long-running.mjs --only=preflight-block-references-real-tools
//   node scripts/verify-long-running.mjs --list
//
// Exits 0 on green smoke. Non-zero with a one-line diagnosis per failure.
// Writes a JSON summary to ~/.clementine-next/state/verify-long-running-<ts>.json
// for cross-release diff.

import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

// ─── Plumbing ──────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DAEMON_DIST = path.join(REPO_ROOT, 'dist');

if (!existsSync(path.join(DAEMON_DIST, 'runtime/harness/loop.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

const palette = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { red: '', green: '', yellow: '', cyan: '', dim: '', bold: '', reset: '' };

let failures = 0;
const results = [];

function pass(name, detail) {
  console.log(`  ${palette.green}✓${palette.reset} ${name}`);
  if (detail) console.log(`      ${palette.dim}${detail}${palette.reset}`);
  results.push({ name, status: 'pass', detail: detail ?? null });
}
function fail(name, detail) {
  failures++;
  console.log(`  ${palette.red}✗${palette.reset} ${name}`);
  if (detail) console.log(`      ${palette.dim}${detail}${palette.reset}`);
  results.push({ name, status: 'fail', detail: detail ?? null });
}
function skip(name, detail) {
  console.log(`  ${palette.yellow}○${palette.reset} ${name} ${palette.dim}(pending)${palette.reset}`);
  if (detail) console.log(`      ${palette.dim}${detail}${palette.reset}`);
  results.push({ name, status: 'skip', detail: detail ?? null });
}
function section(title) { console.log(`\n${palette.bold}→ ${title}${palette.reset}`); }
function info(line) { console.log(`      ${palette.dim}${line}${palette.reset}`); }

// ─── Sandbox HOME so the smoke script can't pollute real state ─────

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-verify-long-running-'));
mkdirSync(path.join(tmpHome, '.clementine-next', 'state'), { recursive: true });
const originalHome = process.env.HOME;
const originalUserprofile = process.env.USERPROFILE;
const originalClemmyHome = process.env.CLEMENTINE_HOME;
process.env.HOME = tmpHome;
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');
if (process.platform === 'win32') process.env.USERPROFILE = tmpHome;

process.on('exit', () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile;
  if (originalClemmyHome !== undefined) process.env.CLEMENTINE_HOME = originalClemmyHome;
  else delete process.env.CLEMENTINE_HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ─── Sub-test registry ─────────────────────────────────────────────

const SUB_TESTS = {
  'preflight-block-references-real-tools': testPreflightBlockReferencesRealTools,
  'auto-elevate-on-warn': testAutoElevateOnWarn,
  'workflow-preflight-compacts': testWorkflowPreflightCompacts,
  'stall-converts-to-question': testStallConvertsToQuestion,
  'sse-truncate-capture': testSseTruncateCapture,
  'loop-detection-survives-restart': testLoopDetectionSurvivesRestart,
  'discord-token-expiry-thinking-indicator': testDiscordTokenExpiryThinkingIndicator,
  '80-tool-call-end-to-end-chat-dock': test80ToolCallEndToEnd,
  'retry-context-injection': testRetryContextInjection,
  'approval-preview-auto-enrichment': testApprovalPreviewAutoEnrichment,
  'codex-transport-timeout-routes-to-f4': testCodexTransportTimeoutRoutesToF4,
  'cli-discovery-surfaces-in-diagnostics': testCliDiscoverySurfacesInDiagnostics,
};

// ─── F1 — preflight-block-references-real-tools ────────────────────
//
// Calls the exported `buildPreflightBlockMessage` helper directly with
// a synthetic verdict and asserts the v2 message references the two
// real tools (create_plan, ask_user_question) and does NOT reference
// the v1 phantom tools (propose_plan, batch_external_calls).

async function testPreflightBlockReferencesRealTools() {
  const loop = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/loop.js')).href);
  if (typeof loop.buildPreflightBlockMessage !== 'function') {
    return fail('preflight-block-references-real-tools', 'buildPreflightBlockMessage not exported from loop.js');
  }
  // Ensure v2 is on (default behavior).
  delete process.env.CLEMMY_PREFLIGHT_BLOCK_MESSAGE_V2;
  const msg = loop.buildPreflightBlockMessage({
    predictedTokens: 300_000,
    blockFraction: 0.85,
    effectiveLimit: 400_000,
  });
  const checks = [
    { ok: msg.includes('create_plan'), label: 'mentions create_plan' },
    { ok: msg.includes('ask_user_question'), label: 'mentions ask_user_question' },
    { ok: !msg.includes('propose_plan'), label: 'does NOT mention propose_plan (phantom)' },
    { ok: !msg.includes('batch_external_calls'), label: 'does NOT mention batch_external_calls (phantom)' },
    { ok: msg.includes('PREFLIGHT BUDGET BLOCK'), label: 'preserves operator-visible header' },
    { ok: msg.includes('300,000'), label: 'interpolates predicted tokens with locale formatting' },
  ];
  // Revert lever still works: with v2=off, v1 wording returns.
  process.env.CLEMMY_PREFLIGHT_BLOCK_MESSAGE_V2 = 'off';
  const v1Msg = loop.buildPreflightBlockMessage({
    predictedTokens: 1, blockFraction: 0.85, effectiveLimit: 1,
  });
  checks.push({ ok: v1Msg.includes('propose_plan'), label: 'v1 fallback still emits propose_plan when knob=off' });
  delete process.env.CLEMMY_PREFLIGHT_BLOCK_MESSAGE_V2;

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('preflight-block-references-real-tools', `${checks.length} assertions passed`);
  } else {
    fail('preflight-block-references-real-tools', `${failed.length} assertions failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── F2 — auto-elevate-on-warn ─────────────────────────────────────
//
// Two-pronged verification:
//   1. Direct: getElevatedBudget(standard) returns a long-shaped
//      runtime; getElevatedBudget(long) returns input unchanged
//      (one-way ratchet); getElevatedBudget with CLEMMY_AUTOBUMP_BUDGET=off
//      returns input unchanged regardless.
//   2. End-to-end: spin a chat session that synthesizes a warn-level
//      preflight verdict via the eventlog, run a turn, assert
//      `budget_elevated` event fires + ceilings raised for the next
//      turn.

async function testAutoElevateOnWarn() {
  const budgetSettings = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/budget-settings.js')).href);
  const eventlog = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/eventlog.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/session.js')).href);
  const loop = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/loop.js')).href);

  const standardRuntime = {
    preset: 'standard',
    maxConversationSteps: 40,
    maxConversationWallMinutes: 120,
    maxConversationWallMs: 120 * 60 * 1000,
    maxTurns: 40,
    toolCallsPerTurn: 40,
    checkInMinutes: 10,
    autoContinueOnLimit: false,
    unlimited: false,
  };

  // Knob default on
  delete process.env.CLEMMY_AUTOBUMP_BUDGET;
  const elevated = budgetSettings.getElevatedBudget(standardRuntime);
  const checks = [];
  checks.push({ ok: elevated.maxConversationSteps >= 160, label: 'standard → elevated: maxSteps >= 160' });
  checks.push({ ok: elevated.maxTurns >= 120, label: 'standard → elevated: maxTurns >= 120' });
  checks.push({ ok: elevated.toolCallsPerTurn >= 80, label: 'standard → elevated: toolCallsPerTurn >= 80' });
  checks.push({ ok: elevated.autoContinueOnLimit === true, label: 'standard → elevated: autoContinueOnLimit flips to true' });
  // One-way ratchet: long stays long.
  const longRuntime = { ...standardRuntime, preset: 'long', maxConversationSteps: 160, maxTurns: 120, toolCallsPerTurn: 80, autoContinueOnLimit: true };
  const longUnchanged = budgetSettings.getElevatedBudget(longRuntime);
  checks.push({ ok: longUnchanged === longRuntime, label: 'long → unchanged (one-way ratchet)' });
  // Knob off: noop.
  process.env.CLEMMY_AUTOBUMP_BUDGET = 'off';
  const knobOff = budgetSettings.getElevatedBudget(standardRuntime);
  checks.push({ ok: knobOff === standardRuntime, label: 'CLEMMY_AUTOBUMP_BUDGET=off: noop' });
  delete process.env.CLEMMY_AUTOBUMP_BUDGET;

  // End-to-end: run a turn that emits a warn-verdict, assert
  // budget_elevated fires on the next iteration. Easiest path: inject
  // the warn event into the eventlog inside the runRunner so that the
  // outer loop sees it when it reads recent guardrail_tripped events.
  eventlog.resetEventLog?.();
  // Use the standard preset by default for this test.
  process.env.HARNESS_BUDGET_PRESET = 'standard';
  // Disable the preflight gate's own auto-injection (we're synthesizing the verdict).
  process.env.CLEMMY_PREFLIGHT_GATE = 'off';

  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'auto-elevate smoke' });
  let turnCount = 0;
  const runRunner = async (_runner, _agent, items, opts) => {
    turnCount += 1;
    const turn = opts?.context?.turn ?? turnCount;
    // Synthesize a warn preflight verdict on the first turn only.
    if (turnCount === 1) {
      eventlog.appendEvent({
        sessionId: opts?.context?.sessionId ?? sess.id,
        turn,
        role: 'system',
        type: 'guardrail_tripped',
        data: {
          kind: 'preflight_budget_check',
          status: 'warn',
          predictedTokens: 220_000,
          effectiveLimit: 400_000,
          fractionUsed: 0.55,
          plannedToolCallCount: 8,
          avgToolReturnTokens: 4_000,
          adaptive: true,
        },
      });
    }
    const isLast = turnCount >= 2;
    return {
      history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'k' }] }],
      lastResponseId: `resp_elev_${turnCount}`,
      finalOutput: isLast
        ? { summary: 'done', reply: 'done', done: true, nextAction: 'completed' }
        : { summary: 'continuing', reply: null, done: false, nextAction: 'awaiting_handoff_result' },
    };
  };
  const makeRunnerStub = () => new EventEmitter();
  await loop.runConversation({
    agent: { model: 'gpt-5.5' },
    sessionId: sess.id,
    input: 'do the long thing',
    runRunner,
    makeRunner: makeRunnerStub,
    // Do NOT pass explicit maxSteps/maxTurns/toolCallsPerTurn — let
    // the loop pull from budget so elevation can raise them.
  });

  const events = eventlog.listEvents(sess.id);
  const elevatedEvents = events.filter((e) => e.type === 'budget_elevated');
  checks.push({ ok: elevatedEvents.length === 1, label: `1 budget_elevated event (got ${elevatedEvents.length})` });
  if (elevatedEvents.length > 0) {
    const evt = elevatedEvents[0];
    checks.push({ ok: evt.data?.reason === 'preflight_warn', label: `budget_elevated.reason === 'preflight_warn'` });
    checks.push({ ok: evt.data?.to?.maxSteps >= 160, label: 'elevated.to.maxSteps >= 160' });
    checks.push({ ok: evt.data?.to?.toolCallsPerTurn >= 80, label: 'elevated.to.toolCallsPerTurn >= 80' });
  }

  delete process.env.HARNESS_BUDGET_PRESET;
  delete process.env.CLEMMY_PREFLIGHT_GATE;

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('auto-elevate-on-warn', `${checks.length} assertions passed`);
  } else {
    fail('auto-elevate-on-warn', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── F3 — workflow-preflight-compacts ──────────────────────────────
//
// Runs a workflow-kind session through runTurn and forces the
// preflight verdict into 'block' by setting an absurdly low effective
// context limit (CLEMMY_MODEL_CONTEXT_LIMIT_GPT55=10_000 forces a
// real conversation > 10K tokens to project block). Asserts:
//   - preflight_budget_check event fires with status=block
//   - workflow_step_overbudget event fires for the workflow kind
//   - chat-only block-message injection does NOT happen (no system
//     message naming create_plan / ask_user_question)
//   - the step still completes (we don't abort workflows mid-step)

async function testWorkflowPreflightCompacts() {
  const eventlog = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/eventlog.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/session.js')).href);
  const loop = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/loop.js')).href);

  // Force a budget block. Two levers needed because checkBudget
  // enforces a 64K FLOOR on effective limit even with env override:
  //   1. Lower the model's effective limit to 1 token (clamped up to
  //      MINIMUM_CONTEXT_FLOOR = 64K).
  //   2. Send a user input that predicts > 64K × 0.85 = 54.4K tokens.
  //      estimateTokens ≈ chars/4, so 300K chars ≈ 75K tokens.
  process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_5 = '1';
  // Make sure workflow leg is on.
  delete process.env.CLEMMY_PREFLIGHT_WORKFLOW;
  delete process.env.CLEMMY_PREFLIGHT_GATE;
  const hugeInput = 'x'.repeat(300_000);

  eventlog.resetEventLog?.();
  const sess = sessionMod.HarnessSession.create({ kind: 'workflow', title: 'workflow preflight' });

  const makeRunnerStub = () => new EventEmitter();
  let observedItems = null;
  const runRunner = async (_runner, _agent, items, opts) => {
    observedItems = items;
    return {
      history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
      lastResponseId: 'resp_wf_1',
      finalOutput: { summary: 'done', reply: null, done: true, nextAction: 'completed' },
    };
  };

  const result = await loop.runTurn({
    agent: { model: 'gpt-5.5' },
    sessionId: sess.id,
    input: hugeInput,
    runRunner,
    makeRunner: makeRunnerStub,
  });

  const events = eventlog.listEvents(sess.id);
  const preflight = events.find((e) => e.type === 'guardrail_tripped' && e.data?.kind === 'preflight_budget_check');
  const overbudget = events.find((e) => e.type === 'workflow_step_overbudget');
  const blockMessageInjected = (observedItems ?? []).some(
    (it) => typeof it.content === 'string' && it.content.includes('PREFLIGHT BUDGET BLOCK'),
  );

  const checks = [];
  checks.push({ ok: result.status === 'completed', label: `workflow step still completes (got '${result.status}')` });
  checks.push({ ok: !!preflight, label: 'preflight_budget_check event fired (telemetry leg works for workflows)' });
  if (preflight) {
    checks.push({ ok: preflight.data?.sessionKind === 'workflow', label: 'preflight event carries sessionKind=workflow' });
    checks.push({ ok: preflight.data?.status === 'block', label: `preflight verdict is block (got '${preflight.data?.status}')` });
  }
  checks.push({ ok: !!overbudget, label: 'workflow_step_overbudget event fired' });
  checks.push({ ok: !blockMessageInjected, label: 'chat-only block message NOT injected for workflow kind' });

  // Restore env so subsequent sub-tests don't inherit the override.
  delete process.env.CLEMMY_MODEL_CONTEXT_LIMIT_GPT_5_5;

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('workflow-preflight-compacts', `${checks.length} assertions passed`);
  } else {
    fail('workflow-preflight-compacts', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── F4 — stall-converts-to-question ───────────────────────────────
//
// Drives runConversation with a runRunner that always returns null
// finalOutput (no structured decision). The stall detector fires
// repeatedly. Asserts:
//   - status is 'awaiting_user_input' (not 'completed' with reason
//     sub_agent_stalled, which was the v0.5.18 behavior)
//   - the eventlog contains an `awaiting_user_input` event with
//     source: 'stall_recovery'
//   - 2 stall_retry_attempted events fired before the question

async function testStallConvertsToQuestion() {
  const eventlog = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/eventlog.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/session.js')).href);
  const loop = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/loop.js')).href);

  // Speed up the test — the F4 backoffs are 250ms + 1000ms.
  // For the smoke we don't care about real wall clock, but accept it.

  eventlog.resetEventLog?.();
  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'stall recovery' });
  const makeRunnerStub = () => new EventEmitter();

  // Always return a short generic prose string. Triggers Signal A
  // (zero tools + short generic reply) inside evaluateProgress at
  // loop.ts:2194. finalOutput MUST be a string for the stall detector
  // to fire — null/undefined skip the check.
  const runRunner = async (_runner, _agent, items, opts) => ({
    history: [
      ...items,
      {
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Continuing.' }],
      },
    ],
    lastResponseId: `resp_stall_${Date.now()}`,
    finalOutput: 'Continuing.', // short generic prose → triggers Signal A
  });

  const agentStub = { model: 'gpt-5.5' };
  const start = Date.now();
  const result = await loop.runConversation({
    agent: agentStub,
    sessionId: sess.id,
    input: 'do the thing',
    runRunner,
    makeRunner: makeRunnerStub,
    maxSteps: 10,
    maxTurns: 50,
  });
  const elapsed = Date.now() - start;

  const checks = [];
  checks.push({ ok: result.status === 'awaiting_user_input', label: `result.status === 'awaiting_user_input' (got '${result.status}')` });
  const events = eventlog.listEvents(sess.id);
  const retryEvents = events.filter((e) => e.type === 'stall_retry_attempted');
  checks.push({ ok: retryEvents.length === 2, label: `2 stall_retry_attempted events (got ${retryEvents.length})` });
  const awaitingEvents = events.filter((e) => e.type === 'awaiting_user_input');
  checks.push({ ok: awaitingEvents.length === 1, label: `1 awaiting_user_input event (got ${awaitingEvents.length})` });
  if (awaitingEvents.length > 0) {
    const evt = awaitingEvents[0];
    checks.push({ ok: evt.data?.source === 'stall_recovery', label: `awaiting_user_input.source === 'stall_recovery'` });
    checks.push({ ok: typeof evt.data?.question === 'string' && evt.data.question.length > 0, label: 'awaiting_user_input has a question' });
    checks.push({ ok: Array.isArray(evt.data?.options) && evt.data.options.length === 3, label: 'awaiting_user_input offers 3 options' });
  }
  // No sub_agent_stalled termination should have fired.
  const stalledTerm = events.find((e) => e.type === 'conversation_completed' && e.data?.reason === 'sub_agent_stalled');
  checks.push({ ok: !stalledTerm, label: 'no sub_agent_stalled termination' });
  // Backoff observable — total should be at least 250+1000ms = 1.25s.
  checks.push({ ok: elapsed >= 1100, label: `total elapsed >= 1.1s (got ${elapsed}ms — proves backoff fired)` });

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('stall-converts-to-question', `${checks.length} assertions passed`);
  } else {
    fail('stall-converts-to-question', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── F5 — sse-truncate-capture ─────────────────────────────────────
//
// Calls `writeSseTruncationTrace` directly with a synthetic Codex
// request body that includes a tools array. Asserts a trace file
// appears under ~/.clementine-next/state/codex-sse-truncated/ and
// that the trace contains the body + breakdown the deferred
// tool-trim work was blocked on.

async function testSseTruncateCapture() {
  const codexModel = await import(
    pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/codex-model.js')).href
  );
  if (typeof codexModel.writeSseTruncationTrace !== 'function') {
    return fail('sse-truncate-capture', 'writeSseTruncationTrace not exported');
  }
  if (typeof codexModel.shouldForceSseTruncation !== 'function') {
    return fail('sse-truncate-capture', 'shouldForceSseTruncation not exported');
  }

  // Production safety: the force-knob must be double-gated.
  process.env.CLEMMY_FORCE_SSE_TRUNCATE = '1';
  delete process.env.NODE_ENV;
  delete process.env.CLEMMY_DEV_OVERRIDES;
  const allowedInProd = codexModel.shouldForceSseTruncation();
  process.env.NODE_ENV = 'test';
  const allowedInTest = codexModel.shouldForceSseTruncation();

  // Synthetic body shaped like a real Codex request — tools array
  // populated so the bodyBreakdown reveals what dominates.
  const syntheticBody = {
    model: 'gpt-5.5',
    instructions: 'You are Clementine. Use the tools provided.',
    input: [{ role: 'user', content: 'hello world' }],
    tools: [
      { name: 'composio_execute_tool', description: 'x'.repeat(2000) },
      { name: 'dataforseo__scrape', description: 'y'.repeat(1500) },
      { name: 'create_plan', description: 'z'.repeat(400) },
    ],
    store: false,
    stream: true,
  };
  const diagContext = {
    itemCount: 0,
    responseId: 'resp_synthetic_smoke',
    attempts: 2,
    modelId: 'gpt-5.5',
    httpStatus: 200,
    responseHeaders: { 'cf-ray': 'synthetic' },
    requestBytes: JSON.stringify(syntheticBody).length,
    durationMs: 2_550,
    ttfbMs: 250,
    bodyBreakdown: { totalBytes: JSON.stringify(syntheticBody).length, toolCount: 3 },
  };

  const tracePath = await codexModel.writeSseTruncationTrace(
    'gpt-5.5',
    diagContext,
    syntheticBody,
  );

  const fs = await import('node:fs');
  const checks = [];
  checks.push({ ok: tracePath !== null, label: 'writeSseTruncationTrace returned a path' });
  checks.push({ ok: !!tracePath && fs.existsSync(tracePath), label: 'trace file exists on disk' });
  if (tracePath && fs.existsSync(tracePath)) {
    const traceJson = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    checks.push({ ok: traceJson.kind === 'codex.sse_truncated', label: 'trace kind is codex.sse_truncated' });
    checks.push({ ok: Array.isArray(traceJson.requestBody?.tools), label: 'trace preserves requestBody.tools array' });
    checks.push({ ok: traceJson.requestBody?.tools?.length === 3, label: 'trace preserves 3 tools' });
    checks.push({ ok: traceJson.diagnostics?.modelId === 'gpt-5.5', label: 'trace preserves diagnostics.modelId' });
    checks.push({ ok: traceJson.diagnostics?.requestBytes > 0, label: 'trace preserves requestBytes' });
  }
  // Production guard checks
  checks.push({ ok: allowedInProd === false, label: 'force-knob refused without NODE_ENV/CLEMMY_DEV_OVERRIDES' });
  checks.push({ ok: allowedInTest === true, label: 'force-knob honored under NODE_ENV=test' });

  delete process.env.CLEMMY_FORCE_SSE_TRUNCATE;
  delete process.env.NODE_ENV;

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('sse-truncate-capture', `${checks.length} assertions passed`);
  } else {
    fail('sse-truncate-capture', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── F6 — loop-detection-survives-restart ──────────────────────────
//
// Fires 8 identical tool calls into the guardrail tracker, then
// drops the in-memory tracker (simulating a daemon restart). Fires
// 2 more — these should see the persisted history (8 + 2 = 10) and
// trigger block under default thresholds.

async function testLoopDetectionSurvivesRestart() {
  const guardrail = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/tool-guardrail.js')).href);
  const eventlog = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/eventlog.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/session.js')).href);

  // Force strict mode so block decisions actually surface.
  process.env.CLEMMY_TOOL_GUARDRAIL = 'strict';
  // Lower thresholds to make the test deterministic in 8 + 2 = 10 calls.
  process.env.CLEMMY_GUARDRAIL_EXACT_BLOCK = '10';
  process.env.CLEMMY_GUARDRAIL_EXACT_WARN = '2';

  eventlog.resetEventLog?.();
  guardrail._resetAllTrackersForTests?.();
  const sess = sessionMod.HarnessSession.create({ kind: 'workflow', title: 'restart resilience' });

  const sameArgs = { resource: 'sheet_123', column: 'A1' };
  // Fire 8 identical calls into the same session.
  for (let i = 0; i < 8; i++) {
    guardrail.evaluateToolCall(sess.id, 'read_file', sameArgs);
  }

  // Simulate restart: drop the in-memory tracker but keep sqlite.
  guardrail._simulateRestartForTests(sess.id);

  // Fire 2 more — these should see the persisted history and either
  // block or warn depending on the threshold semantics.
  const decision9 = guardrail.applyMode(
    guardrail.evaluateToolCall(sess.id, 'read_file', sameArgs),
  );
  const decision10 = guardrail.applyMode(
    guardrail.evaluateToolCall(sess.id, 'read_file', sameArgs),
  );

  const peek = guardrail._peekTracker?.(sess.id);

  const checks = [];
  // The rehydrate worked if the new in-memory tracker shows >=8 recent calls.
  checks.push({ ok: peek && peek.recentCount >= 9, label: `rehydrated tracker has >=9 recent calls (got ${peek?.recentCount ?? 0})` });
  // Block should fire on the 10th call (count >= 10 threshold).
  checks.push({ ok: decision10.action === 'block', label: `10th call blocks (got '${decision10.action}')` });
  // The blocker explanation should mention loop / repeat.
  checks.push({ ok: /repeat|loop|identical/i.test(decision10.reason ?? ''), label: 'block reason mentions repeat/loop' });

  // Sqlite row exists.
  const persistedJson = eventlog.readGuardrailState(sess.id);
  checks.push({ ok: !!persistedJson, label: 'tool_guardrail_state row persisted to sqlite' });
  if (persistedJson) {
    try {
      const parsed = JSON.parse(persistedJson);
      checks.push({ ok: Array.isArray(parsed) && parsed.length >= 5, label: `persisted recent[] has >=5 entries (got ${Array.isArray(parsed) ? parsed.length : 'NaN'})` });
    } catch (err) {
      checks.push({ ok: false, label: `persisted JSON invalid: ${err instanceof Error ? err.message : err}` });
    }
  }

  // Revert env knobs.
  delete process.env.CLEMMY_TOOL_GUARDRAIL;
  delete process.env.CLEMMY_GUARDRAIL_EXACT_BLOCK;
  delete process.env.CLEMMY_GUARDRAIL_EXACT_WARN;

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('loop-detection-survives-restart', `${checks.length} assertions passed`);
  } else {
    fail('loop-detection-survives-restart', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── F8 — discord-token-expiry-thinking-indicator ──────────────────
//
// Exercises the exported `shouldPostExpiryCheckIn` throttle predicate
// across the gates that matter: token not expired (skip), state done
// (skip), no sendFollowup transport (skip), within throttle window
// (skip), past throttle window (fire), knob=off (skip).

async function testDiscordTokenExpiryThinkingIndicator() {
  const discord = await import(
    pathToFileURL(path.join(DAEMON_DIST, 'channels/discord-harness.js')).href
  );
  if (typeof discord.shouldPostExpiryCheckIn !== 'function') {
    return fail('discord-token-expiry-thinking-indicator', 'shouldPostExpiryCheckIn not exported');
  }
  const checkInMs = discord.POST_EXPIRY_CHECKIN_MS ?? 5 * 60_000;

  const baseInput = {
    tokenExpired: true,
    stateDone: false,
    lastCheckInAt: 0,
    now: checkInMs + 1, // past the window
    hasSendFollowup: true,
  };

  delete process.env.CLEMMY_DISCORD_POST_EXPIRY_CHECKINS;

  const checks = [];
  // Happy path: token expired + past window → fire.
  checks.push({ ok: discord.shouldPostExpiryCheckIn(baseInput) === true, label: 'happy path: past throttle window → posts' });
  // Token not expired → never fire (the v0.5.18 path handles edits).
  checks.push({ ok: discord.shouldPostExpiryCheckIn({ ...baseInput, tokenExpired: false }) === false, label: 'token not expired → skip' });
  // State done (e.g. final reply about to land) → skip; finalFlush owns the message.
  checks.push({ ok: discord.shouldPostExpiryCheckIn({ ...baseInput, stateDone: true }) === false, label: 'state.done=true → skip (finalFlush owns it)' });
  // Transport has no sendFollowup (some channels) → skip.
  checks.push({ ok: discord.shouldPostExpiryCheckIn({ ...baseInput, hasSendFollowup: false }) === false, label: 'no sendFollowup transport → skip' });
  // Within throttle window → skip.
  checks.push({ ok: discord.shouldPostExpiryCheckIn({ ...baseInput, now: checkInMs - 1000 }) === false, label: 'within throttle window → skip' });
  // At exactly the throttle window → fire.
  checks.push({ ok: discord.shouldPostExpiryCheckIn({ ...baseInput, now: checkInMs }) === true, label: 'exactly at throttle window → fires' });
  // Revert knob: forces false even when everything else aligns.
  process.env.CLEMMY_DISCORD_POST_EXPIRY_CHECKINS = 'off';
  checks.push({ ok: discord.shouldPostExpiryCheckIn(baseInput) === false, label: 'CLEMMY_DISCORD_POST_EXPIRY_CHECKINS=off → skip' });
  delete process.env.CLEMMY_DISCORD_POST_EXPIRY_CHECKINS;

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('discord-token-expiry-thinking-indicator', `${checks.length} assertions passed`);
  } else {
    fail('discord-token-expiry-thinking-indicator', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── Sub-test 8 — 80-tool-call-end-to-end-chat-dock ────────────────
//
// Boots a real harness session with a stubbed `runRunner` that emits
// a planned sequence of 80 tool calls across 5 turns. Asserts:
//   - terminal status === 'completed'
//   - no 'sub_agent_stalled' reason
//   - no 'runtime.failed' event
//   - all 80 simulated tool invocations recorded in eventlog
//
// Modeled on src/runtime/harness/loop.test.ts patterns (makeRunner +
// runRunner injection — no real OpenAI Codex call).

async function test80ToolCallEndToEnd() {
  // Import the compiled harness module from dist.
  const eventlog = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/eventlog.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/session.js')).href);
  const loop = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/loop.js')).href);

  eventlog.resetEventLog?.();

  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: '80-tool smoke' });
  const TOOL_CALLS_PER_TURN = 16; // matches default brackets limit
  const TOTAL_TOOL_CALLS = 80;
  const REQUIRED_TURNS = Math.ceil(TOTAL_TOOL_CALLS / TOOL_CALLS_PER_TURN); // 5

  let turnCount = 0;
  // Emit synthetic tool_called events from inside the runRunner so the
  // eventlog reflects what the model would have done. The real path
  // emits these via `hooks.onToolEnd`; for the smoke we shortcut by
  // calling appendEvent directly through the eventlog module.
  // The runner must expose `.on/.off` (EventEmitter) because the
  // harness attaches hooks to it — see hooks.js attachEventLogHooks.
  const makeRunnerStub = () => new EventEmitter();

  const runRunner = async (_runner, _agent, items, opts) => {
    turnCount += 1;
    const callsThisTurn = Math.min(TOOL_CALLS_PER_TURN, TOTAL_TOOL_CALLS - (turnCount - 1) * TOOL_CALLS_PER_TURN);
    const sessionId = opts?.context?.sessionId ?? sess.id;
    const turn = opts?.context?.turn ?? turnCount;
    for (let i = 0; i < callsThisTurn; i++) {
      eventlog.appendEvent({
        sessionId,
        turn,
        role: 'tool',
        type: 'tool_called',
        data: {
          name: 'verify_smoke_stub',
          callId: `call_smoke_${turnCount}_${i}`,
          args: { iter: i },
        },
      });
    }
    const isLast = turnCount >= REQUIRED_TURNS;
    // The harness loop auto-continues when nextAction is
    // 'awaiting_handoff_result' (any non-terminal state). The model
    // never returns 'continue' — see toOrchestratorDecision validation
    // at loop.ts:968.
    return {
      history: [
        ...items,
        {
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: isLast ? 'all done' : 'continuing' }],
        },
      ],
      lastResponseId: `resp_${turnCount}`,
      finalOutput: isLast
        ? {
            summary: 'completed 80 tool calls across 5 turns',
            reply: 'all 80 calls done',
            done: true,
            nextAction: 'completed',
          }
        : {
            summary: `turn ${turnCount} of ${REQUIRED_TURNS} complete`,
            reply: null,
            done: false,
            nextAction: 'awaiting_handoff_result',
          },
    };
  };

  // runConversation needs an agent that exposes `model`. Provide a
  // minimal stub — the SDK runner is itself stubbed, so internal
  // model dispatch never fires.
  const agentStub = { model: 'gpt-5.5' };

  const result = await loop.runConversation({
    agent: agentStub,
    sessionId: sess.id,
    input: 'do 80 tool calls and finish',
    runRunner,
    makeRunner: makeRunnerStub,
    // Allow the loop to run to completion across all 5 turns.
    maxSteps: 10,
    maxTurns: 50,
  });

  const checks = [];
  checks.push({ ok: result.status === 'completed', label: `terminal status is completed (got ${result.status})` });
  const events = eventlog.listEvents(sess.id);
  const toolCalled = events.filter((e) => e.type === 'tool_called').length;
  checks.push({ ok: toolCalled === TOTAL_TOOL_CALLS, label: `${TOTAL_TOOL_CALLS} tool_called events recorded (got ${toolCalled})` });
  const stalled = events.find((e) => e.type === 'conversation_completed' && e.data?.reason === 'sub_agent_stalled');
  checks.push({ ok: !stalled, label: 'no sub_agent_stalled termination' });
  const failures = events.filter((e) => e.type === 'run_failed' || e.type === 'runtime_failed');
  checks.push({ ok: failures.length === 0, label: `no run_failed events (got ${failures.length})` });

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('80-tool-call-end-to-end-chat-dock', `${checks.length} assertions passed, 5 turns × 16 calls`);
  } else {
    fail('80-tool-call-end-to-end-chat-dock', `${failed.length} assertions failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── Bug H — retry-context-injection ───────────────────────────────
//
// Seeds a synthetic awaiting_user_input event with retry_context for a
// chat session, then calls runTurn with input="Retry". Asserts the
// items array passed to runRunner contains a [RETRY CONTEXT] system
// message naming the failed tool + args. If the model is then asked to
// rationalize "Retry" without context (the bug), the system message
// prevents drift to a different task.

async function testRetryContextInjection() {
  const eventlog = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/eventlog.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/session.js')).href);
  const loop = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/loop.js')).href);

  eventlog.resetEventLog?.();
  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'retry context smoke' });

  // Seed an awaiting_user_input event with retry_context as if a 5xx
  // had just fired on a composio_execute_tool call.
  eventlog.appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: 'Test infra error — should I retry?',
      options: ['Retry', 'Switch approach', 'Stop'],
      source: 'infra_error_recovery',
      boundaryKind: 'codex.sse_truncated',
      operatorMessage: 'SSE ended without response.completed',
      retry_context: {
        failed_tool: 'composio_execute_tool',
        failed_args: '{"tool_slug":"GOOGLESHEETS_VALUES_UPDATE","arguments":"{\\"spreadsheet_id\\":\\"sheet-abc-123\\"}"}',
        failed_call_id: 'call_xyz_failed',
        failed_turn: 1,
      },
    },
  });

  // Capture what items the model would see AFTER the SDK applies the
  // callModelInputFilter. The runRunner stub mirrors what the real SDK
  // does in applyCallModelInputFilter — read opts.callModelInputFilter
  // and invoke it with the items before treating them as model input.
  let capturedItems = null;
  const makeRunnerStub = () => new EventEmitter();
  const runRunner = async (_runner, agent, items, opts) => {
    let modelInputItems = items;
    if (typeof opts?.callModelInputFilter === 'function') {
      const filtered = await opts.callModelInputFilter({
        modelData: { input: items, instructions: undefined },
        agent,
        context: opts.context,
      });
      modelInputItems = filtered.input;
    }
    capturedItems = modelInputItems;
    return {
      history: [...modelInputItems, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
      lastResponseId: 'resp_retry_smoke',
      finalOutput: { summary: 'done', reply: 'retried', done: true, nextAction: 'completed' },
    };
  };

  await loop.runTurn({
    agent: { model: 'gpt-5.5' },
    sessionId: sess.id,
    input: 'Retry',
    runRunner,
    makeRunner: makeRunnerStub,
  });

  const checks = [];
  checks.push({ ok: Array.isArray(capturedItems), label: 'runRunner received items array' });
  if (Array.isArray(capturedItems)) {
    const systemMsgs = capturedItems.filter((it) => it?.role === 'system' && typeof it.content === 'string');
    const retryCtxMsg = systemMsgs.find((it) => it.content.includes('[RETRY CONTEXT]'));
    checks.push({ ok: !!retryCtxMsg, label: '[RETRY CONTEXT] system message injected' });
    if (retryCtxMsg) {
      checks.push({ ok: retryCtxMsg.content.includes('composio_execute_tool'), label: 'mentions failed tool' });
      checks.push({ ok: retryCtxMsg.content.includes('sheet-abc-123'), label: 'mentions failed args (spreadsheet_id pin preserved)' });
      checks.push({ ok: retryCtxMsg.content.includes('call_xyz_failed'), label: 'mentions failed call_id' });
      checks.push({ ok: retryCtxMsg.content.includes('codex.sse_truncated'), label: 'mentions boundaryKind' });
      checks.push({ ok: retryCtxMsg.content.toLowerCase().includes('do not re-plan') || retryCtxMsg.content.toLowerCase().includes('do not re-discover'), label: 'tells model not to re-plan/discover' });
    }
  }

  // Negative test: knob=off should NOT inject
  process.env.CLEMMY_RETRY_CONTEXT_INJECT = 'off';
  let capturedItemsOff = null;
  const runRunner2 = async (_runner, agent, items, opts) => {
    let modelInputItems = items;
    if (typeof opts?.callModelInputFilter === 'function') {
      const filtered = await opts.callModelInputFilter({
        modelData: { input: items, instructions: undefined },
        agent,
        context: opts.context,
      });
      modelInputItems = filtered.input;
    }
    capturedItemsOff = modelInputItems;
    return {
      history: modelInputItems,
      lastResponseId: 'resp_off',
      finalOutput: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
    };
  };
  // Re-seed the awaiting_user_input event (the prior runTurn may have advanced turn)
  eventlog.appendEvent({
    sessionId: sess.id, turn: 2, role: 'Clem', type: 'awaiting_user_input',
    data: { question: 'q', options: ['Retry'], source: 'infra_error_recovery', boundaryKind: 'codex.http_5xx',
      retry_context: { failed_tool: 'composio_execute_tool', failed_args: '{}', failed_call_id: 'c2', failed_turn: 2 } },
  });
  await loop.runTurn({
    agent: { model: 'gpt-5.5' },
    sessionId: sess.id,
    input: 'Retry',
    runRunner: runRunner2,
    makeRunner: makeRunnerStub,
  });
  // Negative test rationale: the first runTurn (env=on) injected a
  // retry context referencing the FIRST seeded event (boundary
  // codex.sse_truncated). That message gets persisted into session
  // history. When the second runTurn rebuilds items from history,
  // the OLD retry-context system message is still there — that's
  // not a fresh injection. To verify env=off prevents NEW injection,
  // check the second turn's items do NOT contain the SECOND seeded
  // event's distinguishing boundary kind (codex.http_5xx).
  const offHasNewInjection = Array.isArray(capturedItemsOff) && capturedItemsOff.some(
    (it) => it?.role === 'system' && typeof it.content === 'string' && it.content.includes('codex.http_5xx'),
  );
  checks.push({ ok: !offHasNewInjection, label: 'CLEMMY_RETRY_CONTEXT_INJECT=off prevents NEW injection (no http_5xx system msg in turn 2 items)' });
  delete process.env.CLEMMY_RETRY_CONTEXT_INJECT;

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('retry-context-injection', `${checks.length} assertions passed`);
  } else {
    fail('retry-context-injection', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── Bug J — approval-preview auto-enrichment ──────────────────────
//
// Seeds a chat session with a tool_returned event containing batch-
// shaped JSON (10 draft email records). Then registers a pending
// approval and calls summarizeApprovalAction. Asserts the rendered
// card body includes count + sample subjects + recipients — pulled
// automatically from the recent tool output, with no explicit
// preview field passed in the approval args.

async function testApprovalPreviewAutoEnrichment() {
  const eventlog = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/eventlog.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/session.js')).href);
  const approvalRegistry = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/approval-registry.js')).href);
  const approvalSummary = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/approval-summary.js')).href);

  eventlog.resetEventLog?.();
  const sess = sessionMod.HarnessSession.create({ kind: 'workflow', title: 'auto-enrich smoke' });

  // Seed a batch-shaped tool_returned event (10 fake email drafts).
  const drafts = Array.from({ length: 10 }, (_, i) => ({
    accountName: `Firm ${String.fromCharCode(65 + i)}`,
    subject: `Quick thought on your ${['SEO','intake','website','reviews','referrals'][i % 5]} approach`,
    outlookDraftId: `draft-${i + 1}`,
    rowNumber: i + 2,
  }));
  eventlog.appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_returned',
    data: {
      tool: 'composio_execute_tool',
      callId: 'call_create_drafts',
      result: JSON.stringify({
        data: {
          drafts,
          createdAt: '2026-05-25T08:00:00Z',
        },
        successful: true,
      }),
    },
  });

  // Register a request_approval WITHOUT passing the preview field.
  // The runtime should auto-infer from the seeded batch.
  const approvalArgs = {
    subject: 'Send the pending cold-prospect emails from the outreach sheet',
    reason: 'Cold outreach drafts; review first.',
    destructive: false,
  };
  // Construct a PendingApproval-shaped object with state containing
  // the toolCall + args (mirrors how the harness registers approvals).
  const fakeApproval = {
    id: 'apr-auto-enrich-test',
    sessionId: sess.id,
    toolName: 'request_approval',
    state: JSON.stringify({
      toolCall: { name: 'request_approval', arguments: JSON.stringify(approvalArgs) },
    }),
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const rendered = approvalSummary.summarizeApprovalAction(fakeApproval);

  const checks = [];
  checks.push({ ok: typeof rendered === 'string' && rendered.length > 0, label: 'rendered output is a string' });
  checks.push({ ok: rendered.includes('Send the pending cold-prospect emails'), label: 'preserves subject' });
  checks.push({ ok: rendered.includes('Cold outreach drafts'), label: 'preserves reason' });
  checks.push({ ok: rendered.includes('10 items'), label: 'auto-inferred count (10 items)' });
  checks.push({ ok: rendered.includes('Subject'), label: 'auto-inferred Subject label' });
  // First draft's subject should be in samples — check for the unique-ish "SEO approach" string.
  checks.push({ ok: rendered.includes('SEO approach'), label: 'first draft subject in samples' });
  checks.push({ ok: rendered.includes('(auto-inferred from recent tool output)'), label: 'inferred footer shown' });

  // Negative case: explicit preview wins over auto-infer.
  const approvalArgsWithExplicit = {
    ...approvalArgs,
    preview: {
      count: 3,
      samples: [
        { label: 'Explicit', value: 'override 1', secondary: null },
        { label: 'Explicit', value: 'override 2', secondary: null },
        { label: 'Explicit', value: 'override 3', secondary: null },
      ],
    },
  };
  const fakeApprovalExplicit = {
    ...fakeApproval,
    state: JSON.stringify({
      toolCall: { name: 'request_approval', arguments: JSON.stringify(approvalArgsWithExplicit) },
    }),
  };
  const renderedExplicit = approvalSummary.summarizeApprovalAction(fakeApprovalExplicit);
  checks.push({ ok: renderedExplicit.includes('3 items'), label: 'explicit preview count wins' });
  checks.push({ ok: renderedExplicit.includes('override 1'), label: 'explicit samples win over auto-infer' });
  checks.push({ ok: !renderedExplicit.includes('(auto-inferred'), label: 'no inferred footer when explicit' });

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('approval-preview-auto-enrichment', `${checks.length} assertions passed`);
  } else {
    fail('approval-preview-auto-enrichment', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── v0.5.21 Phase 2 — codex-transport-timeout-routes-to-f4 ────────
//
// Three-layer verification of the chronic-Codex-flake fix:
//   (1) Unit:   detectUndiciTimeout classifies the two undici error
//               shapes (UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT)
//               and rejects everything else.
//   (2) Unit:   buildTransportTimeoutError produces a BoundaryError
//               with kind='codex.transport_timeout', retryable=true,
//               and a real userMessage.
//   (3) E2E:    runTurn catches a BoundaryError(kind=transport_timeout)
//               thrown from runRunner and routes it through F4 to an
//               `awaiting_user_input` event with source=infra_error_recovery
//               and boundaryKind='codex.transport_timeout'. Same shape
//               as Bug C/I — same Retry/Switch/Stop card.
//
// Why this matters: today's hung Salesforce chat (sess-mplfm14j-f0985a98)
// silently sat for 3+ minutes because undici defaults are 5 min and
// chat had no wall-clock. With these layers, the same Cloudflare-edge
// stall fast-fails in 15-30s and the user sees a Retry button.

async function testCodexTransportTimeoutRoutesToF4() {
  const dispatcher = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/codex-dispatcher.js')).href);
  const boundaryMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/boundary-error.js')).href);
  const eventlog = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/eventlog.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/session.js')).href);
  const loop = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/loop.js')).href);

  const checks = [];

  // ─── (1) detectUndiciTimeout classifier ──────────────────────────
  // Undici nests its error code under `.cause.code` when wrapped by
  // global fetch's TypeError, OR sets `.code` directly on the error
  // when the caller used undici's own fetch. Both shapes must work.
  const nested = { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } };
  const direct = { code: 'UND_ERR_BODY_TIMEOUT' };
  const unrelated = { code: 'UND_ERR_SOCKET' };
  const random = new TypeError('something else');
  checks.push({ ok: dispatcher.detectUndiciTimeout(nested) === 'UND_ERR_HEADERS_TIMEOUT', label: 'detects headers-timeout via cause.code' });
  checks.push({ ok: dispatcher.detectUndiciTimeout(direct) === 'UND_ERR_BODY_TIMEOUT', label: 'detects body-timeout via direct .code' });
  checks.push({ ok: dispatcher.detectUndiciTimeout(unrelated) === null, label: 'returns null on unrelated undici code' });
  checks.push({ ok: dispatcher.detectUndiciTimeout(random) === null, label: 'returns null on non-undici error' });
  checks.push({ ok: dispatcher.detectUndiciTimeout(null) === null, label: 'returns null on null input' });

  // ─── (2) buildTransportTimeoutError shape ────────────────────────
  const headerErr = dispatcher.buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers', sessionId: 'sess-test' });
  checks.push({ ok: headerErr instanceof boundaryMod.BoundaryError, label: 'returns a BoundaryError instance' });
  checks.push({ ok: headerErr.kind === 'codex.transport_timeout', label: 'kind is codex.transport_timeout' });
  checks.push({ ok: headerErr.retryable === true, label: 'retryable is true' });
  checks.push({ ok: typeof headerErr.userMessage === 'string' && headerErr.userMessage.length > 0, label: 'userMessage is non-empty' });
  checks.push({ ok: headerErr.context.undiciCode === 'UND_ERR_HEADERS_TIMEOUT', label: 'context preserves undiciCode' });
  checks.push({ ok: typeof headerErr.context.budgetMs === 'number', label: 'context preserves budgetMs' });
  checks.push({ ok: boundaryMod.BoundaryError.isTransient(headerErr), label: 'isTransient classifies as transient' });

  // ─── (3) E2E — runTurn routes the BoundaryError through F4 ──────
  // Same pattern as the existing http_5xx/sse_truncated paths in
  // loop.ts:2281-2289. Seed a tool_called event so retry_context can
  // populate, then have runRunner throw a transport_timeout.
  eventlog.resetEventLog?.();
  // Default behavior: HARNESS_INFRA_ASK_USER unset = on. Ensure no
  // stale env from a prior sub-test forces it off.
  delete process.env.HARNESS_INFRA_ASK_USER;

  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'transport timeout smoke' });
  // Seed a tool_called event so loop.ts's retry-context lookup finds
  // SOMETHING to attach. Mirrors what would have been logged just
  // before a real Codex transport timeout.
  eventlog.appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'sf_query',
      arguments: '{"q":"SELECT Owner.Name FROM Account WHERE Website=\'swainlawtexas.com\'"}',
      callId: 'call_sf_test',
    },
  });

  const makeRunnerStub = () => new EventEmitter();
  let runRunnerInvoked = 0;
  const runRunner = async () => {
    runRunnerInvoked += 1;
    // Simulate the codex-dispatcher path: detected an undici body
    // timeout mid-stream, threw a transport_timeout BoundaryError.
    throw dispatcher.buildTransportTimeoutError('UND_ERR_BODY_TIMEOUT', {
      sessionId: sess.id,
      model: 'gpt-5.5',
      phase: 'body',
    });
  };

  const result = await loop.runTurn({
    agent: { model: 'gpt-5.5' },
    sessionId: sess.id,
    input: 'who owns the swain law texas account in salesforce',
    runRunner,
    makeRunner: makeRunnerStub,
  });

  checks.push({ ok: runRunnerInvoked === 1, label: 'runRunner invoked exactly once' });
  checks.push({ ok: result?.status === 'awaiting_user_input', label: 'runTurn returns status=awaiting_user_input (not failed)' });

  // Find the awaiting_user_input event the F4 path wrote.
  const events = eventlog.listEvents(sess.id, { types: ['awaiting_user_input'] });
  checks.push({ ok: events.length === 1, label: 'exactly one awaiting_user_input event emitted' });
  if (events.length === 1) {
    const data = events[0].data ?? {};
    checks.push({ ok: data.source === 'infra_error_recovery', label: 'source=infra_error_recovery (Bug C/I family)' });
    checks.push({ ok: data.boundaryKind === 'codex.transport_timeout', label: 'boundaryKind=codex.transport_timeout' });
    checks.push({ ok: Array.isArray(data.options) && data.options.includes('Retry'), label: 'Retry option present' });
    checks.push({ ok: Array.isArray(data.options) && data.options.includes('Stop'), label: 'Stop option present' });
    checks.push({ ok: data.retry_context && data.retry_context.failed_tool === 'sf_query', label: 'retry_context captures the failed tool from seeded tool_called event' });
    checks.push({ ok: data.retry_context?.failed_call_id === 'call_sf_test', label: 'retry_context captures call_id' });
  }

  // Verify the env-gate revert still works — HARNESS_INFRA_ASK_USER=off
  // should bypass F4 entirely and surface as a normal error.
  process.env.HARNESS_INFRA_ASK_USER = 'off';
  eventlog.resetEventLog?.();
  const sess2 = sessionMod.HarnessSession.create({ kind: 'chat', title: 'transport timeout — env off' });
  let normalErrorPath = false;
  try {
    await loop.runTurn({
      agent: { model: 'gpt-5.5' },
      sessionId: sess2.id,
      input: 'q',
      runRunner: async () => { throw dispatcher.buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', {}); },
      makeRunner: makeRunnerStub,
    });
    // No throw with knob=off but the result should not be awaiting_user_input.
    const evts2 = eventlog.listEvents(sess2.id, { types: ['awaiting_user_input'] });
    normalErrorPath = evts2.length === 0;
  } catch {
    // A surfaced error (rather than awaiting_user_input) is also valid evidence the gate flipped.
    normalErrorPath = true;
  }
  checks.push({ ok: normalErrorPath, label: 'HARNESS_INFRA_ASK_USER=off bypasses F4 (revert lever works)' });
  delete process.env.HARNESS_INFRA_ASK_USER;

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('codex-transport-timeout-routes-to-f4', `${checks.length} assertions passed`);
  } else {
    fail('codex-transport-timeout-routes-to-f4', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── v0.5.21 Phase 2.5 — cli-discovery-surfaces-in-diagnostics ─────
//
// The dashboard summary now shows "N CLIs discovered" alongside
// "X/Y MCP servers ready" (mirror of the existing chip pattern, so
// the user has live visibility into PATH discovery without opening a
// terminal). This requires the diagnostics endpoint to surface a
// `cli: { count, lastScannedAt }` field — verify both directions:
//   (1) Shape: `collectDiagnostics()` includes the `cli` field with
//       the expected keys (number|null + string|null).
//   (2) Population: after seeding the cli-discovery cache with a
//       known scan, the diagnostics surface reports that count back.

async function testCliDiscoverySurfacesInDiagnostics() {
  const diag = await import(pathToFileURL(path.join(DAEMON_DIST, 'dashboard/diagnostics.js')).href);
  const cliDiscovery = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/cli-discovery.js')).href);

  if (typeof diag.collectDiagnostics !== 'function') {
    return fail('cli-discovery-surfaces-in-diagnostics', 'collectDiagnostics not exported from dashboard/diagnostics.js');
  }

  const checks = [];

  // ─── (1) Shape — cli field is always present, even with no cache ─
  cliDiscovery.invalidateCachedScan?.();
  const empty = diag.collectDiagnostics();
  checks.push({ ok: empty && typeof empty === 'object', label: 'collectDiagnostics returns an object' });
  checks.push({ ok: 'cli' in empty, label: 'diagnostics has a `cli` field (always present)' });
  if ('cli' in empty) {
    checks.push({ ok: empty.cli.count === null, label: 'cli.count is null when no scan cache exists' });
    checks.push({ ok: empty.cli.lastScannedAt === null, label: 'cli.lastScannedAt is null when no scan cache exists' });
  }

  // ─── (2) Population — seed scan, assert diagnostics reflects it ─
  // We can't call into the live scanner (it would hit the real PATH,
  // making the assertion machine-dependent). Instead, write a cache
  // file directly using the same shape the runtime writes, then re-
  // read via diagnostics.
  const fs = await import('node:fs');
  const stateDir = path.join(process.env.CLEMENTINE_HOME ?? path.join(os.homedir(), '.clementine-next'), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const cliCachePath = path.join(stateDir, 'cli-scan.json');
  const sampleScan = {
    detected: [
      { command: 'higgsfield', path: '/Users/test/.nvm/versions/node/v22/bin/higgsfield' },
      { command: 'sf', path: '/opt/homebrew/bin/sf' },
      { command: 'gh', path: '/opt/homebrew/bin/gh' },
    ],
    clis: [
      { command: 'higgsfield', path: '/Users/test/.nvm/versions/node/v22/bin/higgsfield', version: null, helpHead: null, isLikelyCli: true },
      { command: 'sf', path: '/opt/homebrew/bin/sf', version: '2.50.0', helpHead: 'sf — Salesforce CLI', isLikelyCli: true },
      { command: 'gh', path: '/opt/homebrew/bin/gh', version: '2.40.0', helpHead: 'gh — GitHub CLI', isLikelyCli: true },
    ],
    scannedAt: new Date().toISOString(),
  };
  fs.writeFileSync(cliCachePath, JSON.stringify(sampleScan, null, 2));

  const populated = diag.collectDiagnostics();
  checks.push({ ok: populated.cli && populated.cli.count === 3, label: 'cli.count reflects seeded scan (3 CLIs)' });
  checks.push({ ok: typeof populated.cli?.lastScannedAt === 'string', label: 'cli.lastScannedAt is a string after scan' });
  checks.push({
    ok: populated.cli?.lastScannedAt === sampleScan.scannedAt,
    label: 'cli.lastScannedAt matches the cache file timestamp exactly',
  });

  // Clean up so other sub-tests aren't affected.
  cliDiscovery.invalidateCachedScan?.();

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    pass('cli-discovery-surfaces-in-diagnostics', `${checks.length} assertions passed`);
  } else {
    fail('cli-discovery-surfaces-in-diagnostics', `${failed.length} failed: ${failed.map((f) => f.label).join('; ')}`);
  }
}

// ─── Runner ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const all = argv.includes('--all');
  const list = argv.includes('--list');
  return { only: onlyArg ? onlyArg.slice('--only='.length) : null, all, list };
}

const args = parseArgs(process.argv.slice(2));

if (args.list || (!args.only && !args.all)) {
  console.log(`${palette.cyan}${palette.bold}verify-long-running.mjs — sub-tests${palette.reset}`);
  for (const name of Object.keys(SUB_TESTS)) console.log(`  - ${name}`);
  console.log(`\nUsage: --all | --only=<name> | --list`);
  process.exit(args.list ? 0 : 1);
}

console.log(`${palette.cyan}${palette.bold}Clementine long-running smoke (v0.5.19)${palette.reset}`);
console.log(`  HOME=${tmpHome}`);

const toRun = args.only ? [args.only] : Object.keys(SUB_TESTS);
for (const name of toRun) {
  const fn = SUB_TESTS[name];
  if (!fn) {
    fail(name, 'unknown sub-test');
    continue;
  }
  section(name);
  try {
    await fn();
  } catch (err) {
    fail(name, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
  }
}

// Summary JSON for cross-release diff.
const summary = {
  timestamp: new Date().toISOString(),
  failures,
  results,
};
try {
  const summaryDir = path.join(originalHome ?? os.homedir(), '.clementine-next', 'state');
  mkdirSync(summaryDir, { recursive: true });
  const summaryPath = path.join(summaryDir, `verify-long-running-${Date.now()}.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n${palette.dim}summary → ${summaryPath}${palette.reset}`);
} catch (err) {
  console.log(`\n${palette.dim}(skipped summary write: ${err instanceof Error ? err.message : err})${palette.reset}`);
}

console.log(`\n${failures === 0 ? palette.green + 'green' : palette.red + failures + ' failure(s)'}${palette.reset}`);
process.exit(failures === 0 ? 0 : 1);
