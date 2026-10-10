# PR-01 — Model scorecard: what each model did, per role, on both surfaces

Size M · risk read-only · depends on PR-00 · foundation for PR-03, PR-05, PR-06

## Why

Clem already measures every model call: `UsageEvent` (`src/runtime/usage-log.ts:40`)
records role (`brain | worker | reviewer | router | writer | memory | quick`),
model, requested model, provider-reported model, backend, account, certified
cached and uncached accounting, failure reason and a trace to the accepted source.
`state/model-route-metrics.db` records, per (role, intent, provider, model),
success, objective-met and tool-success rates, latency, tokens and explicit billed
cost (`src/runtime/model-route-metrics.ts:48-70`). Provider health is in
`state/brain-auth-dead.json`, the rate-limit store, `state/provider-credit.json`,
the helper bench and `buildModelStatus` (`src/runtime/harness/model-status.ts:102`).

None of it reaches the owner as a judgement about a model. `rollupUsage`
(`usage-log.ts:945`) groups by kind, source, model and hour, never by role; the
console shows account percent meters (`usage-presentation.ts:405`) and tokens by
model under Advanced › Usage (`Advanced.tsx:22-73`). A model that is slow, failing
or doing nothing looks the same as one that is carrying the day.

Every suggestion in PR-03 rests on this read model, so it ships first and alone.

## Change

### 1. One read model in the daemon

`src/runtime/harness/model-scorecard.ts` (new), pure over inputs so it is testable
with fixtures:

```ts
export interface ModelScorecardV1 {
  version: 1;
  window: { days: 7 | 30; from: string; to: string };
  rows: ModelScoreRowV1[];           // one per (role, modelId, account?)
  health: ModelHealthRowV1[];        // one per connected account/provider
  computedAt: string;
}
export interface ModelScoreRowV1 {
  role: UsageRequestRole;
  modelId: string; provider: ModelProviderClass; account?: string;
  calls: number; failedCalls: number; failureClasses: Partial<Record<ModelErrorClass, number>>;
  uncachedInputTokens: number; cachedReadTokens: number; outputTokens: number;
  cacheHitRate: number | null;        // cachedReadTokens / promptTokens, certified rows only
  latencyMs: { p50: number; p95: number } | null;
  objectiveRate: number | null; toolSuccessRate: number | null; samples: number; // from route metrics
  fallovers: { from: number; to: number };
  billedUsd: number | null;           // explicit adapter-reported only; null otherwise
  certified: boolean;                 // false when any row in the window was uncertified
}
```

- Usage rows come from the existing NDJSON reader (reuse the parser behind
  `rollupUsage`; do not write a second one). Only `canonical.certified` rows count
  toward token totals; uncertified rows count toward `calls` and set
  `certified:false`.
- Route-metric rows come from the existing summary query in
  `model-route-metrics.ts` (`ModelRouteSummary`); join on (role, model).
  **Until PR-16 lands, `objectiveRate` and `toolSuccessRate` are null on every
  row**: no production path writes those two columns today (verified 2026-10-10,
  see PR-16). The presenter omits null fields, so the card is honest either way.
- Health rows come from `buildModelStatus` plus the dead-login, bench, quota-latch
  and credit stores. Each row: provider, account label, state
  (`ok | rate_limited | auth_dead | out_of_credit | benched`), since, until,
  windows (Codex 5h/weekly, Claude 5h/7d) as the status already exposes them.
- `billedUsd` is explicit cost only (rule 5 in the README). No estimates.
- Cache the computed scorecard for 60 s in memory; computing it reads one or two
  NDJSON files and one SQLite summary.

### 2. Endpoints

- `GET /api/console/models/scorecard?days=7|30` next to `GET model-status`
  (`console-routes.ts:9891`).
- `GET /m/api/models/scorecard` under the paired session in `mobile-routes.ts`
  next to `settings/models` (:6223).
- Both return `ModelScorecardV1` and nothing else; no secrets, no base URLs.

### 3. One presenter, two surfaces

- `packages/chat-engine/src/model-scorecard-presentation.ts` (new): turns rows into
  the words both apps show. Role labels reuse the ones Settings already uses
  ("Does the work", "Checks the work", "Helps in parallel", "Writes the final
  answer", "Memory", "Quick reads"). A row renders as one line:
  `Haiku · 212 checks · 97% passed · 2.1 s typical · 0 failures · 81% cached`.
  Null fields are omitted, never shown as 0.
- Desktop: a "How your models are doing" card at the top of
  `apps/console-web/src/screens/settings/ModelsRoutingSection.tsx`, above the
  accounts card, with the 7/30-day toggle and the health rows (a dead login or an
  exhausted window shows with its "since" and the existing Reconnect action).
- Phone: the same card at the top of the models sheet (`screens/Settings.tsx` →
  `BrainSheet.tsx`), read-only.
- Each role row in `ModelRolesCard.tsx` gets its scorecard line under the select
  (desktop) and under the row (phone `RoleSheet.tsx`), so the owner sees what the
  current choice has done before changing it.

## Files

- new `src/runtime/harness/model-scorecard.ts`, `model-scorecard.test.ts`
- `src/runtime/usage-log.ts` (export the row reader; no behaviour change)
- `src/dashboard/console-routes.ts`, `src/channels/mobile-routes.ts` (two GETs)
- new `packages/chat-engine/src/model-scorecard-presentation.ts` + test
- `apps/console-web/src/screens/settings/ModelsRoutingSection.tsx`,
  `ModelRolesCard.tsx`, `src/lib/model-roles.ts` (query hook)
- `apps/mobile-web/src/screens/Settings.tsx`, `BrainSheet.tsx`, `RoleSheet.tsx`

## Tests

- Pure: fixtures with certified and uncertified rows, a fallover pair, a benched
  helper, an exhausted Codex window; p50/p95 on a known series; `billedUsd` null
  when no adapter cost; a role with no rows produces no row.
- Characterization: an empty usage directory yields `rows: []` and the UI shows
  "Nothing measured yet" (blank-home rule: no failure words; extend
  `src/dashboard/home-blank-state.test.ts` if the card can reach Home).
- Route tests for both endpoints (shape, auth, no secrets in the body).
- Presenter test pins the one-line wording.
- Console and phone typecheck and build; the release-closure gate.

## Done when

Settings → Models on desktop and phone shows, for every role, what its model did
in the last 7 and 30 days, from the usage ledger and route metrics, with health
beside it, and `npm run measure:turns` on a fixture turn changes nothing (the PR
adds no model calls and touches no turn path).

## Do not

- Do not add a token-price table or any dollar estimate.
- Do not write a second NDJSON parser or a second rollup; extend `usage-log.ts`.
- Do not show per-model numbers on Home in this PR; Home gets a weekly line in PR-06.
- Do not change `rollupUsage`'s existing output (Advanced › Usage keeps working).
