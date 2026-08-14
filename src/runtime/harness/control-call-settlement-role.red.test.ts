/**
 * RED: settlement-side businessCall honesty for harness-control tools.
 *
 * The settlement wrapper flags every non-discovery call as business
 * (businessCall = "discovery classification == null"), so a registry-control
 * tool like focus_set persists as business work: it credits capability
 * progress and later counts as durable work evidence at the terminal
 * (live 2026-08-11). The registry already knows better — focus_set carries
 * actionTopologyRole 'control'.
 *
 * Invariant: a registry-control tool's persisted settlement must be
 * distinguishable as control (a typed role field, or businessCall false) so
 * evidence and progress queries can filter it, and a control call never
 * credits business progress.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-control-settlement-role-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-control-settlement-role\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const attempts = await import('./attempt-settlement.js');
const settlements = await import('./logical-call-settlement-store.js');
const registry = await import('../../tools/tool-registry.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function settleRegistryControlCall() {
  const session = eventlog.createSession({ id: `control-settlement-role-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: "What's on my plate today?" },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const toolName = 'focus_set';
  assert.equal(registry.actionTopologyRoleFor(toolName), 'control',
    'fixture uses a registry-control tool');
  const identity = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    logicalToolCallId: `toolu-settlement-role-${serial}`,
  };
  const args = { title: 'Plate check', detail: 'reviewing today' };
  const admitted = dispatch.admitLogicalCall({ identity, tool: toolName, args });
  assert.ok(
    admitted.status === 'inserted' || admitted.status === 'replayed',
    JSON.stringify(admitted),
  );
  const settled = attempts.settleToolAttempt({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    lane: 'agents_runner',
    toolName,
    callId: identity.logicalToolCallId,
    args,
    mutating: false,
    // The wrapper's predicate: not discovery ⇒ business. This is exactly the
    // input a settled focus_set receives in production today.
    businessCall: true,
    result: { successful: true, data: { focused: true } },
  });
  assert.equal(settled.outcome.kind, 'succeeded', JSON.stringify(settled.outcome));
  return { identity, settled };
}

test('a settled registry-control tool is persisted as control, not as business work', () => {
  const { identity } = settleRegistryControlCall();
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost(identity);
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  if (redeemed.status !== 'ok') return;
  const recovery = redeemed.settlement.recovery as
    typeof redeemed.settlement.recovery & { role?: string };
  assert.ok(
    recovery.role === 'control' || recovery.businessCall === false,
    'the durable settlement row for focus_set must be distinguishable as a '
    + 'control call so evidence queries can filter it — persisted recovery: '
    + JSON.stringify(redeemed.settlement.recovery),
  );
});

test('a successful control call never credits business capability progress', () => {
  const { settled } = settleRegistryControlCall();
  assert.equal(
    settled.creditedProgress,
    false,
    'succeeding at harness bookkeeping is not progress on the user\'s work',
  );
});
