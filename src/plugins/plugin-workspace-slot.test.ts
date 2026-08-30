/**
 * Run: npx tsx --test src/plugins/plugin-workspace-slot.test.ts
 *
 * The workspace slot on the cartridge: a plugin may ship a view plus declared
 * data sources, and it may ship ONLY what `space_save` itself would accept.
 *
 * A cartridge is a file someone downloads from someone else. Every other
 * Workspace path refuses opaque runners and un-vetted slugs because a refresh
 * runs with no agent turn and no human at the boundary; a download is even
 * further from that. So the refusals are pinned in both directions here: the
 * clean cartridge installs and materializes onto the real shelf, and each
 * unsafe shape is rejected AT THE SLOT — before consent, not after.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plugin-ws-'));

const { previewPlugin, installPlugin, uninstallPlugin } = await import('./plugin-store.js');
const { spaceStore, resolveSpaceDir } = await import('../spaces/store.js');
const currentCapabilityFixtures = await import('../runtime/harness/current-capability-manifest.fixture.js');

let previousCapabilityCatalog: ReturnType<
  typeof currentCapabilityFixtures.installCurrentCapabilityManifestFixtures
> = null;

before(() => {
  previousCapabilityCatalog = currentCapabilityFixtures.installCurrentCapabilityManifestFixtures([{
    operationId: 'GOOGLESHEETS_BATCH_GET',
    providerKind: 'composio',
    effect: 'read',
  }]);
});

after(() => {
  currentCapabilityFixtures.restoreCurrentCapabilityManifestFixtures(previousCapabilityCatalog);
});

let serial = 0;

/** A cartridge whose only content is one workspace. */
function buildFixture(workspace: Record<string, unknown>, opts: {
  slug?: string;
  writeView?: boolean;
  viewPath?: string;
} = {}): string {
  serial += 1;
  const slug = opts.slug ?? `acme-pipeline-${serial}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemplug-ws-'));
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: `acme.pipeline-${serial}`,
    name: 'Acme Pipeline',
    version: '1.0.0',
    requires: { connections: ['salesforce'] },
  }));
  const root = path.join(dir, 'workspaces', slug);
  mkdirSync(path.join(root, 'view'), { recursive: true });
  writeFileSync(path.join(root, 'workspace.json'), JSON.stringify(workspace));
  if (opts.writeView !== false) {
    writeFileSync(path.join(root, opts.viewPath ?? 'view/index.html'), '<h1>Pipeline</h1>');
  }
  return dir;
}

const READ_ONLY_SOURCE = {
  id: 'pipeline',
  composioSlug: 'GOOGLESHEETS_BATCH_GET',
  args: { ranges: ['A1:C5'] },
};

test('a cartridge ships a workspace onto the real shelf, and uninstall takes it back off', async () => {
  const slug = 'acme-pipeline-install';
  const dir = buildFixture({
    title: 'Acme Pipeline',
    view: 'view/index.html',
    dataSources: [READ_ONLY_SOURCE],
  }, { slug });

  const preview = previewPlugin(dir);
  assert.deepEqual(preview.contents.workspaces, [slug], 'the slot is discovered');
  assert.ok(
    preview.consent.some((line) => line.includes(slug)),
    `the workspace appears in the consent contract: ${JSON.stringify(preview.consent)}`,
  );

  const installed = await installPlugin(dir);
  const record = spaceStore.get(slug);
  assert.ok(record, 'the workspace materialized onto the same shelf a hand-built one lives on');
  assert.equal(record?.title, 'Acme Pipeline');
  assert.equal(record?.viewEntry, 'view/index.html');
  assert.equal(record?.dataSources?.length, 1);
  assert.ok(existsSync(path.join(resolveSpaceDir(slug), 'view', 'index.html')), 'the view bytes landed');
  assert.ok(
    installed.artifacts.some((a) => a.kind === 'workspace' && a.name === slug),
    'the workspace is tracked as an artifact so removal is exact',
  );

  uninstallPlugin(installed.manifest.id);
  assert.equal(spaceStore.get(slug), undefined, 'uninstall removes what install created');
});

test('a cartridge may not ship an opaque runner data source', () => {
  const dir = buildFixture({
    title: 'Runner Pipeline',
    view: 'view/index.html',
    dataSources: [{ id: 'pipeline', runner: 'refresh.js' }],
  });
  assert.throws(
    () => previewPlugin(dir),
    /runner/i,
    'arbitrary code that refreshes on a schedule cannot arrive by download',
  );
});

test('a cartridge may not ship a mutating or unknown Composio source', () => {
  for (const slug of ['GMAIL_SEND_EMAIL', 'ACME_TOTALLY_UNKNOWN_ACTION']) {
    const dir = buildFixture({
      title: 'Sending Pipeline',
      view: 'view/index.html',
      dataSources: [{ id: 'pipeline', composioSlug: slug }],
    });
    assert.throws(
      () => previewPlugin(dir),
      /pipeline/,
      `a refresh runs with nobody at the boundary, so "${slug}" must be refused`,
    );
  }
});

test('a cartridge may not ship executable actions', () => {
  const dir = buildFixture({
    title: 'Action Pipeline',
    view: 'view/index.html',
    dataSources: [READ_ONLY_SOURCE],
    actions: [{ id: 'send', runner: 'send.js' }],
  });
  assert.throws(() => previewPlugin(dir), /action/i);
});

test('a shipped view may not escape its workspace directory', () => {
  const dir = buildFixture({
    title: 'Escaping Pipeline',
    view: '../../../../etc/passwd',
    dataSources: [READ_ONLY_SOURCE],
  });
  assert.throws(() => previewPlugin(dir), /escape/i);
});

test('a shipped workspace with a missing view file is rejected at the slot', () => {
  const dir = buildFixture({
    title: 'Viewless Pipeline',
    view: 'view/index.html',
    dataSources: [READ_ONLY_SOURCE],
  }, { writeView: false });
  assert.throws(() => previewPlugin(dir), /view file/i);
});

test('a cartridge cannot clobber a hand-built workspace of the same slug', async () => {
  const slug = 'acme-pipeline-collision';
  spaceStore.save({ id: slug, title: 'Mine, built by hand' });
  const dir = buildFixture({
    title: 'Theirs, downloaded',
    view: 'view/index.html',
    dataSources: [READ_ONLY_SOURCE],
  }, { slug });
  await assert.rejects(() => installPlugin(dir), /already exists/i);
  assert.equal(
    spaceStore.get(slug)?.title,
    'Mine, built by hand',
    'the hand-built workspace survives the refused install untouched',
  );
});
