/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/held-inventory.test.ts
 *
 * Compaction collapses older tool results to keep per-frame prefill cheap, and
 * that trade is measured and correct. What it never priced is that collapsing a
 * search result destroys the model's only VIEW of the capabilities it found —
 * while those capabilities stay callable in the catalog the whole time.
 *
 * Live 2026-09-12, sess-desktop-03fef66ec002984d6bd0b8d2: seven pairs collapsed
 * at 05:28:33, then six near-identical DataForSEO searches over four minutes —
 * three byte-for-byte repeats — against NINE DataForSEO operations already
 * proven. Across four Plan turns: 945 pairs collapsed and 78 recall calls in the
 * worst one. Re-searching costs one call; recalling costs a call plus knowing
 * which call_id to ask for.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-held-inventory-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('./eventlog.js');
const { heldInventory, heldInventoryLines } = await import('./held-inventory.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function turn() {
  const session = eventlog.createSession({ kind: 'chat', userId: 'fixture-owner' });
  const event = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'plan the research' },
  });
  return { sessionId: session.id, sourceUserSeq: event.seq };
}

function prove(id: { sessionId: string; sourceUserSeq: number }, ...identifiers: string[]) {
  eventlog.appendEvent({
    sessionId: id.sessionId, turn: 1, role: 'system', type: 'capability_resolution',
    data: {
      sourceUserSeq: id.sourceUserSeq,
      entries: identifiers.map((identifier) => ({
        kind: 'composio', identifier, status: 'proven', connection: 'active',
      })),
    },
  });
}

test('the inventory is what survives a collapse: toolkits, operations, inputs read', () => {
  const id = turn();
  eventlog.appendEvent({
    sessionId: id.sessionId, turn: 1, role: 'system', type: 'read_receipt',
    data: { sourceUserSeq: id.sourceUserSeq, record: { identifier: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', effectClass: 'read' } },
  });
  // The live shape: nine DataForSEO operations plus one Apify.
  prove(id, ...Array.from({ length: 9 }, (_, i) => `DATAFORSEO_OP_${i}`));
  prove(id, 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS');

  const held = heldInventory(id.sessionId, id.sourceUserSeq);
  assert.equal(held.total, 10);
  assert.equal(held.toolkits.length, 2);
  assert.equal(held.toolkits[0]!.toolkit, 'DATAFORSEO', 'the widest toolkit leads');
  assert.equal(held.toolkits[1]!.toolkit, 'APIFY');
  assert.deepEqual(held.reads, ['GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT']);

  const lines = heldInventoryLines(held).join('\n');
  assert.match(lines, /still held/i);
  assert.match(lines, /did NOT withdraw/i, 'it must say the collapse took nothing away');
  assert.match(lines, /DATAFORSEO/);
  assert.match(lines, /APIFY/);
  assert.match(lines, /Inputs already read/i);
  // The exact instruction that would have ended the live loop.
  assert.match(lines, /Do NOT search again for a toolkit listed here/i);
  assert.match(lines, /PROVEN and CALLABLE right now/i);
});

test('it is bounded — a map must never grow into the thing it replaces', () => {
  const id = turn();
  for (let kit = 0; kit < 14; kit += 1) {
    prove(id, ...Array.from({ length: 20 }, (_, i) => `KIT${kit}_OP_${i}`));
  }
  const held = heldInventory(id.sessionId, id.sourceUserSeq);
  assert.ok(held.toolkits.length <= 8, `toolkits capped, got ${held.toolkits.length}`);
  for (const entry of held.toolkits) {
    assert.ok(entry.operations.length <= 6, `operations capped, got ${entry.operations.length}`);
  }
  // A few hundred bytes, not a few thousand.
  assert.ok(heldInventoryLines(held).join('\n').length < 2_000);
  // The count stays HONEST even though the listing is capped.
  assert.equal(held.total, 280, 'the total reports everything proven, not just what is shown');
});

test('nothing held means no block — a heading over an empty list teaches the model to skip headings', () => {
  const id = turn();
  assert.deepEqual(heldInventoryLines(heldInventory(id.sessionId, id.sourceUserSeq)), []);
  assert.deepEqual(heldInventoryLines({ toolkits: [], reads: [], total: 0 }), []);
});

test('only PROVEN, present capabilities are claimed as held', () => {
  const id = turn();
  eventlog.appendEvent({
    sessionId: id.sessionId, turn: 1, role: 'system', type: 'capability_resolution',
    data: {
      sourceUserSeq: id.sourceUserSeq,
      entries: [
        { kind: 'composio', identifier: 'GOOD_OP', status: 'proven', connection: 'active' },
        { kind: 'composio', identifier: 'UNPROVEN_OP', status: 'candidate', connection: 'active' },
        { kind: 'composio', identifier: 'GONE_OP', status: 'proven', connection: 'missing' },
      ],
    },
  });
  const held = heldInventory(id.sessionId, id.sourceUserSeq);
  const text = JSON.stringify(held);
  assert.match(text, /GOOD_OP/);
  assert.doesNotMatch(text, /UNPROVEN_OP/, 'a candidate is not something she holds');
  assert.doesNotMatch(text, /GONE_OP/, 'a missing connection is not callable');
  assert.equal(held.total, 1);
});

test('a duplicate proof is not a second capability', () => {
  const id = turn();
  prove(id, 'DATAFORSEO_SAME');
  prove(id, 'DATAFORSEO_SAME');
  prove(id, 'DATAFORSEO_SAME');
  assert.equal(heldInventory(id.sessionId, id.sourceUserSeq).total, 1,
    're-proving one operation three times is one operation held');
});

test('a broken ledger yields no inventory rather than a wrong one', () => {
  assert.deepEqual(heldInventory('', 1), { toolkits: [], reads: [], total: 0 });
  assert.deepEqual(heldInventory('no-such-session', 5), { toolkits: [], reads: [], total: 0 });
});

test('the collapse summary actually carries it — the wiring, not the helper', async () => {
  // WHO CALLS THIS. The inventory is worthless if the collapse summary does not
  // include it, and that summary is built deep inside compaction where a unit
  // test cannot easily reach. Pin the call edge at the source.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./compaction.ts', import.meta.url), 'utf8');
  assert.match(source, /heldInventoryLines\(heldInventory\(sessionId\)\)/,
    'buildCollapsedToolPairsSummary must add the held inventory');
  // It must ride AHEAD of the per-pair lines and outside the char budget, so a
  // truncated summary can drop pair detail but never the map.
  const summaryStart = source.indexOf('function buildCollapsedToolPairsSummary');
  const inventoryAt = source.indexOf('heldInventoryLines', summaryStart);
  const budgetAt = source.indexOf('let chars = lines.join', summaryStart);
  assert.ok(inventoryAt > summaryStart && inventoryAt < budgetAt,
    'the inventory is added before the character budget begins');
});
