import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-project-setup-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const records = await import('./project-record.js');
const local = await import('./local-projects.js');
const setup = await import('./project-tool-setup.js');
const contexts = await import('../runtime/harness/source-session-context.js');
const config = await import('../runtime/mcp-config.js');
const { registerProjectToolSetupTools } = await import('../tools/project-tool-setup-tools.js');
const { createSession, appendEvent, closeEventLog } = await import('../runtime/harness/eventlog.js');
const { setSessionProject } = await import('./session-project.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { classifyTool } = await import('../agents/tool-taxonomy.js');
const configFile = path.join(home, 'mcp', 'servers.json');
mkdirSync(path.dirname(configFile), { recursive: true });
writeFileSync(configFile, '{}');
const roster: ReturnType<typeof local.localProjects> = [];
local._setLocalProjectsForTests(() => roster);
let ordinal = 0;
function fixture(raw: unknown, name = `setup-fixture-${++ordinal}`) {
  const candidate = path.join(home, `Project Files ${++ordinal}`);
  mkdirSync(candidate);
  const folder = realpathSync(candidate);
  writeFileSync(path.join(folder, 'server.cjs'), '// synthetic; never executed');
  writeFileSync(path.join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { [name]: raw } }));
  const made = records.createProject({ name: `Setup project ${ordinal}` }); assert.ok(made.ok);
  const saved = records.saveResource(made.project.id, { kind: 'folder', ref: folder, label: `Folder ${ordinal}` }); assert.ok(saved.ok);
  const resource = records.listResources(made.project.id)[0]!;
  roster.push({ name: `Folder ${ordinal}`, path: folder, type: 'node', description: '', git: false });
  return { project: made.project, resource, folder, name, file: path.join(folder, '.mcp.json'), owner: { sessionId: `fixture-owner-${ordinal}`, sourceUserSeq: ordinal, digest: String(ordinal).padStart(64, '0') } };
}
const privateValue = 'synthetic-private-credential-never-project';
const declaration = () => ({ command: process.execPath, args: ['./server.cjs'], env: { R22_PROJECT_MISSING_KEY: privateValue } });
const inspect = (f: ReturnType<typeof fixture>) => setup.inspectProjectTools(f.owner, f.project.id, f.resource.id) as any;
after(() => { local._setLocalProjectsForTests(null); records._closeProjectStoreForTests(); closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('project setup reads a redacted preview, writes only one approved configuration and never copies credential values', async () => {
  const f = fixture(declaration());
  const before = readFileSync(configFile, 'utf8');
  const preview = inspect(f); assert.equal(preview.ok, true);
  assert.equal(readFileSync(configFile, 'utf8'), before, 'inspection is metadata only');
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(privateValue));
  assert.equal(preview.servers[0].state, 'ready_to_set_up');
  const token = preview.servers[0].previewToken;
  const connected = await setup.connectProjectTool(f.owner, f.project.id, f.resource.id, f.name, token);
  assert.equal(connected.saved, true); assert.equal(connected.state, 'needs_credentials', 'no child starts without declared key');
  const saved = JSON.parse(readFileSync(configFile, 'utf8'))[f.name];
  assert.equal(saved.cwd, f.folder); assert.deepEqual(saved.args, [path.join(f.folder, 'server.cjs')]);
  assert.deepEqual(saved.env, { R22_PROJECT_MISSING_KEY: '' });
  assert.doesNotMatch(JSON.stringify(saved) + JSON.stringify(connected), new RegExp(privateValue));
  const settled = readFileSync(configFile, 'utf8');
  assert.equal((await setup.connectProjectTool(f.owner, f.project.id, f.resource.id, f.name, token)).replayedWithoutWrite, true);
  assert.equal(readFileSync(configFile, 'utf8'), settled, 'same exact receipt never repeats a write');
  saved.enabled = false; config.saveUserMcpServers({ ...config.loadUserMcpServers(), [f.name]: saved }, { deferIndex: true });
  assert.equal((await setup.connectProjectTool(f.owner, f.project.id, f.resource.id, f.name, token)).code, 'configuration_changed');
});

test('preview is bound to exact project, resource and unchanged source bytes', async () => {
  const f = fixture(declaration()); const other = fixture(declaration()); const preview = inspect(f).servers[0];
  assert.equal((await setup.connectProjectTool(other.owner, other.project.id, other.resource.id, f.name, preview.previewToken)).code, 'preview_expired');
  writeFileSync(f.file, JSON.stringify({ mcpServers: { [f.name]: { ...declaration(), args: ['different.cjs'] } } }));
  assert.equal((await setup.connectProjectTool(f.owner, f.project.id, f.resource.id, f.name, preview.previewToken)).code, 'configuration_changed');
  assert.equal(config.loadUserMcpServers()[f.name], undefined);
});

test('a fresh collision hidden by cached discovery is preserved instead of overwritten', async () => {
  const f = fixture(declaration()); const preview = inspect(f).servers[0];
  const latest = JSON.stringify({ ...config.loadUserMcpServers(), [f.name.toUpperCase()]: { command: 'must-not-launch', enabled: false } });
  writeFileSync(configFile, latest);
  const result = await setup.connectProjectTool(f.owner, f.project.id, f.resource.id, f.name, preview.previewToken);
  assert.equal(result.code, 'server_already_configured'); assert.equal(readFileSync(configFile, 'utf8'), latest);
  config.invalidateMcpServerDiscoveryCache();
});

test('missing runtime, removed workspace, and configuration symlink escape have concrete next steps without writes', async () => {
  const f = fixture({ command: 'clem-controlled-missing-runtime-22', args: [], env: {} });
  const preview = inspect(f).servers[0]; assert.equal(preview.state, 'missing_runtime');
  assert.equal((await setup.connectProjectTool(f.owner, f.project.id, f.resource.id, f.name, preview.previewToken)).code, 'missing_runtime');
  const row = roster.pop()!; assert.equal(inspect(f).code, 'folder_not_authorized'); roster.push(row);
  const outside = path.join(home, `outside-${ordinal}.json`); writeFileSync(outside, '{}'); rmSync(f.file); symlinkSync(outside, f.file);
  assert.equal(inspect(f).code, 'configuration_outside_project');
  assert.equal(config.loadUserMcpServers()[f.name], undefined);
});

test('credential-bearing headers, arguments, shell wrappers, and escaping files refuse without returning source values', () => {
  for (const raw of [
    { ...declaration(), args: ['--token', privateValue] },
    { ...declaration(), args: [`--token=${privateValue}`] },
    { ...declaration(), args: [`--token=${privateValue}${'${OTHER_KEY}'}`] },
    { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: `Bearer ${privateValue}` } },
    { type: 'http', url: 'https://example.invalid/mcp', headers: { Accept: privateValue } },
    { ...declaration(), args: ['--ordinary-flag', privateValue] },
    { type: 'http', url: `https://example.invalid/mcp?token=${privateValue}` },
    { command: 'cmd', args: ['/c', 'npx', 'server'] },
    { ...declaration(), args: ['../outside.cjs'] },
    { ...declaration(), cwd: '../' },
  ]) {
    const f = fixture(raw); const result = inspect(f);
    assert.equal(result.servers[0].ok, false); assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue));
    assert.equal(config.loadUserMcpServers()[f.name], undefined);
  }
});

