import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import {
  createPcmWavHeader,
  LocalMeetingRecorder,
  LOCAL_MEETING_SAMPLE_RATE,
  STALE_CAPTURE_AFTER_MS,
} from './local-meeting-recorder.js';

async function withRecorder(
  run: (recorder: LocalMeetingRecorder, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clementine-local-meeting-'));
  let tick = 0;
  const recorder = new LocalMeetingRecorder({
    rootDir: root,
    createId: () => 'test-session-1234',
    now: () => new Date(Date.UTC(2026, 6, 13, 12, 0, tick++)),
  });
  try {
    await run(recorder, root);
  } finally {
    await recorder.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

test('createPcmWavHeader describes 16 kHz mono signed PCM', () => {
  const header = createPcmWavHeader(64_000);
  assert.equal(header.byteLength, 44);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(4), 64_036);
  assert.equal(header.toString('ascii', 8, 12), 'WAVE');
  assert.equal(header.readUInt16LE(20), 1);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), LOCAL_MEETING_SAMPLE_RATE);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.toString('ascii', 36, 40), 'data');
  assert.equal(header.readUInt32LE(40), 64_000);
});

test('streams PCM to a finalized WAV without retaining the meeting in memory', async () => {
  await withRecorder(async (recorder) => {
    const started = await recorder.start({ title: '  Weekly\nplanning  ' });
    assert.equal(started.recording, true);
    assert.equal(started.title, 'Weekly planning');
    assert.equal(started.sessionId, 'test-session-1234');

    const first = new Int16Array([0, 1, -1, 32_767, -32_768]);
    const second = new Int16Array(LOCAL_MEETING_SAMPLE_RATE - first.length);
    second.fill(123);
    await Promise.all([
      recorder.append(started.sessionId!, first),
      recorder.append(started.sessionId!, second.buffer),
    ]);

    const result = await recorder.stop(started.sessionId!);
    assert.equal(result.bytes, LOCAL_MEETING_SAMPLE_RATE * 2);
    assert.equal(result.durationSeconds, 1);
    assert.equal(result.title, 'Weekly planning');
    assert.equal(recorder.status().recording, false);

    const wav = await readFile(result.audioPath);
    assert.equal(wav.byteLength, 44 + result.bytes);
    assert.equal(wav.readUInt32LE(40), result.bytes);
    assert.equal(wav.readInt16LE(44), 0);
    assert.equal(wav.readInt16LE(46), 1);
    assert.equal(wav.readInt16LE(48), -1);

    const metadata = JSON.parse(await readFile(result.audioPath.replace(/\.wav$/, '.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(metadata.status, 'recorded');
    assert.equal(metadata.sessionId, result.sessionId);
    assert.equal(metadata.audioPath, result.audioPath);
    assert.equal((await stat(result.audioPath)).isFile(), true);
  });
});

test('rejects malformed chunks and a mismatched session', async () => {
  await withRecorder(async (recorder) => {
    const started = await recorder.start();
    await assert.rejects(() => recorder.append('wrong-session', new Int16Array([1])), /not active/);
    assert.throws(() => recorder.append(started.sessionId!, new Uint8Array([1])), /complete 16-bit/);
    assert.throws(() => recorder.append(started.sessionId!, 'not audio'), /binary PCM/);
    assert.equal(recorder.status().bytes, 0);
  });
});

test('cancel removes partial audio and metadata', async () => {
  await withRecorder(async (recorder) => {
    const started = await recorder.start();
    const audioPath = started.audioPath!;
    await recorder.append(started.sessionId!, new Int16Array([1, 2, 3]));
    await recorder.cancel(started.sessionId!);
    await assert.rejects(() => stat(audioPath), { code: 'ENOENT' });
    await assert.rejects(() => stat(`${audioPath}.part`), { code: 'ENOENT' });
    await assert.rejects(() => stat(audioPath.replace(/\.wav$/, '.json.part')), { code: 'ENOENT' });
  });
});

test('repairs and finalizes a WAV interrupted by a process crash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clementine-local-recovery-'));
  try {
    const sessionId = 'crashed-session-1234';
    const stem = `local-${sessionId}`;
    const partPath = path.join(root, `${stem}.wav.part`);
    const metadataPartPath = path.join(root, `${stem}.json.part`);
    const pcm = Buffer.alloc(LOCAL_MEETING_SAMPLE_RATE * 2, 7);
    await writeFile(partPath, Buffer.concat([createPcmWavHeader(0), pcm]));
    await writeFile(metadataPartPath, JSON.stringify({
      sessionId,
      title: 'Recovered planning',
      startedAt: '2026-07-13T12:00:00.000Z',
      status: 'recording',
    }));

    const recorder = new LocalMeetingRecorder({
      rootDir: root,
      now: () => new Date('2026-07-13T12:01:00.000Z'),
    });
    const recovered = await recorder.recoverInterruptedRecordings();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].sessionId, sessionId);
    assert.equal(recovered[0].durationSeconds, 1);
    assert.equal(recovered[0].title, 'Recovered planning');

    const finalPath = path.join(root, `${stem}.wav`);
    const wav = await readFile(finalPath);
    assert.equal(wav.readUInt32LE(4), pcm.byteLength + 36);
    assert.equal(wav.readUInt32LE(40), pcm.byteLength);
    await assert.rejects(() => stat(partPath), { code: 'ENOENT' });
    const metadata = JSON.parse(await readFile(path.join(root, `${stem}.json`), 'utf8')) as Record<string, unknown>;
    assert.equal(metadata.status, 'recorded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('crash recovery never follows symlinked audio or metadata', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clementine-local-symlink-recovery-'));
  const audioRoot = path.join(root, 'audio');
  await mkdir(audioRoot);
  try {
    const audioSession = 'linked-audio-session';
    const outsideAudio = path.join(root, 'outside-audio.bin');
    const originalAudio = Buffer.alloc(100, 0x58);
    await writeFile(outsideAudio, originalAudio);
    try {
      await symlink(outsideAudio, path.join(audioRoot, `local-${audioSession}.wav.part`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('symlink creation is not permitted on this Windows host');
        return;
      }
      throw error;
    }
    await writeFile(path.join(audioRoot, `local-${audioSession}.json.part`), JSON.stringify({
      sessionId: audioSession,
      startedAt: '2026-07-13T12:00:00.000Z',
      status: 'recording',
    }));

    const metadataSession = 'linked-metadata-session';
    const outsideMetadata = path.join(root, 'outside-metadata.json');
    const originalMetadata = JSON.stringify({
      sessionId: metadataSession,
      startedAt: '2026-07-13T12:00:00.000Z',
      status: 'recording',
    });
    await writeFile(outsideMetadata, originalMetadata);
    await symlink(outsideMetadata, path.join(audioRoot, `local-${metadataSession}.json.part`));
    await writeFile(
      path.join(audioRoot, `local-${metadataSession}.wav.part`),
      Buffer.concat([createPcmWavHeader(0), Buffer.alloc(64, 7)]),
    );

    const recorder = new LocalMeetingRecorder({ rootDir: audioRoot });
    const recovered = await recorder.recoverInterruptedRecordings();
    assert.deepEqual(recovered, []);
    assert.deepEqual(await readFile(outsideAudio), originalAudio, 'outside audio must not receive a WAV header');
    assert.equal(await readFile(outsideMetadata, 'utf8'), originalMetadata, 'outside metadata must remain untouched');
    assert.equal((await lstat(path.join(audioRoot, `local-${audioSession}.wav.part`))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(audioRoot, `local-${metadataSession}.json.part`))).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dead producer flips status to STALE past the floor; a resumed append restores freshness', async () => {
  // 2026-07-14 review: a renderer crash/reload kills the mic pump while main's
  // recorder kept reporting recording:true with a frozen byte count — the tray
  // showed "Recording" over silence. The staleness floor is what lets the tray,
  // the status poll, and the orphan finalizer see the truth.
  const root = await mkdtemp(path.join(os.tmpdir(), 'clementine-local-meeting-stale-'));
  let nowMs = Date.UTC(2026, 6, 14, 10, 0, 0);
  const recorder = new LocalMeetingRecorder({
    rootDir: root,
    createId: () => 'stale-floor-session',
    now: () => new Date(nowMs),
  });
  try {
    const started = await recorder.start({});
    const chunk = new Int16Array([1, 2, 3, 4]);
    nowMs += 1_000;
    await recorder.append(started.sessionId!, chunk);
    assert.equal(recorder.status().stale, false, 'live capture is not stale');
    assert.ok(recorder.status().lastAppendAt, 'lastAppendAt is exposed');

    nowMs += STALE_CAPTURE_AFTER_MS + 1_000; // silence past the floor
    const stalled = recorder.status();
    assert.equal(stalled.recording, true, 'main still holds the recording');
    assert.equal(stalled.stale, true, 'no PCM past the floor ⇒ stale');

    nowMs += 1_000;
    await recorder.append(started.sessionId!, chunk); // producer resumed
    assert.equal(recorder.status().stale, false, 'a real append restores freshness');
  } finally {
    await recorder.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
