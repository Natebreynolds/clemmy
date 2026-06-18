# Role-Based Multi-Model System — Design + Phase Plan

Goal (2026-06-17): evolve fusion into a flexible, role-based multi-model system. Most users
have Codex + Claude; some add MiniMax/DeepSeek/etc. A **Models UI** = log in to what you have →
pick **brain / workers / judge**. From chat: durable NL routing ("use Claude for design",
"always DeepSeek for X"). See **who's doing what and why**. NEVER rigid (every user routes by
their own categories/words). SIMPLIFY — delete more than we add.

## North star
One canonical `resolveRoleModel(role, intent?)` read point collapsing ~9 scattered model
selectors into one, persisted through the EXISTING env+vault+cache-bust substrate. No new
storage engine, no prompt rule, no rules engine, no rollout sprawl.

## The model (verified against live code)
- **Roles fixed (enum): `brain | worker | judge`.** debate `draftA` stays the flagship, NOT a
  registry role. Intents are the USER'S OWN free-form slugs (reuse `slugifyIntent` +
  `jaccardOverlap` from tool-choice-store.ts) — never a hardcoded design/content/execution enum.
- **Defaults are provider-DERIVED** (no literal claude-* table): a Codex-only user resolves
  all-Codex with `source:'default'`, byte-identical, no "wanted Claude but logged out" flag.
- **Persistence:** one env key `CLEMMY_MODEL_ROLES` (JSON `RoleBinding[]`) via existing
  `updateEnvKey` + cache-bust trio (`resetHarnessRuntimeConfig`/`resetClaudeModelCache`/
  `resetByoModelCache`/`clearAutonomyAgentCache`). `MODEL_ROUTING_MODE` (boot gate) and
  `CLEMMY_DEBATE_MODE` (explicit fusion toggle) STAY. `configureHarnessRuntime`'s ~60-line
  auth/fail-closed safety tree STAYS (only the model id each branch selects comes from the registry).

## Simplification ledger (net concepts DOWN)
DELETE/FOLD: `CLAUDE_MODEL`, `CLEMMY_DEBATE_CHECKER_MODEL`, `CLEMMY_DEBATE_JUDGE`,
`OPENAI_MODEL_WORKER` → fold into `CLEMMY_MODEL_ROLES` (~4 knobs → 1). 4 settings forms → 1
panel. 4 routes (`models`/`model-backend`-routing/`active-brain`/`fusion`-judge) → 1
`PATCH .../models/roles` (+1 GET). 4+ selectors → 1 `resolveRoleModel`. Dead `options.model` revived.
ADD: `model-roles.ts`, `resolveProvider` in model-wire-registry, 1 env key, 2 routes, 1 panel.
NOT built: agents-list registry, 8-dropdown wall, keyword/length router, model_routing_decision
eventlog, model_choice_remember tools, worker-intent classifier, drafter role, implied-fusion.

## Phases
- **Phase 1 — registry unification (PURE refactor, kill-switch `CLEMMY_MODEL_ROLES_REGISTRY`).
  SHIPPED `edb7b09`.** `model-roles.ts` (resolveRoleModel delegates to legacy getters →
  byte-identical) + `resolveProvider` + golden tests; repointed WORKER (sub-agents) + JUDGE
  (debate resolveDebateBrains). judgeChoice moved to config (cycle-free). Suite 2803/0.
  REMAINING in P1: the BRAIN repoint (provider-construction sensitive — configureHarnessRuntime
  brain id + agent model strings) — deliberate next slice.
- **Phase 2 — role-picker data path.** Enable writing `CLEMMY_MODEL_ROLES` (durable, role-wide)
  via `PATCH /api/console/settings/models/roles` + cache-bust. Tests: PATCH worker→deepseek flips
  resolveRoleModel without restart.
- **Phase 3 — Models panel.** `<ModelsPanel/>` (Section A providers+login lift; Section B
  brain/worker/judge pickers populated from connected providers + free-text intent-override
  rows). `GET /api/console/settings/models`. Retire 4 forms. "Who's doing what" = existing
  `byModel` Usage widget. Fusion stays its own explicit toggle.
- **Phase 4 — chat-driven routing.** NL → durable/session bindings with FREE-FORM `whenIntent`
  (slugify+fuzzy, reuse tool-choice-store). Kill-switch `CLEMMY_CHAT_MODEL_ROUTING`. No new tool
  surface — Clem calls the same PATCH the UI uses.
- Post-P4: delete legacy env readers + old forms (one-release coexistence window).

## Open decisions (for the user)
1. Worker per-intent routing — v1 ships worker as role→model (no per-intent; worker dispatch has
   no intent in scope). Build the classifier now or defer? (rec: defer)
2. Fusion explicit toggle vs implied-when-providers-differ. (rec: explicit)
3. Observability depth — v1 = Usage byModel + `source` badge; forensic per-call "why" = one-event
   add later. (rec: minimal now)
4. Env-key consolidation timing — 4 legacy keys stay readable one release then deleted. (rec: OK)
