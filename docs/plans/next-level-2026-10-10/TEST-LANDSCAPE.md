# What the tests prove, what they do not, and where the plan's risk sits

2026-10-10 · read with `docs/development/testing.md` · measured on main `b0612dd` in a clean 4-core container

## 1. The shape of the suite

| Layer | What it is | Count / gate |
|---|---|---|
| Unit and component (`node:test` via tsx) | Pure functions, reducers, stores, routes with fixtures; each file runs in its own process with a private `CLEMENTINE_HOME` minted by `scripts/test-isolation-preload.mjs`, live models disabled (`CLEMMY_TEST_DISABLE_LIVE_MODELS=1`), local embeddings off | 2,250 `*.test.*` files; `npm test` = `scripts/run-tests-isolated.mjs` over the `DEFAULT_TEST_TARGETS` globs (`src/**`, `apps/**`, `packages/**`) |
| Journeys (`src/journeys`) | End-to-end turns through the bridge with **scripted** models and recorded providers | separate serialized gate `npm run journeys`; excluded from the broad suite by design (latency contracts) |
| Release gates | `test:release-assets`, `test:release-closure` (named presenter and UI suites that both apps render from), `check:public-hygiene`, `check:operation-identity`, `no-hardcoded-provider-pins` ratchet, `project-plan-ir` manifest growth | `.github/workflows/test.yml` and `release-desktop.yml` |
| Proof and evals | `npm run proof` (real daemon × claude/codex/glm × 37 scenarios), `eval:passk`, `eval:memory`, `measure:judge-calibration` (κ on a 10-case seed), `bench:gates` | manual, token-spending, not CI |
| Live acceptance | Named fixtures on the installed app, wave runner, receipts under `output/` | manual, the owner's requirement for every change |

Nothing in CI calls a model. That is deliberate and right for a suite this size;
it also means CI can only prove shape, not judgement.

## 2. What the suite is good at

- **Characterization.** The best modules pin "byte-identical when off"
  (`route-policy.test.ts`: empty table ⇒ null, kill-switch ⇒ null), "the
  advertised tool array is append-only within a source", "the tools block is
  byte-identical across a turn's restarts". The plan's rule 1 copies this pattern.
- **Projection honesty.** `packages/chat-engine/src/event-coverage.test.ts` proves
  the public allowlist is fail-closed, that no lifecycle row promises an event the
  server never sends, and that `AWAITING_PROJECTION` is still accurate. Any event
  PR-06 or PR-07 projects must move it out of that list or the test fails.
- **Cost accounting.** `usage-log.test.ts` pins cache-dialect declaration,
  certification, quarantine of impossible samples, role attribution of memory
  jobs. PR-01 builds on exactly these guarantees.
- **Blank home.** `home-blank-state.test.ts` runs every heartbeat on an empty
  home and fails on any failure word. PR-02, PR-03 and PR-06 must keep it green.
- **Voice.** Several suites assert on the owner's rules as regexes
  (`/ask me|continue|retry|resume/i` on ownerless terminals). They are failing
  today because the code has not caught up; that is the suite doing its job.

## 3. What it cannot tell you

- **Whether a model would pick differently.** Scripted models mean every
  recommendation, review verdict and routing decision is only shape-tested.
  PR-03's engine is deliberately pure so that this is enough for it; PR-10's
  review change is the opposite and needs the replay in its brief.
- **Both surfaces.** The console runs its own `lib/useChat.ts`; the phone runs
  `ChatEngine`. A card wired in one and not the other passes every unit test.
  The only parity suite is `apps/console-web/src/features/conversations/thread-parity.test.ts`
  in the release-closure gate. Every UI brief in the plan adds a parity test.
- **Real tokens.** Journeys carry no usage; `measure:turns` on the installed app
  is the only cost truth. Nine of the plan's briefs say "measure:turns unchanged"
  for that reason.
- **Order and environment.** Test files set `process.env` directly (`withEnv`
  helpers) and the preload adds flags. The all-in BYO failures looked
  environment-dependent until reproduced with a throwaway test through the real
  runner (they are real, see PR-14). When a failure does not reproduce in a
  one-off script, run the case through `scripts/run-tests-isolated.mjs` before
  calling it flaky.
- **Scale.** The suite takes CI about 35 minutes and a laptop more; the 10-07
  batch run took a day. Run the touched files one at a time while iterating and
  the whole suite once before a PR.

## 4. The baseline as it stands

See `docs/checkpoints/2026-10-10-ci-baseline.md` for the full failing-file list
with a classification per case. Of the seven files the 10-07 checkpoint named:

| File | Cases | Classification | Owner in the plan |
|---|---|---|---|
| `model-roles.test.ts` | 1 of 36 | real (inactive binding provider) + stale reason regex | PR-14 |
| `model-role-options.test.ts` | 2 of 22 | real (option lists ignore all-in isolation and collisions) | PR-14 |
| `memory-model-route.test.ts` | 1 of 20 | real (memory attribution in all-in) | PR-14 |
| `respond-bridge-one-gate-wiring.test.ts` | 2 of 6 | real (fixed host sentence with an instruction on ownerless terminals) | PR-15 |
| `loop-structured-output-guard.test.ts` | 2 of 12 | stale pins (legacy sentence) | PR-15 |
| `claude-agent-brain.test.ts` | 4 of ~30 | 2 stale pins (queued wording), 2 real (pending capture reported as success on the SDK lane) | PR-15 |
| `autonomous-send-consent-crash-matrix.red.test.ts` | — | file no longer exists on main (fixed in 3.18.30 and removed) | none |

## 5. Rules for the implementing agent, derived from the above

1. A failing case is classified before it is touched: **stale pin** (the sentence
   or shape changed on purpose; move the pin), **real defect** (the test states the
   owner's rule; fix the code), **artifact** (order, environment, timing; fix the
   test's isolation, never the assertion). Write the classification in the PR.
2. Never loosen an assertion that encodes an owner rule (voice, consent,
   provider isolation, cache stability) to get green.
3. Every behaviour behind a flag or a suggestion gets a characterization test
   that pins the off state against a snapshot taken **before** the change.
4. Every event added to `projectData()` is removed from `AWAITING_PROJECTION` in
   the same commit, with its fold test flipped from inert to live.
5. Every card gets a console-and-phone parity test over one fixture event stream.
6. Anything on the turn path reports `measure:turns` before and after, on a named
   fixture, same model and cache state. Component timing is not evidence.
