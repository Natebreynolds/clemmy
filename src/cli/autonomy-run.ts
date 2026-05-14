#!/usr/bin/env tsx
import { loadTeamAgents } from '../tools/shared.js';
import { runAgentCycleV2ForTest } from '../agents/autonomy-v2.js';
import { getAutonomyRun, autonomyRunSlug } from '../agents/run-tracking.js';
import { getOpenAiApiKey } from '../config.js';

/**
 * Manual one-shot runner for an autonomy-v2 cycle.
 *
 * Usage:
 *   npx tsx src/cli/autonomy-run.ts <agent-slug>
 *
 * What it does:
 *   - Loads the named TeamAgentRecord (must exist in
 *     ~/.clementine-next/vault/00-System/agents/).
 *   - Runs ONE v2 cycle for that agent, end-to-end:
 *     · structured-output via Zod schema
 *     · all registered MCP tools available
 *     · output guardrails enforced
 *     · per-tool lifecycle hooks recorded into run-events
 *   - Prints the full run timeline + final outcome so you can see
 *     exactly what the agent did.
 *
 * Useful for: validating the v2 stack end-to-end without restarting
 * the daemon, debugging a flaky agent cycle, demoing the loop, or
 * smoking out integration issues after a config change.
 *
 * Requirements:
 *   - OPENAI_API_KEY set (v2 needs structured outputs).
 *   - The agent's slug must resolve via loadTeamAgents().
 */

function bail(message: string, code = 1): never {
  console.error(`autonomy-run: ${message}`);
  process.exit(code);
}

function formatDuration(start: string, end?: string): string {
  if (!end) return '(no end recorded)';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return `${ms}ms`;
}

async function main(): Promise<void> {
  const slug = process.argv[2]?.trim();
  if (!slug) {
    console.error('Usage: npx tsx src/cli/autonomy-run.ts <agent-slug>');
    console.error('');
    console.error('Available agents:');
    for (const agent of loadTeamAgents()) {
      console.error(`  - ${agent.slug.padEnd(20)} ${agent.name}`);
    }
    process.exit(2);
  }

  if (!getOpenAiApiKey()) {
    bail('OPENAI_API_KEY is not set. v2 needs structured outputs which require an OpenAI API key.');
  }

  const record = loadTeamAgents().find((a) => a.slug === slug);
  if (!record) {
    bail(`No agent with slug "${slug}". Run with no args to list available agents.`);
  }
  if (record.autonomyEnabled === false) {
    bail(`Agent "${slug}" has autonomyEnabled=false. Enable it in the agent record first.`);
  }

  console.log(`▸ Running one v2 cycle for ${record.name} (${slug})`);
  console.log(`  model=${record.model ?? 'default-fast'} cadence=${record.cadenceMinutes ?? 30}m proactive=${record.proactive ?? false}`);
  console.log('');

  const start = Date.now();
  const result = await runAgentCycleV2ForTest(record);
  const wallMs = Date.now() - start;

  if (!result.runId) {
    console.log('  No wake reasons — agent is not due and has no pending inbox items.');
    console.log('  (Add an item to the inbox or wait for cadence to elapse.)');
    return;
  }

  const run = getAutonomyRun(result.runId);
  if (!run) {
    bail(`Run ${result.runId} completed but couldn't be loaded from runs.json.`);
  }

  console.log(`▸ Run ${run.id}`);
  console.log(`  Agent:    ${autonomyRunSlug(run)}`);
  console.log(`  Status:   ${run.status}`);
  console.log(`  Title:    ${run.title}`);
  console.log(`  Duration: ${formatDuration(run.createdAt, run.completedAt)} (wall: ${wallMs}ms)`);
  if (run.error) {
    console.log(`  Error:    ${run.error}`);
  }
  console.log('');
  console.log('▸ Timeline:');
  for (const event of run.events) {
    const time = event.createdAt.slice(11, 19);
    const data = event.data ? ` | ${JSON.stringify(event.data).slice(0, 200)}` : '';
    console.log(`  ${time} [${event.type.padEnd(14)}] ${event.message}${data}`);
  }
  console.log('');

  if (result.success) {
    console.log('▸ Outcome:');
    for (const line of result.outcomes) {
      console.log(`  ${line}`);
    }
  } else {
    console.log('▸ Cycle failed.');
    if (result.error) console.log(`  ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('autonomy-run: unexpected failure');
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
