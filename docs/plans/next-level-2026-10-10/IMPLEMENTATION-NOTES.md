# Implementation notes: the patterns to copy, verified on `b0612dd`

For the implementing agent. Each note names the existing code a brief should
extend, so nothing in the plan grows a parallel primitive.

## Heartbeats (PR-02 follow-ups, PR-03, PR-06)

- `src/agents/heartbeats.ts:8`: `HEARTBEAT_IDS = ['work-review', 'calendar', 'workflow-suggestions', 'noticing'] as const`.
  A new heartbeat (`model-recommendations`, `suggestion-follow-up`, `weekly-models`)
  is added to this tuple, which also makes it appear on the Heartbeats screen
  (`apps/console-web/src/screens/Heartbeats.tsx`) with on/off, cadence
  (`cadenceMinutes`, `cadenceRange`) and notify mode, for free. Keep the pure
  half and the runtime half split as `noticing.ts` / `noticing-runtime.ts` do.
- The blank-home test `src/dashboard/home-blank-state.test.ts` runs every
  heartbeat; a new one must produce no failure words on an empty home.

## Durable JSON state (PR-02, PR-11)

- `src/runtime/atomic-json.ts`: `atomicJsonMutate(path, mutate)` (`:790`),
  `withFileLock` / `withFileLockSync` (`:650`, `:717`), `atomicAppendNdjson` (`:863`).
  `home-preferences.ts:61` is the model for a one-record store; the recurring
  workflow ledger rule applies: a torn or unreadable file keeps its bytes and
  reads as unavailable, never as empty state.

## From Clem rows (PR-02, PR-06)

- `src/dashboard/from-clem.ts:23` `FromClemRow`: `key`, `heartbeat`, `asks`,
  `say`, `choices`, `text`, `detail`, `voiceDigest`, `answer`
  (`{kind:'words', questionId}` or `{kind:'yes_no', planProposalId}`), `done`,
  `setup`, `run`, `ref`. A suggestion row is a new `answer` kind
  (`{kind:'suggestion', suggestionId}`) so the pane's existing reply route
  (`console-routes.ts:14565`) can forward a tap to the suggestion store; do not
  add a second pane.
- `FromClemInput` (`:81`) is assembled by the route; add `suggestions` beside
  `noticingProposals` and keep the function pure.

## Projecting an event (PR-06, PR-07)

- Template: `src/runtime/harness/public-presentation.ts:1412`
  (`case 'expected_work_progress'`): check `version`, bound every array
  (`slice(0, 32)`), whitelist every enum, drop unknown keys, return `null` on
  any violation. Never pass arguments, results or paths.
- Then move the event out of `AWAITING_PROJECTION` in
  `packages/chat-engine/src/reduce-lifecycle.ts:64` into `LIFECYCLE_ROWS`
  (`:38`) or the activity fold; `event-coverage.test.ts:95` fails until you do,
  with the exact instruction in its message.
- `usage-log.ts` → `model_call_completed` already carries the resolved channel
  and role per call (`usage-log.test.ts:458`); PR-06's receipt can be built from
  those rows plus `accepted-source-usage.ts` without a new ledger.

## Settings writes (PR-02 apply, PR-03, PR-05, PR-14)

- Role bindings: `persistModelRoleSetting(change)` in
  `src/runtime/harness/model-role-settings.ts:48` validates the id charset and
  returns the new `RoleBinding[]`. The suggestion applier calls this, never
  `updateEnvKey`.
- Home preferences: `GET/PATCH /api/console/settings/home` at
  `console-routes.ts:9254/9259` and the phone twin `mobile-routes.ts:5398/5407`;
  the PATCH validates and merges, which is the shape a suggestion `settings`
  proposal targets.
- The three copies of preference defaults (`home-preferences.ts:63-80`,
  console `lib/home-prefs.ts:96-109`, mobile `lib/home-prefs.ts:76`) drift; a new
  preference must be added to all three until PR-13 item 13 unifies them.

## Chat send paths (PR-07 Continue)

- Console: `send(input, retryRequest?)` in `apps/console-web/src/lib/useChat.ts:2041`
  takes `{ text, displayText?, attachmentIds?, taskMode?, agentId?, projectId?, connectionResume?, voice? }`
  and mints `clientRequestId` itself (`:543`). The Continue tap calls `send({ text: 'continue' })`.
- Phone: `ChatEngine.send(text, selectedMode?, options)` in
  `packages/chat-engine/src/engine.ts:326`. Same literal.
- Both already route a typed "continue" through the reply router
  (`task-continuity-runtime.ts`); nothing new server-side.

## Parity tests (every UI brief)

- The only existing "parity" suite,
  `apps/console-web/src/features/conversations/thread-parity.test.ts`, is a
  **source-text** test (it reads the two React files and asserts on regexes,
  `:20-39`). It proves nothing about rendering. The pattern the plan asks for is
  different: feed one fixture event stream to the shared reducers
  (`packages/chat-engine/src/reduce-lifecycle.ts` `reduceFeed`, `reduce-activity.ts`
  `reduceActivity`) and to `ChatEngine`, and compare the derived card models
  (not DOM). Put it in `packages/chat-engine/src/*.parity.test.ts` so it runs in
  the release-closure gate (`package.json` `test:release-closure` lists chat-engine
  files explicitly; add the new file there).
- Because the console's `useChat.ts` does not use `ChatEngine`, a parity test on
  the reducers covers the data; the console component still needs its own
  render test (`Home.test.ts` style) for the new card.

## Route metrics (PR-16, PR-01, PR-05)

- `withModelRouteMetrics(model, context)` (`src/runtime/model-route-metrics.ts:518`)
  wraps a model: one decision row at construction, one outcome row per request
  (`successfulRouteOutcome`, `:565`, status `success | fallback`), tokens from
  `modelRouteUsageFromResponse` (`:982`). The brain chain wraps at
  `router-model.ts:273`; the checker at `debate-model.ts:1031-1102`.
- `recordModelRouteOutcome` (`:414`) accepts `objectiveMet` and `toolSuccess`
  (`boolToInt`, `:444`); nothing calls it with them. PR-16 adds the terminal join.
- `route-policy.ts:191/380` opens the DB for the job and the pick; the job runs
  from `runner.ts:3213`; `reapStaleModelRouteMetrics` runs in memory maintenance.

## Tests the briefs rely on

- Runner: `node scripts/run-tests-isolated.mjs <file> [--test-name-pattern "…"]`;
  per-file private home; `CLEMMY_TEST_DISABLE_LIVE_MODELS=1` and local
  embeddings off are set by the preload. A throwaway `src/**/zz-*.test.ts`
  through the runner is the fastest way to see what a resolver sees under test
  conditions (used on 2026-10-10 to confirm PR-14's cases are real).
- `src/no-hardcoded-provider-pins.test.ts` is a ratchet on provider operation
  slugs per file; model ids are not slugs, but a new file that names
  `GOOGLESHEETS_…`-style operations fails the build.
- `scripts/check-public-hygiene.mjs` scans tracked files for personal paths,
  provider resource ids and signing identities; fixture ids must look like
  fixtures (`isFixtureResourceId`, `:111`).
