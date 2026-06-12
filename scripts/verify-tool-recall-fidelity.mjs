#!/usr/bin/env node
// scripts/verify-tool-recall-fidelity.mjs
//
// End-to-end TOOL-RECALL FIDELITY choke suite.
//
// The 80-tool smoke in verify-long-running.mjs proves the multi-turn loop
// survives volume, but its tool events are synthetic — nothing checks that
// what the model RECALLS later is byte-identical to what the tool actually
// returned. A wrong recall before an irreversible write (email send, CRM
// update) is the catastrophic failure mode this suite exists to choke.
//
// Every probe runs the REAL compiled code from dist/ (storage, recall tool
// handler, compaction layers, batch validator, grounding search) inside a
// sandboxed CLEMENTINE_HOME. Offline: no daemon, no model, no network.
//
// Usage:
//   node scripts/verify-tool-recall-fidelity.mjs --all
//   node scripts/verify-tool-recall-fidelity.mjs --only=<name>
//   node scripts/verify-tool-recall-fidelity.mjs --list

import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// CLEMMY_VERIFY_DIST lets the suite run against an alternate compiled
// dist — e.g. the installed Clementine.app daemon after hotpatch:
//   CLEMMY_VERIFY_DIST="/Applications/Clementine.app/Contents/Resources/daemon/dist" node scripts/verify-tool-recall-fidelity.mjs --all
const DAEMON_DIST = process.env.CLEMMY_VERIFY_DIST || path.join(REPO_ROOT, 'dist');

