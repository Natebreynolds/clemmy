/**
 * One invocation observed twice is still one invocation.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/mirrored-call-identity.test.ts
 *
 * Live 2026-09-07, source 146537 — the owner's Platform 49 Sheet-cleanup Plan.
 * Call toolu_01UYMgkwaEPRxRSFwo3QQqUS has ONE invocation nonce, ONE provider
 * dispatch (146623), ONE settlement (146641) and a complete 2,308-byte output.
 * Its lifecycle holds two correctly-parented pairs:
 *
 *   146611 tool_called   accounting=top_level        tool=work_call
 *   146617 tool_called   accounting=transport_mirror tool=composio_execute_tool
 *   146642 tool_returned accounting=transport_mirror
 *   146643 tool_returned accounting=top_level
 *
 * Occurrence counting treated that as two invocations, so every file_query on
 * the authentic result was rejected as "reused by 2 invocations" — eleven
 * times, asking the model for a fresh call id it cannot legitimately
 * manufacture. The Plan died at recovery_surface_mismatch, never written.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-mirror-identity-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'mirror-identity\n', 'utf8');

const eventlog = await import('./eventlog.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

/** The exact 146537 lifecycle: one logical call, a top-level pair and a mirror. */
function mirroredCall(sessionId: string, callId: string, turn = 1) {
  const call = eventlog.appendEvent({
    sessionId, turn, role: 'system', type: 'tool_called',
    data: { callId, accounting: 'top_level', tool: 'work_call',
      effect: 'read', effectiveTool: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION' },
  });
  const mirrorCall = eventlog.appendEvent({
    sessionId, turn, role: 'system', type: 'tool_called',
    data: { callId, accounting: 'transport_mirror', tool: 'composio_execute_tool', effect: 'read' },
  });
  eventlog.appendEvent({
    sessionId, turn, role: 'system', type: 'tool_returned',
    parentEventId: mirrorCall.id,
    data: { callId, accounting: 'transport_mirror', tool: 'composio_execute_tool', effect: 'read' },
  });
  const ret = eventlog.appendEvent({
    sessionId, turn, role: 'system', type: 'tool_returned',
    parentEventId: call.id,
    data: { callId, accounting: 'top_level', tool: 'work_call',
      effect: 'read', effectiveTool: 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION',
      result: 'the authentic 2308-byte payload' },
  });
  return { call, ret };
}

test('THE 146537 CASE: a mirrored call resolves to ONE occurrence', () => {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'mirrored' });
  mirroredCall(s.id, 'toolu_mirrored_one');
  const resolved = eventlog.resolveToolOutputForAuthority(s.id, 'toolu_mirrored_one');
  assert.notEqual(resolved.status, 'ambiguous',
    'the transport mirror is a second VIEW of one call, not a second call');
});

test('two genuine top-level invocations sharing an id still fail ambiguous', () => {
  // The property the counting was protecting. It must survive the fix.
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'genuine-reuse' });
  mirroredCall(s.id, 'toolu_really_reused', 1);
  mirroredCall(s.id, 'toolu_really_reused', 2);
  const resolved = eventlog.resolveToolOutputForAuthority(s.id, 'toolu_really_reused');
  assert.notEqual(resolved.status, 'ok',
    'two real invocations under one id remain ambiguous authority');
});

test('an unwrapped call with only one pair is unaffected', () => {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'unwrapped' });
  const call = eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_called',
    data: { callId: 'toolu_plain', accounting: 'top_level', tool: 'read_file', effect: 'read' },
  });
  eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_returned', parentEventId: call.id,
    data: { callId: 'toolu_plain', accounting: 'top_level', tool: 'read_file', effect: 'read', result: 'x' },
  });
  const resolved = eventlog.resolveToolOutputForAuthority(s.id, 'toolu_plain');
  assert.notEqual(resolved.status, 'ambiguous');
});

test('a MIRROR-ONLY lifecycle keeps its previous treatment', () => {
  // No top-level observation exists, so nothing is filtered and the existing
  // doctrine applies unchanged — the fix must not silently widen authority.
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'mirror-only' });
  const call = eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_called',
    data: { callId: 'toolu_mirror_only', accounting: 'transport_mirror', tool: 'composio_execute_tool', effect: 'read' },
  });
  eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_returned', parentEventId: call.id,
    data: { callId: 'toolu_mirror_only', accounting: 'transport_mirror', tool: 'composio_execute_tool', effect: 'read', result: 'x' },
  });
  const resolved = eventlog.resolveToolOutputForAuthority(s.id, 'toolu_mirror_only');
  assert.notEqual(resolved.status, 'ambiguous', 'one pair is one occurrence however it is labelled');
});

test('ONE invocation is never reported as a reuse', () => {
  // "was reused by 1 invocations; pass a fresh unique call id" was the literal
  // message the model looped on. Ambiguity means several invocations compete
  // for one id; a single invocation with unusable bytes is a different, honest
  // failure — and the model cannot mint a call id for a result the host stored.
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'one-is-not-reuse' });
  const call = eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_called',
    data: { callId: 'toolu_single', accounting: 'top_level', tool: 'work_call', effect: 'read' },
  });
  // A return whose identity deliberately disagrees with its call.
  eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_returned', parentEventId: call.id,
    data: { callId: 'toolu_single', accounting: 'top_level', tool: 'a_different_tool', effect: 'read', result: 'x' },
  });
  const resolved = eventlog.resolveToolOutputForAuthority(s.id, 'toolu_single');
  assert.notEqual(resolved.status, 'ambiguous', 'one invocation cannot be a reuse');
  if (resolved.status === 'ambiguous') return;
  assert.ok(['failed', 'missing'].includes(resolved.status),
    `expected an honest failure status, got ${resolved.status}`);
});

test('the LEGACY branch cannot claim a reuse either', () => {
  // The same Math.max(1, …) lived in two branches. Fixing only the nonce path
  // let "reused by 1 invocations" survive its first correction and reappear in
  // the Platform 49 baseline (2026-09-07, session 2053cb6f, calls
  // toolu_012wDr21bbK2HFqvnedvXJ2V and toolu_01DTJ8oLXWouekL4h6jnP3p6).
  // Both branches now share one decision.
  const src = readFileSync(new URL('./eventlog.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Math\.max\(1, lifecycle\./,
    'no branch may floor an invocation count to 1 and call it a reuse');
  const uses = src.match(/unusableAuthorityResolution\(/g) ?? [];
  assert.ok(uses.length >= 3,
    'one shared decision, used by both resolution branches (plus its definition)');
});
