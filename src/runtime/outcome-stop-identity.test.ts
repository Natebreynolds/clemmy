import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-stop-identity-'));
process.env.CLEMENTINE_HOME = home;
const { createSession, appendEvent, listEvents, updateSession } = await import('./harness/eventlog.js');
const { HarnessSession } = await import('./harness/session.js');
const { deliverOutcomeWithAcknowledgement, publishProactiveOutcome, renderOutcomeText } = await import('./outcome.js');
after(() => rmSync(home, { recursive: true, force: true }));
const context = (sessionId: string, stopId: string) => ({ originSessionId: sessionId, sourceLabel: 'background task', sourceId: 'fixture-task', stopId });
const passive = (id: string) => listEvents(id).filter(e => e.data.deliveryPhase === 'passive');
const reports = (id: string) => listEvents(id).filter(e => e.data.deliveryPhase === 'report');
const terminals = (id: string) => listEvents(id, { types: ['conversation_completed'] });

test('exact stops survive passive delivery, public report, model replay and reload without wording deduplication', () => {
  const { id } = createSession({ id: 'exact-stop-reload', kind: 'chat' });
  const blocked = { status: 'blocked' as const, summary: 'A fixture prerequisite is unavailable.', resumable: true };
  const first = context(id, 'stop-1');
  assert.equal(deliverOutcomeWithAcknowledgement(blocked, first).written, true);
  publishProactiveOutcome(id, blocked, first);
  // Reopening the persisted session replaces in-memory objects as on restart.
  let hs = HarnessSession.load(id)!;
  assert.equal(hs.toInputItems().length, 1);
  assert.equal(deliverOutcomeWithAcknowledgement({ ...blocked, summary: 'Rephrased prerequisite.', resumable: false }, first).written, false);
  publishProactiveOutcome(id, { ...blocked, summary: 'Rephrased prerequisite.', resumable: false }, first);
  assert.equal(terminals(id).length, 1);
  assert.equal(reports(id)[0].data.text, blocked.summary);

  const second = context(id, 'stop-2');
  assert.equal(deliverOutcomeWithAcknowledgement(blocked, second).written, true);
  publishProactiveOutcome(id, blocked, second);
  assert.equal(passive(id).length, 2, 'identical words describe two distinct stops');
  assert.equal(terminals(id).length, 2);
  hs = HarnessSession.load(id)!;
  assert.equal(hs.toInputItems().length, 2);

  const done = { status: 'done' as const, summary: 'Fixture completed.' };
  assert.equal(deliverOutcomeWithAcknowledgement(done, second).written, true);
  publishProactiveOutcome(id, done, second);
  hs = HarnessSession.load(id)!;
  assert.equal(hs.toInputItems().length, 3, 'done is distinct from blocked even with reused stop ID');
  assert.equal(passive(id).length, 3);
  assert.equal(reports(id).length, 3);
  assert.equal(terminals(id).length, 3);
  hs.recordTurnResult({ history: hs.toInputItems(), lastResponseId: undefined, turn: 1 });
  HarnessSession.load(id)!.updateConversationSnapshot([{ role: 'user', content: 'Compacted fixture history.' }]);
  assert.equal(deliverOutcomeWithAcknowledgement(done, second).written, false);
  publishProactiveOutcome(id, done, second);
  assert.equal(HarnessSession.load(id)!.toInputItems().length, 1, 'compaction does not erase delivery identity');
  assert.equal(terminals(id).length, 3);
});

test('passive-event crash gap repairs model snapshot with accepted words and public report after restart', () => {
  const { id } = createSession({ id: 'stop-crash-gap', kind: 'chat' });
  const ctx = context(id, 'gap-stop');
  const accepted = { status: 'blocked' as const, summary: 'Accepted fixture stop.', resumable: true };
  const text = renderOutcomeText(accepted, ctx);
  appendEvent({ sessionId: id, turn: 0, role: 'user', type: 'user_input_received', data: {
    text, synthetic: true, source: 'outcome', sourceLabel: ctx.sourceLabel, sourceId: ctx.sourceId,
    status: accepted.status, outcomeStopId: ctx.stopId, deliveryPhase: 'passive', publicReportText: accepted.summary, resumable: true,
  } });
  for (let n = 0; n < 205; n++) appendEvent({ sessionId: id, turn: n + 1, role: 'user', type: 'user_input_received', data: { text: 'later fixture turn' } });
  const replay = { ...accepted, summary: 'Different retry words.', resumable: false };
  assert.equal(deliverOutcomeWithAcknowledgement(replay, ctx).disposition, 'already_delivered');
  assert.deepEqual(HarnessSession.load(id)!.toInputItems(), [{ role: 'user', content: text }]);
  publishProactiveOutcome(id, replay, ctx);
  assert.equal(reports(id)[0].data.text, accepted.summary);
  assert.equal(reports(id)[0].data.resumable, true);
  assert.equal(passive(id).length, 1);
  assert.equal(terminals(id).length, 1);
  // Unrelated metadata updates and subsequent replay must retain exact IDs.
  const row = HarnessSession.load(id)!.sessionRow;
  updateSession(id, { metadata: { ...row.metadata, fixture: true } });
  assert.equal(deliverOutcomeWithAcknowledgement(replay, ctx).written, false);
  assert.equal(HarnessSession.load(id)!.toInputItems().length, 1);
});

