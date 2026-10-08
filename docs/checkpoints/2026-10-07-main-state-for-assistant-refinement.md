# Main state for the assistant-refinement lane — October 7

Written by the Claude session working the Windows beta and the 3.18.30
batch suite, for the agent on `codex/assistant-refinement-next`. The owner
asked the two lanes to work alongside each other. Nothing in that worktree
was touched; everything below was measured on copies.

## How main moved under the refinement branch

The refinement branch is based on `7764412ef` (v3.18.29, schema 93). Main
has since taken, in order:

- `1a17e070d` **v3.18.30** (mac-only, schema still 93): "continue" and
  "go ahead" to an open question reach the brain with the question on hold
  on every brain and in both modes; plan mode proceeds on sensible defaults
  when the reply answers nothing; the interpreter retries once on a shape
  refusal and Jev reads an unreadable reply before any re-ask; the proposer
  speaks as Clem; the failed-action ending has three honest forms
  (pre-dispatch refusal, dispatch uncertain, terminal failure).
  Files: `task-continuity-runtime.ts`, `plan-first.ts`, `plan-continuity.ts`,
  `interpret-accepted-source.ts`, `clarification-revision.ts`,
  `chat-approval-resume.ts`, `pending-action-executor.ts`, their pins, and
  the autonomous-send crash matrix.
- `d4e6242e2` and the commits after it: the **Windows x64 beta** work
  (the `windows-beta-readiness` worktree, applied unchanged as a patch) and
  sixteen rounds of fixes measured on the real Windows runner. Product
  changes of note: Windows PowerShell launch programs carry no cmdlet (a
  cmdlet makes 5.1 analyze every module on the module path first, which
  never finished under a reduced environment), payloads over stdin are
  ASCII-only JSON (`src/runtime/ascii-json.ts`), the credential-policy
  bundle allows exactly four inputs (`apps/desktop/scripts/build-credential-policy.mjs`),
  `tsImport` callers pass file URLs, cancellation durability tolerates a
  read-only handle on Windows. The release workflow is untouched; the beta
  installer comes from `windows-private-beta.yml` (workflow_dispatch) as an
  Actions artifact, unsigned.

Version files on main read 3.18.30 (`package.json`, `apps/desktop/package.json`,
`package-lock.json`).

## Merge measurement (snapshot 12:3x PT)

The refinement branch's uncommitted tracked diff (9,698 lines, 91 files)
plus its 23 new files were applied onto main `7c5122df5` in a throwaway
worktree with `git apply --3way`:

- **Zero conflicts.** The only path present on both sides is the branch's
  copy of `docs/releases/v3.18.30.md`, which main already carries.
- Twenty files changed on both sides merged textually clean:
  `useChat.ts`, `mobile-routes.ts`, `console-routes.ts`,
  `pending-action-executor.ts`, `attempt-settlement.ts` (+test),
  `chat-approval-resume.ts` (+test), `plan-continuity.ts` (+test),
  `plan-first.ts` (+test), `task-continuity-runtime.ts` (+test),
  `clarification-revision.ts`, `interpret-accepted-source.ts` (+test),
  the crash matrix, `workflow-run-cancellation.ts`, and the three version
  files.
- Combined tree: root typecheck clean, console typecheck clean. The phone
  typecheck at the snapshot failed on `chat-control.ts` against the optional
  `activeSourceUserSeq`; the branch's own copy of that file changed again
  after the snapshot and its own phone typecheck passes, so that was
  in-progress work, not the merge.
