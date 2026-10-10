# PR-14 — All-in BYO identity: options, inactive bindings and memory attribution agree with the router

Size S · risk low (reporting and option lists; the wire route is already right) · depends on PR-00 (baseline) · should land before PR-03 reads the catalog snapshot

## Why

Four of the baseline's failing tests are one defect family, found by running the
files one at a time on `b0612dd` (2026-10-10, clean container):

| File · case | Expected | Actual | What it means |
|---|---|---|---|
| `model-roles.test.ts` · "all_in declared gpt-shaped BYO binding and inactive reporting stay on the BYO provider" | inactive binding `provider: 'byo'`, reason matching "Codex-family ids stay on the BYO backend in all-in" | `provider: 'codex'`, reason "Model gpt-4o is declared by BYO provider Together, but that provider is not connected…" | The route is right (the live worker resolves to the BYO primary), but the **inactive binding** is labelled with the wire-shape classifier, so the UI would say "GPT-4o on Codex isn't available" for a model Together declared. The newer reason sentence is better than the pinned one; keep it. |
| `model-role-options.test.ts` · "an explicitly selected fallback keeps connected subscription and API routes separate from an all-in brain" | ordinary role options contain no `codex` group in all-in | they do | Settings offers Codex models for ordinary roles in all-in mode; choosing one is then refused by `roleModelCapabilityFromContext` ("Codex-family ids stay on the BYO backend in all-in"). The list and the validator disagree. |
| `model-role-options.test.ts` · "all_in is provider-isolated and gpt-shaped BYO ids remain BYO in role/UI reporting" | an id both Codex and a BYO provider could serve is not offered | offered | The collision rule (`unqualifiedModelCollisionReasonFromSnapshot`) runs at validation, not when the option list is built. |
| `memory-model-route.test.ts` · "the fast-tier jobs name the model the router actually serves them, and the meter tags that account" | fast-tier memory jobs name the BYO primary in all-in | `gpt-5.6-luna` | `memoryJobServingNow` (`src/memory/memory-model-route.ts:414`) names the requested fast-tier string; in all-in the router collapses it to the BYO primary, so the billing attribution (`rolesByAccount`) credits memory work to Codex that Codex never does. |

Reproduced with a throwaway test through the real runner on 2026-10-10:
`resolveRoleModel('worker')` with Together declaring `gpt-4o` and its key empty
returns `{ modelId: 'glm-5.2', provider: 'byo', source: 'default', inactiveBinding: { modelId: 'gpt-4o', provider: 'codex', … } }`.

Why it matters for the plan: PR-01's scorecard, PR-03's recommendations and
PR-04's plan all read `modelRoleOptionCatalogSnapshot()` and
`resolveRoleModel()`. If the option list offers what the validator refuses, or an
inactive binding names the wrong provider, the suggestions inherit the lie.

## Change

1. **Inactive bindings use the effective provider.** In `model-roles.ts` around
   `:620-630`, the branch that returns `resolveProvider(modelId)` for an inactive
   binding should return `resolveEffectiveProviderForModelFromSnapshot` when a BYO
   provider declares the id (connected or not). Keep the newer reason sentence;
   update the test's regex to it. The `reason` names the declaring provider; that
   is the better message.
2. **Option lists apply the same rules as validation.** In
   `model-role-options.ts`, the group builders (`connectedModelGroupsFromContext`,
   the `roleOptions` derivation around `:122-190` and `:259`) must run the two
   rules `roleModelCapabilityFromContext` runs: in all-in mode with a configured
   default backend, Codex and Claude groups are offered for ordinary roles only
   when that subscription is connected and the model is not a BYO-declared id;
   an id with an ownership collision is dropped from the offered list (or shown
   disabled with the collision reason, which the UI already supports for
   `inactiveBinding`). Judge-fallback options keep their separate rule (the test's
   "fallback" branch).
3. **Memory jobs name the served model.** `memoryJobServingNow` resolves the
   requested fast-tier string through the same `routedModelString` it already
   calls, and reports the routed id when the mode is all-in (the function already
   does this for the BYO provider id; the model id must follow). The job still
   hands the agent today's string (the test's last assertion).
4. **Characterization.** With `MODEL_ROUTING_MODE` off or `worker`, every option
   list and binding is byte-identical to today (snapshot the JSON of
   `modelRoleOptionCatalogSnapshot()` for the three auth modes before changing
   anything, and pin it).

## Files

- `src/runtime/harness/model-roles.ts`, `model-roles.test.ts` (regex update only)
- `src/runtime/harness/model-role-options.ts`, `model-role-options.test.ts`
- `src/memory/memory-model-route.ts`, `memory-model-route.test.ts`
- `src/runtime/harness/provider-billing.ts` (only if `rolesByAccount` needs the served id; the test expects Codex to carry no memory role)

## Tests

- The four cases above go green without changing their intent (the one regex
  update is the newer, better sentence).
- New: an all-in snapshot offers no Codex group when Codex is not signed in, and
  offers it when it is; an ambiguous id is absent from `roleOptions` but present
  in the refusal reason; the inactive binding of a BYO-declared id carries
  `provider: 'byo'` and the declaring provider's label.
- Characterization snapshots for `off` and `worker` modes unchanged.
- `model-status` and the phone `settings/models` route tests unchanged.

## Done when

Those four baseline failures are gone from `docs/checkpoints/2026-10-10-ci-baseline.md`,
the all-in Settings → Models page on a fixture home offers exactly what it will
accept, and the token meter credits memory work to the account that did it.

## Do not

- Do not change the wire route (`resolveEffectiveProviderForModel` is already
  right); change what is reported and offered.
- Do not restore the old reason sentence to make the pin pass.
- Do not touch non-all-in behaviour.
