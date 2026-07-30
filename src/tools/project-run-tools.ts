import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';

/**
 * `project_run` — drive the user's REAL Claude Code / Codex CLI as a full
 * agent inside one of their local projects.
 *
 * Why a guest harness instead of doing the work in-loop: the output the
 * user wants from a project (their /seo-audit, /build-brief, …) is produced
 * by that project's whole stack — slash commands, skills, CLAUDE.md /
 * AGENTS.md, .mcp.json servers with their creds — running under the CLI the
 * user built it for, on the user's own subscription auth. Reproducing the
 * command in-loop yields a lookalike, not the real deliverable.
 *
 * Contract (mirrors cli_setup): the SPAWN is the effect — offer → one user
 * approval → start → poll with status → deliver the result and the changed
 * files. Runs outlive a single turn (audits take 10–30 min); never block on
 * one. Projects come from the user's workspace roster ONLY; discover them
 * (and their slash commands) with workspace_list.
 */

const ACTION = z.enum(['start', 'status', 'kill', 'runs']);

export function registerProjectRunTools(server: McpServer): void {
  server.tool(
    'project_run',
    [
      'Run a prompt or slash command through the user\'s own Claude Code or Codex CLI inside one of their local projects (the project\'s slash commands, skills, MCP servers, and instructions all apply). Actions:',
      '- start: launch a run. Pass project (name or path from workspace_list), prompt (e.g. "/seo-audit https://example.com" or free text), harness ("claude" | "codex").',
      '- status: poll a run by runId — recent narration, final message, and files it created/changed.',
      '- kill: stop a running guest run.',
      '- runs: list recent guest runs.',
      'Ask the user before start (one approval per run); status/runs are read-only.',
      'Use this when the user asks for something a project\'s own commands already produce — never rebuild a project\'s deliverable by hand in-loop.',
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
  project: string | undefined,
  prompt: string | undefined,
  harness: 'claude' | 'codex' | undefined,
  model: string | undefined,
): Promise<ReturnType<typeof textResult>> {
  if (!project || !prompt) {
    return textResult('project_run start needs both project and prompt. Find projects (and their slash commands) with workspace_list.');
  }
  const { guestHarnessAvailable } = await import('../execution/guest-harness.js');
  const chosen = harness ?? 'claude';
  if (!guestHarnessAvailable(chosen)) {
    const catalogId = chosen === 'claude' ? 'claude-code' : 'codex';
    return textResult(
      `The ${chosen} CLI is not installed. Offer to install it: cli_setup {"action":"install","catalogId":"${catalogId}"} (ask the user first).`,
    );
  }
  const { startGuestRun } = await import('../execution/guest-run-jobs.js');
  const job = startGuestRun({ harness: chosen, project, prompt, model });
  return textResult(
    `Started ${job.harness} in ${job.projectName} (${job.projectPath}) — runId ${job.id}.\n`
    + `Prompt: ${job.prompt}\n`
    + 'This can take many minutes. Poll with project_run {"action":"status","runId":"' + job.id + '"} '
    + 'and tell the user it is underway; deliver the final message and changed files when it completes.',
  );
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
