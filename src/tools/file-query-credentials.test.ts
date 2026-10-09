/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/file-query-credentials.test.ts
 *
 * file_query opens a file by path the way read_file does: credential files are
 * refused without being read, and secrets inside an ordinary file are
 * redacted from the passages it returns.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-file-query-credentials-'));
process.env.CLEMENTINE_HOME = path.join(HOME, '.clementine-next');
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, '.clementine-next', 'state'), { recursive: true });

const { getLocalRuntimeTools } = await import('./local-runtime-tools.js');
after(() => rmSync(HOME, { recursive: true, force: true }));

async function fileQuery(file: string, query: string): Promise<string> {
  const tool = getLocalRuntimeTools().find((entry) => entry.name === 'file_query');
  assert.ok(tool && tool.type === 'function');
  const output = await tool.invoke(new RunContext({ sessionId: 'file-query-credentials' }), JSON.stringify({ query, file }));
  return typeof output === 'string' ? output : JSON.stringify(output);
}

test('file_query refuses a credential file and never returns its contents', async () => {
  const envFile = path.join(HOME, 'project', '.env');
  mkdirSync(path.dirname(envFile), { recursive: true });
  writeFileSync(envFile, 'STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234\nDATABASE_URL=postgres://user:pass@db/app\n');
  const out = await fileQuery(envFile, 'stripe secret key');
  assert.match(out, /credential material/);
  assert.doesNotMatch(out, /sk_live_abcdefghijklmnop1234|postgres:\/\/user:pass/);
});

test('secrets inside an ordinary file are redacted from the passages file_query returns', async () => {
  const notes = path.join(HOME, 'notes', 'setup.md');
  mkdirSync(path.dirname(notes), { recursive: true });
  writeFileSync(notes, '# Setup notes\n\nThe deploy token for staging: api_key = sk-test-abcdefghijklmnopqrstuv\nUse it for the staging deploy.\n');
  const out = await fileQuery(notes, 'staging deploy token');
  assert.match(out, /Setup notes|staging/);
  assert.doesNotMatch(out, /sk-test-abcdefghijklmnopqrstuv/);
  assert.match(out, /REDACTED/);
});