if (!existsSync(path.join(DAEMON_DIST, 'runtime/harness/loop.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

const palette = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { red: '', green: '', yellow: '', dim: '', bold: '', reset: '' };

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
function section(title) { console.log(`\n${palette.bold}→ ${title}${palette.reset}`); }

// ─── Sandbox HOME ──────────────────────────────────────────────────

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-verify-recall-fidelity-'));
mkdirSync(path.join(tmpHome, '.clementine-next', 'state'), { recursive: true });
const originalHome = process.env.HOME;
const originalClemmyHome = process.env.CLEMENTINE_HOME;
process.env.HOME = tmpHome;
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');
if (process.platform === 'win32') process.env.USERPROFILE = tmpHome;

process.on('exit', () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalClemmyHome !== undefined) process.env.CLEMENTINE_HOME = originalClemmyHome;
  else delete process.env.CLEMENTINE_HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ─── Shared module loading ─────────────────────────────────────────

async function loadMods() {
  const eventlog = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/eventlog.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/session.js')).href);
  const loop = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/loop.js')).href);
  const brackets = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/brackets.js')).href);
  const compaction = await import(pathToFileURL(path.join(DAEMON_DIST, 'runtime/harness/compaction.js')).href);
  const recallTools = await import(pathToFileURL(path.join(DAEMON_DIST, 'tools/recall-tools.js')).href);
  const batchValidator = await import(pathToFileURL(path.join(DAEMON_DIST, 'tools/composio-batch-validator.js')).href);
  const schemaCache = await import(pathToFileURL(path.join(DAEMON_DIST, 'tools/composio-schema-cache.js')).href);
  return { eventlog, sessionMod, loop, brackets, compaction, recallTools, batchValidator, schemaCache };
}

// Capture the real recall_tool_result / tool_output_query handlers by
// registering against a fake McpServer.
function captureRecallHandlers(recallTools) {
  const handlers = {};
  const fakeServer = { tool: (name, _desc, _schema, handler) => { handlers[name] = handler; } };
  recallTools.registerRecallTools(fakeServer);
  return handlers;
}

function textOf(result) {
  return result?.content?.map((c) => c.text).join('\n') ?? '';
}

// Deterministic sentinel payload per (turn, call). Embeds exactly the kind
// of data a wrong recall would weaponize: a recipient email, a record id,
// a dollar amount, and a unique nonce.
function sentinelPayload(turn, call, padBytes = 2000) {
  const nonce = `nonce_t${turn}c${call}_${(turn * 1000 + call).toString(36).padStart(8, 'x')}`;
  const body = {
    record: `rec_T${turn}_C${call}`,
    email: `client.t${turn}c${call}@fidelity-probe.example.com`,
    amount: `$${(turn * 1117 + call * 13).toFixed(2)}`,
    nonce,
    // Pad so Layer 1 clipping (>=400 chars) always applies.
    pad: 'x'.repeat(padBytes),
  };
  return { nonce, email: body.email, record: body.record, amount: body.amount, json: JSON.stringify(body) };
}

// ─── Probe 1 — long-chat byte-exact recall ─────────────────────────
//
// 8 turns × 12 tool calls through the REAL runConversation loop. Every
// call's output is written through the REAL writeToolOutput path. After
// the conversation completes, the REAL recall_tool_result handler is
// invoked for every one of the 96 call_ids and the returned body must
// contain that call's exact sentinel data — and must NOT contain any
// other call's nonce (no bleed).

async function probeLongChatByteExactRecall(mods) {
  const { eventlog, sessionMod, loop, brackets, recallTools } = mods;
  eventlog.resetEventLog?.();
  const handlers = captureRecallHandlers(recallTools);

  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'recall fidelity probe' });
  const TURNS = 8;
  const CALLS_PER_TURN = 12;
  const expected = new Map(); // callId -> sentinel

  let turnCount = 0;
  const runRunner = async (_runner, _agent, items, opts) => {
    turnCount += 1;
    const sessionId = opts?.context?.sessionId ?? sess.id;
    const turn = opts?.context?.turn ?? turnCount;
    for (let i = 0; i < CALLS_PER_TURN; i++) {
      const callId = `call_fid_${turnCount}_${i}`;
      const s = sentinelPayload(turnCount, i);
      expected.set(callId, s);
      eventlog.appendEvent({
        sessionId, turn, role: 'tool', type: 'tool_called',
        data: { name: 'probe_fetch_record', callId, args: { turn: turnCount, i } },
      });
      // The real write path: hooks.onToolEnd → writeToolOutput.
      eventlog.writeToolOutput({ sessionId, callId, tool: 'probe_fetch_record', output: s.json });
      eventlog.appendEvent({
        sessionId, turn, role: 'tool', type: 'tool_returned',
        data: { name: 'probe_fetch_record', callId, result: `[clipped: probe_fetch_record returned ${s.json.length} chars — call recall_tool_result("${callId}") for full output]` },
      });
    }
    const isLast = turnCount >= TURNS;
    return {
      history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: isLast ? 'done' : 'continuing' }] }],
      lastResponseId: `resp_${turnCount}`,
      finalOutput: isLast
        ? { summary: 'all calls done', reply: 'done', done: true, nextAction: 'completed' }
        : { summary: `turn ${turnCount}`, reply: null, done: false, nextAction: 'awaiting_handoff_result' },
    };
  };

  const result = await loop.runConversation({
    agent: { model: 'gpt-5.5' },
    sessionId: sess.id,
    input: 'fetch 96 records across 8 turns',
    runRunner,
    makeRunner: () => new EventEmitter(),
    maxSteps: 12,
    maxTurns: 50,
  });

  const checks = [];
  checks.push({ ok: result.status === 'completed', label: `conversation completed (got ${result.status})` });
  checks.push({ ok: expected.size === TURNS * CALLS_PER_TURN, label: `${TURNS * CALLS_PER_TURN} calls staged (got ${expected.size})` });

  // Recall every call_id through the real handler (unmetered context, as
  // the real code allows when no budget is attached).
  const allNonces = [...expected.values()].map((s) => s.nonce);
  let exact = 0, bled = 0, missing = 0, headerBad = 0;
  await brackets.withHarnessRunContext({ sessionId: sess.id, counter: null }, async () => {
    for (const [callId, s] of expected) {
      const body = textOf(await handlers.recall_tool_result({ call_id: callId }));
      if (body.includes('No tool output found')) { missing++; continue; }
      const hasOwn = body.includes(s.nonce) && body.includes(s.email) && body.includes(s.record) && body.includes(s.amount);
      const foreign = allNonces.some((n) => n !== s.nonce && body.includes(n));
      // Byte-exactness: the recalled slice must contain the verbatim JSON.
      const verbatim = body.includes(s.json);
      if (hasOwn && verbatim && !foreign) exact++;
      if (foreign) bled++;
      if (!/^Recalled \d+ chars \(of \d+ total bytes\)/.test(body)) headerBad++;
    }
  });
  checks.push({ ok: exact === expected.size, label: `byte-exact recall for all ${expected.size} calls (got ${exact}, missing ${missing})` });
  checks.push({ ok: bled === 0, label: `zero cross-call bleed (got ${bled})` });
  checks.push({ ok: headerBad === 0, label: `provenance header on every recall (bad: ${headerBad})` });

  // tool_output_query must return the SAME record for a projected read.
  await brackets.withHarnessRunContext({ sessionId: sess.id, counter: null }, async () => {
    const probe = [...expected.entries()][37]; // arbitrary mid-conversation call
    const body = textOf(await handlers.tool_output_query({ call_id: probe[0], fields: ['email', 'record'] }));
    checks.push({ ok: body.includes(probe[1].email) && body.includes(probe[1].record), label: 'tool_output_query projection returns the same record' });
  });

  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('long-chat-byte-exact-recall', `${checks.length} assertions; 8 turns × 12 calls, 96/96 byte-exact`);
  else fail('long-chat-byte-exact-recall', bad.map((b) => b.label).join('; '));
}

