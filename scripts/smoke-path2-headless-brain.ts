/**
 * LIVE smoke — Path 2: the HEADLESS Claude brain in the harness loop.
 *
 * Forces CLEMMY_CLAUDE_AGENT_SDK_BRAIN=off IN-PROCESS ONLY (your .env is NOT
 * touched), so the brain is headless 'claude -p' driven by the @openai/agents
 * harness loop. Drives a MULTI-STEP, read-only tool task and verifies the brain
 * actually CHAINS real tool calls and finishes — the linchpin "functions
 * properly" proof for Path 2.
 *
 * Run: npx tsx scripts/smoke-path2-headless-brain.ts
 * Requires AUTH_MODE=claude_oauth + Claude subscription + the `claude` CLI.
 */
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'off'; // Path 2: headless brain, not the agentic SDK lane

const { respondPreferHarness } = await import('../src/runtime/harness/respond-bridge.js');
const { getActiveAuthMode } = await import('../src/config.js');
const { listEvents } = await import('../src/runtime/harness/eventlog.js');
const { claudeAgentSdkBrainMode } = await import('../src/runtime/harness/claude-agent-brain.js');

if (getActiveAuthMode() !== 'claude_oauth') {
  console.error(`\n✗ AUTH_MODE is "${getActiveAuthMode()}", not "claude_oauth".\n`);
  process.exit(2);
}
console.log(`Agent SDK brain mode (forced): ${claudeAgentSdkBrainMode() ?? 'off'} → brain = headless Claude in the harness loop`);

const sessionId = `smoke-path2-${process.pid}`;
const prompt =
  'Do this in two steps using your tools, then answer: ' +
  '(1) run a read-only git command to get this repo\'s current branch name; ' +
  '(2) count how many .ts files are in the src/runtime/harness/ directory. ' +
  'Then reply with ONE short sentence stating the branch and the count. Read-only only.';

console.log(`\n→ Driving a multi-step read-only tool task on the headless brain (session ${sessionId})…\n`);

const TIMEOUT_MS = 240_000;
const result = await Promise.race([
  respondPreferHarness('cli', { message: prompt, sessionId, channel: 'cli', userId: 'smoke' },
    async () => { throw new Error('FELL BACK TO LEGACY — harness/auth not configured (not a Path-2 test)'); }),
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 240s')), TIMEOUT_MS)),
]).catch((err: unknown) => {
  console.error(`\n✗ RUN ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

const text = (result as { text?: string }).text ?? '';
const turns = (result as { turnsUsed?: number }).turnsUsed;

// Inspect the event log for REAL tool execution (not narration).
const events = listEvents(sessionId);
const byType = (t: string) => events.filter((e) => (e as { type?: string }).type === t).length;
const toolCalls = byType('tool_called');
const toolReturns = byType('tool_returned');
const completed = byType('conversation_completed') + byType('runtime.completed');
const toolNames = [...new Set(events
  .filter((e) => (e as { type?: string }).type === 'tool_called')
  .map((e) => ((e as { data?: { tool?: string } }).data?.tool ?? '?')))];

console.log('─────────────────────────────────────────');
console.log(`turnsUsed:        ${turns ?? '?'}`);
console.log(`tool_called:      ${toolCalls}  ${toolNames.length ? `[${toolNames.join(', ')}]` : ''}`);
console.log(`tool_returned:    ${toolReturns}`);
console.log(`completed events: ${completed}`);
console.log(`reply:            ${text.replace(/\s+/g, ' ').slice(0, 280)}`);
console.log('─────────────────────────────────────────');

// Ground-truth facts the model could only know by running the tools.
const hasBranch = /feat\/background-tasks-board/.test(text);
const hasNumber = /\b\d{1,3}\b/.test(text);
const narratedOnly = toolCalls === 0 && /```|I'?ll run|let me run|you can run|git (status|branch|rev-parse)/i.test(text);

if (toolCalls >= 1 && hasBranch && hasNumber) {
  console.log('\n✓ PASS — the headless brain CHAINED real tool calls and answered from the results (multi-step works).');
  process.exit(0);
} else if (narratedOnly) {
  console.log('\n✗ FAIL — no real tool calls; the reply only describes the commands. Headless brain not executing.');
  process.exit(1);
} else if (toolCalls >= 1 && !hasBranch) {
  console.log('\n~ PARTIAL — tools ran, but the reply lacks the ground-truth branch/count. Inspect the trace.');
  process.exit(3);
} else {
  console.log('\n⚠ INCONCLUSIVE — see fields above (no tool calls recorded and no clear narration).');
  process.exit(3);
}
