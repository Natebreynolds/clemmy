/** Run: node scripts/run-tests-isolated.mjs src/plugins/plugin-export.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plugin-export-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { SKILLS_DIR } = await import('../memory/skill-store.js');
const { saveUserMcpServers } = await import('../runtime/mcp-config.js');
const { spaceStore, resolveSpaceDir } = await import('../spaces/store.js');
const exporter = await import('./plugin-export.js');

test('a cartridge carries definitions, blanks secrets, and leaves the owner\'s data and history behind', () => {
  writeWorkflow('Daily brief', { name: 'Daily brief', description: 'Morning brief', steps: [{ id: 'read', type: 'model', prompt: 'Summarize' }], trigger: { schedule: '0 8 * * *' }, enabled: true } as never);
  mkdirSync(path.join(WORKFLOWS_DIR, 'Daily brief', 'runs'), { recursive: true });
  writeFileSync(path.join(WORKFLOWS_DIR, 'Daily brief', 'runs', 'run-1.json'), '{"private":true}');
  mkdirSync(path.join(SKILLS_DIR, 'brief-style'), { recursive: true });
  writeFileSync(path.join(SKILLS_DIR, 'brief-style', 'SKILL.md'), '# Brief style\n');
  saveUserMcpServers({ 'crm-tools': { name: 'crm-tools', type: 'stdio', command: 'npx', args: ['crm-mcp'], env: { CRM_API_KEY: 'sk-live-secret' }, description: 'CRM', enabled: true, source: 'user' } });
  spaceStore.save({ id: 'deal-board', title: 'Deal board', view_html: '<html><body>board</body></html>', dataSources: [{ id: 'deals', composioSlug: 'SALESFORCE_QUERY', schedule: '0 9 * * *' }] } as never);
  writeFileSync(path.join(resolveSpaceDir('deal-board'), 'data.json'), '{"deals":[{"amount":1}]}');
  writeFileSync(path.join(resolveSpaceDir('deal-board'), 'notes.jsonl'), '{"note":"private"}\n');

  const staged = exporter.stageCartridge({ id: 'acme.sales-pack', name: 'Sales pack', workflows: ['Daily brief'], skills: ['brief-style'], mcpServers: ['crm-tools'], workspaces: ['deal-board'] });
  const at = (...parts: string[]) => path.join(staged.dir, ...parts);
  assert.deepEqual(JSON.parse(readFileSync(at('plugin.json'), 'utf8')).id, 'acme.sales-pack');
  assert.equal(existsSync(at('workflows', 'Daily brief', 'SKILL.md')), true);
  assert.equal(existsSync(at('workflows', 'Daily brief', 'runs')), false, 'run history stays home');
  assert.equal(existsSync(at('skills', 'brief-style', 'SKILL.md')), true);
  const servers = JSON.parse(readFileSync(at('mcp', 'servers.json'), 'utf8'));
  assert.deepEqual(servers['crm-tools'].env, { CRM_API_KEY: '' }, 'key names travel, values do not');
  assert.equal(readFileSync(at('mcp', 'servers.json'), 'utf8').includes('sk-live-secret'), false);
  const workspace = JSON.parse(readFileSync(at('workspaces', 'deal-board', 'workspace.json'), 'utf8'));
  assert.equal(workspace.title, 'Deal board');
  assert.deepEqual(workspace.dataSources, [{ id: 'deals', composioSlug: 'SALESFORCE_QUERY', schedule: '0 9 * * *' }]);
  assert.equal(existsSync(at('workspaces', 'deal-board', 'data.json')), false, 'the dataset stays home');
  assert.equal(existsSync(at('workspaces', 'deal-board', 'notes.jsonl')), false);
  assert.equal(existsSync(at('workspaces', 'deal-board', 'space.json')), false, 'the store record is replaced by the shipped manifest');
  assert.ok(staged.leftOut.some((line) => /secrets/.test(line)) && staged.leftOut.some((line) => /Space data/.test(line)));

  const result = exporter.exportPlugin({ id: 'acme.sales-pack', name: 'Sales pack', workflows: ['Daily brief'] });
  assert.equal(result.fileName, 'acme.sales-pack-1.0.0.clemplug');
  assert.ok(result.bytes > 0);
  assert.equal(exporter.exportedCartridgePath('acme.sales-pack-1.0.0.clemplug'), result.file);
  assert.equal(exporter.exportedCartridgePath('../etc/passwd.clemplug'), null);
  assert.throws(() => exporter.stageCartridge({ id: 'acme.empty', name: 'Empty' }), /pick at least one/);
  assert.throws(() => exporter.stageCartridge({ id: 'bad id', name: 'x', workflows: ['Daily brief'] }), /invalid plugin id/);
});
