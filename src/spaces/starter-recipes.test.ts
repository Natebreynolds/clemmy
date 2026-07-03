/**
 * Run: npx tsx --test src/spaces/starter-recipes.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-starter-recipes-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { availableStarterRecipes, maybeOfferStarterWorkspace, readStarterOfferMarker, WORKSPACE_STARTER_RECIPES } = await import('./starter-recipes.js');
const { SPACES_DIR } = await import('./store.js');

test('availableStarterRecipes: runtime connections drive the connected flag; connection-free recipes always qualify', () => {
  const sf = availableStarterRecipes(['SALESFORCE', 'googlecalendar']);
  const byId = Object.fromEntries(sf.map((r) => [r.id, r.connected]));
  assert.equal(byId['deal-board'], true, 'salesforce → deal board relevant');
  assert.equal(byId['daily-brief'], true, 'calendar → daily brief relevant');
  assert.equal(byId['seo-rank-tracker'], false, 'no seo connection → not connected');
  assert.equal(byId['task-cockpit'], true, 'connection-free recipe always available');

  const none = availableStarterRecipes([]);
  assert.ok(none.some((r) => r.id === 'task-cockpit' && r.connected), 'no connections → connection-free still works');
  assert.ok(WORKSPACE_STARTER_RECIPES.length >= 5, 'a real starter library, not a stub');
});

test('maybeOfferStarterWorkspace: offers ONCE when zero workspaces + a connection; never again after', async () => {
  const notifications: Array<{ id: string; title: string; body: string }> = [];
  const deps = {
    listConnectedSlugs: async () => ['salesforce'],
    notify: ((n: { id: string; title: string; body: string }) => { notifications.push(n); }) as never,
  };
  const fired = await maybeOfferStarterWorkspace(deps);
  assert.equal(fired, true, 'zero workspaces + a connection → offer fires');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].id, 'starter-workspace-offer', 'stable id for at-most-once delivery');
  assert.match(notifications[0].body, /Deal Board/, 'the offer names the connection-matched recipe');
  assert.ok(readStarterOfferMarker(), 'marker written');

  const again = await maybeOfferStarterWorkspace(deps);
  assert.equal(again, false, 'marker → never offers twice');
  assert.equal(notifications.length, 1);
});

test('maybeOfferStarterWorkspace: a user who already HAS workspaces is never nudged', async () => {
  // Fresh home for this case.
  rmSync(path.join(TMP_HOME, 'state', 'starter-workspace-offer.json'), { force: true });
  mkdirSync(path.join(SPACES_DIR, 'existing-space', 'view'), { recursive: true });
  writeFileSync(path.join(SPACES_DIR, 'existing-space', 'space.json'), JSON.stringify({
    id: 'existing-space', title: 'Existing', status: 'active', version: 1, viewEntry: 'view/index.html',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    dataSources: [], actions: [], revisions: [],
  }), 'utf-8');
  const notifications: unknown[] = [];
  const fired = await maybeOfferStarterWorkspace({
    listConnectedSlugs: async () => ['salesforce'],
    notify: ((n: unknown) => { notifications.push(n); }) as never,
  });
  assert.equal(fired, false);
  assert.equal(notifications.length, 0, 'existing workspaces → no nudge, ever');
  const marker = readStarterOfferMarker();
  assert.equal((marker as { reason?: string })?.reason, 'already-has-workspaces', 'marker records why, so we never rescan');
});

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
