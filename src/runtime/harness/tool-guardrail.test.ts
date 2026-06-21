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

test('evaluateToolCall: corrective-then-terminal — a mutating exact-args loop stays SOFT block through the advisory window, escalates only at hardStop', () => {
  // 2026-06-20: the bar is "inform, rarely block; hard-stop only on budget
  // abuse." A repeating identical mutating call now gets a LONG advisory window
  // of soft 'block' refusals (which the model sees + can recover from) before
  // the terminal escalate fires at hardStopAt (= blockAt+7 = 12 by default).
  // Previously escalate hard-killed the turn at blockAt+2 (=7) — the blunt
  // turn-ender that cut off the live site-host run.
  _resetAllTrackersForTests();
  const args = { workflow_id: 'wf-ladder' };
  const call = () => evaluateToolCall('sess-ladder', 'workflow_run', args); // workflow_run is mutating
  let d;
  for (let i = 0; i < 5; i += 1) d = call();          // counts 1..5
  assert.equal(d?.action, 'block', 'count 5 → soft block (advisory)');
  for (let i = 6; i <= 11; i += 1) d = call();         // counts 6..11
  assert.equal(d?.count, 11);
  assert.equal(d?.action, 'block', 'count 11 → STILL soft block (advisory window), not a turn-kill');
  d = call();                                          // count 12 = hardStopAt
  assert.equal(d?.count, 12);
  assert.equal(d?.action, 'escalate', 'count 12 (hardStop) → terminal escalate, the runaway backstop');
});

test('evaluateToolCall: the soft-block message hardens to "provably stuck" past blockAt+2', () => {
  _resetAllTrackersForTests();
  const args = { workflow_id: 'wf-msg' };
  const call = () => evaluateToolCall('sess-msg', 'workflow_run', args);
  let d;
  for (let i = 0; i < 5; i += 1) d = call();          // count 5
  assert.match(d!.reason, /STOP/i);
  assert.doesNotMatch(d!.reason, /provably stuck/i);  // milder at the start of the window
  for (let i = 6; i <= 7; i += 1) d = call();          // count 7 = blockAt+2
  assert.match(d!.reason, /provably stuck/i);          // hardened, terminal-toned
});

