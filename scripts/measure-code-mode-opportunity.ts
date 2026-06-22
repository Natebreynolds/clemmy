/**
 * measure:code-mode — quantify the Code Mode (programmatic tool calling)
 * opportunity on REAL traffic BEFORE building it (Lane C Phase 0, measure-first).
 *
 * Code Mode collapses a multi-tool CHAIN (the same tool called many times in a
 * turn — e.g. 10 composio_execute_tool sends, or a run_worker fan-out) into ONE
 * sandboxed program that loops internally and returns a DISTILLED result. The
 * win is that every intermediate tool RESULT stops flowing into the model's
 * context. This replays the event log and projects that saving so the build is
 * justified by data, not the 37% headline alone.
 *
 * Read-only. Run: npx tsx scripts/measure-code-mode-opportunity.ts [limitSessions]
 */
import { listSessions, listEvents } from '../src/runtime/harness/eventlog.js';

// Tools whose repeated/serial use is the Code Mode target (loops + fan-out).
const CHAIN_TOOLS = new Set(['composio_execute_tool', 'run_worker']);
const CHAIN_MIN = 3;                 // ≥3 same-tool calls in a turn = a chain
const DISTILLED_RETURN_TOKENS = 150; // what a code-mode program returns instead
const tok = (s: string): number => Math.ceil((s || '').length / 4);

const limit = Math.max(1, Number(process.argv[2]) || 300);
const sessions = listSessions({ limit });

let sessionsWithChains = 0;
let totalChains = 0;
let totalIntermediateTokens = 0;
let totalProjectedSaving = 0;
const perTool = new Map<string, { chains: number; tokens: number }>();

for (const s of sessions) {
  const called = listEvents(s.id, { types: ['tool_called'] });
  const returned = listEvents(s.id, { types: ['tool_returned'] });
  const resultByCall = new Map<string, string>();
  for (const r of returned) {
    const cid = typeof r.data.callId === 'string' ? r.data.callId : '';
    if (cid) resultByCall.set(cid, typeof r.data.result === 'string' ? r.data.result : '');
  }
  // Group this session's calls by tool name.
  const byTool = new Map<string, string[]>(); // tool -> callIds
  for (const c of called) {
    const tool = typeof c.data.tool === 'string' ? c.data.tool : '';
    if (!CHAIN_TOOLS.has(tool)) continue;
    const cid = typeof c.data.callId === 'string' ? c.data.callId : c.id;
    if (!byTool.has(tool)) byTool.set(tool, []);
    byTool.get(tool)!.push(cid);
  }
  let sessionHadChain = false;
  for (const [tool, callIds] of byTool) {
    if (callIds.length < CHAIN_MIN) continue; // not a chain
    sessionHadChain = true;
    totalChains += 1;
    const intermediate = callIds.reduce((sum, cid) => sum + tok(resultByCall.get(cid) ?? ''), 0);
    totalIntermediateTokens += intermediate;
    totalProjectedSaving += Math.max(0, intermediate - DISTILLED_RETURN_TOKENS);
    const cur = perTool.get(tool) ?? { chains: 0, tokens: 0 };
    perTool.set(tool, { chains: cur.chains + 1, tokens: cur.tokens + intermediate });
  }
  if (sessionHadChain) sessionsWithChains += 1;
}

const pct = totalIntermediateTokens > 0 ? (totalProjectedSaving / totalIntermediateTokens) * 100 : 0;
console.log(`\n  Code Mode opportunity — replayed ${sessions.length} recent sessions\n`);
console.log(`  sessions with a multi-tool chain (≥${CHAIN_MIN} same-tool calls): ${sessionsWithChains}`);
console.log(`  total chains: ${totalChains}`);
console.log(`  intermediate result tokens that flowed into context: ${totalIntermediateTokens.toLocaleString()}`);
console.log(`  projected tokens saved by code-mode (distilled return): ${totalProjectedSaving.toLocaleString()}  (~${pct.toFixed(1)}% of chain intermediate tokens)\n`);
for (const [tool, v] of [...perTool.entries()].sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(`  ${tool.padEnd(24)} ${String(v.chains).padStart(4)} chains   ${v.tokens.toLocaleString().padStart(10)} intermediate tokens`);
}
if (totalChains === 0) {
  console.log('  (no multi-tool chains in the sampled window — the opportunity is usage-dependent; re-run after heavier multi-tool sessions.)');
}
console.log('');
