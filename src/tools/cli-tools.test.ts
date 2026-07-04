/**
 * Run: npx tsx --test src/tools/cli-tools.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cli-tools-test-'));
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');
process.env.HOME = tmpHome;

const { registerCliTools } = await import('./cli-tools.js');

type Handler = (input: { filter?: string; refresh?: boolean }) => Promise<{ content: Array<{ text: string }> }>;

function captureLocalCliList(): Handler {
  let handler: Handler | null = null;
  const server = {
    tool(name: string, _description: string, _params: unknown, fn: Handler) {
      if (name === 'local_cli_list') handler = fn;
    },
  };
  registerCliTools(server as never);
  assert.ok(handler, 'local_cli_list should be registered');
  return handler;
}

test('local_cli_list without a filter returns fast guidance when no cached scan exists', async () => {
  const localCliList = captureLocalCliList();
  const result = await localCliList({});
  const text = result.content.map((item) => item.text).join('\n');
  assert.match(text, /No cached full CLI scan/);
  assert.match(text, /exact filter/);
  assert.match(text, /Clementine built-in tool/);
});

test.after(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
