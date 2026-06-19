/**
 * Phase 0a — measure the per-turn TOOL-SURFACE token cost.
 *
 * Completes the engine-over-prompt thesis check. Phase-0 already measured:
 *   - Codex rubric (ORCHESTRATOR_INSTRUCTIONS) ≈ 8,730 tokens/turn
 *   - persistent memory-context              ≈ 12,000 tokens/turn
 *   - tool surface                            = THIS script
 *
 * Builds the real orchestrator agent in a throwaway CLEMENTINE_HOME and serializes
 * its built-in tool surface to the exact wire shape the model sees on every turn
 * ({type:'function', name, description, parameters JSON-schema, strict}). MCP tools
 * resolve separately via `mcpServers` (per-scope, ≤8/family); the built-in surface
 * is the always-present cost and the dominant, measurable one. We bound the MCP
 * add-on analytically at the end.
 *
 * Token estimate uses the SAME chars/4 heuristic the Phase-0 rubric/memory numbers
 * used, so the three are directly comparable.
 *
 * Run: npx tsx scripts/measure-tool-surface.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-measure-tools-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

const TOK = (chars: number) => Math.round(chars / 4);

const { buildOrchestratorAgent, ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_BEHAVIOR_NATIVE } = await import(
  '../src/agents/orchestrator.js'
);
// Single source of truth for the always-loaded CORE so this measurement and the
// runtime JIT behavior can never disagree (the alternative — a local copy — drifted).
const { TOOL_JIT_CORE } = await import('../src/agents/tool-jit.js');

const agent = await buildOrchestratorAgent({});
const tools = (agent as unknown as { tools: unknown[] }).tools ?? [];

interface ToolRow {
  name: string;
  chars: number;
  descChars: number;
  paramChars: number;
}

const rows: ToolRow[] = [];
for (const t of tools) {
  const tool = t as { name?: string; description?: string; parameters?: unknown; strict?: boolean; type?: string };
  const name = tool.name ?? '(unnamed)';
  const description = typeof tool.description === 'string' ? tool.description : '';
  // After tool() the parameters field is the JSON schema sent on the wire.
  const paramsJson = tool.parameters != null ? JSON.stringify(tool.parameters) : '';
  // The full function-tool wire object (Responses API shape).
  const wire = JSON.stringify({
    type: tool.type ?? 'function',
    name,
    description,
    parameters: tool.parameters ?? {},
    strict: tool.strict ?? false,
  });
  rows.push({ name, chars: wire.length, descChars: description.length, paramChars: paramsJson.length });
}

rows.sort((a, b) => b.chars - a.chars);

const totalChars = rows.reduce((s, r) => s + r.chars, 0);
const totalDesc = rows.reduce((s, r) => s + r.descChars, 0);
const totalParam = rows.reduce((s, r) => s + r.paramChars, 0);

// The always-load CORE is the RUNTIME set (TOOL_JIT_CORE) — imported, not re-declared,
// so this measurement matches actual JIT behavior. Everything else (workflow authoring,
// spaces, task/goal admin, profile writes, browser harness, git…) is JIT-able — retrieved
// only when the intent calls for it. This sizes the realizable Phase-1 prize: tokens
// removable from the EVERY-turn surface while the conditional tools stay reachable.
const coreRows = rows.filter((r) => TOOL_JIT_CORE.has(r.name));
const coreChars = coreRows.reduce((s, r) => s + r.chars, 0);
const jitChars = totalChars - coreChars;

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  PHASE 0a — TOOL-SURFACE TOKEN COST (per turn, built-in surface)');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  built-in tools exposed:   ${rows.length}`);
console.log(`  total wire chars:         ${totalChars.toLocaleString()}  ≈ ${TOK(totalChars).toLocaleString()} tokens`);
console.log(`    of which descriptions:  ${totalDesc.toLocaleString()} chars  ≈ ${TOK(totalDesc).toLocaleString()} tokens`);
console.log(`    of which param schemas: ${totalParam.toLocaleString()} chars  ≈ ${TOK(totalParam).toLocaleString()} tokens`);

console.log('\n  ── top 15 tools by wire size ──');
for (const r of rows.slice(0, 15)) {
  console.log(`    ${r.name.padEnd(28)} ${String(r.chars).padStart(6)} chars  ≈ ${String(TOK(r.chars)).padStart(4)} tok`);
}

console.log('\n  ── always-load CORE vs JIT-able split (the Phase-1 prize) ──');
console.log(`    core (always loaded):   ${coreChars.toLocaleString()} chars  ≈ ${TOK(coreChars).toLocaleString()} tok  (${coreRows.length} tools)`);
console.log(`    JIT-able (retrieve):    ${jitChars.toLocaleString()} chars  ≈ ${TOK(jitChars).toLocaleString()} tok  (${rows.length - coreRows.length} tools)`);
console.log(`    → up to ${Math.round((jitChars / totalChars) * 100)}% of the built-in tool surface is removable from the every-turn prompt.`);
console.log('    (CORE = the runtime TOOL_JIT_CORE mandated set; the realizable per-turn drop is');
console.log('     this minus whatever semantic retrieval adds back for the turn\'s actual intent.)');

// --- the thesis comparison -------------------------------------------------
const rubricChars = ORCHESTRATOR_INSTRUCTIONS.length;
const nativeChars = ORCHESTRATOR_BEHAVIOR_NATIVE.length;
// DOCUMENTED figure (not re-measured here): persistent memory-context per turn, from
// the Phase-0 tiered-context measurement on a representative loaded store. Order-of-
// magnitude only — it varies with how much memory the user has accrued. Treated as a
// comparison datapoint, not a precise constant.
const MEMORY_CTX_TOK = 12_000;
const CLAUDE_LEAN_TOK = 834; // MEASURED: CLAUDE_BRAIN_RUBRIC body (clem-rubric.ts), 3335 chars/4

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  THESIS CHECK — per-turn context budget (chars/4 tokens)');
console.log('══════════════════════════════════════════════════════════════');
const lines: Array<[string, number]> = [
  ['Tool surface (built-in, this run)', TOK(totalChars)],
  ['Persistent memory-context (Phase-0 baseline)', MEMORY_CTX_TOK],
  ['Codex rubric (ORCHESTRATOR_INSTRUCTIONS)', TOK(rubricChars)],
  ['Claude SDK-worker native rubric (HEAD+TAIL)', TOK(nativeChars)],
  ['Claude chat-brain lean rubric (measured)', CLAUDE_LEAN_TOK],
];
for (const [label, tok] of lines) {
  console.log(`  ${label.padEnd(46)} ${tok.toLocaleString().padStart(8)} tok`);
}
console.log('\n  HEADLINE: the TOOL SURFACE is the single biggest per-turn cost —');
console.log(`  ~${Math.round(TOK(totalChars) / TOK(rubricChars))}× the Codex rubric and ~${(TOK(totalChars) / MEMORY_CTX_TOK).toFixed(1)}× the memory context. Pruning the`);
console.log('  rubric alone (Phase 5) is the SMALLEST lever; Tool RAG (Phase 1) is the win.');
console.log('\n  CAVEATS: (1) chars/4 is conservative for JSON — the repo budgets structured');
console.log('  content at ~3.5 chars/tok, so the tool surface is likely UNDER-counted here.');
console.log('  (2) This counts the @openai/agents (Codex/headless) lane; the Claude Agent SDK');
console.log('  brain has its own tool surface — JIT currently targets the Codex lane only.');

console.log('\n  NOTE: MCP tools are NOT in this count — they resolve per-scope via');
console.log('  mcpServers (≤8 tools/keyword-family). A DataForSEO server alone holds');
console.log('  ~118 tools; an unbounded surface would dwarf everything here, which is');
console.log('  exactly why Tool RAG (Phase 1) is the #1 lever. To bound the add-on:');
console.log(`  8 MCP tools × ~600 chars/tool ≈ ${TOK(8 * 600).toLocaleString()} tok per active family.`);

rmSync(TMP_HOME, { recursive: true, force: true });
