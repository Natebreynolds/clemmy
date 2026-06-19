#!/usr/bin/env tsx
/**
 * LIVE smoke — does the Claude chat brain CALL tools instead of NARRATING them?
 *
 * Reproduces the live failure (sess-mql8hb50): "pull 5 salesforce accounts" made
 * ZERO tool calls and the model typed a fake "Tool:run_shell_command / System:
 * tool result is empty" transcript. Runs the real brain N times (narration was
 * intermittent ~50%) and reports, per run: real tool calls vs narration.
 *
 * PASS = zero narrated runs. Run: npx tsx scripts/smoke-brain-narration.ts
 * Needs the real Claude subscription login + the `claude` CLI.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
if (!existsSync(path.join(realHome, 'state', 'claude-auth.json'))) {
  console.error('✗ No Claude login found — cannot run the live brain smoke.');
  process.exit(1);
}
process.env.CLEMENTINE_HOME = realHome;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';

const RUNS = Number.parseInt(process.env.NARRATION_RUNS || '4', 10);
const PROMPT = 'pull 5 salesforce accounts for me please just as a test';

const { respondViaClaudeAgentSdkBrain, looksLikeToolNarration, claudeAgentSdkBrainEnabled } =
  await import('../src/runtime/harness/claude-agent-brain.js');
const { resetHarnessRuntimeConfig } = await import('../src/runtime/harness/codex-client.js');
const { loadFreshClaudeAccessToken } = await import('../src/runtime/claude-oauth.js');
resetHarnessRuntimeConfig();

if (!claudeAgentSdkBrainEnabled('home')) { console.error('✗ Claude brain not enabled even with the flag forced.'); process.exit(2); }
try { await loadFreshClaudeAccessToken(); } catch (e) { console.error(`✗ token refresh: ${e instanceof Error ? e.message : e}`); process.exit(3); }

let narrated = 0; let called = 0;
for (let i = 1; i <= RUNS; i += 1) {
  const sessionId = `smoke-narrate-${process.pid}-${i}`;
  let res: any;
  try {
    res = await Promise.race([
      respondViaClaudeAgentSdkBrain('home', { message: PROMPT, sessionId, channel: 'home', userId: 'smoke' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 180s')), 180_000)),
    ]);
  } catch (e) { console.error(`  run ${i}: ERROR ${e instanceof Error ? e.message : e}`); continue; }
  const toolUses: string[] = res?.raw?.toolUses ?? [];
  const text: string = res?.text ?? '';
  const isNarration = looksLikeToolNarration(text, toolUses);
  if (toolUses.length > 0) called += 1;
  if (isNarration) narrated += 1;
  console.log(`  run ${i}: toolCalls=${toolUses.length} [${toolUses.map((t) => t.split('__').at(-1)).join(',') || '-'}] | narrated=${isNarration} | reply="${text.replace(/\s+/g, ' ').slice(0, 90)}"`);
}

console.log('─────────────────────────────────────────');
console.log(`RUNS=${RUNS} | made real tool calls: ${called} | NARRATED (the bug): ${narrated}`);
if (narrated > 0) { console.error(`\n✗ FAIL — ${narrated}/${RUNS} runs still narrated instead of calling tools.\n`); process.exit(1); }
console.log(`\n✓ PASS — 0 narrated runs; the brain invoked real tools.\n`);
