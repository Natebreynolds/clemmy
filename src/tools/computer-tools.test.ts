/**
 * Run: npx tsx --test src/tools/computer-tools.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-computer-tools-test-'));
process.env.HOME = tmpHome;
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');

let getComputerTools: typeof import('./computer-tools.js').getComputerTools;

before(async () => {
  ({ getComputerTools } = await import('./computer-tools.js'));
});

after(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeTool(): Extract<ReturnType<typeof getComputerTools>[number], { name: 'write_file' }> {
  return getComputerTools().find((tool) => tool.name === 'write_file') as Extract<ReturnType<typeof getComputerTools>[number], { name: 'write_file' }>;
}

async function invokeWrite(input: { path: string; content: string; mode: 'create' | 'append' | 'overwrite' | null }): Promise<string> {
  const tool = writeTool() as unknown as {
    invoke: (runContext: unknown, input: string, details: unknown) => Promise<string>;
  };
  return tool.invoke(
    { context: { sessionId: 'sess-write-test', turn: 0 } },
    JSON.stringify(input),
    { toolCall: { callId: `call_${Date.now()}` } },
  );
}

test('write_file create refuses to clobber an existing file', async () => {
  const file = path.join(tmpHome, 'report.md');
  assert.equal(await invokeWrite({ path: file, content: 'first', mode: null }), `Wrote ${file} (5 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'first\n');

  const second = await invokeWrite({ path: file, content: 'second', mode: null });
  assert.match(second, /Refused to overwrite existing file/);
  assert.equal(readFileSync(file, 'utf-8'), 'first\n');
});

test('write_file append preserves existing content', async () => {
  const file = path.join(tmpHome, 'append.md');
  assert.equal(await invokeWrite({ path: file, content: 'alpha', mode: null }), `Wrote ${file} (5 chars).`);
  assert.equal(await invokeWrite({ path: file, content: 'beta', mode: 'append' }), `Appended ${file} (4 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'alpha\nbeta\n');
});

test('write_file overwrite requires explicit overwrite mode', async () => {
  const file = path.join(tmpHome, 'overwrite.md');
  assert.equal(await invokeWrite({ path: file, content: 'old', mode: null }), `Wrote ${file} (3 chars).`);
  assert.equal(await invokeWrite({ path: file, content: 'new', mode: 'overwrite' }), `Overwrote ${file} (3 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'new\n');
});

test('write_file append creates a missing file', async () => {
  const file = path.join(tmpHome, 'missing.md');
  assert.equal(existsSync(file), false);
  assert.equal(await invokeWrite({ path: file, content: 'created by append', mode: 'append' }), `Appended ${file} (17 chars).`);
  assert.equal(readFileSync(file, 'utf-8'), 'created by append\n');
});
