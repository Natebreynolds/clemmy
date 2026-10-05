import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
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
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
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
const sourceContexts = await import('./source-session-context.js');
const consolidation = await import('../../memory/durable-consolidation.js');
const destinations = await import('../../memory/memory-destination.js');
const facts = await import('../../memory/facts.js');
const temporal = await import('../../memory/temporal-memory.js');
const scopes = await import('../../memory/memory-scope.js');

test.after(() => {
  eventlog.closeEventLog();
  memory.closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function acceptedCaptureSource(source: import('./eventlog.js').EventRow) {
  return {
    authority: 'accepted_user_input' as const,
    sessionId: source.sessionId,
    eventId: source.id,
    seq: source.seq,
    role: source.role,
    type: source.type,
    data: source.data,
  };
}

/** Persist through the actual queue without scheduling an asynchronous provider
 * drain. Consumer tests deliberately control canonical outcomes below. */
function captureOffline(source: import('./eventlog.js').EventRow, message: string) {
  const sourceProvenance = acceptedCaptureSource(source);
  const input = { message, sessionId: source.sessionId, sourceEventId: `user-source:${source.seq}`,
    occurredAt: source.createdAt, sourceProvenance };
  if (!capture.isEligibleAutoCaptureSourceProvenance(sourceProvenance, input)) {
    return { candidates: [], queuedCandidateIds: [] as number[], episodeId: null };
  }
  const candidates = capture.selectAutoMemoryCandidates(message);
  const queued = consolidation.enqueueAutoCaptureCandidates({ ...input, candidates,
    origins: capture.automaticMemoryOriginsForCapture(input, candidates) });
  return { candidates, queuedCandidateIds: queued.candidateIds, episodeId: queued.episodeId };
}

/** Controlled consolidation result, separate from the production reviewer.
 * This exercises the receipt consumer against real canonical fact/scope/link
 * storage; pipeline semantic review and lease ownership have their own tests. */
function qualifyCaptured(task: ReturnType<typeof acceptActivatedMemoryAction>) {
  const db = memory.openMemoryDb();
  const result: number[] = [];
  for (const id of task.captured?.queuedCandidateIds ?? []) {
    const row = db.prepare('SELECT * FROM memory_reflection_candidates WHERE id = ?').get(id) as {
      destination_json: string; episode_id: string; source_uri: string; kind: import('../../memory/db.js').ConsolidatedFactKind };
    const original = destinations.parseAutomaticMemoryEnvelope(row.destination_json);
    const envelope = destinations.withAutomaticMemoryDecision(original, { durability: 'standing',
      claim: original.origin.claim, destination: 'kind_default', destinationSpans: [], reason: 'controlled consumer fixture' });
    const target = destinations.resolveAutomaticMemoryDestination(envelope);
    assert.equal(target.status, 'resolved');
    if (target.status !== 'resolved') throw new Error('fixture destination unresolved');
    const fact = scopes.withMemorySettledFor(target.scope, () => facts.rememberFact({ kind: row.kind,
      content: target.claimText, sessionId: task.sessionId }));
    scopes.stampMemoryScope('fact', fact.id, target.scope, {sessionId: task.sessionId});
    temporal.linkFactEvidence({ factId: fact.id, episodeId: row.episode_id, sourceUri: row.source_uri, excerpt: target.claimText });
    db.prepare("UPDATE memory_reflection_candidates SET destination_json = ?, status = 'promoted', resulting_fact_id = ? WHERE id = ?")
      .run(JSON.stringify(envelope), fact.id, id);
    result.push(fact.id);
  }
  return result;
}

test('an old unresolved-reference intake cannot tell the brain that the actual correction is already captured', async () => {
  const message = 'Correction for this project Orchard: the heading is INDIGO MEADOW, replacing COPPER HORIZON. The footnote CHARTER LAMP stays unchanged. Remember the correction only here in this project, and confirm both current conventions.';
  const session = eventlog.createSession({ id: `memory-reference-receipt-${process.pid}-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: message } });
  const { enqueueAutoCaptureCandidates } = await import('../../memory/durable-consolidation.js');
  const queued = enqueueAutoCaptureCandidates({ message, sessionId: session.id, sourceEventId: `user-source:${source.seq}`,
    candidates: [{ kind: 'project', content: 'the correction only here in this project, and confirm both current conventions.',
      reason: 'explicit remember request' }] });
  assert.equal(queued.candidateIds.length, 1, 'fixture recreates the old durable intake without running its drain');
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  assert.equal(receipts.verifiedMemoryIntakeContext(identity), null);
  assert.equal(receipts.verifiedMemoryConsolidationEvidence(identity), null);
  assert.notEqual(receipts.prepareDurableMemoryIntakeHostCompletion(identity).status, 'redeemed');
  assert.ok(capture.explicitMemoryInstructionFor(message), 'normal memory intent remains available');
  const persisted = eventlog.listEvents(session.id, { types: ['user_input_received'] }).find(row => row.seq === source.seq);
  assert.equal(persisted?.data.text, message, 'the original correction and unchanged convention are not rewritten');
});

function acceptActivatedMemoryAction(
  message: string,
  options: { capture?: boolean; sourceData?: Record<string, unknown> } = {},
) {
  const session = eventlog.createSession({
    id: `memory-host-receipt-${process.pid}-${++serial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: message, ...(options.sourceData ?? {}) },
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
  sourceContexts.captureFreshSourceSessionContext({ sessionId: session.id, sourceUserSeq: source.seq });
  const captured = options.capture === false
    ? null
    : captureOffline(source, message);
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
  qualifyCaptured(task);
  const issued = receipts.issueDurableMemoryIntakeReceipt(task);
  assert.equal(issued.status, 'issued', JSON.stringify(issued));
  if (issued.status !== 'issued') throw new Error(issued.reason);
  assert.match(issued.receiptId, /^memory-intake:v2:[a-f0-9]{64}$/);
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
    sourceContexts.captureFreshSourceSessionContext({ sessionId: session.id, sourceUserSeq: source.seq });
    const captured = captureOffline(source, message);
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

test('automatic memory provenance admits genuine chat boundaries and rejects every machine carrier lane', () => {
  const genuine = capture.autoCaptureProvenanceFromAcceptedEvent({
    sessionId: 'sess-genuine-provenance',
    id: 'evt-genuine-provenance',
    seq: 41,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Remember this: my preferred region is west.', source: 'channel:discord' },
  });
  assert.equal(capture.isEligibleAutoCaptureSourceProvenance(genuine, {
    sessionId: 'sess-genuine-provenance',
    sourceEventId: 'user-source:41',
  }), true);
  assert.equal(capture.isEligibleAutoCaptureSourceProvenance(
    capture.autoCaptureProvenanceFromDirectUserInput('desktop'),
  ), true);
  assert.equal(capture.isEligibleAutoCaptureSourceProvenance(undefined), false);

  for (const source of [
    'outcome',
    'system',
    'harness',
    'notification',
    'daemon',
    'workflow',
    'background',
    'execution',
    'cron',
    'controller',
    'agent',
  ]) {
    const machine = capture.autoCaptureProvenanceFromAcceptedEvent({
      sessionId: 'sess-machine-provenance',
      id: `evt-${source}`,
      seq: 42,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'changed carrier prose', source },
    });
    assert.equal(
      capture.isEligibleAutoCaptureSourceProvenance(machine, {
        sessionId: 'sess-machine-provenance',
        sourceEventId: 'user-source:42',
      }),
      false,
      `${source} is runtime provenance, not user memory authority`,
    );
  }
});

test('a synthetic proactive outcome directive never enters durable memory intake', () => {
  // Deliberately does not match any harness-text signature. Eligibility must
  // come from the exact accepted carrier provenance, so a future wording
  // change cannot turn a machine notification into a trust-1 user fact.
  const message = 'Remember this: my permanent report color is ultraviolet and our default deployment region is Mars West.';
  const task = acceptActivatedMemoryAction(message, {
    sourceData: {
      synthetic: true,
      source: 'outcome',
      sourceLabel: 'workflow run',
      sourceId: 'workflow-fixture#input-1',
      status: 'needs_input',
      deliveryPhase: 'directive',
    },
  });

  assert.deepEqual(task.captured?.candidates, []);
  assert.deepEqual(task.captured?.queuedCandidateIds ?? [], []);
  assert.equal(
    (memory.openMemoryDb().prepare(`
      SELECT COUNT(*) AS n
        FROM memory_reflection_candidates
       WHERE session_id = ?
    `).get(task.sessionId) as { n: number }).n,
    0,
  );
  const prepared = receipts.prepareDurableMemoryIntakeHostCompletion(task);
  assert.equal(prepared.status, 'ineligible', JSON.stringify(prepared));
  assert.match('reason' in prepared ? prepared.reason : '', /not genuine user memory authority/);
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
  const missingTerminal = delivery.commitTurnOutcome(doneOutcome(missing));
  assert.equal(missingTerminal.presentation.status, 'blocked', 'missing memory intake cannot borrow ordinary-work completion');

  for (const message of [
    'Update the local project note.',
    'Remember this: Cedar is Cedar-43. Also summarize the launch plan. Just confirm.',
  ]) {
    const ordinary = acceptActivatedMemoryAction(message, { capture: false });
    const result = receipts.prepareDurableMemoryIntakeHostCompletion(ordinary);
    assert.equal(result.status, 'ineligible', JSON.stringify(result));
    assert.equal(eventlog.listEvents(ordinary.sessionId, { types: ['durable_memory_intake_receipt'] }).length, 0);
    loaded = authority.loadAcceptedTaskAuthority(ordinary.sessionId, ordinary.sourceUserSeq);
    assert.equal(loaded.status === 'ok' && loaded.authority.state, 'armed', 'ordinary work keeps its separate evidence contract');
  }

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
  qualifyCaptured(task);
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
  qualifyCaptured(eventTask);
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
  qualifyCaptured(task);
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


test('multiline accepted memory binds raw graph bytes while preserving normalized intake evidence', () => {
  const task = acceptActivatedMemoryAction(
    'Remember this: Cedar is Cedar-41.\n\nA natural acknowledgement is enough.',
  );
  assert.equal(task.captured?.queuedCandidateIds?.length, 1);
  qualifyCaptured(task);
  const issued = receipts.issueDurableMemoryIntakeReceipt(task);
  assert.equal(issued.status, 'issued', JSON.stringify(issued));
  eventlog.closeEventLog();
  memory.closeMemoryDb();
  assert.equal(receipts.redeemDurableMemoryIntakeReceipt(task).status, 'redeemed');
});


test('a pure remember request needs no special acknowledgement wording, but secondary work stays ineligible', () => {
  const pure = acceptActivatedMemoryAction('Remember this: my durable harness marker is AUTO-CAPTURE-ACK-42.');
  qualifyCaptured(pure);
  assert.equal(receipts.issueDurableMemoryIntakeReceipt(pure).status, 'issued');
  const compound = acceptActivatedMemoryAction('Remember this: my durable harness marker is AUTO-CAPTURE-ACK-42. Then analyze these 50 deals.');
  assert.equal(receipts.issueDurableMemoryIntakeReceipt(compound).status, 'ineligible');
});

function assertUnbound(task: ReturnType<typeof acceptActivatedMemoryAction>) {
  const loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'armed');
  assert.equal(loaded.status === 'ok' && loaded.authority.hostCompletionReceiptId, undefined);
  assert.deepEqual(eventlog.openEventLog().prepare('SELECT host_completion_receipt_id, host_completion_event_id FROM accepted_task_authority WHERE session_id = ? AND source_user_seq = ?')
    .get(task.sessionId, task.sourceUserSeq), {host_completion_receipt_id:null,host_completion_event_id:null});
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) n FROM durable_memory_intake_receipts WHERE session_id = ? AND source_user_seq = ?')
    .get(task.sessionId, task.sourceUserSeq) as { n: number }).n, 0);
}

test('pending intake survives reopen without occupying completion, then exact qualified facts can issue V2', () => {
  const task = acceptActivatedMemoryAction('Remember this: the receipt fixture marker is MARBLE FINCH. Just confirm.');
  const pendingRows = memory.openMemoryDb().prepare('SELECT id, destination_json FROM memory_reflection_candidates WHERE session_id = ?')
    .all(task.sessionId);
  assert.ok(receipts.verifiedMemoryIntakeContext(task));
  assert.equal(receipts.verifiedMemoryConsolidationEvidence(task)?.[0]?.verified, false);
  assert.notEqual(receipts.prepareDurableMemoryIntakeHostCompletion(task).status, 'redeemed');
  assertUnbound(task);
  eventlog.closeEventLog(); memory.closeMemoryDb();
  assert.ok(receipts.verifiedMemoryIntakeContext(task), 'pending original-source context remains reconstructible');
  assert.notEqual(receipts.prepareDurableMemoryIntakeHostCompletion(task).status, 'redeemed');
  assertUnbound(task);
  assert.deepEqual(memory.openMemoryDb().prepare('SELECT id, destination_json FROM memory_reflection_candidates WHERE session_id = ?').all(task.sessionId), pendingRows);
  qualifyCaptured(task);
  const prepared = receipts.prepareDurableMemoryIntakeHostCompletion(task);
  assert.equal(prepared.status, 'redeemed', JSON.stringify(prepared));
  if (prepared.status !== 'redeemed') throw new Error('expected V2');
  assert.equal(prepared.receipt.protocol, 2);
  assert.equal(prepared.receipt.candidates[0]?.destination.envelope.origin.source.eventId, task.source.id);
  assert.equal(prepared.receipt.candidates[0]?.destination.envelope.origin.source.context?.sourceUserSeq, task.sourceUserSeq);
  assert.equal(prepared.receipt.candidates[0]?.fact.active, true);
  assert.deepEqual(prepared.receipt.candidates.map(row => row.id), (pendingRows as Array<{id:number}>).map(row => row.id), 'promotion keeps original candidate identity');
});

for (const defect of ['pending-decision', 'wrong-scope', 'inactive-fact', 'missing-link', 'foreign-link', 'changed-source-context', 'legacy-origin'] as const) {
  test(`canonical automatic completion refuses ${defect} without occupying authority`, () => {
    const task = acceptActivatedMemoryAction(`Remember this: the ${defect} fixture marker is ROSE QUARTZ. Just confirm.`);
    const [factId] = qualifyCaptured(task);
    assert.ok(factId);
    const db = memory.openMemoryDb();
    const candidateId = task.captured!.queuedCandidateIds[0]!;
    if (defect === 'pending-decision') {
      const row = db.prepare('SELECT destination_json FROM memory_reflection_candidates WHERE id = ?').get(candidateId) as {destination_json:string};
      const envelope = destinations.parseAutomaticMemoryEnvelope(row.destination_json);
      db.prepare('UPDATE memory_reflection_candidates SET destination_json = ? WHERE id = ?')
        .run(JSON.stringify(destinations.createAutomaticMemoryEnvelope(envelope.origin)), candidateId);
    } else if (defect === 'wrong-scope') scopes.stampMemoryScope('fact', factId, {projectId:'unrelated-project',agentKey:null});
    else if (defect === 'inactive-fact') db.prepare('UPDATE consolidated_facts SET active = 0 WHERE id = ?').run(factId);
    else if (defect === 'missing-link') db.prepare('DELETE FROM fact_evidence WHERE fact_id = ?').run(factId);
    else if (defect === 'foreign-link') db.prepare('UPDATE fact_evidence SET source_uri = ? WHERE fact_id = ?').run('conversation://foreign/turn', factId);
    else if (defect === 'legacy-origin') db.prepare('UPDATE memory_reflection_candidates SET destination_json = NULL WHERE id = ?').run(candidateId);
    else {
      // Source bytes can remain identical while the stored origin falsely
      // claims a different frozen scope for the same accepted source.
      const row = db.prepare('SELECT destination_json FROM memory_reflection_candidates WHERE id = ?').get(candidateId) as {destination_json:string};
      const envelope = destinations.parseAutomaticMemoryEnvelope(row.destination_json);
      const origin = destinations.createAutomaticMemoryOrigin({ candidate: envelope.origin.candidate, claim: envelope.origin.claim, claimMode: envelope.origin.claimMode, source: { ...envelope.origin.source,
        context: { ...envelope.origin.source.context!, memoryScope: {projectId:'substituted-project',agentKey:null} } } });
      db.prepare('UPDATE memory_reflection_candidates SET destination_json = ? WHERE id = ?')
        .run(JSON.stringify(destinations.withAutomaticMemoryDecision(destinations.createAutomaticMemoryEnvelope(origin), envelope.decision!)), candidateId);
    }
    assert.notEqual(receipts.prepareDurableMemoryIntakeHostCompletion(task).status, 'redeemed');
    assert.notEqual(receipts.verifiedMemoryConsolidationEvidence(task)?.[0]?.verified, true);
    assertUnbound(task);
    assert.equal(delivery.commitTurnOutcome(doneOutcome(task)).presentation.status, 'blocked', 'unqualified memory cannot fall through as conversation');
  });
}

test('missing canonical scope store cannot be interpreted as an everywhere fact', () => {
  const task = acceptActivatedMemoryAction('Remember this: the missing scope table marker is PEARL RIDGE. Just confirm.');
  qualifyCaptured(task);
  const db = memory.openMemoryDb();
  db.exec('SAVEPOINT receipt_scope_store');
  try {
    db.exec('DROP TABLE memory_scopes');
    assert.notEqual(receipts.prepareDurableMemoryIntakeHostCompletion(task).status, 'redeemed');
    assert.equal(receipts.verifiedMemoryConsolidationEvidence(task), null);
    assertUnbound(task);
  } finally { db.exec('ROLLBACK TO receipt_scope_store; RELEASE receipt_scope_store'); }
});

test('fact or destination drift after immutable issuance blocks redemption without rewriting the receipt', () => {
  const task = acceptActivatedMemoryAction('Remember this: the immutable receipt marker is CLOUD PINE. Just confirm.');
  const [factId] = qualifyCaptured(task);
  const issued = receipts.issueDurableMemoryIntakeReceipt(task);
  assert.equal(issued.status, 'issued');
  const before = eventlog.openEventLog().prepare('SELECT * FROM durable_memory_intake_receipts WHERE session_id = ?').get(task.sessionId);
  memory.openMemoryDb().prepare("UPDATE consolidated_facts SET content = content || ' revised' WHERE id = ?").run(factId);
  assert.equal(receipts.redeemDurableMemoryIntakeReceipt(task).status, 'conflict');
  assert.deepEqual(eventlog.openEventLog().prepare('SELECT * FROM durable_memory_intake_receipts WHERE session_id = ?').get(task.sessionId), before);
  assert.equal(delivery.commitTurnOutcome(doneOutcome(task)).presentation.status, 'blocked');
});

function canonicalTestJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalTestJson(object[key])}`).join(',')}}`;
}

/** Historical fixture only: translate an actual exact-source V2 row to the
 * immutable V1 shape issued by the previous binary. Restore every trigger. */
function historicalV1(task: ReturnType<typeof acceptActivatedMemoryAction>) {
  const db = eventlog.openEventLog();
  const row = db.prepare('SELECT * FROM durable_memory_intake_receipts WHERE session_id = ?').get(task.sessionId) as Record<string, string | number>;
  const receipt = JSON.parse(String(row.receipt_json)) as import('./durable-memory-intake-receipt.js').DurableMemoryIntakeReceiptV2;
  const candidates = receipt.candidates.map(({destination: _destination, fact: _fact, ...intake}) => intake);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const candidateDigest = hash(canonicalTestJson(candidates));
  const evidenceDigest = hash(canonicalTestJson({sourceEventId:receipt.source.eventId, sourceMessageDigest:receipt.source.messageDigest,
    episodeId:receipt.memory.episodeId, callId:receipt.memory.callId, episodeContentHash:receipt.memory.episodeContentHash, candidateDigest}));
  const old = {...receipt, protocol:1, candidates, candidateDigest, evidenceDigest};
  const receiptJson = canonicalTestJson(old);
  const receiptId = `memory-intake:v1:${hash(receiptJson)}`;
  db.transaction(() => {
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('accepted_task_authority', 'durable_memory_intake_receipts')").all() as Array<{name:string;sql:string}>;
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
    db.prepare('UPDATE durable_memory_intake_receipts SET receipt_id=?, protocol_version=1, candidate_digest=?, evidence_digest=?, receipt_json=? WHERE session_id=?')
      .run(receiptId,candidateDigest,evidenceDigest,receiptJson,task.sessionId);
    db.prepare('UPDATE events SET data_json=? WHERE id=?').run(JSON.stringify({sourceUserSeq:task.sourceUserSeq,acceptedTaskId:receipt.identity.acceptedTaskId,receiptId,receipt:old}),row.receipt_event_id);
    db.prepare('UPDATE accepted_task_authority SET manifest_id=?, host_completion_receipt_id=? WHERE session_id=?').run(receiptId,receiptId,task.sessionId);
    for (const trigger of triggers) db.exec(trigger.sql);
  })();
  return receiptId;
}

test('historical V1 remains readable but cannot authorize a new done publication', () => {
  const historical = acceptActivatedMemoryAction('Remember this: the old published marker is QUARTZ ROBIN. Just confirm.');
  qualifyCaptured(historical);
  assert.equal(receipts.issueDurableMemoryIntakeReceipt(historical).status,'issued');
  const published = delivery.commitTurnOutcome(doneOutcome(historical));
  assert.equal(published.presentation.status,'done');
  const oldId = historicalV1(historical);
  eventlog.closeEventLog(); memory.closeMemoryDb();
  const read = eventlog.readAcceptedTaskTerminalPublication(historical.sessionId,historical.sourceUserSeq);
  assert.equal(read.status,'published',JSON.stringify(read));
  assert.equal(read.status === 'published' && read.hostReceiptId,oldId);
  assert.notEqual(receipts.redeemDurableMemoryIntakeReceipt(historical).status,'redeemed');

  const unfinished = acceptActivatedMemoryAction('Remember this: the old unfinished marker is CEDAR FINCH. Just confirm.');
  qualifyCaptured(unfinished);
  assert.equal(receipts.issueDurableMemoryIntakeReceipt(unfinished).status,'issued');
  historicalV1(unfinished);
  assert.notEqual(receipts.prepareDurableMemoryIntakeHostCompletion(unfinished).status,'redeemed');
  const completion = delivery.commitTurnOutcome(doneOutcome(unfinished));
  assert.equal(completion.presentation.status,'blocked');
  assert.equal(eventlog.readAcceptedTaskTerminalPublication(unfinished.sessionId,unfinished.sourceUserSeq).status,'published', 'legacy non-done closure remains readable');
});

test('receipt intake replays producer admission for overlapping heuristic labels and repeated distinct claims', () => {
  const cases = [
    {message:'I prefer Clementine to be concise, and the assistant should always preserve project context.', expected:1, overlapping:true},
    {message:'Remember this: Cedar is Cedar-57. Remember this: Cedar is Cedar-57.', expected:2, overlapping:false},
  ];
  for (const fixture of cases) {
    const session = eventlog.createSession({id:`memory-admission-span-${process.pid}-${++serial}`,kind:'chat'});
    const source = eventlog.appendEvent({sessionId:session.id,turn:1,role:'user',type:'user_input_received',data:{text:fixture.message}});
    sourceContexts.captureFreshSourceSessionContext({sessionId:session.id,sourceUserSeq:source.seq});
    if (fixture.overlapping) assert.ok(capture.extractAutoMemoryCandidates(fixture.message).length > fixture.expected,
      'control activates different heuristics for one original claim span');
    const captured = captureOffline(source,fixture.message);
    assert.equal(captured.queuedCandidateIds.length,fixture.expected);
    const identity = {sessionId:session.id,sourceUserSeq:source.seq};
    assert.ok(receipts.verifiedMemoryIntakeContext(identity), 'consumer uses producer-selected identities rather than heuristic labels');
    const evidence = receipts.verifiedMemoryConsolidationEvidence(identity);
    assert.equal(evidence?.length,fixture.expected);
    assert.ok(evidence?.every(row => row.status === 'pending' && !row.verified));
    if (!fixture.overlapping) {
      const rows = memory.openMemoryDb().prepare('SELECT candidate_hash,destination_json FROM memory_reflection_candidates WHERE session_id=? ORDER BY id')
        .all(session.id) as Array<{candidate_hash:string;destination_json:string}>;
      assert.notEqual(rows[0]!.candidate_hash,rows[1]!.candidate_hash);
      assert.notDeepEqual(destinations.parseAutomaticMemoryEnvelope(rows[0]!.destination_json).origin.claim,
        destinations.parseAutomaticMemoryEnvelope(rows[1]!.destination_json).origin.claim);
    }
  }
});

test('same-content reinforcement and additive corroboration preserve the immutable receipt, but its original evidence is required', () => {
  const task = acceptActivatedMemoryAction('Remember this: the reinforced receipt marker is LARK BIRCH. Just confirm.');
  const [factId] = qualifyCaptured(task);
  const issued = receipts.issueDurableMemoryIntakeReceipt(task);
  assert.equal(issued.status,'issued');
  if (issued.status !== 'issued') throw new Error('fixture did not qualify');
  const before = eventlog.openEventLog().prepare('SELECT * FROM durable_memory_intake_receipts WHERE session_id=?').get(task.sessionId);
  const db = memory.openMemoryDb();
  db.prepare("UPDATE consolidated_facts SET updated_at='2030-01-01T00:00:00.000Z', score=score+0.1 WHERE id=?").run(factId);
  const originalLink = db.prepare('SELECT excerpt FROM fact_evidence WHERE fact_id=? AND episode_id=? AND ordinal=0')
    .get(factId,issued.receipt.memory.episodeId) as {excerpt:string};
  temporal.linkFactEvidence({factId:factId!,episodeId:issued.receipt.memory.episodeId,sourceUri:issued.receipt.memory.sourceUri,
    ordinal:0,excerpt:originalLink.excerpt});
  // Force a distinct incidental clock value even if the calls share a millisecond.
  db.prepare("UPDATE fact_evidence SET created_at='2030-01-01T00:00:00.000Z' WHERE fact_id=? AND episode_id=? AND ordinal=0")
    .run(factId,issued.receipt.memory.episodeId);
  temporal.linkFactEvidence({factId:factId!,episodeId:issued.receipt.memory.episodeId,sourceUri:issued.receipt.memory.sourceUri,
    ordinal:2,excerpt:'Additional corroboration for the same owner-source claim.'});
  eventlog.closeEventLog(); memory.closeMemoryDb();
  const redeemed = receipts.redeemDurableMemoryIntakeReceipt(task);
  assert.equal(redeemed.status,'redeemed',JSON.stringify(redeemed));
  assert.equal(redeemed.status === 'redeemed' && redeemed.receiptId,issued.receiptId);
  assert.deepEqual(redeemed.status === 'redeemed' && redeemed.receipt,issued.receipt);
  const replay = receipts.issueDurableMemoryIntakeReceipt(task);
  assert.equal(replay.status,'replayed',JSON.stringify(replay));
  assert.deepEqual(eventlog.openEventLog().prepare('SELECT * FROM durable_memory_intake_receipts WHERE session_id=?').get(task.sessionId),before);
  memory.openMemoryDb().prepare('DELETE FROM fact_evidence WHERE fact_id=? AND episode_id=? AND ordinal=0')
    .run(factId,issued.receipt.memory.episodeId);
  assert.equal(receipts.redeemDurableMemoryIntakeReceipt(task).status,'conflict','a different/additional source link cannot replace the issued evidence');
});

test('one memory snapshot cannot combine a prior fact with a concurrent scope write; redemption observes the later drift', () => {
  const task = acceptActivatedMemoryAction('Remember this: the snapshot marker is WILLOW COVE. Just confirm.');
  const [factId] = qualifyCaptured(task);
  const db = memory.openMemoryDb();
  const peer = new Database(db.name);
  const originalPrepare = db.prepare;
  let changed = false;
  db.prepare = function (sql: string) {
    const statement = originalPrepare.call(db, sql);
    if (sql === 'SELECT id, content, active, updated_at FROM consolidated_facts WHERE id = ?') {
      const read = statement.get.bind(statement);
      statement.get = (...args: unknown[]) => {
        const value = read(...args);
        if (!changed) {
          changed = true;
          peer.prepare(`INSERT INTO memory_scopes
            (target_kind,target_id,scope_project_id,scope_agent_key,source_session_id,stamped_by,stamped_at)
            VALUES ('fact',?,'concurrent-project',NULL,?,'owner',?)`).run(String(factId),task.sessionId,new Date().toISOString());
        }
        return value;
      };
    }
    return statement;
  } as typeof db.prepare;
  let issued: ReturnType<typeof receipts.issueDurableMemoryIntakeReceipt>;
  try { issued = receipts.issueDurableMemoryIntakeReceipt(task); }
  finally { db.prepare = originalPrepare; peer.close(); }
  assert.equal(changed,true);
  assert.equal(issued!.status,'issued',JSON.stringify(issued));
  if (issued!.status !== 'issued') throw new Error('snapshot should contain pre-change source/fact/scope');
  assert.deepEqual(issued!.receipt.candidates[0]!.fact.scope,{projectId:null,agentKey:null});
  assert.notEqual(receipts.redeemDurableMemoryIntakeReceipt(task).status,'redeemed','new read observes concurrent scope drift');
  assert.equal(delivery.commitTurnOutcome(doneOutcome(task)).presentation.status,'blocked');
});

test('bounded episode excerpts preserve full long-source claim and canonical storage evidence', () => {
  const claim = `the standing handbook paragraph is ${'a precise convention with all its conditions retained, '.repeat(48)}and the mandatory final marker is GLASS HERON`;
  const task = acceptActivatedMemoryAction(`Remember this: ${claim}.`);
  assert.ok(claim.length > 2000);
  const db = memory.openMemoryDb();
  const row = db.prepare('SELECT text,destination_json,episode_id FROM memory_reflection_candidates WHERE session_id=?')
    .get(task.sessionId) as {text:string;destination_json:string;episode_id:string};
  assert.equal(row.text,`${claim}.`);
  const episode = db.prepare('SELECT evidence_excerpt FROM memory_episodes WHERE id=?').get(row.episode_id) as {evidence_excerpt:string};
  assert.equal(episode.evidence_excerpt.length,2000);
  const origin = destinations.parseAutomaticMemoryEnvelope(row.destination_json).origin;
  assert.equal(origin.source.ownerText,task.source.data.text);
  assert.ok(origin.source.ownerText.slice(origin.claim.start,origin.claim.end).endsWith('GLASS HERON.'));
  assert.ok(receipts.verifiedMemoryIntakeContext(task));
  qualifyCaptured(task);
  const evidence = receipts.verifiedMemoryConsolidationEvidence(task);
  assert.equal(evidence?.[0]?.verified,true);
  assert.equal(evidence?.[0]?.fact?.content,`${claim}.`);
  assert.equal(evidence?.[0]?.fact?.contentComplete,true);
  assert.notEqual(receipts.prepareDurableMemoryIntakeHostCompletion(task).status,'redeemed',
    'bounded storage proof does not expand the separate acknowledgement-only completion contract');
  assertUnbound(task);
});


test('a still-pending admitted memory instruction cannot publish a conversational done without a receipt', () => {
  const task = acceptActivatedMemoryAction('Remember this: the pending terminal marker is APRICOT DOVE. Just confirm.');
  assert.equal(receipts.prepareDurableMemoryIntakeHostCompletion(task).status,'missing');
  assertUnbound(task);
  const result = delivery.commitTurnOutcome(doneOutcome(task,'Got it.'));
  assert.equal(result.presentation.status,'blocked');
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) n FROM durable_memory_intake_receipts WHERE session_id=?').get(task.sessionId) as {n:number}).n,0);
});

test('the receipt reads volunteered statements by the same reason the drain writes', async () => {
  const { UNJUDGED_OWNER_STATEMENT_REASON } = await import('../../memory/durable-consolidation.js');
  assert.equal(receipts.VOLUNTEERED_FOR_REVIEW_REASON, UNJUDGED_OWNER_STATEMENT_REASON);
});
