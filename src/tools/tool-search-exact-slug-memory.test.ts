/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/tool-search-exact-slug-memory.test.ts
 * Memory bookkeeping on the exact-slug discovery path is never load-bearing.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-exact-slug-memory-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-exact-slug-memory\n');
const store = await import('../memory/tool-choice-store.js');
const sources = await import('./tool-search-provider-sources.js');

after(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });

test('a remembered record the store now rejects does not abort exact-slug reconciliation for the operation', () => {
  const slug = 'FIXTURE_UPDATE_EVENT_IN_CALENDAR';
  const fingerprint = 'f'.repeat(64);
  // The rejection is real: re-saving a memo whose intent exceeds the slug rule
  // throws out of the store (live 2026-09-15: 82 chars).
  const longIntent = 'update the existing calendar event body for the adam invite with a brief clem description now';
  assert.ok(longIntent.length > 80);
  assert.throws(
    () => sources.reconcileOneExactSlugRecord({
      intent: longIntent,
      description: 'legacy memo',
      choice: { kind: 'composio', identifier: slug, testEvidence: 'fixture' },
    } as never, fingerprint),
    /intents are short canonical slugs/,
  );
  // The source-level reconcile never lets that escape, and still stamps the
  // memos it can re-save.
  store.rememberToolChoice({ intent: 'fixture.calendar.update', description: 'healthy memo', choice: { kind: 'composio', identifier: slug, testEvidence: 'fixture' } });
  assert.doesNotThrow(() => sources.reconcileExactSlugMemory(slug, fingerprint));
  const stamped = store.listToolChoices().filter((record) => record.choice?.identifier === slug && record.choice?.schemaFingerprint === fingerprint);
  assert.ok(stamped.length >= 1, 'a re-savable memo is stamped with the live contract');
});
