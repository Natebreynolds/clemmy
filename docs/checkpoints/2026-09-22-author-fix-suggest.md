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

## Second wave, same day: the human-in-the-loop contracts (`b7f93fc6` → `5220d8d1`)

Owner's north star, recorded: Clem must create interactive workflows and
workspaces for any scenario with any tools, linked to human replies,
changes and updates. Fixture: a three-prospect outreach campaign
(fictional contacts, drafts only, never a send), authored from one request
in 13 min / 23 calls / 635k tokens, exercised on the installed app.

| Contract | Before | After (installed `5220d8d1`) |
|---|---|---|
| A gated step performs what the reviewer approved | 3 `write_file` calls refused `coverage_missing`; run blocked; diagnosis said "no tool was called" | 3 draft files written after approval; a refused write is now named as a refusal |
| A change note revises instead of cancelling | occurrence cancelled with the note; "re-run in chat" | note → `step_invalidated` → drafting step re-ran (28 s) → Jev revision check `applied` (0.77, 1.3 s) → gate asked again: "Revised per your note; the check confirmed it was applied" → approved → completed |
| The reviewer reads a draft | raw JSON | numbered items, labelled lines, long text as paragraphs |
| Any approval reads as a person would | `{"requirement_id":"cap:resolved:…","args_json":…}` | "Send message via Slack · Slack · SLACK_SEND_MESSAGE · Channel · Markdown text", raw call behind "Technical details" (desktop and mobile) |
| The Space follows the workflow | tiles stuck at "Drafts saved 0 / Not drafted 3" | "Prospects 3 · Drafts saved 3 · Not drafted 0" with the draft on each card; the stale authored phone summary is dropped on a later commit |
| What Clem sends anywhere shows on desktop and mobile | Slack post → "Workflow completed" only | every irreversible send mirrored as one in-app item (pinned; live proof owed: the test send is waiting on the owner's approval) |

Commits: `9e77e697` (gate coverage, revision path, readable draft, truthful
diagnosis), `d0235ba1` (send mirror), `6be305a7` (revision judge,
approval presentation, Space re-projection), `178e896d` and `5220d8d1`
(the judge in the one attempt wrapper; invalidation under the durable slug).
Three live-found traps on the way: the agent-lane hook never saw the graph
lane; the invalidation was written under the display name while the resume
reads the slug; the tsc at the root passed where the build's tsc did not.

Shell access, answered from code and the week's log: `run_shell_command`
is core in chat, workers and steps (51 runs this week, 0 approval cards);
cwd must be inside an allowed root; destructive shapes ask first
(rm/mv/chmod/kill/sudo/package installs/redirection); hard blocks never
approve (`rm -rf /` or home, sudo, shutdown, reboot, disk erase, `dd of=`,
fork bombs, mkfs, recursive chmod/chown on root or home, Clem's own stores).
A shell command wrapped in `work_call` is refused as effect-unknown with
the direct tool named as the recovery.

Still owed: the send mirror's live proof; a second scenario end to end
(content calendar synced to a Space); mobile not driven; the Space dock
session for chat-created Spaces (console 404s). Worker restored to
claude-haiku-4-5 at 17:08Z. Fixtures to delete: workflows `Prospect
outreach review`, `Digest check`, `Digest check 2`, `Invite digest`,
`Whats on my calendar today`; Space `Prospect campaign`; plan proposal
`plan-a1f3b23e`; the pending "Send Slack message" approval.

## Third wave, same day: the proven surface and the live pre-tag pass (`930c755f` → `1776a5b1`)

The morning's placeholder-question dead end had one root left: which
requests a proven strategy is allowed to *thin the surface* for. The
store's recall score is containment of the shorter keyword list, so a
three-word calendar strategy "touched" any longer request that mentioned
the calendar once. Two attempts kept a door open on the thinned surface
(`call_tool`, then the authoring tools) and each cost something live: the
brain wrapped the proven read through `call_tool` and lost a frame (98 s
turn), then a plain calendar question started with `workflow_create`
("tmp-cal-read", rejected by schema) with ~111k prompt tokens of authoring
schemas. Both were reverted.

The rule that held (`1a49645e`, `1776a5b1`): a strategy thins the surface
only when its keywords and the request's mostly coincide — shared words
over the union of both sets, at least half
(`provenStrategyCoversRequest`, proven-operation.ts). A near rephrase
("show me my calendar for tomorrow" against "what is on my calendar
tomorrow") skips the search; an authoring request that mentions the
calendar, short or long, does not; a request about something else that
shares two filler words ("whats … today") does not. A weak match still
offers the proven call — it just never removes the doors. The authoring
tools no longer ride through the skip. Pins in proven-operation.test.ts and
tool-catalog.test.ts.

### Live, on the installed app

Installed `1a49645e` by hotpatch (sealed 3.18.19), launched **by path**.

| Sample (`whats on my calendar tomorrow`) | Wall | Model | Calls | Prompt tokens | Note |
|---|---|---|---|---|---|
| `930c755f` ×3 (before) | — | 86.6 s / 52.2 s / 53.0 s | 3 | ~111k | sample 1 called `workflow_create` first |
| `1a49645e` sample 1 | 67.8 s | 54.4 s | 3 (tool_search, calendar read, tool_output_query) | 87k | skip applied (`skipDiscoverySearch: true`, 6.5k schema tokens); the brain still searched once before the read |
| `1a49645e` sample 2 | 11 min 26 s | — | 0 | — | **provider outage**: first frame silent 10 min → stream-stall retry → xAI "Internal error during token generation" → "Something went wrong on that turn" |
| `1a49645e` sample 3 | (see below) | | | | started while sample 2's retry was in flight; xAI still degraded |

Sample 2 is the ceiling of a one-brain home: the stall wall is 600 s of
no activity (model-stall-policy.ts), one same-brain retry follows, the
provider's in-stream internal error is already classified retryable, and
with `activeBrain: api_key` there is no second brain to fall over to. The
turn ended truthfully rather than hanging. It cost the person 11 minutes
of "Still working". Not changed before the tag; noted as the next
latency item (a shorter silence wall when the request is small).

### A trap found on the way

- `open -a Clementine` launches `/Applications/Clementine.app`, an old
  3.18.6 bundle (`32269b1e`) still beside the sealed `~/Applications` one;
  six bundles answer to the desktop bundle id on this machine. The old
  daemon held the live home for a minute, ran the pre-fix boot cap and
  re-parked 12 already-parked runs (no schema change). Launch by path and
  confirm `gitSha` + `entry` from build-info before driving anything.
