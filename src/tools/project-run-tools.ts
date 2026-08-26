import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';

/**
 * `project_run` — inspect and stop historical Claude Code / Codex guest runs.
 *
 * The former `start` implementation launched a raw child CLI after the local
 * tool returned. That child had no durable logical/physical execution owner,
 * and exit-zero prose was promoted directly to success. Until a delegated
 * execution root can own the child, its effects, and its terminal receipt,
 * `start` is a typed pre-spawn unavailable result. Historical status, runs,
 * and kill controls remain reachable.
 */

const ACTION = z.enum(['start', 'status', 'kill', 'runs']);

export function registerProjectRunTools(server: McpServer): void {
  server.tool(
    'project_run',
    [
      'Inspect or stop historical Claude Code or Codex guest runs. Starting a new raw guest process is unavailable until a durable delegated-execution root owns its effects and terminal receipt. Actions:',
      '- start: returns a typed unavailable result without spawning a process or creating a run record.',
      '- status: poll a run by runId — recent narration, final message, and files it created/changed.',
      '- kill: stop a running guest run.',
      '- runs: list recent guest runs.',
      'status/runs are read-only; kill remains available for an already-running historical process.',
    ].join('\n'),
    {
      action: ACTION.describe('What to do: start | status | kill | runs.'),
      project: z.string().max(500).optional()
        .describe('start only: project name or absolute path — must be on the workspace roster (see workspace_list).'),
      prompt: z.string().max(4000).optional()
        .describe('start only: the instruction, e.g. "/seo-audit https://example.com".'),
      harness: z.enum(['claude', 'codex']).optional()
        .describe('start only: which CLI runs it. Default: claude.'),
      model: z.string().max(60).optional()
        .describe('start only: optional model override passed to the CLI.'),
      runId: z.string().max(80).optional()
        .describe('status/kill: the id returned by start.'),
    },
    async ({ action, project, prompt, harness, model, runId }) => {
      try {
        if (action === 'start') return await startAction(project, prompt, harness, model);
        if (action === 'status') return await statusAction(runId);
        if (action === 'kill') return await killAction(runId);
        return await runsAction();
      } catch (err) {
        return textResult(`project_run ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

async function startAction(
  _project: string | undefined,
  _prompt: string | undefined,
  _harness: 'claude' | 'codex' | undefined,
  _model: string | undefined,
): Promise<ReturnType<typeof textResult>> {
  return textResult(JSON.stringify({
    ok: false,
    status: 'unavailable',
    code: 'durable_delegated_execution_root_required',
    processStarted: false,
    runRecordCreated: false,
    reason: 'project_run start cannot launch an unowned guest process. A durable delegated-execution root must own the child process, physical effects, and terminal receipt before new starts can be enabled. Historical status, runs, and kill actions remain available.',
  }), { isError: true });
}

async function statusAction(runId: string | undefined): Promise<ReturnType<typeof textResult>> {
  if (!runId) return textResult('project_run status needs runId.');
  const { getGuestRun } = await import('../execution/guest-run-jobs.js');
  const job = getGuestRun(runId);
  if (!job) return textResult(`No guest run ${runId} — it may predate the last daemon restart. See project_run runs.`);
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

async function killAction(runId: string | undefined): Promise<ReturnType<typeof textResult>> {
  if (!runId) return textResult('project_run kill needs runId.');
  const { killGuestRun } = await import('../execution/guest-run-jobs.js');
  const job = killGuestRun(runId);
  if (!job) return textResult(`No guest run ${runId}.`);
  return textResult(`${job.id}: ${job.status === 'running' ? 'stop requested' : `already ${job.status}`}.`);
}

async function runsAction(): Promise<ReturnType<typeof textResult>> {
  const { listGuestRuns } = await import('../execution/guest-run-jobs.js');
  const runs = listGuestRuns();
  if (runs.length === 0) return textResult('No guest runs yet this session.');
  return textResult(runs.slice(0, 15)
    .map((j) => `- ${j.id}: ${j.status} — ${j.harness} in ${j.projectName} — "${j.prompt.slice(0, 80)}"`)
    .join('\n'));
}
