import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';

export const LOCAL_MEETING_SAMPLE_RATE = 16_000;
export const LOCAL_MEETING_CHANNELS = 1;
export const LOCAL_MEETING_BITS_PER_SAMPLE = 16;

const WAV_HEADER_BYTES = 44;
const MAX_CHUNK_BYTES = 1024 * 1024;
// whisper.cpp decodes the whole WAV to float PCM. Four hours keeps the worst-
// case working set practical on an 8 GB Intel Mac while covering long meetings.
const MAX_RECORDING_SECONDS = 4 * 60 * 60;
const MAX_DATA_BYTES = LOCAL_MEETING_SAMPLE_RATE
  * LOCAL_MEETING_CHANNELS
  * (LOCAL_MEETING_BITS_PER_SAMPLE / 8)
  * MAX_RECORDING_SECONDS;

export interface LocalMeetingRecording {
  sessionId: string;
  title?: string;
  audioPath: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  bytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface LocalMeetingRecorderStatus {
  recording: boolean;
  sessionId?: string;
  title?: string;
  audioPath?: string;
  startedAt?: string;
  bytes: number;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
}

interface ActiveRecording {
  sessionId: string;
  title?: string;
  startedAt: string;
  partPath: string;
  finalPath: string;
  metadataPartPath: string;
  metadataPath: string;
  handle: FileHandle;
  bytes: number;
}

export interface LocalMeetingRecorderOptions {
  rootDir?: string;
  now?: () => Date;
  createId?: () => string;
}

function defaultRootDir(): string {
  const home = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
  return path.join(home, 'state', 'meeting-capture', 'local-audio');
}

function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 160) : undefined;
}

function durationForBytes(bytes: number): number {
  return bytes / (LOCAL_MEETING_SAMPLE_RATE * LOCAL_MEETING_CHANNELS * (LOCAL_MEETING_BITS_PER_SAMPLE / 8));
}

/** Build a canonical PCM WAV header for the streamed 16 kHz mono payload. */
export function createPcmWavHeader(dataBytes: number): Buffer {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes > 0xffff_ffff - 36) {
    throw new Error('invalid WAV payload size');
  }

  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(LOCAL_MEETING_CHANNELS, 22);
  header.writeUInt32LE(LOCAL_MEETING_SAMPLE_RATE, 24);
  header.writeUInt32LE(LOCAL_MEETING_SAMPLE_RATE * LOCAL_MEETING_CHANNELS * 2, 28);
  header.writeUInt16LE(LOCAL_MEETING_CHANNELS * 2, 32);
  header.writeUInt16LE(LOCAL_MEETING_BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function toOwnedPcmBuffer(value: unknown): Buffer {
  let chunk: Buffer;
  if (Buffer.isBuffer(value)) {
    chunk = Buffer.from(value);
  } else if (value instanceof ArrayBuffer) {
    chunk = Buffer.from(new Uint8Array(value));
  } else if (ArrayBuffer.isView(value)) {
    chunk = Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  } else {
    throw new Error('audio chunk must be binary PCM data');
  }

  if (chunk.byteLength === 0) throw new Error('audio chunk is empty');
  if (chunk.byteLength > MAX_CHUNK_BYTES) throw new Error('audio chunk is too large');
  if (chunk.byteLength % 2 !== 0) throw new Error('audio chunk must contain complete 16-bit samples');
  return chunk;
}

async function writeAll(handle: FileHandle, buffer: Buffer, position: number | null = null): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position === null ? null : position + offset,
    );
    if (result.bytesWritten <= 0) throw new Error('failed to write local meeting audio');
    offset += result.bytesWritten;
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function openRegularFileNoFollow(
  filePath: string,
  flags: number,
  realRoot: string,
): Promise<{ handle: FileHandle; stats: Stats }> {
  const before = await lstat(filePath);
  if (!before.isFile()) throw new Error(`recording recovery path is not a regular file: ${filePath}`);
  const resolved = await realpath(filePath);
  if (!isInsideRoot(resolved, realRoot)) {
    throw new Error(`recording recovery path escaped local-audio storage: ${filePath}`);
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, flags | noFollow);
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`recording recovery path changed while opening: ${filePath}`);
    }
    return { handle, stats: after };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Owns the durable side of an in-person meeting recording. The renderer only
 * streams small PCM chunks; a full meeting is never retained in renderer RAM.
 */
export class LocalMeetingRecorder {
  readonly rootDir: string;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private active: ActiveRecording | null = null;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(options: LocalMeetingRecorderOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? defaultRootDir());
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  status(): LocalMeetingRecorderStatus {
    const active = this.active;
    return {
      recording: Boolean(active),
      sessionId: active?.sessionId,
      title: active?.title,
      audioPath: active?.finalPath,
      startedAt: active?.startedAt,
      bytes: active?.bytes ?? 0,
      durationSeconds: durationForBytes(active?.bytes ?? 0),
      sampleRate: LOCAL_MEETING_SAMPLE_RATE,
      channels: LOCAL_MEETING_CHANNELS,
    };
  }

