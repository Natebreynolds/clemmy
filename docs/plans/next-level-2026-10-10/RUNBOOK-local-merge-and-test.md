# Runbook: merging this branch locally and testing the plan's PRs

2026-10-10 · for the owner and the implementing agent · branch `claude/next-level-plan-2026-10-10`

The branch carries two commits on top of main `b0612dd`: the one-line hygiene
fixture fix (`be69534`) and the plan (`abd1110`). Nothing else. It is safe to
merge into any worktree; it changes one test string and adds documents.

## 0. Before anything

Read `AGENTS.md` and the three 09-19 checkpoints. Recheck who owns which
worktree (`~/clem-worktrees/*`, `~/clementine-next`): another agent may be mid-change.
Never `git add -A` in a shared worktree; never stage another agent's files.

## 1. Bring the branch in

```bash
cd ~/clementine-next            # or the worktree you own
git fetch origin claude/next-level-plan-2026-10-10
git merge --no-ff origin/claude/next-level-plan-2026-10-10   # zero conflicts expected on b0612dd
npm ci                          # root
npm --prefix apps/desktop ci    # test needs build:credential-policy
npm --prefix apps/console-web ci
npm --prefix apps/mobile-web ci
npm run check:public-hygiene    # must print "passed"
```

If main has moved, `git merge origin/main` first; the branch touches
`packages/chat-engine/src/live-work.test.ts` (one line), `docs/README.md` (one
line) and new files only.

## 2. Establish the baseline before any PR

The point of the baseline is a **named list of failing files**, not a count.

```bash
npm run typecheck
npm test 2>&1 | tee output/baseline-$(git rev-parse --short HEAD).log
grep -E "^not ok" output/baseline-*.log | sort | uniq > output/baseline-failures.txt
```

On a 4-core machine the suite takes roughly the CI time (about 35 minutes).
`scripts/run-tests-isolated.mjs` mints a private `CLEMENTINE_HOME` per file; it
never touches the live home. Pass `--test-concurrency 3` on a laptop that is
also running the installed app.

The known failing families on `b0612dd`, verified one file at a time on
2026-10-10 in a clean container, are listed in
`docs/checkpoints/2026-10-10-ci-baseline.md` with their classification (stale
pin, real defect, test-order artifact). Compare every later run against that
file; a new failing file is a regression, a vanished one is a fix to record.

Fast per-file loop while implementing:

```bash
node scripts/run-tests-isolated.mjs src/runtime/harness/model-roles.test.ts
node scripts/run-tests-isolated.mjs src/runtime/harness/model-roles.test.ts --test-name-pattern "all_in"
```

## 3. Build and the guarded hotpatch

The owner's acceptance environment is the installed app on the live home, by
the guarded hotpatch recipe (see `docs/checkpoints/2026-10-07-main-state-for-assistant-refinement.md`
"Traps that cost time today" and the 10-02 handoff §2). In short:

```bash
npm run build                      # daemon (rebuild after ANY commit, even docs, before a hotpatch)
npm run build:console-web
npm run build:mobile-web
npm --prefix apps/desktop run build
```

Then the guarded hotpatch with an idle app, a fresh native-shell snapshot and
empty updater staging, keeping rollback and both web trees. Verify the served
build through the authenticated build-info endpoint; a copied file is not served
proof. Trap from 10-07: a hotpatch does not carry new npm dependencies; if a PR
adds one, copy its closure into the installed daemon's `node_modules` or the
first relaunch fails.

## 4. Per-PR acceptance, in the installed app

Each brief ends with "Done when". These are the concrete fixtures to use. Every
fixture is named `clem-fixture …` so it can be found and cleaned up, and none
touches a personal Space, workflow or integration.

