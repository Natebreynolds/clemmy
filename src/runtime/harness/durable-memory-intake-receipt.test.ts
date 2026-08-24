import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-host-receipt-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-memory-host-receipt\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const authority = await import('./accepted-task-authority.js');
const contracts = await import('./expected-work-contract.js');
const activation = await import('./action-expected-work-boundary.js');
const capture = await import('../../memory/auto-capture.js');
const memory = await import('../../memory/db.js');
const receipts = await import('./durable-memory-intake-receipt.js');
const delivery = await import('./delivery-committer.js');
const outcomes = await import('./turn-outcome.js');

test.after(() => {
  eventlog.closeEventLog();
  memory.closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function acceptActivatedMemoryAction(message: string, options: { capture?: boolean } = {}) {
  const session = eventlog.createSession({
    id: `memory-host-receipt-${process.pid}-${++serial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: message },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  }));
  assert.equal(authority.armAcceptedTaskAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).status, 'armed');
  assert.deepEqual(contracts.requireKnownExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }), { status: 'action_deferred' });
  assert.equal(activation.requireActionExpectedWorkActivation({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).status, 'action_active');
  const captured = options.capture === false
    ? null
    : capture.captureInteractionSignals({
        message,
        sessionId: session.id,
        sourceEventId: `user-source:${source.seq}`,
        occurredAt: source.createdAt,
      });
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    source,
    captured,
  };
}

function doneOutcome(task: ReturnType<typeof acceptActivatedMemoryAction>, text = 'Got it — I’ll remember that.') {
  const identity = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  };
  return {
    version: 2 as const,
    id: outcomes.turnOutcomeId(identity),
    identity,
    status: 'done' as const,
    resumable: false as const,
    presentation: { kind: 'answer' as const, text },
  };
}

test('exact memory intake receipt survives restart, replays, and atomically closes terminal authority', () => {
  const task = acceptActivatedMemoryAction(
    'Remember this: Cedar is Cedar-41. A natural acknowledgement is enough.',
  );
  assert.equal(task.captured?.queuedCandidateIds?.length, 1);
  const issued = receipts.issueDurableMemoryIntakeReceipt(task);
  assert.equal(issued.status, 'issued', JSON.stringify(issued));
  if (issued.status !== 'issued') throw new Error(issued.reason);
  assert.match(issued.receiptId, /^memory-intake:v1:[a-f0-9]{64}$/);
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['durable_memory_intake_receipt'] }).length,
    1,
  );
  let loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'manifested_verifying');
  assert.equal(loaded.status === 'ok' && loaded.authority.hostCompletionReceiptId, issued.receiptId);

  eventlog.closeEventLog();
  memory.closeMemoryDb();
  const redeemed = receipts.redeemDurableMemoryIntakeReceipt(task);
  assert.equal(redeemed.status, 'redeemed', JSON.stringify(redeemed));
  const replayed = receipts.issueDurableMemoryIntakeReceipt(task);
  assert.equal(replayed.status, 'replayed', JSON.stringify(replayed));
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['durable_memory_intake_receipt'] }).length,
    1,
  );

  const committed = delivery.commitTurnOutcome(doneOutcome(task));
  assert.equal(committed.presentation.status, 'done');
  loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'terminal');
  assert.equal(loaded.status === 'ok' && loaded.authority.terminalEventId, committed.event.id);
  const publication = eventlog.readAcceptedTaskTerminalPublication(task.sessionId, task.sourceUserSeq);
  assert.equal(publication.status, 'published', JSON.stringify(publication));
  assert.equal(publication.status === 'published' && publication.hostReceiptId, issued.receiptId);

  const replay = delivery.commitTurnOutcome(doneOutcome(task));
  assert.equal(replay.inserted, false);
  assert.equal(replay.event.id, committed.event.id);
});

test('a direct-reply graph cannot mint an action-only memory receipt', async () => {
  const { recordAcceptedSourceGraph } = await import('./record-accepted-source-graph.js');
  const { installTurnSemanticModelPort } = await import('../semantic-boundary/turn-semantic-port-registry.js');
  const session = eventlog.createSession({
    id: `memory-host-receipt-direct-${process.pid}-${++serial}`,
    kind: 'chat',
  });
  const message = 'Remember this: Marker is Value-18. Just confirm.';
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: message },
  });
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: {
          version: 1,
          relation: 'conversation',
          targetGoal: null,
          goal: null,
          work: null,
          slotAnswers: [],
          rationale: 'fixture',
        },
        modelIdentity: 'fixture/direct-reply',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });
  try {
    const recorded = await recordAcceptedSourceGraph({
      identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
      surface: 'direct',
      acceptedText: message,
    });
    assert.ok(recorded);
    assert.equal(recorded?.data.route, 'direct_reply');
    const armed = authority.requireAcceptedTaskAuthority({
      sessionId: session.id,
      sourceUserSeq: source.seq,
    });
    assert.equal(armed.expectedWorkRequired, false);
    const captured = capture.captureInteractionSignals({
      message,
      sessionId: session.id,
      sourceEventId: `user-source:${source.seq}`,
      occurredAt: source.createdAt,
    });
    assert.equal(captured.queuedCandidateIds?.length, 1);

    const prepared = receipts.prepareDurableMemoryIntakeHostCompletion({
      sessionId: session.id,
      sourceUserSeq: source.seq,
    });
    assert.equal(prepared.status, 'ineligible', JSON.stringify(prepared));
    assert.match('reason' in prepared ? prepared.reason : '', /not an action turn/);
    const loaded = authority.loadAcceptedTaskAuthority(session.id, source.seq);
    assert.equal(loaded.status === 'ok' && loaded.authority.state, 'armed');
    assert.equal(
      eventlog.listEvents(session.id, { types: ['durable_memory_intake_receipt'] }).length,
      0,
    );
  } finally {
    installTurnSemanticModelPort(null);
  }
});

test('missing intake and compound secondary work fail closed without binding host completion', () => {
  const missing = acceptActivatedMemoryAction(
    'Remember this: Cedar is Cedar-42. A natural acknowledgement is enough.',
    { capture: false },
  );
  const absent = receipts.prepareDurableMemoryIntakeHostCompletion(missing);
  assert.equal(absent.status, 'missing', JSON.stringify(absent));
  let loaded = authority.loadAcceptedTaskAuthority(missing.sessionId, missing.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'armed');

  const compound = acceptActivatedMemoryAction(
    'Remember this: Cedar is Cedar-43. Also summarize the launch plan. Just confirm.',
  );
  assert.ok((compound.captured?.queuedCandidateIds?.length ?? 0) > 0);
  const refused = receipts.prepareDurableMemoryIntakeHostCompletion(compound);
  assert.equal(refused.status, 'ineligible', JSON.stringify(refused));
  loaded = authority.loadAcceptedTaskAuthority(compound.sessionId, compound.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'armed');
  assert.equal(
    eventlog.listEvents(compound.sessionId, { types: ['durable_memory_intake_receipt'] }).length,
    0,
  );
});

test('candidate, receipt-row, and event tampering are refused and cannot close done', () => {
  const task = acceptActivatedMemoryAction(
    'Remember this: Cedar is Cedar-44. A natural acknowledgement is enough.',
  );
  const issued = receipts.issueDurableMemoryIntakeReceipt(task);
  assert.equal(issued.status, 'issued', JSON.stringify(issued));
  if (issued.status !== 'issued') throw new Error(issued.reason);

  assert.throws(() => eventlog.openEventLog().prepare(`
    UPDATE durable_memory_intake_receipts SET evidence_digest = ? WHERE receipt_id = ?
  `).run('f'.repeat(64), issued.receiptId), /immutable/);

  memory.openMemoryDb().prepare(`
    UPDATE memory_reflection_candidates
       SET text = text || ' tampered'
     WHERE session_id = ? AND call_id = ?
  `).run(task.sessionId, issued.receipt.memory.callId);
  const candidateTamper = receipts.redeemDurableMemoryIntakeReceipt(task);
  assert.equal(candidateTamper.status, 'conflict', JSON.stringify(candidateTamper));
  const committed = delivery.commitTurnOutcome(doneOutcome(task, 'Got it.'));
  assert.equal(committed.presentation.status, 'blocked');
  let loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'terminal');
  assert.equal(
    loaded.status === 'ok' && loaded.authority.terminalEventId,
    committed.event.id,
  );

  const eventTask = acceptActivatedMemoryAction(
    'Remember this: Cedar is Cedar-45. A natural acknowledgement is enough.',
  );
  const eventIssued = receipts.issueDurableMemoryIntakeReceipt(eventTask);
  assert.equal(eventIssued.status, 'issued', JSON.stringify(eventIssued));
  if (eventIssued.status !== 'issued') throw new Error(eventIssued.reason);
  eventlog.openEventLog().prepare(`
    UPDATE events SET data_json = json_set(data_json, '$.acceptedTaskId', 'task:tampered#1')
     WHERE id = ?
  `).run(eventIssued.receiptEventId);
  const eventTamper = receipts.redeemDurableMemoryIntakeReceipt(eventTask);
  assert.equal(eventTamper.status, 'conflict', JSON.stringify(eventTamper));
  assert.equal(
    eventlog.readAcceptedTaskTerminalPublication(eventTask.sessionId, eventTask.sourceUserSeq).status,
    'conflict',
  );
  loaded = authority.loadAcceptedTaskAuthority(eventTask.sessionId, eventTask.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'manifested_verifying');
});

function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (existsSync(file)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function raceChild(input: { ready: string; barrier: string; payload: string }) {
  const code = `
    import { existsSync, writeFileSync } from 'node:fs';
    const receipt = await import(process.env.CLEM_RECEIPT_MODULE_URL);
    const input = JSON.parse(process.env.CLEM_RECEIPT_INPUT);
    writeFileSync(process.env.CLEM_READY_FILE, 'ready');
    while (!existsSync(process.env.CLEM_BARRIER_FILE)) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    console.log(JSON.stringify(receipt.issueDurableMemoryIntakeReceipt(input)));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_RECEIPT_MODULE_URL: pathToFileURL(
        path.resolve('src/runtime/harness/durable-memory-intake-receipt.ts'),
      ).href,
      CLEM_RECEIPT_INPUT: input.payload,
      CLEM_READY_FILE: input.ready,
      CLEM_BARRIER_FILE: input.barrier,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (codeValue) => resolve({ code: codeValue, output }));
  });
}

test('concurrent host receipt issuers serialize to one issued row and one replay', async () => {
  const task = acceptActivatedMemoryAction(
    'Remember this: Cedar is Cedar-46. A natural acknowledgement is enough.',
  );
  const barrier = path.join(TMP_HOME, `memory-receipt-${serial}.release`);
  const readyOne = path.join(TMP_HOME, `memory-receipt-${serial}.one.ready`);
  const readyTwo = path.join(TMP_HOME, `memory-receipt-${serial}.two.ready`);
  const payload = JSON.stringify({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq });
  const one = raceChild({ ready: readyOne, barrier, payload });
  const two = raceChild({ ready: readyTwo, barrier, payload });
  await Promise.all([waitForFile(readyOne), waitForFile(readyTwo)]);
  writeFileSync(barrier, 'release');
  const results = await Promise.all([one, two]);
  for (const result of results) assert.equal(result.code, 0, result.output);
  const parsed = results.map((result) => {
    const line = result.output.split(/\r?\n/).find((entry) => /^\{"status":/.test(entry.trim()));
    assert.ok(line, result.output);
    return JSON.parse(line) as { status: string };
  });
  assert.deepEqual(parsed.map((result) => result.status).sort(), ['issued', 'replayed']);
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['durable_memory_intake_receipt'] }).length,
    1,
  );
  assert.equal(receipts.redeemDurableMemoryIntakeReceipt(task).status, 'redeemed');
});