// ─── Probe 2 — cross-session isolation ─────────────────────────────
//
// The same call_id in two sessions must never leak across. A foreign
// call_id must fail LOUD ("No tool output found"), never return another
// session's data.

async function probeCrossSessionIsolation(mods) {
  const { eventlog, sessionMod, brackets, recallTools } = mods;
  const handlers = captureRecallHandlers(recallTools);

  const a = sessionMod.HarnessSession.create({ kind: 'chat', title: 'iso A' });
  const b = sessionMod.HarnessSession.create({ kind: 'chat', title: 'iso B' });
  const shared = 'call_shared_id_1';
  eventlog.writeToolOutput({ sessionId: a.id, callId: shared, tool: 't', output: 'SESSION_A_PAYLOAD wire $111 to alice@a.example' });
  eventlog.writeToolOutput({ sessionId: b.id, callId: shared, tool: 't', output: 'SESSION_B_PAYLOAD wire $999 to mallory@b.example' });
  eventlog.writeToolOutput({ sessionId: b.id, callId: 'call_only_in_b', tool: 't', output: 'B_ONLY_SECRET' });

  const checks = [];
  await brackets.withHarnessRunContext({ sessionId: a.id, counter: null }, async () => {
    const own = textOf(await handlers.recall_tool_result({ call_id: shared }));
    checks.push({ ok: own.includes('SESSION_A_PAYLOAD') && !own.includes('SESSION_B_PAYLOAD'), label: 'session A recalls its own payload for a shared call_id' });
    const foreign = textOf(await handlers.recall_tool_result({ call_id: 'call_only_in_b' }));
    checks.push({ ok: foreign.includes('No tool output found') && !foreign.includes('B_ONLY_SECRET'), label: 'foreign call_id fails loud, leaks nothing' });
  });

  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('cross-session-isolation', 'shared call_id scoped; foreign id fails loud');
  else fail('cross-session-isolation', bad.map((b) => b.label).join('; '));
}

// ─── Probe 3 — duplicate call_id semantics ─────────────────────────
//
// writeToolOutput keeps the LARGER payload when the same call_id is
// written twice (eventlog.ts:784). Pin the semantics so a regression is
// caught — and so the stale-read hazard is documented: a retry that
// returns a SMALLER corrected result is silently ignored.

async function probeDuplicateCallIdSemantics(mods) {
  const { eventlog, sessionMod } = mods;
  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'dup probe' });

  const id = 'call_dup_1';
  const first = `FIRST_${'a'.repeat(500)}`;
  const smaller = 'SECOND_SMALLER_CORRECTED';
  eventlog.writeToolOutput({ sessionId: sess.id, callId: id, tool: 't', output: first });
  eventlog.writeToolOutput({ sessionId: sess.id, callId: id, tool: 't', output: smaller });
  const afterSmaller = eventlog.getToolOutput(sess.id, id);

  const larger = `THIRD_LARGER_${'b'.repeat(800)}`;
  eventlog.writeToolOutput({ sessionId: sess.id, callId: id, tool: 't', output: larger });
  const afterLarger = eventlog.getToolOutput(sess.id, id);

  const checks = [
    { ok: afterSmaller?.output === first, label: 'smaller rewrite ignored (keep-larger semantics held)' },
    { ok: afterLarger?.output === larger, label: 'larger rewrite replaces' },
  ];
  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) {
    pass('duplicate-callid-keeps-larger', 'semantics pinned. HAZARD: a retry returning a smaller CORRECTED result is silently ignored — recall serves the stale larger payload. Safe only while the SDK guarantees unique call_ids.');
  } else fail('duplicate-callid-keeps-larger', bad.map((b) => b.label).join('; '));
}

// ─── Probe 4 — 200KB tail truncation warns loud ────────────────────
//
// A >200KB output is tail-truncated at write time. The tail is GONE —
// the safety net is the explicit truncation warning on recall. If the
// critical fact (here: the recipient) lived in the tail, recall must
// scream rather than silently present the head as complete.

