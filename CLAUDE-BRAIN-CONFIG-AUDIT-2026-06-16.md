# Claude Brain Configuration Audit — why Claude struggles vs Codex

**Date:** 2026-06-16
**Branch:** feat/background-tasks-board
**Scope:** Why switching the brain from Codex (gpt-5.x) to Claude (`AUTH_MODE=claude_oauth`) degrades the harness, especially after the recent consolidation/cleanup work.

## TL;DR — the structural root cause

The harness's **reliability + quality machinery is concentrated in the Codex-native adapter** (`src/runtime/harness/codex-model.ts`, ~1470 LOC of hand-rolled HTTP/SSE/retry/auth). The Claude brain (`src/runtime/harness/claude-model.ts`, ~150 LOC) is a **thin passthrough** over `@ai-sdk/anthropic` via the `aisdk()` agents-extensions adapter.

Claude *does* inherit the **loop-level** resilience (stream-stall watchdog, decision-parse salvage/empty-retry, grounding/goal gates). It does **not** inherit the **model-boundary** resilience and tuning that Codex has. Every consolidation pass ("ONE system", no-flags, leanness pass tuned for gpt-5.5, the "always an output" invariant, native compaction, dynamic reasoning default-on) has steadily widened this gap, because the new capability landed Codex-side and the shared prompt/knobs were tuned around gpt-5.5's *reason-before-acting* behavior. Claude wasn't newly broken — it was **left behind**.

---

## Gap 1 — Reasoning effort is silently dropped → Claude never "thinks" (HIGH, quality)

**This is the most likely cause of "struggling."**

- `loop.ts:3022-3056` sets `agent.modelSettings.reasoning.effort` per turn (`none`/`medium`/`high`) — a **gpt-5-shaped** knob. `reasoning-effort.ts` is explicitly documented as built for "gpt-5.x reasoning models [that] think before emitting any token."
- The aisdk adapter (`node_modules/@openai/agents-extensions/dist/ai-sdk/index.js:1050-1062` and `1227-1239`) maps `toolChoice / temperature / topP / frequencyPenalty / presencePenalty / maxOutputTokens` and spreads `modelSettings.providerData` — **but has no mapping for `reasoning` / `effort`.** It is dropped on the floor.
- Anthropic extended thinking requires `providerOptions.anthropic.thinking = { type: 'enabled', budget_tokens: N }`. **Nothing in the Claude path sets it** (grep of `src` for `thinking`/`budgetTokens`/`cache_control` finds only a header-preservation test).
- **Net:** Claude (Opus) runs the *entire* agentic loop with extended thinking **disabled**, including the hard multi-step `complex` turns the harness explicitly wants at `effort:'high'`. gpt-5.5 reasons natively before each action; Claude here acts flat. The harness's single biggest per-turn quality lever is inert for Claude.

**Fix:** In `claude-model.ts` (envelope body-rewrite or a small provider wrapper), translate the effort tier → `thinking.budget_tokens` and enable it via `providerOptions.anthropic` / `modelSettings.providerData`. Suggested map: `none→disabled`, `medium→~6k`, `high→~16-24k`; ensure `max_tokens > budget_tokens`. Add the `interleaved-thinking-2025-05-14` beta (the envelope already preserves it) so thinking interleaves with tool calls.

---

## Gap 2 — No model-boundary retries → Anthropic 429/529/transport blips hard-fail the turn (HIGH, reliability)

- Codex has **3 transparent retries with exponential backoff** for SSE truncation, header/body timeout, **429 rate limit**, and empty completion (`codex-model.ts:375-425, 485-654`). Retry-safe because nothing was yielded.
- Claude: the aisdk adapter calls `this.#model.doStream(aiSdkRequest)` **directly** — no AI SDK `streamText` retry wrapper, and `createAnthropic(...)` is built with no `maxRetries`. So there are **zero automatic retries**.
- The only backstop is the loop's stream-stall **watchdog**, which fires on a *silent stall* (zero events for the window) — **not** on a thrown error. An Anthropic `429 rate_limit_error`, `529 overloaded_error` (both routine under subscription load), or a transient TLS/stream drop **throws straight to `handleRunError`** and fails the turn — exactly where Codex would ride through invisibly.

