# Clementine Harness — Loop Architecture Gap Analysis & Roadmap
*2026-06-29 · scope: chat (desktop dock), Slack, Discord, workflows · constraints: premium/trusted reliability on ANY model · no token-burn*

## TL;DR — there is ONE root cause behind almost every failure today: **the FORK**

The interactive chat surfaces (**desktop `/api/harness/chat`, Discord, Slack**) run on a *separate engine* — the **Claude Agent SDK lane** (`claude-agent-brain.ts`) — that **bypasses the unified harness loop's safety machinery**. Every other surface (webhook, cron, background, CLI, workflow, dashboard, desktop `/chat/stream`) routes through `respondPreferHarness` (`respond-bridge.ts:395`) and gets fallover + bounding for free. The most-used, most-visible surfaces are the *least* protected.

The Claude SDK lane is **load-bearing** — it exists so Claude-subscription users run on their own billing, not an API key (`claude-agent-brain.ts:218`). The fix is **not** to delete it; it's to **route into it through the unified path** and give it parity.

Today's incidents are all symptoms of this one fork:
| Symptom today | Underlying gap |
|---|---|
| "Didn't finish" on a parse error | parse-failure falls over **nowhere**; chat lanes bypass the only fallover |
| 33-shell-call thrash, looked frozen | SDK lane has **no per-turn tool-call ceiling**; guardrail is warn-only |
| Double-sent 3 emails | thrash + no action-visibility (**patched today** v0.12.40) + duplicate speed-bump (**patched today** v0.12.39) |
| Re-ran a stale send | brain blind to its own completed actions (**patched today**) |
| Relearned `Market_Leader__c` via shell | knowledge starvation — Claude-lane recall weaker than main loop |
| "Apify connection issue" fabrication | error masking (**patched today** v0.12.34) |

---

## The gaps, by failure class (with file:line)

### 1. Fallover — *the reliability gap*
- **Parse-failure ("tool call could not be parsed (retry also failed)") falls over NOWHERE.** Three classifiers all reject it: `resilient-model.ts:104` (→ `runtime.unknown`), `loop.ts:4595` (`TRANSIENT_FALLOVER_KINDS`), `transient-error.ts` (no `parse` token). So even the lanes that *have* fallover (Codex loop, workflow steps) can't recover from the exact error that killed your turn.
- **The 3 interactive chat surfaces bypass the only chat fallover.** `console-routes.ts:8541`, `discord-harness.ts:2122` (Slack inherits) call `respondViaClaudeAgentSdkBrain` directly; the bridge's overload-only fallover (`respond-bridge.ts:431`) never runs there.
- **6 same-model re-runs instead of 1 cross-brain switch** (`claude-agent-sdk.ts` overload×2; `claude-agent-brain.ts` salvage, narration, reasoning-leak, judge-continue). This is *both* a reliability miss (re-running the same broken model) *and* the #1 avoidable token cost.

