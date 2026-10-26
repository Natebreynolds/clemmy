/** Actual host wait over source-bound automatic memory; no scheduler or model I/O. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-settlement-timing-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false',
  EMBEDDINGS_DISABLED: 'true', CLEMMY_LOCAL_EMBEDDINGS: 'off', CLEMMY_EMBED_AT_WRITE: 'off' });
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state/machine-id'), 'memory-settlement-timing-test\n');
const events = await import('./eventlog.js');
const host = await import('./host-turn-runner.js');
const brackets = await import('./brackets.js');
const contexts = await import('./source-session-context.js');
const authorities = await import('./accepted-turn-call-authority.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const capture = await import('../../memory/auto-capture.js');
const consolidation = await import('../../memory/durable-consolidation.js');
const memoryDb = await import('../../memory/db.js');
const receipts = await import('./durable-memory-intake-receipt.js');
const deferred = await import('./review-after-delivery.js');
const steering = await import('./steer-notes.js');
const checkLessons = await import('../../memory/check-lessons.js');
checkLessons._setCheckLessonModelForTests(async () => ({ lessons: [] }));
after(() => {
  host._setHostObjectiveJudgeForTests(null); deferred._resetReviewAfterDeliveryForTests();
  checkLessons._setCheckLessonModelForTests(null);
  memoryDb.closeMemoryDb(); events.closeEventLog(); rmSync(home, { recursive: true, force: true });
});

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const pendingReply = 'The project report heading is captured. Consolidation is still pending; it is not saved yet.';
const savedReply = 'The project report heading AMBER TRACE is remembered.';
const amendment = 'Keep the saved heading. Include the display label SILVER WAVE in your response.';
const steeredReply = `${savedReply} The display label is SILVER WAVE.`;
const compoundReply = `${savedReply} A = 17.`;
function fixture(label: string) {
  const sessionId = `${label === 'steered-during-wait' ? 'sess-' : ''}memory-settlement-timing-${label}`;
  events.createSession({ id: sessionId, kind: 'chat' });
  const attempt = events.beginRunAttempt(sessionId, { runId: `${sessionId}:run` });
  const ownerText = `${label === 'compound-reviewed' ? 'Report A = 17 in your answer. ' : ''}`
    + `Remember that the ${label} project report heading is AMBER TRACE for future chats.`;
  const source = events.recordRunAttemptUserInput(attempt,
    { turn: 1, role: 'user', data: { text: ownerText } }, { armRunInFlight: true });
  const identity = { sessionId, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(contexts.captureFreshSourceSessionContext(identity));
  // Same accepted host-owned, tool-free entry as the existing memory obligation fixtures.
  const frozenCatalogDigest = hash(JSON.stringify({ entries: [], version: 1 }));
  assert.equal(authorities.armHostCallAuthority({ ...identity,
    catalogRevisionDigest: hash(JSON.stringify({ envelopeDigest: null, frozenCatalogDigest, sealedUniverse: [], version: 1 })),
    bindingRevisionDigest: hash(JSON.stringify({ attemptId: sessionId, envelopeDigest: null, frozenCatalogDigest, version: 1 })),
    maxLogicalCalls: 20, maxParallelCalls: 8 }).status, 'armed');
  const input = { message: ownerText, sessionId, sourceEventId: `user-source:${source.seq}`, occurredAt: source.createdAt,
    sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(source) };
  const candidates = capture.selectAutoMemoryCandidates(ownerText);
  assert.equal(candidates.length, 1);
  const queued = consolidation.enqueueAutoCaptureCandidates({ ...input, candidates,
    origins: capture.automaticMemoryOriginsForCapture(input, candidates) });
  assert.equal(queued.candidateIds.length, 1);
  return { ...identity, attempt, ownerText, queued };
}

async function promote(value: ReturnType<typeof fixture>) {
  const reviewed: Array<{ ownerText: string; sourceUserSeq: number | undefined }> = [];
  const drained = await consolidation.drainDurableConsolidationCandidates({
    ids: value.queued.candidateIds, limit: value.queued.candidateIds.length,
    resolver: async () => ({ decision: 'ADD' }),
    standingReviewer: async (ownerText, _candidate, _mode, origin) => {
      reviewed.push({ ownerText, sourceUserSeq: origin?.source.context?.sourceUserSeq });
      if (!origin) throw new Error('Controlled fixture lacks accepted origin');
      return { scope: 'standing', reason: 'Controlled source-bound retention.', destinationDecision: {
        durability: 'standing', claim: origin.claim, destination: 'kind_default', destinationSpans: [],
        reason: 'Controlled full-source default destination.',
      } };
    },
  });
  return { drained, reviewed };
}

type ModelRequest = { input?: Array<{ role?: string; content?: unknown }>; tools?: unknown[] };
const intakeNotices = (request: ModelRequest) => request.input?.filter(item => item.role === 'system'
  && typeof item.content === 'string' && item.content.startsWith('[Verified memory intake]'))
  .map(item => item.content as string) ?? [];

for (const state of ['settles-during-wait', 'settles-during-answer', 'already-saved', 'remains-pending',
  'step-limit', 'steered-during-wait', 'compound-reviewed'] as const) {
  test(`memory settlement timing: ${state}`, async (t) => {
    const value = fixture(state);
    t.after(() => { events.finishRunAttempt(value.attempt, 'completed'); });
    if (state === 'steered-during-wait') assert.equal(steering.sessionSupportsSteering(value.sessionId), true);
    let promotion: Promise<Awaited<ReturnType<typeof promote>>> | undefined;
    if (state === 'already-saved') promotion = Promise.resolve(await promote(value));
    const before = receipts.verifiedMemoryConsolidationEvidence(value);
    assert.equal(before?.length, 1);
    assert.equal(before[0]!.verified, state === 'already-saved');
    const requests: ModelRequest[] = [];
    const reviews: Array<{ objective: string; reply: string; options: unknown }> = [];
    const finalReply = state === 'steered-during-wait' ? steeredReply : state === 'compound-reviewed' ? compoundReply : savedReply;
    const firstDraft = state === 'compound-reviewed' ? `A = 17. ${pendingReply}` : pendingReply;
    let note: { seq: number } | undefined;
    host._setHostObjectiveJudgeForTests(async (objective, reply, options) => {
      reviews.push({ objective, reply, options });
      // A qualified whole-request review is still necessary if the reply is
      // reviewed before publication. Storage alone is not a positive verdict.
      return { done: reply === finalReply, ...(state === 'compound-reviewed' ? {} : { repairScope: 'claims' as const }),
        reason: reply === finalReply ? 'The current reply covers this complete request.'
          : state === 'compound-reviewed' ? 'The response omitted the independently requested A = 17 result.'
          : 'The pending claim contradicts current canonical storage.',
        memoryRequirement: { version: 1, kind: 'retain', corrections: [], reason: 'The owner asks to retain the stated heading.' } };
    });
    const model = {
      async getResponse(request: ModelRequest) {
        requests.push(structuredClone(request));
        if (['settles-during-answer', 'step-limit', 'compound-reviewed'].includes(state) && requests.length === 1) {
          // The request already carries pending evidence, but the canonical
          // save finishes before its answer returns. This interleaving never
          // enters the host's pending-consolidation wait.
          promotion = promote(value);
          await promotion;
        }
        const text = state === 'compound-reviewed' && requests.length === 2 ? savedReply
          : state === 'already-saved' || requests.length > 1 ? finalReply : firstDraft;
        return { responseId: `memory-timing-${state}-${requests.length}`,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] };
      },
      async *getStreamedResponse(request: ModelRequest) {
        const response = await this.getResponse(request); yield { type: 'response_started' } as never;
        yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
      },
    };
    const originalSetTimeout = globalThis.setTimeout;
    let waitEntered = false;
    // The real host timer selects the interleaving. Do not race wall-clock
    // provider duration or accelerate the wait: promote only after the host
    // has read pending evidence and actually called its bounded wait.
    if (state === 'settles-during-wait' || state === 'steered-during-wait') globalThis.setTimeout = ((callback: (...args: unknown[]) => void,
      delay?: number, ...args: unknown[]) => {
      if (!waitEntered && requests.length === 1 && delay === 500) {
        waitEntered = true;
        promotion = promote(value);
        return originalSetTimeout(() => { void promotion!.then(() => {
          if (state === 'steered-during-wait') note = steering.appendSteerNote(value.sessionId, amendment,
            { expectedAttemptId: value.attempt.attemptId });
          callback(...args);
        }); }, delay);
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
    catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
    host.captureEffectiveCompletionPolicyOnce({ ...value, enabled: true });
    let outcome: Awaited<ReturnType<typeof host.hostRunRunner>>;
    try {
      const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } });
      outcome = await brackets.withHarnessRunContext({ ...value, runAttemptId: value.attempt.attemptId,
        counter: new brackets.ToolCallsCounter(20) }, () =>
        host.hostRunRunner(runner as never, { model, tools: [] } as never,
          [{ type: 'message', role: 'user', content: value.ownerText }] as never,
          { maxTurns: state === 'step-limit' ? 1 : 4, hostTurnEngine: 'host_v1', hostJudgeCompletion: true,
            hostReviewAfterDelivery: state !== 'compound-reviewed', context: value } as never));
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      host._setHostObjectiveJudgeForTests(null); catalogs.installHostCapabilityCatalogFactory(priorCatalog);
      deferred._resetReviewAfterDeliveryForTests();
    }
    // Assertions stay outside host/model/reviewer catches, so setup failures
    // cannot masquerade as the pending-to-saved regression.
    assert.ok(requests[0]);
    assert.equal(intakeNotices(requests[0]!).length, 1);
    assert.match(intakeNotices(requests[0]!)[0]!, state === 'already-saved' ? /durably SAVED/ : /durably queued/);
    const after = receipts.verifiedMemoryConsolidationEvidence(value);
    assert.equal(events.listEvents(value.sessionId, { types: ['tool_called'] }).length, 0,
      'automatic retention never needs explicit duplicate saves or readback');
    if (promotion) {
      const completed = await promotion;
      assert.equal(completed.drained.promoted, 1); assert.equal(completed.drained.retried, 0);
      assert.equal(completed.drained.skipped, 0); assert.equal(completed.drained.expired, 0);
      assert.deepEqual(completed.reviewed, [{ ownerText: value.ownerText, sourceUserSeq: value.sourceUserSeq }]);
      assert.equal(after?.length, 1); assert.equal(after[0]!.verified, true);
      assert.equal(after[0]!.sourceLinked, true); assert.equal(after[0]!.scopeMatches, true);
    }
    if (state === 'settles-during-wait' || state === 'settles-during-answer') {
      const waited = events.listEvents(value.sessionId, { types: ['guardrail_tripped'] })
        .filter(row => row.data.kind === 'memory_consolidation_review_wait' && row.data.sourceUserSeq === value.sourceUserSeq);
      if (state === 'settles-during-wait') {
        assert.equal(waitEntered, true, 'promotion must occur within the actual host bounded wait');
        assert.equal(waited.length, 1); assert.equal(waited[0]!.data.stillPending, false);
      } else {
        assert.equal(waitEntered, false);
        assert.equal(waited.length, 0, 'the request became stale during answer generation, without a bounded wait');
      }
      assert.notEqual(outcome.finalOutput, pendingReply,
        'an unpublished draft made from pending evidence must not leave after that same intake is verified saved');
      assert.equal(outcome.finalOutput, savedReply);
      assert.ok(requests.slice(1).some(request => intakeNotices(request).some(text => text.includes('durably SAVED'))),
        'the existing next model request must receive the reopened saved state');
      assert.ok(reviews.length <= 1, 'the transition must not add a reviewer repair loop');
    } else if (state === 'step-limit') {
      assert.equal(requests.length, 1, 'refresh cannot create another model allowance');
      assert.equal(outcome.terminal?.status, 'blocked');
      assert.equal(outcome.terminal?.reason, 'max_turns');
      assert.notEqual(outcome.finalOutput, firstDraft, 'budget exhaustion cannot publish the stale draft');
      assert.equal(reviews.length, 0);
    } else if (state === 'steered-during-wait') {
      assert.equal(waitEntered, true); assert.ok(note);
      assert.ok(requests[1], 'the accepted amendment receives its own actual model request');
      assert.ok(steering.adoptedSteerNotesForSource(value).some(row => row.seq === note!.seq && row.text === amendment));
      assert.ok(JSON.stringify(requests[1]).includes(amendment), 'next request receives the actual accepted amendment');
      assert.match(intakeNotices(requests[1]!)[0] ?? '', /durably SAVED/);
      assert.ok(!JSON.stringify(requests[1]).includes('The automatic memory evidence changed after your previous request'),
        'refresh guidance owned by the earlier objective must not cross an adopted amendment');
      assert.ok(!JSON.stringify(requests[1]).includes(firstDraft), 'the obsolete draft is not reintroduced as refresh guidance');
      assert.equal(after?.[0]!.verified, true, 'owner steering preserves the already saved fact');
      // Existing memory source authority deliberately excludes adopted
      // steering until its typed handoff is available. Refreshing wording
      // cannot waive that separate full-request completion floor.
      assert.equal(outcome.terminal?.status, 'blocked');
      assert.equal(outcome.terminal?.reason, 'memory_correction_unverified');
      assert.match(String(outcome.finalOutput), /could not verify all the memory work/);
      assert.ok(events.listEvents(value.sessionId, { types: ['goal_alignment_judged'] })
        .filter(row => row.data.kind === 'completion').every(row => row.data.fulfills !== true));
    } else if (state === 'compound-reviewed') {
      assert.equal(outcome.finalOutput, compoundReply); assert.equal(requests.length, 3);
      assert.match(intakeNotices(requests[1]!)[0] ?? '', /durably SAVED/);
      assert.ok(JSON.stringify(requests[1]).includes(firstDraft), 'refresh retains the full previous draft including independent A');
      assert.deepEqual(reviews.map(row => row.reply), [savedReply, compoundReply],
        'ordinary review rejects omitted independent work, then accepts the complete answer');
      assert.ok(reviews.every(row => row.objective === value.ownerText), 'review still owns the entire accepted request');
      const verdicts = events.listEvents(value.sessionId, { types: ['goal_alignment_judged'] })
        .filter(row => row.data.kind === 'completion' && row.data.sourceUserSeq === value.sourceUserSeq);
      assert.deepEqual(verdicts.map(row => row.data.fulfills), [false, true]);
      assert.equal(events.listEvents(value.sessionId, { types: ['completion_review_deferred'] }).length, 0);
    } else if (state === 'already-saved') {
      assert.equal(outcome.finalOutput, savedReply); assert.equal(requests.length, 1);
      assert.equal(reviews.length, 0, 'unchanged verified storage retains ordinary deferred review');
    } else {
      assert.equal(outcome.terminal?.status, 'blocked');
      assert.equal(outcome.terminal?.reason, 'memory_consolidation_pending');
      assert.equal(after?.[0]!.verified, false); assert.equal(reviews.length, 0);
      assert.equal(requests.length, 1, 'pending work remains held without duplicate model save attempts');
    }
  });
}
