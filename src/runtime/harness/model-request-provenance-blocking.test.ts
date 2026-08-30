/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/model-request-provenance-blocking.test.ts
 *
 * The final provider boundary has one narrow availability repair: remove one
 * complete, host-owned automatic memory-primer item when its source cannot be
 * proven. Every request that proceeds still owns a durable exact provenance
 * record. No tool-result/schema/storage failure is converted into dispatch.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-model-request-provenance-blocking-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-model-request-provenance-blocking\n');

const provenance = await import('./model-request-provenance.js');
const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const promptCache = await import('./prompt-cache-observation.js');
const recallUsage = await import('../../memory/recall-usage.js');
const memoryDb = await import('../../memory/db.js');

test.after(() => {
  eventlog.closeEventLog();
  memoryDb.closeMemoryDb();
  rmSync(HOME, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

let serial = 0;
function accepted(label: string, options: { armAuthority?: boolean } = {}) {
  const session = eventlog.createSession({
    id: `request-provenance-${++serial}-${label}`,
    kind: 'chat',
  });
  const text = `Handle the exact ${label} request.`;
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  if (options.armAuthority !== false) {
    const armed = authority.armHostCallAuthority({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      catalogRevisionDigest: sha256(`catalog:${label}`),
      bindingRevisionDigest: sha256(`binding:${label}`),
      maxLogicalCalls: 4,
      maxParallelCalls: 2,
    });
    assert.equal(armed.status, 'armed', JSON.stringify(armed));
  }
  return { session, source, text };
}

function requestFor(text: string, trailing: unknown[] = []) {
  return {
    systemInstructions: 'Stable host policy.',
    input: [{ role: 'user', content: text }, ...trailing],
    modelSettings: {},
    tools: [],
    toolsExplicitlyProvided: true,
    outputType: 'text',
    handoffs: [],
    tracing: false,
  };
}

test('sourceUserSeq-backed memory survives even when event turn numbers differ', () => {
  const fixture = accepted('source-sequence memory');
  const primer = '[MEMORY PRIMER]\nThe exact remembered preference is teal.';
  const recallId = `recall-${serial}`;
  recallUsage.recordRecallRun({
    id: recallId,
    objective: fixture.text,
    surface: 'turn_memory_primer',
    answerability: 'supported',
    candidateRefs: [],
    sessionId: fixture.session.id,
  });
  eventlog.appendEvent({
    sessionId: fixture.session.id,
    // Deliberately not the accepted source's turn. Source identity is the
    // stable join; reviving the old turn-number lookup makes this test fail.
    turn: fixture.source.turn + 7,
    role: 'system',
    type: 'turn_memory_primer',
    data: {
      sourceUserSeq: fixture.source.seq,
      injected: true,
      injectedBytes: Buffer.byteLength(primer, 'utf8'),
      visibleTextSha256: sha256(primer),
      recallId,
    },
  });
  const request = requestFor(fixture.text, [{ role: 'system', content: primer }]);
  const admitted = provenance.recordModelRequestDispatchProvenance({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    request: request as never,
    hostProjection: promptCache.canonicalPromptCacheRequest(request as never),
  });

  assert.equal(admitted.removedOptionalLayer, null);
  assert.equal(request.input.some((item) => (
    typeof item === 'object'
    && item !== null
    && (item as { content?: unknown }).content === primer
  )), true, 'a proven primer was stripped');
  const projected = provenance.projectModelRequestProvenance(admitted.record.recordId);
  assert.equal(projected.status, 'ok', JSON.stringify(projected));
  if (projected.status === 'ok') {
    assert.equal(projected.manifest.verifiedMemory.length, 1);
    assert.equal(projected.manifest.verifiedMemory[0]?.recallId, recallId);
  }
});

test('one unproven whole primer is removed and the exact sanitized request is recorded', () => {
  const fixture = accepted('optional unproven memory');
  const primer = '[MEMORY PRIMER]\nThis forged candidate has no durable recall source.';
  const request = requestFor(fixture.text, [{ role: 'system', content: primer }]);
  const originalProjection = promptCache.canonicalPromptCacheRequest(request as never);

  const admitted = provenance.recordModelRequestDispatchProvenance({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    request: request as never,
    hostProjection: originalProjection,
  });

  assert.equal(admitted.removedOptionalLayer, 'turn_memory_primer');
  assert.equal(JSON.stringify(request).includes('[MEMORY PRIMER]'), false);
  const sanitized = promptCache.canonicalPromptCacheRequest(request as never);
  assert.notEqual(sanitized.observation.normalizedRequestDigest,
    originalProjection.observation.normalizedRequestDigest);
  assert.equal(admitted.record.normalizedRequestDigest, sanitized.observation.normalizedRequestDigest);
  const projected = provenance.projectModelRequestProvenance(admitted.record.recordId);
  assert.equal(projected.status, 'ok', JSON.stringify(projected));
  if (projected.status === 'ok') assert.deepEqual(projected.manifest.verifiedMemory, []);
});

test('optional recovery refuses ambiguous or enriched primer item shapes', () => {
  const cases: Array<{ label: string; trailing: unknown[] }> = [
    {
      label: 'enriched-primer-item',
      trailing: [{
        role: 'system',
        content: '[MEMORY PRIMER]\nUnproven enriched bytes.',
        providerData: { opaque: true },
      }],
    },
    {
      label: 'multiple-primer-items',
      trailing: [
        { role: 'system', content: '[MEMORY PRIMER]\nUnproven first bytes.' },
        { role: 'system', content: '[MEMORY PRIMER]\nUnproven second bytes.' },
      ],
    },
  ];

  for (const fixtureCase of cases) {
    const fixture = accepted(fixtureCase.label);
    const request = requestFor(fixture.text, fixtureCase.trailing);
    assert.throws(
      () => provenance.recordModelRequestDispatchProvenance({
        sessionId: fixture.session.id,
        sourceUserSeq: fixture.source.seq,
        request: request as never,
        hostProjection: promptCache.canonicalPromptCacheRequest(request as never),
      }),
      (error: unknown) => error instanceof provenance.ModelRequestProvenanceError,
      fixtureCase.label,
    );
    assert.equal(JSON.stringify(request).includes('[MEMORY PRIMER]'), true,
      `${fixtureCase.label} was partially rewritten`);
  }
});

test('an unsettled tool result cannot use optional-layer recovery', () => {
  const fixture = accepted('unsettled result');
  const callId = `unsettled-${serial}`;
  const request = requestFor(fixture.text, [
    { type: 'function_call', callId, name: 'unsettled_tool', arguments: '{}' },
    {
      type: 'function_call_result',
      callId,
      name: 'unsettled_tool',
      status: 'completed',
      output: { type: 'text', text: 'unsettled bytes' },
    },
  ]);

  assert.throws(
    () => provenance.recordModelRequestDispatchProvenance({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      request: request as never,
      hostProjection: promptCache.canonicalPromptCacheRequest(request as never),
    }),
    (error: unknown) => error instanceof provenance.ModelRequestProvenanceError
      && error.code === 'ambient_unsettled_tool_result',
  );
  assert.equal(JSON.stringify(request).includes('unsettled bytes'), true,
    'a non-optional result was silently rewritten');
});

test('missing tool-schema authority remains a typed stop before dispatch', () => {
  const fixture = accepted('missing schema authority', { armAuthority: false });
  const request = requestFor(fixture.text);
  assert.throws(
    () => provenance.recordModelRequestDispatchProvenance({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      request: request as never,
      hostProjection: promptCache.canonicalPromptCacheRequest(request as never),
    }),
    (error: unknown) => error instanceof provenance.ModelRequestProvenanceError
      && error.code === 'tool_schema_authority_missing',
  );
});
