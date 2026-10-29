/** Run: node scripts/run-tests-isolated.mjs src/plugins/plugin-export.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plugin-export-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { SKILLS_DIR } = await import('../memory/skill-store.js');
const { loadUserMcpServers, saveUserMcpServers } = await import('../runtime/mcp-config.js');
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

type ExportServer = Parameters<typeof saveUserMcpServers>[0][string];
const privateLaunchFixtures: Array<{ name: string; secret: string; server: ExportServer }> = [
  {
    name: 'controlled-export-url-userinfo',
    secret: 'synthetic-export-userinfo-private',
    server: { type: 'http', url: 'https://fixture-user:synthetic-export-userinfo-private@export-fixture.invalid/mcp' },
  },
  {
    name: 'controlled-export-url-query',
    secret: 'synthetic-export-query-private',
    server: { type: 'http', url: 'https://export-fixture.invalid/mcp?api_key=synthetic-export-query-private' },
  },
  {
    name: 'controlled-export-argv-separated',
    secret: 'synthetic-export-separated-private',
    server: { type: 'stdio', command: 'controlled-export-mcp', args: ['--api-key', 'synthetic-export-separated-private'] },
  },
  {
    name: 'controlled-export-argv-assignment',
    secret: 'synthetic-export-assignment-private',
    server: { type: 'stdio', command: 'controlled-export-mcp', args: ['--token=synthetic-export-assignment-private'] },
  },
  {
    name: 'controlled-export-argv-mixed-template',
    secret: 'synthetic-export-prefix-private',
    server: { type: 'stdio', command: 'controlled-export-mcp', args: ['--api-key=synthetic-export-prefix-private${CONTROLLED_EXPORT_KEY}'], env: { CONTROLLED_EXPORT_KEY: '' } },
  },
  {
    name: 'controlled-export-command-repeats-env',
    secret: 'synthetic-export-command-private',
    server: { type: 'stdio', command: 'synthetic-export-command-private', env: { CONTROLLED_EXPORT_KEY: 'synthetic-export-command-private' } },
  },
  {
    name: 'controlled-export-header-repeats-env',
    secret: 'synthetic-export-header-private',
    server: { type: 'http', url: 'https://export-fixture.invalid/mcp', headers: { Authorization: 'Bearer synthetic-export-header-private' }, env: { CONTROLLED_EXPORT_KEY: 'synthetic-export-header-private' } },
  },
  {
    name: 'controlled-export-literal-auth-header',
    secret: 'synthetic-export-authorization-private',
    server: { type: 'http', url: 'https://export-fixture.invalid/mcp', headers: { Authorization: 'Bearer synthetic-export-authorization-private' } },
  },
  {
    name: 'controlled-export-private-protocol-header',
    secret: 'synthetic-export-protocol-private',
    server: { type: 'http', url: 'https://export-fixture.invalid/mcp', headers: { Accept: 'synthetic-export-protocol-private' } },
  },
];

for (const fixture of privateLaunchFixtures) {
  test(`a cartridge refuses private MCP launch values: ${fixture.name}`, () => {
    const definition: ExportServer = { name: fixture.name, enabled: true, source: 'user', ...fixture.server };
    saveUserMcpServers({ [fixture.name]: definition }, { deferIndex: true });
    let staged: ReturnType<typeof exporter.stageCartridge> | undefined;
    try {
      // Refuse this definition intact: silently removing a URL component or
      // argument could change the server, account or operation being shared.
      assert.throws(() => {
        staged = exporter.stageCartridge({ id: 'controlled.private-launch', name: 'Controlled private launch', mcpServers: [fixture.name] });
      }, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /private|credential|secret|environment reference/i);
        assert.equal(error.message.includes(fixture.secret), false, 'the refusal must not repeat the private value');
        return true;
      });
      assert.deepEqual(loadUserMcpServers(), { [fixture.name]: definition }, 'sharing must not repair or change the saved definition');
    } finally {
      // A red implementation returns a staged cartridge; retain no copy of
      // even these synthetic private values after checking that refusal.
      if (staged) rmSync(staged.dir, { recursive: true, force: true });
    }
  });
}

test('a cartridge preserves public MCP endpoints and complete environment references without copying their values', () => {
  const publicName = 'controlled-export-public-endpoint';
  const stdioName = 'controlled-export-env-arguments';
  const publicUrl = 'https://export-fixture.invalid/mcp';
  const args = ['--api-key', '${CONTROLLED_EXPORT_KEY}', '--token=${CONTROLLED_EXPORT_TOKEN}', '--mode', 'read'];
  const privateKey = 'synthetic-export-key-stays-home';
  const privateToken = 'synthetic-export-token-stays-home';
  const headers = { Authorization: 'Bearer ${CONTROLLED_EXPORT_KEY}', 'X-Api-Key': '${CONTROLLED_EXPORT_HEADER}',
    Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-03-26' };
  saveUserMcpServers({
    [publicName]: { name: publicName, type: 'http', url: publicUrl, headers,
      env: { CONTROLLED_EXPORT_KEY: privateKey }, enabled: true, source: 'user' },
    [stdioName]: { name: stdioName, type: 'stdio', command: 'controlled-export-mcp', args,
      env: { CONTROLLED_EXPORT_KEY: privateKey, CONTROLLED_EXPORT_TOKEN: privateToken }, enabled: true, source: 'user' },
  }, { deferIndex: true });
  const sourceDefinitions = loadUserMcpServers();
  const staged = exporter.stageCartridge({ id: 'controlled.public-launch', name: 'Controlled public launch', mcpServers: [publicName, stdioName] });
  try {
    const text = readFileSync(path.join(staged.dir, 'mcp', 'servers.json'), 'utf8');
    const servers = JSON.parse(text);
    assert.equal(servers[publicName].url, publicUrl, 'a public endpoint travels unchanged');
    assert.deepEqual(servers[publicName].headers, headers, 'public metadata and whole credential references keep their exact header values');
    assert.deepEqual(servers[publicName].env, { CONTROLLED_EXPORT_KEY: '', CONTROLLED_EXPORT_HEADER: '' }, 'header references declare each key once, including previously undeclared keys');
    assert.equal(servers[stdioName].command, 'controlled-export-mcp');
    assert.deepEqual(servers[stdioName].args, args, 'whole environment references keep the original invocation');
    assert.deepEqual(servers[stdioName].env, { CONTROLLED_EXPORT_KEY: '', CONTROLLED_EXPORT_TOKEN: '' });
    assert.equal(text.includes(privateKey), false);
    assert.equal(text.includes(privateToken), false);
    assert.deepEqual(loadUserMcpServers(), sourceDefinitions, 'sharing never changes the saved connection or credentials');
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});