| PR | Fixture | What to observe | Measure |
|---|---|---|---|
| PR-00 | none | `Test` workflow on the PR reaches the unit step; failing-file list equals the baseline or is shorter | `output/baseline-failures.txt` diff |
| PR-01 | Write 40 fixture rows into `state/token-usage/<today>.ndjson` under a test `source` prefix (`clem-fixture-scorecard-…`), two roles, two models, one uncertified row, one fallover pair | Settings → Models shows both rows with the right numbers; phone matches; "Nothing measured yet" on a fresh window | none on the turn path; `measure:turns` on any chat turn unchanged |
| PR-02 | `POST /api/console/suggestions` test route with a `settings` proposal for `quick` | Card on desktop From Clem and phone; tap applies through the normal handler; Undo restores; "Never" suppresses a re-raise | — |
| PR-03 | Two families connected (e.g. Claude sign-in + a BYO key); fixture usage rows making a BYO model the measured faster helper (R2) | One suggestion under the worker role within the heartbeat window (or `GET …/recommendations` immediately); words name labels, not ids; accept → worker resolves to it | `measure:turns`: no added model calls |
| PR-04 | Connect a throwaway BYO provider (`clem-fixture-provider`, any OpenAI-compatible endpoint with a fake key is fine: the plan needs the catalog, not a call) | Plan card appears in place of the four buttons; "Let me choose" reveals them; accept → roles set; Undo | — |
| PR-05 | Flag on; worker intent with two models ≥ 8 samples (fixture outcome rows in `model-route-metrics.db` under a test intent) | Picks appear in the scorecard and receipt; flag off ⇒ previous resolution | — |
| PR-06 | Any read turn; a forced helper fallover (bench the current helper via a fixture dead-login row) | Receipt line carries calls/tokens/cached share/"checked by"; fallover line inside the turn | numbers equal `measure:turns` for that source |
| PR-07 | A turn that pauses with `kind: continue` (the plan-mode fixture from v3.18.30) | Continue tap resumes on desktop and phone; rail shows on a long task; manifest line on a fixture task with a declared manifest | — |
| PR-08 | Disposable home with a BYO key in `.env`; then the installed app with a throwaway provider | Key in vault with 0600, line gone from `.env`, receipt written; catalog browse still works | — |
| PR-09 | Ollama running locally with one small model | Found, suggested once, accepted → memory/quick on it; stop Ollama → `unreachable`, no failure words on Home | scorecard shows zero metered tokens for memory |
| PR-10 | The three-message slide/drafts/PDF conversation and the read-only drafts question from v3.18.35's validation, plus the nine 10-10 runs replayed | Verdict agreement; reviewer uncached input halves | `measure:turns` reviewer rows; `measure:judge-calibration` |
| PR-11 | A BYO model that refuses images (fixture turn with `view_image`) | "no images" chip on both surfaces; PR-03 stops proposing it for image roles | — |
| PR-12 | — | Mode switch from Settings writes the same payload as Advanced; reasons under every automatic label; ⌘K asks and runs | — |

Measurement rules (from the 09-19 and 10-07 checkpoints): same model, account,
fixture, tool surface and cache state for before and after; include worker,
review and repair calls; component timing is not proof; a substitution or a
failed-open review is not validation.

## 5. Handing a brief to the implementing agent

Give the agent this prompt, filling in the brief:

> Work on Clementine from branch `claude/next-level-plan-2026-10-10` merged onto
> current main. Read `AGENTS.md`, the three 09-19 checkpoints, then
> `docs/plans/next-level-2026-10-10/README.md` (rules in §3 are binding) and the
> brief `docs/plans/next-level-2026-10-10/PR-NN-….md`. Implement exactly that
> brief: its Files, Implementation, Tests, Done-when and Do-not. Keep the
> default behaviour byte-identical when the feature is off or nothing is
> accepted, and prove it with a characterization test. Run the touched test
> files one at a time with `node scripts/run-tests-isolated.mjs <file>`, then
> `npm run typecheck`, then the console and phone typecheck and build if you
> touched them, then compare the full suite's failing-file list against
> `docs/checkpoints/2026-10-10-ci-baseline.md`. Do not hotpatch the installed
> app, change the owner's settings, or create paid model traffic; leave live
> acceptance to the owner with the fixture named in the runbook. Commit on your
> own branch `claude/next-level/PR-NN-<slug>`, one PR per brief, with a
> description that lists the brief's Done-when items and how each was checked.

Order: PR-00 first. PR-07, PR-08 and PR-12 can run in parallel with PR-01.
PR-02 after PR-01. PR-03 and PR-04 together after PR-02. PR-05, PR-06, PR-09,
PR-11 after PR-03. PR-10 after PR-06, with its measurement before the default flips.

## 6. What to send back here

For each PR: the branch, the failing-file list diff against the baseline, the
`measure:turns` receipts where the brief asks for them, and the installed-app
fixture result. A dated checkpoint under `docs/checkpoints/` per PR that touches
the turn path (PR-05, PR-06, PR-10), in the style of the existing ones.