async function probeTailTruncationWarns(mods) {
  const { eventlog, sessionMod, brackets, recallTools } = mods;
  const handlers = captureRecallHandlers(recallTools);
  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'trunc probe' });

  const TAIL_SENTINEL = 'CRITICAL_TAIL_RECIPIENT=ceo@only-in-the-tail.example.com';
  const big = 'h'.repeat(250_000) + TAIL_SENTINEL;
  eventlog.writeToolOutput({ sessionId: sess.id, callId: 'call_big_1', tool: 'bulk_export', output: big });
  const row = eventlog.getToolOutput(sess.id, 'call_big_1');

  const checks = [];
  checks.push({ ok: row?.truncatedAtWrite === true || row?.truncatedAtWrite === 1, label: 'truncated_at_write flag set' });
  checks.push({ ok: row?.contentBytes === Buffer.byteLength(big, 'utf8'), label: 'original byte count preserved for provenance' });
  checks.push({ ok: !row?.output.includes(TAIL_SENTINEL), label: 'tail is actually gone (documents the loss)' });

  await brackets.withHarnessRunContext({ sessionId: sess.id, counter: null }, async () => {
    const body = textOf(await handlers.recall_tool_result({ call_id: 'call_big_1' }));
    checks.push({ ok: body.includes('tail-truncated at write-time'), label: 'recall header warns about write-time truncation' });
    checks.push({ ok: !body.includes(TAIL_SENTINEL), label: 'recall does not fabricate the lost tail' });
  });

  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('tail-truncation-warns-loud', '250KB payload: tail lost at 200KB cap, flag + recall warning both present');
  else fail('tail-truncation-warns-loud', bad.map((b) => b.label).join('; '));
}

// ─── Probe 5 — compaction stubs stay recallable ────────────────────
//
// Layer 1 clip must stub with the CORRECT call_id, and every stubbed
// call_id must recall to the original full text. Layer 1b pair-collapse
// must REFUSE to collapse a pair whose output was never stored (the
// recallableToolOutputExists safety rule) — otherwise data would vanish.

async function probeCompactionStubsRecallable(mods) {
  const { eventlog, sessionMod, brackets, compaction, recallTools } = mods;
  const handlers = captureRecallHandlers(recallTools);
  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'compaction probe' });

  const N = 10;
  const items = [{ role: 'user', content: 'start' }];
  const sentinels = new Map();
  for (let i = 0; i < N; i++) {
    const callId = `call_cmp_${i}`;
    const s = sentinelPayload(99, i);
    sentinels.set(callId, s);
    if (i !== 7) {
      // call 7 deliberately has NO stored output — collapse must skip it.
      eventlog.writeToolOutput({ sessionId: sess.id, callId, tool: 'probe_tool', output: s.json });
    }
    items.push({ type: 'function_call', callId, name: 'probe_tool', arguments: JSON.stringify({ i }) });
    items.push({ type: 'function_call_result', callId, name: 'probe_tool', output: { type: 'text', text: s.json } });
  }
  items.push({ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] });

  const checks = [];

  // Layer 1: clip all but the last 2 results.
  const clipped = compaction.clipOldToolResults(items, 2);
  checks.push({ ok: clipped === N - 2, label: `clipped ${N - 2} old results (got ${clipped})` });
  const stubbed = items.filter((it) => it.__clipped);
  const stubIdsCorrect = stubbed.every((it) => {
    const txt = it.output?.text ?? '';
    return txt.includes(`recall_tool_result("${it.callId}")`);
  });
  checks.push({ ok: stubIdsCorrect, label: 'every stub carries its own call_id (no swaps)' });

  // Every stubbed-and-stored call_id must recall to the full original.
  let recallExact = 0;
  await brackets.withHarnessRunContext({ sessionId: sess.id, counter: null }, async () => {
    for (const it of stubbed) {
      if (it.callId === 'call_cmp_7') continue; // never stored
      const body = textOf(await handlers.recall_tool_result({ call_id: it.callId }));
      if (body.includes(sentinels.get(it.callId).json)) recallExact++;
    }
  });
  const stubbedStored = stubbed.filter((it) => it.callId !== 'call_cmp_7').length;
  checks.push({ ok: recallExact === stubbedStored, label: `all ${stubbedStored} stubbed+stored results recall byte-exact (got ${recallExact})` });

  // Layer 1b: collapse with sessionId — pair 7 (not recallable) must survive.
  const { nextItems, collapsed, callIds } = compaction.collapseOldCompletedToolPairs(items, 2, sess.id);
  checks.push({ ok: collapsed > 0, label: `collapsed ${collapsed} old pairs` });
  checks.push({ ok: !callIds.includes('call_cmp_7'), label: 'non-recallable pair NOT collapsed (safety rule held)' });
  const seven = nextItems.find((it) => it.type === 'function_call_result' && it.callId === 'call_cmp_7');
  checks.push({ ok: !!seven, label: 'non-recallable result still present in history' });
  const summary = nextItems.find((it) => it.role === 'system' && String(it.content ?? '').includes('collapsed before this turn'));
  const summaryIdsOk = summary ? callIds.every((id) => String(summary.content).includes(id) || String(summary.content).includes('additional older completed tool calls')) : false;
  checks.push({ ok: summaryIdsOk, label: 'collapse summary references the collapsed call_ids' });

  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('compaction-stubs-recallable', `${clipped} clips + ${collapsed} collapses, all recallable, unstored pair preserved`);
  else fail('compaction-stubs-recallable', bad.map((b) => b.label).join('; '));
}

