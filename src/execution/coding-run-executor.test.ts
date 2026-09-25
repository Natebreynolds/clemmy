/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/coding-run-executor.test.ts
 *
 * End to end over real git and the real harness event log, with a scripted
 * agent in place of the CLI: Clem briefs the agent, reviews every turn from
 * git and her own test run, sends it back with what is missing, settles
 * honestly, reports to the chat that asked, stops on request, and resumes the
 * agent's own session after its process dies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'coding-run-executor-'));
process.env.CLEMENTINE_HOME = home;

const store = await import('./coding-run-store.js');
const executor = await import('./coding-run-executor.js');
const { setCodingRunJudgeForTests } = await import('./coding-run-receipt.js');
const { AsyncQueue } = await import('./coding-agent-bridge.js');
const { codingRunBranchName, codingRunWorktreePath } = await import('./coding-run-git.js');
const { listEvents } = await import('../runtime/harness/eventlog.js');
type CodingAgentEvent = import('./coding-agent-bridge.js').CodingAgentEvent;
type CodingAgentStartInput = import('./coding-agent-bridge.js').CodingAgentStartInput;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', ...args], { cwd, encoding: 'utf-8' }).trim();

const project = path.join(home, 'projects', 'fixture');
mkdirSync(project, { recursive: true });
git(project, 'init', '-q', '-b', 'main');
writeFileSync(path.join(project, 'package.json'), '{"name":"fixture"}\n');
git(project, 'add', '.');
git(project, 'commit', '-q', '-m', 'Initial commit');

test.after(() => rmSync(home, { recursive: true, force: true }));

// ─── A scripted agent ───────────────────────────────────────────────────

interface AgentControls {
  input: CodingAgentStartInput;
  emit(event: CodingAgentEvent): void;
  /** Resolves with the next follow-up Clem sends. */
  nextFollowUp(): Promise<string>;
  end(): void;
  stopped: Promise<void>;
}

type Script = (agent: AgentControls) => Promise<void>;

const starts: CodingAgentStartInput[] = [];
let scripts: Script[] = [];

const fakeBridge = {
  id: 'claude' as const,
  start(input: CodingAgentStartInput) {
    starts.push(input);
    const events = new AsyncQueue<CodingAgentEvent>();
    const followUps: string[] = [];
    let waiter: ((text: string) => void) | null = null;
    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    const controls: AgentControls = {
      input,
      emit: (event) => events.push(event),
      nextFollowUp: () => new Promise((resolve) => {
        const queued = followUps.shift();
        if (queued !== undefined) resolve(queued);
        else waiter = resolve;
      }),
      end: () => events.close(),
      stopped,
    };
    const script = scripts.shift();
    if (!script) throw new Error('no scripted agent left');
    void script(controls).finally(() => events.close());
    return {
      events,
      send(text: string) {
        if (waiter) { const w = waiter; waiter = null; w(text); } else followUps.push(text);
      },
      async interrupt() { stop(); },
      close() { stop(); events.close(); },
    };
  },
};

executor.setCodingRunBridgesForTests({ claude: fakeBridge });
executor.setCodingRunPreflightForTests(async () => ({ ok: true }));

const reports: Array<{ runId: string; outcome: string; origin: string | null }> = [];
executor.setCodingRunReportDelivererForTests((run, settlement) => {
  reports.push({ runId: run.runId, outcome: settlement.outcome, origin: run.originSessionId });
  return true;
});

let judgeCalls = 0;
let judgeVerdict: (() => Promise<{ done: boolean; reason: string }>) = async () => ({ done: true, reason: 'The greeting works and is tested.' });
setCodingRunJudgeForTests(async () => { judgeCalls += 1; return judgeVerdict(); });

