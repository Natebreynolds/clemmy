/**
 * LIVE measurement — does a STABLE system+tools prefix cache-hit on turns 2+ even
 * as the user message varies? This is the empirical confirmation behind flipping
 * CLEMMY_JIT_MONOTONIC default-on: the monotonic tool floor's whole value rests on
 * the SDK caching the system+tools block when (and only when) the advertised tools
 * are byte-identical across turns.
 *
 * Two regimes, same model, same stable system append, trivial VARYING user messages:
 *   A. STABLE tools (what a converged monotonic floor produces) — same allowlist every turn.
 *   B. VARYING tools (what per-turn JIT produces) — a shifting allowlist each turn.
 * Read-only, non-agentic (deny-only permission), maxTurns:1 — the model just answers;
 * we only care about the cache fields in usage. ~6 live SDK calls.
 *
 * Run: npx tsx scripts/measure-jit-cache.ts
 * Requires AUTH_MODE=claude_oauth + Claude subscription + the `claude` CLI.
 */

const { getActiveAuthMode } = await import('../src/config.js');
const { runClaudeAgentSdk, CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS } = await import(
  '../src/runtime/harness/claude-agent-sdk.js'
);

if (getActiveAuthMode() !== 'claude_oauth') {
  console.error(`\n✗ AUTH_MODE is "${getActiveAuthMode()}", not "claude_oauth". Cannot measure the subscription SDK lane.\n`);
  process.exit(2);
}

const ALL = [...CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS];
// A stable system append (identity-like), constant across every call in both regimes.
const SYS =
  'You are a terse measurement probe running inside a test harness. ' +
  'Answer every question with a single short token and nothing else.';

const QUESTIONS = [
  'Reply with the word: alpha',
  'Reply with the word: bravo',
  'Reply with the word: charlie',
];

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function cacheFields(usage: unknown): { input: number; create: number; read: number } {
  const u = (usage ?? {}) as Record<string, unknown>;
  return {
    input: num(u.input_tokens ?? (u as Record<string, unknown>).inputTokens),
    create: num(u.cache_creation_input_tokens ?? (u as Record<string, unknown>).cacheCreationInputTokens),
    read: num(u.cache_read_input_tokens ?? (u as Record<string, unknown>).cacheReadInputTokens),
  };
}

async function turn(
  sessionId: string,
  allowlist: string[],
  userMsg: string,
): Promise<{ pct: number; read: number; create: number; total: number }> {
  const r = await runClaudeAgentSdk({
    sessionId, // a real id — the local MCP surface needs CLEMENTINE_MCP_SESSION_ID
    systemAppend: SYS,
    allowedLocalMcpTools: allowlist,
    mcpToolAllowlist: allowlist, // advertise ONLY these → the tools block IS this set
    agentic: false,
    maxTurns: 1,
    maxWallClockMs: 0,
    priorTurns: [], // stateless prefix = system + tools + the one varying user message
    prompt: userMsg,
  });
  const f = cacheFields(r.usage);
  const total = f.input + f.create + f.read; // total input tokens
  const pct = total > 0 ? Math.round((f.read / total) * 100) : 0;
  return { pct, read: f.read, create: f.create, total };
}

async function runRegime(label: string, sid: string, allowlistFor: (i: number) => string[]): Promise<void> {
  console.log(`\n=== Regime ${label} ===`);
  for (let i = 0; i < QUESTIONS.length; i++) {
    const list = allowlistFor(i);
    try {
      const t = await turn(sid, list, QUESTIONS[i]);
      console.log(
        `  turn ${i + 1}: tools=${list.length}  total_input=${t.total}  cache_create=${t.create}  cache_read=${t.read}  cache_read%=${t.pct}`,
      );
    } catch (e) {
      console.log(`  turn ${i + 1}: ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

console.log('Measuring SDK prompt-cache behavior vs tool-block stability (read-only, non-agentic)…');

// Regime A: STABLE allowlist (a converged monotonic floor) — first 22 read-only tools, every turn.
const STABLE = ALL.slice(0, 22);
await runRegime('A — STABLE tools (monotonic-converged)', `mjc-stable-${process.pid}`, () => STABLE);

// Regime B: VARYING allowlist (per-turn JIT) — a window that shifts by 2 each turn.
await runRegime('B — VARYING tools (per-turn JIT)', `mjc-vary-${process.pid}`, (i) => ALL.slice(i * 2, i * 2 + 22));

console.log(
  '\nExpectation: A turns 2+ show high cache_read% (stable system+tools prefix hits);\n' +
  'B stays low (each tool change busts the prefix). A>>B ⇒ tool stability is the cache lever ⇒ monotonic JIT pays off.\n',
);
process.exit(0);
