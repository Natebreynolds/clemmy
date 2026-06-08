/**
 * Run: npx tsx --test src/tools/space-tools.test.ts
 *
 * Exercises the space_save / space_list / space_get tool handlers directly
 * (no LLM, no MCP transport) via a fake capturing server, plus the
 * CLEMENTINE_SPACES flag gate. Temp CLEMENTINE_HOME so the real home is safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-tools-test-'));

const { registerSpaceTools } = await import('./space-tools.js');
const store = await import('../spaces/store.js');

type Handler = (input: Record<string, unknown>) => Promise<unknown> | unknown;
function captureTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const fake = { tool(name: string, _d: string, _p: unknown, h: Handler) { handlers[name] = h; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSpaceTools(fake as any);
  return handlers;
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.[0]?.text ?? '';
}

const tools = captureTools();

test('registerSpaceTools exposes the three tools', () => {
  assert.ok(tools.space_save);
  assert.ok(tools.space_list);
  assert.ok(tools.space_get);
});

test('space_save creates a workspace, installs the view, returns the URL', async () => {
  // Clem "writes" the view with write_file first → emulate by writing into BASE_DIR.
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'spaces', 'crm', 'view', 'index.html');
  mkdirSync(path.dirname(draft), { recursive: true });
  writeFileSync(draft, '<html><body>CRM v1</body></html>', 'utf-8');

  const res = await tools.space_save({ slug: 'crm', title: 'CRM Board', view_path: draft });
  const out = text(res);
  assert.match(out, /Created workspace "CRM Board"/);
  assert.match(out, /\/workspaces\/crm/);

  const rec = store.spaceStore.get('crm');
  assert.equal(rec?.title, 'CRM Board');
  const canonical = store.resolveInSpace('crm', 'view/index.html');
  assert.ok(existsSync(canonical));
  assert.match(readFileSync(canonical, 'utf-8'), /CRM v1/);
});

test('space_save rejects an invalid slug and a missing view on create', async () => {
  assert.match(text(await tools.space_save({ slug: 'Bad Slug', title: 'x', view_path: null })), /not a valid workspace slug/);
  assert.match(text(await tools.space_save({ slug: 'newone', title: 'x', view_path: null })), /view_path is required/);
});

test('space_save updates in place + snapshots the prior view (revert path)', async () => {
  const draft2 = path.join(process.env.CLEMENTINE_HOME!, 'tmp-crm-v2.html');
  writeFileSync(draft2, '<html><body>CRM v2</body></html>', 'utf-8');
  const res = await tools.space_save({ slug: 'crm', title: 'CRM Board', view_path: draft2 });
  assert.match(text(res), /Updated workspace/);
  const rec = store.spaceStore.get('crm');
  assert.equal(rec?.version, 2);
  assert.equal(rec?.revisions.length, 1);
  // canonical now holds v2; the snapshot holds v1.
  assert.match(readFileSync(store.resolveInSpace('crm', 'view/index.html'), 'utf-8'), /CRM v2/);
  assert.match(readFileSync(store.resolveInSpace('crm', rec!.revisions[0].file), 'utf-8'), /CRM v1/);
});

test('space_save records declared data sources + re-engage contract', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-planner.html');
  writeFileSync(draft, '<html>planner</html>', 'utf-8');
  await tools.space_save({
    slug: 'planner',
    title: 'Daily Planner',
    view_path: draft,
    data_sources: [{ id: 'cal', composio_slug: 'GOOGLECALENDAR_LIST_EVENTS', composio_args_json: '{"max":10}', schedule: '0 7 * * *', timezone: 'America/Los_Angeles', runner: null }],
    reengage_triggers: ['note', 'ask'],
    reengage_guidance: 'reschedule anything that slips',
  });
  const rec = store.spaceStore.get('planner');
  assert.equal(rec?.dataSources.length, 1);
  assert.equal(rec?.dataSources[0].composioSlug, 'GOOGLECALENDAR_LIST_EVENTS');
  assert.deepEqual(rec?.dataSources[0].composioArgs, { max: 10 });
  assert.deepEqual(rec?.reengage?.triggers, ['note', 'ask']);
});

test('space_list + space_get read back', async () => {
  assert.match(text(await tools.space_list({})), /CRM Board/);
  const got = text(await tools.space_get({ slug: 'crm' }));
  assert.match(got, /Workspace "CRM Board"/);
  assert.match(got, /v2/);
});

test('space_edit_view applies a targeted change + bumps version + snapshots', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-edit-view.html');
  writeFileSync(draft, '<html><body><button>Call</button></body></html>', 'utf-8');
  await tools.space_save({ slug: 'editable', title: 'Editable', view_path: draft });
  const before = store.spaceStore.get('editable')!.version;

  const res = await tools.space_edit_view({
    slug: 'editable',
    edits: [{ find: '<button>Call</button>', replace: '<a href="tel:+1">Call</a>' }],
  });
  assert.match(text(res), /Applied 1 edit/);
  const canonical = readFileSync(store.resolveInSpace('editable', 'view/index.html'), 'utf-8');
  assert.match(canonical, /href="tel:\+1"/);
  assert.equal(canonical.includes('<button>Call</button>'), false);
  assert.equal(store.spaceStore.get('editable')!.version, before + 1); // bumped + snapshot taken
});

test('space_edit_view reports when no find string matches (no write)', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-edit-nomatch.html');
  writeFileSync(draft, '<html>hello</html>', 'utf-8');
  await tools.space_save({ slug: 'nomatch', title: 'NoMatch', view_path: draft });
  const res = await tools.space_edit_view({ slug: 'nomatch', edits: [{ find: 'NOT THERE', replace: 'x' }] });
  assert.match(text(res), /No edits applied/);
  assert.match(readFileSync(store.resolveInSpace('nomatch', 'view/index.html'), 'utf-8'), /hello/);
});

test('isSpacesEnabled defaults ON (beta) and honors the kill-switch', () => {
  const prev = process.env.CLEMENTINE_SPACES;
  delete process.env.CLEMENTINE_SPACES;
  assert.equal(store.isSpacesEnabled(), true); // default ON
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    process.env.CLEMENTINE_SPACES = off;
    assert.equal(store.isSpacesEnabled(), false, `kill-switch "${off}" should disable`);
  }
  for (const on of ['', '1', 'true', 'on', 'yes', 'anything']) {
    process.env.CLEMENTINE_SPACES = on;
    assert.equal(store.isSpacesEnabled(), true, `"${on}" should stay enabled`);
  }
  if (prev === undefined) delete process.env.CLEMENTINE_SPACES; else process.env.CLEMENTINE_SPACES = prev;
});
