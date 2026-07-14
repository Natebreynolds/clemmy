import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { BASE_DIR, PKG_DIR, getRuntimeEnv } from '../../config.js';

/**
 * Keep these pins in sync with scripts/vendor-whispercpp.mjs.
 *
 * Release: https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1
 * Model:   https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1
 */
export const WHISPER_CPP_VERSION = 'v1.9.1';
export const WHISPER_CPP_COMMIT = 'f049fff95a089aa9969deb009cdd4892b3e74916';
export const WHISPER_MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
export const DEFAULT_LOCAL_WHISPER_MODEL = 'base.en' as const;

const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const MAX_TRANSCRIPTION_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MODEL_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1_000;
const PROCESS_KILL_GRACE_MS = 3_000;
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1_024;
const MAX_JSON_OUTPUT_BYTES = 64 * 1_024 * 1_024;
const STALE_RUNTIME_ARTIFACT_AGE_MS = 24 * 60 * 60 * 1_000;
const RUNTIME_PRUNE_THROTTLE_MS = 15 * 60 * 1_000;

const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg']);
export const MAX_LOCAL_MEETING_DURATION_SECONDS = 4 * 60 * 60;

const WHISPER_MODELS = {
  'base.en': {
    fileName: 'ggml-base.en.bin',
    bytes: 147_964_211,
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-base.en.bin?download=true`,
    repositoryUrl: 'https://huggingface.co/ggerganov/whisper.cpp',
    license: 'MIT',
    licenseDeclarationUrl: `https://huggingface.co/ggerganov/whisper.cpp/blob/${WHISPER_MODEL_REVISION}/README.md`,
  },
} as const;

export type LocalWhisperModelId = keyof typeof WHISPER_MODELS;
export type WhisperRuntimeTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'x86_64-pc-windows-msvc';

export type LocalWhisperErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'CLI_NOT_FOUND'
  | 'CLI_NOT_EXECUTABLE'
  | 'AUDIO_NOT_FOUND'
  | 'AUDIO_TOO_LONG'
  | 'UNSUPPORTED_AUDIO_FORMAT'
  | 'UNSUPPORTED_MODEL'
  | 'UNSUPPORTED_LANGUAGE'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_CHECKSUM_MISMATCH'
  | 'TRANSCRIPTION_TIMEOUT'
  | 'TRANSCRIPTION_CANCELLED'
  | 'TRANSCRIPTION_FAILED'
  | 'TRANSCRIPTION_OUTPUT_INVALID';

export class LocalWhisperRuntimeError extends Error {
  readonly code: LocalWhisperErrorCode;
  readonly cause?: unknown;

  constructor(code: LocalWhisperErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'LocalWhisperRuntimeError';
    this.code = code;
    this.cause = options?.cause;
  }
}

