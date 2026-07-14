/**
 * Run: npx tsx --test src/integrations/local-meetings/meeting-capture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-local-meeting-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const local = await import('./meeting-capture.js');
const shared = await import('../recall/meeting-capture.js');

async function waitForStatus(meetingId: string, status: string): Promise<ReturnType<typeof shared.loadRecallMeetingById>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const record = shared.loadRecallMeetingById(meetingId);
    if (record?.transcriptionStatus === status) return record;
    await delay(10);
  }
  assert.fail(`meeting ${meetingId} did not reach ${status}`);
}

function writeFakeWav(filePath: string): void {
  writeFileSync(filePath, Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt fake audio payload'));
}

test.before(() => {
  local.saveLocalMeetingSettings({ enabled: true, analyzeOnComplete: false, keepAudio: true });
});

test.after(() => {
  local._setLocalMeetingTranscriberForTests(null);
  local._setLocalMeetingAudioDeleterForTests(null);
  local._setLocalMeetingAnalysisTaskCreatorForTests(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('local settings PATCH semantics preserve omitted values', () => {
  const first = local.saveLocalMeetingSettings({
    enabled: true,
    analyzeOnComplete: false,
    keepAudio: true,
  });
  assert.equal(first.enabled, true);
  assert.equal(first.analyzeOnComplete, false);

  const second = local.saveLocalMeetingSettings({ language: 'en' });
  assert.equal(second.enabled, true);
  assert.equal(second.analyzeOnComplete, false);
  assert.equal(second.keepAudio, true);
  assert.equal(second.language, 'en');
});

test('local path validation blocks traversal and symlink escape', () => {
  assert.throws(
    () => local.startLocalMeeting({ sessionId: 'escape', audioPath: path.join(TMP_HOME, 'outside.wav') }),
    /inside Clementine local-audio storage/,
  );

  const outside = path.join(TMP_HOME, 'outside-real.wav');
  writeFakeWav(outside);
  const link = path.join(local.LOCAL_MEETING_AUDIO_DIR, 'linked.wav');
  symlinkSync(outside, link);
  assert.throws(() => local.validateLocalAudioPath(link, true), /inside Clementine local-audio storage/);
});

test('ingest writes a shared transcript artifact and is idempotent', async () => {
  let calls = 0;
  local._setLocalMeetingTranscriberForTests(async () => {
    calls += 1;
    return {
      text: 'We agreed to ship the onboarding patch.',
      segments: [{ text: 'We agreed to ship the onboarding patch.', startSeconds: 1, endSeconds: 4 }],
      model: 'base.en',
      language: 'en',
      durationSeconds: 5,
    };
  });
  const started = local.startLocalMeeting({
    sessionId: 'happy-path',
    title: 'Onboarding sync',
    startedAt: '2026-07-13T10:00:00.000Z',
    sampleRate: 16_000,
    channels: 1,
  });
  writeFakeWav(started.audioPath);
  const ingested = local.ingestLocalMeeting({
    sessionId: 'happy-path',
    audioPath: started.audioPath,
    endedAt: '2026-07-13T10:00:05.000Z',
    durationSeconds: 5,
  });
  assert.equal(ingested.record.provider, 'local');
  const ready = await waitForStatus(started.record.id, 'ready');
  assert.ok(ready?.artifactPath);
  assert.equal(ready?.canonicalStatus, 'not_started');
  assert.equal(ready?.transcriptionModel, 'base.en');
  assert.equal(ready?.audioDurationSeconds, 5);
  assert.equal(ready?.segments.length, 1);
  assert.equal(ready?.segments[0]?.timestamp, '2026-07-13T10:00:01.000Z');
  const artifact = readFileSync(ready!.artifactPath!, 'utf-8');
  assert.match(artifact, /^provider: local$/m);
  assert.match(artifact, /^source: local whisper \(base\.en\)$/m);
  assert.match(artifact, /We agreed to ship the onboarding patch/);

  // A completion retry after a response/network loss must not transcribe twice.
  local.ingestLocalMeeting({ sessionId: 'happy-path', audioPath: started.audioPath });
  await delay(20);
  assert.equal(calls, 1);
});

test('keepAudio=false durably records completed source-audio deletion', async () => {
  local.saveLocalMeetingSettings({ analyzeOnComplete: false, keepAudio: false });
  local._setLocalMeetingTranscriberForTests(async () => ({
    text: 'Private source audio can now be removed.',
    segments: [{ text: 'Private source audio can now be removed.', startSeconds: 0, endSeconds: 1 }],
    model: 'base.en',
    language: 'en',
  }));
  try {
    const started = local.startLocalMeeting({ sessionId: 'delete-audio-after-ready' });
    writeFakeWav(started.audioPath);
    local.ingestLocalMeeting({ sessionId: 'delete-audio-after-ready', audioPath: started.audioPath });
    const ready = await waitForStatus(started.record.id, 'ready');
    assert.equal(existsSync(started.audioPath), false);
    assert.equal(ready?.audioDeletionStatus, 'deleted');
    assert.equal(ready?.audioDeletionError, undefined);
    assert.equal(ready?.audioDeletionAttempts, 1);
    assert.equal(ready?.audioPath, undefined);
    assert.equal(ready?.audioBytes, undefined);
  } finally {
    local.saveLocalMeetingSettings({ analyzeOnComplete: false, keepAudio: true });
  }
});

test('failed source-audio deletion remains visible and retries durably', async () => {
  local.saveLocalMeetingSettings({ analyzeOnComplete: false, keepAudio: false });
  local._setLocalMeetingTranscriberForTests(async () => ({
    text: 'Deletion will retry after restart.',
    segments: [{ text: 'Deletion will retry after restart.', startSeconds: 0, endSeconds: 1 }],
    model: 'base.en',
    language: 'en',
  }));
  local._setLocalMeetingAudioDeleterForTests(() => {
    throw Object.assign(new Error('audio file is temporarily busy'), { code: 'EBUSY' });
  });
  try {
    const started = local.startLocalMeeting({ sessionId: 'retry-audio-deletion' });
    writeFakeWav(started.audioPath);
    local.ingestLocalMeeting({ sessionId: 'retry-audio-deletion', audioPath: started.audioPath });
    const ready = await waitForStatus(started.record.id, 'ready');
    assert.equal(ready?.transcriptionStatus, 'ready');
    assert.equal(ready?.audioDeletionStatus, 'failed');
    assert.match(ready?.audioDeletionError ?? '', /temporarily busy/);
    assert.equal(existsSync(started.audioPath), true);
    const surfaced = shared.summarizeRecallMeeting(ready!);
    assert.equal(surfaced.audioDeletionStatus, 'failed');
    assert.match(surfaced.audioDeletionError ?? '', /temporarily busy/);

    local._setLocalMeetingAudioDeleterForTests(null);
    const recovery = local.recoverPendingLocalAudioDeletions({ force: true });
    assert.equal(recovery.discovered >= 1, true);
    assert.equal(recovery.deleted >= 1, true);
    const deleted = shared.loadRecallMeetingById(started.record.id);
    assert.equal(deleted?.transcriptionStatus, 'ready');
    assert.equal(deleted?.audioDeletionStatus, 'deleted');
    assert.equal(deleted?.audioDeletionAttempts, 2);
    assert.equal(deleted?.audioPath, undefined);
    assert.equal(existsSync(started.audioPath), false);
  } finally {
    local._setLocalMeetingAudioDeleterForTests(null);
    local.saveLocalMeetingSettings({ analyzeOnComplete: false, keepAudio: true });
  }
});

test('analysis scheduling failure never downgrades a ready transcript', async () => {
  local.saveLocalMeetingSettings({ analyzeOnComplete: true, keepAudio: true });
  local._setLocalMeetingTranscriberForTests(async () => ({
    text: 'The transcript succeeded before optional analysis.',
    segments: [{ text: 'The transcript succeeded before optional analysis.', startSeconds: 0, endSeconds: 1 }],
    model: 'base.en',
    language: 'en',
  }));
  local._setLocalMeetingAnalysisTaskCreatorForTests(() => {
    throw new Error('analysis scheduler unavailable');
  });
  try {
    const started = local.startLocalMeeting({ sessionId: 'analysis-schedule-failure' });
    writeFakeWav(started.audioPath);
    local.ingestLocalMeeting({ sessionId: 'analysis-schedule-failure', audioPath: started.audioPath });
    const ready = await waitForStatus(started.record.id, 'ready');
    assert.equal(ready?.transcriptionStatus, 'ready');
    assert.equal(ready?.segments[0]?.text, 'The transcript succeeded before optional analysis.');
    assert.equal(ready?.analysisTaskId, undefined);
    assert.match(ready?.analysisError ?? '', /scheduler unavailable/);
    assert.ok(ready?.analysisUpdatedAt);
    assert.match(shared.summarizeRecallMeeting(ready!).analysisError ?? '', /scheduler unavailable/);
  } finally {
    local._setLocalMeetingAnalysisTaskCreatorForTests(null);
    local.saveLocalMeetingSettings({ analyzeOnComplete: false, keepAudio: true });
  }
});

test('the transcription queue runs only one local model at a time', async () => {
  let active = 0;
  let maxActive = 0;
  local._setLocalMeetingTranscriberForTests(async ({ audioPath }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(30);
    active -= 1;
    return {
      text: path.basename(audioPath),
      segments: [{ text: path.basename(audioPath), startSeconds: 0, endSeconds: 1 }],
      model: 'base.en',
      language: 'en',
    };
  });
  const one = local.startLocalMeeting({ sessionId: 'serial-one' });
  const two = local.startLocalMeeting({ sessionId: 'serial-two' });
  writeFakeWav(one.audioPath);
  writeFakeWav(two.audioPath);
  local.ingestLocalMeeting({ sessionId: 'serial-one', audioPath: one.audioPath });
  local.ingestLocalMeeting({ sessionId: 'serial-two', audioPath: two.audioPath });
  await Promise.all([
    waitForStatus(one.record.id, 'ready'),
    waitForStatus(two.record.id, 'ready'),
  ]);
  assert.equal(maxActive, 1);
});

test('failed audio remains available and an ingest retry succeeds', async () => {
  let shouldFail = true;
  local._setLocalMeetingTranscriberForTests(async () => {
    if (shouldFail) throw new Error('model temporarily unavailable');
    return {
      text: 'Recovered transcript',
      segments: [{ text: 'Recovered transcript', startSeconds: 0, endSeconds: 1 }],
      model: 'base.en',
      language: 'en',
    };
  });
  const started = local.startLocalMeeting({ sessionId: 'retry-after-failure' });
  writeFakeWav(started.audioPath);
  local.ingestLocalMeeting({ sessionId: 'retry-after-failure', audioPath: started.audioPath });
  const failed = await waitForStatus(started.record.id, 'failed');
  assert.match(failed?.transcriptionError ?? '', /temporarily unavailable/);
  assert.equal(existsSync(started.audioPath), true);

  shouldFail = false;
  local.retryLocalMeetingTranscription({ meetingId: started.record.id });
  const ready = await waitForStatus(started.record.id, 'ready');
  assert.equal(ready?.segments[0]?.text, 'Recovered transcript');
});

test('finalized Electron sidecar recreates a record after daemon outage', async () => {
  local._setLocalMeetingTranscriberForTests(async () => ({
    text: 'Transcript recovered from durable sidecar',
    segments: [{ text: 'Transcript recovered from durable sidecar', startSeconds: 0, endSeconds: 2 }],
    model: 'base.en',
    language: 'en',
  }));
  const sessionId = 'recovery123';
  const audioPath = path.join(local.LOCAL_MEETING_AUDIO_DIR, `local-${sessionId}.wav`);
  const sidecarPath = path.join(local.LOCAL_MEETING_AUDIO_DIR, `local-${sessionId}.json`);
  writeFakeWav(audioPath);
  writeFileSync(sidecarPath, JSON.stringify({
    sessionId,
    status: 'recorded',
    title: 'Recovered planning call',
    audioPath: path.join(TMP_HOME, 'untrusted-path-is-ignored.wav'),
    startedAt: '2026-07-13T12:00:00.000Z',
    endedAt: '2026-07-13T12:00:02.000Z',
    durationSeconds: 2,
  }));

  const recovery = local.recoverFinalizedLocalMeetingSidecars({ force: true });
  assert.equal(recovery.discovered >= 1, true);
  assert.equal(recovery.queued >= 1, true);
  const record = shared.findRecallMeetingRecord({ windowId: `local:${sessionId}` });
  assert.ok(record);
  assert.equal(record?.audioPath, local.validateLocalAudioPath(audioPath, true));
  const ready = await waitForStatus(record!.id, 'ready');
  assert.equal(ready?.segments[0]?.text, 'Transcript recovered from durable sidecar');
  unlinkSync(audioPath);
  const terminalScan = local.recoverFinalizedLocalMeetingSidecars({ force: true });
  assert.equal(terminalScan.errors, 0, 'ready record with intentionally deleted audio is terminal, not corrupt');
});

test('Recall stuck-recording reaper never finalizes an active local recording', () => {
  const started = local.startLocalMeeting({
    sessionId: 'long-local-recording',
    startedAt: '2020-01-01T00:00:00.000Z',
  });
  const reaped = shared.reapStuckRecallRecordings({ idleMs: 0 });
  assert.equal(reaped.some((entry) => entry.record.id === started.record.id), false);
  assert.equal(shared.loadRecallMeetingById(started.record.id)?.status, 'recording');
  local.cancelLocalMeeting('long-local-recording');
});

test('cancel removes an unfinished recording and is idempotent', () => {
  const started = local.startLocalMeeting({ sessionId: 'cancel-me' });
  writeFakeWav(started.audioPath);
  const cancelled = local.cancelLocalMeeting('cancel-me');
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.meetingId, started.record.id);
  assert.equal(existsSync(started.audioPath), false);
  assert.equal(shared.loadRecallMeetingById(started.record.id), null);
  assert.deepEqual(local.cancelLocalMeeting('cancel-me'), { cancelled: true });
});

// ── Transcript-only product decision + coherence fixes (2026-07-14) ──────────

test('transcript-only DEFAULT: keeping audio is the explicit opt-in', () => {
  assert.equal(local.DEFAULT_LOCAL_MEETING_SETTINGS.keepAudio, false);
  // Absent keepAudio normalizes to transcript-only…
  local.saveLocalMeetingSettings({ keepAudio: undefined });
  assert.equal(local.loadLocalMeetingSettings().keepAudio, false);
  // …and the explicit opt-in persists across unrelated patches.
  local.saveLocalMeetingSettings({ keepAudio: true });
  local.saveLocalMeetingSettings({ language: 'en' });
  assert.equal(local.loadLocalMeetingSettings().keepAudio, true);
});

test('default flow is transcript-only end to end: audio AND sidecar gone once the transcript is durable', async () => {
  // keepAudio deliberately ABSENT — this exercises the default path.
  local.saveLocalMeetingSettings({ enabled: true, analyzeOnComplete: false, keepAudio: undefined });
  local._setLocalMeetingTranscriberForTests(async () => ({
    text: 'Transcript only.',
    segments: [{ text: 'Transcript only.', startSeconds: 0, endSeconds: 1 }],
    model: 'base.en',
    language: 'en',
  }));
  try {
    const started = local.startLocalMeeting({ sessionId: 'transcript-only-default' });
    writeFakeWav(started.audioPath);
    const sidecarPath = path.join(local.LOCAL_MEETING_AUDIO_DIR, 'local-transcript-only-default.json');
    writeFileSync(sidecarPath, JSON.stringify({ sessionId: 'transcript-only-default', status: 'recorded' }));
    local.ingestLocalMeeting({ sessionId: 'transcript-only-default', audioPath: started.audioPath });
    const ready = await waitForStatus(started.record.id, 'ready');
    assert.ok(ready?.artifactPath, 'the transcript is durable');
    assert.equal(ready?.audioDeletionStatus, 'deleted', 'default is transcript-only: audio deleted after transcription');
    assert.equal(existsSync(started.audioPath), false, 'raw audio does not persist by default');
    assert.equal(existsSync(sidecarPath), false, 'crash-recovery sidecar is cleaned up with it');
  } finally {
    local.saveLocalMeetingSettings({ analyzeOnComplete: false, keepAudio: true });
  }
});

test('cancel removes the recovery sidecar; a cancelled record is never resurrected', () => {
  local.saveLocalMeetingSettings({ enabled: true, analyzeOnComplete: false, keepAudio: true });
  // Path 1: normal cancel — sidecar and audio both removed, nothing to recover.
  const started = local.startLocalMeeting({ sessionId: 'cancel-no-resurrect' });
  writeFakeWav(started.audioPath);
  const sidecarPath = path.join(local.LOCAL_MEETING_AUDIO_DIR, 'local-cancel-no-resurrect.json');
  writeFileSync(sidecarPath, JSON.stringify({ sessionId: 'cancel-no-resurrect', status: 'recorded' }));
  local.cancelLocalMeeting('cancel-no-resurrect');
  assert.equal(existsSync(sidecarPath), false, 'cancel deletes the recovery sidecar');
  assert.equal(existsSync(started.audioPath), false, 'cancel deletes the audio');

  // Path 2: the locked-file shape — record survives as cancelled while a stray
  // sidecar+WAV reappear on disk. Recovery must SKIP it (terminal user decision).
  const locked = local.startLocalMeeting({ sessionId: 'cancel-locked-skip' });
  writeFakeWav(locked.audioPath);
  shared.patchMeetingRecord(locked.record.id, {
    status: 'cancelled',
    transcriptionStatus: 'cancelled',
    transcriptionUpdatedAt: new Date().toISOString(),
  });
  const lockedSidecar = path.join(local.LOCAL_MEETING_AUDIO_DIR, 'local-cancel-locked-skip.json');
  writeFileSync(lockedSidecar, JSON.stringify({ sessionId: 'cancel-locked-skip', status: 'recorded' }));
  try {
    local.recoverFinalizedLocalMeetingSidecars({ force: true });
    const after = shared.loadRecallMeetingById(locked.record.id);
    assert.equal(after?.transcriptionStatus, 'cancelled', 'recovery must not resurrect a cancelled meeting');
  } finally {
    try { unlinkSync(lockedSidecar); } catch { /* already gone */ }
    try { unlinkSync(locked.audioPath); } catch { /* already gone */ }
  }
});