  start(input: { title?: unknown } = {}): Promise<LocalMeetingRecorderStatus> {
    return this.enqueue(async () => {
      if (this.active) throw new Error('a local meeting is already recording');
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });

      const sessionId = this.createId();
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) throw new Error('invalid generated meeting session ID');
      const startedAt = this.now().toISOString();
      const title = cleanTitle(input.title);
      const stem = `local-${sessionId}`;
      const partPath = path.join(this.rootDir, `${stem}.wav.part`);
      const finalPath = path.join(this.rootDir, `${stem}.wav`);
      const metadataPartPath = path.join(this.rootDir, `${stem}.json.part`);
      const metadataPath = path.join(this.rootDir, `${stem}.json`);
      const handle = await open(partPath, 'wx', 0o600);

      try {
        await writeAll(handle, createPcmWavHeader(0));
        await writeFile(metadataPartPath, JSON.stringify({
          sessionId,
          title,
          audioPath: finalPath,
          startedAt,
          sampleRate: LOCAL_MEETING_SAMPLE_RATE,
          channels: LOCAL_MEETING_CHANNELS,
          bitsPerSample: LOCAL_MEETING_BITS_PER_SAMPLE,
          status: 'recording',
        }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(partPath, { force: true }).catch(() => undefined);
        await rm(metadataPartPath, { force: true }).catch(() => undefined);
        throw error;
      }

      this.active = {
        sessionId,
        title,
        startedAt,
        partPath,
        finalPath,
        metadataPartPath,
        metadataPath,
        handle,
        bytes: 0,
      };
      return this.status();
    });
  }

  append(sessionId: string, value: unknown): Promise<LocalMeetingRecorderStatus> {
    // Copy before queueing so the renderer may safely reuse its ArrayBuffer.
    const chunk = toOwnedPcmBuffer(value);
    return this.enqueue(async () => {
      const active = this.requireActive(sessionId);
      if (active.bytes + chunk.byteLength > MAX_DATA_BYTES) {
        throw new Error('local meeting reached the 4-hour recording limit');
      }
      await writeAll(active.handle, chunk);
      active.bytes += chunk.byteLength;
      return this.status();
    });
  }

  stop(sessionId: string): Promise<LocalMeetingRecording> {
    return this.enqueue(async () => {
      const active = this.requireActive(sessionId);
      const endedAt = this.now().toISOString();
      const recording: LocalMeetingRecording = {
        sessionId: active.sessionId,
        title: active.title,
        audioPath: active.finalPath,
        startedAt: active.startedAt,
        endedAt,
        durationSeconds: durationForBytes(active.bytes),
        bytes: active.bytes,
        sampleRate: LOCAL_MEETING_SAMPLE_RATE,
        channels: LOCAL_MEETING_CHANNELS,
        bitsPerSample: LOCAL_MEETING_BITS_PER_SAMPLE,
      };

      try {
        await writeAll(active.handle, createPcmWavHeader(active.bytes), 0);
        await active.handle.sync();
        await active.handle.close();
        await rename(active.partPath, active.finalPath);
        await writeFile(active.metadataPartPath, JSON.stringify({ ...recording, status: 'recorded' }, null, 2), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'w',
        });
        await rename(active.metadataPartPath, active.metadataPath);
        this.active = null;
        return recording;
      } catch (error) {
        await active.handle.close().catch(() => undefined);
        this.active = null;
        throw error;
      }
    });
  }

  cancel(sessionId: string): Promise<{ cancelled: true }> {
    return this.enqueue(async () => {
      const active = this.requireActive(sessionId);
      await active.handle.close().catch(() => undefined);
      await Promise.all([
        rm(active.partPath, { force: true }),
        rm(active.metadataPartPath, { force: true }),
      ]);
      this.active = null;
      return { cancelled: true as const };
    });
  }

  shutdown(): Promise<LocalMeetingRecording | null> {
    const sessionId = this.active?.sessionId;
    return sessionId ? this.stop(sessionId) : Promise.resolve(null);
  }

  /**
   * Finalize recordings interrupted by a process/OS crash. The small sidecar
   * is written at start, so we can repair the WAV header from the actual file
   * length without guessing paths or trusting arbitrary metadata paths.
   */
  recoverInterruptedRecordings(): Promise<LocalMeetingRecording[]> {
    return this.enqueue(async () => {
      if (this.active) return [];
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const realRoot = await realpath(this.rootDir);
      const names = await readdir(this.rootDir).catch(() => [] as string[]);
      const recovered: LocalMeetingRecording[] = [];

      for (const metadataName of names.filter((name) => /^local-[a-zA-Z0-9_-]{8,80}\.json\.part$/.test(name))) {
        const match = /^local-([a-zA-Z0-9_-]{8,80})\.json\.part$/.exec(metadataName);
        if (!match) continue;
        const sessionId = match[1];
        const stem = `local-${sessionId}`;
        const metadataPartPath = path.join(this.rootDir, metadataName);
        const metadataPath = path.join(this.rootDir, `${stem}.json`);
        const partPath = path.join(this.rootDir, `${stem}.wav.part`);
        const finalPath = path.join(this.rootDir, `${stem}.wav`);

        try {
          const metadataFile = await openRegularFileNoFollow(metadataPartPath, fsConstants.O_RDONLY, realRoot);
          let rawMetadata: string;
          try {
            if (metadataFile.stats.size > 64 * 1024) continue;
            rawMetadata = await metadataFile.handle.readFile('utf8');
            if (Buffer.byteLength(rawMetadata, 'utf8') > 64 * 1024) continue;
          } finally {
            await metadataFile.handle.close();
          }
          const metadata = JSON.parse(rawMetadata) as { sessionId?: unknown; title?: unknown; startedAt?: unknown };
          if (metadata.sessionId !== sessionId) continue;

          let audioPath = partPath;
          let audioInfo: Awaited<ReturnType<typeof openRegularFileNoFollow>> | null = null;
          try {
            audioInfo = await openRegularFileNoFollow(partPath, fsConstants.O_RDWR, realRoot);
          } catch (error) {
            const partEntry = await lstat(partPath).catch(() => null);
            if (partEntry) throw error;
            audioPath = finalPath;
            audioInfo = await openRegularFileNoFollow(finalPath, fsConstants.O_RDWR, realRoot);
          }
          const audioStat = audioInfo.stats;
          if (audioStat.size < WAV_HEADER_BYTES) {
            await audioInfo.handle.close();
            continue;
          }
          const bytes = audioStat.size - WAV_HEADER_BYTES;
          if (bytes === 0) {
            await audioInfo.handle.close();
            await Promise.all([
              rm(partPath, { force: true }),
              rm(finalPath, { force: true }),
              rm(metadataPartPath, { force: true }),
            ]);
            continue;
          }
          if (bytes % 2 !== 0 || bytes > MAX_DATA_BYTES) {
            await audioInfo.handle.close();
            continue;
          }

          try {
            await writeAll(audioInfo.handle, createPcmWavHeader(bytes), 0);
            await audioInfo.handle.sync();
          } finally {
            await audioInfo.handle.close();
          }
          if (audioPath === partPath) await rename(partPath, finalPath);

          const parsedStartedAt = typeof metadata.startedAt === 'string' && Number.isFinite(Date.parse(metadata.startedAt))
            ? new Date(metadata.startedAt).toISOString()
            : audioStat.birthtime.toISOString();
          const recording: LocalMeetingRecording = {
            sessionId,
            title: cleanTitle(metadata.title),
            audioPath: finalPath,
            startedAt: parsedStartedAt,
            endedAt: this.now().toISOString(),
            durationSeconds: durationForBytes(bytes),
            bytes,
            sampleRate: LOCAL_MEETING_SAMPLE_RATE,
            channels: LOCAL_MEETING_CHANNELS,
            bitsPerSample: LOCAL_MEETING_BITS_PER_SAMPLE,
          };
          // Never write through the crash sidecar path: it could be replaced by
          // a symlink after validation. Write a fresh exclusive temp and rename
          // that owned inode into place instead.
          const recoveredMetadataPath = path.join(
            this.rootDir,
            `${stem}.recovered-${randomUUID()}.json.part`,
          );
          try {
            await writeFile(recoveredMetadataPath, JSON.stringify({ ...recording, status: 'recorded' }, null, 2), {
              encoding: 'utf8',
              mode: 0o600,
              flag: 'wx',
            });
            // Removing an existing entry never follows a symlink; rename then
            // installs only the exclusive regular file created above.
            await rm(metadataPath, { force: true });
            await rename(recoveredMetadataPath, metadataPath);
            await rm(metadataPartPath, { force: true });
          } finally {
            await rm(recoveredMetadataPath, { force: true }).catch(() => undefined);
          }
          recovered.push(recording);
        } catch (error) {
          // Leave ambiguous/corrupt input untouched for support or manual
          // recovery. One bad sidecar must never block other recordings.
          console.warn('[local-meeting] could not recover interrupted recording', sessionId, error instanceof Error ? error.message : error);
        }
      }
      return recovered;
    });
  }

  private requireActive(sessionId: string): ActiveRecording {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id || !this.active || this.active.sessionId !== id) {
      throw new Error('local meeting recording session is not active');
    }
    return this.active;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operation.then(run, run);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}
