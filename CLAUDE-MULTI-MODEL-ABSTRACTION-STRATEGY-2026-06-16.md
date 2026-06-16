# Multi-Model Abstraction Strategy

**Clementine · Lead-architect recommendation · 2026-06-16**
*Scope: make every brain (Codex / Claude / BYO) first-class without architecture churn. Closes audit gaps G1–G6 (see CLAUDE-BRAIN-CONFIG-AUDIT-2026-06-16.md).*
*All load-bearing claims re-verified against the **pinned installed deps** — `@openai/agents-extensions@0.11.6`, `@ai-sdk/anthropic@3.0.82` — and the authoritative `claude-api` skill, not from memory.*

---

## 1. Direct answer: how mature multi-model harnesses do it

Every production multi-model harness examined — **Hermes Agent (NousResearch)**, **pi-ai (`@earendil-works/pi-ai`)**, **LiteLLM**, the **Vercel AI SDK**, **aider / Cline / Roo Code / Continue.dev / OpenCode / Goose** — converges on the **same three-layer abstraction**. No provider is second-class because per-model behavior lives *above* the wire, not duplicated *inside* each adapter.

**Layer 1 — a data-only capability registry (one declarative entry per model).**
WHAT a model can do is data; HOW to call it is code.
- **pi-ai** ships a 453KB generated `models.generated.ts` (per-model: `api`, `reasoning`, `thinkingLevelMap`, `cost{input/output/cacheRead/cacheWrite}`, `contextWindow`, `maxTokens`, `compat`).
- **LiteLLM** uses `model_prices_and_context_window.json` (`supports_reasoning`, `supports_prompt_caching`, `cache_*_input_token_cost`, `max_input_tokens`).
- **models.dev (sst)** is the frontier shared registry (one TOML/model; `reasoning_options` as a discriminated union of `effort` / `budget_tokens` / `toggle`); **OpenCode** reads it directly, **Goose** bundles a derived snapshot, **aider** layers over LiteLLM's.

**Layer 2 — a small set of provider adapters keyed by WIRE PROTOCOL, not vendor.**
~40 vendors collapse onto ~3 adapters.
- **pi-ai**: `Api` union of ~9 shapes (`anthropic-messages`, `openai-codex-responses`, `openai-completions`, `google-generative-ai`, …); ~40 vendors (deepseek / groq / xai / minimax / together / fireworks / copilot) reuse `openai-completions` via per-model `compat` data.
- **Hermes**: the identical concept named `api_mode`, with exactly **three** native shapes — `chat_completions`, `codex_responses`, `anthropic_messages`. Adding a vendor is **a registry/plugin entry, not request-path code**. Crucially, **Anthropic is a PEER native adapter to Codex in both pi-ai (38KB `anthropic.ts`) and Hermes** — never a thin passthrough.

**Layer 3 — a unified options/resilience superset that each adapter maps or clamps (the "no-second-class" mechanism).**
Reasoning, caching, retries, timeouts, and auth are passed as **abstract options**; each adapter MAPS them into its provider's native mechanism, or clamps/ignores — a capability is **never silently dropped** for one provider.
- **pi-ai** `StreamOptions`: `cacheRetention`, `reasoning` level, `maxRetries`, `timeoutMs` → its `anthropic.ts` maps `cacheRetention → cache_control:{type:'ephemeral',ttl:'1h'}` and reasoning → extended/interleaved thinking.
- **LiteLLM** maps one `reasoning_effort` to each dialect (Anthropic effort/thinking, OpenAI passthrough, Gemini `thinking_level`), and `drop_params` strips what a model can't support per `get_supported_openai_params()`.
- **Vercel AI SDK** normalizes shared params and routes provider-specifics through a typed `providerOptions[providerId]` bag; **retries/backoff live in the `generateText`/`streamText` wrappers, not in `doGenerate`/`doStream`** — exactly the gap that makes Claude second-class in Clementine (see §2).
- **Hermes** adds a 3-layer resilience stack on top of the unified contract: credential pools → primary cross-provider fallback → auxiliary-task fallback.

**Scope correction (verified):** `hermes-agent-self-evolution` (DSPy+GEPA prompt optimizer) is a *separate* repo and is **not** the model-options layer — that lives entirely in `hermes-agent`.

