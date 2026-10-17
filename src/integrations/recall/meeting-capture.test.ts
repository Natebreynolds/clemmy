/**
 * Run: npx tsx --test src/integrations/recall/meeting-capture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-meeting-filing-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  appendRecallTranscriptSegment,
  _observeRecallRecordReadsForTests,
  ingestRecallTranscriptSegment,
  applyCanonicalTranscript,
  finalizeRecallMeeting,
  saveRecallMeetingAnalysis,
  fileMeetingFromAnalysis,
  buildMeetingChatPrompt,
  findRecallMeetingRecord,
  groundedMeetingParticipantNames,
  meetingMemoryProposals,
  listAllRecallMeetingRecords,
  loadRecallMeetingById,
  noteRecallMeetingDetected,
  patchMeetingRecord,
  updateRecallTranscriptDelivery,
  recordMeetingTitle,
  renameMeeting,
  summarizeRecallMeeting,
} = await import('./meeting-capture.js');
const { reindexVault } = await import('../../memory/indexer.js');
const { openMemoryDb, closeMemoryDb } = await import('../../memory/db.js');
const { shouldPromoteToDurable } = await import('../../execution/background-promote.js');

test.after(() => {
  closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function identifiedFinal(windowId: string, sdkUploadId: string, id = 'a') {
  return { windowId, sdkUploadId, event: 'transcript.data', isFinal: true, text: 'A controlled final utterance',
    eventId: `recall-final-${id.repeat(64)}`, eventIdentity: 'sdk' as const, participantId: '7', sourceStartSeconds: 10, sourceEndSeconds: 11 };
}

test('repeated final ingestion and exact meeting reads leave unchanged historical transcripts undecoded', () => {
  const directory = path.join(TMP_HOME, 'state', 'meeting-capture', 'recall-recordings');
  mkdirSync(directory, { recursive: true });
  const history = Array.from({ length: 12 }, (_, index) => path.join(directory, `hot-path-history-${index}.json`));
  const historical = (index: number) => ({ id: `hot-path-history-${index}`, windowId: `hot-path-history-window-${index}`,
    status: 'completed', startedAt: '2026-10-16T12:00:00.000Z', segments: [{ text: 'Retained historical words. '.repeat(2_000) }] });
  for (const [index, filePath] of history.entries()) writeFileSync(filePath, JSON.stringify(historical(index)));
  const input = identifiedFinal('hot-path-current-window', 'hot-path-current-upload');
  const active = noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, status: 'recording' });
  assert.equal(ingestRecallTranscriptSegment(input).status, 'accepted');
  assert.ok(loadRecallMeetingById(active.id)); // warm the metadata for the last write
  const reads: Array<{ filePath: string; kind: string }> = [];
  const restore = _observeRecallRecordReadsForTests((event) => reads.push(event));
  try {
    for (let index = 0; index < 4; index++) {
      const result = ingestRecallTranscriptSegment({ ...input, eventId: `recall-final-${index.toString(16).padStart(64, '0')}` });
      assert.equal(result.status, 'accepted');
      const fresh = loadRecallMeetingById(active.id)!;
      assert.equal(fresh.segments.length, index + 2);
      fresh.segments.length = 0;
      assert.equal(loadRecallMeetingById(active.id)?.segments.length, index + 2, 'mutable full records are never cached');
    }
    assert.equal(reads.filter((read) => history.includes(read.filePath)).length, 0);
    const changed = history[0];
    writeFileSync(`${changed}.tmp`, JSON.stringify({ ...historical(0), id: 'hot-path-changed-history' }));
    renameSync(`${changed}.tmp`, changed);
    assert.ok(loadRecallMeetingById(active.id));
    assert.ok(loadRecallMeetingById(active.id));
    assert.equal(reads.filter((read) => read.filePath === changed && read.kind === 'inventory').length, 1);
    assert.equal(loadRecallMeetingById('hot-path-history-0'), null);
    assert.equal(loadRecallMeetingById('hot-path-changed-history')?.id, 'hot-path-changed-history');
    writeFileSync(`${changed}.tmp`, '{ corrupt history'); renameSync(`${changed}.tmp`, changed);
    assert.equal(ingestRecallTranscriptSegment({ ...input, eventId: `recall-final-${'f'.repeat(64)}` }).status, 'ignored');
    assert.equal(loadRecallMeetingById(active.id), null, 'unknown identities cannot certify an exact capture');
    writeFileSync(`${changed}.tmp`, JSON.stringify(historical(0))); renameSync(`${changed}.tmp`, changed);
    assert.equal(ingestRecallTranscriptSegment({ ...input, eventId: `recall-final-${'f'.repeat(64)}` }).status, 'accepted');
  } finally {
    restore();
    for (const filePath of history) rmSync(filePath, { force: true });
  }
});

test('live final saves defer memory episodes until completion, and canonical updates project normally', () => {
  const input = identifiedFinal('projection-boundary-window', 'projection-boundary-upload');
  const record = noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, status: 'recording' });
  const episodeCount = () => (openMemoryDb().prepare('SELECT COUNT(*) AS count FROM memory_episodes WHERE call_id = ?').get(record.id) as { count: number }).count;
  assert.equal(episodeCount(), 0);
  for (const id of ['1', '2', '3']) assert.equal(ingestRecallTranscriptSegment({ ...input, eventId: `recall-final-${id.repeat(64)}` }).status, 'accepted');
  assert.equal(episodeCount(), 0);
  const stopped = finalizeRecallMeeting({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, retentionMode: 'zero' });
  assert.equal(episodeCount(), 1);
  const canonicalText = 'The canonical projection has its own retained evidence.';
  applyCanonicalTranscript(stopped.record, [{ id: 'projection-canonical', windowId: input.windowId, event: 'transcript.canonical', isFinal: true, text: canonicalText, timestamp: '2026-10-17T12:00:00.000Z' }]);
  assert.equal(episodeCount(), 1);
  const episode = openMemoryDb().prepare('SELECT evidence_excerpt FROM memory_episodes WHERE call_id = ?').get(record.id) as { evidence_excerpt: string };
  assert.match(episode.evidence_excerpt, /canonical projection/);
});

test('duplicate meeting ids or capture ids in changed history cannot admit a final to one guessed record', () => {
  const input = identifiedFinal('inventory-duplicate-window', 'inventory-duplicate-upload');
  const active = noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, status: 'recording' });
  const duplicatePath = path.join(TMP_HOME, 'state', 'meeting-capture', 'recall-recordings', 'inventory-duplicate-alias.json');
  try {
    for (const duplicate of [
      { ...active, id: 'different-meeting-id', windowId: 'another-window' },
      { ...active, sdkUploadId: 'different-capture-id', windowId: 'another-window' },
    ]) {
      writeFileSync(`${duplicatePath}.tmp`, JSON.stringify(duplicate)); renameSync(`${duplicatePath}.tmp`, duplicatePath);
      const result = ingestRecallTranscriptSegment(input);
      assert.equal(result.status, 'ignored');
      if (result.status === 'ignored') assert.equal(result.reason, 'ambiguous_capture');
    }
  } finally { rmSync(duplicatePath, { force: true }); }
  const result = ingestRecallTranscriptSegment(input);
  assert.equal(result.status, 'accepted');
  if (result.status === 'accepted') assert.equal(result.record.segments.length, 1);
});

test('final ingestion refuses unknown captures and nonfinal events without creating records', () => {
  const before = listAllRecallMeetingRecords().length;
  assert.deepEqual(ingestRecallTranscriptSegment(identifiedFinal('unknown-ingress', 'unknown-upload')), { status: 'ignored', reason: 'unknown_capture' });
  assert.deepEqual(ingestRecallTranscriptSegment({ ...identifiedFinal('unknown-ingress', 'unknown-upload'), event: 'transcript.partial_data' }), { status: 'ignored', reason: 'not_a_final_transcript' });
  assert.equal(listAllRecallMeetingRecords().length, before);
  assert.throws(() => appendRecallTranscriptSegment({ windowId: 'unknown-legacy-ingress', event: 'transcript.data', text: 'Legacy final' }), /unknown_capture/);
});

test('exact final replay is idempotent and an altered payload cannot reuse its identity', () => {
  const input = identifiedFinal('replay-window', 'replay-upload');
  noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, status: 'recording' });
  const first = ingestRecallTranscriptSegment(input);
  assert.equal(first.status, 'accepted');
  const repeated = ingestRecallTranscriptSegment({ ...input, timestamp: '2026-10-17T12:00:00.000Z' });
  assert.equal(repeated.status, 'duplicate');
  if (first.status === 'accepted' && repeated.status === 'duplicate') assert.equal(repeated.segmentId, first.segmentId);
  const conflicting = ingestRecallTranscriptSegment({ ...input, text: 'Different content' });
  assert.equal(conflicting.status, 'ignored');
  if (conflicting.status === 'ignored') assert.equal(conflicting.reason, 'event_identity_conflict');
  assert.equal(findRecallMeetingRecord({ sdkUploadId: input.sdkUploadId })?.segments.length, 1);
  const distinct = ingestRecallTranscriptSegment({ ...input, eventId: `recall-final-${'b'.repeat(64)}`, sourceStartSeconds: 20, sourceEndSeconds: 21 });
  assert.equal(distinct.status, 'accepted', 'identical words at another source time are another utterance');
});

test('capture identity must match window, SDK upload, and an already-known recording', () => {
  const input = identifiedFinal('strict-window', 'strict-upload');
  noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, recordingId: 'strict-recording', status: 'recording' });
  for (const bad of [
    { ...input, windowId: 'other-window' },
    { ...input, sdkUploadId: 'other-upload', recordingId: 'strict-recording' },
    { ...input, recordingId: 'other-recording' },
  ]) assert.equal(ingestRecallTranscriptSegment(bad).status, 'ignored');
  assert.equal(findRecallMeetingRecord({ sdkUploadId: input.sdkUploadId })?.segments.length, 0);
});

test('an unassigned capture cannot adopt another meeting recording id through final, detection, completion, or patch', () => {
  const directory = path.join(TMP_HOME, 'state', 'meeting-capture', 'recall-recordings');
  const input = identifiedFinal('ownership-fixture-window-a', 'ownership-fixture-upload-a');
  const a = noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, status: 'recording' });
  const b = noteRecallMeetingDetected({ windowId: 'ownership-fixture-window-b', sdkUploadId: 'ownership-fixture-upload-b', recordingId: 'ownership-fixture-recording-x', status: 'recording' });
  const snapshot = () => Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.json')).sort().map((name) => [name, readFileSync(path.join(directory, name), 'utf8')]));
  const before = snapshot();
  const result = ingestRecallTranscriptSegment({ ...input, recordingId: b.recordingId });
  assert.equal(result.status, 'ignored');
  if (result.status === 'ignored') assert.equal(result.reason, 'capture_identity_conflict');
  assert.deepEqual(snapshot(), before, 'no overwritten foreign record or alias cleanup');
  for (const mutate of [
    () => noteRecallMeetingDetected({ windowId: a.windowId, sdkUploadId: a.sdkUploadId, recordingId: b.recordingId }),
    () => finalizeRecallMeeting({ windowId: a.windowId, sdkUploadId: a.sdkUploadId, recordingId: b.recordingId }),
    () => patchMeetingRecord(a.id, { recordingId: b.recordingId }),
  ]) {
    assert.throws(mutate, /capture identity/);
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(findRecallMeetingRecord({ sdkUploadId: a.sdkUploadId })?.id, a.id);
  assert.equal(findRecallMeetingRecord({ recordingId: b.recordingId })?.id, b.id);
  assert.equal(loadRecallMeetingById(a.id)?.recordingId, undefined);
});

test('unowned recording enrichment migrates only its own alias and preserves another capture in the reused window', () => {
  const directory = path.join(TMP_HOME, 'state', 'meeting-capture', 'recall-recordings');
  const windowId = 'ownership-migration-fixture-window';
  const a = noteRecallMeetingDetected({ windowId, sdkUploadId: 'ownership-migration-fixture-a', status: 'recording' });
  const b = noteRecallMeetingDetected({ windowId, sdkUploadId: 'ownership-migration-fixture-b', recordingId: 'ownership-migration-fixture-recording-b', status: 'recording' });
  const bPath = path.join(directory, 'ownership-migration-fixture-recording-b.json');
  const bBytes = readFileSync(bPath, 'utf8');
  const enriched = ingestRecallTranscriptSegment({ ...identifiedFinal(windowId, a.sdkUploadId!), recordingId: 'ownership-migration-fixture-recording-a' });
  assert.equal(enriched.status, 'accepted');
  if (enriched.status === 'accepted') { assert.equal(enriched.record.id, a.id); assert.equal(enriched.record.recordingId, 'ownership-migration-fixture-recording-a'); }
  assert.equal(existsSync(path.join(directory, 'ownership-migration-fixture-a.json')), false, 'only A upload alias migrated');
  assert.equal(readFileSync(bPath, 'utf8'), bBytes);
  assert.equal(findRecallMeetingRecord({ sdkUploadId: b.sdkUploadId })?.id, b.id);
});

test('a recording identity cannot overwrite a foreign upload target in the shared legacy filename namespace', () => {
  const directory = path.join(TMP_HOME, 'state', 'meeting-capture', 'recall-recordings');
  const a = noteRecallMeetingDetected({ windowId: 'namespace-fixture-window-a', sdkUploadId: 'namespace-fixture-upload-a', status: 'recording' });
  const b = noteRecallMeetingDetected({ windowId: 'namespace-fixture-window-b', sdkUploadId: 'namespace-fixture-shared-key', status: 'recording' });
  const aPath = path.join(directory, 'namespace-fixture-upload-a.json');
  const bPath = path.join(directory, 'namespace-fixture-shared-key.json');
  const before = [readFileSync(aPath, 'utf8'), readFileSync(bPath, 'utf8')];
  assert.throws(() => patchMeetingRecord(a.id, { recordingId: b.sdkUploadId }), /target belongs to another meeting/);
  assert.deepEqual([readFileSync(aPath, 'utf8'), readFileSync(bPath, 'utf8')], before);
  assert.equal(loadRecallMeetingById(a.id)?.recordingId, undefined);
  assert.equal(loadRecallMeetingById(b.id)?.sdkUploadId, b.sdkUploadId);
});

test('native transcript delivery uncertainty survives completion and only exact status or canonical readback clears it', () => {
  const input = identifiedFinal('delivery-status-fixture-window', 'delivery-status-fixture-upload');
  noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, status: 'recording' });
  ingestRecallTranscriptSegment(input);
  const completed = finalizeRecallMeeting({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, unresolvedFinalCount: 2, retentionMode: 'zero' }).record;
  assert.deepEqual(completed.liveTranscriptDelivery, { status: 'incomplete', failedFinalCount: 2 });
  assert.deepEqual(summarizeRecallMeeting(completed).liveTranscriptDelivery, completed.liveTranscriptDelivery, 'native meeting_read summary carries the qualification');
  const bytes = JSON.stringify(loadRecallMeetingById(completed.id));
  for (const bad of [
    { windowId: 'foreign-window', sdkUploadId: input.sdkUploadId!, unresolvedFinalCount: 0 },
    { windowId: input.windowId, sdkUploadId: 'foreign-upload', unresolvedFinalCount: 0 },
    { windowId: input.windowId, sdkUploadId: input.sdkUploadId!, unresolvedFinalCount: -1 },
  ]) assert.equal(updateRecallTranscriptDelivery(bad).status, 'ignored');
  assert.equal(JSON.stringify(loadRecallMeetingById(completed.id)), bytes);
  const acknowledged = updateRecallTranscriptDelivery({ windowId: input.windowId, sdkUploadId: input.sdkUploadId!, unresolvedFinalCount: 0 });
  assert.equal(acknowledged.status, 'updated');
  if (acknowledged.status === 'updated') { assert.equal(acknowledged.record.status, 'completed'); assert.equal(acknowledged.record.liveTranscriptDelivery, undefined); assert.equal(acknowledged.record.endedAt, completed.endedAt); }
  updateRecallTranscriptDelivery({ windowId: input.windowId, sdkUploadId: input.sdkUploadId!, unresolvedFinalCount: 1 });
  const marked = loadRecallMeetingById(completed.id)!;
  assert.equal(marked.liveTranscriptDelivery?.failedFinalCount, 1);
  const canonical = applyCanonicalTranscript(marked, [{ id: 'delivery-status-canonical', windowId: input.windowId, event: 'transcript.canonical', isFinal: true,
    text: 'The canonical fixture transcript is retained.', timestamp: '2026-10-17T12:00:00.000Z' }]).record;
  assert.equal(canonical.liveTranscriptDelivery, undefined);
  const afterCanonical = updateRecallTranscriptDelivery({ windowId: input.windowId, sdkUploadId: input.sdkUploadId!, unresolvedFinalCount: 1 });
  assert.equal(afterCanonical.status, 'updated');
  if (afterCanonical.status === 'updated') assert.equal(afterCanonical.record.liveTranscriptDelivery, undefined);
  assert.equal(loadRecallMeetingById(completed.id)?.status, 'completed');
});

test('a synchronous first final can activate an already-detected exact SDK capture', () => {
  const input = identifiedFinal('detected-final-window', 'detected-final-upload');
  noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, status: 'detected' });
  const result = ingestRecallTranscriptSegment(input);
  assert.equal(result.status, 'accepted');
  if (result.status === 'accepted') assert.equal(result.record.status, 'recording');
});

test('an identified late final extends only its completed streamed capture and keeps its status', () => {
  const input = identifiedFinal('late-final-window', 'late-final-upload');
  noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, status: 'recording' });
  ingestRecallTranscriptSegment(input);
  const stopped = finalizeRecallMeeting({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, retentionMode: 'zero' });
  const late = ingestRecallTranscriptSegment({ ...input, eventId: `recall-final-${'c'.repeat(64)}`, text: 'The last slow utterance', sourceStartSeconds: 30, sourceEndSeconds: 31 });
  assert.equal(late.status, 'accepted');
  if (late.status === 'accepted') {
    assert.equal(late.record.status, 'completed');
    assert.equal(late.meetingId, stopped.record.id);
    assert.equal(late.record.segments.length, 2);
    assert.match(readFileSync(late.record.artifactPath!, 'utf-8'), /last slow utterance/);
  }
  const legacy = ingestRecallTranscriptSegment({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, event: 'transcript.data', text: 'An unkeyed late callback' });
  assert.equal(legacy.status, 'ignored');
});

test('canonical replacement preserves exact final replay receipts and refuses new late streamed content', () => {
  const input = identifiedFinal('canonical-receipt-window', 'canonical-receipt-upload');
  noteRecallMeetingDetected({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, status: 'recording' });
  ingestRecallTranscriptSegment(input);
  const stopped = finalizeRecallMeeting({ windowId: input.windowId, sdkUploadId: input.sdkUploadId, retentionMode: 'timed' });
  const inFlightFinal = { ...input, eventId: `recall-final-${'e'.repeat(64)}`, text: 'Arrived while backfill was waiting', sourceStartSeconds: 30, sourceEndSeconds: 31 };
  assert.equal(ingestRecallTranscriptSegment(inFlightFinal).status, 'accepted');
  // Deliberately pass the older snapshot held by an async backfill worker.
  const canonical = applyCanonicalTranscript(stopped.record, [{ id: 'canonical-1', windowId: input.windowId, event: 'canonical', text: 'Canonical source content', timestamp: '2026-10-17T12:00:00.000Z' }]);
  assert.equal(ingestRecallTranscriptSegment(input).status, 'duplicate');
  assert.equal(ingestRecallTranscriptSegment(inFlightFinal).status, 'duplicate', 'backfill must retain receipts accepted after its snapshot');
  const late = ingestRecallTranscriptSegment({ ...input, eventId: `recall-final-${'d'.repeat(64)}` });
  assert.equal(late.status, 'ignored');
  assert.deepEqual(loadRecallMeetingById(canonical.record.id)?.segments, canonical.record.segments);
  assert.doesNotMatch(readFileSync(canonical.artifactPath!, 'utf-8'), /controlled final utterance/);
});

test('legacy finals remain explicitly qualified and require one already-active window', () => {
  noteRecallMeetingDetected({ windowId: 'legacy-known-window', status: 'recording' });
  const record = appendRecallTranscriptSegment({ windowId: 'legacy-known-window', event: 'transcript.data', text: 'Legacy compatible final' });
  assert.equal(record.segments[0].eventIdentity, 'legacy');
  assert.equal(record.segments[0].eventId, undefined);
  const partial = ingestRecallTranscriptSegment({ windowId: record.windowId, event: 'transcript.data', isFinal: false, text: 'Not final' });
  assert.equal(partial.status, 'ignored');
  assert.equal(loadRecallMeetingById(record.id)?.segments.length, 1);
});

test('fileMeetingFromAnalysis folds title + analysis into the note, idempotently, and keeps the transcript', () => {
  const windowId = 'win-onboarding';
  noteRecallMeetingDetected({ windowId, status: 'recording' });
  // Transcript text is deliberately distinct from the analysis summary so
  // we can prove the curated summary (not just the raw transcript) becomes
  // searchable.
  appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Host',
    text: 'alright lets get the screen share going',
  });
  const { record, artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom' });
  assert.ok(artifactPath, 'finalize should write a vault artifact');

  saveRecallMeetingAnalysis(record.id, {
    title: 'Clementine onboarding walkthrough',
    summary: 'Walked the guest through installing the desktop app and connecting Salesforce.',
    decisions: ['Skip Discord setup for now'],
    actionItems: [{ text: 'Send the patch build', owner: 'Host', dueDate: '2026-05-27' }],
    topics: ['onboarding', 'salesforce'],
    participants: ['Host', 'Guest'],
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });

  const changed = fileMeetingFromAnalysis(record.id);
  assert.equal(changed, true, 'first filing should rewrite the note');

  const filed = readFileSync(artifactPath as string, 'utf-8');
  assert.match(filed, /^title: Clementine onboarding walkthrough$/m, 'title in frontmatter');
  assert.match(filed, /^# Clementine onboarding walkthrough$/m, 'title in heading');
  assert.match(filed, /## Summary/);
  assert.match(filed, /installing the desktop app and connecting Salesforce/);
  assert.match(filed, /## Action Items/);
  assert.match(filed, /Send the patch build \(owner: Host, due: 2026-05-27\)/);
  assert.match(filed, /## Topics\nonboarding, salesforce/);
  // Transcript preserved verbatim.
  assert.match(filed, /alright lets get the screen share going/);

  // Title persisted onto the record so the dashboard list shows it.
  assert.equal(loadRecallMeetingById(record.id)?.title, 'Clementine onboarding walkthrough');

  const episode = openMemoryDb().prepare(`
    SELECT subtype, title, evidence_excerpt, metadata_json
    FROM memory_episodes WHERE subtype = 'meeting' AND call_id = ?
  `).get(record.id) as { subtype: string; title: string; evidence_excerpt: string; metadata_json: string } | undefined;
  assert.ok(episode, 'Recall recording is projected into the durable episode store');
  assert.equal(episode?.title, 'Clementine onboarding walkthrough');
  assert.match(episode?.evidence_excerpt ?? '', /installing the desktop app and connecting Salesforce/);
  assert.equal((JSON.parse(episode?.metadata_json ?? '{}') as { provider?: string }).provider, 'recall');
  const episodeCount = (openMemoryDb().prepare(
    `SELECT COUNT(*) AS c FROM memory_episodes WHERE subtype = 'meeting' AND call_id = ?`,
  ).get(record.id) as { c: number }).c;
  assert.equal(episodeCount, 1, 'analysis and title updates amend one stable meeting episode');
  const genericObservationCount = (openMemoryDb().prepare(`
    SELECT COUNT(*) AS c FROM entity_observations eo
    JOIN memory_episodes me ON me.id = eo.episode_id
    WHERE me.call_id = ?
  `).get(record.id) as { c: number }).c;
  assert.equal(genericObservationCount, 0, 'generic Host/Guest role labels never become people');

  // Idempotent: re-filing the same analysis is a no-op.
  assert.equal(fileMeetingFromAnalysis(record.id), false, 'second filing should be a no-op');

  // The curated summary is now searchable via the vault index even though
  // "Salesforce" never appears in the raw transcript.
  const stats = reindexVault();
  assert.equal(stats.errors, 0);
  const rows = openMemoryDb().prepare(
    'SELECT content FROM vault_chunks WHERE path = ?',
  ).all(artifactPath) as Array<{ content: string }>;
  const joined = rows.map((r) => r.content).join('\n');
  assert.match(joined, /connecting Salesforce/, 'summary content should be indexed');
});

test('named meeting participants become replay-safe canonical source observations', () => {
  assert.deepEqual(
    groundedMeetingParticipantNames({
      participants: ['Host', 'Speaker 2', 'Guest: Dana Rivera', 'Dana Rivera', 'Morgan Lee (speaker 3)', 'Unknown'],
      generatedAt: new Date().toISOString(),
      source: 'agent',
    }),
    ['Dana Rivera', 'Morgan Lee'],
  );

  const windowId = 'win-named-participants';
  noteRecallMeetingDetected({ windowId, status: 'recording' });
  appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Dana Rivera',
    text: 'Morgan and I reviewed the launch risks.',
  });
  const { record } = finalizeRecallMeeting({ windowId, platform: 'in-person' });
  saveRecallMeetingAnalysis(record.id, {
    title: 'Launch risk review',
    summary: 'Dana and Morgan reviewed launch risks.',
    participants: ['Dana Rivera', 'Speaker 2', 'Morgan Lee', 'dana rivera'],
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });

  const episode = openMemoryDb().prepare(`
    SELECT id FROM memory_episodes WHERE subtype = 'meeting' AND call_id = ?
  `).get(record.id) as { id: string };
  const observations = openMemoryDb().prepare(`
    SELECT e.canonical_name, eo.source_kind, eo.confidence
    FROM entity_observations eo
    JOIN entities e ON e.id = eo.entity_id
    WHERE eo.episode_id = ?
    ORDER BY e.canonical_name
  `).all(episode.id) as Array<{ canonical_name: string; source_kind: string; confidence: number }>;
  assert.deepEqual(observations, [
    { canonical_name: 'Dana Rivera', source_kind: 'meeting_participant', confidence: 0.82 },
    { canonical_name: 'Morgan Lee', source_kind: 'meeting_participant', confidence: 0.82 },
  ]);

  // Replaying the same analysis is exactly-once; correcting it removes only
  // this episode's obsolete participant observation, not the identity row.
  saveRecallMeetingAnalysis(record.id, {
    title: 'Launch risk review',
    summary: 'Morgan reviewed launch risks.',
    participants: ['Morgan Lee'],
    generatedAt: new Date().toISOString(),
    source: 'manual',
  });
  const corrected = openMemoryDb().prepare(`
    SELECT e.canonical_name, eo.confidence
    FROM entity_observations eo
    JOIN entities e ON e.id = eo.entity_id
    WHERE eo.episode_id = ?
  `).all(episode.id) as Array<{ canonical_name: string; confidence: number }>;
  assert.deepEqual(corrected, [{ canonical_name: 'Morgan Lee', confidence: 0.95 }]);
  assert.equal((openMemoryDb().prepare(`
    SELECT COUNT(*) AS c FROM entities WHERE canonical_name_lc = 'dana rivera'
  `).get() as { c: number }).c, 1, 'identity history remains even when one episode observation is corrected');
});

test('meeting decisions and actions become replay-safe review proposals, not automatic facts', () => {
  const windowId = 'win-reviewable-meeting-memory';
  noteRecallMeetingDetected({ windowId, status: 'recording' });
  appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Dana Rivera',
    text: 'We decided to launch Friday. Morgan will send the migration checklist tomorrow.',
  });
  const { record } = finalizeRecallMeeting({ windowId, platform: 'in-person', title: 'Orchid launch review' });
  const firstAnalysis = {
    title: 'Orchid launch review',
    summary: 'The team reviewed launch readiness.',
    decisions: ['Launch the Orchid migration on Friday'],
    actionItems: [{ text: 'Send the migration checklist', owner: 'Morgan Lee', dueDate: '2026-07-16' }],
    topics: ['launch', 'migration'],
    participants: ['Dana Rivera', 'Morgan Lee'],
    generatedAt: '2026-07-15T18:00:00.000Z',
    source: 'agent' as const,
  };
  assert.equal(meetingMemoryProposals(record, firstAnalysis).length, 2);
  saveRecallMeetingAnalysis(record.id, firstAnalysis);

  const db = openMemoryDb();
  const episode = db.prepare(`SELECT id FROM memory_episodes WHERE subtype = 'meeting' AND call_id = ?`).get(record.id) as { id: string };
  const first = db.prepare(`
    SELECT text, status, source_type, episode_id
    FROM memory_reflection_candidates WHERE episode_id = ? ORDER BY text
  `).all(episode.id) as Array<{ text: string; status: string; source_type: string; episode_id: string }>;
  assert.equal(first.length, 2);
  assert.ok(first.every((row) => row.status === 'pending' && row.source_type === 'meeting_analysis'));
  assert.ok(first.every((row) => row.episode_id === episode.id));
  assert.match(first.map((row) => row.text).join('\n'), /Decision from Orchid launch review/);
  assert.match(first.map((row) => row.text).join('\n'), /Action item from Orchid launch review/);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count, 0,
    'derived meeting analysis waits for owner review instead of silently becoming canonical truth');

  saveRecallMeetingAnalysis(record.id, firstAnalysis);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memory_reflection_candidates WHERE episode_id = ?').get(episode.id) as { count: number }).count, 2,
    'replaying identical analyzer output creates no duplicate proposals');

  saveRecallMeetingAnalysis(record.id, {
    ...firstAnalysis,
    decisions: [],
    actionItems: [{ text: 'Send the final migration checklist', owner: 'Morgan Lee' }],
    generatedAt: '2026-07-15T18:05:00.000Z',
  });
  const corrected = db.prepare(`
    SELECT status, reason, text FROM memory_reflection_candidates
    WHERE episode_id = ? ORDER BY id
  `).all(episode.id) as Array<{ status: string; reason: string | null; text: string }>;
  assert.equal(corrected.filter((row) => row.status === 'pending').length, 1);
  assert.equal(corrected.filter((row) => row.status === 'rejected' && row.reason === 'analysis_revision_removed').length, 2);
  assert.match(corrected.find((row) => row.status === 'pending')?.text ?? '', /final migration checklist/);
});

test('renameMeeting sets a user title that the analyzer cannot overwrite', () => {
  const windowId = 'win-rename';
  noteRecallMeetingDetected({ windowId, status: 'recording' });
  appendRecallTranscriptSegment({ windowId, event: 'transcript.data', speaker: 'Host', text: 'quarterly numbers look good' });
  const { record, artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom' });
  assert.ok(artifactPath);

  // User renames the meeting.
  assert.equal(renameMeeting(record.id, 'Q3 Board Review'), true);
  const afterRename = loadRecallMeetingById(record.id);
  assert.equal(afterRename?.title, 'Q3 Board Review');
  assert.equal(afterRename?.titleSource, 'user');
  assert.match(readFileSync(artifactPath as string, 'utf-8'), /^title: Q3 Board Review$/m);

  // A later analyzer pass with a DIFFERENT title must not clobber it.
  saveRecallMeetingAnalysis(record.id, {
    title: 'Some Auto Generated Title',
    summary: 'Reviewed quarterly performance.',
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });
  fileMeetingFromAnalysis(record.id);
  const afterAnalysis = loadRecallMeetingById(record.id);
  assert.equal(afterAnalysis?.title, 'Q3 Board Review', 'user title must survive analyzer filing');
  assert.equal(afterAnalysis?.titleSource, 'user');
  // But the analyzer's summary still gets folded in (searchable).
  assert.match(readFileSync(artifactPath as string, 'utf-8'), /Reviewed quarterly performance/);
});

test('live transcript refresh preserves a user title lock', () => {
  const windowId = 'win-live-rename';
  noteRecallMeetingDetected({ windowId, status: 'recording' });
  const initial = appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Host',
    text: 'lets talk about client follow up',
  });
  assert.ok(recordMeetingTitle(initial.id, 'Client Follow-up', 'user'));

  appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Guest',
    text: 'next steps are clear',
  });
  const afterRefresh = loadRecallMeetingById(initial.id);
  assert.equal(afterRefresh?.title, 'Client Follow-up');
  assert.equal(afterRefresh?.titleSource, 'user');

  const { artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom' });
  assert.ok(artifactPath);
  saveRecallMeetingAnalysis(initial.id, {
    title: 'Auto Analyzer Title',
    summary: 'Discussed client follow-up next steps.',
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });
  fileMeetingFromAnalysis(initial.id);

  const afterAnalysis = loadRecallMeetingById(initial.id);
  assert.equal(afterAnalysis?.title, 'Client Follow-up');
  assert.equal(afterAnalysis?.titleSource, 'user');
  assert.match(readFileSync(artifactPath as string, 'utf-8'), /^# Client Follow-up$/m);
});

test('buildMeetingChatPrompt requires the full transcript and asks for next action', () => {
  const windowId = 'win-chat-prompt';
  noteRecallMeetingDetected({ windowId, status: 'recording' });
  appendRecallTranscriptSegment({
    windowId,
    event: 'transcript.data',
    speaker: 'Alex',
    text: 'we need to follow up with the design partner after the onboarding call',
  });
  const { record, artifactPath } = finalizeRecallMeeting({ windowId, platform: 'zoom', title: 'Design partner onboarding' });
  assert.ok(artifactPath);

  saveRecallMeetingAnalysis(record.id, {
    title: 'Design Partner Onboarding',
    summary: 'Discussed onboarding, follow-up, and several large, long-running matters.',
    actionItems: [{ text: 'Follow up with the design partner', owner: 'Alex' }],
    generatedAt: new Date().toISOString(),
    source: 'agent',
  });

  const prompt = buildMeetingChatPrompt(loadRecallMeetingById(record.id)!);
  assert.match(prompt, /Read the FULL transcript end-to-end/);
  assert.match(prompt, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /What would you like me to act on/);
  assert.match(prompt, /likely follow-up tasks/i);
  assert.match(prompt, /Do not refer to yourself as Clementine/i);
  assert.match(prompt, /Do not send messages, schedule events, update sheets, or create tasks/);
  assert.equal(
    shouldPromoteToDurable(prompt),
    false,
    'embedded meeting-summary wording must never move Discuss in chat to the background',
  );
});

test('two SDK uploads in one reused window remain distinct before reconciliation', () => {
  const windowId = 'reused-native-window';
  const first = noteRecallMeetingDetected({
    windowId,
    sdkUploadId: 'same-window-upload-1',
    status: 'recording',
    startedAt: '2026-07-13T10:00:00.000Z',
  });
  appendRecallTranscriptSegment({
    windowId,
    sdkUploadId: 'same-window-upload-1',
    event: 'transcript.data',
    text: 'first sequential meeting',
  });
  finalizeRecallMeeting({
    windowId,
    sdkUploadId: 'same-window-upload-1',
    retentionMode: 'zero',
    canonicalBackfill: false,
  });

  const second = noteRecallMeetingDetected({
    windowId,
    sdkUploadId: 'same-window-upload-2',
    status: 'recording',
    startedAt: '2026-07-13T11:00:00.000Z',
  });
  appendRecallTranscriptSegment({
    windowId,
    sdkUploadId: 'same-window-upload-2',
    event: 'transcript.data',
    text: 'second sequential meeting',
  });
  finalizeRecallMeeting({
    windowId,
    sdkUploadId: 'same-window-upload-2',
    retentionMode: 'zero',
    canonicalBackfill: false,
  });

  assert.notEqual(first.id, second.id);
  assert.equal(findRecallMeetingRecord({ sdkUploadId: 'same-window-upload-1' })?.id, first.id);
  assert.equal(findRecallMeetingRecord({ sdkUploadId: 'same-window-upload-2' })?.id, second.id);
  assert.deepEqual(
    findRecallMeetingRecord({ sdkUploadId: 'same-window-upload-1' })?.segments.map((segment) => segment.text),
    ['first sequential meeting'],
  );
  assert.deepEqual(
    findRecallMeetingRecord({ sdkUploadId: 'same-window-upload-2' })?.segments.map((segment) => segment.text),
    ['second sequential meeting'],
  );
  const records = listAllRecallMeetingRecords().filter((record) => record.windowId === windowId);
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map((record) => record.sdkUploadId)), new Set([
    'same-window-upload-1',
    'same-window-upload-2',
  ]));
  assert.deepEqual(new Set(records.map((record) => record.startedAt)), new Set([
    '2026-07-13T10:00:00.000Z',
    '2026-07-13T11:00:00.000Z',
  ]));
});

test('Recall summary derives transcript truth instead of presenting failed canonical work as Done', () => {
  const failed = summarizeRecallMeeting({
    id: 'recall-failed-summary',
    windowId: 'failed-summary-window',
    provider: 'recall',
    source: 'recall-desktop-sdk',
    status: 'completed',
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:30:00.000Z',
    sdkUploadId: 'sdk-failed-summary',
    sdkUploadStatus: 'complete',
    recordingId: 'recording-failed-summary',
    recallRetentionMode: 'timed',
    canonicalStatus: 'failed',
    canonicalError: 'canonical transcript came back empty',
    segments: [],
  });

  assert.deepEqual(failed.presentation, {
    status: 'failed',
    label: 'Transcript failed',
    error: 'canonical transcript came back empty',
    retryable: true,
  });

  const timedOut = summarizeRecallMeeting({
    id: 'recall-timeout-summary',
    windowId: 'timeout-summary-window',
    provider: 'recall',
    source: 'recall-desktop-sdk',
    status: 'completed',
    startedAt: '2026-07-20T13:00:00.000Z',
    endedAt: '2026-07-20T13:30:00.000Z',
    sdkUploadId: 'sdk-timeout-summary',
    sdkUploadStatus: 'timed_out',
    sdkUploadError: 'Recall SDK upload reconciliation timed out after 180 attempts',
    canonicalStatus: 'timed_out',
    canonicalError: 'Recall SDK upload reconciliation timed out after 180 attempts',
    segments: [],
  });

  assert.deepEqual(timedOut.presentation, {
    status: 'timed_out',
    label: 'Upload timed out',
    error: 'Recall SDK upload reconciliation timed out after 180 attempts',
    retryable: true,
  });

  const emptyReady = summarizeRecallMeeting({
    id: 'recall-empty-ready-summary',
    windowId: 'empty-ready-summary-window',
    provider: 'recall',
    source: 'recall-desktop-sdk',
    status: 'completed',
    startedAt: '2026-07-20T13:30:00.000Z',
    endedAt: '2026-07-20T13:45:00.000Z',
    sdkUploadId: 'sdk-empty-ready-summary',
    sdkUploadStatus: 'complete',
    recordingId: 'recording-empty-ready-summary',
    recallRetentionMode: 'timed',
    canonicalStatus: 'ready',
    segments: [],
  });
  assert.deepEqual(emptyReady.presentation, {
    status: 'failed',
    label: 'Transcript empty',
    error: 'Recall returned an empty transcript.',
    retryable: true,
  });

  const legacyCanonicalFailure = summarizeRecallMeeting({
    id: 'recall-legacy-failed-summary',
    windowId: 'legacy-failed-summary-window',
    provider: 'recall',
    source: 'recall-desktop-sdk',
    status: 'completed',
    startedAt: '2026-07-20T13:45:00.000Z',
    endedAt: '2026-07-20T14:00:00.000Z',
    sdkUploadId: 'legacy-sdk-without-status',
    recordingId: 'legacy-recording-without-sdk-status',
    canonicalStatus: 'failed',
    canonicalError: 'legacy canonical failure',
    segments: [],
  });
  assert.equal(legacyCanonicalFailure.presentation?.status, 'failed');
  assert.equal(legacyCanonicalFailure.presentation?.error, 'legacy canonical failure');
});

test('legacy Recall recordings without canonical state remain recoverable unless zero retention was explicit', () => {
  const legacy = summarizeRecallMeeting({
    id: 'recall-legacy-missing-canonical-state',
    windowId: 'legacy-missing-canonical-state-window',
    provider: 'recall',
    source: 'recall-desktop-sdk',
    status: 'completed',
    startedAt: '2026-07-19T12:00:00.000Z',
    endedAt: '2026-07-19T12:30:00.000Z',
    recordingId: 'legacy-recording-without-canonical-state',
    segments: [],
  });
  assert.deepEqual(legacy.presentation, {
    status: 'unavailable',
    label: 'Transcript unavailable',
    error: 'The canonical transcript has not been retrieved yet.',
    retryable: true,
  });

  const zeroRetention = summarizeRecallMeeting({
    id: 'recall-zero-retention-missing-canonical-state',
    windowId: 'zero-retention-missing-canonical-state-window',
    provider: 'recall',
    source: 'recall-desktop-sdk',
    status: 'completed',
    startedAt: '2026-07-19T13:00:00.000Z',
    endedAt: '2026-07-19T13:30:00.000Z',
    recordingId: 'zero-retention-recording-without-canonical-state',
    recallRetentionMode: 'zero',
    segments: [],
  });
  assert.equal(zeroRetention.presentation?.retryable, false);
  assert.match(zeroRetention.presentation?.error ?? '', /Zero-retention meetings cannot be recovered/);
});

test('Recall summary reports ready only for a usable transcript and leaves local presentation unchanged', () => {
  const ready = summarizeRecallMeeting({
    id: 'recall-ready-summary',
    windowId: 'ready-summary-window',
    provider: 'recall',
    source: 'recall-desktop-sdk',
    status: 'completed',
    startedAt: '2026-07-20T14:00:00.000Z',
    endedAt: '2026-07-20T14:30:00.000Z',
    sdkUploadId: 'sdk-ready-summary',
    sdkUploadStatus: 'complete',
    recordingId: 'recording-ready-summary',
    recallRetentionMode: 'timed',
    canonicalStatus: 'ready',
    segments: [{
      id: 'segment-ready-summary',
      windowId: 'ready-summary-window',
      recordingId: 'recording-ready-summary',
      event: 'transcript.canonical',
      text: 'The canonical transcript is usable.',
      timestamp: '2026-07-20T14:00:00.000Z',
      isFinal: true,
    }],
  });
  assert.equal(ready.presentation?.status, 'ready');
  assert.equal(ready.presentation?.label, 'Transcribed');
  assert.equal(ready.presentation?.retryable, false);

  const local = summarizeRecallMeeting({
    id: 'local-ready-summary',
    windowId: 'local:ready-summary',
    provider: 'local',
    source: 'local-audio',
    status: 'completed',
    startedAt: '2026-07-20T15:00:00.000Z',
    endedAt: '2026-07-20T15:30:00.000Z',
    transcriptionStatus: 'ready',
    segments: [],
  });
  assert.equal(local.presentation, undefined, 'local meeting UI remains driven by local transcriptionStatus');
});
