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

## UI tests and parity (every UI brief)

- There is **no DOM render harness** in either app: `apps/console-web` and
  `apps/mobile-web` declare only `typecheck` and `build` scripts, no jsdom or
  testing-library. Console screen tests (`screens/Home.test.ts`,
  `thread-parity.test.ts`) read the component source with `readFileSync` and
  assert on regexes ("visual contract" pins); model tests
  (`components/home/home-model.test.ts`, `needs-you-answer.test.ts`) exercise
  pure helpers. The phone has 54 test files of the same two kinds.
- So a new card is tested in three places, none of them a render:
  1. its presenter in `packages/chat-engine/src/*-presentation.ts` (pure, one
     fixture in, words and actions out), which is where desktop and phone
     parity actually lives, because both import it;
  2. a reducer parity test: one fixture event stream through `reduceFeed` /
     `reduceActivity` and through `ChatEngine`, comparing the derived card
     models, placed in `packages/chat-engine/src/*.parity.test.ts` and listed in
     `package.json` `test:release-closure`;
  3. a source-contract pin per app in the existing style (the component imports
     the presenter, wires every action the presenter names, and renders nothing
     the presenter did not say).
- A jsdom render harness would be a real improvement; it is listed under
  PR-13 and is not a prerequisite for any brief.

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