// ─── Probe 6 — hallucinated call_id sanitized ──────────────────────
//
// Layer 2's mini-model summary can invent call_ids. validateCallIdReferences
// must rewrite fakes to [invalid call_id] so the model can never recall a
// nonexistent id and then improvise.

async function probeHallucinatedCallIdSanitized(mods) {
  const { compaction } = mods;
  const valid = new Set(['call_real_1']);
  const summary = 'Fetched the record [call_real_1] and the invoice [call_fake_999] earlier.';
  const out = compaction.validateCallIdReferences(summary, valid);
  const checks = [
    { ok: out.referenced.includes('call_real_1'), label: 'real id kept' },
    { ok: out.hallucinated.includes('call_fake_999'), label: 'fake id reported' },
    { ok: out.sanitized.includes('[call_real_1]') && !out.sanitized.includes('call_fake_999'), label: 'fake id scrubbed from summary' },
    { ok: out.sanitized.includes('[invalid call_id]'), label: 'fake rewritten to explicit invalid marker' },
  ];
  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('hallucinated-callid-sanitized', 'fake call_id scrubbed + reported; real id preserved');
  else fail('hallucinated-callid-sanitized', bad.map((b) => b.label).join('; '));
}

// ─── Probe 7 — TTL reap fails loud, never wrong ────────────────────
//
// After the 14-day reaper removes a row, recall must return the explicit
// "No tool output found" message — never stale data, never a crash.

async function probeTtlReapFailsLoud(mods) {
  const { eventlog, sessionMod, brackets, recallTools } = mods;
  const handlers = captureRecallHandlers(recallTools);
  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'ttl probe' });

  eventlog.writeToolOutput({ sessionId: sess.id, callId: 'call_old_1', tool: 't', output: 'ANCIENT_PAYLOAD' });
  eventlog.writeToolOutput({ sessionId: sess.id, callId: 'call_new_1', tool: 't', output: 'FRESH_PAYLOAD' });

  // Backdate the old row 20 days directly in the DB.
  const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));
  const dbPath = path.join(process.env.CLEMENTINE_HOME, 'state', 'harness.db');
  const db = new Database(dbPath);
  const backdated = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE tool_outputs SET created_at = ? WHERE call_id = ?').run(backdated, 'call_old_1');
  db.close();

  const reaped = eventlog.reapStaleToolOutputs();
  const checks = [{ ok: reaped >= 1, label: `reaper removed backdated row (got ${reaped})` }];

  await brackets.withHarnessRunContext({ sessionId: sess.id, counter: null }, async () => {
    const gone = textOf(await handlers.recall_tool_result({ call_id: 'call_old_1' }));
    checks.push({ ok: gone.includes('No tool output found') && !gone.includes('ANCIENT_PAYLOAD'), label: 'reaped row fails loud with explicit message' });
    const kept = textOf(await handlers.recall_tool_result({ call_id: 'call_new_1' }));
    checks.push({ ok: kept.includes('FRESH_PAYLOAD'), label: 'fresh row untouched by reaper' });
  });

  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('ttl-reap-fails-loud', '20-day-old row reaped; recall fails loud; fresh row intact');
  else fail('ttl-reap-fails-loud', bad.map((b) => b.label).join('; '));
}

// ─── Probe 8 — recall budget enforced without data leak ────────────
//
// Budget exhaustion must return a clean error string — no partial data
// riding along with it.

