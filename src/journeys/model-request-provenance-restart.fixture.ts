/**
 * Separate-process restart projector used by the governing durable-request
 * journey. It emits only content-free identities; exact prompt bytes stay in
 * the authority-owned encrypted store and in this short-lived process.
 */
import { createHash } from 'node:crypto';

const rawRecordIds = process.env.CLEM_MODEL_REQUEST_RESTART_RECORD_IDS ?? '';
const parsed = JSON.parse(rawRecordIds) as unknown;
if (
  !Array.isArray(parsed)
  || parsed.length < 1
  || parsed.length > 32
  || parsed.some((value) => typeof value !== 'string' || !value.startsWith('model-request:'))
) {
  throw new Error('restart projector requires bounded model-request record ids');
}
const recordIds = parsed as string[];
const provenance = await import('../runtime/harness/model-request-provenance.js');
const promptCache = await import('../runtime/harness/prompt-cache-observation.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const memoryDb = await import('../memory/db.js');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

try {
  const projections = recordIds.map((recordId) => {
    const projected = provenance.projectModelRequestProvenance(recordId);
    if (projected.status !== 'ok') return { recordId, ...projected };
    const expectedNames = [...promptCache.PROMPT_CACHE_LAYER_ORDER];
    const expectedNameSet = new Set<string>(expectedNames);
    const projectedNames = Object.keys(projected.layers);
    const manifestNames = Object.keys(projected.manifest.layers);
    const owns = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name);
    if (
      projectedNames.length !== expectedNames.length
      || manifestNames.length !== expectedNames.length
      || projectedNames.some((name) => !expectedNameSet.has(name))
      || manifestNames.some((name) => !expectedNameSet.has(name))
      || expectedNames.some((name) => (
        !owns(projected.layers, name) || !owns(projected.manifest.layers, name)
      ))
    ) {
      throw new Error(`restart projector layer membership diverged for ${recordId}`);
    }
    const layerDigests: Record<string, { bytes: number; sha256: string }> = {};
    for (const name of expectedNames) {
      const text = projected.layers[name];
      const actual = { bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) };
      const expected = projected.manifest.layers[name];
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw new Error(`restart projector layer verification diverged for ${recordId}:${name}`);
      }
      layerDigests[name] = actual;
    }
    const normalizedRequestDigest = promptCache.promptCacheNormalizedRequestDigest({
      boundary: projected.boundary,
      layers: projected.layers,
    });
    if (
      normalizedRequestDigest !== projected.record.normalizedRequestDigest
      || normalizedRequestDigest !== projected.record.hostProjectionDigest
    ) {
      throw new Error(`restart projector layer verification diverged for ${recordId}`);
    }
    return {
      status: 'ok' as const,
      recordId,
      requestOrdinal: projected.record.requestOrdinal,
      normalizedRequestDigest: projected.record.normalizedRequestDigest,
      hostProjectionDigest: projected.record.hostProjectionDigest,
      provenanceDigest: projected.record.provenanceDigest,
      boundary: projected.boundary,
      cacheEligibility: projected.cacheEligibility,
      layerDigests,
      sourceEventId: projected.manifest.source.eventId,
      preambles: projected.manifest.preambles.map((ref) => ({
        eventId: ref.eventId,
        eventDigest: ref.eventDigest,
        deliveryKey: ref.deliveryKey,
      })),
      verifiedMemory: projected.manifest.verifiedMemory.map((ref) => ({
        eventId: ref.eventId,
        recallId: ref.recallId,
        recallDigest: ref.recallDigest,
      })),
      disclosedEventIds: projected.manifest.disclosedRefs.map((ref) => ref.eventId),
      settlements: projected.manifest.settledResults.map((ref) => ({
        logicalToolCallId: ref.logicalToolCallId,
        settlementDigest: ref.settlementDigest,
        resultHandleId: ref.resultHandleId,
        resultHandleDigest: ref.resultHandleDigest,
      })),
      toolSchemaCount: projected.manifest.toolSchemas.schemaDigests.length,
      toolAuthorityDigest: projected.manifest.toolSchemas.authorityDigest,
    };
  });
  process.stdout.write(`MODEL_REQUEST_RESTART_PROJECTION=${JSON.stringify({
    pid: process.pid,
    parentPid: process.ppid,
    projections,
  })}\n`);
} finally {
  eventlog.closeEventLog();
  memoryDb.closeMemoryDb();
}
