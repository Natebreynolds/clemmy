/** Controlled local fixture executables only; no actual CLI or login probe. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-path-parity-'));
const priorHome = process.env.CLEMENTINE_HOME;
process.env.CLEMENTINE_HOME = home;
const { childExecutablePath, connectedCliBinDir, mergedSpawnEnv } = await import('./spawn-env.js');
const { scrubbedChildEnv } = await import('./sandboxed-script.js');
after(() => {
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

test('scrubbed and interactive children share the same nonsecret command lookup', () => {
  const previousPath = process.env.PATH;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousSecret = process.env.WEBHOOK_SECRET;
  try {
    process.env.PATH = path.join(home, 'earlier-bin');
    process.env.OPENAI_API_KEY = 'synthetic-api-secret';
    process.env.WEBHOOK_SECRET = 'synthetic-webhook-secret';
    const scrubbed = scrubbedChildEnv({ CLEMENTINE_WORKFLOW_RUN_ID: 'fixture-run' });
    const interactive = mergedSpawnEnv();
    const interactivePathKey = Object.keys(interactive).find(key => key.toLowerCase() === 'path')!;
    assert.equal(scrubbed.PATH, interactive[interactivePathKey]);
    assert.equal(scrubbed.PATH, childExecutablePath(process.env.PATH));
    assert.equal(scrubbed.CLEMENTINE_WORKFLOW_RUN_ID, 'fixture-run');
    assert.equal(scrubbed.OPENAI_API_KEY, undefined);
    assert.equal(scrubbed.WEBHOOK_SECRET, undefined);
    assert.equal(scrubbed.NO_COLOR, '1');
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.WEBHOOK_SECRET; else process.env.WEBHOOK_SECRET = previousSecret;
  }
});

test('an existing connected binary projection leads both paths once', { skip: process.platform === 'win32' }, () => {
  const directory = connectedCliBinDir()!;
  mkdirSync(directory, { recursive: true });
  const projected = childExecutablePath([path.join(home, 'earlier-bin'), directory, directory].join(path.delimiter));
  const entries = projected.split(path.delimiter);
  assert.equal(entries[0], directory);
  assert.equal(entries.filter(entry => entry === directory).length, 1);
});

test('the same fixture binary wins for normal and scrubbed workflow/Workspace children', { skip: process.platform === 'win32' }, () => {
  const command = 'clem-path-fixture';
  const wrongDir = path.join(home, 'earlier-bin');
  const selectedDir = path.join(home, 'selected-bin');
  for (const [directory, label] of [[wrongDir, 'wrong'], [selectedDir, 'selected']]) {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, command);
    writeFileSync(file, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(label)});\n`);
    chmodSync(file, 0o755);
  }
  mkdirSync(connectedCliBinDir()!, { recursive: true });
  symlinkSync(path.join(selectedDir, command), path.join(connectedCliBinDir()!, command));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = [wrongDir, selectedDir].join(path.delimiter);
    const normal = mergedSpawnEnv();
    const scrubbed = scrubbedChildEnv();
    assert.equal(execFileSync(command, [], { env: normal, encoding: 'utf8' }), 'selected');
    assert.equal(execFileSync(command, [], { env: scrubbed, encoding: 'utf8' }), 'selected');
    assert.equal(normal.PATH, scrubbed.PATH);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
});
