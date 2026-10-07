import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITY_REGISTRY, checkCapability, clearCapabilityCache,
  getCapabilityDescriptor, listKnownCapabilities, renderCapabilityResult,
} from './capabilities.js';
import { registerCapabilityTools } from '../tools/capability-tools.js';

test('Windows descriptors never expose retained Homebrew/nvm/POSIX updater hints, including raw render inputs', () => {
  const descriptors = listKnownCapabilities('win32');
  assert.equal(descriptors.length, CAPABILITY_REGISTRY.length);
  for (const descriptor of descriptors) {
    assert.doesNotMatch(descriptor.installHint, /brew install|brew tap|nvm-sh|install via nvm|curl\s.+\|\s*sh|git clone|~\/Developer/i, descriptor.name);
    assert.deepEqual(getCapabilityDescriptor(descriptor.name, 'win32'), descriptor);
  }
  for (const raw of CAPABILITY_REGISTRY) {
    const rendered = renderCapabilityResult({ name: raw.name, available: false, checkedAt: '2026-10-07T00:00:00.000Z' }, raw, 'win32');
    assert.doesNotMatch(rendered, /brew install|brew tap|nvm-sh|install via nvm|curl\s.+\|\s*sh|git clone|~\/Developer/i, raw.name);
  }
});

test('Windows catalog hints match the approved setup recipe and manual/native boundaries', () => {
  assert.match(getCapabilityDescriptor('gh', 'win32')!.installHint, /winget install --id GitHub\.cli --exact --source winget --disable-interactivity/);
  assert.match(getCapabilityDescriptor('gh', 'win32')!.installHint, /catalogId":"github/);
  assert.match(getCapabilityDescriptor('sf', 'win32')!.installHint, /npm install -g @salesforce\/cli/);
  assert.match(getCapabilityDescriptor('gcloud', 'win32')!.installHint, /official instructions.*Automatic installation is not available/);
  assert.match(getCapabilityDescriptor('node', 'win32')!.installHint, /Node\.js for Windows.*npm is included/);
  assert.match(getCapabilityDescriptor('npm', 'win32')!.installHint, /official installer/);
  assert.match(getCapabilityDescriptor('browser-harness', 'win32')!.installHint, /browser_harness_setup.*reviewed pinned Windows/);
});

test('macOS descriptor identity, metadata and install recipes remain unchanged', () => {
  for (const descriptor of CAPABILITY_REGISTRY) assert.equal(getCapabilityDescriptor(descriptor.name, 'darwin'), descriptor);
  assert.deepEqual(listKnownCapabilities('darwin'), [...CAPABILITY_REGISTRY]);
  assert.match(getCapabilityDescriptor('gh', 'darwin')!.installHint, /brew install gh/);
});

test('actual platform check_capability schema and returned descriptor use platform setup guidance', async () => {
  let description = ''; let handler: ((args: { name: string }) => Promise<{ content: Array<{ text: string }> }>) | undefined;
  const server = { tool: (_name: string, text: string, _schema: unknown, execute: typeof handler) => { description = text; handler = execute; } };
  registerCapabilityTools(server as never);
  if (process.platform === 'win32') assert.doesNotMatch(description, /brew install/);
  else assert.match(description, /brew install/);
  const output = await handler!({ name: 'totally-not-an-installed-owned-cli-78321' });
  assert.match(output.content[0].text, /NOT available/);
});

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-capability-windows-'));
after(() => rmSync(fixtureHome, { recursive: true, force: true }));

test('actual Windows capability checker launches the exact discovered batch shim and rejects timed-out partial version output', { skip: process.platform !== 'win32' }, async () => {
  const bin = path.join(fixtureHome, 'space & café 日本語'); mkdirSync(bin, { recursive: true });
  const command = `owned-capability-${process.pid}`;
  const program = path.join(bin, 'version fixture.mjs');
  writeFileSync(program, "if(process.argv.includes('--version')) {process.stdout.write('owned capability 1.0 café 日本語');} else process.exitCode=9;");
  writeFileSync(path.join(bin, `${command}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0version fixture.mjs" %*\r\n`);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  try {
    clearCapabilityCache();
    const result = await checkCapability(command, { useCache: false });
    assert.equal(result.available, true, result.error);
    assert.equal(result.source, path.join(bin, `${command}.cmd`));
    assert.equal(result.version, 'owned capability 1.0 café 日本語');
    writeFileSync(program, "process.stdout.write('partial response cannot qualify'); setInterval(()=>{},1000);");
    const timeout = await checkCapability(command, { useCache: false });
    assert.equal(timeout.available, false, 'a killed partial version cannot establish availability');
    assert.equal(timeout.source, result.source);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    clearCapabilityCache();
  }
});