async function probeRecallBudgetEnforced(mods) {
  const { eventlog, sessionMod, brackets, recallTools } = mods;
  const handlers = captureRecallHandlers(recallTools);
  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'budget probe' });
  const SECRET = 'BUDGET_PROBE_SECRET_PAYLOAD';
  for (let i = 0; i < 5; i++) {
    eventlog.writeToolOutput({ sessionId: sess.id, callId: `call_bud_${i}`, tool: 't', output: `${SECRET}_${i} ` + 'p'.repeat(1000) });
  }

  const checks = [];
  const budget = new brackets.RecallBudget(3, 60_000);
  await brackets.withHarnessRunContext({ sessionId: sess.id, counter: null, recallBudget: budget }, async () => {
    for (let i = 0; i < 3; i++) {
      const body = textOf(await handlers.recall_tool_result({ call_id: `call_bud_${i}` }));
      checks.push({ ok: body.includes(`${SECRET}_${i}`), label: `recall ${i + 1}/3 within budget succeeds` });
    }
    const fourth = textOf(await handlers.recall_tool_result({ call_id: 'call_bud_3' }));
    checks.push({ ok: fourth.includes('recall budget exhausted') && !fourth.includes(SECRET), label: '4th recall blocked with clean error (no data leak)' });
  });

  // Byte budget: a tiny byte ceiling rejects an oversized slice cleanly.
  const byteBudget = new brackets.RecallBudget(10, 500);
  await brackets.withHarnessRunContext({ sessionId: sess.id, counter: null, recallBudget: byteBudget }, async () => {
    const body = textOf(await handlers.recall_tool_result({ call_id: 'call_bud_4' }));
    checks.push({ ok: body.includes('recall byte budget exhausted') && !body.includes(SECRET), label: 'byte-budget rejection is clean (no data leak)' });
  });

  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('recall-budget-enforced', '3-call cap + byte cap both fail clean, zero payload leakage');
  else fail('recall-budget-enforced', bad.map((b) => b.label).join('; '));
}

// ─── Probe 9 — batch validator blocks malformed writes ─────────────
//
// The pre-dispatch batch validator must reject incomplete batch items
// (the bad-data-write choke) and pass well-formed ones.

async function probeBatchValidatorBlocks(mods) {
  const { batchValidator } = mods;
  const checks = [];

  const badBatch = batchValidator.validateComposioBatchOperation('AIRTABLE_BATCH_UPDATE_RECORDS', {
    records: [{ id: 'rec1', fields: { Name: 'ok' } }, { id: 'rec2' }, {}],
  });
  checks.push({ ok: badBatch != null, label: 'malformed batch (missing fields/id) rejected pre-dispatch' });
  if (badBatch) {
    const msg = batchValidator.formatBatchValidationError(badBatch, 'AIRTABLE_BATCH_UPDATE_RECORDS');
    checks.push({ ok: typeof msg === 'string' && msg.includes('AIRTABLE_BATCH_UPDATE_RECORDS'), label: 'rejection carries actionable guidance' });
  }

  const goodBatch = batchValidator.validateComposioBatchOperation('AIRTABLE_BATCH_UPDATE_RECORDS', {
    records: [{ id: 'rec1', fields: { Name: 'ok' } }, { id: 'rec2', fields: { Name: 'also ok' } }],
  });
  checks.push({ ok: goodBatch == null, label: 'well-formed Airtable batch passes' });

  // Exact live shapes from harness.db — the canonical Sheets batch update
  // and the Outlook object-shaped updates must never be falsely blocked.
  const sheetsLive = batchValidator.validateComposioBatchOperation('GOOGLESHEETS_BATCH_UPDATE_VALUES', {
    spreadsheet_id: 'x', value_input_option: 'RAW',
    data: [{ range: 'Sheet1!A1:O16', values: [['Account Id', 'Website']] }],
  });
  checks.push({ ok: sheetsLive == null, label: 'live Sheets { range, values } shape passes' });
  const outlookLive = batchValidator.validateComposioBatchOperation('OUTLOOK_BATCH_UPDATE_MESSAGES', {
    user_id: 'me', message_ids: ['a', 'b'], updates: { isRead: true },
  });
  checks.push({ ok: outlookLive == null, label: 'live Outlook object-updates shape passes' });
  const sheetsNoTarget = batchValidator.validateComposioBatchOperation('GOOGLESHEETS_BATCH_UPDATE_VALUES', {
    data: [{ values: [['a']] }],
  });
  checks.push({ ok: sheetsNoTarget != null, label: 'Sheets item without range/id still blocked' });

  const nonBatch = batchValidator.validateComposioBatchOperation('OUTLOOK_SEND_EMAIL', { to: 'a@b.c' });
  checks.push({ ok: nonBatch == null, label: 'non-batch op not falsely blocked' });

  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('batch-validator-blocks-malformed', 'incomplete batch items blocked; clean batches pass');
  else fail('batch-validator-blocks-malformed', bad.map((b) => b.label).join('; '));
}

// ─── Probe — schema overrides heuristic (the future-proof loop) ────
//
// A brand-new toolkit whose batch items use a key no heuristic knows.
// Without a schema the heuristic blocks it; depositing the action's real
// schema (what composio_search_tools does as a side effect) flips the
// validator to schema-grounded and the same args pass. This is Clem's
// self-fix loop: block → fetch schema → retry passes. No code change
// needed for new toolkits, ever.

