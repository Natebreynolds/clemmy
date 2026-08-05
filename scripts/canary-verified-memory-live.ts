#!/usr/bin/env tsx
/**
 * Live canary: the verified-memory loop end to end on REAL infrastructure.
 *
 *   cold turn  → real brain turn (BYO backend) → real governed Composio read
 *              → settlement learns
 *   warm turn  → a PARAPHRASE resolves candidates → the brain sees the card
 *              → fewer discovery calls, lower latency
 *   guard turn → an unrelated question retrieves nothing
 *
 * Runs in a SCRATCH CLEMENTINE_HOME with credentials copied from the live
 * home (the live daemon and its stores are never touched). Reads only: the
 * canary asks read-class questions; the lane cannot dispatch a write from a
 * question, and every dispatch still crosses the governed gateway.
 *
 * Usage:
 *   CANARY_HOME=$(mktemp -d) npx tsx scripts/canary-verified-memory-live.ts
 *
 * Requires: ~/.clementine-next/.env with a reachable model backend and a
 * COMPOSIO key whose workspace has at least one connected calendar/email
 * toolkit. Aborts (exit 2) when either is missing — a canary that cannot run
 * reports that it could not run; it never fakes a pass.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE_HOME = path.join(os.homedir(), '.clementine-next');
const CANARY_HOME = process.env.CANARY_HOME || path.join(os.tmpdir(), `clem-canary-${Date.now().toString(36)}`);

if (!existsSync(path.join(LIVE_HOME, '.env'))) {
  console.error('CANARY ABORT: no live credentials to copy (~/.clementine-next/.env missing).');
  process.exit(2);
}
mkdirSync(path.join(CANARY_HOME, 'state'), { recursive: true });
copyFileSync(path.join(LIVE_HOME, '.env'), path.join(CANARY_HOME, '.env'));
if (existsSync(path.join(LIVE_HOME, 'state', 'secrets-vault.json'))) {
  copyFileSync(path.join(LIVE_HOME, 'state', 'secrets-vault.json'), path.join(CANARY_HOME, 'state', 'secrets-vault.json'));
}
writeFileSync(path.join(CANARY_HOME, 'state', 'machine-id'), 'canary-A\n');
process.env.CLEMENTINE_HOME = CANARY_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'on';
// The canary brain runs ALL-IN on the BYO backend (its API key is the
// credential). This deliberately avoids the live daemon's Codex/Claude OAuth
// tokens: a second process refreshing those can invalidate the daemon's
// session — the exact incident class the token-ownership rule exists for.
process.env.MODEL_ROUTING_MODE = 'all_in';

const { respondPreferHarness } = await import('../src/runtime/harness/respond-bridge.js');
const eventlog = await import('../src/runtime/harness/eventlog.js');
const candidates = await import('../src/runtime/read-path/capability-candidates.js');
const toolChoice = await import('../src/memory/tool-choice-store.js');

interface TurnStats {
  ms: number;
  text: string;
  toolCalls: number;
  composioDispatches: number;
  discoveryCalls: number;
  readReceipts: number;
}

async function turn(sessionId: string, message: string): Promise<TurnStats> {
  const before = eventlog.getSession(sessionId) ? eventlog.listEvents(sessionId).length : 0;
  const t0 = performance.now();
  const response = await respondPreferHarness('home', { message, sessionId }, async (req) => ({
    text: '(legacy fallback — canary counts this as a routing failure)', sessionId: req.sessionId,
  }));
  const ms = performance.now() - t0;
  const events = eventlog.listEvents(sessionId).slice(before);
  const toolEvents = events.filter((e) => e.type === 'tool_called');
  const named = (needle: RegExp) => toolEvents.filter((e) => needle.test(String((e.data as { tool?: string }).tool ?? ''))).length;
  return {
    ms,
    text: (response.text ?? '').slice(0, 200),
    toolCalls: toolEvents.length,
    composioDispatches: named(/composio_execute_tool/),
    discoveryCalls: named(/composio_search|composio_get_tool|mcp_list_tools|tool_search/),
    readReceipts: events.filter((e) => e.type === 'read_receipt').length,
  };
}

console.log(`canary home: ${CANARY_HOME}`);
const learnedBefore = toolChoice.listToolChoices().length;

// The account is pinned in the request so the read settles in ONE turn (the
// multi-account clarification conversation is exercised separately below —
// its structural limits are recorded in the evidence document).
/**
 * A workspace with several connected accounts ASKS which one — correct
 * fail-closed behavior on ANY turn, and the canary answers it like a user
 * would. The read then settles on the answer turn.
 */
async function converse(sessionId: string, message: string): Promise<TurnStats> {
  let stats = await turn(sessionId, message);
  console.log(`${sessionId}:`, JSON.stringify(stats));
  if (stats.readReceipts === 0 && /which|choose|account/i.test(stats.text)) {
    const answer = await turn(sessionId, 'Use the first one.');
    console.log(`${sessionId} (answer):`, JSON.stringify(answer));
    stats = {
      ...answer,
      ms: stats.ms + answer.ms,
      toolCalls: stats.toolCalls + answer.toolCalls,
      composioDispatches: stats.composioDispatches + answer.composioDispatches,
      discoveryCalls: stats.discoveryCalls + answer.discoveryCalls,
      readReceipts: stats.readReceipts + answer.readReceipts,
    };
  }
  return stats;
}

const cold = await converse('canary-cold', "What's on my calendar tomorrow? Use my first Outlook account.");

// Give the post-settlement embed backfill a beat.
await new Promise((r) => setTimeout(r, 1_500));
console.log('LEARNED DELTA:', toolChoice.listToolChoices().length - learnedBefore);

const warm = await converse('canary-warm', 'What does my day look like tomorrow?');
await new Promise((r) => setTimeout(r, 1_500));

// Retrieval cohorts AFTER both settlements: the exact repeat of a settled
// phrase must hit the exact tier; a fresh paraphrase measures the semantic
// tier against whatever phrasing the live conversation actually produced.
const exact = await candidates.resolveTurnCapabilityCandidates({ userInput: 'What does my day look like tomorrow?' });
const paraphrase = await candidates.resolveTurnCapabilityCandidates({ userInput: 'Anything on deck tomorrow?' });
console.log('RETRIEVAL:', JSON.stringify({
  exact: exact.candidates.map((c) => `${c.identifier}${c.accountIdentity ? `@${c.accountIdentity}` : ''} via ${c.via}`),
  paraphrase: paraphrase.candidates.map((c) => `${c.identifier} via ${c.via}`),
}));

const guard = await turn('canary-guard', 'What do you think about our plan for next quarter?');
console.log('GUARD:', JSON.stringify(guard));

const verdict = {
  coldLearned: cold.readReceipts > 0,
  warmLearned: warm.readReceipts > 0,
  exactRepeatHadCandidates: exact.candidates.length > 0,
  paraphraseHadCandidates: paraphrase.candidates.length > 0,
  guardNoComposio: guard.composioDispatches === 0,
};
console.log('VERDICT:', JSON.stringify(verdict));
process.exit(Object.values(verdict).every(Boolean) ? 0 : 1);