export interface LocalWhisperSegment {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface LocalWhisperTranscription {
  text: string;
  segments: LocalWhisperSegment[];
  model: LocalWhisperModelId;
  language?: string;
  durationSeconds?: number;
}

export interface TranscribeLocalMeetingAudioInput {
  audioPath: string;
  model?: LocalWhisperModelId;
  language?: string;
  /** Recorder-reported duration, used to bound decoded memory and timeout. */
  durationSeconds?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LocalTranscriptionRuntimeStatus {
  available: boolean;
  platform: string;
  target?: WhisperRuntimeTarget;
  whisperVersion: string;
  cliPath?: string;
  cliSource?: 'override' | 'vendored';
  model: LocalWhisperModelId;
  modelPath: string;
  modelNoticePath: string;
  modelReady: boolean;
  modelBytes: number;
  modelLicense: 'MIT';
  modelSourceRevision: string;
  reason?: string;
}

type CliResolution =
  | { ok: true; path: string; source: 'override' | 'vendored'; target: WhisperRuntimeTarget }
  | { ok: false; reason: string; code: 'UNSUPPORTED_PLATFORM' | 'CLI_NOT_FOUND' | 'CLI_NOT_EXECUTABLE'; target?: WhisperRuntimeTarget };

interface VerificationCacheEntry {
  expectedSha256: string;
  size: number;
  mtimeMs: number;
  ino: number;
  valid: boolean;
}

const verificationCache = new Map<string, VerificationCacheEntry>();
const pendingModelDownloads = new Map<string, Promise<string>>();
const activeJobDirs = new Set<string>();
const activeWhisperProcesses = new Set<ActiveWhisperProcess>();
let lastRuntimePruneAt = 0;
let pendingRuntimePrune: Promise<WhisperRuntimePruneResult> | undefined;
let whisperLifecycleHandlersInstalled = false;
let shutdownWhisperRuntimePromise: Promise<void> | undefined;

export function resolveWhisperRuntimeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): WhisperRuntimeTarget | undefined {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  return undefined;
}

function clementineHome(): string {
  return path.resolve(getRuntimeEnv('CLEMENTINE_HOME', BASE_DIR));
}

function modelConfig(model: LocalWhisperModelId = DEFAULT_LOCAL_WHISPER_MODEL) {
  const config = WHISPER_MODELS[model];
  if (!config) {
    throw new LocalWhisperRuntimeError(
      'UNSUPPORTED_MODEL',
      `Unsupported local transcription model "${String(model)}". Allowed models: ${Object.keys(WHISPER_MODELS).join(', ')}.`,
    );
  }
  return config;
}

export function getLocalWhisperModelPath(model: LocalWhisperModelId = DEFAULT_LOCAL_WHISPER_MODEL): string {
  const config = modelConfig(model);
  return path.join(clementineHome(), 'runtime', 'whisper', 'models', WHISPER_MODEL_REVISION, config.fileName);
}

export function getLocalWhisperModelNoticePath(model: LocalWhisperModelId = DEFAULT_LOCAL_WHISPER_MODEL): string {
  return `${getLocalWhisperModelPath(model)}.provenance.json`;
}

function modelNoticeText(model: LocalWhisperModelId): string {
  const config = modelConfig(model);
  return `${JSON.stringify({
    schemaVersion: 1,
    model: {
      id: model,
      fileName: config.fileName,
      bytes: config.bytes,
      sha256: config.sha256,
    },
    provenance: {
      originalModel: `OpenAI Whisper ${model}`,
      originalProjectUrl: 'https://github.com/openai/whisper',
      conversionRepositoryUrl: config.repositoryUrl,
      conversionRevision: WHISPER_MODEL_REVISION,
      sourceFileUrl: config.url,
    },
    license: {
      spdx: config.license,
      declaredBy: 'ggerganov/whisper.cpp Hugging Face model repository metadata',
      declarationUrl: config.licenseDeclarationUrl,
    },
  }, null, 2)}\n`;
}

async function ensureModelNotice(model: LocalWhisperModelId): Promise<string> {
  const noticePath = getLocalWhisperModelNoticePath(model);
  const expected = modelNoticeText(model);
  try {
    const info = await lstat(noticePath);
    if (info.isFile() && info.size <= 16 * 1_024 && await readFile(noticePath, 'utf8') === expected) return noticePath;
  } catch { /* create or replace only the fixed notice path */ }

  await mkdir(path.dirname(noticePath), { recursive: true, mode: 0o700 });
  const partPath = `${noticePath}.${process.pid}.${randomUUID()}.part`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(partPath, 'wx', 0o600);
    await file.writeFile(expected, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    try {
      await rename(partPath, noticePath);
    } catch (error) {
      // A concurrent first-use can win on Windows. Accept it only if it wrote
      // the identical immutable provenance notice.
      const existing = await readFile(noticePath, 'utf8').catch(() => '');
      if (existing !== expected) throw error;
    }
    if (process.platform !== 'win32') await chmod(noticePath, 0o600);
    return noticePath;
  } finally {
    if (file) await file.close().catch(() => undefined);
    await rm(partPath, { force: true }).catch(() => undefined);
  }
}

function vendoredCliPath(target: WhisperRuntimeTarget): string {
  return path.join(
    PKG_DIR,
    'vendor',
    'whisper',
    target,
    target.endsWith('windows-msvc') ? 'whisper-cli.exe' : 'whisper-cli',
  );
}

async function inspectCliCandidate(
  candidate: string,
  source: 'override' | 'vendored',
  target: WhisperRuntimeTarget,
): Promise<CliResolution> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      return { ok: false, code: 'CLI_NOT_FOUND', reason: `Configured whisper.cpp CLI is not a regular file: ${candidate}`, target };
    }
    if (process.platform !== 'win32') {
      await access(candidate, fsConstants.X_OK);
    }
    return { ok: true, path: candidate, source, target };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES') {
      return { ok: false, code: 'CLI_NOT_EXECUTABLE', reason: `whisper.cpp CLI is not executable: ${candidate}`, target };
    }
    return {
      ok: false,
      code: 'CLI_NOT_FOUND',
      reason: source === 'override'
        ? `CLEMENTINE_WHISPER_CLI does not point to a readable CLI: ${candidate}`
        : `The vendored whisper.cpp CLI is missing for ${target}.`,
      target,
    };
  }
}

async function resolveWhisperCli(): Promise<CliResolution> {
  const target = resolveWhisperRuntimeTarget();
  if (!target) {
    return {
      ok: false,
      code: 'UNSUPPORTED_PLATFORM',
      reason: `Local transcription is not packaged for ${process.platform}/${process.arch}.`,
    };
  }

  const override = getRuntimeEnv('CLEMENTINE_WHISPER_CLI', '').trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      return {
        ok: false,
        code: 'CLI_NOT_FOUND',
        reason: 'CLEMENTINE_WHISPER_CLI must be an absolute path.',
        target,
      };
    }
    return inspectCliCandidate(path.normalize(override), 'override', target);
  }

  return inspectCliCandidate(vendoredCliPath(target), 'vendored', target);
}

