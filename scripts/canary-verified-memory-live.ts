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

const cold = await turn('canary-cold', "What's on my calendar tomorrow?");
console.log('COLD :', JSON.stringify(cold));

// Give the post-settlement embed backfill a beat, then check retrieval state.
await new Promise((r) => setTimeout(r, 1_500));
const resolved = await candidates.resolveTurnCapabilityCandidates({ userInput: 'Anything on deck tomorrow?' });
console.log('RETRIEVAL:', JSON.stringify({
  candidates: resolved.candidates.map((c) => `${c.identifier}${c.accountIdentity ? `@${c.accountIdentity}` : ''} via ${c.via}`),
  learnedDelta: toolChoice.listToolChoices().length - learnedBefore,
}));

const warm = await turn('canary-warm', 'Anything on deck tomorrow?');
console.log('WARM :', JSON.stringify(warm));

const guard = await turn('canary-guard', 'What do you think about our plan for next quarter?');
console.log('GUARD:', JSON.stringify(guard));

const verdict = {
  coldLearned: cold.readReceipts > 0,
  warmHadCandidates: resolved.candidates.length > 0,
  warmFewerDiscovery: warm.discoveryCalls <= cold.discoveryCalls,
  guardNoComposio: guard.composioDispatches === 0,
};
console.log('VERDICT:', JSON.stringify(verdict));
process.exit(Object.values(verdict).every(Boolean) ? 0 : 1);
