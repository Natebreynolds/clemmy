/**
 * LIVE smoke — the Claude Agent SDK brain GENERATES + EXECUTES a workflow.
 *
 * The goal requirement: "if we run in -p claude, he needs to be able to generate
 * and execute workflows." Forces CLEMMY_CLAUDE_AGENT_SDK_BRAIN=full IN-PROCESS
 * ONLY, drives the Claude brain to author a one-step workflow and run it, and
 * verifies via the workflow store + the tool calls that it actually did both.
 *
 * Run: npx tsx scripts/smoke-claude-brain-workflow.ts
 * Requires AUTH_MODE=claude_oauth + Claude subscription + the `claude` CLI.
 */
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';

const { respondViaClaudeAgentSdkBrain, claudeAgentSdkBrainEnabled } =
  await import('../src/runtime/harness/claude-agent-brain.js');
const { getActiveAuthMode } = await import('../src/config.js');
const { listWorkflows } = await import('../src/memory/workflow-store.js');

if (getActiveAuthMode() !== 'claude_oauth') {
  console.error(`\n✗ AUTH_MODE is "${getActiveAuthMode()}", not "claude_oauth".\n`);
  process.exit(2);
}
if (!claudeAgentSdkBrainEnabled('cli')) {
  console.error('\n✗ claudeAgentSdkBrainEnabled(cli) is false even with the flag forced.\n');
  process.exit(2);
}

const tag = `clem-smoke-flow-${process.pid}`;
const before = new Set(listWorkflows().map((w) => (w as { name?: string; id?: string }).name ?? (w as { id?: string }).id));

const sessionId = `smoke-wf-${process.pid}`;
const prompt =
  `Using your workflow tools, do BOTH of these now: ` +
  `(1) create a simple one-step workflow named "${tag}" whose single step runs the read-only shell command ` +
  `\`echo hello from a clementine workflow\` (no external writes, no approval needed); ` +
  `(2) immediately run that workflow once. ` +
  `Then tell me in one sentence that you created and ran it.`;

console.log(`\n→ Asking the Claude brain to author + run workflow "${tag}" (session ${sessionId})…\n`);

const TIMEOUT_MS = 240_000;
const result = await Promise.race([
  respondViaClaudeAgentSdkBrain('cli', { message: prompt, sessionId, channel: 'cli', userId: 'smoke' }),
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 240s')), TIMEOUT_MS)),
]).catch((err: unknown) => {
  console.error(`\n✗ RUN ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

const raw = (result as { raw?: { toolUses?: string[] } }).raw ?? {};
const toolUses = (raw.toolUses ?? []).map((t) => t.split('__').at(-1));
const text = (result as { text?: string }).text ?? '';

const after = listWorkflows();
const created = after.find((w) => ((w as { name?: string }).name ?? '') === tag);
const calledCreate = toolUses.includes('workflow_create');
const calledRun = toolUses.includes('workflow_run');

console.log('─────────────────────────────────────────');
console.log(`toolUses:        [${toolUses.join(', ') || '(none)'}]`);
console.log(`workflow_create: ${calledCreate ? 'called' : 'NOT called'}`);
console.log(`workflow_run:    ${calledRun ? 'called' : 'NOT called'}`);
console.log(`workflow in store: ${created ? `YES (id=${(created as { id?: string }).id ?? '?'})` : 'NO'}`);
console.log(`new workflows:   ${after.length - before.size}`);
console.log(`reply:           ${text.replace(/\s+/g, ' ').slice(0, 240)}`);
console.log('─────────────────────────────────────────');

if (created && calledCreate && calledRun) {
  console.log('\n✓ PASS — the Claude brain AUTHORED a workflow (in the store) AND ran it. Generate + execute works.');
  process.exit(0);
} else if (created && calledCreate) {
  console.log('\n~ PARTIAL — workflow was created, but workflow_run was not called. Authoring works; check the run dispatch.');
  process.exit(3);
} else if (calledCreate && !created) {
  console.log('\n~ PARTIAL — workflow_create was called but no workflow landed in the store. Inspect the create handler / spec validity.');
  process.exit(3);
} else {
  console.log('\n✗ FAIL — the Claude brain did not author the workflow. Inspect the trace / whether the workflow tools fired.');
  process.exit(1);
}