test('sidecar recovery is consent-gated: a disabled feature never auto-transcribes found audio', () => {
  local.saveLocalMeetingSettings({ enabled: false, analyzeOnComplete: false });
  const sessionId = 'consent-gate-check';
  const audioPath = path.join(local.LOCAL_MEETING_AUDIO_DIR, `local-${sessionId}.wav`);
  const sidecarPath = path.join(local.LOCAL_MEETING_AUDIO_DIR, `local-${sessionId}.json`);
  try {
    writeFakeWav(audioPath);
    writeFileSync(sidecarPath, JSON.stringify({ sessionId, status: 'recorded' }));
    const result = local.recoverFinalizedLocalMeetingSidecars({ force: true });
    assert.equal(result.discovered, 0, 'disabled feature: recovery must not even scan');
    assert.equal(result.queued, 0, 'disabled feature: nothing may be queued into memory');
  } finally {
    try { unlinkSync(sidecarPath); } catch { /* absent */ }
    try { unlinkSync(audioPath); } catch { /* absent */ }
    local.saveLocalMeetingSettings({ enabled: true, analyzeOnComplete: false, keepAudio: true });
  }
});

test('audio-deletion retries are bounded and exhaustion is surfaced exactly once', async () => {
  local.saveLocalMeetingSettings({ enabled: true, analyzeOnComplete: false, keepAudio: false });
  local._setLocalMeetingTranscriberForTests(async () => ({
    text: 'Bounded retries.',
    segments: [{ text: 'Bounded retries.', startSeconds: 0, endSeconds: 1 }],
    model: 'base.en',
    language: 'en',
  }));
  local._setLocalMeetingAudioDeleterForTests(() => {
    throw Object.assign(new Error('permanently locked'), { code: 'EBUSY' });
  });
  try {
    const started = local.startLocalMeeting({ sessionId: 'exhausted-cap' });
    writeFakeWav(started.audioPath);
    local.ingestLocalMeeting({ sessionId: 'exhausted-cap', audioPath: started.audioPath });
    await waitForStatus(started.record.id, 'ready'); // deletion attempt 1 fails
    let surfaced = 0;
    for (let i = 0; i < local.MAX_LOCAL_AUDIO_DELETION_ATTEMPTS + 3; i += 1) {
      const r = local.recoverPendingLocalAudioDeletions({ force: true });
      surfaced += r.exhausted.filter((e) => e.meetingId === started.record.id).length;
    }
    assert.equal(surfaced, 1, 'crossing the cap is surfaced exactly once (durable marker)');
    const record = shared.loadRecallMeetingById(started.record.id);
    assert.match(record?.audioDeletionError ?? '', /retries exhausted/);
    assert.ok((record?.audioDeletionAttempts ?? 0) <= local.MAX_LOCAL_AUDIO_DELETION_ATTEMPTS + 1, 'attempts stop growing after the cap');
  } finally {
    local._setLocalMeetingAudioDeleterForTests(null);
    local.saveLocalMeetingSettings({ analyzeOnComplete: false, keepAudio: true });
  }
});