async function sha256RegularFile(filePath: string, expectedBytes: number, signal?: AbortSignal): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.size !== expectedBytes) return undefined;

  throwIfAborted(signal);
  const hash = createHash('sha256');
  const file = await open(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    while (position < info.size) {
      throwIfAborted(signal);
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== info.size) return undefined;
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

async function verifyModelFile(filePath: string, model: LocalWhisperModelId, signal?: AbortSignal): Promise<boolean> {
  const config = modelConfig(model);
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    verificationCache.delete(filePath);
    return false;
  }
  if (!info.isFile() || info.size !== config.bytes) {
    verificationCache.delete(filePath);
    return false;
  }

  const cached = verificationCache.get(filePath);
  if (
    cached
    && cached.expectedSha256 === config.sha256
    && cached.size === info.size
    && cached.mtimeMs === info.mtimeMs
    && cached.ino === info.ino
  ) {
    return cached.valid;
  }

  const digest = await sha256RegularFile(filePath, config.bytes, signal);
  const valid = digest === config.sha256;
  verificationCache.set(filePath, {
    expectedSha256: config.sha256,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ino: info.ino,
    valid,
  });
  return valid;
}

interface VerifiedDownloadInput {
  url: string;
  destination: string;
  sha256: string;
  bytes: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

async function downloadVerifiedFile(input: VerifiedDownloadInput): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('Expected SHA-256 must be a lowercase 64-character hex digest.');
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) throw new Error('Expected download size must be a positive integer.');
  throwIfAborted(input.signal);

  await mkdir(path.dirname(input.destination), { recursive: true, mode: 0o700 });
  const partPath = `${input.destination}.${process.pid}.${randomUUID()}.part`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      redirect: 'follow',
      signal: input.signal,
      headers: { Accept: 'application/octet-stream' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) throw new Error('Download response had no body.');

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== input.bytes) {
      throw new Error(`Unexpected download size: expected ${input.bytes} bytes, server reported ${contentLength}.`);
    }

    file = await open(partPath, 'wx', 0o600);
    reader = response.body.getReader();
    const hash = createHash('sha256');
    let bytesWritten = 0;
    while (true) {
      throwIfAborted(input.signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value || chunk.value.byteLength === 0) continue;
      bytesWritten += chunk.value.byteLength;
      if (bytesWritten > input.bytes) {
        throw new Error(`Download exceeded the allowlisted size of ${input.bytes} bytes.`);
      }
      hash.update(chunk.value);
      let chunkOffset = 0;
      while (chunkOffset < chunk.value.byteLength) {
        const written = await file.write(
          chunk.value,
          chunkOffset,
          chunk.value.byteLength - chunkOffset,
        );
        if (written.bytesWritten <= 0) throw new Error('Model download stopped making write progress.');
        chunkOffset += written.bytesWritten;
      }
    }
    await file.sync();
    await file.close();
    file = undefined;

    if (bytesWritten !== input.bytes) {
      throw new Error(`Incomplete download: expected ${input.bytes} bytes, received ${bytesWritten}.`);
    }
    const digest = hash.digest('hex');
    if (digest !== input.sha256) {
      throw new LocalWhisperRuntimeError(
        'MODEL_CHECKSUM_MISMATCH',
        `Downloaded model checksum mismatch: expected ${input.sha256}, received ${digest}.`,
      );
    }

    try {
      await rename(partPath, input.destination);
    } catch (error) {
      // Another daemon process can win the same first-run download on Windows,
      // where rename does not replace an existing destination. Its file is
      // acceptable only when it has the exact same allowlisted bytes.
      const existingDigest = await sha256RegularFile(input.destination, input.bytes, input.signal);
      if (existingDigest !== input.sha256) throw error;
    }
    if (process.platform !== 'win32') await chmod(input.destination, 0o600);
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
    if (file) await file.close().catch(() => undefined);
    await rm(partPath, { force: true }).catch(() => undefined);
  }
}

function whisperJobsRoot(): string {
  return path.join(clementineHome(), 'runtime', 'whisper', 'jobs');
}

export interface WhisperRuntimePruneResult {
  modelPartsDeleted: number;
  jobDirsDeleted: number;
  entriesScanned: number;
}

