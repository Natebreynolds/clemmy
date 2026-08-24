/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/session-composition.test.ts
 *
 * Session identity mounts tools and primers. The loop does not learn a job.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-session-compose-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-session-compose\n', 'utf8');

const { spaceStore } = await import('../../spaces/store.js');
const { HarnessSession } = await import('./session.js');
const { resetEventLog } = await import('./eventlog.js');
const {
  applySessionMountPrimers,
  composeSession,
  composeSessionFromStore,
  durableSessionKind,
  pinCompositionHotTools,
  pinCompositionTools,
  renderSessionMountPrimers,
  WORKSPACE_CONTEXT_PRIMER_PREFIX,
} = await import('./session-composition.js');
const { WORKSPACE_DOCK_HOT_TOOLS, WORKSPACE_DOCK_TOOLS } = await import('../../spaces/workspace-context.js');

resetEventLog();

test('composition source is identity-only: no prompt, no dispatch, no job type', () => {
  const src = readFileSync(fileURLToPath(new URL('./session-composition.ts', import.meta.url)), 'utf8');
  const imports = [...src.matchAll(/^import[\s\S]*?from [^;]+;/gm)].map((match) => match[0]).join('\n');
  assert.doesNotMatch(imports, /typed-source-dispatch|accepted-goal|capabilityRole/);
  assert.doesNotMatch(src, /\buserInput\b|\buserMessage\b|\bacceptedText\b/);
});

test('chat mounts memory inject and no dock pin', () => {
  const mount = composeSession({ sessionId: 'sess-abc' });
  assert.equal(mount.kind, 'chat');
  assert.equal(mount.sessionKind, 'chat');
  assert.equal(mount.workspaceSlug, null);
  assert.equal(mount.workflow, null);
  assert.deepEqual(mount.memory, { inject: true, grantsReachability: false });
  assert.deepEqual(mount.primers, []);
  assert.deepEqual(mount.pinnedTools, []);
  assert.deepEqual(mount.hotTools, []);
  assert.equal(mount.toolAllowlist, null);
});

