/**
 * Measure the tiered-context win (Step 0 instrument + Step 1 proof).
 *
 * Renders the chat prompt for two DIFFERENT messages in the same session, with
 * tiered context OFF vs ON, and reports:
 *   - system-prompt (`instructions`) size off vs on,
 *   - the per-turn tail size on,
 *   - the CACHE property: are the `instructions` identical across two different
 *     messages? (ON should be — a stable prefix caches; OFF busts the cache
 *     because message-scoped facts sit in the prefix).
 *
 * Run: npx tsx scripts/measure-tiered-context.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-measure-tiered-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

const { buildAssistantInstructions, buildTurnContextBlock } = await import('../src/assistant/instructions.js');
const { rememberToolChoice } = await import('../src/memory/tool-choice-store.js');
const { rememberFact } = await import('../src/memory/facts.js');

// Seed a little learned context so the dynamic blocks aren't empty.
rememberToolChoice({ intent: 'outlook.send_email', description: 'Send an Outlook email.', choice: { kind: 'composio', identifier: 'OUTLOOK_OUTLOOK_SEND_EMAIL' } });
try { rememberFact({ kind: 'user', content: 'Nathan owns the Market Leader Salesforce accounts; "my accounts" means owner=Nathan.', importance: 8 }); } catch { /* fact shape best-effort */ }

const ctx = {
  soul: 'Clementine is a sharp, proactive executive assistant. Practical, concise, biased to action.',
  identity: 'I am Clementine — a personal executive assistant paired with one person at a time.',
  memory: '# Memory\n\n- Nathan prefers terse replies, no bullet bloat.',
  workingMemory: '# Working Memory\n\n## Focus\nProspecting CRM build.',
} as never;

const msgA = 'send an outlook email to bob about the proposal';
const msgB = 'pull my market-leader accounts with no activity in 15 days';

function sizes(label: string, tiered: boolean) {
  if (tiered) process.env.CLEMMY_TIERED_CONTEXT = 'on'; else delete process.env.CLEMMY_TIERED_CONTEXT;
  const instrA = buildAssistantInstructions(ctx, 'dashboard', 'action', msgA);
  const instrB = buildAssistantInstructions(ctx, 'dashboard', 'action', msgB);
  const tailA = buildTurnContextBlock(ctx, 'action', msgA);
  const stable = instrA === instrB;
  console.log(`\n── ${label} ──`);
  console.log(`  instructions (system prompt): ${instrA.length} chars`);
  console.log(`  per-turn tail:                ${tailA.length} chars`);
  console.log(`  total per turn:               ${instrA.length + tailA.length} chars`);
  console.log(`  instructions STABLE across two different messages? ${stable ? 'YES → caches ✅' : 'NO → cache busts every turn ❌'}`);
  return { instrLen: instrA.length, tailLen: tailA.length, stable };
}

const off = sizes('TIERED OFF (legacy)', false);
const on = sizes('TIERED ON', true);

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`System-prompt size: ${off.instrLen} → ${on.instrLen} chars  (${Math.round((1 - on.instrLen / off.instrLen) * 100)}% smaller, and now cacheable)`);
console.log(`Cache prefix stable across turns: OFF=${off.stable} → ON=${on.stable}`);
const ok = on.stable && on.instrLen < off.instrLen;
console.log(ok ? '\n✅ Tiered context: smaller + stable/cacheable system prompt.' : '\n❌ Expected smaller + stable instructions under tiered context.');
delete process.env.CLEMMY_TIERED_CONTEXT;
rmSync(TMP_HOME, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