async function probeSchemaOverridesHeuristic(mods) {
  const { batchValidator, schemaCache } = mods;
  const checks = [];
  schemaCache.resetToolSchemaCache();

  const slug = 'FUTURETOOL_BATCH_UPDATE_GADGETS';
  const args = { items: [{ gadget_ref: 'g1', payload: { mode: 'on' } }] };

  // Step 1: unknown toolkit, heuristic engages and blocks (the false positive).
  const before = batchValidator.validateComposioArgs(slug, args, schemaCache.getCachedToolSchema(slug));
  checks.push({ ok: before.mode === 'heuristic' && before.error != null, label: 'unknown toolkit: heuristic blocks the unfamiliar shape' });
  if (before.error) {
    const msg = batchValidator.formatBatchValidationError(before.error, slug, before.mode);
    checks.push({ ok: msg.includes('composio_search_tools'), label: 'block message teaches the schema-fetch recovery path' });
  }

  // Step 2: the recovery action deposits the real schema (search/list side effect).
  schemaCache.rememberToolSchema(slug, {
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array', items: { type: 'object', required: ['gadget_ref', 'payload'] } } },
  });

  // Step 3: identical args now validate against the REAL schema and pass.
  const after = batchValidator.validateComposioArgs(slug, args, schemaCache.getCachedToolSchema(slug));
  checks.push({ ok: after.mode === 'schema' && after.error === null, label: 'after schema fetch: same args pass (self-healing loop closed)' });

  // Step 4: the schema still catches a genuinely broken item — precision, not leniency.
  const broken = batchValidator.validateComposioArgs(slug, { items: [{ gadget_ref: 'g1' }] }, schemaCache.getCachedToolSchema(slug));
  checks.push({ ok: broken.error != null && broken.error.reason.includes('payload'), label: 'schema mode still blocks a provably-incomplete item, naming the real field' });

  schemaCache.resetToolSchemaCache();
  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('schema-overrides-heuristic', 'block → schema fetch → pass; schema names real fields for true errors');
  else fail('schema-overrides-heuristic', bad.map((b) => b.label).join('; '));
}

// ─── Probe — live-shape corpus (self-updating regression net) ──────
//
// Invariant: any composio_execute_tool arg shape that EXECUTED
// SUCCESSFULLY in real production history must never be blocked by the
// heuristic validator (worst case: empty schema cache). Reads the real
// harness.db READ-ONLY; the corpus grows automatically as Clem uses new
// toolkits, so a future validator change that would re-introduce a
// false positive fails this probe the day it's written.

async function probeLiveShapeCorpus(mods) {
  const { batchValidator } = mods;
  const realDb = path.join(originalHome ?? os.homedir(), '.clementine-next', 'state', 'harness.db');
  if (!existsSync(realDb)) {
    pass('live-shape-corpus', 'no live harness.db on this machine — probe skipped (nothing to regress against)');
    return;
  }
  const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));
  const db = new Database(realDb, { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = db.prepare(
      `SELECT e.session_id AS sid, e.data_json AS dj FROM events e
        WHERE e.type = 'tool_called' AND e.data_json LIKE '%composio_execute_tool%'`,
    ).all();
  } finally { /* keep db open for output lookups below */ }

  const lookupOutput = db.prepare(
    'SELECT output_full FROM tool_outputs WHERE session_id = ? AND call_id = ?',
  );

  const seen = new Set();
  const blocked = [];
  let tested = 0, skippedNoOutcome = 0, skippedFailed = 0;
  for (const row of rows) {
    let slug, args, callId;
    try {
      const data = JSON.parse(row.dj);
      callId = data.callId;
      const outer = JSON.parse(data.arguments ?? data.args ?? 'null');
      slug = outer?.tool_slug;
      args = typeof outer?.arguments === 'string' ? JSON.parse(outer.arguments) : outer?.arguments;
    } catch { continue; }
    if (!slug || !args || typeof args !== 'object' || Array.isArray(args)) continue;

    // Only shapes that demonstrably SUCCEEDED bind the validator.
    const out = callId ? lookupOutput.get(row.sid, callId) : null;
    if (!out?.output_full) { skippedNoOutcome++; continue; }
    const text = out.output_full;
    if (text.includes('"successful": false') || text.includes('"successful":false') ||
        text.startsWith('⚠') || text.includes('validation failed before dispatch')) { skippedFailed++; continue; }

    // Dedup by slug + arg-key skeleton (including the key shape of the
    // first item of every array arg, so per-item variants like
    // {message_id, patch} vs {message_id, is_read} are tested separately).
    const itemShapes = Object.entries(args)
      .filter(([, v]) => Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0]))
      .map(([k, v]) => `${k}:[${Object.keys(v[0]).sort().join('|')}]`)
      .join(';');
    const skeleton = `${slug}::${Object.keys(args).sort().join(',')}::${itemShapes}`;
    if (seen.has(skeleton)) continue;
    seen.add(skeleton);

    tested++;
    const verdict = batchValidator.validateComposioArgs(slug, args, null); // worst case: no schema
    if (verdict.error) blocked.push(`${slug} (${verdict.error.field})`);
  }
  db.close();

  if (blocked.length === 0) {
    pass('live-shape-corpus', `${tested} distinct production-successful shapes, 0 falsely blocked (${skippedNoOutcome} no-outcome + ${skippedFailed} failed calls excluded)`);
  } else {
    fail('live-shape-corpus', `${blocked.length}/${tested} production-successful shapes would be blocked: ${blocked.slice(0, 5).join('; ')}`);
  }
}

