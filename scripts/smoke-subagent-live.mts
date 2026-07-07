/**
 * LIVE 1.0 gate — real SDK workflow step with tool-deferral ON, driving a fan-out
 * that uses a DEFERRED external MCP tool (dataforseo). Validates two things at once:
 *   #1 workflow-lane deferral: a workflow step's workers can still REACH a deferred
 *      external tool via tool search (no tool lost in the workflow lane).
 *   #2 Agents-panel attribution: the fan-out workers are recorded under the workflow
 *      RUN in the subagent-runs store (listSubagentRuns(runId) returns them).
 *
 * Run: CLEMMY_CLAUDE_TOOL_SEARCH=on npx tsx scripts/smoke-subagent-live.mts
 */
process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'on';

const { createSession } = await import('../src/runtime/harness/eventlog.js');
const { runClaudeAgentSdkWorkflowStep } = await import('../src/runtime/harness/claude-agent-workflow-step.js');
const { listSubagentRuns } = await import('../src/agents/subagent-runs.js');

const sess = createSession({ kind: 'workflow' } as any);
const runId = `smoke10-${Date.now()}`;
console.log(`session=${sess.id} runId=${runId} tool_search=on\n`);

const step = {
  id: 'seo_fanout',
  prompt: 'Fetch top organic keywords per domain via the dataforseo MCP.',
  intent: 'research',
  output: { type: 'object' as const, required_keys: ['results'] },
} as any;

const result = await runClaudeAgentSdkWorkflowStep({
  step,
  workflowName: 'Smoke10SEO',
  runId,
  sessionId: sess.id,
  fullLane: true,
  modelId: 'claude-sonnet-4-6',
  prompt: [
    'Get the top 3 organic Google keywords (US) for stanleysteemer.com via the dataforseo MCP.',
    'Return { results: [{ domain, keywords }] } and call workflow_step_result once.',
  ].join('\n'),
});

console.log('STEP status:', (result as any)?.output?.blocked ? `BLOCKED: ${(result as any).output.reason}` : 'completed');
console.log('STEP output head:', JSON.stringify((result as any)?.output).slice(0, 300), '\n');

const agents = listSubagentRuns(runId);
console.log(`=== SUBAGENTS recorded under workflow run ${runId}: ${agents.length} ===`);
for (const a of agents) {
  console.log(` - ${a.provider} ${a.model ?? ''} | ${a.role ?? ''} ${a.task} | ${a.status} | parentKind=${a.parentKind} | workProduct=${a.outputRef ? 'yes' : 'no'}`);
}
console.log('\nGATE #1 (workflow-lane deferral reachable):', agents.some((a) => a.status === 'ok') ? 'workers ran OK' : 'CHECK — no ok worker');
console.log('GATE #2 (attribution to workflow run):', agents.length > 0 && agents.every((a) => a.parentKind === 'workflow') ? 'PASS — all under the run' : (agents.length ? 'PARTIAL' : 'FAIL — none recorded'));
process.exit(0);
