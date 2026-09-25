import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { textResult } from './shared.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { DISPATCH_ALIGNMENT_BEAT_REFUSAL, dispatchAlignmentBeatOwed } from './background-task-tools.js';

/**
 * Delegated coding agents in the user's local projects.
 *
 * `dispatch_coding_task` hands an agreed coding task to Claude Code, working
 * in its own git worktree on its own branch. The tool only ADMITS the run — a
 * durable row the daemon claims, drives, reviews and settles; it never spawns
 * a process. The result reports back into this chat when the run settles.
 *
 * `project_run` inspects and stops runs. Its old `start` launched a raw child
 * CLI with no durable owner and promoted exit-zero prose to success; that path
 * stays closed and points at dispatch_coding_task instead.
 */

const ACTION = z.enum(['start', 'status', 'kill', 'runs']);

export function registerProjectRunTools(server: McpServer): void {
  server.tool(
    'dispatch_coding_task',
    [
      'Hand an AGREED coding task to a coding agent (Claude Code) working in one of the user\'s local git projects.',
      'The agent works in its own worktree on a new branch, so the user\'s checkout is never touched. It can read, edit, build, test and commit there; it cannot push, open PRs, publish or deploy.',
      'Clem reviews every turn from git and her own run of test_command, sends the agent back with anything missing, and reports the result to THIS chat automatically. The user can watch it live.',
      'Call this ONLY after you and the user agreed on the task. After it returns, tell the user it is running and STOP — do not do the coding yourself and do not poll.',
    ].join('\n'),
    {
      project: z.string().min(1).max(500)
        .describe('Project name or absolute path from workspace_list. It must be a git repository with at least one commit.'),
      objective: z.string().min(4).max(300)
        .describe('One line naming the job (e.g. "Add a dark-mode toggle to the settings page"). This is the run\'s title and what Clem checks the work against.'),
      brief: z.string().min(1).max(8000)
        .describe('The agreed instructions for the coding agent: what to change, where, constraints, anything the user said. Written for the agent.'),
      acceptance: z.array(z.string().min(1).max(300)).max(12).nullable()
        .describe('Concrete done-checks Clem reviews against. Null when the objective says it all.'),
      test_command: z.string().max(300).nullable()
        .describe('A command Clem runs herself in the worktree to verify (e.g. "npm test"). Null when the project has no suitable one.'),
      expect_changes: z.boolean().nullable()
        .describe('False only for investigation tasks whose answer is a report, not code. Default true: finishing without changes counts as not done.'),
      model: z.string().max(80).nullable()
        .describe('Optional model for the coding agent. Null uses its default.'),
      handoff_note: z.string().nullable()
        .describe('YOUR OWN WORDS to the user confirming the handoff: what is running, where, and that you will report back here. Null falls back to a generated line.'),
    },
    async (input) => {
      try {
        return await dispatchCodingTask(input);
      } catch (err) {
        return textResult(JSON.stringify({
          ok: false,
          code: 'coding_dispatch_failed',
          reason: err instanceof Error ? err.message : String(err),
        }));
      }
    },
  );

  server.tool(
    'project_run',
    [
      'Inspect or stop coding runs (and older guest runs) in the user\'s local projects. Actions:',
      '- status: a run by runId — state, what the agent is doing now, and the result once settled.',
      '- kill: stop a run by runId.',
      '- runs: list recent runs.',
      '- start: not available here; use dispatch_coding_task.',
    ].join('\n'),
    {
      action: ACTION.describe('What to do: status | kill | runs (start is not available; use dispatch_coding_task).'),
      project: z.string().max(500).optional()
        .describe('Unused; kept for older callers.'),
      prompt: z.string().max(4000).optional()
        .describe('Unused; kept for older callers.'),
      harness: z.enum(['claude', 'codex']).optional()
        .describe('Unused; kept for older callers.'),
      model: z.string().max(60).optional()
        .describe('Unused; kept for older callers.'),
      runId: z.string().max(80).optional()
        .describe('status/kill: the run id.'),
    },
    async ({ action, runId }) => {
      try {
        if (action === 'start') return startAction();
        if (action === 'status') return await statusAction(runId);
        if (action === 'kill') return await killAction(runId);
        return await runsAction();
      } catch (err) {
        return textResult(`project_run ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

interface DispatchInput {
  project: string;
  objective: string;
  brief: string;
  acceptance: string[] | null;
  test_command: string | null;
  expect_changes: boolean | null;
  model: string | null;
  handoff_note: string | null;
}

function refusal(code: string, reason: string): ReturnType<typeof textResult> {
  return textResult(JSON.stringify({ ok: false, code, reason }));
}

async function dispatchCodingTask(input: DispatchInput): Promise<ReturnType<typeof textResult>> {
  const toolContext = getToolOutputContext();
  const sessionId = toolContext?.sessionId;
  if (!sessionId) {
    return refusal('coding_dispatch_needs_chat', 'A coding task can only be dispatched from a live chat, which is where it reports back.');
  }
  if (dispatchAlignmentBeatOwed(sessionId)) return textResult(DISPATCH_ALIGNMENT_BEAT_REFUSAL);
  void input.handoff_note; // rendered as the reply by the control-receipt renderer

  const { resolveRosterProject } = await import('../execution/guest-run-jobs.js');
  const project = resolveRosterProject(input.project);
  if (!project) {
    return refusal(
      'coding_project_not_on_roster',
      `"${input.project}" is not one of the user's projects. Check workspace_list, or have the user add the folder under Connect → Projects.`,
    );
  }
  const { readProjectRepo, codingRunBranchName, codingRunWorktreePath } = await import('../execution/coding-run-git.js');
  const repo = await readProjectRepo(project.path);
  if (!repo) {
    return refusal(
      'coding_project_not_git',
      `${project.name} is not a git repository with at least one commit. A coding run works on its own branch, so the project needs git first.`,
    );
  }

  const context = harnessRunContextStorage.getStore();
  const sourceUserSeq = typeof toolContext?.sourceUserSeq === 'number' && toolContext.sourceUserSeq > 0
    ? toolContext.sourceUserSeq
    : context?.sessionId === sessionId && typeof context.sourceUserSeq === 'number'
      ? context.sourceUserSeq
      : null;
  const objective = input.objective.trim();
  // A retried call in the same turn rejoins its run; a different task in the
  // same turn is a different run.
  const admissionKey = sourceUserSeq
    ? `${sessionId}:${sourceUserSeq}:${createHash('sha256').update(`${repo.topLevel}\n${objective}`).digest('hex').slice(0, 16)}`
    : null;

  const { admitCodingRun, newCodingRunId } = await import('../execution/coding-run-store.js');
  const runId = newCodingRunId();
  const { run, created } = admitCodingRun({
    runId,
    agent: 'claude',
    projectName: project.name,
    projectPath: repo.topLevel,
    worktreePath: codingRunWorktreePath(project.name, runId),
    branch: codingRunBranchName(objective, runId),
    baseRef: repo.branch,
    baseCommit: repo.headCommit,
    objective,
    brief: input.brief.trim(),
    acceptance: (input.acceptance ?? []).map((item) => item.trim()).filter(Boolean),
    testCommand: input.test_command?.trim() || null,
    expectChanges: input.expect_changes !== false,
    model: input.model?.trim() || null,
    originSessionId: sessionId,
    originSourceUserSeq: sourceUserSeq,
    originAttemptId: context?.runAttemptId ?? null,
    admissionKey,
  });

  return textResult(
    `Dispatched coding run ${run.runId}: Claude Code will work on "${run.objective}" in ${run.projectName} `
    + `on its own branch ${run.branch}${repo.branch ? ` (cut from ${repo.branch})` : ''}. The user's checkout is untouched. `
    + `Clem checks the work${run.testCommand ? ` with \`${run.testCommand}\`` : ''} and reports back here when it settles.`
    + (created ? '' : ' (This rejoined the run already started for this request.)')
    + '\n[harness-directive] Tell the user in your own words that it is running and that you will report back; '
    + 'do NOT write the code yourself this turn and do NOT poll.',
  );
}

function startAction(): ReturnType<typeof textResult> {
  return textResult(JSON.stringify({
    ok: false,
    status: 'unavailable',
    code: 'project_run_start_moved',
    processStarted: false,
    runRecordCreated: false,
    reason: 'project_run no longer starts runs. Use dispatch_coding_task, which gives the run a durable owner, its own worktree, and a verified result.',
  }), { isError: true });
}

async function statusAction(runId: string | undefined): Promise<ReturnType<typeof textResult>> {
  if (!runId) return textResult('project_run status needs runId.');
  if (runId.startsWith('code-')) return codingRunStatus(runId);
  const { getGuestRun } = await import('../execution/guest-run-jobs.js');
  const job = getGuestRun(runId);
  if (!job) return textResult(`No run ${runId}. See project_run runs.`);
  const lines = [
    `${job.id}: ${job.status} — ${job.harness} in ${job.projectName}`,
    `Prompt: ${job.prompt}`,
  ];
  if (job.status === 'running') {
    const tail = job.events.slice(-8);
    lines.push(tail.length ? `Recent activity:\n${tail.map((e) => `  ${e}`).join('\n')}` : 'No output yet.');
  } else {
    if (job.durationMs) lines.push(`Took ${Math.round(job.durationMs / 1000)}s.`);
    if (job.finalMessage) lines.push(`Final message:\n${job.finalMessage}`);
    if (job.error) lines.push(`Error: ${job.error}`);
    lines.push(job.changedFiles.length
      ? `Files created/changed (relative to ${job.projectPath}):\n${job.changedFiles.map((f) => `  ${f}`).join('\n')}`
      : 'No files changed.');
  }
  return textResult(lines.join('\n'));
}

async function codingRunStatus(runId: string): Promise<ReturnType<typeof textResult>> {
  const { getCodingRun, getCodingRunSettlement } = await import('../execution/coding-run-store.js');
  const run = getCodingRun(runId);
  if (!run) return textResult(`No coding run ${runId}. See project_run runs.`);
  const lines = [
    `${run.runId}: ${run.state} — ${run.agent} in ${run.projectName} on ${run.branch}`,
    `Task: ${run.objective}`,
  ];
  if (run.stopRequestedAt && run.state !== 'settled') lines.push(`Stop requested: ${run.stopReason ?? 'yes'}.`);
  const settlement = run.state === 'settled' ? getCodingRunSettlement(runId) : null;
  if (settlement) {
    lines.push(`Outcome: ${settlement.outcome} — ${settlement.reason}`);
    if (settlement.commits.length) lines.push(`Commits:\n${settlement.commits.map((c) => `  ${c.sha.slice(0, 10)} ${c.subject}`).join('\n')}`);
    if (settlement.testCommand) lines.push(`Tests (${settlement.testCommand}): exit ${settlement.testExitCode ?? 'none'}`);
  } else {
    const { listEvents } = await import('../runtime/harness/eventlog.js');
    // desc + limit returns the newest rows, already back in chronological order.
    const recent = listEvents(run.sessionId, { types: ['coding_run_activity'], desc: true, limit: 8 })
      .map((event) => {
        const data = event.data as { kind?: unknown; text?: unknown; tool?: unknown; detail?: unknown; reason?: unknown };
        const text = [data.tool, data.detail, data.text, data.reason].find((value) => typeof value === 'string' && value.trim());
        return `  ${String(data.kind)}${text ? `: ${String(text).slice(0, 160)}` : ''}`;
      });
    lines.push(recent.length ? `Recent activity:\n${recent.join('\n')}` : 'No activity yet.');
    lines.push(`Review round ${run.round + 1} of ${run.maxRounds}.`);
  }
  return textResult(lines.join('\n'));
}

async function killAction(runId: string | undefined): Promise<ReturnType<typeof textResult>> {
  if (!runId) return textResult('project_run kill needs runId.');
  if (runId.startsWith('code-')) {
    const { requestCodingRunStop } = await import('../execution/coding-run-store.js');
    const run = requestCodingRunStop(runId, 'Stopped by request in chat.');
    if (!run) return textResult(`No coding run ${runId}.`);
    return textResult(`${run.runId}: ${run.state === 'settled' ? 'already finished' : 'stop requested'}.`);
  }
  const { killGuestRun } = await import('../execution/guest-run-jobs.js');
  const job = killGuestRun(runId);
  if (!job) return textResult(`No guest run ${runId}.`);
  return textResult(`${job.id}: ${job.status === 'running' ? 'stop requested' : `already ${job.status}`}.`);
}

async function runsAction(): Promise<ReturnType<typeof textResult>> {
  const { listCodingRuns } = await import('../execution/coding-run-store.js');
  const { listGuestRuns } = await import('../execution/guest-run-jobs.js');
  const coding = listCodingRuns({ limit: 15 })
    .map((run) => `- ${run.runId}: ${run.state} — ${run.agent} in ${run.projectName} — "${run.objective.slice(0, 80)}"`);
  const guest = listGuestRuns().slice(0, 5)
    .map((j) => `- ${j.id}: ${j.status} — ${j.harness} in ${j.projectName} — "${j.prompt.slice(0, 80)}"`);
  const lines = [...coding, ...guest];
  return textResult(lines.length ? lines.join('\n') : 'No coding runs yet.');
}