test('a durable outbox identity cannot be rebound to another stop', () => {
  const { id } = createSession({ id: 'stop-outbox-conflict', kind: 'chat' });
  const result = { status: 'blocked' as const, summary: 'Same words.' };
  const ctx = { ...context(id, 'first'), deliveryId: 'fixture-delivery' };
  assert.equal(deliverOutcomeWithAcknowledgement(result, ctx).written, true);
  assert.equal(deliverOutcomeWithAcknowledgement(result, { ...ctx, stopId: 'different' }).acknowledged, false);
  assert.equal(passive(id).length, 1);
});


test('stale model, completion and compaction writers retain only reports injected after their replay snapshot', () => {
  for (const mode of ['turn', 'completed', 'compact'] as const) {
    const { id } = createSession({ id: `stop-stale-${mode}`, kind: 'chat' });
    const old = context(id, 'already-observed');
    const blocked = { status: 'blocked' as const, summary: 'Identical fixture stop words.' };
    deliverOutcomeWithAcknowledgement(blocked, old);
    const writer = HarnessSession.load(id)!;
    const before = writer.toInputItems();
    assert.equal(before.length, 1);
    // Same words/new exact ID arrive while a model or compactor owns old input.
    const fresh = context(id, 'arrived-during-model');
    deliverOutcomeWithAcknowledgement(blocked, fresh);
    const compacted = [{ role: 'user' as const, content: 'Older fixture report summarized.' }];
    const write = () => {
      if (mode === 'turn') writer.recordTurnResult({ history: before, lastResponseId: undefined, turn: 1 });
      else if (mode === 'completed') writer.recordCompletedTurnResult({ history: before, lastResponseId: undefined, turn: 1, finalOutputPreview: 'Fixture reply.', toolCalls: 0 });
      else writer.updateConversationSnapshot(compacted);
    };
    write();
    const items = HarnessSession.load(id)!.toInputItems();
    assert.equal(items.length, 2, `${mode}: concurrent arrival survives the stale writer`);
    assert.equal((items[1] as { content: string }).content, renderOutcomeText(blocked, fresh));
    assert.equal(deliverOutcomeWithAcknowledgement(blocked, fresh).written, false);
    assert.equal(HarnessSession.load(id)!.toInputItems().length, 2, 'replay adds no duplicate');
    if (mode !== 'completed') {
      // A current-history write need not call toInputItems first (which would
      // advance the reader's basis); it must not append the arrival twice.
      const current = (writer.sessionRow.metadata.__conversation as { items: typeof before }).items;
      writer.updateConversationSnapshot(current);
      assert.equal(HarnessSession.load(id)!.toInputItems().length, 2, 'writing already-merged history does not duplicate the arrival');
      write();
      assert.equal(HarnessSession.load(id)!.toInputItems().length, 2, 'retrying the old snapshot still retains the arrival once');
    }
    // Once a reader has actually observed both IDs it may compact either away;
    // the lifetime delivery ledger does not force old content back into context.
    const nextReader = HarnessSession.load(id)!;
    nextReader.toInputItems();
    nextReader.updateConversationSnapshot(compacted);
    deliverOutcomeWithAcknowledgement(blocked, fresh);
    assert.deepEqual(HarnessSession.load(id)!.toInputItems(), compacted);
  }
});


test('recovery adoption after restart retains reports arriving after the checkpoint replay basis', () => {
  const { id } = createSession({ id: 'stop-recovery-replay', kind: 'chat' });
  const result = { status: 'blocked' as const, summary: 'Identical checkpoint fixture stop.' };
  deliverOutcomeWithAcknowledgement(result, context(id, 'checkpoint-observed'));
  const writer = HarnessSession.load(id)!;
  const history = writer.toInputItems();
  deliverOutcomeWithAcknowledgement(result, context(id, 'checkpoint-unobserved'));
  assert.equal(writer.saveRecoveryState('fixture-checkpoint-state').installed, true);
  const restarted = HarnessSession.load(id)!;
  assert.equal(restarted.adoptRecoveredConversation({ serializedState: 'fixture-checkpoint-state', history, lastResponseId: undefined }), true);
  assert.equal(HarnessSession.load(id)!.toInputItems().length, 2);
  assert.equal(restarted.loadRecoveryState(), null);
  deliverOutcomeWithAcknowledgement(result, context(id, 'checkpoint-unobserved'));
  assert.equal(HarnessSession.load(id)!.toInputItems().length, 2);
});


test('approval checkpoint resume retains reports arriving after its model replay basis', () => {
  const { id } = createSession({ id: 'stop-approval-replay', kind: 'chat' });
  const result = { status: 'blocked' as const, summary: 'Identical approval fixture stop.' };
  deliverOutcomeWithAcknowledgement(result, context(id, 'approval-observed'));
  const writer = HarnessSession.load(id)!;
  const history = writer.toInputItems();
  deliverOutcomeWithAcknowledgement(result, context(id, 'approval-unobserved'));
  writer.saveInterruptState('fixture-approval-state');
  const restarted = HarnessSession.load(id)!;
  assert.equal(restarted.loadInterruptState(), 'fixture-approval-state');
  restarted.recordTurnResult({ history, lastResponseId: undefined, turn: 1 });
  assert.equal(HarnessSession.load(id)!.toInputItems().length, 2);
  const current = (restarted.sessionRow.metadata.__conversation as { items: typeof history }).items;
  restarted.updateConversationSnapshot(current);
  assert.equal(HarnessSession.load(id)!.toInputItems().length, 2);
  restarted.recordTurnResult({ history, lastResponseId: undefined, turn: 1 });
  assert.equal(HarnessSession.load(id)!.toInputItems().length, 2);
});