- Test files on the combined tree (both sides' changes together), all
  green: task-continuity-runtime 55, plan-first 28, plan-continuity 26,
  interpret-accepted-source 23, chat-approval-resume 17, crash matrix 26,
  attempt-settlement 5, approval-card-edit 7 (the branch's new pins against
  main's card-edit module), terminal-delivery-resume-ledger 1.
  Final (14:5x PT, fresh snapshot of the finished branch on main `5ac8f3496`,
  branch `claude/refinement-32`): root, console and phone typecheck clean;
  98 test files the branch touches or overlaps, 1,456 tests, 1,451 pass.
  The five that did not: four are the preview's missing desktop
  credential-policy bundle (auth-grant 4/4 and credentials-bridge 3/3 once
  it is built), one is the branch's own stale pin on the queued-workflow
  acknowledgement wording it changed, updated on the branch (117/117).
  The branch's copy of `chat-approval-resume.ts` was the 3.18.30 three-ending
  fix; main's four-ending version (a tool's refusal in words is heard)
  supersedes it and is what the candidate carries.

## The v3.18.32 candidate is live (10-07 21:18Z)

`efc5120ce` = main + the batch, hotpatched (recipe 70) onto the installed
app, which the updater had meanwhile replaced with the signed v3.18.29
release. One trap for every future hotpatch: main's Windows work added
`@peculiar/x509` and `reflect-metadata`, which a hotpatch does not carry;
the first relaunch's daemon failed on the missing package until the
dependency closure was copied into the installed daemon's `node_modules`.
Live waves on the candidate: the new wave for the batch's corrections
(change-in-words then approve, Stop mid-work, two tool sources in one
answer) 11/11 turns clean; the 3.18.29 regression waves follow in
`~/clem-worktrees/takeover-kit/live/<label>` beside their `.pre32` receipts.

So a rebase of the refinement branch onto main is expected to be mechanical.
The semantic overlap to read with care is the reply router and plan
continuity, where both sides changed behaviour in the same functions.

## Division of work

- This session keeps the Windows beta (installer artifact for the owner's
  Windows testers), the 3.18.30 batch suite, and live acceptance on the
  installed Mac app.
- The refinement lane keeps its twelve corrections through to a built
  candidate. Its handoff leaves live validation as separate work: this
  session can run it with the wave runner (named synthetic fixtures, live
  models, installed app) once the candidate sha is named in the refinement
  handoff doc.

## Batch suite: pre-existing failures, do not chase

The 3.18.30 batch (1,860 files, one at a time, niced) is past file 777.
Every failing file so far failed identically on the 3.18.29 batch:
`autonomous-send-consent-crash-matrix.red` (fixed in 3.18.30),
`memory-model-route`, `claude-agent-brain`, `loop-structured-output-guard`,
`model-role-options`, `model-roles`, `respond-bridge-one-gate-wiring`.

## Traps that cost time today

- Push main before pushing a release tag; `release-desktop.yml` refuses a
  tag whose sha is not `origin/main`.
- Rebuild the daemon after any commit, even docs, before a guarded hotpatch.
- Anything imported by `credential-private-filesystem.ts` or
  `windows-private-filesystem.ts` must be in the bundle's allowed inputs.
- zsh never word-splits `$VAR`; a space-joined file list reaches the test
  runner as one argument and nothing runs.
- Never `git add -A` in a shared worktree.

## Shipped: v3.18.32 (10-08 00:09Z) on `f38c41e45`

The batch is on main and tagged, with these changes on top of it, each
found by a live run of the Slack reminder scenario on the installed app and
each pinned:

- A provider that answers a write with its own refusal envelope is read
  back, not parked: classification (`provider_refused_envelope`), the
  settlement no longer forcing `acknowledged = false` on returned failures,
  the checkpoint projection, the no-progress projection and the settlement
  audit all key on that detail; the ledger keeps the uncertain write's own
  directive (reconciliation owed, no replay).
- The batch's pin that an `{ ok: false }` envelope must block
  reconciliation was updated: that shape is the live dead end.
- The audit's repaired-write rule now applies to uncertain attempts, which
  restored the host-v1 exact-artifact recovery pin that had failed on every
  candidate commit since the batch.
- A definitive 4xx-class status closes the write as failed in the
  projection again (main's 2026-10-06 design); a 4xx on a mutation stays
  classified uncertain as the batch intended.
- `composioFailureProvesNoCommit` no longer compiles in an operation name.
- A card whose question the model left out asks in Clem's words.

Known limits recorded in docs/releases/v3.18.32.md. Two framework defects
for the next wave: an auto-resumed chat run can wedge the daemon's HTTP
server into a liveness kill loop, and each kill re-orphans it; the hard
reconciliation stop, when right, still speaks machine text.

## Windows x64 beta installer: qualified (10-08 01:40Z)

`windows-private-beta.yml` run 37712746814 on main `43b6d8821` passed every
gate on the real Windows runner: unsigned NSIS install (166 s, 16,330 files),
the real setup window driven through CDP, the authenticated daemon, the
mounted React dashboard with the served asset hashed against the installed
file, the mobile TLS loopback pin, a graceful quit, the installed storage
probe (event log, artifact bundle, encrypted payload store, staged blobs,
mobile identity retained), a restart on the same home that lists the
seeded session and exposes its text, a second graceful quit and the
retention read-back. Artifact
`clementine-windows-beta-3.18.33-windows.32-37712746814` (the `.exe`, its
blockmap, `latest.yml`, both receipts), 14-day retention. Unsigned: testers
click through SmartScreen. Not claimed by the smoke: models, OAuth, BYO,
Browserbase, a physical tester, phone pairing, LAN firewall.

Runs 20–32 on the runner, each one defect: PowerShell 5.1 cmdlet analysis
under a reduced environment (launch programs carry no cmdlet), ASCII JSON
over stdin, file URLs for `tsImport`, the setup marker under the selected
home, the probe resolver walking to the daemon root, every read through the
daemon on a cold first boot as a bounded retried wait inside the diagnostics
collector (headers and body both), and the storage probe's event type.
Method that ended the loop: run a probe that imports the daemon's dist on
the Mac with Electron as node against an isolated home before spending a
25-minute Windows run (`scratchpad/probe-fixture` in the session notes).
