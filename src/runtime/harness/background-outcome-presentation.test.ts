/** Display relationships require retained exact identities, never copied chat metadata. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-background-presentation-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('./eventlog.js');
const { projectHarnessEventForPublic } = await import('./public-presentation.js');
type EventRow = import('./eventlog.js').EventRow;

after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function session(id: string): string {
  log.createSession({ id, kind: 'chat', channel: 'desktop' });
  return id;
}

function source(sessionId: string, phase: 'passive' | 'report', extra: Record<string, unknown> = {}): EventRow {
  return log.appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_input_received', data: {
    synthetic: true, source: 'outcome', sourceLabel: 'Controlled workflow', sourceId: 'fixture-run:one',
    deliveryPhase: phase, text: 'Private staging text.', publicReportText: 'The controlled report is ready.',
    outcomeDigest: 'private-digest', evidence: ['private-ledger-reference'],
    nextAction: 'PRIVATE EXECUTOR DIRECTIVE', outcomeStopId: 'private-stop-receipt', ...extra,
  } });
}

function terminalData(accepted: EventRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const id = `turn:${accepted.seq}`;
  const text = 'The controlled report is ready.';
  const evidenceRefs = [{ kind: 'artifact', id: 'fixture-report', uri: 'artifact:fixture-report' }];
  return {
    sourceUserSeq: accepted.seq, terminalKey: id, logicalTerminalVersion: 1, reply: text,
    presentation: { version: 1, id: `${id}:presentation`, outcomeId: id, audience: 'user', phase: 'final',
      identity: { sessionId: accepted.sessionId, turn: 0, sourceUserSeq: accepted.seq },
      status: 'done', kind: 'answer', text, resumable: false, evidenceRefs },
    turnOutcome: { version: 2, id, status: 'done', resumable: false, evidenceRefs },
    outcomeDigest: 'PRIVATE TERMINAL RECEIPT', nextAction: 'PRIVATE EXECUTOR DIRECTIVE', ...extra,
  };
}

function terminal(accepted: EventRow, extra: Record<string, unknown> = {}): EventRow {
  return log.appendEvent({ sessionId: accepted.sessionId, turn: 0, role: 'assistant', type: 'conversation_completed',
    data: terminalData(accepted, extra) });
}

function marker(row: EventRow): unknown { return projectHarnessEventForPublic(row)?.data.backgroundOutcomeReport; }

let historicalTerminalId = 0;
/** Historical corrupt rows can predate the canonical terminal writer. */
function retainedHistoricalTerminal(sessionId: string, data: Record<string, unknown>): EventRow {
  const id = `historical-background-terminal:${++historicalTerminalId}`;
  log.openEventLog().prepare(`INSERT INTO events (id,session_id,turn,role,type,data_json,created_at)
    VALUES (?,?,0,'assistant','conversation_completed',?,?)`)
    .run(id, sessionId, JSON.stringify(data), '2026-10-15T12:00:00.000Z');
  return log.getEvent(id)!;
}

test('retained passive and report sources get bounded versioned relationships without private staging data', () => {
  const id = session('background-source-contract');
  for (const phase of ['passive', 'report'] as const) {
    const accepted = source(id, phase);
    const projected = projectHarnessEventForPublic(accepted)!;
    assert.deepEqual(projected.data.backgroundOutcomeReport, { version: 1, sourceUserSeq: accepted.seq,
      sourceLabel: 'Controlled workflow', sourceId: 'fixture-run:one', phase });
    assert.equal(projected.parentEventId, null);
    for (const key of ['text', 'publicReportText', 'outcomeDigest', 'evidence', 'nextAction', 'outcomeStopId']) {
      assert.equal(projected.data[key], undefined, `${key} remains in the private ledger`);
    }
    assert.equal(log.getEvent(accepted.id)!.data.nextAction, 'PRIVATE EXECUTOR DIRECTIVE');
  }
});