// ─── Probe 10 — grounding search surfaces the write target ─────────
//
// The grounding gate verifies outgoing payloads against stored artifacts
// via searchToolOutputs. If the search can't find the artifact that
// mentions the recipient, the judge has nothing to check against.

async function probeGroundingSearchFindsTarget(mods) {
  const { eventlog, sessionMod } = mods;
  const sess = sessionMod.HarnessSession.create({ kind: 'chat', title: 'grounding probe' });
  eventlog.writeToolOutput({
    sessionId: sess.id, callId: 'call_src_1', tool: 'composio_execute_tool',
    output: JSON.stringify({ contact: { name: 'Dana Eley', email: 'dana.eley@client.example.com', city: 'Denver' } }),
  });
  eventlog.writeToolOutput({ sessionId: sess.id, callId: 'call_noise_1', tool: 't', output: 'unrelated noise '.repeat(50) });

  const hits = eventlog.searchToolOutputs(sess.id, ['dana.eley@client.example.com']);
  const checks = [
    { ok: hits.length === 1 && hits[0].callId === 'call_src_1', label: `target artifact found exactly (got ${hits.length} hits)` },
    { ok: (hits[0]?.output ?? '').includes('Denver'), label: 'artifact carries the ground-truth fields the judge needs' },
    { ok: eventlog.searchToolOutputs(sess.id, ['nobody@nowhere.example']).length === 0, label: 'unknown target returns zero artifacts (gate sees the gap)' },
  ];

  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) pass('grounding-search-finds-target', 'recipient artifact retrievable for the grounding judge');
  else fail('grounding-search-finds-target', bad.map((b) => b.label).join('; '));
}

// ─── Runner ────────────────────────────────────────────────────────

const SUB_TESTS = {
  'long-chat-byte-exact-recall': probeLongChatByteExactRecall,
  'cross-session-isolation': probeCrossSessionIsolation,
  'duplicate-callid-keeps-larger': probeDuplicateCallIdSemantics,
  'tail-truncation-warns-loud': probeTailTruncationWarns,
  'compaction-stubs-recallable': probeCompactionStubsRecallable,
  'hallucinated-callid-sanitized': probeHallucinatedCallIdSanitized,
  'ttl-reap-fails-loud': probeTtlReapFailsLoud,
  'recall-budget-enforced': probeRecallBudgetEnforced,
  'batch-validator-blocks-malformed': probeBatchValidatorBlocks,
  'schema-overrides-heuristic': probeSchemaOverridesHeuristic,
  'live-shape-corpus': probeLiveShapeCorpus,
  'grounding-search-finds-target': probeGroundingSearchFindsTarget,
};

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  console.log('verify-tool-recall-fidelity.mjs — probes');
  for (const name of Object.keys(SUB_TESTS)) console.log(`  - ${name}`);
  process.exit(0);
}
const only = argv.find((a) => a.startsWith('--only='))?.slice(7);
const names = only ? [only] : Object.keys(SUB_TESTS);
if (only && !SUB_TESTS[only]) {
  console.error(`unknown probe: ${only}`);
  process.exit(2);
}

console.log('Clementine tool-recall fidelity choke suite');
console.log(`  HOME=${tmpHome}`);

const mods = await loadMods();
for (const name of names) {
  section(name);
  try {
    await SUB_TESTS[name](mods);
  } catch (err) {
    fail(name, `threw: ${err?.stack?.split('\n').slice(0, 3).join(' | ') ?? err}`);
  }
}

const summaryPath = path.join(originalHome ?? os.homedir(), '.clementine-next', 'state', `verify-recall-fidelity-${Date.now()}.json`);
try {
  mkdirSync(path.dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\nsummary → ${summaryPath}`);
} catch {}

console.log(failures === 0 ? `\n${palette.green}green${palette.reset}` : `\n${palette.red}${failures} probe(s) failed${palette.reset}`);
process.exit(failures === 0 ? 0 : 1);
