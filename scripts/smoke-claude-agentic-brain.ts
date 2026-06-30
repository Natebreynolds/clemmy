/**
 * LIVE smoke — Claude agentic brain (Agent SDK lane) narrate-instead-of-call check.
 *
 * Runs ONE read-only agentic turn on the user's Claude subscription with the
 * Agent SDK brain forced to `full` IN-PROCESS ONLY (does NOT persist the flag —
 * your .env default stays whatever it is). Verifies the narrate-instead-of-call
 * fix: the turn must produce a NATIVE tool call (run_shell_command for a
 * read-only git command), not a markdown description of one.
 *
 * Run: npx tsx scripts/smoke-claude-agentic-brain.ts
 * Requires: AUTH_MODE=claude_oauth + a logged-in Claude subscription + the
 * `claude` CLI on PATH. Read-only (a git status); creates one test chat session.
 */
// Force the agentic brain for THIS PROCESS ONLY (process.env wins over .env in
// getRuntimeEnv). The persisted default is untouched.
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';

const { claudeAgentSdkBrainEnabled, respondViaClaudeAgentSdkBrain, claudeAgentSdkBrainMode } =
  await import('../src/runtime/harness/claude-agent-brain.js');
const { getActiveAuthMode } = await import('../src/config.js');

function bail(msg: string): never {
  console.error(`\n✗ PRECONDITION FAILED: ${msg}\n`);
  process.exit(2);
}

if (getActiveAuthMode() !== 'claude_oauth') {
  bail(`AUTH_MODE is "${getActiveAuthMode()}", not "claude_oauth". Select Claude as the brain first.`);
}
if (!claudeAgentSdkBrainEnabled('cli')) {
  bail('claudeAgentSdkBrainEnabled(cli) is false even with the flag forced — check surface gating / auth mode.');
}
console.log(`Agent SDK brain mode: ${claudeAgentSdkBrainMode()} (forced in-process; .env default unchanged)`);

const sessionId = `smoke-agentic-brain-${process.pid}`;
const prompt =
  'Using a tool, find the current git branch of this repository and how many files are uncommitted, ' +
  'then tell me both in one short sentence. Run a read-only command — do not change anything.';

console.log(`\n→ Driving one read-only agentic turn (session ${sessionId})…\n`);

const TIMEOUT_MS = 180_000;
const run = respondViaClaudeAgentSdkBrain('cli', {
  message: prompt,
  sessionId,
  channel: 'cli',
  userId: 'smoke',
});
const result = await Promise.race([
  run,
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 180s (possible approval pause or slow model)')), TIMEOUT_MS)),
]).catch((err: unknown) => {
  console.error(`\n✗ RUN ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

const raw = (result as { raw?: { toolUses?: string[]; model?: string } }).raw ?? {};
const toolUses = raw.toolUses ?? [];
const text = (result as { text?: string }).text ?? '';

console.log('─────────────────────────────────────────');
console.log(`model:      ${raw.model ?? '(unknown)'}`);
console.log(`toolUses:   [${toolUses.join(', ') || '(none)'}]`);
console.log(`reply:      ${text.replace(/\s+/g, ' ').slice(0, 280)}`);
console.log('─────────────────────────────────────────');

// Narration detector: a described-but-not-called command in the reply.
const narratedCmd = /```|run_shell_command\s*\(|\bI'?ll run\b|\bI would run\b|\blet me run\b|\byou can run\b/i.test(text);

if (toolUses.length > 0) {
  console.log('\n✓ PASS — Claude made a NATIVE tool call (no narrate-instead-of-call). The fix holds.');
  if (narratedCmd) console.log('  (note: reply also contains command-like text, but a real tool call DID happen.)');
  process.exit(0);
} else if (narratedCmd) {
  console.log('\n✗ FAIL — NO native tool call, but the reply DESCRIBES one. Narrate-instead-of-call still present.');
  process.exit(1);
} else {
  console.log('\n⚠ INCONCLUSIVE — no tool call and no narration. The model may have answered without needing a tool;');
  console.log('  re-run with a prompt that unambiguously requires a tool, or inspect the session trace.');
  process.exit(3);
}
