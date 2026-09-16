/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/evidence-receipts-created-payload.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-created-payload-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createdPayloadOf } = await import('./evidence-receipts.js');

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a provider-shaped created record yields its id, outward link and a provider-minted receipt', () => {
  // The exact shape ten Outlook drafts came back with, live 2026-09-15, minus
  // the message body: the run was marked failed on "missing an exact created
  // id, handle, or receipt" while every draft existed.
  const payload = { successful: true, error: null, data: {
    '@odata.context': 'https://graph.example/$metadata#users(\'me\')/messages/$entity',
    '@odata.etag': 'W/"CQAAABYAAACM9mY4"',
    changeKey: 'CQAAABYAAACM9mY4',
    createdDateTime: '2026-09-15T15:23:51Z',
    id: 'AAMkADExOGRmNmY1LWQ1MmEt',
    internetMessageId: '<DS0PR15MB5573@example>',
    isDraft: true,
    subject: 'Broken backlinks on your site',
    webLink: 'https://outlook.example/owa/?ItemID=AAMkADExOGRmNmY1LWQ1MmEt',
  } };
  const created = createdPayloadOf(payload);
  assert.equal(created.id, 'AAMkADExOGRmNmY1LWQ1MmEt');
  assert.equal(created.handle, 'https://outlook.example/owa/?ItemID=AAMkADExOGRmNmY1LWQ1MmEt', 'the outward link is the handle');
  assert.equal(created.receipt, 'W/"CQAAABYAAACM9mY4"', 'the entity tag is a provider-minted receipt');
  assert.notEqual(created.receipt, `receipt:${created.id}`);
});

test('the Clementine-shaped created contract still reads exactly as before', () => {
  const created = createdPayloadOf({ successful: true, error: null, data: { created: { id: 'rec-1', handle: 'https://x.example/rec-1', receipt: 'rcpt-9', writtenDigest: 'a'.repeat(64) } } });
  assert.deepEqual(created, { id: 'rec-1', handle: 'https://x.example/rec-1', receipt: 'rcpt-9', writtenDigest: 'a'.repeat(64) });
});

test('an id without any outward link falls back to the id as handle, but a receipt is never invented', () => {
  const created = createdPayloadOf({ successful: true, error: null, data: { id: 'row-42', updatedAt: '2026-09-15T15:00:00Z' } });
  assert.equal(created.handle, 'row-42');
  assert.equal(created.receipt, '2026-09-15T15:00:00Z');
  const bare = createdPayloadOf({ successful: true, error: null, data: { id: 'row-43' } });
  assert.equal(bare.handle, 'row-43');
  assert.equal(bare.receipt, undefined, 'no provider-minted fact → no receipt → the settlement still refuses honestly');
  assert.deepEqual(createdPayloadOf({ successful: true, error: null, data: 'ok' }), {});
  assert.deepEqual(createdPayloadOf(null), {});
});

test('a created record that echoes its stored content is its own readback', async () => {
  const { echoedContentOf } = await import('./evidence-receipts.js');
  assert.equal(echoedContentOf({ id: 'm1', subject: 'hi', body: { content: 'Hello there', contentType: 'text' } }), 'Hello there');
  assert.equal(echoedContentOf({ id: 'm1', content: 'plain' }), 'plain');
  assert.equal(echoedContentOf({ id: 'm1', description: 'a note' }), 'a note');
  assert.equal(echoedContentOf({ id: 'm1', etag: 'x' }), undefined, 'a bare receipt with no content is not a readback');
});