async function pruneStaleWhisperRuntimeArtifacts(options: {
  now?: number;
  staleAfterMs?: number;
} = {}): Promise<WhisperRuntimePruneResult> {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STALE_RUNTIME_ARTIFACT_AGE_MS;
  if (!Number.isFinite(now) || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error('Whisper runtime prune bounds must be positive finite numbers.');
  }
  const cutoff = now - staleAfterMs;
  const result: WhisperRuntimePruneResult = { modelPartsDeleted: 0, jobDirsDeleted: 0, entriesScanned: 0 };

  const model = DEFAULT_LOCAL_WHISPER_MODEL;
  const config = modelConfig(model);
  const modelDir = path.dirname(getLocalWhisperModelPath(model));
  try {
    const entries = (await readdir(modelDir, { withFileTypes: true })).slice(0, 10_000);
    for (const entry of entries) {
      result.entriesScanned += 1;
      if (
        !entry.name.startsWith(`${config.fileName}.`)
        || !entry.name.endsWith('.part')
        || entry.name.length > 255
      ) continue;
      const candidate = path.join(modelDir, entry.name);
      const info = await lstat(candidate).catch(() => undefined);
      // lstat + isFile deliberately skips symlinks, directories, sockets, and
      // any path that disappeared during the bounded scan.
      if (!info?.isFile() || info.mtimeMs > cutoff) continue;
      try {
        await rm(candidate, { force: true });
        result.modelPartsDeleted += 1;
      } catch { /* disappeared or became unavailable after lstat */ }
    }
  } catch { /* model directory does not exist on a clean install */ }

  const jobsRoot = whisperJobsRoot();
  try {
    const entries = (await readdir(jobsRoot, { withFileTypes: true })).slice(0, 10_000);
    for (const entry of entries) {
      result.entriesScanned += 1;
      if (!entry.name.startsWith('transcribe-') || entry.name.length > 255) continue;
      const candidate = path.join(jobsRoot, entry.name);
      if (activeJobDirs.has(candidate)) continue;
      const info = await lstat(candidate).catch(() => undefined);
      // Never follow/delete a symlink masquerading as a job directory.
      if (!info?.isDirectory() || info.mtimeMs > cutoff) continue;
      try {
        await rm(candidate, { recursive: true, force: true });
        result.jobDirsDeleted += 1;
      } catch { /* disappeared or became unavailable after lstat */ }
    }
  } catch { /* jobs directory does not exist on a clean install */ }
  return result;
}

async function maybePruneWhisperRuntime(force = false): Promise<WhisperRuntimePruneResult> {
  const now = Date.now();
  if (!force && now - lastRuntimePruneAt < RUNTIME_PRUNE_THROTTLE_MS) {
    return { modelPartsDeleted: 0, jobDirsDeleted: 0, entriesScanned: 0 };
  }
  if (pendingRuntimePrune) return pendingRuntimePrune;
  pendingRuntimePrune = pruneStaleWhisperRuntimeArtifacts({ now })
    .then((result) => {
      lastRuntimePruneAt = now;
      return result;
    })
    .finally(() => { pendingRuntimePrune = undefined; });
  return pendingRuntimePrune;
}

/** Startup hook: remove only stale, fixed-pattern artifacts from Whisper-owned roots. */
export async function prepareLocalTranscriptionRuntime(): Promise<WhisperRuntimePruneResult> {
  return maybePruneWhisperRuntime(true);
}

async function ensureLocalWhisperModel(
  model: LocalWhisperModelId,
  signal?: AbortSignal,
): Promise<string> {
  await maybePruneWhisperRuntime();
  const config = modelConfig(model);
  const modelPath = getLocalWhisperModelPath(model);
  if (await verifyModelFile(modelPath, model, signal)) {
    await ensureModelNotice(model);
    return modelPath;
  }

  const existing = pendingModelDownloads.get(modelPath);
  if (existing) return existing;

  const pending = (async () => {
    // Remove stale, partial, symlinked, or corrupt content only at Clementine's
    // fixed model-cache path. Never accept a caller-provided model URL/path.
    await rm(modelPath, { recursive: true, force: true });
    const timeoutSignal = AbortSignal.timeout(MODEL_DOWNLOAD_TIMEOUT_MS);
    try {
      const downloadSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      await downloadVerifiedFile({
        url: config.url,
        destination: modelPath,
        sha256: config.sha256,
        bytes: config.bytes,
        signal: downloadSignal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new LocalWhisperRuntimeError('TRANSCRIPTION_CANCELLED', 'Local transcription was cancelled while downloading its model.', { cause: error });
      }
      if (error instanceof LocalWhisperRuntimeError && error.code === 'MODEL_CHECKSUM_MISMATCH') throw error;
      const detail = timeoutSignal.aborted
        ? `the download exceeded ${Math.round(MODEL_DOWNLOAD_TIMEOUT_MS / 60_000)} minutes`
        : errorMessage(error);
      throw new LocalWhisperRuntimeError(
        'MODEL_DOWNLOAD_FAILED',
        `Could not download the verified ${model} transcription model: ${detail}`,
        { cause: error },
      );
    }
    if (!(await verifyModelFile(modelPath, model, signal))) {
      await rm(modelPath, { force: true }).catch(() => undefined);
      throw new LocalWhisperRuntimeError('MODEL_CHECKSUM_MISMATCH', `The downloaded ${model} model failed verification.`);
    }
    await ensureModelNotice(model);
    return modelPath;
  })();

  pendingModelDownloads.set(modelPath, pending);
  try {
    return await pending;
  } finally {
    if (pendingModelDownloads.get(modelPath) === pending) pendingModelDownloads.delete(modelPath);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LocalWhisperRuntimeError('TRANSCRIPTION_CANCELLED', 'Local transcription was cancelled.', { cause: signal.reason });
  }
}

function normalizeLanguage(model: LocalWhisperModelId, language?: string): string {
  const normalized = (language || 'en').trim().toLowerCase();
  if (
    model === 'base.en'
    && (normalized === 'en' || normalized === 'english' || normalized === 'auto' || /^en[-_][a-z0-9-]+$/.test(normalized))
  ) return 'en';
  throw new LocalWhisperRuntimeError(
    'UNSUPPORTED_LANGUAGE',
    `The ${model} model supports English audio only.`,
  );
}

async function validateAudioFile(audioPath: string): Promise<string> {
  const resolved = path.resolve(audioPath);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw new LocalWhisperRuntimeError('AUDIO_NOT_FOUND', `Meeting audio file was not found: ${resolved}`, { cause: error });
  }
  if (!info.isFile()) {
    throw new LocalWhisperRuntimeError('AUDIO_NOT_FOUND', `Meeting audio path is not a regular file: ${resolved}`);
  }
  const extension = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
    throw new LocalWhisperRuntimeError(
      'UNSUPPORTED_AUDIO_FORMAT',
      `Unsupported local audio format "${extension || '(none)'}". Use WAV, MP3, FLAC, or OGG.`,
    );
  }
  return resolved;
}