test('declared argument and header references remain templates; project-relative files use project working directory', async () => {
  const f = fixture({ command: process.execPath, args: ['./server.cjs', '--token', '${R22_ARGUMENT_TOKEN}'], env: {} });
  const server = inspect(f).servers[0]; assert.deepEqual(server.requiredEnvKeys, ['R22_ARGUMENT_TOKEN']);
  assert.equal((await setup.connectProjectTool(f.owner, f.project.id, f.resource.id, f.name, server.previewToken)).state, 'needs_credentials');
  assert.deepEqual(config.loadUserMcpServers()[f.name].args, [path.join(f.folder, 'server.cjs'), '--token', '${R22_ARGUMENT_TOKEN}']);
  const remote = fixture({ type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${R22_REMOTE_TOKEN}' } });
  assert.deepEqual(inspect(remote).servers[0].requiredEnvKeys, ['R22_REMOTE_TOKEN']);
});

test('Windows project paths resolve drive, UNC and spaces without shell interpretation or inherited cwd', () => {
  assert.equal(setup.resolveProjectMcpPath('C:\\Work\\Project Files', '.\\server.cjs', 'win32'), 'C:\\Work\\Project Files\\server.cjs');
  assert.equal(setup.resolveProjectMcpPath('\\\\host\\share\\Project', '${workspaceFolder}\\server.py', 'win32'), '\\\\host\\share\\Project\\server.py');
  assert.equal(setup.resolveProjectMcpPath('/work/project', '../data.json', 'linux', '/work/project/scripts'), '/work/project/data.json');
  for (const bad of ['C:server.py', '\\server.py', '/Users/owner/server.py', '..\\outside.cjs']) {
    assert.throws(() => setup.resolveProjectMcpPath('C:\\Work\\Project Files', bad, 'win32'));
  }
});

test('registered setup tools require the owner’s selected project and retain normal admin classification', async () => {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  registerProjectToolSetupTools({ tool(name: string, ...args: any[]) { handlers.set(name, args.at(-1)); } } as any);
  const parse = (value: any) => JSON.parse(value.content[0].text);
  assert.equal(classifyTool('project_tools_connect'), 'admin'); assert.equal(classifyTool('project_tools_inspect'), 'read');
  assert.equal(parse(await handlers.get('project_tools_inspect')!({})).code, 'select_project');
  const f = fixture(declaration()); const session = createSession({ id: 'r22-selected-owner', kind: 'chat' });
  assert.equal(setSessionProject(session.id, f.project.id, { by: 'owner' }).ok, true);
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Prepare this controlled project.' } });
  assert.ok(contexts.captureFreshSourceSessionContext({ sessionId: session.id, sourceUserSeq: source.seq }));
  const owner = { sessionId: session.id, sourceUserSeq: source.seq };
  const preview = await withToolOutputContext(owner, () => handlers.get('project_tools_inspect')!({ resource_id: f.resource.id }));
  assert.equal(parse(preview).projectId, f.project.id);
  const foreign = fixture(declaration());
  const refused = await withToolOutputContext(owner, () => handlers.get('project_tools_inspect')!({ resource_id: foreign.resource.id }));
  assert.equal(parse(refused).code, 'choose_project_folder');
  assert.equal(setSessionProject(session.id, foreign.project.id, { by: 'owner' }).ok, true);
  const unchanged = await withToolOutputContext(owner, () => handlers.get('project_tools_inspect')!({ resource_id: f.resource.id }));
  assert.equal(parse(unchanged).projectId, f.project.id, 'running source keeps its original project after UI selection changes');
  const noSource = await withToolOutputContext({ sessionId: session.id }, () => handlers.get('project_tools_inspect')!({}));
  assert.equal(parse(noSource).code, 'select_project', 'today’s selection never supplies missing accepted context');
});

test('an inspected setup token belongs to one exact accepted owner, never another chat, source or composition', async () => {
  const f = fixture(declaration()); const preview = inspect(f).servers[0];
  for (const owner of [
    { ...f.owner, sessionId: 'another-owner-chat' },
    { ...f.owner, sourceUserSeq: f.owner.sourceUserSeq + 1 },
    { ...f.owner, digest: 'f'.repeat(64) },
  ]) {
    assert.equal((await setup.connectProjectTool(owner, f.project.id, f.resource.id, f.name, preview.previewToken)).code, 'preview_expired');
    assert.equal(config.loadUserMcpServers()[f.name], undefined);
  }
});

test('approval rechecks unchanged declarations against retargeted local paths and bounded configuration reads', async () => {
  const f = fixture(declaration());
  const preview = inspect(f).servers[0];
  const outside = path.join(home, 'outside-server.cjs'); writeFileSync(outside, '// outside linked project');
  rmSync(path.join(f.folder, 'server.cjs')); symlinkSync(outside, path.join(f.folder, 'server.cjs'));
  assert.equal((await setup.connectProjectTool(f.owner, f.project.id, f.resource.id, f.name, preview.previewToken)).code, 'path_outside_project');
  assert.equal(config.loadUserMcpServers()[f.name], undefined);
  const large = fixture(declaration()); writeFileSync(large.file, ' '.repeat(256_001));
  assert.equal(inspect(large).code, 'configuration_invalid');
});

test('protocol headers stay public metadata and named credential reuse is never account certification', () => {
  const f = fixture({ type: 'http', url: 'https://example.invalid/mcp', headers: { Accept: 'application/json, text/event-stream', Authorization: 'Bearer ${R22_REMOTE_TOKEN}' } });
  const preview = inspect(f).servers[0];
  assert.equal(preview.state, 'ready_to_set_up'); assert.equal(preview.accountVerified, false);
  assert.match(preview.detail, /Existing named credentials may be reused/);
  assert.deepEqual(preview.requiredEnvKeys, ['R22_REMOTE_TOKEN']);
});

test('a non-regular project declaration is refused without waiting for a pipe writer', { skip: process.platform === 'win32' }, () => {
  const f = fixture(declaration()); rmSync(f.file);
  execFileSync('mkfifo', [f.file]);
  assert.equal(inspect(f).code, 'configuration_invalid');
  assert.equal(config.loadUserMcpServers()[f.name], undefined);
});
