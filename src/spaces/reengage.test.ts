/**
 * Run: npx tsx --test src/spaces/reengage.test.ts
 *
 * The canonical re-engage path (shared by the HTTP route AND the scheduler):
 * records a note+audit always; wakes only when the trigger is configured (or
 * it's an explicit 'ask'); 404/423 guards. Temp CLEMENTINE_HOME, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reengage-test-'));

const store = await import('./store.js');
const data = await import('./data-store.js');
const { reengageSpace, spaceSessionId } = await import('./reengage.js');

test('not found → 404; archived → 423', async () => {
  assert.equal((await reengageSpace('nope-nope', { trigger: 'ask' })).status, 404);
  store.spaceStore.save({ id: 'rg-arch', title: 'Arch' });
  store.spaceStore.archive('rg-arch');
  assert.equal((await reengageSpace('rg-arch', { trigger: 'ask' })).status, 423);
});

test("records a note+audit always; an unconfigured non-'ask' trigger does NOT wake", async () => {
  const slug = 'rg-note';
  store.spaceStore.save({ id: slug, title: 'Note' }); // no reengage config
  const out = await reengageSpace(slug, { trigger: 'threshold', message: 'deal X went cold' });
  assert.equal(out.status, 202);
  assert.equal(out.body.reengaged, false);
  assert.equal(out.body.reason, 'trigger not configured');
  assert.ok(data.listNotes(slug).some((n) => n.kind === 'threshold' && /went cold/.test(n.text)));
  assert.ok(data.listAudit(slug).some((a) => a.path === '/reengage/threshold'));
});

test("a configured 'threshold' trigger wakes (reengaged:true, session = space-<slug>)", async () => {
  const slug = 'rg-wake';
  store.spaceStore.save({ id: slug, title: 'Wake', reengage: { triggers: ['threshold'], guidance: 'draft a follow-up' } });
  const out = await reengageSpace(slug, { trigger: 'threshold', message: 'idle 14d' });
  assert.equal(out.body.reengaged, true);
  assert.equal(out.body.sessionId, spaceSessionId(slug));
});

test("'ask' always wakes even with no configured triggers", async () => {
  const slug = 'rg-ask';
  store.spaceStore.save({ id: slug, title: 'Ask' });
  const out = await reengageSpace(slug, { trigger: 'ask', message: 'why is this cold?' });
  assert.equal(out.body.reengaged, true);
});
