# Author, fix and suggest workflows — 2026-09-22

Continues `2026-09-22-authoring-spaces-latency.md`. Six commits on shared
`main`, `b7f93fc6` → `4857b064`, installed by hotpatch (three cycles) and
accepted in the installed app against the live home. No release was
published. Model roles during the tests: brain grok-4.6, judge grok-4.3,
worker moved to glm-5.3 for the window and restored afterwards.

The owner's direction: "Outside of adding verbs we need Clem to be
intelligent enough to author workflows, fix them, create them. Suggest them.
This is the last thing I think we need to really dial in before the tag."
No new chat tools were added. Existing tools got settled answers and a
repair shape; the host got two new pieces of judgement (a strategy scope,
a suggestion watch) and one restored door.

## Why users could not turn a workflow on or fix one

From the live home before this work (eventlog and run records, 09-12 →
09-22): every chat enable ended "Verifying … before it goes live" and the
turn closed with the workflow still off; the desktop drawer's Enable did
the same and then refetched once, so the switch the user had just flipped
showed off again. The creation test's verdict arrived minutes later as a
card, and 22 runs since 09-12 had parked as "connect outlook / salesforce /
googlesheets / provider" for providers that were connected. Fixing meant
resending the whole step graph through `workflow_update`; the brain hit
invalid JSON, a rejected transform op, the 5× loop guard and a TypeError in
the description of a workflow it had already written. Ten occurrences of
one workflow had been re-parked at every launch, one of them reaching 446
"restarts".

## What changed, at the class level

1. **Enabling is the creation test** (`b7f93fc6`). `workflow_set_enabled`,
   `workflow_update` and `workflow_edit_step` wait (bounded, inside a
   draining daemon) for the test they start and answer with the settled
   result — on, or exactly what still needs the user. The console
   set-enabled route still queues; the drawer now follows the test to its
   settled state ("Testing before it goes live…" → on, or the daemon's
   needs-review report), and the workflow detail carries the test as
   running / passed / needs review (`6305b3d9`, `cbfff5c8`).
2. **A failed test hands the brain the repair** (`b7f93fc6`). The creation
   test records structured per-step verdicts; the authoring receipt renders
   each flagged step's authorable shape and the one-call fix. `workflow_edit_step`
   accepts a `patch` (any authorable field, `null` removes, the host's
   account binding survives, validated, snapshotted, revertable), so no
   full-graph resend and no re-read is needed.
3. **Authoring writes exact call steps** (`b7f93fc6`). Call args gain
   `{{now}}`, `{{now+24h}}`, `{{date+1d}}`; the create description, the
   call schema and the proven-operation note say an operation the turn
   already proved is a `call` step and the host binds the account; a bare
   call step on a multi-account operation is routed from the run's origin
   conversation, re-proved and saved on the step.
4. **Strategies carry the scope they were learned in** (`6305b3d9`,
   `4857b064`). A strategy learned inside a workflow step is never offered
   to a chat request (the keyword matcher and the Jev staged path both
   apply it) and never suggested as a workflow; legacy records resolve
   their scope from the receipt's session on read (13 of 41 live records
   were step strategies).
5. **A proven turn keeps the local door** (`cbfff5c8`). `call_tool`
   survives the proven skip, so a tool the search discloses is callable.
6. **Workflow suggestions** (`6305b3d9`, `f32c573b`): the second watch on
   the heartbeat contract. Deterministic evidence only (proven strategies
   re-selected by chat turns, ≥3 turns on ≥2 days in 30, a real work tool,
   no saved workflow that runs those tools *and* is about the same thing),
   one plan-proposal card at a time, approve = `workflow_from_session` on
   the chat that last did the work, decline remembered 30 days, own switch
   and cadence under Autonomy → Watches.
7. **Parked runs stay parked at boot; a non-string input default no
   longer crashes the description** (`b7f93fc6`).

## Measured on the installed app, live home