**Fix:** Wrap the Claude provider (or `makeClaudeFetch`) in a bounded transparent retry on `429/529` and pre-content transport drops, mirroring `isRetryableCodexRateLimit` / `shouldRetryTransparentCodexFailure`. Retry only before any content has been yielded.

---

## Gap 3 — No prompt caching → subscription token quota burns fast, TTFT high (HIGH, cost/throughput)

- Anthropic caches a prefix **only** when you set explicit `cache_control: {type:'ephemeral'}` breakpoints. OpenAI/Codex does automatic server-side prefix caching for free.
- `applyClaudeEnvelope` (`claude-model.ts:76-100`) injects the identity block + `max_tokens` but sets **no `cache_control`** anywhere — not on the ~40KB system prompt, not on the (large) tool-schema array. **Every turn reprocesses the full prefix uncached.**
- On a token-metered Max/Pro subscription this consumes the rate-limit budget several × faster (→ more 429s, which feeds Gap 2) and adds first-token latency.

**Fix:** In the body rewrite, add `cache_control` breakpoints on the last system block and the last tool definition (Anthropic allows up to 4). Small change, large latency + rate-limit win.

---

## Gap 4 — No 401 refresh-and-retry at the model boundary (MED, reliability)

- Codex forces exactly one refresh+retry on a marker-less 401 (`codex-model.ts:793-824`).
- Claude caches the token for 60s (`TOKEN_TTL_MS`). `loadFreshClaudeAccessToken` refreshes-if-needed, but if a request **401s mid-flight** (expiry inside the 60s window, or a one-off edge reject), there is **no refresh-and-retry** — it throws.

**Fix:** On a 401 from the Claude stream, invalidate `cachedToken`, force a refresh, retry once.

---

## Gap 5 — No model-boundary "always an output" invariant (MED, reliability)

- Codex enforces "there is always an output" — an empty completion (stop with zero content) is retried at the adapter (`44a5389`, kill-switch `CLEMMY_CODEX_RETRY_EMPTY_COMPLETION`).
- Claude relies only on the **loop-level** decision-parse salvage / empty-retry (`HARNESS_STALL_RETRY_EMPTY`, `loop.ts:1619-1645`). That covers the "unparseable/empty decision" case but re-prompts *within the same turn budget* rather than cleanly re-requesting at the model boundary. An Anthropic stop-with-no-content (overloaded soft-stop, thinking-only-no-text) is handled less robustly than for Codex.

**Fix:** Optional once Gaps 1-3 land; fold an empty-completion retry into the Gap 2 wrapper.

---

## Gap 6 — Loose timeouts vs Codex's bounded dispatcher (MED, reliability)

- Codex passes `codexDispatcher` (undici **15s headers / 30s body**) so a Cloudflare edge stall can't hang a turn (`codex-model.ts:769-775`).
- Claude's `makeClaudeFetch` is **plain `fetch`** → undici defaults (the very thing the code comments say hung Codex chat indefinitely before the dispatcher was added). Backstopped only by the loop's **75s pre-content / 300s post-content** stall watchdog — bounded, but ~5-10× looser, and a mid-stream body stall can wait up to 300s.

**Fix:** Give the Claude fetch a bounded dispatcher (e.g. 15s headers / 60s body — allow a longer legit first-token gap once thinking is enabled).

---

## Gap 7 — Native compaction is Codex-only (LOW, verify)

`isNativeCodexCompactionEnabled` / `context_management` compaction and `rewriteHistoryWithNativeCompaction` are Codex-specific. Claude falls back to the harness's own `compaction.ts`. Likely fine — worth a single long-context smoke to confirm Claude's window isn't silently overrun on long workflow runs.

---

## Suggested order of work

1. **Gap 3 (caching)** — smallest change, immediately reduces 429s + latency.
2. **Gap 1 (thinking)** — biggest quality lift; makes Claude actually reason on agentic turns.
3. **Gap 2 (429/529 retry)** — biggest reliability lift; stops routine hard-fails.
4. Gaps 4-6 — fold into the same provider wrapper.

All four can live in/around `claude-model.ts` as a focused wrapper, default-on with kill-switches, no churn to the shared loop — consistent with forward-only + no-flag-sprawl.
