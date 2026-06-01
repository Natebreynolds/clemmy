/**
 * Run: npx tsx --test src/runtime/harness/tool-guardrail.test.ts
 *
 * Tool-call guardrail (primitive 6) — loop detection + tool-return
 * size enforcement. Pure-logic tests; no SDK, no DB.
 *
 * v0.5.19 F6 — these tests use synthetic session ids that don't
 * exist in the sqlite sessions table, so the new write-through
 * persistence would log FK constraint failures on every call.
 * Bypass with the revert flag — the F6 sub-test in
 * scripts/verify-long-running.mjs exercises the persistence path
 * with real session rows.
 */
process.env.CLEMMY_GUARDRAIL_PERSIST = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashToolCall,
  evaluateToolCall,
  applyMode,
  _peekTracker,
  _resetAllTrackersForTests,
  resetTracker,
} from './tool-guardrail.js';

// ─── hashToolCall — canonical signatures ──────────────────────────

test('hashToolCall: identical args produce identical hash', () => {
  const h1 = hashToolCall('memory_search', { query: 'foo' });
  const h2 = hashToolCall('memory_search', { query: 'foo' });
  assert.equal(h1, h2);
});

test('hashToolCall: different tool names produce different hashes', () => {
  const h1 = hashToolCall('memory_search', { query: 'foo' });
  const h2 = hashToolCall('memory_recall', { query: 'foo' });
  assert.notEqual(h1, h2);
});

test('hashToolCall: key order in args does not affect hash (canonicalization)', () => {
  const h1 = hashToolCall('composio_execute_tool', { tool_slug: 'X', arguments: '{"a":1,"b":2}' });
  const h2 = hashToolCall('composio_execute_tool', { arguments: '{"a":1,"b":2}', tool_slug: 'X' });
  assert.equal(h1, h2);
});

test('hashToolCall: handles primitive args (string, number, null)', () => {
  assert.ok(hashToolCall('ping', null));
  assert.ok(hashToolCall('ping', 'string-arg'));
  assert.ok(hashToolCall('ping', 42));
});

// ─── evaluateToolCall — exact-args repeat ─────────────────────────

test('evaluateToolCall: first call always allowed', () => {
  _resetAllTrackersForTests();
  const decision = evaluateToolCall('sess-1', 'memory_search', { query: 'X' });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.count, 1);
});

test('evaluateToolCall: exact-args repeat hits warn at 2nd, block at 5th', () => {
  _resetAllTrackersForTests();
  const args = { query: 'same' };
  evaluateToolCall('sess-2', 'memory_search', args); // count=1 allow
  const d2 = evaluateToolCall('sess-2', 'memory_search', args); // count=2 warn
  assert.equal(d2.action, 'warn');
  assert.equal(d2.rule, 'exact_args_repeat');
  evaluateToolCall('sess-2', 'memory_search', args); // 3
  evaluateToolCall('sess-2', 'memory_search', args); // 4
  const d5 = evaluateToolCall('sess-2', 'memory_search', args); // 5 block
  assert.equal(d5.action, 'block');
  assert.equal(d5.count, 5);
});

test('evaluateToolCall: per-session isolation — two sessions don\'t cross-contaminate', () => {
  _resetAllTrackersForTests();
  const args = { query: 'same' };
  for (let i = 0; i < 4; i += 1) evaluateToolCall('sess-A', 'memory_search', args);
  const dA = evaluateToolCall('sess-A', 'memory_search', args); // 5 block
  const dB = evaluateToolCall('sess-B', 'memory_search', args); // session B's 1st: allow
  assert.equal(dA.action, 'block');
  assert.equal(dB.action, 'allow');
});

// ─── evaluateToolCall — same-mut-tool different-args ──────────────

test('evaluateToolCall: mutating tool with N distinct arg sets hits warn at 3, halt at 8', () => {
  _resetAllTrackersForTests();
  // composio_execute_tool is classified by its INNER slug (2026-06-01): a
  // write slug (SEND/CREATE/…) is mutating, a read slug (LIST/GET/…) is not.
  // Use a write slug here so the same-mut-tool runaway rule engages.
  for (let i = 0; i < 2; i += 1) {
    evaluateToolCall('sess-3', 'composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL', arguments: `${i}` });
  }
  // 3rd distinct args → warn
  const d3 = evaluateToolCall('sess-3', 'composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL', arguments: 'distinct-3' });
  assert.equal(d3.action, 'warn');
  assert.equal(d3.rule, 'same_mut_tool_repeat');
  for (let i = 4; i < 8; i += 1) {
    evaluateToolCall('sess-3', 'composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL', arguments: `distinct-${i}` });
  }
  // 8th distinct args → halt
  const d8 = evaluateToolCall('sess-3', 'composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL', arguments: 'distinct-8' });
  assert.equal(d8.action, 'halt');
});

test('evaluateToolCall: a looping composio READ slug never escalates to a turn-kill', () => {
  // Regression guard for the 2026-06-01 live incident: AIRTABLE_LIST_RECORDS
  // (a READ) repeated 7× got escalate-KILLED with a raw error because
  // composio_execute_tool was classified flatly mutating. A read slug must
  // never escalate — repeating it wastes budget but cannot corrupt state, so
  // it gets the soft 'block' corrective instead.
  _resetAllTrackersForTests();
  const readArgs = { tool_slug: 'AIRTABLE_LIST_RECORDS', arguments: '{"baseId":"app1","tableIdOrName":"tbl1"}' };
  let last;
  for (let i = 0; i < 12; i += 1) {
    last = evaluateToolCall('sess-read', 'composio_execute_tool', readArgs);
  }
  // After many identical repeats it is blocked (corrective), NOT escalated.
  assert.notEqual(last?.action, 'escalate');
  assert.equal(last?.action, 'block');

  // A WRITE slug with the same repetition DOES escalate (turn-kill is correct).
  _resetAllTrackersForTests();
  const writeArgs = { tool_slug: 'AIRTABLE_CREATE_RECORDS', arguments: '{"baseId":"app1"}' };
  let lastWrite;
  for (let i = 0; i < 12; i += 1) {
    lastWrite = evaluateToolCall('sess-write', 'composio_execute_tool', writeArgs);
  }
  assert.equal(lastWrite?.action, 'escalate');
});

