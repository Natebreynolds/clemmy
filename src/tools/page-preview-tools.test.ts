/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/page-preview-tools.test.ts
 *
 * page_preview is how work that produced a local page gets looked at. The
 * browser is faked through the documented override; the renderer itself is
 * covered in src/spaces/space-preview.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RunContext } from '@openai/agents';
import { BASE_DIR } from '../config.js';
import { getLocalRuntimeTools, getLocalToolCatalog } from './local-runtime-tools.js';
import { TOOL_REGISTRY } from './tool-registry.js';
import { HostLocalExecutionFailureResult } from '../runtime/harness/attempt-settlement.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const dir = path.join(BASE_DIR, 'page-preview-fixture');
mkdirSync(dir, { recursive: true });
const browser = path.join(dir, 'fake-browser.js');
const seen = path.join(dir, 'seen.json');
writeFileSync(browser, `#!/usr/bin/env node
const fs = require('node:fs');
const shot = process.argv.find((value) => value.startsWith('--screenshot='));
const index = process.argv[process.argv.length - 1].replace('file://', '');
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), host: fs.readFileSync(index, 'utf8') }));
fs.writeFileSync(shot.slice('--screenshot='.length), Buffer.from('${PNG.toString('hex')}', 'hex'));
`, 'utf8');
chmodSync(browser, 0o755);
process.env.CLEMMY_PREVIEW_BROWSER = browser;

const context = () => new RunContext({ sessionId: 'page-preview-fixture' });
const tool = () => {
  const found = getLocalRuntimeTools().find((row) => row.name === 'page_preview');
  assert.ok(found && found.type === 'function', 'page_preview is a local runtime tool');
  return found;
};

test('page_preview is a declared read that a plan may cite and a chat turn may carry', () => {
  const row = TOOL_REGISTRY.find((candidate) => candidate.name === 'page_preview');
  assert.ok(row, 'declared in the registry');
  assert.equal(row.sideEffect, 'read');
  assert.equal(row.localPlanningRead, true);
  assert.equal(row.actionTopologyRole, 'control');
  assert.equal(row.localPlanning, undefined, 'it declares no write');
  assert.ok(getLocalToolCatalog().some((candidate) => candidate.name === 'page_preview'));
});

test('page_preview returns the rendered page as an image and changes nothing', async () => {
  const file = path.join(dir, 'brief', 'index.html');
  mkdirSync(path.dirname(file), { recursive: true });
  const source = '<!doctype html><html><body><h1>Brief</h1></body></html>';
  writeFileSync(file, source, 'utf8');
  const output = await tool().invoke(context(), JSON.stringify({ path: file, width: 390, height: 800, offset_y: 1200 }));
  assert.ok(Array.isArray(output), JSON.stringify(output));
  assert.ok(output.some((row) => row.type === 'image' && row.data === PNG.toString('base64') && row.mimeType === 'image/png'));
  const note = output.find((row) => row.type === 'text')?.text ?? '';
  assert.match(note, /390×800, starting 1200px down the page/);
  assert.ok(note.includes(file), 'the note names the file that was shown');
  const observed = JSON.parse(readFileSync(seen, 'utf8')) as { argv: string[]; host: string };
  assert.ok(observed.argv.includes('--window-size=390,800'));
  assert.ok(observed.host.includes(`src="file://${file}"`), 'the browser was shown the file where it lies');
  assert.equal(readFileSync(file, 'utf8'), source, 'the page is unchanged');
});

test('page_preview refuses what read_file would refuse, and anything that is not a page', async () => {
  const notes = path.join(dir, 'notes.txt');
  writeFileSync(notes, 'plain', 'utf8');
  for (const [requested, expected] of [
    [path.join(dir, 'missing.html'), /File does not exist/],
    [dir, /Not a file/],
    [notes, /Not an HTML page/],
    [path.join(dir, 'mcp', 'servers.json'), /credential material/],
  ] as const) {
    const refused = await tool().invoke(context(), JSON.stringify({ path: requested }));
    assert.ok(refused instanceof HostLocalExecutionFailureResult, `${requested}: a refusal is a failure, never an image`);
    assert.match(JSON.stringify(refused), expected, requested);
  }
});

test('page_preview reads only where the owner lets files be read', async () => {
  const { loadProactivityPolicy, saveProactivityPolicy } = await import('../agents/proactivity-policy.js');
  const before = loadProactivityPolicy().autoApproveScope;
  saveProactivityPolicy({ autoApproveScope: 'workspace' });
  try {
    const refused = await tool().invoke(context(), JSON.stringify({ path: '/etc/hosts.html' }));
    assert.ok(refused instanceof HostLocalExecutionFailureResult);
    assert.match(JSON.stringify(refused), /outside allowed workspace roots/);
  } finally {
    saveProactivityPolicy({ autoApproveScope: before });
  }
});

test('page_preview says so when no browser can render', async () => {
  const file = path.join(dir, 'brief', 'index.html');
  process.env.CLEMMY_PREVIEW_BROWSER = path.join(dir, 'fake-browser-that-writes-nothing.js');
  writeFileSync(process.env.CLEMMY_PREVIEW_BROWSER, '#!/usr/bin/env node\n', 'utf8');
  chmodSync(process.env.CLEMMY_PREVIEW_BROWSER, 0o755);
  try {
    const refused = await tool().invoke(context(), JSON.stringify({ path: file }));
    assert.ok(refused instanceof HostLocalExecutionFailureResult);
    assert.match(JSON.stringify(refused), /Preview unavailable: the browser did not produce a preview in time/);
  } finally {
    process.env.CLEMMY_PREVIEW_BROWSER = browser;
  }
});

test('reading a page\'s source says where its picture is, and reading anything else does not', async () => {
  const { executeLocalFileRead, PAGE_SOURCE_NOTE } = await import('./computer-tools.js');
  const page = path.join(dir, 'brief', 'index.html');
  const notes = path.join(dir, 'notes.txt');
  writeFileSync(page, '<!doctype html><title>t</title>', 'utf8');
  writeFileSync(notes, 'plain', 'utf8');
  const read = String(await executeLocalFileRead({ path: page, max_chars: null } as never, undefined, undefined));
  assert.ok(read.includes(PAGE_SOURCE_NOTE), read.slice(0, 160));
  assert.match(read, /<!doctype html>/);
  assert.match(PAGE_SOURCE_NOTE, /page_preview/);
  // A workflow that consumes the bytes as data is handed the file and nothing else.
  const data = String(await executeLocalFileRead({ path: page, max_chars: null } as never, undefined, undefined, { completeOutput: true }));
  assert.equal(data, '<!doctype html><title>t</title>');
  const plain = String(await executeLocalFileRead({ path: notes, max_chars: null } as never, undefined, undefined, { completeOutput: true }));
  assert.equal(plain, 'plain');
});
