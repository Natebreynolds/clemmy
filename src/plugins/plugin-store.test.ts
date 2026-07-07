/**
 * Run: npx tsx --test src/plugins/plugin-store.test.ts
 *
 * The cartridge slot, end to end: build a plugin source dir → preview (consent)
 * → install (materializes onto the real shelves) → disable (eject, keep save)
 * → enable → uninstall (clean removal). CLEMENTINE_HOME is redirected to a temp
 * dir BEFORE imports so nothing touches the real home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plugin-'));

const { validateManifest, renderConsentSummary } = await import('./plugin-manifest.js');
const { previewPlugin, installPlugin, listPlugins, setPluginEnabled, uninstallPlugin } = await import('./plugin-store.js');
const { loadSkill } = await import('../memory/skill-store.js');
const { readWorkflow } = await import('../memory/workflow-store.js');
const { loadUserMcpServers } = await import('../runtime/mcp-config.js');

function buildFixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemplug-src-'));
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: 'acme.sales-pack',
    name: 'Acme Sales Pack',
    version: '1.0.0',
    description: 'Outbound helpers',
    publisher: { name: 'Acme' },
    requires: { connections: ['salesforce'] },
    permissions: { tools: ['composio:SALESFORCE_*'], externalWrites: 'approval', schedules: true, config: ['plugin.acme.sales-pack.region'] },
  }));
  mkdirSync(path.join(dir, 'skills', 'acme-outbound'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', 'acme-outbound', 'SKILL.md'), [
    '---', 'name: acme-outbound', 'description: Outbound email style', '---', '', 'Keep emails under 90 words.',
  ].join('\n'));
  // Workflows ship in the store's own Agent-Skills layout: <name>/SKILL.md.
  mkdirSync(path.join(dir, 'workflows', 'acme-daily-prep'), { recursive: true });
  writeFileSync(path.join(dir, 'workflows', 'acme-daily-prep', 'SKILL.md'), [
    '---',
    'name: acme-daily-prep',
    'description: Prep the daily prospect list',
    'enabled: true',
    'trigger:',
    '  manual: true',
    'steps:',
    '  - id: prep',
    '---',
    '',
    '## step: prep',
    '',
    'Assemble the daily prospect list from Salesforce (read-only).',
  ].join('\n'));
  mkdirSync(path.join(dir, 'mcp'), { recursive: true });
  writeFileSync(path.join(dir, 'mcp', 'servers.json'), JSON.stringify({
    'acme-data': { type: 'stdio', command: 'npx', args: ['acme-mcp'], description: 'Acme data', enabled: true },
  }));
  return dir;
}

test('validateManifest: blocks bad ids/versions/out-of-sandbox config/non-free entitlement', () => {
  assert.equal(validateManifest({ id: 'nodots', name: 'X', version: '1.0.0' }).manifest, null);
  assert.equal(validateManifest({ id: 'a.b', name: 'X', version: 'latest' }).manifest, null);
  assert.equal(validateManifest({ id: 'a.b', name: 'X', version: '1.0.0', permissions: { config: ['CLEMMY_KILL_SWITCH'] } }).manifest, null, 'config outside plugin.<id>.* is refused');
  assert.equal(validateManifest({ id: 'a.b', name: 'X', version: '1.0.0', entitlement: 'licensed:pro' }).manifest, null, 'non-free entitlement blocked in v1');
  const ok = validateManifest({ id: 'a.b', name: 'X', version: '1.0.0', permissions: { config: ['plugin.a.b.key'] } });
  assert.ok(ok.manifest);
});

test('cartridge lifecycle: preview → install → shelves populated → disable ejects → enable restores → uninstall cleans', () => {
  const src = buildFixture();

  // Preview = the consent contract, nothing materialized yet.
  const preview = previewPlugin(src);
  assert.equal(preview.manifest.id, 'acme.sales-pack');
  assert.deepEqual(preview.contents, { skills: ['acme-outbound'], workflows: ['acme-daily-prep'], mcpServers: ['acme-data'] });
  const consent = renderConsentSummary(preview.manifest, preview.contents).join('\n');
  assert.match(consent, /1 skill.*acme-outbound/s);
  assert.match(consent, /1 workflow.*acme-daily-prep/s);
  assert.match(consent, /Needs connections: salesforce/);
  assert.equal(loadSkill('acme-outbound'), null, 'preview must not install');

  // Install → everything lands on the EXISTING shelves.
  const installed = installPlugin(src);
  assert.equal(installed.artifacts.length, 3);
  assert.ok(loadSkill('acme-outbound'), 'skill on the shelf');
  assert.ok(readWorkflow('acme-daily-prep'), 'workflow on the shelf');
  assert.ok(loadUserMcpServers()['acme-data'], 'mcp server merged');
  assert.equal(listPlugins().length, 1);

  // Double-install refuses.
  assert.throws(() => installPlugin(src), /already installed/);

  // Disable = eject without deleting the save.
  setPluginEnabled('acme.sales-pack', false);
  assert.equal(loadSkill('acme-outbound'), null, 'skill stashed while disabled');
  assert.equal(readWorkflow('acme-daily-prep')?.data.enabled, false, 'workflow disabled');
  assert.equal(loadUserMcpServers()['acme-data']?.enabled, false, 'server disabled');

  // Enable = slot the cartridge back in.
  setPluginEnabled('acme.sales-pack', true);
  assert.ok(loadSkill('acme-outbound'), 'skill restored');
  assert.notEqual(readWorkflow('acme-daily-prep')?.data.enabled, false, 'workflow re-enabled');

  // Uninstall = remove exactly what it brought.
  const { removed } = uninstallPlugin('acme.sales-pack');
  assert.equal(removed.length, 3);
  assert.equal(loadSkill('acme-outbound'), null);
  assert.equal(readWorkflow('acme-daily-prep'), null);
  assert.equal(loadUserMcpServers()['acme-data'], undefined);
  assert.equal(listPlugins().length, 0);
});

test('collision safety: an existing hand-built workflow blocks install and rolls back cleanly', async () => {
  const src = buildFixture();
  // Same content under a DIFFERENT plugin id, colliding with a pre-existing workflow.
  writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ id: 'other.pack', name: 'Other', version: '1.0.0' }));
  const { readWorkflowDefinitionFile, writeWorkflow } = await import('../memory/workflow-store.js');
  // Pre-existing USER workflow in the store's own format (parsed the same way
  // the installer parses cartridge workflows, then written via the store).
  const userWfDir = path.join(src, 'user-built');
  mkdirSync(userWfDir, { recursive: true });
  writeFileSync(path.join(userWfDir, 'SKILL.md'), [
    '---', 'name: acme-daily-prep', 'description: user-built', 'enabled: true', 'steps:', '  - id: s', '---', '', '## step: s', '', 'mine',
  ].join('\n'));
  const userDef = readWorkflowDefinitionFile(path.join(userWfDir, 'SKILL.md'));
  assert.ok(userDef && userDef.steps.length === 1);
  writeWorkflow('acme-daily-prep', userDef!);
  assert.throws(() => installPlugin(src), /already exists/);
  assert.equal(loadSkill('acme-outbound'), null, 'rolled-back skill did not survive');
  const survived = readWorkflow('acme-daily-prep');
  assert.ok(survived, 'the user workflow still exists');
  assert.match(String(survived!.data.steps?.[0]?.prompt ?? ''), /mine/, 'the user workflow was NOT clobbered');
  assert.equal(listPlugins().length, 0, 'nothing recorded in the ledger');
});
