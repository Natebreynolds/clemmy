# PR-03 — Routing recommendations from what the owner connected

Size M · risk additive (suggestions only) · depends on PR-01 (scorecard), PR-02 (suggestion record)

## Why

The owner asked for this in so many words: Clem should offer routing suggestions
based on the models the owner has connected, instead of leaving every role to a
dropdown. Today the automatic defaults are compiled-in ids (`claude-opus-4-8` at
`src/config.ts:322`, `gpt-5.6-terra/sol/luna` at `:373-387`, the checker
`claude-haiku-4-5` or Luna at `src/runtime/harness/judge-family.ts:533`, the
fallback checker `claude-sonnet-4-6` at `config.ts:337`); a connected DeepSeek,
GLM, Kimi or MiniMax model does nothing until the owner finds the right select;
and the only hint after connecting is four unexplained buttons
(`ModelProviderForms.tsx:196-244`).

Everything a recommendation needs already exists as data: the catalog snapshot
(`modelRoleOptionCatalogSnapshot`, `model-role-options.ts:574-606`), the
capability table and observations (`model-wire-registry.ts:207`,
`model-window-observations.ts`), the account status and billing
(`model-status.ts:102`, `provider-billing.ts:288`), the saved bindings
(`CLEMMY_MODEL_ROLES`), and after PR-01 the scorecard.

## Change

### 1. A pure engine

`src/runtime/harness/model-recommendations.ts` (new):

```ts
export interface RecommendationInputV1 {
  snapshot: ModelRoleOptionCatalogSnapshot;   // what is connected and usable now
  bindings: ResolvedRoleModel[];              // resolveRoleModel for each role, with source
  scorecard: ModelScorecardV1;                // PR-01, 30-day window
  status: ModelStatus;                        // windows, balances, dead logins, benches
  capabilities: (modelId: string) => ModelCapability; // table + observations
  now: string;
}
export function recommendModelRoles(input: RecommendationInputV1): SuggestionV1[];
```

Deterministic, no I/O, no model call. Each rule yields at most one suggestion with
its evidence lines (each line names its source: scorecard, status, catalog,
capability). Rules, in priority order; the first three are the ones the owner
feels most:

| Rule | Fires when | Proposal |
|---|---|---|
| **R1 Two families** | The checker resolves to the brain's family, or to nothing usable, while a usable model of another family is connected. | `settings` → judge = the connected other-family model with the best (objectiveRate, then lowest p50) in the scorecard, or the fast tier of that family when unmeasured. Never the brain's family. |
| **R2 A faster helper, measured** | For role ∈ {worker, quick, memory}: a connected candidate with ≥ 20 samples in 30 days whose failure rate ≤ the current model's, objectiveRate ≥ current − 0.02 (or both unmeasured on objective), and p50 ≤ 0.7 × current p50. | `settings` → that role = candidate, with the four numbers as evidence and `followUp.afterTurns = 30`. |
| **R3 Connected and idle** | A usable model with 0 calls in 30 days and no role or rule. | `settings` → worker = that model when its capability row says tools are supported (PR-11) or is unknown; `followUp.afterTurns = 20`. If the capability row says no tools: `open` → Settings with words saying what it cannot do. |
| **R4 Window pressure** | An account's 5-hour or weekly window (Codex, Claude) is ≥ 80% used, and it serves worker/quick/memory, and another connected family has headroom. | `settings` → move those roles (never the brain) to the family with headroom; `expiresAt` = the window's reset time. |
| **R5 A role on a dead account** | The role's account is `auth_dead` or `out_of_credit` (status) for more than 15 minutes and a live candidate exists. | `settings` → role = live candidate; words name the dead account and the existing Reconnect action. |
| **R6 Saved choice gone** | `inactiveBinding` on a saved role or rule (the UI already says "isn't available, so Y is used"). | `settings` → role = the resolved stand-in Y, so the saved record stops lying. |
| **R7 Enough evidence to let Clem pick** | Worker role: two or more candidates each with ≥ 8 samples (the route policy's own floor) and the policy is off. | `settings` → PR-05's toggle on. Not raised before PR-05 lands. |
| **R8 A local model is here** | A local provider is connected (PR-09) and memory or quick runs on a metered account. | `settings` → memory and quick = the local model; evidence: zero metered tokens, measured p50 if any. |

Guards that every rule obeys (README rules 2–6):

- never proposes a brain change, never routes a role to a model the capability
  table or observations mark as unable for that role (max output too small for
  writer, no tools for worker), never a model `benched` or `rate_limited` right now;
- the judge candidate must be a different family from the resolved brain
  (`chooseBoundaryJudgeFamily` is the arbiter; reuse it, do not re-implement);
- a `never` standing answer for the same kind + subject suppresses the rule
  (PR-02 store does this; the engine stays pure and the caller filters);
- when two rules want the same role, the earlier one wins and the other is dropped
  for this run.

### 2. Where it runs

- A heartbeat registered in `src/agents/heartbeats.ts:22` (`model-recommendations`,
  every 6 hours, quiet-hours aware) builds the input and raises through the PR-02
  store. Daily cap and dedupe come from the store.
- On demand: `GET /api/console/models/recommendations` (and `/m/api/...`) returns
  the current set without raising, for the Settings screen and PR-04's plan card.
- After a provider is connected (`POST settings/model-providers`, `console-routes.ts:9901`)
  the engine runs once immediately so the answer is on screen when the owner
  looks (PR-04 renders it).

### 3. Where the owner sees it

- Settings → Models: an open suggestion about a role renders as the PR-02 card
  directly under that role's select, on desktop (`ModelRolesCard.tsx`) and phone
  (`RoleSheet.tsx`). The automatic label gains its reason, read from the same
  input: "Automatic · Haiku, because your brain is Codex and the checker should be
  a different family" (the facts already exist in `checkerSettingsFacts`,
  `debate-model.ts:1368`; this PR only words them).