async function detectWaveDurationSeconds(filePath: string): Promise<number | undefined> {
  const info = await stat(filePath);
  if (info.size < 44) return undefined;
  const file = await open(filePath, 'r');
  try {
    const riff = Buffer.alloc(12);
    if ((await file.read(riff, 0, riff.length, 0)).bytesRead !== riff.length) return undefined;
    if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') return undefined;

    let offset = 12;
    let byteRate: number | undefined;
    let dataBytes: number | undefined;
    for (let chunkIndex = 0; chunkIndex < 256 && offset + 8 <= info.size; chunkIndex += 1) {
      const header = Buffer.alloc(8);
      if ((await file.read(header, 0, header.length, offset)).bytesRead !== header.length) return undefined;
      const chunkId = header.toString('ascii', 0, 4);
      const chunkBytes = header.readUInt32LE(4);
      const payloadOffset = offset + 8;
      if (chunkBytes > info.size - payloadOffset) return undefined;
      if (chunkId === 'fmt ' && chunkBytes >= 16) {
        const format = Buffer.alloc(16);
        if ((await file.read(format, 0, format.length, payloadOffset)).bytesRead !== format.length) return undefined;
        byteRate = format.readUInt32LE(8) || undefined;
      } else if (chunkId === 'data') {
        dataBytes = chunkBytes;
      }
      if (byteRate && dataBytes !== undefined) return dataBytes / byteRate;
      offset = payloadOffset + chunkBytes + (chunkBytes % 2);
    }
    return undefined;
  } finally {
    await file.close();
  }
}

async function resolveAudioDurationSeconds(audioPath: string, reported?: number): Promise<number | undefined> {
  if (reported !== undefined && (!Number.isFinite(reported) || reported < 0)) {
    throw new LocalWhisperRuntimeError('TRANSCRIPTION_FAILED', 'Audio duration must be a non-negative finite number.');
  }
  const detected = path.extname(audioPath).toLowerCase() === '.wav'
    ? await detectWaveDurationSeconds(audioPath)
    : undefined;
  const durationSeconds = Math.max(reported ?? 0, detected ?? 0) || undefined;
  if (durationSeconds !== undefined && durationSeconds > MAX_LOCAL_MEETING_DURATION_SECONDS) {
    throw new LocalWhisperRuntimeError(
      'AUDIO_TOO_LONG',
      `Local transcription currently supports recordings up to ${MAX_LOCAL_MEETING_DURATION_SECONDS / 3_600} hours.`,
    );
  }
  return durationSeconds;
}

