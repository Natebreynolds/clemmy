# Single Tool Registry — design + surface map (2026-07-07)

**Mandate:** kill the "register a tool in 6–11 places" class (live incidents: run_batch, run_tool_program, workflows CRUD, memory_pin, recall_tool_result, goal_*). One declaration per tool; every surface derives. Principle: constrain EFFECTS, free METHODS; nothing reachable-in-principle may be invisible-in-practice.

## Surface map (audited 2026-07-07, agent-verified with file:line)

### Registration origins (existence per lane)
- **R1** `src/tools/mcp-server.ts:130-190` — register calls for the Claude Agent SDK child MCP. Missing → invisible to Claude brain/worker.
- **R2** `src/tools/local-runtime-tools.ts:117-166` — same register calls against a fake server → `getCoreTools()` (`src/tools/registry.ts:23-31`). Missing → unresolvable on Codex/GLM lane.
- R1/R2 have DRIFTED (browser-harness/step-result only in R2; gated-mutating/run_tool_program only in R1).

### Advertise/allowlist surfaces
- **A1** `src/tools/catalog.ts` `LOCAL_MCP_TOOL_NAMES` — CLI/architect allowlist.
- **A2** `src/agents/orchestrator.ts:1160-1414` curated `discoveryTools` + `byName` (deduped 1417-1423) — the live-chat surface. Biggest repeat offender (4+ logged incidents).
- **A3** `orchestrator.ts:1491-1498` structural `assembledTools` (planner/approval/ask/offer/run_worker) — bypass JIT.
- **A4** `src/runtime/harness/claude-agent-sdk.ts:218-392` — READ_ONLY(218) ⊂ LOCAL_AUTHORING(276); AGENTIC_EXECUTION(346); FULL(364, brain); WORKER(389) → `allowedTools` (396).
- **A5** `src/agents/tool-jit.ts:106-165` MANDATED/CORE(173) + intent pins (WORKSPACE 175 / BACKGROUND 191 / TEAM_AGENT 205). Pruning fires ONLY above a 24K-token surface budget (tool-jit.ts:399) — green in tests, drops in prod.
- **A6** `src/spaces/workspace-context.ts:23-27` WORKSPACE_DOCK_TOOLS (feature bundle; consumed by tool-jit:175 + claude-agent-brain:814).
- **A7** `src/tools/code-mode-tool.ts:113-128` READ_ONLY_TOOLS/WRITE_TOOLS (external `<server>__<tool>` MCP is dynamic/exempt, 160-173).

### Classification/gating
- **C1** `src/agents/tool-taxonomy.ts` ALWAYS_ADMIN(60)/NEVER_GATE_LOCAL_MEMORY(89)/ALWAYS_READ(185)/NAME_PATTERNS(307)/classifyComposioSlug(408) → decideToolApproval(546). Unmatched → 'write' → asks (conservative default — PRESERVE).
- **C2** per-family needsApproval wiring: local-runtime-tools:179, composio-tools:1136/1404, computer-tools:65. Bespoke `tool()` outside register fns defaults needsApproval:false — trap.
- **C3** `src/tools/gated-mutating-tools.ts:50-76` GATED_TOOL_SCHEMAS — hand-mirrored JSON schemas for the Claude gated lane (6 tools). Param drift → InvalidToolInputError. SEPARATE duplication axis; registry of names won't fix — needs schema single-sourcing.

### Subtractive filters (default-INCLUDE blocklists — DO NOT invert)
- **F1** `src/agents/workflow-step-agent.ts:61-96` WORKFLOW_STEP_BLOCKED_TOOL_NAMES.
- **F2** `src/agents/sub-agents.ts:105-118` workerBlockedToolNames (=F1 ∪ notify_user), lazily computed (TDZ dodge, :100-110).
- **F3** `src/runtime/harness/tool-policy.ts:93` resolveEffectiveToolPolicy — runtime filter, no registry.

### Behavioral
- **B1** `src/runtime/harness/tool-guardrail.ts:110-178` IDEMPOTENT/MUTATING/CACHE_SAFE_READS/READ_MUTATORS — a new mutating tool absent from MUTATING_TOOLS gets loose loop thresholds (runaway-write gap).

### Already dynamic (no lists — model to copy)
External MCP (`src/runtime/mcp-tool-scope.ts`), telemetry (`src/agents/tool-observability.ts`).

## Target declaration
```ts
interface ToolDecl {
  name: string;
  register: (server: McpServer) => void;   // or the tool() factory — module wiring stays explicit but ONE place
  sideEffect: 'read' | 'write' | 'send' | 'admin';
  lanes: Array<'orchestrator' | 'sdk-brain' | 'sdk-worker' | 'workflow-step' | 'code-mode' | 'cli'>;
  tier: 'core' | 'discoverable';           // core = never pruned/deferred
  needsApproval?: boolean;                  // default derives from sideEffect (write/send/admin → ask)
  featureGroup?: 'spaces-dock' | ...;       // A6-style bundles
  blockedFor?: Array<'worker' | 'workflow-step'>; // F1/F2 stay NEGATIVE properties (do not invert defaults)
}
```
Derivable (~8/14): A1, A2, A4×4 (from lanes), A5-core (tier), A7 (sideEffect+code-mode lane), C1-kind + B1 sets (sideEffect), C2 (needsApproval). NOT derived: intent-pin regex groupings (A5), C3 schemas (separate fix), R1/R2 module wiring (collapses INTO the registry file), F1/F2 semantics (kept as blockedFor).

## Refactor risks (agent-audited — bake into tests)
1. **Allowlist/blocklist inversion**: worker/step surfaces are default-INCLUDE minus blocklist. Deriving them as allowlists silently strips untagged tools. Keep F1/F2 as negative filters over the derived full set.
2. **Unknown sideEffect must stay 'ask'** (taxonomy default 'write'). Never let a missing decl field ungate.
3. **JIT budget conditionality**: tier changes pass small-surface tests and only bite in large-MCP prod → add a test that forces the >24K budget path.
4. **byName silent-swallow is a FEATURE** for flag-gated tools (spaces/code-mode off ⇒ undefined ⇒ vanish quietly). The registry must no-op, not throw, on disabled tools.
5. **TDZ/import cycle** (sub-agents ← orchestrator ← workflow-step-agent): registry must be lazily evaluated (functions, not top-level constant graphs).

## Migration order (incremental, each step shippable)
1. Introduce `src/tools/tool-registry.ts` with ToolDecl[] covering CURRENT truth (transcribe, no behavior change); add a conformance test asserting every existing list == derivation output (catches drift both ways).
2. Flip consumers one at a time to derive: catalog → SDK profiles → orchestrator discoveryTools → JIT core → code-mode sets → taxonomy/guardrail sets. Each flip deletes a hand list; conformance test shrinks with it.
3. R1/R2 register calls collapse into iterating the registry.
4. Separately: C3 schema single-sourcing (generate GATED_TOOL_SCHEMAS from the zod defs).

## Related
- Names-visible/schema-on-demand memo (deferral-designer) — see SCHEMA-ON-DEMAND-PLAN-2026-07-07.md when written.
- Memory: project_legible_engine_mandate.