function commitFile(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(path.join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

function turn(finalMessage: string): CodingAgentEvent {
  return {
    kind: 'turn_completed',
    ok: true,
    finalMessage,
    usage: [{ model: 'claude-test', inputTokens: 10, cachedInputTokens: 100, cacheCreationInputTokens: 0, outputTokens: 5 }],
    costUsd: 0.01,
  };
}

function admit(label: string, overrides: Partial<Parameters<typeof store.admitCodingRun>[0]> = {}) {
  const runId = store.newCodingRunId();
  const objective = `Add ${label}`;
  return store.admitCodingRun({
    runId,
    agent: 'claude',
    projectName: 'fixture',
    projectPath: project,
    worktreePath: codingRunWorktreePath('fixture', runId),
    branch: codingRunBranchName(objective, runId),
    baseRef: 'main',
    baseCommit: git(project, 'rev-parse', 'HEAD'),
    objective,
    brief: `Add ${label} with a test.`,
    acceptance: [`${label} exists`],
    testCommand: `test -f ${label}.js`,
    originSessionId: 'sess-origin-exec',
    originSourceUserSeq: 3,
    ...overrides,
  }).run;
}

async function drainAndWait(): Promise<void> {
  await executor.drainCodingRunsOnce();
  await executor._waitForActiveCodingRunsForTests();
  await executor.drainCodingRunReportBacks();
}

function activityKinds(sessionId: string): string[] {
  return listEvents(sessionId)
    .filter((event) => event.type === 'coding_run_activity')
    .map((event) => String((event.data as { kind?: unknown }).kind));
}

// ─── Scenarios ───────────────────────────────────────────────────────────

test('a run briefs the agent in its worktree, verifies from git and tests, settles and reports back', async () => {
  const run = admit('greet');
  scripts.push(async (agent) => {
    agent.emit({ kind: 'session', agentSessionId: agent.input.agentSessionId, model: 'claude-test' });
    agent.emit({ kind: 'message', text: 'Adding greet.js now.', nested: false });
    agent.emit({ kind: 'step_started', stepId: 's1', tool: 'Write', detail: path.join(agent.input.cwd, 'greet.js'), nested: false });
    commitFile(agent.input.cwd, 'greet.js', 'module.exports = 1;\n', 'Add greet');
    agent.emit({ kind: 'step_finished', stepId: 's1', ok: true, output: 'written' });
    agent.emit(turn('Added greet.js.'));
    await agent.stopped;
  });
  await drainAndWait();

  const start = starts.at(-1)!;
  assert.equal(start.cwd, run.worktreePath);
  assert.equal(start.resume, false);
  assert.match(start.message, /Task: Add greet/);
  assert.match(start.instructions, new RegExp(run.branch.replace(/[/-]/g, '\\$&')));
  assert.equal(start.env.CLEMENTINE_HOME, undefined);

  const settled = store.getCodingRunSettlement(run.runId);
  assert.ok(settled);
  assert.equal(settled.outcome, 'completed_verified');
  assert.equal(settled.testExitCode, 0);
  assert.equal(settled.commits.length, 1);
  assert.equal(settled.commits[0]!.subject, 'Add greet');
  assert.equal(store.getCodingRun(run.runId)?.state, 'settled');
  assert.equal(git(run.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'), run.branch);
  // The user's own checkout never saw the change.
  assert.equal(existsSync(path.join(project, 'greet.js')), false);
  assert.equal(git(project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

  assert.deepEqual(reports.filter((r) => r.runId === run.runId), [{ runId: run.runId, outcome: 'completed_verified', origin: 'sess-origin-exec' }]);
  const kinds = activityKinds(run.sessionId);
  for (const kind of ['status', 'clem_message', 'agent_message', 'step_started', 'step_finished', 'review']) {
    assert.ok(kinds.includes(kind), `activity has ${kind}: ${kinds.join(',')}`);
  }
  assert.equal(listEvents(run.sessionId).filter((event) => event.type === 'coding_run_settled').length, 1);
  const step = listEvents(run.sessionId).find((event) => (event.data as { kind?: unknown }).kind === 'step_started');
  assert.equal((step?.data as { detail?: unknown }).detail, 'greet.js', 'worktree paths read project-relative');
  assert.equal(listEvents(run.sessionId).some((event) => event.type === 'tool_called'), false);
  assert.equal(store.getCodingRun(run.runId)?.usageRecorded['claude-test']?.cachedInputTokens, 100);
});

test('failing tests send the agent back with the output, and the next turn is checked again', async () => {
  const run = admit('fixme');
  let followUp = '';
  scripts.push(async (agent) => {
    agent.emit({ kind: 'session', agentSessionId: agent.input.agentSessionId, model: null });
    commitFile(agent.input.cwd, 'other.js', 'x\n', 'Wrong file');
    agent.emit(turn('Done, I think.'));
    followUp = await agent.nextFollowUp();
    commitFile(agent.input.cwd, 'fixme.js', 'x\n', 'Add fixme');
    agent.emit(turn('Fixed: added fixme.js.'));
    await agent.stopped;
  });
  await drainAndWait();
  assert.match(followUp, /exited 1/);
  assert.match(followUp, /test -f fixme\.js/);
  const settled = store.getCodingRunSettlement(run.runId);
  assert.equal(settled?.outcome, 'completed_verified');
  assert.equal(settled?.commits.length, 2);
  assert.equal(store.getCodingRun(run.runId)?.round, 1);
  const clemMessages = listEvents(run.sessionId)
    .filter((event) => event.type === 'coding_run_activity' && (event.data as { kind?: unknown }).kind === 'clem_message');
  assert.equal(clemMessages.length, 2, 'brief plus one follow-up');
});

test('an agent that changes nothing is sent back, then settles as failed when rounds run out', async () => {
  const run = admit('nothing', { maxRounds: 2, testCommand: null });
  scripts.push(async (agent) => {
    agent.emit({ kind: 'session', agentSessionId: agent.input.agentSessionId, model: null });
    agent.emit(turn('All done!'));
    await agent.nextFollowUp();
    agent.emit(turn('Really done.'));
    await agent.stopped;
  });
  const before = judgeCalls;
  await drainAndWait();
  const settled = store.getCodingRunSettlement(run.runId);
  assert.equal(settled?.outcome, 'failed');
  assert.match(settled?.reason ?? '', /without changing anything/);
  assert.equal(judgeCalls, before, 'no judge call is spent on an empty diff');
});

test('a judge that cannot answer leaves the work unverified, never passed', async () => {
  const run = admit('unverified');
  judgeVerdict = async () => { throw new Error('judge unavailable'); };
  scripts.push(async (agent) => {
    agent.emit({ kind: 'session', agentSessionId: agent.input.agentSessionId, model: null });
    commitFile(agent.input.cwd, 'unverified.js', 'x\n', 'Add unverified');
    agent.emit(turn('Done.'));
    await agent.stopped;
  });
  try {
    await drainAndWait();
  } finally {
    judgeVerdict = async () => ({ done: true, reason: 'ok' });
  }
  const settled = store.getCodingRunSettlement(run.runId);
  assert.equal(settled?.outcome, 'completed_unverified');
  assert.equal(settled?.verdict, 'unavailable');
});

test('a stop request ends the agent and settles the run as cancelled without a report', async () => {
  const run = admit('stoppable');
  scripts.push(async (agent) => {
    agent.emit({ kind: 'session', agentSessionId: agent.input.agentSessionId, model: null });
    agent.emit({ kind: 'message', text: 'Working…', nested: false });
    store.requestCodingRunStop(run.runId, 'Stopped from the chat');
    await agent.stopped;
  });
  await drainAndWait();
  const settled = store.getCodingRunSettlement(run.runId);
  assert.equal(settled?.outcome, 'cancelled');
  assert.equal(settled?.reason, 'Stopped from the chat');
  assert.equal(reports.some((r) => r.runId === run.runId), false);
  assert.equal(store.listPendingCodingRunReportBacks().some((row) => row.runId === run.runId), false);
});

test('a missing or signed-out agent blocks the run with the fix in the report', async () => {
  const run = admit('blocked');
  executor.setCodingRunPreflightForTests(async () => ({ ok: false, reason: 'Claude Code is signed out. Sign in from Connect → CLI tools.' }));
  try {
    await drainAndWait();
  } finally {
    executor.setCodingRunPreflightForTests(async () => ({ ok: true }));
  }
  const settled = store.getCodingRunSettlement(run.runId);
  assert.equal(settled?.outcome, 'blocked');
  assert.match(settled?.reason ?? '', /signed out/);
  assert.deepEqual(reports.filter((r) => r.runId === run.runId).map((r) => r.outcome), ['blocked']);
});

test('when the agent process dies, the next claim resumes the agent\'s own session', async () => {
  const run = admit('resumed');
  scripts.push(async (agent) => {
    agent.emit({ kind: 'session', agentSessionId: agent.input.agentSessionId, model: null });
    agent.emit({ kind: 'error', message: 'process exited with code 1' });
    agent.end();
  });
  await drainAndWait();
  const released = store.getCodingRun(run.runId);
  assert.equal(released?.state, 'resuming');
  const firstSessionId = starts.at(-1)!.agentSessionId;
  assert.equal(released?.agentSessionId, firstSessionId);

  scripts.push(async (agent) => {
    agent.emit({ kind: 'session', agentSessionId: agent.input.agentSessionId, model: null });
    commitFile(agent.input.cwd, 'resumed.js', 'x\n', 'Add resumed');
    agent.emit(turn('Picked up where I left off.'));
    await agent.stopped;
  });
  await drainAndWait();
  const resumedStart = starts.at(-1)!;
  assert.equal(resumedStart.resume, true);
  assert.equal(resumedStart.agentSessionId, firstSessionId);
  assert.match(resumedStart.message, /interrupted/);
  assert.equal(store.getCodingRunSettlement(run.runId)?.outcome, 'completed_verified');
  assert.equal(store.getCodingRun(run.runId)?.resumeCount, 1);
});

test('runs leased to a daemon that no longer exists are released for immediate resume', async () => {
  const run = admit('orphaned');
  // A PID far above any live process on this machine stands in for a dead daemon.
  const deadOwner = 'daemon:999999:deadbeef';
  let claimed = store.claimNextCodingRun(deadOwner, 60_000);
  while (claimed && claimed.runId !== run.runId) claimed = store.claimNextCodingRun(deadOwner, 60_000);
  assert.ok(claimed);
  assert.equal(executor.releaseRunsOfDeadOwners(), 1);
  assert.equal(store.getCodingRun(run.runId)?.state, 'resuming');
  store.requestCodingRunStop(run.runId, 'cleanup');
  scripts.push(async (agent) => {
    agent.emit({ kind: 'session', agentSessionId: agent.input.agentSessionId, model: null });
    await agent.stopped;
  });
  await drainAndWait();
  assert.equal(store.getCodingRunSettlement(run.runId)?.outcome, 'cancelled');
});