### 2. Bounding — *the thrash / token gap*
- **The Claude SDK lane is bounded by ONLY `maxTurns=24`** (`claude-agent-brain.ts:229`). No per-turn `ToolCallsCounter` (it's reset to **1000 every call** — `gated-mutating-tools.ts:106`, `mcp-server.ts:66`), no wall-clock, no token-budget, no stall watchdog — all of those live in `loop.ts`, which this lane never enters.
- **The runaway guardrail is warn-only by default and only hard-stops *identical-args* loops.** `CLEMMY_TOOL_GUARDRAIL=warn` default (`tool-guardrail.ts:358`, *"never throws"*); `same_mut_tool_repeat` (distinct args — the normal shape of a real thrash) has its `halt` **demoted to warn** (`:742-744`). 33 *different* commands → ~30 warns, never stopped.
- **Even an escalate doesn't cleanly stop the SDK loop** — it's caught as one failed tool result (`gated-mutating-tools.ts:150`) and the model continues. `maxTurns` returns *gracefully* ("say continue"), inviting resumption of the thrash.

### 3. Surface parity — *the trust-everywhere gap*
- Parity matrix (from the audit): cron/background/workflow/CLI/webhook/dashboard/desktop-stream = **full parity**; desktop `/api/harness/chat`, Discord, Slack = **missing fallover** when Claude is the brain.
- **Claude-lane query recall is weaker** — FTS-only `searchFactsByText` (`harness-context.ts:335`) vs the main loop's hybrid semantic+FTS+vault `buildTurnMemoryPrimer` (`loop.ts:1136`). A silent quality divergence (knowledge starvation).
- **Two desktop chat endpoints** (`/chat/stream` converged, `/api/harness/chat` not) — a maintenance hazard.

### 4. Token efficiency — *the cost gap (aligns with reliability, doesn't fight it)*
Ranked sinks (token-efficiency audit):
- **#1 — The prompt-cache machinery is built but UNWIRED on the live path.** `applyClaudeCaching` / `CACHE_BREAK_SENTINEL` (`claude-model.ts:228-280`) only runs under `CLEMMY_CLAUDE_TRANSPORT=raw_messages` — a *diagnostic/rollback* path. The two live Claude paths (headless `claude -p`, and the Agent SDK brain) never apply it. Worse, `renderHarnessMemoryContext` **leads with volatile fields** (`Now` timestamp — changes every minute, current-focus `last_touched_at`, query recall) and is appended *after* the cacheable `claude_code` preset (`claude-agent-sdk.ts:653-658`), so the cached system prefix is **invalidated and re-billed every turn**: ~**5–15K input tokens/turn** that should cost ≈0. At ~10 turns/session = **50–150K wasted tokens per session.**
- **#2 — Retries compound MULTIPLICATIVELY.** Lane A (SDK brain): initial + salvage + narration + reasoning-leak + judge-continue = 5 full-context `query()`s, each ×3 overload retry → **~15× full-context calls worst case**, each itself up to 24 internal turns. Lane B (Claude-as-Model): `resilient ×4 × fallback ×3 brains` = ~12 full-context calls. **Blind** re-sends (an overload re-sent unchanged tends to overload again).
- **#3 — Thrash tool-output re-entry.** Each tool output rides along every later turn until compaction; Layer-1 trims only at **30% of a 200K budget** (`compaction.ts:50`) → up to ~60K of stale output accumulates first.
- **#4 — Per-turn double-embed** of the identical input (`loop.ts:3311` vs `3312`), `embedQuery` has no cache (`embeddings.ts:414`) — latency + API waste.
- **#5 — Objective-judge continuations**: the judge is cheap, but a NOT-DONE verdict injects up to **3 full brain re-runs** (`loop.ts:1446`).
- **Uncapped context:** whole vault files (SOUL/IDENTITY/MEMORY/working-memory) and the skills index are injected untruncated every turn (`harness-context.ts:265,309`).

**Leave alone — justified "premium" reliability spend:** the three cheap, cross-family, deterministic-pre-passed, fail-open pre-write gates (grounding/goal-fidelity/output-grounding); `verify-delivered` (suspicious-only); cross-family judging; fusion-debate (correctly OFF by default). These are exactly what separates a trusted harness from a token-burner — they're conditional and cheap-tier. **Do not cut them.**

---

## Roadmap — prioritized by (reliability lift × token saving) / risk

### Phase 1 — Unify the fork (closes the most gaps, lowest risk, near-drop-in)
1. **Route the 3 direct chat callers through `respondPreferHarness`** (`console-routes.ts:8541`, `discord-harness.ts:2122`, Slack-via-Discord). Instantly gives desktop+Discord+Slack the bridge's fallover + uniform dispatch. *Verify the brain stays the sole terminal-event emitter (no double `conversation_completed`).*
2. **One failure taxonomy, one classifier** (extend `transient-error.ts`, shared by both lanes): `overload | rate_limited | transport_timeout | empty_completion | parse_failure | deterministic`. **Add `parse_failure` as fallover-eligible.** Delete the `TRANSIENT_FALLOVER_KINDS` vs `isTransientStepError` divergence.
3. **One recovery spine** (all lanes): deterministic → fail fast; a write already committed → **salvage, never re-dispatch** (use the `external_write` guard at `loop.ts:1499` / `workflow-runner.ts:2002`); else → **switch brain ONCE** (`falloverBrainModelIds`, Codex→Claude→BYO); only if no other brain → a single same-model retry. **Collapse the 6 same-model retries into ≤2 bounded continuations.**
→ Result: parse-failure becomes a one-switch recovery; chat reaches desktop parity; a failing turn costs ~1–2 cross-brain runs instead of ~6 same-model re-runs.

### Phase 2 — Bound the SDK lane (stops thrash, saves the most tokens)
4. **Per-turn tool-call ceiling on the SDK lane** — replace the per-call `ToolCallsCounter(1000)` with a session-scoped counter that **throws** at a generous ceiling (~40–60 mutating calls); reads uncounted/higher. This alone would have stopped today's 33-call thrash.
5. **Make distinct-args runaway terminal at a high count even in `warn` mode** (`tool-guardrail.ts:617`) and exempt it from the `halt→warn` demotion — converts the silent warn-spam into a real stop while keeping a long advisory window.
6. **Make the stop interrupt the SDK turn** — drive `canUseTool → { behavior:'deny', interrupt:true }` (`claude-agent-sdk.ts:315`) on a terminal guardrail decision; surface "I stopped myself — N calls without progress."
7. **Wall-clock backstop on the SDK lane** — thread `maxWallClockMs` into `runClaudeAgentSdk` and break the stream loop, returning the existing graceful `limitHit` shape.

### Phase 3 — Token efficiency (the biggest *cost* win — pairs with Phase 1's reliability win)
8. **Wire prompt-caching on the live Claude paths (#1 sink — largest single win).** Split `renderHarnessMemoryContext` into a **stable half** (identity/soul/skills index/persistent facts/profile — cached once) and a **tiny volatile tail** (`Now`/focus/query-recall — sent uncached in the *user* turn, not the system block). On the Agent SDK lane, pass the stable half so the SDK caches it (`claude-agent-sdk.ts:653`). *Est: 40–80% of per-turn input cost on Claude lanes once warm.*
9. **Bound the context block** — cap the skills index; replace whole-vault-file injection with a pointer/summary + on-demand `memory_read` (`harness-context.ts:265,309`). *Est: 2–8K tokens/turn.*
10. **Dedupe the per-turn embed** (`loop.ts:3311`↔`3312`) — share one `embedQuery` result or add a short TTL cache (`embeddings.ts:414`).
11. **Bound objective-judge continuations 3→1** (`loop.ts:1446`) — keep the cheap judge, drop the up-to-3 full-brain re-runs.
12. **Tighten thrash carry** — lower the compaction Layer-1 trigger / eagerly clip large tool outputs via `recall_tool_result` indirection.

### Phase 4 — Parity polish
13. **Lift Claude-lane recall to the main loop's hybrid retrieval** (shared helper from `buildTurnMemoryPrimer`) — closes knowledge starvation.
14. **Collapse the duplicate desktop endpoints** to one bridge call.

### Already shipped today (the point-fixes that prove the classes)
v0.12.34 brain-switch + error unmask · v0.12.37 salvage · v0.12.38 never-starve tools · v0.12.39 query-recall + duplicate hard-wall · v0.12.40 action-visibility.

---

## The two constraints are NOT in tension
- **Trusted on any model:** Phase 1's one-switch fallover means *no single model's stumble (parse-fail, overload, stall) ends a turn* — Codex covers Claude, Claude covers Codex, BYO covers both. That's the "premium, trusted" property, uniformly across all four surfaces.
- **No token-burn:** the same changes *cut* tokens — one cross-brain switch replaces 6 blind re-runs; a hard ceiling kills the 24+-re-prompt thrash; prompt-caching stops re-billing the stable context. Reliability and efficiency point the same direction because the waste *is* the unreliability (blind retries, thrash).

**Recommended first move:** Phase 1.1 (route the 3 callers through the bridge) + 1.2/1.3 (parse-failure → one-switch spine). Smallest diff, closes the headline gap, and is the difference between "any model failing renders Clem useless" and "Clem transparently rides through it."