test('workspace identity mounts the live profile, not a job type', () => {
  spaceStore.save({
    id: 'ops-board',
    title: 'Ops Board',
    contract: {
      objective: 'Keep the live board current.',
      successCriteria: ['The view matches the connected records.'],
      invariants: ['Do not invent rows.'],
    },
    actions: [],
    dataSources: [{ id: 'records', runner: 'r.mjs' }],
  });
  const mount = composeSession({ sessionId: 'space-ops-board' });
  assert.equal(mount.kind, 'workspace');
  assert.equal(mount.sessionKind, 'chat');
  assert.equal(mount.workspaceSlug, 'ops-board');
  assert.equal(mount.workflow, null);
  assert.deepEqual(mount.memory, { inject: true, grantsReachability: false });
  assert.deepEqual([...mount.pinnedTools], [...WORKSPACE_DOCK_TOOLS]);
  assert.deepEqual([...mount.hotTools], [...WORKSPACE_DOCK_HOT_TOOLS]);
  assert.equal(mount.primers.length, 1);
  assert.equal(mount.primers[0]?.prefix, WORKSPACE_CONTEXT_PRIMER_PREFIX);
  assert.match(mount.primers[0]?.text ?? '', /Ops Board/);
  assert.match(mount.primers[0]?.text ?? '', /Keep the live board current/);
  assert.match(renderSessionMountPrimers(mount), /space_edit_view\('ops-board'/);
  assert.equal(durableSessionKind(mount), 'chat');
});

test('a space session with no saved workspace still pins dock tools', () => {
  const mount = composeSession({ sessionId: 'space-missing-surface' });
  assert.equal(mount.kind, 'workspace');
  assert.equal(mount.workspaceSlug, 'missing-surface');
  assert.deepEqual(mount.primers, []);
  assert.ok(mount.pinnedTools.includes('space_get'));
});

test('workflow identity records the saved bundle without dock pins', () => {
  const mount = composeSession({
    sessionId: 'workflow:run-abc:prepare',
    sessionKind: 'workflow',
    metadata: {
      workflowName: 'nightly-sync',
      workflowRunId: 'run-abc',
      stepId: 'prepare',
    },
    toolAllowlist: ['read_file', 'write_file'],
  });
  assert.equal(mount.kind, 'workflow');
  assert.equal(mount.sessionKind, 'workflow');
  assert.equal(mount.workspaceSlug, null);
  assert.deepEqual(mount.workflow, {
    name: 'nightly-sync',
    runId: 'run-abc',
    stepId: 'prepare',
  });
  assert.deepEqual(mount.memory, { inject: true, grantsReachability: false });
  assert.deepEqual(mount.pinnedTools, []);
  assert.deepEqual(mount.hotTools, []);
  assert.deepEqual(mount.toolAllowlist, ['read_file', 'write_file']);
  assert.equal(durableSessionKind(mount), 'workflow');
});

test('workflow: prefix is enough to identify a saved-bundle session', () => {
  const mount = composeSession({ sessionId: 'workflow:run-xyz:step-one' });
  assert.equal(mount.kind, 'workflow');
  assert.equal(mount.sessionKind, 'workflow');
  assert.equal(mount.workflow?.runId, 'run-xyz');
  assert.equal(mount.workflow?.stepId, 'step-one');
});

test('execution and agent kinds stay on the same kernel with no extra pins', () => {
  const execution = composeSession({ sessionId: 'sess-bg', sessionKind: 'execution' });
  assert.equal(execution.kind, 'execution');
  assert.equal(execution.sessionKind, 'execution');
  assert.deepEqual(execution.pinnedTools, []);
  const agent = composeSession({ sessionId: 'sess-agent', sessionKind: 'agent' });
  assert.equal(agent.kind, 'agent');
  assert.equal(durableSessionKind(agent), 'agent');
});

test('durableSessionKind maps background surfaces to execution without inventing a job type', () => {
  const chat = composeSession({ sessionId: 'sess-plain' });
  assert.equal(durableSessionKind(chat, { surface: 'home' }), 'chat');
  assert.equal(durableSessionKind(chat, { surface: 'background' }), 'execution');
  assert.equal(durableSessionKind(chat, { surface: 'cron' }), 'execution');
});

test('pins only add names already reachable this turn', () => {
  const mount = composeSession({ sessionId: 'space-ops-board' });
  const exposed = new Set(['read_file']);
  pinCompositionTools(exposed, mount, ['read_file', 'space_get', 'space_save']);
  assert.equal(exposed.has('read_file'), true);
  assert.equal(exposed.has('space_get'), true);
  assert.equal(exposed.has('space_save'), true);
  assert.equal(exposed.has('space_publish'), false);

  const hot = new Set<string>();
  pinCompositionHotTools(hot, mount, ['space_get', 'space_get_view']);
  assert.deepEqual([...hot].sort(), ['space_get', 'space_get_view']);
});

test('memory never becomes a pin or allowlist grant', () => {
  const chat = composeSession({ sessionId: 'sess-memory' });
  assert.equal(chat.memory.grantsReachability, false);
  assert.ok(!chat.pinnedTools.some((name) => /memory|recall/i.test(name)));
  const workflow = composeSession({
    sessionId: 'workflow:run-1:step',
    sessionKind: 'workflow',
    toolAllowlist: ['read_file'],
  });
  assert.equal(workflow.memory.grantsReachability, false);
  assert.ok(!workflow.pinnedTools.includes('memory_recall'));
});

test('composeSessionFromStore reads durable workflow metadata', () => {
  const session = HarnessSession.create({
    id: 'workflow:run-store:send',
    kind: 'workflow',
    metadata: { workflowName: 'outbound', workflowRunId: 'run-store', stepId: 'send' },
  });
  const mount = composeSessionFromStore(session.id, { toolAllowlist: ['send_message'] });
  assert.equal(mount.kind, 'workflow');
  assert.equal(mount.workflow?.name, 'outbound');
  assert.deepEqual(mount.toolAllowlist, ['send_message']);
});

test('applySessionMountPrimers writes the workspace primer onto the Codex snapshot', () => {
  spaceStore.save({
    id: 'ops-board',
    title: 'Ops Board',
    actions: [],
    dataSources: [],
  });
  const session = HarnessSession.create({
    id: 'space-ops-board',
    kind: 'chat',
    metadata: { source: 'workspace', spaceSlug: 'ops-board' },
  });
  const mount = composeSessionFromStore(session.id);
  applySessionMountPrimers(session.id, mount);
  const items = HarnessSession.load(session.id)?.toInputItems() ?? [];
  const primer = items.find((item) => {
    const content = (item as { content?: unknown }).content;
    return typeof content === 'string' && content.startsWith(WORKSPACE_CONTEXT_PRIMER_PREFIX);
  }) as { content?: string } | undefined;
  assert.ok(primer?.content);
  assert.match(primer.content!, /Ops Board/);
  applySessionMountPrimers(session.id, mount);
  const again = HarnessSession.load(session.id)?.toInputItems() ?? [];
  const primers = again.filter((item) => {
    const content = (item as { content?: unknown }).content;
    return typeof content === 'string' && content.startsWith(WORKSPACE_CONTEXT_PRIMER_PREFIX);
  });
  assert.equal(primers.length, 1, 'primer replace is idempotent by prefix');
});