test('only a typed terminal for the exact earlier retained report gets its relationship and retains public result evidence', () => {
  const accepted = source(session('background-terminal-contract'), 'report');
  const completed = terminal(accepted);
  const projected = projectHarnessEventForPublic(completed)!;
  assert.deepEqual(projected.data.backgroundOutcomeReport, { version: 1, sourceUserSeq: accepted.seq,
    sourceLabel: 'Controlled workflow', sourceId: 'fixture-run:one', phase: 'report' });
  assert.equal(projected.data.reply, 'The controlled report is ready.');
  assert.deepEqual((projected.data.presentation as Record<string, unknown>).evidenceRefs,
    [{ kind: 'artifact', id: 'fixture-report', uri: 'artifact:fixture-report' }]);
  assert.deepEqual((projected.data.turnOutcome as Record<string, unknown>).evidenceRefs,
    [{ kind: 'artifact', id: 'fixture-report', uri: 'artifact:fixture-report' }]);
  assert.equal(projected.data.nextAction, undefined);
  assert.equal(projected.data.outcomeDigest, undefined);
});

test('a copied marker on a human message or ordinary terminal does not turn it into a background report', () => {
  const id = session('background-human-copy');
  const copied = { version: 1, sourceUserSeq: 1, sourceLabel: 'Controlled workflow', sourceId: 'fixture-run:one', phase: 'report' };
  const human = log.appendEvent({ sessionId: id, turn: 1, role: 'user', type: 'user_input_received', data: {
    text: `I pasted this marker: ${JSON.stringify(copied)}`, backgroundOutcomeReport: copied,
  } });
  assert.equal(marker(human), undefined);
  assert.equal(marker(terminal(human, { backgroundOutcomeReport: copied })), undefined);
});

test('unretained, altered and cross-session source rows cannot earn the display relationship', () => {
  const accepted = source(session('background-exact-source'), 'report');
  session('background-other-session');
  for (const forged of [
    { ...accepted, id: 'unretained-background-source', seq: accepted.seq + 10_000 },
    { ...accepted, sessionId: 'background-other-session' },
    { ...accepted, data: { ...accepted.data, sourceId: 'changed-run-identity' } },
  ]) assert.equal(marker(forged), undefined);
});

test('malformed source labels, phases and roles do not certify a terminal', () => {
  const id = session('background-malformed-source');
  for (const extra of [
    { sourceLabel: '' }, { sourceLabel: 'hidden\nlabel' }, { sourceId: 'x'.repeat(4097) },
    { sourceId: null }, { deliveryPhase: 'future' }, { synthetic: 'true' }, { source: 'human' },
  ]) {
    const malformed = source(id, 'report', extra);
    assert.equal(marker(malformed), undefined);
    assert.equal(marker(terminal(malformed)), undefined);
  }
  const wrongRole = log.appendEvent({ sessionId: id, turn: 0, role: 'system', type: 'user_input_received', data: {
    synthetic: true, source: 'outcome', sourceLabel: 'Controlled workflow', sourceId: 'fixture-run:role', deliveryPhase: 'report',
  } });
  assert.equal(marker(wrongRole), undefined);
  assert.equal(marker(terminal(wrongRole)), undefined);
});

test('passive-only, malformed typed and mismatched typed terminal identities remain unqualified', () => {
  const id = session('background-terminal-rejections');
  assert.equal(marker(terminal(source(id, 'passive'))), undefined);
  const accepted = source(id, 'report');
  const good = terminal(accepted);
  assert.throws(() => terminal(source(id, 'report'), { presentation: { version: 1 } }),
    /typed completion projection is invalid/, 'the canonical writer refuses new malformed terminals');
  const malformed = retainedHistoricalTerminal(id, terminalData(source(id, 'report'), { presentation: { version: 1 } }));
  assert.equal(marker(malformed), undefined);
  for (const mutation of ['source', 'presentation-source', 'presentation-session']) {
    const fresh = source(id, 'report');
    const data = terminalData(fresh);
    const freshPresentation = data.presentation as Record<string, unknown>;
    const freshIdentity = freshPresentation.identity as Record<string, unknown>;
    if (mutation === 'source') data.sourceUserSeq = fresh.seq + 1;
    else data.presentation = { ...freshPresentation, identity: { ...freshIdentity,
      ...(mutation === 'presentation-source' ? { sourceUserSeq: fresh.seq + 1 } : { sessionId: 'another-session' }) } };
    assert.equal(marker(retainedHistoricalTerminal(id, data)), undefined);
  }
  for (const changed of [
    { ...good, id: 'unretained-background-terminal', seq: good.seq + 1000 },
    { ...good, seq: accepted.seq },
  ]) assert.equal(marker(changed), undefined);
});
