/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/project-run-tools.test.ts
 *
 * Production-surface containment for project_run. New starts must fail before
 * the legacy guest job registry or child-process edge, while control of rows
 * created before the cutover remains available.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-project-run-tool-'));
const WORKSPACE = mkdtempSync(path.join(os.tmpdir(), 'clemmy-project-run-workspace-'));
const PROJECT = path.join(WORKSPACE, 'fixture-project');
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
mkdirSync(PROJECT, { recursive: true });
writeFileSync(path.join(PROJECT, 'package.json'), '{"name":"fixture-project"}');

type ToolResult = {
  content: Array<{ text?: string }>;
  isError?: boolean;
};
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
const handlers = new Map<string, Handler>();
const fakeServer = {
  tool(name: string, _description: string, _schema: unknown, handler: Handler) {
    handlers.set(name, handler);
  },
} as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;

const { registerProjectRunTools } = await import('./project-run-tools.js');
const {
  setGuestHarnessBinaryResolverForTest,
  setGuestHarnessSpawnForTest,
} = await import('../execution/guest-harness.js');
const {
  getGuestRun,
  listGuestRuns,
  startGuestRun,
} = await import('../execution/guest-run-jobs.js');
const { clearWorkspaceProjectCache, updateEnvKey } = await import('./shared.js');

updateEnvKey('WORKSPACE_DIRS', WORKSPACE);
clearWorkspaceProjectCache();
setGuestHarnessBinaryResolverForTest(() => process.execPath);
registerProjectRunTools(fakeServer);

async function call(args: Record<string, unknown>): Promise<ToolResult> {
  const handler = handlers.get('project_run');
  assert.ok(handler, 'project_run is registered');
  return handler(args);
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}

function persistedJobRowCount(): number {
  const file = path.join(TEST_HOME, 'state', 'guest-runs.json');
  if (!existsSync(file)) return 0;
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return Array.isArray(value) ? value.length : 0;
}

function fakeChild(): { child: any; finish: (code: number) => void; killed: string[] } {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const killed: string[] = [];
  child.kill = (signal: string) => { killed.push(signal); };
  return { child, finish: (code: number) => child.emit('close', code), killed };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test.after(() => {
  setGuestHarnessSpawnForTest(null);
  setGuestHarnessBinaryResolverForTest(null);
  updateEnvKey('WORKSPACE_DIRS', '');
  clearWorkspaceProjectCache();
  rmSync(WORKSPACE, { recursive: true, force: true });
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('production project_run start is typed unavailable with zero spawn and zero job rows', async () => {
  let spawnCount = 0;
  setGuestHarnessSpawnForTest((() => {
    spawnCount += 1;
    throw new Error('project_run start reached the raw guest spawn edge');
  }) as any);

  assert.equal(listGuestRuns().length, 0);
  assert.equal(persistedJobRowCount(), 0);
  const result = await call({
    action: 'start',
    project: 'fixture-project',
    prompt: '/seo-audit https://example.test',
    harness: 'claude',
  });

  assert.equal(result.isError, true, 'unavailable is a failed MCP result, never successful prose');
  assert.deepEqual(JSON.parse(text(result)), {
    ok: false,
    status: 'unavailable',
    code: 'durable_delegated_execution_root_required',
    processStarted: false,
    runRecordCreated: false,
    reason: 'project_run start cannot launch an unowned guest process. A durable delegated-execution root must own the child process, physical effects, and terminal receipt before new starts can be enabled. Historical status, runs, and kill actions remain available.',
  });
  assert.equal(spawnCount, 0, 'no Claude/Codex child starts');
  assert.equal(listGuestRuns().length, 0, 'no in-memory guest job is minted');
  assert.equal(persistedJobRowCount(), 0, 'no durable guest job row is minted');
});

test('status, runs, and kill remain available for historical guest-job rows', async () => {
  const completedChild = fakeChild();
  setGuestHarnessSpawnForTest((() => completedChild.child) as any);
  const completed = startGuestRun({
    harness: 'claude',
    project: 'fixture-project',
    prompt: 'historical completed run',
  });
  completedChild.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Historical result remains readable.',
  })}\n`));
  completedChild.finish(0);
  await settle();
  assert.equal(getGuestRun(completed.id)?.status, 'succeeded');

  const status = await call({ action: 'status', runId: completed.id });
  assert.equal(status.isError, undefined);
  assert.match(text(status), new RegExp(`${completed.id}: succeeded`));
  assert.match(text(status), /Historical result remains readable/);

  const runs = await call({ action: 'runs' });
  assert.equal(runs.isError, undefined);
  assert.match(text(runs), new RegExp(completed.id));
  assert.match(text(runs), /historical completed run/);

  const runningChild = fakeChild();
  setGuestHarnessSpawnForTest((() => runningChild.child) as any);
  const running = startGuestRun({
    harness: 'codex',
    project: 'fixture-project',
    prompt: 'historical in-flight run',
  });
  const killed = await call({ action: 'kill', runId: running.id });
  assert.equal(killed.isError, undefined);
  assert.match(text(killed), /stop requested/);
  assert.deepEqual(runningChild.killed, ['SIGTERM'], 'kill still reaches the already-owned historical child');

  runningChild.finish(143);
  await settle();
  const killedStatus = await call({ action: 'status', runId: running.id });
  assert.match(text(killedStatus), new RegExp(`${running.id}: killed`));
});
