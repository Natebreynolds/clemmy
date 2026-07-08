# Schema-on-demand for the Codex lane — Decision memo (2026-07-07, agent-audited)

**Decision: Design C (hybrid).** First-class schemas = structural CORE + hot-set (TOOL_JIT_MANDATED ∪ tool_choice_recall pins ∪ session LRU, ~25-30 tools ≈ 6K tokens). Everything else: name+one-liner catalog (registry-generated), reachable THIS turn via `tool_search(query)` (names+one-liners+full schema for top hits) + `call_tool(name, args_json)` (generic gated dispatch reusing dispatchBatchItemTool). Hits promote to first-class next turn.

**Grounding (measured):** orchestrator lane carries ~124 curated built-in names (~115 unique) + 5 structural ≈ ~18K tokens/turn at ~150 tok/schema. JIT pruning effectively NEVER fires for built-ins (24K budget never reached — tool-jit.ts:261-264, :399). Codex lane has NO external-MCP schema deferral (scoping attaches full schemas via listTools; the @anthropic lane's alwaysLoad:false has no codex equivalent). Net savings Phases 1-2: **~12-14K tokens/turn (~65-70%)**; Phase 3 (external MCP parity) reclaims more.

**Safety mechanics (verified):**
- Gates key from classifyExternalWrite(tool.name) INSIDE wrapToolForHarness (brackets.ts:1239-1281). dispatchBatchItemTool wraps the REAL inner tool → keying correct by construction. RULE: never bracket-wrap `call_tool` itself.
- `call_tool` must consult resolveEffectiveToolPolicy (same authority as first-class assembly) so generic dispatch can't escalate.
- Arg errors: call_tool Zod-validates BEFORE dispatch; on failure returns {error:'arg_validation', schema, detail} with ZERO side effects — one round-trip self-correction. tool_search returns full schema for top hits so deliberate cold calls are right first try.
- run_worker/run_batch/run_tool_program stay first-class structural → batch-shape directive unaffected.
- TOOL_JIT_MANDATED becomes the hot-set SEED (keep set + CI test); retire semantic top-K/24K-budget pruning on this lane.
- Reachability invariant test: every registered, policy-allowed tool appears in the catalog (kills the run_batch-invisible class structurally).

**Files:** new src/agents/tool-catalog.ts (buildToolCatalog + resolveHotSet), src/tools/tool-search-tool.ts, src/tools/call-tool.ts (reuse dispatchBatchItemTool), src/agents/tool-hotset.ts (session LRU); orchestrator.ts surface assembly behind CLEMMY_CODEX_TOOL_SEARCH (catalog via turnContext to keep system prefix cacheable); tool-jit.ts MANDATED→seed; telemetry: genericDispatch:true tag + tool_search_scope event; trace drawer attributes inner names.

**Tests:** reachability invariant; gate parity (write via call_tool fires identical battery); guardrail keying (shapeKey/fanoutKey from inner name); arg-fail returns schema w/ no side effect; kill-switch off = byte-identical curated surface; promotion (recall hit → first-class next turn); token-budget assertion.

**Rollout:** Phase 0 additive+dormant (catalog+tools shipped, everything still first-class) → Phase 1 behind CLEMMY_CODEX_TOOL_SEARCH default-off with session A/B via resolveToolJitDecision bucketing (existing analysis tooling) → Phase 2 default-on after live smoke w/ zero tool-calling regressions (mirror claudeToolSearchEnabled v1.0 precedent, =off byte-identical revert) → Phase 3 external-MCP names-visible parity.

**Depends on:** TOOL-REGISTRY-PLAN-2026-07-07.md (catalog derives from the registry). Memory: project_legible_engine_mandate.