- From Clem: the one suggestion the heartbeat raised, in Clem's words, with
  evidence folded.
- Composer model chip (`ModelPicker.tsx`): when a suggestion concerns the current
  conversation's model, one line under the picker ("Clem suggests …"), tap opens
  the card. Nothing else changes in the picker.

### 4. Clem's words

The engine fills `words.ask` and `words.why` from templates per rule, in her voice,
with the numbers in the evidence lines rather than in the sentence:
"Your checks could run on DeepSeek: it has passed 97% of 212 checks for you, about
three times faster than Haiku. Switch the checker?" The model names shown are
the labels the pickers already use (`model-roles.ts` label helpers), never raw ids
in the sentence; raw ids fold under Details.

## Files

- new `src/runtime/harness/model-recommendations.ts`, `model-recommendations.test.ts`
- `src/agents/heartbeats.ts` (register), new `src/agents/model-recommendations-runtime.ts`
- `src/dashboard/console-routes.ts` (GET + run-after-connect), `src/channels/mobile-routes.ts`
- `apps/console-web/src/screens/settings/ModelRolesCard.tsx`, `ModelProviderForms.tsx`,
  `components/chat/ModelPicker.tsx`
- `apps/mobile-web/src/screens/RoleSheet.tsx`, `BrainSheet.tsx`
- `packages/chat-engine/src/suggestion-presentation.ts` (role-specific wording)

## Tests

- One fixture per rule with the numbers at the boundary (R2 at 0.7× exactly fires;
  0.71× does not; 19 samples does not fire).
- Guards: same-family judge never proposed; benched or rate-limited candidate never
  proposed; brain never proposed; a `never` answer suppresses; two rules on one
  role yield one suggestion.
- Characterization: a home where every default is connected and nothing is
  measured yields `[]`, and Settings renders byte-identical to main (snapshot test
  on the rendered words).
- The heartbeat obeys quiet hours and the daily cap; the after-connect run raises at
  most one suggestion per role.
- The 22-file CI baseline is unchanged; the model-role suites named in the 10-07
  checkpoint (`model-role-options`, `model-roles`) are run one at a time and their
  failures are the baseline's, not new ones.

## Done when

On the installed app, with fixture usage rows written to a named test window and
two families connected, the heartbeat raises the R1 or R2 suggestion once, it shows
under the role on desktop and phone, a tap changes the role through the normal
handler, Undo restores it, and `npm run measure:turns` on a fixture turn shows no
added model calls.

## Do not

- Do not call a model to write the suggestion; templates and the engine's numbers only.
- Do not compile in a "best model" list or a price; everything comes from the input.
- Do not apply R4 or R5 automatically because the situation looks urgent; the
  existing fallover and bench are the automatic layer, this is the owner's layer.
- Do not raise more than one suggestion per role per day, or any during quiet hours.
