# Engine-over-prompt — Phase 0 baseline (measured)

Reproduce: `npx tsx scripts/measure-tool-surface.ts` (tool surface) ·
`npx tsx scripts/measure-tiered-context.ts` (system-prompt/memory).
Token estimate = chars/4 (same heuristic across all three numbers, so comparable).

## Per-turn static context budget (before the user even speaks)

| Component | tokens/turn | source |
|---|---:|---|
| **Tool surface (built-in, 92 tools)** | **24,804** | `measure-tool-surface.ts` |
| Persistent memory-context | 12,000 | Phase-0 (tiered-context) |
| Codex rubric (`ORCHESTRATOR_INSTRUCTIONS`) | 8,730 | 34,919 chars |
| Claude SDK-worker native rubric (HEAD+TAIL) | 8,421 | `ORCHESTRATOR_BEHAVIOR_NATIVE` |
| Claude chat-brain lean rubric | ~3,000 | `CLAUDE_BRAIN_RUBRIC` |
| **TOTAL static (tools+memory+Codex rubric)** | **~45,500** | |
| MCP tools (per active keyword family, ≤8) | ~1,200/family | not in the 24.8K; resolved per-scope |

## Headline finding (refines the plan)

The **tool surface is the single biggest per-turn cost** — ~3× the Codex rubric
and ~2.1× the memory context. **Pruning the 34KB rubric (Phase 5) is the
SMALLEST lever.** Tool RAG / JIT tool loading (Phase 1) is the win.

### The Phase-1 prize (theoretical ceiling vs. the SAFE realizable split)
The *theoretical* ceiling (a minimal 21-tool core) is ~75% / ~18.5K tok. But Phase 1.1
deliberately ships a **generous, safety-first CORE** — the runtime `TOOL_JIT_CORE`
(single source of truth, imported by the measurement script): every tool the rubric
mandates every-turn or needs for cross-cutting correctness (full `focus_*`, `execution_*`,
plan tools, `memory_review_instructions`, `session_history`, `workspace_roots`,
`notify_user`, tool-choice correction, the composio escape-hatch) is CORE so it is NEVER
JIT-dropped (there is no mid-run built-in acquisition yet — Phase 1.2).

Realizable split (measured, with the safe CORE):
- CORE (always loaded, **50 tools**): **~12,113 tok**.
- JIT-able (**42 tools**, retrieved only when the user's message names the domain):
  **~12,692 tok** → **~51%** of the built-in surface is removable per turn.

The JIT-able set is exactly the CONDITIONAL, intent-evident, heavy tools — `workflow_*`
(create 2,468 / update 2,039 / schedule 799 …), `space_*` (save 1,559 …), `task_*`,
`goal_*`, `browser_harness_*`, `background_*`. A "pull 5 Salesforce accounts" turn never
needs `workflow_create`'s 2.5K-token schema, and semantic retrieval brings these back the
moment the message is about them. Param schemas (14,556 tok) outweigh descriptions
(8,161 tok) — the workflow/space authoring schemas dominate the JIT-able set.

Caveats: chars/4 is conservative for JSON (the repo budgets structured content at ~3.5
chars/tok) so the surface is likely under-counted; the 12K memory figure is a documented
Phase-0 datapoint, not re-measured here; JIT currently targets the @openai/agents (Codex)
lane only, not the Claude Agent SDK brain.

## Implication for the plan
1. **Phase 1 (Tool RAG) confirmed as #1 lever.** Phase 1.1 ships the safe split:
   42 JIT-able tools behind semantic top-K retrieval, 50-tool mandated core always
   loaded. Realizable per-turn ceiling ≈ 12.7K tok (~28% of the static budget); the
   actual drop per turn = that minus what retrieval adds back for the turn's intent.
   The remaining headroom toward the ~18.5K theoretical ceiling unlocks once Phase 1.2
   adds mid-run built-in acquisition (then more tools can leave the mandated core).
2. **JIT applies to MEMORY CONTEXT too** (12K tok, bigger than the rubric) — fold
   into Phase 1 as the plan notes.
3. **Phase 5 (rubric prune) stays LAST and surgical** — it is the smallest of the
   three levers and the highest-risk (proven Codex behavior).
