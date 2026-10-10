# PR-11 — Capability learning: what a model proved it can and cannot do

Size M · risk additive · depends on PR-03 (consumer); standalone otherwise

## Why

The capability table (`ModelCapability`, `src/runtime/harness/model-wire-registry.ts:207`)
knows family, API shape, context window, max output, reasoning-effort support,
prompt caching and retry class, by regex row over the model id; an unknown id gets
a conservative 128K default (:253). Observations already override the table for
windows, rejections, acceptances, cache hit rates and supported efforts
(`model-window-observations.ts:7-60`, `state/model-window-observations.json`).

Nothing records whether a model reads images, makes tool calls reliably, returns
the strict shapes the interpreter needs, or how fast it is, although the harness
learns each of these the hard way: v3.18.35 tells "a model that cannot take images
… it did not see it" (`1bb53732`); the interpreter "retries once on a shape
refusal" (v3.18.30); `classifyModelError` (`resilient-model.ts:300`) names
`refused` and empty completions; the ledger has latency per call. The
recommendation engine (PR-03) and the plan (PR-04) need these facts to avoid
proposing a model for a role it cannot serve, and the owner deserves to see them
in the picker instead of discovering them mid-turn.

## Change

1. **Observed capabilities, beside the window observations.** Extend the
   observations store (same file, versioned) with per-model counters and last-seen
   times for: `images: accepted | refused`, `toolCalls: ok | malformed | refused`,
   `strictShape: ok | refused` (the interpreter lane), `maxOutput: accepted(n) |
   rejected(n)`, `latency: p50/p95 rolling over the last 200 calls by role`. Each
   written from the place the harness already learns it:
   - image refusal: the `1bb53732` path;
   - malformed tool call: the carrier repair path (v3.18.35 "a slightly malformed
     tool call is repaired or refused with its own schema");
   - shape refusal: `interpret-accepted-source.ts` retry;
   - max output: the existing acceptance/rejection observation;
   - latency: `recordModelUsage`.
   Writes are best-effort and never on the turn's critical path (the observations
   module already follows this rule).
2. **One resolver.** `modelCapabilities(modelId)` returns the table row merged with
   observations as `{ value, source: 'table' | 'observed' | 'unknown', samples }` per
   field. PR-03's `capabilities()` input is this function. "Unknown" is a value,
   never a guess.
3. **Chips in the pickers.** `ModelPicker.tsx` and the role selects show up to
   three chips per model: context ("1M"), "reads images", "tool calls", and a
   warning chip when observed ("no images", "tool calls fail 12%"). Phone
   `RoleSheet.tsx` the same. Unknown shows nothing.
4. **Role guards use it.** `validateRoleModelBinding` (`model-role-options.ts:452`)
   gains advisory facts (not refusals): choosing a model with observed `toolCalls`
   failure ≥ 25% for worker shows a warning line; choosing a `no images` model for
   the brain shows "Clem will say she did not see an image". The owner can still
   choose; nothing is refused that is not refused today.

## Files

- `src/runtime/harness/model-window-observations.ts` (+ test), `model-wire-registry.ts`
- the four learning sites above (one line each, best-effort)
- `src/runtime/harness/model-role-options.ts` (advisory facts)
- `apps/console-web/src/components/chat/ModelPicker.tsx`, `screens/settings/ModelRolesCard.tsx`;
  phone `RoleSheet.tsx`, `BrainSheet.tsx`

## Tests

- Store: counters and last-seen update from fixture events; rolling latency over
  200; file survives a torn write (original bytes kept).
- Resolver: table-only, observed-overrides-table, unknown stays unknown; a model
  with 2 samples is `observed` but flagged low-sample in the output.
- Pickers: chips from fixture capabilities; nothing for unknown.
- Advisory facts never change the accept/refuse result of
  `validateRoleModelBinding` (characterization on the existing suite).

## Done when

After a fixture turn in which a BYO model refuses an image, the picker shows "no
images" for it on both surfaces, PR-03 stops proposing it for image-heavy roles,
and the resolution of every role is unchanged.

## Do not

- Do not refuse a binding on observed data; advise.
- Do not call a model to probe capabilities; learn from real turns only.
- Do not extend the regex table with vendor marketing claims.
