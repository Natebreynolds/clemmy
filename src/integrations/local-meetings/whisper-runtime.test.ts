import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const previousHome = process.env.CLEMENTINE_HOME;
const previousCli = process.env.CLEMENTINE_WHISPER_CLI;
const testHome = await mkdtemp(path.join(os.tmpdir(), 'clementine-whisper-runtime-'));
process.env.CLEMENTINE_HOME = testHome;

const runtime = await import('./whisper-runtime.js');

after(async () => {
  if (previousHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = previousHome;
  if (previousCli === undefined) delete process.env.CLEMENTINE_WHISPER_CLI;
  else process.env.CLEMENTINE_WHISPER_CLI = previousCli;
  await rm(testHome, { recursive: true, force: true });
});

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function isRuntimeError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof runtime.LocalWhisperRuntimeError && error.code === code;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForProcessPid(pidPath: string): Promise<number> {
  let pid = 0;
  await waitUntil(async () => {
    try {
      pid = Number(await readFile(pidPath, 'utf8'));
      return Number.isSafeInteger(pid) && pid > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }, 5_000);
  return pid;
}

test('maps every packaged platform target and rejects unsupported targets', () => {
  assert.equal(runtime.resolveWhisperRuntimeTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(runtime.resolveWhisperRuntimeTarget('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.equal(runtime.resolveWhisperRuntimeTarget('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.equal(runtime.resolveWhisperRuntimeTarget('win32', 'arm64'), undefined);
  assert.equal(runtime.resolveWhisperRuntimeTarget('linux', 'x64'), undefined);
});

test('parses official whisper.cpp JSON offsets and language', () => {
  const parsed = runtime.parseWhisperJson({
    result: { language: 'en' },
    transcription: [
      { offsets: { from: 0, to: 1_250 }, text: ' Hello' },
      { offsets: { from: 1_250, to: 2_500 }, text: 'world.' },
    ],
  });
  assert.equal(parsed.text, 'Hello world.');
  assert.equal(parsed.language, 'en');
  assert.equal(parsed.durationSeconds, 2.5);
  assert.deepEqual(parsed.segments, [
    { text: 'Hello', startSeconds: 0, endSeconds: 1.25 },
    { text: 'world.', startSeconds: 1.25, endSeconds: 2.5 },
  ]);
});

test('parses timestamp and wrapper variants without trusting malformed payloads', () => {
  const parsed = runtime.parseWhisperJson({
    segments: [
      { timestamps: { from: '00:00:01,200', to: '00:00:02.750' }, content: 'First' },
      { start: 2.75, end: 3.5, text: ', then second' },
    ],
  });
  assert.equal(parsed.text, 'First, then second');
  assert.deepEqual(parsed.segments[0], { text: 'First', startSeconds: 1.2, endSeconds: 2.75 });
  assert.throws(() => runtime.parseWhisperJson('{not-json'), isRuntimeError('TRANSCRIPTION_OUTPUT_INVALID'));
  assert.throws(() => runtime.parseWhisperJson({ result: { language: 'en' } }), isRuntimeError('TRANSCRIPTION_OUTPUT_INVALID'));
});

test('downloads to a part file, verifies SHA-256, and atomically installs it', async () => {
  const body = Buffer.from('verified local model fixture');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    response.end(body);
  });
  const baseUrl = await listen(server);
  const destination = path.join(testHome, 'download-success', 'model.bin');
  try {
    await runtime.__testing.downloadVerifiedFile({
      url: `${baseUrl}/model.bin`,
      destination,
      sha256: sha256(body),
      bytes: body.length,
    });
    assert.deepEqual(await readFile(destination), body);
    assert.equal((await stat(destination)).isFile(), true);
    assert.deepEqual((await readdir(path.dirname(destination))).filter((name) => name.endsWith('.part')), []);
  } finally {
    await close(server);
  }
});

test('rejects a checksum mismatch and never promotes the part file', async () => {
  const body = Buffer.from('wrong model bytes');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': String(body.length) });
    response.end(body);
  });
  const baseUrl = await listen(server);
  const destination = path.join(testHome, 'download-mismatch', 'model.bin');
  try {
    await assert.rejects(
      runtime.__testing.downloadVerifiedFile({
        url: `${baseUrl}/model.bin`,
        destination,
        sha256: sha256(Buffer.from('same byte length!')),
        bytes: body.length,
      }),
      isRuntimeError('MODEL_CHECKSUM_MISMATCH'),
    );
    await assert.rejects(stat(destination), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.deepEqual((await readdir(path.dirname(destination))).filter((name) => name.endsWith('.part')), []);
  } finally {
    await close(server);
  }
});

test('writes immutable pinned provenance and license metadata beside the model', async () => {
  const noticePath = await runtime.__testing.ensureModelNotice('base.en');
  const notice = JSON.parse(await readFile(noticePath, 'utf8')) as {
    model: { id: string; bytes: number; sha256: string };
    provenance: { originalModel: string; conversionRepositoryUrl: string; conversionRevision: string };
    license: { spdx: string; declaredBy: string; declarationUrl: string };
  };
  assert.equal(noticePath, runtime.getLocalWhisperModelNoticePath('base.en'));
  assert.equal(notice.model.id, 'base.en');
  assert.equal(notice.model.bytes, 147_964_211);
  assert.equal(notice.model.sha256, 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002');
  assert.equal(notice.provenance.originalModel, 'OpenAI Whisper base.en');
  assert.equal(notice.provenance.conversionRepositoryUrl, 'https://huggingface.co/ggerganov/whisper.cpp');
  assert.equal(notice.provenance.conversionRevision, runtime.WHISPER_MODEL_REVISION);
  assert.equal(notice.license.spdx, 'MIT');
  assert.match(notice.license.declaredBy, /Hugging Face model repository metadata/);
  assert.equal(
    notice.license.declarationUrl,
    `https://huggingface.co/ggerganov/whisper.cpp/blob/${runtime.WHISPER_MODEL_REVISION}/README.md`,
  );
  assert.deepEqual(
    (await readdir(path.dirname(noticePath))).filter((name) => name.endsWith('.part')),
    [],
  );
});

test('prunes only stale Whisper-owned artifacts and never follows symlinks', async () => {
  const now = Date.now();
  const oldTime = new Date(now - 48 * 60 * 60 * 1_000);
  const modelPath = runtime.getLocalWhisperModelPath('base.en');
  const modelDir = path.dirname(modelPath);
  const modelName = path.basename(modelPath);
  await mkdir(modelDir, { recursive: true });

  const stalePart = path.join(modelDir, `${modelName}.stale.part`);
  const freshPart = path.join(modelDir, `${modelName}.fresh.part`);
  const unrelatedPart = path.join(modelDir, 'another-model.stale.part');
  const outsideFile = path.join(testHome, 'outside-model-target.txt');
  const linkedPart = path.join(modelDir, `${modelName}.linked.part`);
  await Promise.all([
    writeFile(stalePart, 'stale'),
    writeFile(freshPart, 'fresh'),
    writeFile(unrelatedPart, 'unrelated'),
    writeFile(outsideFile, 'outside'),
  ]);
  await Promise.all([utimes(stalePart, oldTime, oldTime), utimes(unrelatedPart, oldTime, oldTime)]);
  let modelSymlinkCreated = true;
  try {
    await symlink(outsideFile, linkedPart);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') modelSymlinkCreated = false;
    else throw error;
  }

  const jobsRoot = path.join(testHome, 'runtime', 'whisper', 'jobs');
  const staleJob = path.join(jobsRoot, 'transcribe-stale');
  const freshJob = path.join(jobsRoot, 'transcribe-fresh');
  const unrelatedJob = path.join(jobsRoot, 'unrelated-old');
  const outsideJob = path.join(testHome, 'outside-job-target');
  const linkedJob = path.join(jobsRoot, 'transcribe-linked');
  await Promise.all([
    mkdir(staleJob, { recursive: true }),
    mkdir(freshJob, { recursive: true }),
    mkdir(unrelatedJob, { recursive: true }),
    mkdir(outsideJob, { recursive: true }),
  ]);
  await writeFile(path.join(staleJob, 'result.json'), '{}');
  await Promise.all([utimes(staleJob, oldTime, oldTime), utimes(unrelatedJob, oldTime, oldTime)]);
  let jobSymlinkCreated = true;
  try {
    await symlink(outsideJob, linkedJob, 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') jobSymlinkCreated = false;
    else throw error;
  }

  const result = await runtime.__testing.pruneStaleWhisperRuntimeArtifacts({
    now,
    staleAfterMs: 24 * 60 * 60 * 1_000,
  });
  assert.equal(result.modelPartsDeleted, 1);
  assert.equal(result.jobDirsDeleted, 1);
  assert.equal(await pathExists(stalePart), false);
  assert.equal(await pathExists(staleJob), false);
  for (const preserved of [freshPart, unrelatedPart, outsideFile, freshJob, unrelatedJob, outsideJob]) {
    assert.equal(await pathExists(preserved), true, `${preserved} should be preserved`);
  }
  if (modelSymlinkCreated) assert.equal((await lstat(linkedPart)).isSymbolicLink(), true);
  if (jobSymlinkCreated) assert.equal((await lstat(linkedJob)).isSymbolicLink(), true);
});

async function makeExecutable(name: string, source: string): Promise<string> {
  const executable = path.join(testHome, name);
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test('runs a fake CLI without a shell and reads its JSON artifact', async () => {
  const cli = await makeExecutable('fake-whisper-cli.mjs', `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-file') + 1];
const input = args[args.indexOf('--file') + 1];
writeFileSync(output + '.json', JSON.stringify({ result: { language: 'en' }, transcription: [
  { offsets: { from: 0, to: 900 }, text: 'literal input: ' + input }
] }));
`);
  const jobDir = await mkdtemp(path.join(testHome, 'fake-job-'));
  const outputPrefix = path.join(jobDir, 'result');
  const literalInput = 'meeting.wav; touch should-not-run';
  await runtime.__testing.runWhisperProcess(
    cli,
    ['--file', literalInput, '--output-file', outputPrefix],
    { timeoutMs: 5_000 },
  );
  const parsed = await runtime.__testing.readWhisperOutput(`${outputPrefix}.json`);
  assert.equal(parsed.text, `literal input: ${literalInput}`);
  assert.equal(parsed.durationSeconds, 0.9);
});

test('terminates a stuck CLI on timeout', async () => {
  const cli = await makeExecutable('stuck-whisper-cli.mjs', `#!/usr/bin/env node
setInterval(() => {}, 1_000);
`);
  await assert.rejects(
    runtime.__testing.runWhisperProcess(cli, [], { timeoutMs: 50 }),
    isRuntimeError('TRANSCRIPTION_TIMEOUT'),
  );
});

test('terminates a CLI when the caller aborts', async () => {
  const cli = await makeExecutable('cancelled-whisper-cli.mjs', `#!/usr/bin/env node
setInterval(() => {}, 1_000);
`);
  const controller = new AbortController();
  const pending = runtime.__testing.runWhisperProcess(cli, [], { signal: controller.signal, timeoutMs: 5_000 });
  setTimeout(() => controller.abort(new Error('test abort')), 50).unref();
  await assert.rejects(pending, isRuntimeError('TRANSCRIPTION_CANCELLED'));
});

test('aborting a CLI terminates its whole POSIX process group', {
  skip: process.platform === 'win32',
}, async () => {
  const helperPidPath = path.join(testHome, 'whisper-helper.pid');
  const cli = await makeExecutable('process-tree-whisper-cli.mjs', `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(helper.pid));
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const pending = runtime.__testing.runWhisperProcess(cli, [helperPidPath], {
    signal: controller.signal,
    timeoutMs: 15_000,
  });
  let helperPid = 0;
  try {
    helperPid = await waitForProcessPid(helperPidPath);
    controller.abort(new Error('tree cleanup test'));
    await assert.rejects(pending, isRuntimeError('TRANSCRIPTION_CANCELLED'));
    await waitUntil(() => {
      try {
        process.kill(helperPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }, 5_000);
  } finally {
    controller.abort(new Error('tree cleanup test teardown'));
    await pending.catch(() => undefined);
    if (helperPid > 0) {
      try { process.kill(helperPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

test('aborting kills a descendant that ignores SIGTERM after its parent exits', {
  skip: process.platform === 'win32',
}, async () => {
  const helperPidPath = path.join(testHome, 'whisper-ignoring-helper.pid');
  const helperReadyPath = path.join(testHome, 'whisper-ignoring-helper.ready');
  const helperSource = [
    'const { writeFileSync } = require("node:fs");',
    'process.on("SIGTERM", () => {});',
    'writeFileSync(process.argv[1], "ready");',
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const cli = await makeExecutable('ignoring-tree-whisper-cli.mjs', `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helperSource)}, process.argv[3]], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(helper.pid));
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const pending = runtime.__testing.runWhisperProcess(cli, [helperPidPath, helperReadyPath], {
    signal: controller.signal,
    timeoutMs: 15_000,
  });
  let helperPid = 0;
  try {
    helperPid = await waitForProcessPid(helperPidPath);
    await waitUntil(() => pathExists(helperReadyPath), 5_000);
    controller.abort(new Error('ignoring-tree cleanup test'));
    await assert.rejects(pending, isRuntimeError('TRANSCRIPTION_CANCELLED'));
    await waitUntil(() => {
      try {
        process.kill(helperPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }, 5_000);
  } finally {
    controller.abort(new Error('ignoring-tree cleanup test teardown'));
    await pending.catch(() => undefined);
    if (helperPid > 0) {
      try { process.kill(helperPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

test('shutdown owns all active CLIs with one listener set and leaves none behind', async () => {
  const cli = await makeExecutable('shutdown-whisper-cli.mjs', `#!/usr/bin/env node
setInterval(() => {}, 1_000);
`);
  const signals = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const baseline = new Map(signals.map((signal) => [signal, process.listenerCount(signal)]));
  const first = runtime.__testing.runWhisperProcess(cli, [], { timeoutMs: 5_000 });
  const second = runtime.__testing.runWhisperProcess(cli, [], { timeoutMs: 5_000 });
  const rejected = Promise.all([
    assert.rejects(first, isRuntimeError('TRANSCRIPTION_CANCELLED')),
    assert.rejects(second, isRuntimeError('TRANSCRIPTION_CANCELLED')),
  ]);
  assert.equal(runtime.__testing.activeWhisperProcessCount(), 2);
  for (const signal of signals) {
    assert.equal(process.listenerCount(signal), baseline.get(signal)! + 1, `${signal} should have one shared cleanup listener`);
  }
  await runtime.shutdownLocalTranscriptionRuntime({ graceMs: 100 });
  await rejected;
  assert.equal(runtime.__testing.activeWhisperProcessCount(), 0);
  for (const signal of signals) {
    assert.equal(process.listenerCount(signal), baseline.get(signal), `${signal} cleanup listener should be removed`);
  }
});

test('status accepts an absolute explicit CLI and reports a pending model download', async () => {
  const cli = await makeExecutable('status-whisper-cli.mjs', '#!/usr/bin/env node\n');
  process.env.CLEMENTINE_WHISPER_CLI = cli;
  runtime.__testing.clearCaches();
  const status = await runtime.getLocalTranscriptionRuntimeStatus();
  assert.equal(status.available, true);
  assert.equal(status.cliSource, 'override');
  assert.equal(status.cliPath, cli);
  assert.equal(status.model, 'base.en');
  assert.equal(status.modelReady, false);
  assert.equal(status.modelPath.startsWith(testHome), true);
  assert.equal(status.modelNoticePath, runtime.getLocalWhisperModelNoticePath('base.en'));
  assert.equal(status.modelLicense, 'MIT');
  assert.equal(status.modelSourceRevision, runtime.WHISPER_MODEL_REVISION);
});

test('validates the pinned CLI audio allowlist before transcription', async () => {
  const wav = path.join(testHome, 'meeting.WAV');
  const m4a = path.join(testHome, 'meeting.m4a');
  await writeFile(wav, 'fixture');
  await writeFile(m4a, 'fixture');
  assert.equal(await runtime.__testing.validateAudioFile(wav), wav);
  await assert.rejects(runtime.__testing.validateAudioFile(m4a), isRuntimeError('UNSUPPORTED_AUDIO_FORMAT'));
});

function pcmWave(durationSeconds: number): Buffer {
  const sampleRate = 1;
  const channels = 1;
  const bitsPerSample = 8;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = Math.ceil(durationSeconds * byteRate);
  const wave = Buffer.alloc(44 + dataBytes);
  wave.write('RIFF', 0, 'ascii');
  wave.writeUInt32LE(36 + dataBytes, 4);
  wave.write('WAVE', 8, 'ascii');
  wave.write('fmt ', 12, 'ascii');
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(channels, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(byteRate, 28);
  wave.writeUInt16LE(blockAlign, 32);
  wave.writeUInt16LE(bitsPerSample, 34);
  wave.write('data', 36, 'ascii');
  wave.writeUInt32LE(dataBytes, 40);
  return wave;
}

test('caps decoded WAV duration and scales the default timeout', async () => {
  const longWave = path.join(testHome, 'too-long.wav');
  await writeFile(longWave, pcmWave(runtime.MAX_LOCAL_MEETING_DURATION_SECONDS + 1));
  assert.equal(
    await runtime.__testing.detectWaveDurationSeconds(longWave),
    runtime.MAX_LOCAL_MEETING_DURATION_SECONDS + 1,
  );
  await assert.rejects(
    runtime.__testing.resolveAudioDurationSeconds(longWave),
    isRuntimeError('AUDIO_TOO_LONG'),
  );
  assert.equal(runtime.__testing.boundedTimeout(undefined, 60 * 60), 55 * 60 * 1_000);
  assert.equal(runtime.__testing.boundedTimeout(undefined, 4 * 60 * 60), 190 * 60 * 1_000);
});

test('normalizes English locale variants for the pinned English-only model', () => {
  assert.equal(runtime.__testing.normalizeLanguage('base.en', 'en-US'), 'en');
  assert.equal(runtime.__testing.normalizeLanguage('base.en', 'en_GB'), 'en');
  assert.throws(() => runtime.__testing.normalizeLanguage('base.en', 'fr'), isRuntimeError('UNSUPPORTED_LANGUAGE'));
});
