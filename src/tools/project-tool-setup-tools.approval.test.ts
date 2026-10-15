import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-project-approval-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const records = await import('../projects/project-record.js');
const local = await import('../projects/local-projects.js');
const contexts = await import('../runtime/harness/source-session-context.js');
const { registerProjectToolSetupTools } = await import('./project-tool-setup-tools.js');
const events = await import('../runtime/harness/eventlog.js');
const pending = await import('../runtime/harness/pending-actions.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const { pendingActionApprovalView } = await import('../runtime/harness/pending-action-view.js');
const { setSessionProject } = await import('../projects/session-project.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const brackets = await import('../runtime/harness/brackets.js');
const { unwrapRuntimeEffectiveToolIdentity, canonicalRuntimeEffectiveToolName } = await import('../runtime/harness/tool-effect.js');
const configFile = path.join(home, 'mcp', 'servers.json');
mkdirSync(path.dirname(configFile), { recursive: true });
writeFileSync(configFile, '{}');
const roster: ReturnType<typeof local.localProjects> = [];
local._setLocalProjectsForTests(() => roster);
after(() => {
  local._setLocalProjectsForTests(null);
  records._closeProjectStoreForTests();
  events.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});
const handlers = new Map<string, (args: any) => Promise<any>>();
registerProjectToolSetupTools({ tool(name: string, ...args: any[]) { handlers.set(name, args.at(-1)); } } as any);
const parse = (value: any) => JSON.parse(value.content[0].text);
type ConnectArgs = { resource_id: string; server_name: string; preview_token: string };
type Capability = { pendingActionId: string; payloadHash: string; claimToken: string; sourceUserSeq: number };
type Carrier = 'direct' | 'call_tool' | 'work_call';
let ordinal = 0;

function frozenInvocation(carrier: Carrier, args: Record<string, unknown>) {
  if (carrier === 'call_tool') return { toolName: 'call_tool', payload: {
    name: 'mcp__clementine-local__project_tools_connect', args_json: JSON.stringify(args),
  } };
  if (carrier === 'work_call') return { toolName: 'mcp__clementine-local__work_call', payload: {
    name: 'project_tools_connect', args: { ...args },
  } };
  return { toolName: 'project_tools_connect', payload: { ...args } };
}

async function fixture(carrier: Carrier, freeze?: (args: ConnectArgs) => { toolName: string; payload: unknown }) {
  const id = ++ordinal;
  const missingKey = `R22_PROJECT_APPROVAL_MISSING_KEY_${id}`;
  delete process.env[missingKey];
  const candidate = path.join(home, `Project Files With Spaces ${id}`);
  mkdirSync(candidate);
  const folder = realpathSync(candidate);
  const launchedMarker = path.join(folder, 'child-must-not-run.txt');
  writeFileSync(path.join(folder, 'server.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(launchedMarker)}, 'unexpected child'); process.exit(91);`);
  const serverName = `r22-approved-project-${id}`;
  writeFileSync(path.join(folder, '.mcp.json'), JSON.stringify({ mcpServers: {
    [serverName]: { command: process.execPath, args: ['./server.cjs'], cwd: '.', env: { [missingKey]: '' } },
  } }));
  const original = records.createProject({ name: `Approval original project ${id}` });
  assert.ok(original.ok);
  assert.ok(records.saveResource(original.project.id, { kind: 'folder', ref: folder, label: `Controlled folder ${id}` }).ok);
  const resource = records.listResources(original.project.id)[0]!;
  roster.push({ name: `Controlled folder ${id}`, path: folder, type: 'node', description: '', git: false });
  const other = records.createProject({ name: `Approval selection switch ${id}` });
  assert.ok(other.ok);
  const session = events.createSession({ id: `r22-project-approval-${id}`, kind: 'chat' });
  assert.equal(setSessionProject(session.id, original.project.id, { by: 'owner' }).ok, true);
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Prepare this controlled project tool connection.' } });
  assert.ok(contexts.captureFreshSourceSessionContext({ sessionId: session.id, sourceUserSeq: source.seq }));
  const preview = parse(await withToolOutputContext({ sessionId: session.id, sourceUserSeq: source.seq },
    () => handlers.get('project_tools_inspect')!({ resource_id: resource.id })));
  assert.equal(preview.projectId, original.project.id);
  assert.equal(preview.ok, true);
  const args: ConnectArgs = { resource_id: resource.id, server_name: serverName, preview_token: preview.servers[0].previewToken };
  const frozen = freeze ? freeze(args) : frozenInvocation(carrier, args);
  const action = pending.queuePendingAction({ title: 'Prepare controlled project MCP', kind: 'other',
    ...frozen, sessionId: session.id, sourceUserSeq: source.seq });
  const card = approvals.register({ sessionId: session.id, subject: action.title, tool: 'request_approval',
    args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
  assert.equal(approvals.resolve(card.approvalId, 'approved', 'fixture-owner').ok, true);
  assert.equal(setSessionProject(session.id, other.project.id, { by: 'owner' }).ok, true);
  const attempt = events.beginRunAttempt(session.id, { runId: `r22-project-approval-resume-${id}` });
  const control = events.recordRunAttemptUserInput(attempt, { turn: 2, role: 'user', data: {
    text: `Approve ${card.approvalId}.`, displayText: `Approve ${card.approvalId}`,
    synthetic: true, source: 'approval_resume', approvalId: card.approvalId, decision: 'approve',
  } }, { armRunInFlight: true });
  const claim = pending.claimPendingActionExecution(action.id, 'fixture-resume', {
    expectedSessionId: session.id, requireResolvedHumanCard: true,
  });
  assert.equal(claim.claimed, true);
  assert.ok(claim.claimToken);
  const capability: Capability = { pendingActionId: action.id, payloadHash: action.payloadHash,
    claimToken: claim.claimToken!, sourceUserSeq: control.seq };
  assert.equal(pending.verifyPendingActionResumeExecutionCapability({ capability,
    sessionId: session.id, toolName: action.toolName, payload: action.payload }), true);
  assert.equal(pending.getPendingAction(action.id)?.sourceUserSeq, source.seq);
  assert.equal(contexts.readSourceSessionContext({ sessionId: session.id, sourceUserSeq: control.seq }), null);
  const unrelated = events.appendEvent({ sessionId: session.id, turn: 3, role: 'user', type: 'user_input_received',
    data: { text: 'Unrelated controlled source with no project composition.' } });
  const foreign = events.createSession({ id: `r22-project-approval-foreign-${id}`, kind: 'chat' });
  const foreignSource = events.appendEvent({ sessionId: foreign.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Unrelated controlled chat.' } });
  return { args, action, capability, session, source, control, attempt, unrelated, foreign, foreignSource, launchedMarker, folder, missingKey, serverName };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function invoke(f: Fixture, options: {
  args?: Record<string, unknown>; capability?: Capability | null; inspect?: boolean;
  harnessSessionId?: string; outputSessionId?: string; harnessSource?: number; outputSource?: number;
} = {}) {
  return parse(await brackets.withHarnessRunContext({
    sessionId: options.harnessSessionId ?? f.session.id,
    sourceUserSeq: options.harnessSource ?? f.control.seq,
    runAttemptId: f.attempt.attemptId, turn: 2, counter: new brackets.ToolCallsCounter(1),
    ...(options.capability !== null ? { pendingActionExecution: options.capability ?? f.capability } : {}),
  }, () => withToolOutputContext({
    sessionId: options.outputSessionId ?? f.session.id,
    sourceUserSeq: options.outputSource ?? f.control.seq,
  }, () => handlers.get(options.inspect ? 'project_tools_inspect' : 'project_tools_connect')!(
    options.inspect ? { resource_id: f.args.resource_id } : options.args ?? f.args))));
}
function configSnapshot() {
  return { bytes: readFileSync(configFile, 'utf8'), mtime: statSync(configFile, { bigint: true }).mtimeNs };
}
async function refusedWithoutWrite(f: Fixture, options: Parameters<typeof invoke>[1], label: string) {
  const before = configSnapshot();
  const result = await invoke(f, options);
  assert.equal(result.saved, undefined, label);
  assert.equal(result.code, 'select_project', label);
  assert.deepEqual(configSnapshot(), before, `${label}: no write`);
  assert.equal(existsSync(f.launchedMarker), false, `${label}: no child`);
}

for (const carrier of ['direct', 'call_tool', 'work_call'] as const) {
  test(`exact ${carrier} approval retains the inspected project; invalid capabilities cannot borrow it and settled replay does not write`, async () => {
    const f = await fixture(carrier);
    const effective = unwrapRuntimeEffectiveToolIdentity(f.action.toolName, f.action.payload);
    assert.equal(canonicalRuntimeEffectiveToolName(effective.toolName), 'project_tools_connect');
    assert.deepEqual(effective.args, f.args);
    await refusedWithoutWrite(f, { capability: null }, 'missing capability');
    await refusedWithoutWrite(f, { capability: { ...f.capability, claimToken: 'invalid-controlled-claim' } }, 'invalid claim token');
    await refusedWithoutWrite(f, { capability: { ...f.capability, sourceUserSeq: f.unrelated.seq },
      harnessSource: f.unrelated.seq, outputSource: f.unrelated.seq }, 'wrong capability source');
    await refusedWithoutWrite(f, { harnessSource: f.unrelated.seq }, 'wrong harness source');
    await refusedWithoutWrite(f, { outputSource: f.unrelated.seq }, 'wrong tool output source');
    await refusedWithoutWrite(f, { harnessSessionId: f.foreign.id, outputSessionId: f.foreign.id,
      harnessSource: f.foreignSource.seq, outputSource: f.foreignSource.seq }, 'foreign session');
    await refusedWithoutWrite(f, { harnessSessionId: f.foreign.id }, 'mismatched harness session');
    await refusedWithoutWrite(f, { outputSessionId: f.foreign.id }, 'mismatched tool output session');
    for (const key of ['resource_id', 'server_name', 'preview_token'] as const) {
      await refusedWithoutWrite(f, { args: { ...f.args, [key]: f.args[key] + '-tampered' } }, `tampered ${key}`);
    }
    await refusedWithoutWrite(f, { inspect: true }, 'inspect cannot borrow connect capability');
    const before = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(before[f.serverName], undefined);
    const connected = await invoke(f);
    assert.equal(connected.saved, true);
    assert.equal(connected.state, 'needs_credentials', 'the declared missing key must prevent child launch');
    assert.equal(existsSync(f.launchedMarker), false);
    const after = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), f.serverName].sort(), 'one named connection only');
    for (const name of Object.keys(before)) assert.deepEqual(after[name], before[name], 'other connections preserved');
    assert.equal(after[f.serverName].cwd, f.folder);
    assert.deepEqual(after[f.serverName].args, [path.join(f.folder, 'server.cjs')]);
    assert.deepEqual(after[f.serverName].env, { [f.missingKey]: '' });
    // Pin a deliberately old mtime so a repeated identical write is observable
    // even on coarse-resolution filesystems; no sleep or timing race is needed.
    const oldTime = new Date('2001-01-01T00:00:00.000Z');
    utimesSync(configFile, oldTime, oldTime);
    const settled = configSnapshot();
    const replay = await invoke(f);
    assert.equal(replay.saved, true);
    assert.equal(replay.replayedWithoutWrite, true);
    assert.deepEqual(configSnapshot(), settled, 'settled replay leaves bytes and write time unchanged');
    assert.equal(existsSync(f.launchedMarker), false);
  });
}

test('a verified claim for a foreign tool or non-exact connect arguments cannot borrow the original project', async () => {
  for (const [label, freeze] of [
    ['foreign namespace', (args: ConnectArgs) => ({ toolName: 'call_tool', payload: {
      name: 'mcp__foreign-server__project_tools_connect', args_json: JSON.stringify(args),
    } })],
    ['different tool', (args: ConnectArgs) => ({ toolName: 'work_call', payload: {
      name: 'project_tools_inspect', args: { resource_id: args.resource_id },
    } })],
    ['extra frozen argument', (args: ConnectArgs) => frozenInvocation('call_tool', { ...args, unapproved_extra: true })],
  ] as const) {
    const f = await fixture('direct', freeze);
    await refusedWithoutWrite(f, {}, label);
  }
});

test('an ordinary context-free request remains refused after an unrelated project selection', async () => {
  const f = await fixture('direct');
  const before = configSnapshot();
  const result = parse(await withToolOutputContext({ sessionId: f.session.id },
    () => handlers.get('project_tools_connect')!(f.args)));
  assert.equal(result.code, 'select_project');
  assert.deepEqual(configSnapshot(), before);
  assert.equal(existsSync(f.launchedMarker), false);
});
