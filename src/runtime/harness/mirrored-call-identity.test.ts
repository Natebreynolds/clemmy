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

/** A carrier running an inner tool, as the live Space read did: the carrier
 *  and the inner tool each store an output under the one call id. */
function carriedCallWithTwoOutputs(
  sessionId: string,
  callId: string,
  inner: string,
  presented: string,
  options: { parentedMirrorReturn?: boolean; dispatchLeaseId?: string } = {},
) {
  const lease = options.dispatchLeaseId ? { dispatchLeaseId: options.dispatchLeaseId } : {};
  const call = eventlog.appendEvent({
    sessionId, turn: 1, role: 'system', type: 'tool_called',
    data: { callId, accounting: 'top_level', tool: 'call_tool', effect: 'read', effectiveTool: 'space_get', ...lease },
  });
  const mirrorCall = eventlog.appendEvent({
    sessionId, turn: 1, role: 'system', type: 'tool_called',
    data: { callId, accounting: 'transport_mirror', tool: 'space_get' },
  });
  eventlog.writeToolOutput({ sessionId, callId, tool: 'space_get', output: inner, invocationNonce: `${callId}-inner` });
  eventlog.appendEvent({
    sessionId, turn: 1, role: 'system', type: 'tool_returned',
    ...(options.parentedMirrorReturn === false ? {} : { parentEventId: mirrorCall.id }),
    data: { callId, accounting: 'transport_mirror', tool: 'space_get', result: inner.slice(0, 40) },
  });
  eventlog.writeToolOutput({ sessionId, callId, tool: 'call_tool', output: presented, invocationNonce: `${callId}-carrier` });
  eventlog.appendEvent({
    sessionId, turn: 1, role: 'system', type: 'tool_returned', parentEventId: call.id,
    data: { callId, accounting: 'top_level', tool: 'call_tool', effect: 'read', effectiveTool: 'space_get', result: presented.slice(0, 40), ...lease },
  });
}

test('a carried call whose carrier and inner tool both stored output resolves to the complete inner bytes', () => {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'carried-two-outputs' });
  const inner = `Workspace "My Day" (my-day) — active. Dataset: ${'x'.repeat(4_000)} END-OF-INNER`;
  const presented = `${inner.slice(0, 1_000)}\n[clipped for presentation]`;
  carriedCallWithTwoOutputs(s.id, 'toolu_carried_pair', inner, presented);
  const resolved = eventlog.resolveToolOutputForAuthority(s.id, 'toolu_carried_pair');
  assert.equal(resolved.status, 'ok', JSON.stringify(resolved).slice(0, 300));
  if (resolved.status !== 'ok') return;
  assert.equal(resolved.record.tool, 'space_get');
  assert.match(resolved.record.output, /END-OF-INNER$/, 'the complete inner output, not the clipped presentation');
  assert.equal(resolved.effect, 'read');
});

test('a carried call resolves when its transport mirror return is unparented, as the host writes it', () => {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'carried-unparented-mirror' });
  const inner = `Workspace "My Day" (my-day) — active. Dataset: ${'y'.repeat(4_000)} END-OF-INNER`;
  carriedCallWithTwoOutputs(s.id, 'toolu_unparented_mirror', inner, `${inner.slice(0, 900)}\n[clipped]`, {
    parentedMirrorReturn: false, dispatchLeaseId: 'lease-host-owned',
  });
  const resolved = eventlog.resolveToolOutputForAuthority(s.id, 'toolu_unparented_mirror');
  assert.equal(resolved.status, 'ok', JSON.stringify(resolved).slice(0, 300));
  if (resolved.status !== 'ok') return;
  assert.equal(resolved.record.tool, 'space_get');
  assert.match(resolved.record.output, /END-OF-INNER$/);

  carriedCallWithTwoOutputs(s.id, 'toolu_unparented_no_host', inner, `${inner.slice(0, 900)}\n[clipped]`, { parentedMirrorReturn: false });
  assert.equal(eventlog.resolveToolOutputForAuthority(s.id, 'toolu_unparented_no_host').status, 'ambiguous',
    'without a host dispatch lease there is no canonical result to pair');
});

test('a mirror pair outside the carrier call window is not the carried pair', () => {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'mirror-outside-window' });
  const callId = 'toolu_mirror_outside';
  const mirrorCall = eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_called',
    data: { callId, accounting: 'transport_mirror', tool: 'space_get' },
  });
  eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_returned',
    data: { callId, accounting: 'transport_mirror', tool: 'space_get', result: 'earlier' },
  });
  void mirrorCall;
  const call = eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_called',
    data: { callId, accounting: 'top_level', tool: 'call_tool', effect: 'read', effectiveTool: 'space_get' },
  });
  eventlog.writeToolOutput({ sessionId: s.id, callId, tool: 'space_get', output: 'inner', invocationNonce: 'inner' });
  eventlog.writeToolOutput({ sessionId: s.id, callId, tool: 'call_tool', output: 'presented', invocationNonce: 'carrier' });
  eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_returned', parentEventId: call.id,
    data: { callId, accounting: 'top_level', tool: 'call_tool', effect: 'read', effectiveTool: 'space_get', result: 'presented' },
  });
  const resolved = eventlog.resolveToolOutputForAuthority(s.id, callId);
  assert.equal(resolved.status, 'ambiguous');
});

test('two outputs under one id without a provable carrier pair stay ambiguous', () => {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'unpaired-two-outputs' });
  const call = eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_called',
    data: { callId: 'toolu_unpaired', accounting: 'top_level', tool: 'call_tool', effect: 'read', effectiveTool: 'space_get' },
  });
  eventlog.writeToolOutput({ sessionId: s.id, callId: 'toolu_unpaired', tool: 'space_get', output: 'first', invocationNonce: 'n1' });
  eventlog.writeToolOutput({ sessionId: s.id, callId: 'toolu_unpaired', tool: 'space_get', output: 'second', invocationNonce: 'n2' });
  eventlog.appendEvent({
    sessionId: s.id, turn: 1, role: 'system', type: 'tool_returned', parentEventId: call.id,
    data: { callId: 'toolu_unpaired', accounting: 'top_level', tool: 'call_tool', effect: 'read', effectiveTool: 'space_get', result: 'x' },
  });
  const resolved = eventlog.resolveToolOutputForAuthority(s.id, 'toolu_unpaired');
  assert.equal(resolved.status, 'ambiguous', 'two outputs from the same tool are two invocations');
});