test('evaluateToolCall: CLEMMY_GUARDRAIL_EXACT_HARDSTOP tunes the terminal threshold', () => {
  _resetAllTrackersForTests();
  const prev = process.env.CLEMMY_GUARDRAIL_EXACT_HARDSTOP;
  process.env.CLEMMY_GUARDRAIL_EXACT_HARDSTOP = '6';
  try {
    const args = { workflow_id: 'wf-tune' };
    let d;
    for (let i = 0; i < 6; i += 1) d = evaluateToolCall('sess-tune', 'workflow_run', args);
    assert.equal(d?.action, 'escalate', 'with hardStop=6, the 6th identical call escalates');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_GUARDRAIL_EXACT_HARDSTOP;
    else process.env.CLEMMY_GUARDRAIL_EXACT_HARDSTOP = prev;
  }
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

// ─── evaluateToolCall — serial-batch fan-out nudge ────────────────

test('fanoutNudge: 3rd DISTINCT same-slug composio call attaches the nudge (and cadence re-fires at 8)', () => {
  _resetAllTrackersForTests();
  const call = (i: number) =>
    evaluateToolCall('sess-fan', 'composio_execute_tool', {
      tool_slug: 'DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID',
      arguments: `{"id":"task-${i}"}`,
    });
  assert.equal(call(1).fanoutNudge, undefined);
  assert.equal(call(2).fanoutNudge, undefined);
  const d3 = call(3);
  assert.ok(d3.fanoutNudge, '3rd distinct same-slug call must carry the nudge');
  assert.match(d3.fanoutNudge!, /run_worker/);
  // Cadence: 4th–7th distinct stay quiet, 8th re-fires.
  for (let i = 4; i <= 7; i += 1) assert.equal(call(i).fanoutNudge, undefined, `distinct #${i} must not re-nudge`);
  assert.ok(call(8).fanoutNudge, '8th distinct re-fires the nudge');
});

test('fanoutNudge: re-polling the SAME id never nudges (identical args = one distinct entry)', () => {
  _resetAllTrackersForTests();
  const args = { tool_slug: 'DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID', arguments: '{"id":"task-1"}' };
  for (let i = 0; i < 6; i += 1) {
    const d = evaluateToolCall('sess-poll', 'composio_execute_tool', args);
    assert.equal(d.fanoutNudge, undefined, 'legitimate polling must not be told to fan out');
  }
});

test('fanoutNudge: different slugs do NOT group together', () => {
  _resetAllTrackersForTests();
  const slugs = ['AIRTABLE_LIST_RECORDS', 'SALESFORCE_QUERY', 'OUTLOOK_LIST_MESSAGES'];
  for (const [i, slug] of slugs.entries()) {
    const d = evaluateToolCall('sess-mix', 'composio_execute_tool', { tool_slug: slug, arguments: `{"n":${i}}` });
    assert.equal(d.fanoutNudge, undefined);
  }
});

test('fanoutNudge: non-composio tools never nudge (local serialization is legitimate)', () => {
  _resetAllTrackersForTests();
  for (let i = 0; i < 6; i += 1) {
    const d = evaluateToolCall('sess-local', 'read_file', { path: `/tmp/f-${i}` });
    assert.equal(d.fanoutNudge, undefined);
  }
});

// ─── FIX 2: within-task fetch memory (cache nudge) ────────────────
function withRecallNudge<T>(fn: () => T): T {
  const prev = process.env.CLEMMY_WITHIN_TASK_RECALL_NUDGE;
  process.env.CLEMMY_WITHIN_TASK_RECALL_NUDGE = 'on';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_WITHIN_TASK_RECALL_NUDGE;
    else process.env.CLEMMY_WITHIN_TASK_RECALL_NUDGE = prev;
  }
}

test('FIX 2: a CACHE_SAFE read repeated with identical args sets cachedCallId pointing at the prior call', () => {
  withRecallNudge(() => {
    _resetAllTrackersForTests();
    const args = { query: 'market leaders' };
    evaluateToolCall('sess-cache-1', 'memory_search', args, 'call-A');
    const d2 = evaluateToolCall('sess-cache-1', 'memory_search', args, 'call-B');
    assert.equal(d2.cachedCallId, 'call-A', 'points at the prior identical call');
    assert.ok((d2.cachedAgeMs ?? -1) >= 0, 'carries an age');
  });
});

test('FIX 2: flag OFF (default) never sets cachedCallId', () => {
  _resetAllTrackersForTests();
  const args = { query: 'x' };
  evaluateToolCall('sess-cache-2', 'memory_search', args, 'call-A');
  const d2 = evaluateToolCall('sess-cache-2', 'memory_search', args, 'call-B');
  assert.equal(d2.cachedCallId, undefined, 'no nudge when the feature is off (default)');
});

test('FIX 2: external-mutable reads + pollers are NOT cached (allowlist polarity)', () => {
  withRecallNudge(() => {
    // composio read (AIRTABLE_LIST_RECORDS): idempotent, but an external actor
    // can change the rows between calls — never serve a cached copy.
    _resetAllTrackersForTests();
    const a = { tool_slug: 'AIRTABLE_LIST_RECORDS', arguments: '{"view":"v"}' };
    evaluateToolCall('s-ext', 'composio_execute_tool', a, 'c1');
    assert.equal(
      evaluateToolCall('s-ext', 'composio_execute_tool', a, 'c2').cachedCallId,
      undefined,
      'composio reads are never cached (external-mutable)',
    );
    // a poller — re-reading an async status is the whole point.
    _resetAllTrackersForTests();
    const p = { id: 'run-1' };
    evaluateToolCall('s-poll', 'workflow_run_status', p, 'c1');
    assert.equal(
      evaluateToolCall('s-poll', 'workflow_run_status', p, 'c2').cachedCallId,
      undefined,
      'pollers are never cached',
    );
  });
});

test('FIX 2: an intervening write invalidates a read_file cache (no stale nudge)', () => {
  withRecallNudge(() => {
    _resetAllTrackersForTests();
    const readArgs = { path: '/x/draft.md' };
    evaluateToolCall('s-rw', 'read_file', readArgs, 'r1');
    evaluateToolCall('s-rw', 'write_file', { path: '/x/draft.md', content: '...' }, 'w1');
    assert.equal(
      evaluateToolCall('s-rw', 'read_file', readArgs, 'r2').cachedCallId,
      undefined,
      'a write since the last read suppresses the cache nudge',
    );
  });
});

test('FIX 2: focus_get cache invalidated by a focus_set between reads', () => {
  withRecallNudge(() => {
    _resetAllTrackersForTests();
    evaluateToolCall('s-focus', 'focus_get', {}, 'f1');
    evaluateToolCall('s-focus', 'focus_set', { title: 'X' }, 'fs1');
    assert.equal(evaluateToolCall('s-focus', 'focus_get', {}, 'f2').cachedCallId, undefined);
  });
});

test('FIX 2: a static read with NO in-session mutator (skill_read) caches across a write', () => {
  withRecallNudge(() => {
    _resetAllTrackersForTests();
    const args = { name: 'proposal-builder' };
    evaluateToolCall('s-skill', 'skill_read', args, 'k1');
    evaluateToolCall('s-skill', 'write_file', { path: '/x', content: 'y' }, 'w1');
    // skill_read has no mapped mutator family — a file write can't change a skill.
    assert.equal(evaluateToolCall('s-skill', 'skill_read', args, 'k2').cachedCallId, 'k1');
  });
});

test('FIX 2: applyMode off strips the cache nudge (one coherent off-switch)', () => {
  withRecallNudge(() => {
    _resetAllTrackersForTests();
    const args = { query: 'x' };
    evaluateToolCall('s-mode', 'memory_search', args, 'c1');
    const d2 = evaluateToolCall('s-mode', 'memory_search', args, 'c2');
    assert.equal(d2.cachedCallId, 'c1');
    assert.equal(applyMode(d2, 'off').cachedCallId, undefined);
  });
});

test('fanoutNudge: rides on a warn decision too (same-mut-tool warn keeps the nudge)', () => {
  _resetAllTrackersForTests();
  // 3 distinct WRITE-slug calls: hits same_mut_tool_repeat warn AND the
  // fan-out threshold simultaneously — the nudge must survive on the warn.
  evaluateToolCall('sess-warn', 'composio_execute_tool', { tool_slug: 'AIRTABLE_CREATE_RECORDS', arguments: '{"n":1}' });
  evaluateToolCall('sess-warn', 'composio_execute_tool', { tool_slug: 'AIRTABLE_CREATE_RECORDS', arguments: '{"n":2}' });
  const d3 = evaluateToolCall('sess-warn', 'composio_execute_tool', { tool_slug: 'AIRTABLE_CREATE_RECORDS', arguments: '{"n":3}' });
  assert.equal(d3.action, 'warn');
  assert.equal(d3.rule, 'same_mut_tool_repeat');
  assert.ok(d3.fanoutNudge);
});

test('fanoutNudge: slug-specific batch-API hints (DataForSEO tasks array, TASKS_READY, Airtable records array)', () => {
  const cases: Array<[slug: string, expect: RegExp]> = [
    ['DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST', /`tasks` ARRAY/],
    ['DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID', /TASKS_READY/],
    ['AIRTABLE_UPDATE_RECORDS', /`records` ARRAY/],
  ];
  for (const [slug, re] of cases) {
    _resetAllTrackersForTests();
    let d;
    for (let i = 1; i <= 3; i += 1) {
      d = evaluateToolCall(`sess-hint-${slug}`, 'composio_execute_tool', { tool_slug: slug, arguments: `{"n":${i}}` });
    }
    assert.ok(d?.fanoutNudge, `${slug}: 3rd distinct call must nudge`);
    assert.match(d!.fanoutNudge!, re, `${slug}: nudge must carry its batch-API hint`);
  }
  // A slug with no known batch shape gets the generic nudge, no NOTE.
  _resetAllTrackersForTests();
  let d;
  for (let i = 1; i <= 3; i += 1) {
    d = evaluateToolCall('sess-hint-none', 'composio_execute_tool', { tool_slug: 'SALESFORCE_QUERY', arguments: `{"n":${i}}` });
  }
  assert.ok(d?.fanoutNudge);
  assert.doesNotMatch(d!.fanoutNudge!, /NOTE:/);
});

test('fanoutNudge: applyMode off strips the nudge', () => {
  _resetAllTrackersForTests();
  for (let i = 1; i <= 2; i += 1) {
    evaluateToolCall('sess-off', 'composio_execute_tool', { tool_slug: 'SALESFORCE_QUERY', arguments: `{"q":${i}}` });
  }
  const d3 = evaluateToolCall('sess-off', 'composio_execute_tool', { tool_slug: 'SALESFORCE_QUERY', arguments: '{"q":3}' });
  assert.ok(d3.fanoutNudge);
  assert.equal(applyMode(d3, 'off').fanoutNudge, undefined);
  assert.equal(applyMode(d3, 'warn').fanoutNudge, d3.fanoutNudge);
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

test('applyMode: warn mode does NOT hard-block a looping composio READ slug (slug-aware)', () => {
  // Regression for the 2026-06-02 live incident: a looping AIRTABLE_LIST_RECORDS
  // read got hard-blocked ("the system stopped repeated Airtable reads") because
  // applyMode keyed off MUTATING_TOOLS.has('composio_execute_tool') = true. The
  // decision now carries the SLUG-AWARE mutating flag (false for a read slug),
  // so the read block demotes to warn and the agent keeps going.
  const readLoop = {
    action: 'block' as const,
    signature: 'sig',
    toolName: 'composio_execute_tool',
    reason: 'loop',
    rule: 'exact_args_repeat' as const,
    count: 6,
    mutating: false, // inner slug is a read (AIRTABLE_LIST_RECORDS)
  };
  assert.equal(applyMode(readLoop, 'warn').action, 'warn');
});

test('applyMode: warn mode STILL hard-blocks a looping composio WRITE slug (slug-aware)', () => {
  // The flip side: a write slug (OUTLOOK_SEND_EMAIL) with identical args is the
  // dangerous duplicate-send runaway — must stay blocked even in warn mode.
  const writeLoop = {
    action: 'block' as const,
    signature: 'sig',
    toolName: 'composio_execute_tool',
    reason: 'loop',
    rule: 'exact_args_repeat' as const,
    count: 6,
    mutating: true, // inner slug is a write (OUTLOOK_SEND_EMAIL)
  };
  assert.equal(applyMode(writeLoop, 'warn').action, 'block');
});

test('evaluateToolCall: a looping composio READ slug decision demotes end-to-end in warn mode', () => {
  // Full path: a read slug repeated past the block threshold returns
  // action:'block' WITH mutating:false, which applyMode(warn) demotes to warn.
  _resetAllTrackersForTests();
  const readArgs = { tool_slug: 'AIRTABLE_LIST_RECORDS', arguments: '{"baseId":"app1","tableIdOrName":"tbl1"}' };
  let raw;
  for (let i = 0; i < 6; i += 1) {
    raw = evaluateToolCall('sess-read-e2e', 'composio_execute_tool', readArgs);
  }
  assert.equal(raw?.action, 'block');
  assert.equal(raw?.mutating, false);
  assert.equal(applyMode(raw!, 'warn').action, 'warn');
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