---

## 2. Clementine's current state — honest diagnosis (source-verified)

Clementine has Layer 2 half-built and Layers 1 & 3 missing. The brain seam is already correct: every brain is an `@openai/agents` `Model` behind `ModelProvider.getModel(name)`, registered **once per process** via `setDefaultModelProvider(...)` in `src/runtime/harness/codex-client.ts`. The Claude registration is the **single `claude_oauth` branch** at `codex-client.ts:114→120`; the other `setDefaultModelProvider` calls (`:140/:159/:164`) register `RouterModelProvider`/`CodexModelProvider` by routing mode.

**The anti-pattern: provider-agnostic resilience is trapped Codex-side.**

| Brain | File | LOC (verified) | What it has |
|---|---|---|---|
| Codex (`openai-codex-responses`) | `src/runtime/harness/codex-model.ts` | **1467** | native HTTP+SSE, 3 transparent retries, empty-completion invariant, 401-refresh-retry, bounded undici dispatcher (15s/30s), SSE/4xx diagnostics, `reasoning.effort`+verbosity |
| Claude (`anthropic-messages`) | `src/runtime/harness/claude-model.ts` | **150** | OAuth billing-guard + Claude-Code identity envelope over `aisdk()` — and *nothing else* |
| BYO (`openai-completions`) | `src/runtime/harness/byo-model.ts` | **335** | SDK `OpenAIChatCompletionsModel`, no boundary resilience |
| Router | `src/runtime/harness/router-model.ts` | **52** | selects brain by a `gpt-5*`-vs-byo string check |

Five concerns inside `CodexResponsesModel` are about the **agent contract** ("a turn must yield content; transient blips retry"), **not** the Codex wire, yet only Codex gets them: transparent retry gated on `yieldedRealContent`; empty-completion invariant; 401 refresh-and-retry; rate-limit retry; diagnostics.

What is **genuinely Codex-wire-specific and must stay native**: `parseCodexSse`/`buildCodexRequestBody`, `serializeInput`/`serializeTools`, `buildCodexHeaders` (chatgpt-account-id JWT, originator), native compaction (`context_management`), and the `codexDispatcher` socket timeouts.

**Why Claude is second-class — confirmed from the installed source, with two earlier-audit claims corrected:**

- **G1 (reasoning dropped) — root cause CONFIRMED.** The `aisdk()` adapter maps only `toolChoice`/`temperature`/`topP`/`maxOutputTokens`/`responseFormat`, then spreads `...(request.modelSettings.providerData ?? {})` at the **top level** of the AI-SDK call options (`index.js:1062` getResponse, `:1239` getStreamedResponse). It **never reads `modelSettings.reasoning`**. Meanwhile `loop.ts:3044-3046` sets `agent.modelSettings.reasoning.effort` (the *Codex* shape). So Claude reasoning effort is provably dropped.
  - **CORRECTION (the load-bearing fix):** `providerData.providerOptions.anthropic.effort` **DOES reach the wire** — verified, not speculative. Because the adapter spreads `providerData` at top level, `providerData = { providerOptions: { anthropic: { effort } } }` lands as `aiSdkRequest.providerOptions.anthropic.effort`; `@ai-sdk/anthropic@3.0.82` parses `providerOptions.anthropic` and emits `output_config: { effort }` from `anthropicOptions.effort` (`dist/index.js:3464-3467`). It maps to **`output_config.effort`**, **not** `thinking` — so it carries no signature round-trip.
- **G3 (no caching):** `claude-model.ts:127` constructs `aisdk(getProvider()(modelId))` with no `providerOptions`/`cacheControl` — no `cache_control` breakpoints emitted. `@ai-sdk/anthropic` reads caching from `providerOptions.anthropic.cacheControl` (camelCase; snake_case also accepted) — `getCacheControl` at `dist/index.js:1122`.
- **G2 (no model-boundary retries) — CONFIRMED.** The AI SDK's own `maxRetries` lives only in `generateText`/`streamText`; the `aisdk()` adapter **bypasses them** by calling `doGenerate`/`doStream` directly (`index.js:1070`/`:1248`). 529 `overloaded_error` is retryable (skill's error table) and not specially handled.
- **G4/G5:** no 401-refresh, no empty-completion invariant on the Claude path.
- **G6 — RESTATED (earlier audit overstated it):** the adapter **already passes `abortSignal: request.signal`** into `doGenerate`/`doStream` (`index.js:1061/:1238`), so the Claude path honors the loop-level abort. What it lacks is a **socket-level** connect/headers timeout like `codexDispatcher` (15s/30s). G6 is "no socket-level dispatcher," not "no timeout at all."

