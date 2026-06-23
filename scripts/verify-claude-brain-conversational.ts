/**
 * Live, NON-disruptive verification of the Claude-brain conversational fix —
 * calls runClaudeAgentSdk directly (real Claude auth, in-process, no daemon / no
 * port / no Discord, so the installed app is untouched). Checks the two things
 * deterministic tests can't: (1) streaming actually emits text deltas (the SDK
 * partial-message shape my extractor assumes), (2) priorTurns reaches the model.
 * Run: CLEMENTINE_HOME=~/.clementine-next npx tsx scripts/verify-claude-brain-conversational.ts
 */
import { runClaudeAgentSdk } from '../src/runtime/harness/claude-agent-sdk.js';

console.log('=== 1) STREAMING — do text deltas fire? ===');
let deltas = 0;
let streamed = '';
const r1 = await runClaudeAgentSdk({
  prompt: 'Reply with exactly these five words and nothing else: ONE TWO THREE FOUR FIVE',
  onDelta: (d) => { deltas += 1; streamed += d; },
  maxTurns: 1,
});
console.log(`  deltas fired: ${deltas}`);
console.log(`  streamed text: ${JSON.stringify(streamed.slice(0, 80))}`);
console.log(`  final text:    ${JSON.stringify((r1.text || '').slice(0, 80))}`);
console.log(`  → STREAMING ${deltas > 0 ? 'WORKS ✓' : 'NOT EMITTING ✗ (extractTextDelta shape may be off)'}`);

console.log('\n=== 2) HISTORY — does priorTurns reach the model? ===');
const r2 = await runClaudeAgentSdk({
  prompt: 'What number did I ask you to remember earlier? Reply with just the number.',
  priorTurns: [
    { who: 'user', text: 'Please remember the number 42 for later.' },
    { who: 'assistant', text: 'Got it — 42.' },
  ],
  maxTurns: 1,
});
console.log(`  reply: ${JSON.stringify((r2.text || '').slice(0, 100))}`);
console.log(`  → HISTORY ${/42/.test(r2.text || '') ? 'WORKS ✓ (model used prior turns)' : 'FAIL ✗ (no history reached the model)'}`);

console.log('\n=== 3) NO-HISTORY control — bare prompt unaffected ===');
const r3 = await runClaudeAgentSdk({ prompt: 'Reply with exactly: OK', maxTurns: 1 });
console.log(`  reply: ${JSON.stringify((r3.text || '').slice(0, 40))} → ${r3.text ? 'ran ✓' : 'no output ✗'}`);