test('evaluateToolCall: read slugs with SET/ADD SUBSTRINGS are not misclassified as writes (token match)', () => {
  // Guard for the 2026-06-01 review finding: classification must be TOKEN-based
  // (split on '_', match canonical MUTATING_VERBS), not a substring regex.
  // Otherwise a read slug whose tokens merely CONTAIN "SET"/"ADD" (OFFSET,
  // ADDRESS, RESET, ASSET) would be flagged mutating and escalate-killed.
  for (const readSlug of ['HUBSPOT_LIST_OFFSET_RECORDS', 'CRM_GET_ADDRESS', 'X_GET_ASSET_LIST']) {
    _resetAllTrackersForTests();
    const args = { tool_slug: readSlug, arguments: '{}' };
    let last;
    for (let i = 0; i < 12; i += 1) {
      last = evaluateToolCall('sess-sub', 'composio_execute_tool', args);
    }
    assert.notEqual(last?.action, 'escalate', `${readSlug} (a read) must never escalate-kill`);
  }
});

test('evaluateToolCall: idempotent tool with many distinct args is NOT flagged by same-mut-tool rule', () => {
  _resetAllTrackersForTests();
  // memory_search is idempotent; firing it 10x with different queries should not halt
  for (let i = 0; i < 10; i += 1) {
    const d = evaluateToolCall('sess-4', 'memory_search', { query: `q-${i}` });
    assert.notEqual(d.action, 'halt');
  }
});

// ─── applyMode — mode-based action demotion ──────────────────────

test('applyMode: warn mode HARD-BLOCKS an exact-args loop on a MUTATING tool (runaway stop)', () => {
  // Mutating tool, identical args, ≥ block threshold = the dangerous runaway
  // (e.g. 137× workflow_run with identical inputs). Hard-block in default mode.
  const exactLoop = {
    action: 'block' as const,
    signature: 'sig',
    toolName: 'workflow_run', // mutating
    reason: 'loop',
    rule: 'exact_args_repeat' as const,
    count: 5,
  };
  assert.equal(applyMode(exactLoop, 'warn').action, 'block');
});

test('applyMode: warn mode does NOT block an exact-args loop on a READ/poll tool (polling is legit)', () => {
  // Polling workflow_run_status (a read) for an async result repeats the
  // identical call — legitimate + non-destructive. Must NOT hard-block;
  // demote to warn so the poll continues.
  const pollLoop = {
    action: 'block' as const,
    signature: 'sig',
    toolName: 'workflow_run_status', // read, not in MUTATING_TOOLS
    reason: 'loop',
    rule: 'exact_args_repeat' as const,
    count: 6,
  };
  assert.equal(applyMode(pollLoop, 'warn').action, 'warn');
});

test('applyMode: warn mode still demotes non-exact-args block/halt to warn', () => {
  // Same tool, DIFFERENT args (possibly legitimate varied/batch work) stays
  // demoted in the default mode; strict mode enforces it.
  const variedHalt = {
    action: 'halt' as const,
    signature: 'sig',
    toolName: 'composio_execute_tool',
    reason: 'varied',
    rule: 'same_mut_tool_repeat' as const,
    count: 8,
  };
  assert.equal(applyMode(variedHalt, 'warn').action, 'warn');
});

test('applyMode: strict mode passes block/halt through unchanged', () => {
  const blockDecision = {
    action: 'block' as const,
    signature: 'sig',
    toolName: 'memory_search',
    reason: 'test',
    rule: 'exact_args_repeat' as const,
    count: 5,
  };
  assert.equal(applyMode(blockDecision, 'strict').action, 'block');
});

test('applyMode: off mode always returns allow', () => {
  const haltDecision = {
    action: 'halt' as const,
    signature: 'sig',
    toolName: 'composio_execute_tool',
    reason: 'test',
    rule: 'same_mut_tool_repeat' as const,
    count: 10,
  };
  assert.equal(applyMode(haltDecision, 'off').action, 'allow');
});

// (maybeTruncateToolReturn tests removed 2026-05-24 — function removed
//  from tool-guardrail.ts; truncation handled by hooks.ts/clipToolResult
//  + writeToolOutput + compaction.ts Layer 1. See hooks.test.ts.)

// ─── tracker housekeeping ─────────────────────────────────────────

test('resetTracker: clears per-session state', () => {
  _resetAllTrackersForTests();
  evaluateToolCall('sess-rst', 'memory_search', { q: 'x' });
  assert.equal(_peekTracker('sess-rst').recentCount, 1);
  resetTracker('sess-rst');
  assert.equal(_peekTracker('sess-rst').recentCount, 0);
});

test('window cap: tracker bounded by recentWindowSize env (default 100)', () => {
  _resetAllTrackersForTests();
  // Default window is 100; push 150 to verify the head is pruned
  for (let i = 0; i < 150; i += 1) {
    evaluateToolCall('sess-cap', 'memory_search', { q: `unique-${i}` });
  }
  assert.equal(_peekTracker('sess-cap').recentCount, 100);
});
