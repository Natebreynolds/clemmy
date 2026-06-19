/**
 * Phase 1.2 (measure-first) — JIT tool-selection ACCURACY + RECALL harness.
 *
 * The Phase-1.1 safety guarantee is mechanical (MANDATED tools never drop, unit-tested).
 * What's UNvalidated is the SEMANTIC quality on the JIT-able set: when CLEMMY_TOOL_JIT is
 * on, does the conditional tool an intent needs (workflow_create for "make a workflow",
 * task_add for "add a task"…) actually survive the top-K? This harness measures it against
 * a labeled corpus, so CLEMMY_TOOL_JIT_TOPK / _MIN_SCORE can be tuned from DATA and the
 * mid-run-acquisition decision is evidence-based — NOT guessed.
 *
 * Requires real embeddings (OPENAI key / embeddings enabled). Offline it reports the
 * graceful fallback (full surface, 0% reduction) with a clear banner — still a valid run,
 * just not an accuracy measurement. Informational; never a CI gate.
 *
 * Run: npx tsx scripts/measure-tool-jit-accuracy.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-jit-acc-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');
process.env.CLEMMY_TOOL_JIT = 'on';

const { buildOrchestratorAgent } = await import('../src/agents/orchestrator.js');
const { selectToolsForTurn, TOOL_JIT_CORE } = await import('../src/agents/tool-jit.js');
const { isEmbeddingsEnabled, embedQuery, embedTexts, cosine } = await import('../src/memory/embeddings.js');

// Labeled corpus: a representative user message → the JIT-able (non-CORE) built-in tools
// that message should be able to call. CORE tools are always present, so they're not the
// thing under test. Keep `expect` to tools that are genuinely JIT-able + needed.
const INTENTS: Array<{ msg: string; expect: string[] }> = [
  { msg: 'create a workflow that emails me a daily standup at 8am', expect: ['workflow_create'] },
  { msg: 'update my prospecting workflow to run weekly instead of daily', expect: ['workflow_update'] },
  { msg: 'schedule my SEO audit workflow to run every Monday morning', expect: ['workflow_schedule'] },
  { msg: 'run my morning briefing workflow now', expect: ['workflow_run'] },
  { msg: 'build me a space to track my Q2 deals as a kanban board', expect: ['space_save'] },
  { msg: 'add a task to follow up with Acme Corp next Tuesday', expect: ['task_add'] },
  { msg: 'mark the Acme follow-up task as done', expect: ['task_update'] },
  { msg: 'set a goal to book 50 product demos this quarter', expect: ['goal_update'] },
  { msg: 'what background tasks are still running right now?', expect: ['background_tasks_recent', 'background_task_status'] },
  { msg: 'show me my recent agent runs and how they went', expect: ['agent_runs_recent'] },
  // browser_harness_* moved to CORE after this corpus measured them at noise-level
  // cosine (0.155/0.19) — kept here as a coverage check (now satisfied via CORE).
  { msg: 'log into my LinkedIn and pull my recent connection requests', expect: ['browser_harness_status', 'browser_harness_run'] },
  { msg: "what's the git status of this repo and any uncommitted changes?", expect: ['git_status'] },
  { msg: 'update my profile timezone to US Pacific', expect: ['user_profile_update'] },
  { msg: 'list all my workspaces', expect: ['workspace_list'] },
  { msg: 'pin this as a standing instruction: always CC my assistant on client emails', expect: ['memory_pin'] },
  // Negative controls: pure read/converse — should JIT-drop heavily, expect NO JIT tool.
  { msg: "what's the weather like today?", expect: [] },
  { msg: 'summarize the last meeting transcript you have', expect: [] },
];

const TOK = (chars: number) => Math.round(chars / 4);

const agent = await buildOrchestratorAgent({});
const tools = ((agent as unknown as { tools: Array<{ name?: string; description?: string }> }).tools ?? []).map((t) => ({
  name: t.name ?? '',
  description: typeof t.description === 'string' ? t.description : '',
}));
const jitableCount = tools.filter((t) => !TOOL_JIT_CORE.has(t.name)).length;

const embeddingsOn = isEmbeddingsEnabled();
console.log('\n══════════════════════════════════════════════════════════════');
console.log('  PHASE 1.2 — JIT tool-selection ACCURACY + RECALL');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  surface: ${tools.length} tools (${jitableCount} JIT-able) · TOPK=${process.env.CLEMMY_TOOL_JIT_TOPK ?? '16(default)'} MIN_SCORE=${process.env.CLEMMY_TOOL_JIT_MIN_SCORE ?? '0.25(default)'}`);
if (!embeddingsOn) {
  console.log('\n  ⚠️  EMBEDDINGS UNAVAILABLE in this environment — selectToolsForTurn will fall');
  console.log('     back to the FULL surface (no reduction). This run validates the harness but');
  console.log('     NOT semantic accuracy. Re-run on a box with embeddings configured.\n');
}

let recallNum = 0;
let recallDen = 0;
let reductionSum = 0;
let reductionRuns = 0;
const misses: Array<{ msg: string; tool: string; score: number | null }> = [];
const hitScores: Array<{ tool: string; score: number | null; hit: boolean }> = [];
let negControlClean = 0;
let negControlTotal = 0;

// Pre-embed the query+tools once per intent for the diagnostic cosine (misses only).
async function scoreOf(query: string, toolName: string): Promise<number | null> {
  if (!embeddingsOn) return null;
  const t = tools.find((x) => x.name === toolName);
  if (!t) return null;
  const [qv, tv] = await Promise.all([embedQuery(query), embedTexts([`${t.name}\n${t.description}`])]);
  if (!qv || !tv || !tv[0]) return null;
  return Math.round(cosine(qv, tv[0]) * 1000) / 1000;
}

for (const intent of INTENTS) {
  const sel = await selectToolsForTurn({ userInput: intent.msg, tools });
  const droppedJit = jitableCount - [...sel.exposed].filter((n) => !TOOL_JIT_CORE.has(n)).length;
  reductionSum += jitableCount > 0 ? droppedJit / jitableCount : 0;
  reductionRuns += 1;

  if (intent.expect.length === 0) {
    negControlTotal += 1;
    // a "clean" negative control retrieved 0–2 JIT tools (didn't balloon back to full)
    const retrievedJit = jitableCount - droppedJit;
    if (retrievedJit <= 3) negControlClean += 1;
    console.log(`  [neg] "${intent.msg.slice(0, 52)}" → retrieved ${retrievedJit} JIT tools, dropped ${droppedJit}`);
    continue;
  }

  // recall over expected tools that ACTUALLY exist on the surface
  const present = intent.expect.filter((t) => tools.some((x) => x.name === t));
  const hit = present.filter((t) => sel.exposed.has(t));
  recallNum += hit.length;
  recallDen += present.length;
  const missed = present.filter((t) => !sel.exposed.has(t));
  for (const m of missed) misses.push({ msg: intent.msg, tool: m, score: await scoreOf(intent.msg, m) });
  // record the score of EVERY expected tool (hit or miss) for the distribution
  for (const t of present) hitScores.push({ tool: t, score: await scoreOf(intent.msg, t), hit: hit.includes(t) });
  const mark = missed.length === 0 ? '✅' : '❌';
  console.log(`  ${mark} "${intent.msg.slice(0, 52)}" → hit [${hit.join(', ')}]${missed.length ? ` MISS [${missed.join(', ')}]` : ''}`);
}

console.log('\n══════════════════════════════════════════════════════════════');
const recallPct = recallDen > 0 ? Math.round((recallNum / recallDen) * 100) : 0;
const avgReduction = reductionRuns > 0 ? Math.round((reductionSum / reductionRuns) * 100) : 0;
console.log(`  RECALL (expected JIT tool survived): ${recallNum}/${recallDen} = ${recallPct}%`);
console.log(`  AVG JIT-able reduction per turn:     ${avgReduction}%  (~${TOK(Math.round((avgReduction / 100) * tools.filter((t) => !TOOL_JIT_CORE.has(t.name)).reduce((s, t) => s + JSON.stringify(t).length, 0)))} tok proxy)`);
console.log(`  NEGATIVE controls clean (≤3 JIT):    ${negControlClean}/${negControlTotal}`);
if (misses.length > 0) {
  console.log('\n  MISSES (tune MIN_SCORE/TOPK from these cosines):');
  for (const m of misses) console.log(`    ${m.tool.padEnd(24)} score=${m.score ?? 'n/a'}  ← "${m.msg.slice(0, 44)}"`);
}
if (embeddingsOn && hitScores.length > 0) {
  const withScore = hitScores.filter((h) => h.score != null) as Array<{ tool: string; score: number; hit: boolean }>;
  const hits = withScore.filter((h) => h.hit).map((h) => h.score).sort((a, b) => a - b);
  const missed = withScore.filter((h) => !h.hit).map((h) => h.score).sort((a, b) => a - b);
  console.log('\n  EXPECTED-TOOL SCORE DISTRIBUTION (pick MIN_SCORE between the miss and hit bands):');
  console.log(`    hits   (n=${hits.length}): min=${hits[0] ?? 'n/a'}  median=${hits[Math.floor(hits.length / 2)] ?? 'n/a'}  max=${hits[hits.length - 1] ?? 'n/a'}`);
  console.log(`    missed (n=${missed.length}): ${missed.length ? missed.join(', ') : '(none)'}`);
}
if (embeddingsOn) {
  const verdict = recallPct >= 90 ? '✅ recall ≥90%' : '⚠️ recall <90% — raise TOPK or lower MIN_SCORE, or improve descriptions / move misses to CORE';
  console.log(`\n  VERDICT: ${verdict}`);
}

rmSync(TMP_HOME, { recursive: true, force: true });