**Fix.** Fixture: a manual workflow whose `read_file` step names a
misspelled path; the console created it and its creation test failed.
Request on a fresh desktop session: "The Digest check workflow failed its
creation test. Fix it — the file it should read is
output/invite-digest/digest.txt — and turn it on."

| Build | Wall | Calls | Searches | Prompt tokens | Ending |
|---|---|---|---|---|---|
| `eebd4239` before | 173 s | 21 (workflow_get ×5, tool_search ×7, workflow_update) | 7 | 542k | done, but "Enable is running a creation test now; it'll turn on automatically" |
| `b7f93fc6` after | 120 s | 13 (workflow_edit_step patch, workflow_set_enabled settled in 18 s) | 2 | 269k | done: "Digest check 2 is on … the creation test passed" |

**Author.** Same request as this morning ("Create a workflow named 'Invite
digest'…"), fresh session each time.

| Build | Wall | Calls | Prompt tokens | Read step | Ending |
|---|---|---|---|---|---|
| `eca325f1` this morning | 333 s | 8 | 281k | prompt step (43 s on the worker per run) | done, enabled |
| `b7f93fc6` / `6305b3d9` | 400 s / 208 s | 4 / 6 | 36k / 62k | — | **needs_input on a placeholder question**: a step strategy matched the request, the proven skip removed every local door, `workflow_create` was found by search and could not be called |
| `4857b064` | 256 s | 5 (tool_search ×2, get, list, create) | 199k | **exact `call: OUTLOOK_GET_CALENDAR_VIEW` with `{{now}}`..`{{now+24h}}`** | done: creation test passed inside the create call, enabled |

**Enable from the page.** Digest check 2 disabled, drawer → Start creation
test: "Testing before it goes live…" with the running note, then "On —
runs on its schedule · Creation test passed (8:29:14 AM)" without leaving
the drawer (`output/calendar-watch/drawer-testing2.png`, `drawer-on.png`).
Before the slug fix the drawer had stopped following the test at once.

**Suggest.** Read-only proof against the home: 31 chat turns re-selecting
proven strategies in 30 days, 23 chat-scoped strategies, 109 saved
workflows → one candidate ("whats on my calendar today", 12 turns on 2
days), one covered by the fixture that reads tomorrow's calendar. Live
tick on the installed app raised that one card on Needs you
(`needs-you-suggestion.png`: "Workflow suggestion: you asked for 'whats on
my calendar today' 12 times over 2 days. Save it as a workflow you can run
or schedule?" with Approve exact plan / Reject). Both watches on Autonomy
(`autonomy-watches-2.png`). Approving the card ran the plan as a
background task: 6 min, 7 calls (workflow_get ×4, tool_search ×2,
workflow_create — the brain chose `workflow_create` with an exact
`OUTLOOK_GET_CALENDAR_VIEW` step over `workflow_from_session`), creation
test passed, and "Whats on my calendar today" exists enabled, manual-only.

**Boot.** The ten parked occurrences kept their counts and park times
through two launches.

## Not done, stated plainly

- The model emitted `ask_user_question("placeholder")` twice after long
  stalled frames when it had no door; the harness accepted it as a real
  question. A degenerate question is still delivered as needs_input.
- The routed-account log line for the exact calendar call was not observed
  in the daemon log; the step ran and returned data without parking, and
  `call.account` is not yet written on the saved definition.
- A scheduled run of `daily-standup-email` parked as "connect provider"
  (an operation whose toolkit is not registered) during the window; not in
  this slice.
- Mobile was not driven. The suggestion card renders through the existing
  plan-proposal surface on both apps, verified on desktop only.
- Two `orchestration-tools.test.ts` failures and one `tool-catalog.test.ts`
  failure pre-exist on `main`.
- Fixtures left in the owner's home: workflows `Digest check`,
  `Digest check 2`, `Invite digest`, the suggested `Whats on my calendar
  today` (if the approval completed), and the plan proposal
  `plan-a1f3b23e`. Delete when done. Updater `pending` folder still held.