**Two further source facts that reshape the design:**
- **The signature-drop trap (openai-agents-js #770) is ALREADY FIXED in the installed `@openai/agents-extensions@0.11.6`.** The adapter emits reasoning *before* tool calls and preserves the Anthropic signature via `mergeProviderData(...)`; `index.js:386` scopes provider data to the target model. So any "build reasoning-replay machinery + pin a patched adapter" plan is **stale and over-scoped — do not build it.** Residual risk is a *future* version bump regressing this — guard with a pinned characterization test, not replay code.
- **`getModel()` has no per-turn request.** `ClaudeModelProvider.getModel` returns a Model cached by `modelId` (`claude-model.ts:124-130, 141`). Writing reasoning/cache settings into `getModel` is the **wrong seam** — it runs once per modelId and can't see the turn's effort tier or which prompt blocks are stable. Per-turn injection needs a **Model decorator that mutates `request.modelSettings.providerData` inside `getResponse`/`getStreamedResponse`** (folded into the resilience wrapper — §3).

---

## 3. Recommended architecture (strategic, low-churn)

The fix is **not** a second 1400-LOC native Claude adapter — that re-introduces the N-native-adapters cost and the asymmetry it would cure. Codex earns native because it carries primary traffic and needs a streaming contract the unified adapter mistranslates. Claude/BYO stay on the SDK passthrough and get first-class behavior from **two shared layers + one translation seam**, bolted onto seams that already exist.

### (a) Model-capability registry — `src/runtime/harness/model-wire-registry.ts` (new)

Per-model-id data, the single source of truth. **Do not reuse `src/runtime/capability-registry.ts`** (547 LOC, TOOL/intent routing — a different concern). Name it `model-wire-registry.ts` to disambiguate. This is **declarative data, not a curated tool allowlist** — it satisfies the "no hardcoded tool lists / global, no curated lists" directive because per-model wire metadata is legitimately data, the same thing models.dev/LiteLLM publish.

```ts
interface ModelCapability {
  idMatch: RegExp;                      // resolve the EFFECTIVE id
  apiShape: 'codex_responses' | 'anthropic_messages' | 'openai_completions';
  contextWindow: number;
  maxOutput: number;
  supportsEffort: boolean;
  effortMap: Record<'low'|'medium'|'high'|'xhigh'|'max', string | null>; // generic tier -> wire idiom (G1)
  thinkingMode: 'adaptive_only' | 'budget_tokens' | 'none';
  supportsPromptCache: boolean;
  cacheMinTokens: number;
  retryClass: 'codex' | 'anthropic' | 'openai_compat';
  reasoningContentMode?: 'deepseek';    // BYO thinking+tool-call gate
}
```

**Seed it as a VENDORED static snapshot** (committed JSON derived from models.dev/LiteLLM, like Goose's bundled snapshot) refreshed by an **offline script** — never a runtime/build-time network fetch (keeps CI deterministic and offline-safe). Resolve the **effective** id the same way `ClaudeModelProvider.getModel` does (`isClaudeModelId(name) ? name : getClaudeBrainModel()` — `claude-model.ts:132,140`). **Fail LOUD on an unknown id** (warn + conservative defaults) — never silently trust a stale map.

**Authoritative seed values (verified against the `claude-api` skill — earlier-audit numbers were inverted):**

| Model | `cacheMinTokens` | `thinkingMode` | `effortMap` (tiers) |
|---|---|---|---|
| Opus 4.8 / 4.7 / 4.6 / 4.5, Haiku 4.5 | **4096** | adaptive_only (4.8/4.7), budget_tokens deprecated-OK (4.6/4.5) | low/medium/high/**xhigh**/max (xhigh added in 4.7) |
| Fable 5, Sonnet 4.6 | **2048** | adaptive_only (Fable: `thinking:{type:"disabled"}` also 400s) | low…max |
| Sonnet 4.5 / 4.1 / 4 / 3.7 | **1024** | budget_tokens | effort errors — omit |

The live brain is **Opus 4.8 → `cacheMinTokens = 4096`**, which makes the Phase-1 prefix work *more* load-bearing: a short static prefix silently won't cache.

### (b) Provider-agnostic resilience + translation wrapper — `src/runtime/harness/resilient-model.ts` (new)

A `Model` decorator. **Applied ONLY at the two thin-brain seams** — `getClaudeModel` (`claude-model.ts:124-130`, **wrap before `modelCache.set`**) and `getByoModel` (`byo-model.ts:313`). **Codex is explicitly NOT a wrap site** — it already owns transparent-retry-gated-on-`yieldedRealContent`, the empty-completion invariant, 401-refresh, rate-limit retry, and the bounded dispatcher; wrapping the load-bearing primary-traffic brain merely to opt it back out is pure regression surface (forward-only / never-regress). Wrapping only the two brains that *lack* these concerns still fixes the general CLASS — the next brain (DeepSeek/MiniMax) inherits parity for free.

```ts
export function withResilience(inner: Model, policy: ResiliencePolicy): Model
```

Two jobs, both inside `getResponse`/`getStreamedResponse(request)`:

1. **Per-turn settings translation (G1/G3)** — the per-turn seam `getModel` can't be. Read the effort tier the loop already computed and re-emit it as the active provider's wire idiom on `request.modelSettings.providerData`.
2. **Resilience (G2/G4/G5/G6):**
   - transparent retry + jittered exponential backoff, gated on **no-real-content-yielded** (the streaming-idempotency rule Clementine already proved in `codex-model.ts`);
   - retry 408/409/429/**529**/5xx/transport — **honor `Retry-After` first**, else jittered backoff (→ **G2**);
   - empty-completion invariant: throw a retryable `BoundaryError` on empty output-after-stream (→ **G5**); `applyClaudeEnvelope` already defaults `max_tokens=16384` (`claude-model.ts:42,93`), so don't duplicate that;
   - 401-refresh hook (→ **G4**); `freshClaudeToken()` already refreshes, so the hook just retries once on a boundary 401;
   - bounded **per-attempt socket deadline** via `AbortController.timeout`, **composed with** the existing `request.signal` (→ **G6**).

> Equivalent for the Claude path alone: `wrapLanguageModel({ middleware })` at the `LanguageModelV2` boundary works even though `aisdk()` calls `doGenerate`/`doStream` directly. We prefer the `Model`-decorator because the *same* wrapper covers BYO too — fix the general CLASS.

### (c) Per-provider settings-translation seam (the G1/G3 map) — runs inside the decorator

The `reasoning-effort.ts` tier (set at `loop.ts:3039-3046`) stays the single decider; the registry maps the tier to each provider's wire idiom. The decorator READS `request.modelSettings.reasoning.effort` (the Codex shape the adapter ignores) and RE-EMITS it for the active provider.

**Claude (write to `request.modelSettings.providerData`, forwarded at `index.js:1062` — no adapter fork):**
- **Reasoning (G1):** emit `providerData = { providerOptions: { anthropic: { effort } } }`, `effort ∈ low|medium|high|xhigh|max` from `effortMap`. Lands as `output_config.effort` — **stable, GA, no beta header, no signature round-trip, no `budget/max_tokens` math.** **Do NOT use `thinking:{type:"enabled",budgetTokens}`** on Opus 4.8/4.7/Fable — it is **fully removed → HTTP 400**. On Opus 4.8, pair with `thinking:{type:"adaptive"}`. Confine any `budget_tokens` path to Opus 4.6/older behind the registry's `thinkingMode`.
- **Caching (G3):** `providerOptions.anthropic.cacheControl = { type:'ephemeral'[, ttl:'1h'] }` on the largest **stable** blocks (system+tools), gated on `supportsPromptCache` + `cacheMinTokens` (≤4 breakpoints). The `cache_control` breakpoint **must sit AFTER** the Claude-Code identity block (`withIdentityPrefix`, `claude-model.ts:59-71`), which **must remain system block index 0** for the OAuth token to be honored. Characterization-test that invariant.

**Codex:** unchanged — `buildCodexRequestBody` already maps `reasoning.effort`. Not a wrap site.

**BYO:** map effort via `compat.reasoningFormat` when present; else omit. For the DeepSeek/thinking class, set `providerData.thinking` so the installed adapter forwards `reasoning_content` on tool-call turns (`index.js:773-781`; guards openai-agents-js #791). `retryClass:'openai_compat'` gets the same 5xx-retryable treatment.

### (d) Compaction parity (long-running is a north-star non-negotiable)

Codex offloads compaction to the provider's native `context_management`; Claude/BYO have no equivalent. **Decision: the harness-level `src/runtime/harness/compaction.ts` is the floor for ALL brains; native provider compaction is a Codex-only optimization, not a requirement.** Add a long-run characterization test on the Claude path that exceeds the context budget and asserts harness compaction fires. *(Anthropic's beta server-side compaction `compact-2026-01-12` is a later optimization, out of scope.)*

---

## 4. Phased, forward-only rollout (mapped to G1–G6)

Sequenced **by risk**, additive, characterization-tested. **One umbrella tripwire, not four flags.**

**Flag policy (binding).** A single kill-switch `CLEMMY_MODEL_PARITY=off` at the two thin-brain `getModel` return sites restores **byte-identical** legacy behavior across all phases. Phases are rollout **order**, not per-phase flags. The switch is a **temporary tripwire, to be DELETED** once the suite + a live smoke confirm parity.

**Phase 0 — Registry + tests (no behavior change).** Land `model-wire-registry.ts` from the vendored snapshot + characterization tests (metadata integrity; unknown-id warns LOUD; **pin `@ai-sdk/anthropic@3.0.82` and assert `output_config.effort` still emitted**; **pin `@openai/agents-extensions@0.11.6` and assert reasoning-before-tool-call ordering survives**).

**Phase 1 — Prompt-cache prefix discipline (prerequisite, code-level, no caching yet).** **First grep the actual system-prompt assembler** (loop.ts / context-packet builder) to confirm WHERE `currentDate`/mode/recall sit relative to tools+stable-system. Frame as a deterministic prefix/suffix partition: static tools + stable system **before** the breakpoint, all dynamic content (date, mode, recall) **after**. Invariant test: identity stays system block 0; breakpoint after it. Also a no-op-safe win for OpenAI/Gemini auto prefix caching.

**Phase 2 — G3 caching (highest ROI, lowest risk).** Emit `cacheControl` gated on `supportsPromptCache` + `cacheMinTokens` (Opus 4.8 = 4096). Acceptance gate: `usage.cache_read_input_tokens > 0` on a second identical-prefix call — assert it, don't assume.

**Phase 3 — G2/G4/G5/G6 resilience wrapper.** Land `withResilience`, wrap the two thin seams. Brings Claude/BYO to Codex parity. Codex untouched.

**Phase 4 — G1 reasoning LAST (highest correctness risk, smaller than feared since #770 is fixed).** Map effort tier → `output_config.effort` via `providerData`. Ship the multi-turn tool-use replay test (reasoning → tool_call → tool_result → reasoning) asserting no 400 + signature preserved, plus the BYO+thinking equivalent, before flipping on.

| Gap | Closed by | Mechanism |
|---|---|---|
| G1 reasoning.effort dropped | Phase 4 + §(c) | tier → `providerData.providerOptions.anthropic.effort` → `output_config.effort` |
| G2 no model-boundary retries | Phase 3 | wrapper retries 408/409/429/5xx/529 (closes AI-SDK `doGenerate` bypass) |
| G3 no prompt caching | Phases 1–2 + §(c) | stable prefix + `cacheControl` breakpoints, gated on `cacheMinTokens` |
| G4 no 401-refresh-retry | Phase 3 | wrapper 401 hook (re-reads via `freshClaudeToken()`) |
| G5 no empty-completion invariant | Phase 3 | wrapper throws retryable BoundaryError on empty output-after-stream |
| G6 no **socket-level** dispatcher | Phase 3 | wrapper per-attempt `AbortController.timeout`, composed with `request.signal` |

---

## 5. Tradeoffs, risks, and the must-have tests

1. **The signature-drop trap is ALREADY FIXED — do not build replay machinery.** Verified in `@openai/agents-extensions@0.11.6`. Defaulting Claude to `output_config.effort` is the right call for **cost/simplicity** (no signature round-trip, no `budget`/`max_tokens` math), not because replay is broken. Residual risk: a future minor bump regressing #770 — the Phase-0 version-pinned ordering test catches it.
2. **`output_config.effort` is version-fragile but currently VALID.** Pin the dep; CI-assert the emission so a silent future degradation fails loud.
3. **Caching is the genuinely non-uniform concern, and the thresholds were inverted earlier.** Opus 4.x + Haiku 4.5 = 4096; Fable 5 + Sonnet 4.6 = 2048; Sonnet 4.5/4.1/4/3.7 = 1024. Live brain (Opus 4.8) is 4096 — wiring `cache_control` without Phase-1 prefix discipline yields a 0% hit rate while paying the 1.25×/2× write premium. Gate strictly on `cacheMinTokens`.
4. **Don't over-normalize (the `drop_params` trap).** The reference fix is **namespaced escape hatches + native-preferred-API per provider** (Vercel `providerOptions`) — exactly what `modelSettings.providerData` already is. Translate known knobs; pass unknowns through; never pretend a feature doesn't exist.
5. **Metadata staleness fails silently.** Vendored snapshot + offline-refresh script that diffs against models.dev and opens a PR on drift (Goose's pattern); loud-warn on unknown id at runtime.
6. **Native-adapter cost is real — keep it to load-bearing brains.** Codex's 1467 LOC is justified by primary traffic + a streaming contract the unified adapter mistranslates. Go native **only** when you need model-boundary retries, auth-refresh, empty-completion invariants, or a stream contract the unified adapter breaks — and lift the provider-agnostic pieces into the shared wrapper.

**Must-have characterization tests (the rollback contract):**
- **(a) Codex byte-identical baseline** — golden Codex request-body snapshot (Codex is not a wrap site; proves no-regression on the load-bearing brain).
- **(b) Claude multi-turn tool-use replay** — reasoning → tool_call → tool_result → reasoning, no 400 + signature preserved (guards #770 on the pinned adapter).
- **(c) BYO+thinking tool-use** — DeepSeek-reasoner forwards `reasoning_content` on tool-call turns (guards #791).
- **(d) No-double-retry** — mock a 429, assert exactly one retry source fires.
- **(e) Cache-hit** — second identical-prefix Claude call reports `cache_read_input_tokens > 0`.
- **(f) Long-run compaction on Claude** — exceed context budget, assert harness compaction fires.
- **(g) Identity-block invariant** — Claude-Code identity stays system block 0 after Phase-1 reorder + Phase-2 breakpoint.
- **(h) Effort emission** — emitted Claude request carries `providerOptions.anthropic.effort`; version-pinned so a dep bump dropping `output_config.effort` fails loud.
- **(i) Kill-switch restore** — `CLEMMY_MODEL_PARITY=off` yields byte-identical legacy Claude/BYO traffic.

---

## Net

Make "no provider is second-class" a **structural property**: resilience + capability live **above** the wire (a vendored model-wire registry + a `withResilience` decorator on the thin brains + a `providerData` translation seam), not duplicated per brain. **Native for Codex's wire; thin-plus-shim for everyone else; Codex is never a wrap site.** Adding a future brain becomes a registry entry, not a 1400-LOC adapter — honoring every binding constraint: additive / forward-only, code-level not prompt-level, **one** temporary kill-switch (to be deleted), and fixing the general CLASS rather than patching Claude alone. The two corrections that change the build: **effort maps to `output_config.effort` and provably reaches the wire today**, and the **signature-drop bug is already fixed in the pinned adapter** — so the riskiest phase is cheaper than feared, and the real load-bearing work is the (correct) cache thresholds and prefix discipline.
