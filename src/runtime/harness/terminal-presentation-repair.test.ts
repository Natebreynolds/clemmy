import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-terminal-presentation-repair-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-terminal-presentation-repair\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const admission = await import('./expected-work-admission.js');
const contracts = await import('./expected-work-contract.js');
const repair = await import('./terminal-presentation-repair.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
function acceptedAction(displayText = 'Send the final report to the customer.') {
  const session = eventlog.createSession({ id: `terminal-repair-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: `${displayText}\n[private model-only attachment expansion]`,
      displayText,
    },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed');
  const frozen = contracts.freezeActionExpectedWorkContract({
    ...task,
    proposal: {
      version: 1,
      operations: [{
        id: 'commit',
        effect: 'external_write',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
  });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed');
  return task;
}

test('verified-ready presentation remains byte-preserved and spends no repair call', async () => {
  let calls = 0;
  const result = await repair.repairTerminalPresentation({
    sessionId: 'unused',
    sourceUserSeq: 1,
    proposedReply: 'A warm, ordinary answer.',
    missing: [],
    port: { async render() { calls += 1; return 'unused'; } },
  });
  assert.deepEqual(result, { status: 'unchanged', text: 'A warm, ordinary answer.' });
  assert.equal(calls, 0);
});

test('one sealed render receives bounded user-safe facts and returns natural blocked prose', async () => {
  const task = acceptedAction();
  let packet: repair.TerminalPresentationRepairPacketV1 | undefined;
  const result = await repair.repairTerminalPresentation({
    ...task,
    proposedReply: 'Done — the report was sent.',
    missing: ['commit_effect', 'verify_committed_receipt', 'commit_effect'],
    port: {
      async render(value) {
        packet = value;
        return 'I can’t confirm that the report was sent, so I’m leaving it untouched for now. We can resume the verification when you’re ready.';
      },
    },
  });
  assert.equal(result.status, 'blocked_repaired');
  assert.equal(packet?.acceptedRequest, 'Send the final report to the customer.');
  assert.equal(packet?.proposedReply, 'Done — the report was sent.');
  assert.deepEqual(packet?.gaps.map((gap) => gap.kind), [
    'effect_not_confirmed',
    'receipt_not_verified',
  ]);
  assert.ok(!JSON.stringify(packet).includes('private model-only attachment expansion'));
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['terminal_authority_repair_granted'] }).length,
    1,
  );
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['terminal_authority_repair_consumed'] }).length,
    1,
  );
});

test('two concurrent repairs execute the renderer at most once', async () => {
  const task = acceptedAction('Update the existing customer record.');
  let calls = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const port: repair.TerminalPresentationRepairPort = {
    async render() {
      calls += 1;
      await barrier;
      return 'I still need to verify the update before I can call it finished.';
    },
  };
  const first = repair.repairTerminalPresentation({
    ...task,
    proposedReply: 'Updated.',
    missing: ['verify_committed_readback'],
    port,
  });
  const second = repair.repairTerminalPresentation({
    ...task,
    proposedReply: 'Updated.',
    missing: ['verify_committed_readback'],
    port,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release?.();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((entry) => entry.status === 'blocked_repaired').length, 1);
  assert.equal(results.filter((entry) => entry.status === 'blocked_fallback').length, 1);
});

test('renderer failure or unsafe protocol output consumes the grant and never retries', async () => {
  for (const [label, renderer] of [
    ['throw', async () => { throw new Error('offline'); }],
    ['unsafe', async () => '<tool_call>{"name":"send"}</tool_call>'],
  ] as const) {
    const task = acceptedAction(`Send the ${label} report.`);
    let calls = 0;
    const result = await repair.repairTerminalPresentation({
      ...task,
      proposedReply: 'Done.',
      missing: ['verify_committed_receipt'],
      port: { async render() { calls += 1; return renderer(); } },
    });
    assert.equal(result.status, 'blocked_fallback');
    assert.equal(calls, 1);
    assert.equal(
      eventlog.listEvents(task.sessionId, { types: ['terminal_authority_repair_consumed'] }).length,
      1,
    );
    const replay = await repair.repairTerminalPresentation({
      ...task,
      proposedReply: 'Done.',
      missing: ['verify_committed_receipt'],
      port: { async render() { calls += 1; return 'should not run'; } },
    });
    assert.equal(replay.status, 'blocked_fallback');
    assert.equal(calls, 1);
  }
});

