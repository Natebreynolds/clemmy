/**
 * Run: npx tsx --test src/runtime/harness/publish-provenance.test.ts
 *
 * Regression for the 2026-07-08 cross-task clobber: `sites:create --name X …
 * || sites:list --json` — the failed create's LIST fallback (exit 0, same
 * callId) handed blanket provenance to EVERY existing site, and the deploy
 * overwrote another task's live site. Listing-shaped output must confer
 * provenance ONLY on an object matching a requested create name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-provenance-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { resetEventLog, createSession, appendEvent } = await import('./eventlog.js');
const { buildPublishProvenance } = await import('./brackets.js');

function seed(sessionId: string, command: string, result: string): void {
  appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'tool_called', data: { tool: 'run_shell_command', callId: 'c1', arguments: JSON.stringify({ command }) } });
  appendEvent({ sessionId, turn: 1, role: 'tool', type: 'tool_returned', data: { tool: 'run_shell_command', callId: 'c1', result } });
}

const LISTING = `exit_code: 0\n\nstdout:\n[\n  {\n    "id": "f22da5f3-e124-4a15-8f8a-06da10c4f60e",\n    "site_id": "f22da5f3-e124-4a15-8f8a-06da10c4f60e",\n    "name": "salt-and-timber-coffee",\n    "url": "https://salt-and-timber-coffee.netlify.app"\n  }\n]`;

test('a failed create whose || list fallback exits 0 confers NO provenance on unrelated listed sites', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seed(sess.id, 'netlify sites:create --name dust-devil-coffee-co --json || netlify sites:list --json', LISTING);
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('f22da5f3-e124-4a15-8f8a-06da10c4f60e'), false, 'another task\'s site id must NOT gain provenance from a listing');
  assert.equal(has('salt-and-timber-coffee'), false, 'another task\'s site name must NOT gain provenance from a listing');
});

test('a listing that CONTAINS the requested create name provenances only that object', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const listing = LISTING.replace(/salt-and-timber-coffee/g, 'dust-devil-coffee-co').replace(/f22da5f3-e124-4a15-8f8a-06da10c4f60e/g, 'aaaa1111');
  seed(sess.id, 'netlify sites:create --name dust-devil-coffee-co --json || netlify sites:list --json', listing);
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('dust-devil-coffee-co'), true, 'the requested name matched in the listing IS provenanced');
  assert.equal(has('aaaa1111'), true, 'ids inside the matching object ride along');
});

test('a genuine single-site create result still confers provenance (unchanged path)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seed(sess.id, 'netlify sites:create --name fresh-site --json', 'exit_code: 0\n\nstdout:\n{\n  "site_id": "bbbb2222",\n  "name": "fresh-site",\n  "url": "https://fresh-site.netlify.app"\n}');
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('fresh-site'), true);
  assert.equal(has('bbbb2222'), true);
});

test('run_batch gets the long-executor timeout tier, never the 60s default (2026-07-08 false-kill)', async () => {
  const { timeoutForTool, DEFAULT_TIMEOUTS_MS } = await import('./brackets.js');
  assert.equal(timeoutForTool('run_batch'), DEFAULT_TIMEOUTS_MS.shell);
  assert.ok(timeoutForTool('run_batch') >= 600_000);
});
