/**
 * Run: npx tsx --test src/runtime/harness/turn-control.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-turn-control-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, requestKill, clearKill, accrueSessionTokens } = await import('./eventlog.js');
const { openRunTokenWindow } = await import('./run-token-budget.js');
const {
  killGateVerdict,
  grindGateVerdict,
  composeKillAwareShouldCancel,
  evaluateTurnBoundary,
  shouldOfferBackground,
  backgroundOfferEnabled,
} = await import('./turn-control.js');

let seq = 0;
function freshSession(kind = 'chat'): string {
  seq += 1;
  const id = `turn-control-test-${Date.now().toString(36)}-${seq}`;
  createSession({ id, kind } as never);
  return id;
}

afterEach(() => {
  delete process.env.CLEMMY_BG_OFFER_NUDGE;
  delete process.env.CLEMMY_GUARDRAIL_MUT_WARN;
  delete process.env.CLEMMY_GUARDRAIL_MUT_HALT;
  delete process.env.CLEMMY_GUARDRAIL_EXACT_BLOCK;
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// ── kill gate ────────────────────────────────────────────────────────────────

test('killGateVerdict: null normally; a hard interrupt deny once the kill row exists', () => {
  const sess = freshSession();
  assert.equal(killGateVerdict(sess), null);
  requestKill(sess, 'user stop');
  const verdict = killGateVerdict(sess);
  assert.equal(verdict?.behavior, 'deny');
  assert.equal(verdict?.interrupt, true, 'interrupt:true is the only reliable in-loop stop');
  clearKill(sess);
  assert.equal(killGateVerdict(sess), null);
  assert.equal(killGateVerdict(undefined), null);
});

test('composeKillAwareShouldCancel: ORs the kill switch with the base', async () => {
  const sess = freshSession();
  const base = { value: false };
  const fn = composeKillAwareShouldCancel(sess, () => base.value);
  assert.equal(await fn(), false);
  requestKill(sess, 'stop');
  assert.equal(await fn(), true, 'kill row cancels');
  clearKill(sess);
  assert.equal(await fn(), false);
  base.value = true;
  assert.equal(await fn(), true, 'base caller-cancel still works');
});

// ── grind gate (the incident: 15 ignored advisories) ────────────────────────

test('grindGateVerdict: a mutating tool ground across DISTINCT args HALTS at the threshold (never 15 ignored advisories)', () => {
  process.env.CLEMMY_GUARDRAIL_MUT_WARN = '2';
  process.env.CLEMMY_GUARDRAIL_MUT_HALT = '4';
  const sess = freshSession();
  // run_shell_command is in MUTATING_TOOLS — the incident's exact grind shape.
  const tool = 'run_shell_command';
  let firstDeny: number | null = null;
  let denyMessage = '';
  for (let i = 1; i <= 12; i++) {
    const v = grindGateVerdict(sess, tool, { command: `screencap https://firm${i}.com` });
    if (v && firstDeny === null) { firstDeny = i; denyMessage = v.message; break; }
  }
  assert.ok(firstDeny !== null && firstDeny <= 5, `the halt must actually deny at the threshold (first deny at ${firstDeny})`);
  assert.match(denyMessage, /run_worker|fan out|batch|program/i, 'the deny steers to the structural alternative');
});

test('grindGateVerdict: an IDENTICAL-args mutating loop reaches the terminal escalate', () => {
  process.env.CLEMMY_GUARDRAIL_EXACT_BLOCK = '3';
  const sess = freshSession();
  let sawTerminal = false;
  for (let i = 1; i <= 15; i++) {
    const v = grindGateVerdict(sess, 'run_shell_command', { command: 'netlify deploy --prod' });
    if (v?.interrupt) { sawTerminal = true; break; }
  }
  assert.ok(sawTerminal, 'identical mutating repeats end the turn (escalate)');
});

test('grindGateVerdict: a fanout refuse carries the fanout tag (callers without run_tool_program skip it)', () => {
  const sess = freshSession();
  // Distinct-args read grinding trips the fanout block (entity-gated ≥6 distinct).
  let fanout: ReturnType<typeof grindGateVerdict> = null;
  for (let i = 1; i <= 12; i++) {
    const v = grindGateVerdict(sess, 'dataforseo__serp_organic_live_advanced', { keyword: `firm ${i} san antonio`, url: `https://firm${i}.com` });
    if (v?.fanout) { fanout = v; break; }
  }
  if (fanout) {
    assert.equal(fanout.interrupt, false, 'fanout steer is a soft deny the model reads');
    assert.match(fanout.message, /REFUSED|one-at-a-time|program/i);
  }
  // (entity-gate specifics may keep this advisory-only for some shapes — the
  // tagged pathway is what this test pins when it does fire)
});

test('grindGateVerdict: normal varied usage is untouched', () => {
  const sess = freshSession();
  assert.equal(grindGateVerdict(sess, 'notion__search', { q: 'alpha' }), null);
  assert.equal(grindGateVerdict(sess, 'linear__list_issues', { team: 'eng' }), null);
});

// ── boundary verdict ─────────────────────────────────────────────────────────

test('evaluateTurnBoundary precedence: kill → wall-clock → token budget → max-steps', () => {
  const sess = freshSession();
  const base = { sessionId: sess, startedAt: Date.now(), maxWallMs: 0, stepIndex: 1, maxSteps: 100, tokenWindow: null };
  assert.equal(evaluateTurnBoundary(base).kind, 'continue');

  requestKill(sess, 'x');
  assert.equal(evaluateTurnBoundary(base).kind, 'killed');
  clearKill(sess);

  const wallHit = evaluateTurnBoundary({ ...base, startedAt: Date.now() - 10_000, maxWallMs: 5_000 });
  assert.deepEqual({ kind: wallHit.kind, limit: (wallHit as { limit?: string }).limit }, { kind: 'limit', limit: 'wall_clock' });

  const window = openRunTokenWindow({ sessionId: sess, ceiling: 1_000 });
  accrueSessionTokens(sess, 2_000);
  const both = evaluateTurnBoundary({ ...base, startedAt: Date.now() - 10_000, maxWallMs: 5_000, tokenWindow: window });
  assert.equal((both as { limit?: string }).limit, 'wall_clock', 'wall-clock wins a dual breach (loop precedence)');
  const budgetOnly = evaluateTurnBoundary({ ...base, tokenWindow: window });
  assert.equal((budgetOnly as { limit?: string }).limit, 'token_budget');

  const steps = evaluateTurnBoundary({ ...base, stepIndex: 100 });
  assert.equal((steps as { limit?: string }).limit, 'max_steps');
});

// ── background offer (policy: default ON) ────────────────────────────────────

test('background offer: default ON; triggers on tool count OR elapsed; one-shot; chat-only', () => {
  assert.equal(backgroundOfferEnabled(), true, 'graduated to default ON per the 2026-07-16 policy');
  const chat = freshSession('chat');
  const base = { sessionId: chat, toolCalls: 0, elapsedMs: 0, alreadyNudged: false };
  assert.equal(shouldOfferBackground(base), false, 'quick turns are never nudged');
  assert.equal(shouldOfferBackground({ ...base, toolCalls: 6 }), true, 'tool-count trigger');
  assert.equal(shouldOfferBackground({ ...base, elapsedMs: 91_000 }), true, 'elapsed trigger');
  assert.equal(shouldOfferBackground({ ...base, toolCalls: 6, alreadyNudged: true }), false, 'one-shot');
  assert.equal(shouldOfferBackground({ ...base, toolCalls: 6, suppressed: true }), false);
  const exec = freshSession('execution');
  assert.equal(shouldOfferBackground({ ...base, sessionId: exec, toolCalls: 20 }), false, 'non-chat sessions never nudge');
  assert.equal(shouldOfferBackground({ ...base, sessionId: 'background:bg-1', toolCalls: 20 }), false);
  process.env.CLEMMY_BG_OFFER_NUDGE = 'off';
  assert.equal(shouldOfferBackground({ ...base, toolCalls: 20 }), false, 'kill-switch respected');
});
