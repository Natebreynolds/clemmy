/** Actual HTTP controls for current, process-free catalog certification. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-console-certification-view-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(testHome, 'workspace'), { recursive: true });
writeFileSync(path.join(testHome, '.env'), `WORKSPACE_DIRS=${path.join(testHome, 'workspace')}\n`);
const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { SKILLS_DIR } = await import('../memory/skill-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { MCP_SERVERS_FILE } = await import('../config.js');
const { invalidateMcpServerDiscoveryCache, saveUserMcpServers } = await import('../runtime/mcp-config.js');
const {
  provisionReviewedCliReadDescriptor, removeReviewedCliReadDescriptor, reviewedCliReadConfigPath,
} = await import('../runtime/harness/reviewed-cli-read-config.js');
const { resetEventLog } = await import('../runtime/harness/eventlog.js');

test.beforeEach(() => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5';
  process.env.MODEL_ROUTING_MODE = 'off';
  process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
  process.env.CLEMMY_MODEL_ROLES = '';
  process.env.CLEMMY_SAVED_CLIS = '';
  for (const dir of [SKILLS_DIR, WORKFLOWS_DIR, WORKFLOW_RUNS_DIR]) {
    assert.ok(dir.startsWith(testHome + path.sep));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  rmSync(reviewedCliReadConfigPath(), { force: true });
  invalidateMcpServerDiscoveryCache();
});
test.after(() => { resetEventLog(); rmSync(testHome, { recursive: true, force: true }); });

async function boot() {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, { getRuntime: () => ({ listPendingApprovals: () => [] }) } as never,
    { serveLegacyAtRoot: false });
  const server: Server = await new Promise(resolve => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

type WorkflowView = {
  name: string;
  certification: { canRun: boolean; state: string; blockerCount: number; contractAdvisoryCount: number };
  executionPlan?: { toolReadiness: { items: Array<{ kind: string; name: string; status: string; reason: string }> } };
};

async function workflows(url: string): Promise<WorkflowView[]> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return (await response.json() as { workflows: WorkflowView[] }).workflows;
}

function installSkill(name: string) {
  mkdirSync(path.join(SKILLS_DIR, name), { recursive: true });
  writeFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Controlled fixture only.\n---\nRead the controlled fixture.\n`);
}

for (const route of ['/api/console/workflows', '/api/console/workflows/home']) {
  test(`${route} certification follows skill install and deletion without a workflow or run edit`, async () => {
    const slug = route.endsWith('/home') ? 'current-home-skill' : 'current-list-skill';
    const skill = `${slug}-skill`;
    const entry = writeWorkflow(slug, { name: slug, description: 'Controlled capability freshness fixture.', enabled: true,
      trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read the controlled fixture.', sideEffect: 'read', usesSkill: skill }] });
    const definitionBytes = readFileSync(entry.filePath, 'utf8');
    const h = await boot();
    try {
      const get = async () => (await workflows(h.url + route)).find(item => item.name === slug)!;
      const absent = await get();
      assert.equal(absent.certification.canRun, false);
      assert.equal(absent.certification.state, 'blocked');
      assert.equal((await get()).certification.canRun, false, 'the blocked state is warmed before connection changes');
      installSkill(skill);
      assert.equal((await get()).certification.canRun, true, 'newly installed capability clears its own memo blocker');
      rmSync(path.join(SKILLS_DIR, skill), { recursive: true });
      assert.equal((await get()).certification.canRun, false, 'removing the capability cannot leave cached ready status');
      assert.equal(readFileSync(entry.filePath, 'utf8'), definitionBytes);
      assert.deepEqual(fs.readdirSync(WORKFLOW_RUNS_DIR), [], 'catalog inspection queues no execution');
    } finally { await h.close(); }
  });
}

test('catalog exact reviewed CLI descriptor availability refreshes without becoming account authority', async () => {
  const slug = 'current-cli-descriptor';
  const operationId = 'fixture_read_catalog_record';
  const entry = writeWorkflow(slug, { name: slug, description: 'Controlled descriptor freshness fixture.', enabled: true,
    trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read the controlled fixture.', sideEffect: 'read',
      call: { tool: operationId, args: {} } }] });
  const before = readFileSync(entry.filePath, 'utf8');
  const h = await boot();
  try {
    const get = async () => (await workflows(h.url + '/api/console/workflows')).find(item => item.name === slug)!;
    const status = (item: WorkflowView) => item.executionPlan!.toolReadiness.items.find(tool => tool.name === operationId)!.status;
    const absent = await get();
    assert.equal(status(absent), 'missing');
    assert.equal(absent.certification.canRun, true, 'unconfirmed tool availability is advisory, not an invented hard block');
    await provisionReviewedCliReadDescriptor({
      version: 1, descriptorId: 'fixture-catalog-read', operationId, displayName: 'Controlled catalog read',
      description: 'Read a controlled fixture only.', effect: 'read', accountId: 'reviewed_cli:host',
      executablePath: process.execPath, argvPrefix: [], arguments: [],
      limits: { timeoutMs: 1_000, maxStdoutBytes: 1_024, maxStderrBytes: 1_024, maxArgumentBytes: 1_024 },
    });
    const present = await get();
    assert.equal(status(present), 'ready');
    assert.equal(present.certification.canRun, true);
    assert.equal(await removeReviewedCliReadDescriptor('fixture-catalog-read'), true);
    assert.equal(status(await get()), 'missing');
    assert.equal(readFileSync(entry.filePath, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(WORKFLOW_RUNS_DIR), []);
  } finally { await h.close(); }
});

test('catalog routing advisories follow current worker rules without workflow edits or model calls', async () => {
  const slug = 'current-worker-routing';
  const entry = writeWorkflow(slug, { name: slug, description: 'Controlled routing freshness fixture.', enabled: true,
    trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read the controlled fixture.', sideEffect: 'read', intent: 'writing' }] });
  const before = readFileSync(entry.filePath, 'utf8');
  const h = await boot();
  try {
    const get = async () => (await workflows(h.url + '/api/console/workflows')).find(item => item.name === slug)!;
    const initial = await get();
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'worker', modelId: 'claude-sonnet-5', whenIntent: 'design', scope: 'durable', source: 'chat-rule' }]);
    const changed = await get();
    assert.equal(changed.certification.contractAdvisoryCount, initial.certification.contractAdvisoryCount + 1);
    process.env.CLEMMY_MODEL_ROLES = '';
    assert.equal((await get()).certification.contractAdvisoryCount, initial.certification.contractAdvisoryCount);
    assert.equal(readFileSync(entry.filePath, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(WORKFLOW_RUNS_DIR), []);
  } finally { await h.close(); }
});

test('catalog MCP configuration changes refresh advisory availability without connecting a server', async () => {
  const slug = 'current-mcp-readiness';
  const operationId = 'mcp__fixture_catalog__read';
  writeWorkflow(slug, { name: slug, description: 'Controlled MCP configuration fixture.', enabled: true,
    trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read the controlled fixture.', sideEffect: 'read', allowedTools: [operationId] }] });
  saveUserMcpServers({ fixture_catalog: { type: 'stdio', command: process.execPath, enabled: false } }, { deferIndex: true });
  const h = await boot();
  try {
    const get = async () => (await workflows(h.url + '/api/console/workflows')).find(item => item.name === slug)!;
    const item = (view: WorkflowView) => view.executionPlan!.toolReadiness.items.find(tool => tool.name === operationId)!;
    const disabled = await get();
    assert.equal(item(disabled).status, 'missing');
    assert.match(item(disabled).reason, /disabled/);
    assert.equal(disabled.certification.canRun, true, 'MCP availability alone does not grant or refuse runtime execution');
    saveUserMcpServers({ fixture_catalog: { type: 'stdio', command: process.execPath, enabled: true } }, { deferIndex: true });
    const configured = await get();
    assert.equal(item(configured).status, 'unknown', 'a configured server is not proof an exact tool or account is ready');
    assert.equal(configured.certification.canRun, true);
    saveUserMcpServers({}, { deferIndex: true });
    const removed = await get();
    assert.equal(item(removed).status, 'missing');
    assert.match(item(removed).reason, /not configured/);
    assert.deepEqual(fs.readdirSync(WORKFLOW_RUNS_DIR), []);
  } finally { await h.close(); }
});

test('one catalog request captures global skill, CLI descriptor/scan and MCP inputs once for every workflow', async t => {
  installSkill('shared-fixture-skill');
  for (let i = 0; i < 4; i++) writeWorkflow(`shared-view-${i}`, { name: `shared-view-${i}`,
    description: 'Controlled once-per-request inventory fixture.', enabled: true, trigger: { manual: true },
    steps: [{ id: 'read', prompt: 'Read the fixture.', sideEffect: 'read', usesSkill: 'shared-fixture-skill' }] });
  const scanFile = path.join(testHome, 'state', 'cli-scan.json');
  mkdirSync(path.dirname(scanFile), { recursive: true });
  writeFileSync(scanFile, JSON.stringify({ scannedAt: '2026-10-16T01:00:00.000Z', detected: [], clis: [] }));
  saveUserMcpServers({}, { deferIndex: true });
  const h = await boot();
  const reads = t.mock.method(fs, 'readFileSync');
  const listings = t.mock.method(fs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    const counts = () => ({
      skills: listings.mock.calls.filter(call => call.arguments[0] === SKILLS_DIR).length,
      descriptors: reads.mock.calls.filter(call => call.arguments[0] === reviewedCliReadConfigPath()).length,
      scan: reads.mock.calls.filter(call => call.arguments[0] === scanFile).length,
      mcp: reads.mock.calls.filter(call => call.arguments[0] === MCP_SERVERS_FILE).length,
    });
    assert.equal((await workflows(h.url + '/api/console/workflows')).length, 4);
    assert.deepEqual(counts(), { skills: 1, descriptors: 1, scan: 1, mcp: 1 });
    reads.mock.resetCalls(); listings.mock.resetCalls();
    assert.equal((await workflows(h.url + '/api/console/workflows')).length, 4);
    assert.deepEqual(counts(), { skills: 1, descriptors: 1, scan: 1, mcp: 0 }, 'warm memo still observes current local facts once; existing MCP discovery reuses its own unchanged snapshot');
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await h.close();
  }
});

test('a catalog request cannot attach later skill state to an earlier captured readiness result', async t => {
  const slug = 'coherent-skill-capture';
  const skill = 'coherent-skill-fixture';
  const entry = writeWorkflow(slug, { name: slug, description: 'Controlled capture race fixture.', enabled: true,
    trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read the controlled fixture.', sideEffect: 'read', usesSkill: skill }] });
  const scriptsDir = path.join(entry.dir, 'scripts');
  const h = await boot();
  const originalExists = fs.existsSync;
  let installed = false;
  t.mock.method(fs, 'existsSync', (...args) => {
    const exists = Reflect.apply(originalExists, fs, args);
    // The global installed-skill inventory has already been captured when the
    // exact workflow's script directory is inspected. Another process can
    // publish a skill at this boundary without changing the workflow bytes.
    if (!installed && args[0] === scriptsDir) { installed = true; installSkill(skill); }
    return exists;
  });
  syncBuiltinESMExports();
  try {
    const get = async () => (await workflows(h.url + '/api/console/workflows')).find(item => item.name === slug)!;
    assert.equal((await get()).certification.canRun, false, 'first response retains its observed missing capability');
    assert.equal(installed, true);
    assert.equal((await get()).certification.canRun, true, 'later facts cannot hit a memo for the earlier readiness capture');
    assert.equal((await get()).certification.canRun, true);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await h.close();
  }
});