function boundedTimeout(timeoutMs?: number, durationSeconds?: number): number {
  if (timeoutMs === undefined) {
    if (durationSeconds === undefined) return DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
    // Intel transcription can be substantially slower than Apple Silicon.
    // Allow 75% of recording time plus ten minutes, with a 30-minute floor.
    return Math.min(
      MAX_TRANSCRIPTION_TIMEOUT_MS,
      Math.max(30 * 60 * 1_000, Math.ceil(durationSeconds * 750 + 10 * 60 * 1_000)),
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LocalWhisperRuntimeError('TRANSCRIPTION_FAILED', 'Transcription timeout must be a positive number of milliseconds.');
  }
  return Math.min(Math.floor(timeoutMs), MAX_TRANSCRIPTION_TIMEOUT_MS);
}

function appendBoundedTail(current: Buffer, chunk: Buffer | string): Buffer {
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (next.length >= MAX_PROCESS_OUTPUT_BYTES) return next.subarray(next.length - MAX_PROCESS_OUTPUT_BYTES);
  if (current.length + next.length <= MAX_PROCESS_OUTPUT_BYTES) return Buffer.concat([current, next]);
  return Buffer.concat([current.subarray(current.length + next.length - MAX_PROCESS_OUTPUT_BYTES), next]);
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

type WhisperStopReason = 'timeout' | 'cancelled' | 'shutdown';

interface ActiveWhisperProcess {
  child: ChildProcess;
  closed: Promise<void>;
  requestStop(reason: WhisperStopReason): void;
  forceKill(): void;
}

const WHISPER_PARENT_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const whisperParentSignalHandlers = new Map<NodeJS.Signals, () => void>();

function signalWhisperChildTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (process.platform !== 'win32' && child.pid) {
    try {
      // POSIX children are spawned as process-group leaders. Signalling the
      // negative PID also terminates any helper processes whisper.cpp starts.
      // Do this even after the direct child has exited: a descendant that
      // ignored SIGTERM can keep the process group alive without its leader.
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      // Fall through to the direct-child kill when group signalling is not
      // available in an unusual host/container configuration.
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function handleWhisperParentExit(): void {
  for (const active of activeWhisperProcesses) active.forceKill();
}

function removeWhisperLifecycleHandlers(): void {
  if (!whisperLifecycleHandlersInstalled) return;
  whisperLifecycleHandlersInstalled = false;
  process.removeListener('exit', handleWhisperParentExit);
  for (const [signal, handler] of whisperParentSignalHandlers) {
    process.removeListener(signal, handler);
  }
  whisperParentSignalHandlers.clear();
}

function installWhisperLifecycleHandlers(): void {
  if (whisperLifecycleHandlersInstalled) return;
  whisperLifecycleHandlersInstalled = true;
  process.on('exit', handleWhisperParentExit);
  for (const signal of WHISPER_PARENT_SIGNALS) {
    const handler = () => {
      for (const active of activeWhisperProcesses) active.requestStop('shutdown');

      // The daemon owns graceful process termination. In a standalone runtime
      // with no other signal owner, restore the OS default after synchronously
      // killing the whole child group so this listener cannot swallow Ctrl-C.
      const hasAnotherHandler = process.listeners(signal).some((listener) => listener !== handler);
      if (!hasAnotherHandler) {
        for (const active of activeWhisperProcesses) active.forceKill();
        process.removeListener(signal, handler);
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exit(1);
        }
      }
    };
    whisperParentSignalHandlers.set(signal, handler);
    process.prependListener(signal, handler);
  }
}

function runWhisperProcess(
  cliPath: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ProcessResult> {
  throwIfAborted(options.signal);
  if (shutdownWhisperRuntimePromise) {
    return Promise.reject(new LocalWhisperRuntimeError(
      'TRANSCRIPTION_CANCELLED',
      'Local transcription runtime is shutting down.',
    ));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let finished = false;
    let stopReason: WhisperStopReason | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolveClose) => { resolveClosed = resolveClose; });

    const forceKill = () => { signalWhisperChildTree(child, 'SIGKILL'); };
    const requestStop = (reason: WhisperStopReason) => {
      if (finished) return;
      if (!stopReason) {
        stopReason = reason;
        signalWhisperChildTree(child, 'SIGTERM');
      }
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(forceKill, PROCESS_KILL_GRACE_MS);
        forceKillTimer.unref();
      }
    };
    const active: ActiveWhisperProcess = { child, closed, requestStop, forceKill };
    activeWhisperProcesses.add(active);
    installWhisperLifecycleHandlers();

    const timeout = setTimeout(() => requestStop('timeout'), options.timeoutMs);
    timeout.unref();
    const onAbort = () => requestStop('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) requestStop('cancelled');

    child.stdout.on('data', (chunk: Buffer | string) => { stdout = appendBoundedTail(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr = appendBoundedTail(stderr, chunk); });

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
      activeWhisperProcesses.delete(active);
      resolveClosed();
      if (activeWhisperProcesses.size === 0) removeWhisperLifecycleHandlers();
    };

    child.once('error', (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new LocalWhisperRuntimeError('TRANSCRIPTION_FAILED', `Could not start whisper.cpp: ${errorMessage(error)}`, { cause: error }));
    });
    child.once('close', (code, processSignal) => {
      if (finished) return;
      finished = true;
      // If the direct CLI honored SIGTERM before the grace timer, descendants
      // may still be alive in its detached process group. The leader is already
      // gone, so there is nothing left to shut down gracefully; kill the group
      // before resolving `closed` or allowing daemon exit.
      if (stopReason) forceKill();
      cleanup();
      if (stopReason === 'cancelled' || stopReason === 'shutdown') {
        reject(new LocalWhisperRuntimeError('TRANSCRIPTION_CANCELLED', 'Local transcription was cancelled.'));
        return;
      }
      if (stopReason === 'timeout') {
        reject(new LocalWhisperRuntimeError(
          'TRANSCRIPTION_TIMEOUT',
          `Local transcription timed out after ${Math.round(options.timeoutMs / 1_000)} seconds.`,
        ));
        return;
      }
      if (code !== 0) {
        const diagnostic = stderr.toString('utf8').trim().slice(-2_000);
        reject(new LocalWhisperRuntimeError(
          'TRANSCRIPTION_FAILED',
          `whisper.cpp exited with ${code === null ? `signal ${processSignal || 'unknown'}` : `code ${code}`}${diagnostic ? `: ${diagnostic}` : '.'}`,
        ));
        return;
      }
      resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

async function waitForWhisperProcesses(entries: ActiveWhisperProcess[], timeoutMs: number): Promise<void> {
  if (entries.length === 0) return;
  await Promise.race([
    Promise.all(entries.map((entry) => entry.closed)),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Gracefully stop every owned whisper.cpp process before daemon exit/update. */
export function shutdownLocalTranscriptionRuntime(
  options: { graceMs?: number } = {},
): Promise<void> {
  if (shutdownWhisperRuntimePromise) return shutdownWhisperRuntimePromise;
  const graceMs = options.graceMs ?? PROCESS_KILL_GRACE_MS;
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 30_000) {
    return Promise.reject(new Error('Whisper shutdown graceMs must be between 0 and 30000 milliseconds.'));
  }

  let tracked!: Promise<void>;
  const work = (async () => {
    const initial = [...activeWhisperProcesses];
    for (const active of initial) active.requestStop('shutdown');
    await waitForWhisperProcesses(initial, graceMs);

    const remaining = [...activeWhisperProcesses];
    for (const active of remaining) active.forceKill();
    await waitForWhisperProcesses(remaining, Math.max(1_000, Math.min(PROCESS_KILL_GRACE_MS, graceMs || 1_000)));
  })();
  tracked = work.finally(() => {
    if (shutdownWhisperRuntimePromise === tracked) shutdownWhisperRuntimePromise = undefined;
  });
  shutdownWhisperRuntimePromise = tracked;
  return tracked;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  const direct = finiteNumber(value);
  if (direct !== undefined) return direct;
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!match) return undefined;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number((match[4] || '').padEnd(3, '0'));
  if (minutes > 59 || seconds > 59) return undefined;
  return hours * 3_600 + minutes * 60 + seconds + millis / 1_000;
}

function segmentTimes(segment: Record<string, unknown>, previousEnd: number): { start: number; end: number } {
  const offsets = asRecord(segment.offsets);
  const timestamps = asRecord(segment.timestamps);

  let start = offsets ? finiteNumber(offsets.from) : undefined;
  let end = offsets ? finiteNumber(offsets.to) : undefined;
  if (start !== undefined) start /= 1_000;
  if (end !== undefined) end /= 1_000;

  start ??= finiteNumber(segment.startSeconds);
  end ??= finiteNumber(segment.endSeconds);
  start ??= finiteNumber(segment.start);
  end ??= finiteNumber(segment.end);
  if (start === undefined && finiteNumber(segment.start_ms) !== undefined) start = finiteNumber(segment.start_ms)! / 1_000;
  if (end === undefined && finiteNumber(segment.end_ms) !== undefined) end = finiteNumber(segment.end_ms)! / 1_000;
  // Some whisper wrappers expose native t0/t1 units (10 ms per tick).
  if (start === undefined && finiteNumber(segment.t0) !== undefined) start = finiteNumber(segment.t0)! / 100;
  if (end === undefined && finiteNumber(segment.t1) !== undefined) end = finiteNumber(segment.t1)! / 100;
  start ??= timestamps ? parseTimestamp(timestamps.from) : undefined;
  end ??= timestamps ? parseTimestamp(timestamps.to) : undefined;

  const normalizedStart = Math.max(0, start ?? previousEnd);
  return { start: normalizedStart, end: Math.max(normalizedStart, end ?? normalizedStart) };
}

function joinTranscriptParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse the stable whisper.cpp JSON shape plus conservative wrapper variants. */
export function parseWhisperJson(payload: string | unknown): Omit<LocalWhisperTranscription, 'model'> {
  let parsed: unknown = payload;
  if (typeof payload === 'string') {
    const trimmed = payload.replace(/^\uFEFF/, '').trim();
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new LocalWhisperRuntimeError('TRANSCRIPTION_OUTPUT_INVALID', 'whisper.cpp returned malformed JSON.', { cause: error });
    }
  }
  const root = asRecord(parsed);
  if (!root) throw new LocalWhisperRuntimeError('TRANSCRIPTION_OUTPUT_INVALID', 'whisper.cpp JSON output was not an object.');
  const result = asRecord(root.result);

  let segmentValues: unknown[] | undefined;
  if (Array.isArray(root.transcription)) segmentValues = root.transcription;
  else if (Array.isArray(root.segments)) segmentValues = root.segments;
  else if (result && Array.isArray(result.segments)) segmentValues = result.segments;

  const explicitText = typeof root.text === 'string'
    ? root.text
    : result && typeof result.text === 'string'
      ? result.text
      : typeof root.transcription === 'string'
        ? root.transcription
        : undefined;
  if (!segmentValues && explicitText === undefined) {
    throw new LocalWhisperRuntimeError('TRANSCRIPTION_OUTPUT_INVALID', 'whisper.cpp JSON did not contain transcription segments or text.');
  }

  const segments: LocalWhisperSegment[] = [];
  let previousEnd = 0;
  for (const value of segmentValues ?? []) {
    const segment = asRecord(value);
    if (!segment) continue;
    const text = typeof segment.text === 'string'
      ? segment.text.trim()
      : typeof segment.content === 'string'
        ? segment.content.trim()
        : '';
    if (!text) continue;
    const times = segmentTimes(segment, previousEnd);
    previousEnd = times.end;
    segments.push({ text, startSeconds: times.start, endSeconds: times.end });
  }

  const text = explicitText !== undefined ? explicitText.trim() : joinTranscriptParts(segments.map((segment) => segment.text));
  if ((segmentValues?.length ?? 0) > 0 && segments.length === 0 && !text) {
    throw new LocalWhisperRuntimeError('TRANSCRIPTION_OUTPUT_INVALID', 'whisper.cpp JSON contained no valid transcription segments.');
  }
  if (segments.length === 0 && text) {
    segments.push({ text, startSeconds: 0, endSeconds: 0 });
  }
  const language = result && typeof result.language === 'string'
    ? result.language.trim() || undefined
    : typeof root.language === 'string'
      ? root.language.trim() || undefined
      : undefined;
  const durationSeconds = segments.reduce((max, segment) => Math.max(max, segment.endSeconds), 0) || undefined;
  return { text, segments, language, durationSeconds };
}

async function readWhisperOutput(outputPath: string): Promise<Omit<LocalWhisperTranscription, 'model'>> {
  let info;
  try {
    info = await lstat(outputPath);
  } catch (error) {
    throw new LocalWhisperRuntimeError('TRANSCRIPTION_OUTPUT_INVALID', 'whisper.cpp completed without producing JSON output.', { cause: error });
  }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_JSON_OUTPUT_BYTES) {
    throw new LocalWhisperRuntimeError(
      'TRANSCRIPTION_OUTPUT_INVALID',
      `whisper.cpp JSON output had an invalid size (${info.size} bytes).`,
    );
  }
  return parseWhisperJson(await readFile(outputPath, 'utf8'));
}

export async function getLocalTranscriptionRuntimeStatus(): Promise<LocalTranscriptionRuntimeStatus> {
  void maybePruneWhisperRuntime();
  const model = DEFAULT_LOCAL_WHISPER_MODEL;
  const config = modelConfig(model);
  const modelPath = getLocalWhisperModelPath(model);
  const [cli, modelReady] = await Promise.all([
    resolveWhisperCli(),
    verifyModelFile(modelPath, model).catch(() => false),
  ]);
  return {
    available: cli.ok,
    platform: `${process.platform}/${process.arch}`,
    target: cli.target,
    whisperVersion: WHISPER_CPP_VERSION,
    cliPath: cli.ok ? cli.path : undefined,
    cliSource: cli.ok ? cli.source : undefined,
    model,
    modelPath,
    modelNoticePath: getLocalWhisperModelNoticePath(model),
    modelReady,
    modelBytes: config.bytes,
    modelLicense: config.license,
    modelSourceRevision: WHISPER_MODEL_REVISION,
    reason: cli.ok ? undefined : cli.reason,
  };
}

export async function transcribeLocalMeetingAudio(
  input: TranscribeLocalMeetingAudioInput,
): Promise<LocalWhisperTranscription> {
  const model = input.model ?? DEFAULT_LOCAL_WHISPER_MODEL;
  modelConfig(model);
  throwIfAborted(input.signal);
  const [audioPath, cli] = await Promise.all([validateAudioFile(input.audioPath), resolveWhisperCli()]);
  if (!cli.ok) throw new LocalWhisperRuntimeError(cli.code, cli.reason);
  const language = normalizeLanguage(model, input.language);
  const durationSeconds = await resolveAudioDurationSeconds(audioPath, input.durationSeconds);
  const timeoutMs = boundedTimeout(input.timeoutMs, durationSeconds);
  const modelPath = await ensureLocalWhisperModel(model, input.signal);
  throwIfAborted(input.signal);

  await maybePruneWhisperRuntime();
  const jobsRoot = whisperJobsRoot();
  await mkdir(jobsRoot, { recursive: true, mode: 0o700 });
  const jobDir = await mkdtemp(path.join(jobsRoot, 'transcribe-'));
  activeJobDirs.add(jobDir);
  const outputPrefix = path.join(jobDir, 'result');
  const outputPath = `${outputPrefix}.json`;
  try {
    await runWhisperProcess(cli.path, [
      '--model', modelPath,
      '--file', audioPath,
      '--language', language,
      '--output-json',
      '--output-file', outputPrefix,
      '--no-prints',
    ], { signal: input.signal, timeoutMs });
    const parsed = await readWhisperOutput(outputPath);
    return { ...parsed, model, language: parsed.language ?? language };
  } finally {
    activeJobDirs.delete(jobDir);
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrow test surface for download integrity and process behavior fixtures. */
export const __testing = {
  activeWhisperProcessCount: (): number => activeWhisperProcesses.size,
  boundedTimeout,
  detectWaveDurationSeconds,
  downloadVerifiedFile,
  ensureLocalWhisperModel,
  ensureModelNotice,
  modelNoticeText,
  normalizeLanguage,
  pruneStaleWhisperRuntimeArtifacts,
  readWhisperOutput,
  resolveAudioDurationSeconds,
  resolveWhisperCli,
  runWhisperProcess,
  validateAudioFile,
  verifyModelFile,
  clearCaches(): void {
    verificationCache.clear();
    pendingModelDownloads.clear();
  },
};
