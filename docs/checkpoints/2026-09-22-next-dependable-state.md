# Next dependable state — 2026-09-22

Candidate delivered against `docs/JEV-FRAMEWORK-HANDOFF-2026-09-21.md`. Fourteen
commits on shared `main`, `8c11aa3c` → `a1f1f986`, accepted in the installed app
against the live home. No release was published; the working tree holds only the
other agent's uncommitted handoff document.

## Installed identity

| Item | Value |
|---|---|
| Bundle | `~/Applications/Clementine.app`, sealed **3.18.19** (reinstalled from the updater's own signed zip after a broken-seal launch, see below) |
| Daemon dist | hotpatched to commit `a1f1f986`, fingerprint `3402954c67e25ec34f11418b1639ed564c99b8c6b9290d8b5ad8f02eeed21df6`, schema 81 |
| Daemon pid at acceptance | 49129, started 05:49:51Z |
| Web apps in the bundle | `console-web` and `mobile-web` dists rebuilt from the same commits |
| Live home | `~/.clementine-next` |
| Served models | brain grok-4.6, judge grok-4.3, worker claude-haiku-4-5 (moved to glm-5.2 for the test window, restored), Jev `jev-1.13.0` served for `jev-latest` |

Rollback: every hotpatch retained the prior `daemon/dist.backup-*`,
`builtin-skills.backup-*`, `apps/console-web/dist.backup-*`, and
`apps/mobile-web/dist.backup-*` inside the bundle; the newest of each is the
pre-candidate state. The signed 3.18.19 zip is at
`~/Library/Caches/@clemmydesktop-updater/pending.held-20260921-215159/`.
The pre-reinstall bundle is at `~/Applications/Clementine.app.broken-seal-20260921-215159`.

**The updater's pending folder is held.** `pending.held-…` must be renamed back
to `pending` (or deleted) when you want auto-update to resume. While held, a
quit does not reinstall 3.18.19 over the candidate; the app will re-download
the update on its next check.

## What changed, by cause

1. **Capability → invocation → result** (`a6aa0e87`, `8a432718`). The live
   failure (source 277962: a `cap:…` ref sent to `tool_output_query` thirteen
   times, no calendar call) is answered at the source: the two retained-output
   readers name a capability reference for what it is, hand back the exact
   carrier call, and list what the turn has actually retained. `tool_search`
   and both readers stay on the proven-skip surface (the readers had been
   removed after that loop; removing them created the opposite dead end).
   Record projections demote opaque tokens (etags, GUIDs, hashes) below
   readable fields, so start/end/subject survive a tight budget.
2. **Workflow choice → test → execute** (`1f045ec6`, `420db28b`, `b382e4b4`,
   `2517ec44`). A creation test that needs an account answer parks like a run
   and resumes as a creation test (mutations stay previewed); the answer is
   saved on the definition step as an exact (capability, account, choice-set
   digest) binding the compiler revalidates; a committed file's path is on its
   receipt so "save to <path>" contracts pass; both reviewers see every human
   review decision on the run.
3. **Human review** (`599cc785`, `4fd5cb26`). The card shows the actual draft;
   "request changes" is a decision with a note on desktop and mobile; the note
   is recorded on the run before the approval resolves and travels with the
   stop report.
4. **Truthful home** (`9fcdc042`, `99fd2b43`). Restart-cap parks are "paused,
   resume or skip" decisions in Needs you (one item per workflow), no longer
   "Waiting for approval" under Running.
5. **Noise removed** (`e7117e82`). An expired plan preparation gets its typed
   terminal once; the 16-second boot-scan warning loop is gone (0 lines from
   the new daemon after the first pass).
6. **Jev** (`610411f8`, `6dfa3583`, `a1f1f986`). The configured reviewer is
   hedged behind Jev (1 s) instead of raced; Jev's completion timeout is 2.5 s;
   every judge attempt carries its lane on usage rows; the watcher asks Jev the
   same "on track?" question in shadow and records agreement.

## Live acceptance (installed app, live home)

| Case | Before | After (candidate v5, `a1f1f986`) |
|---|---|---|
| "whats on my calendar tomorrow" (source 277962 on 3.18.18) | blocked, 301 s, 16 calls, 145k input, no calendar call | done, 69 s, 3 tool calls, 70k prompt (25k cached), Jev accepted at 280 ms, reviewer not started |
| same request on my first candidate (`e7117e82`) | done, 297 s, 16 calls, 425k prompt | done, 66–72 s, 3 calls, 70–86k prompt |
| calendar + a Google Drive read never used before, one turn | — | done, 148 s, 6 calls, 127k prompt; Drive discovered and called in the same turn |
| workflow created conversationally with a review step | — | created in 304 s, creation test passed, enabled on pass |
| review run: park → draft on card → request changes | — | note recorded, occurrence stopped with the note, approval resolved once |
| review run: park → restart → approve → duplicate approve | — | pending review survived the restart; second approve refused "already resolved"; file written |
| review run on `a1f1f986` | goal review 4/5, "saved without your review" | `completed`, terminal `succeeded`, goal validation pass |
| boot-scan warning loop | one line every 16 s for days | 0 from pid 49129 after the boot pass |

Accounting is `scripts/session-comparison.ts::measureAcceptedTurn`, read-only.
Wall times are single runs, not p50/p95.

Desktop walkthrough (Playwright against the installed console):
`output/handoff-review-fixture/home-before.png`, `home-after-restart.png`,
`inbox-request-changes.png`, plus the accessibility snapshots beside them.
Mobile: the installed bundle carries the new Approvals controls (verified in the
built asset); the phone UI could not be driven here because a device session
needs the owner's PIN or a handoff from a paired phone. Not physically verified.

## Jev measurements (last 24 h of usage rows before the hedge)

| Lane | Calls | Model-seconds | Input tokens |
|---|---:|---:|---:|
| brain grok-4.6 (chat) | 365 | 8,353 | 11.6M (64% cached) |
| judge grok-4.3 (chat + workflow + unattributed) | 253 | 1,527 | 1.57M |
| Jev, all sites | ~72 | ~45 | ~126k |

Jev on the candidate: hits at 270–988 ms, one timeout at 1,525 ms (before the
timeout change). With the hedge, an accepted Jev verdict no longer starts the
reviewer (`jevAttempt.reviewerStarted` records it per turn).

## Removed or retired

- The proven-skip narrowing that hid `tool_output_query`/`recall_tool_result`.
- The unbounded 16-second re-scan of an expired plan preparation.
- "Waiting for approval" as the label for restart-cap parks.
- The raced reviewer call on Jev hits.

## Fixtures in the live home (yours to keep or delete)

`Handoff review fixture` (enabled, manual), `Handoff calendar fixture`,
`Handoff account fixture` (both disabled), and `output/handoff-review-fixture/`.
No email was sent; only local files were written.

## Not done, stated plainly

- A natural creation-test account gate could not be provoked on this machine
  (the CLI read resolves to one account now). The park/resume/binding path is
  unit-pinned; the live park itself is unexercised.
- Re-running the same occurrence's draft step after "request changes" is not
  implemented; the note goes back to the owner conversation instead.
- Jev decides completion only; the trajectory verdict is shadow-only until its
  recorded agreement supports a switch. One small judge call per turn still
  lands without a lane (it does not go through the hedged judge).
- Cache: the brain runs at 64% cached input; the next lever is the prompt
  prefix order (memory context is variable and sits early), measured before
  any rewrite.
- The hotpatch flow needs Terminal.app (App Management permission) and a held
  updater; a patch onto a freshly installed sealed bundle silently prevents the
  daemon from spawning (recovered once tonight by reinstalling from the zip).
