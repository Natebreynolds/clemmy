# 2026-09-16 — mobile sign-in, usage meters, tidy, and the one-shot build gap

Owner-facing checkpoint for the uncommitted wave after v3.18.8. Everything
below is hotpatched into the owner's local install (`~/Applications`), pinned,
and not yet committed.

## 1. Phone showed nothing after a completed workflow

The scheduled Facebook brief completed and was delivered (Discord, Slack,
desktop toast) but the phone showed no trace of it. The store was right; the
phone was refused. Supervisor log: after the first burst of a visit, every
data request answered `401 BAD_DEVICE_PROOF` while `/auth/status` kept saying
"authenticated", so screens sat on stale or empty data with no sign-out.

Cause: mobile API and auth answers carried no `Cache-Control: no-store`, so
the phone's browser revalidated them (304). A 304 hands the page the STORED
copy's headers merged in, including a session-fingerprint header captured at
an earlier token rotation; the client folds any such header into its signing
state, so every later proof was signed over a retired fingerprint.
Ordering-dependent, so intermittent — it also explains the one refused
request per visit on the Home space tile and the old "bounced to login every
12 h" reports.

Fix: the mobile router drops conditional request headers and marks every
`/api`, `/auth`, `/push` answer `no-store` (never 304); the client's 401
recovery probes status live and adopts the live fingerprint; the door log
now carries the proof refusal reason. Pins: mobile-routes "never served from
a cache"; `proof-recovery.test.ts`.

Also found: no push subscription had ever been registered for a phone
(notifications must be enabled in the app), and "Workflow completed" rows
are silent by design — the brief is the completion notice.

## 2. Phone UI pass

"8·7·22" chip → words ("8 running" / "3 stalled"), spinner-only when the
Needs-you pill is also present so the title never reads "Ch…"; app header
hidden inside a conversation; chat rows show time only (1003 of 1049
sessions are "active", the word was noise); one touch-only press rule (no
scale/filter/gradient on `:active`). The "hover effects" were `:active`
transforms holding through a scroll — the phone app has no hover rules.

## 3. Restart flood (Chats list "active · 3m ago" at the top after every boot)

Ten chat sessions carry an in-flight marker recovery can never release (a
prepared workflow dispatch still owns the source, some from 08-25). Every
boot and tick re-appended `run_paused` / `restart_recovery_decision`
(bumping `updated_at`) and re-notified. `recoveryEventAlreadyRecorded` makes
those appends idempotent per (session, interruptedAt, phase/reason) and
suppresses the repeat notification. Pinned by a second-boot test. Live: a
boot appended zero recovery events and zero notifications.

## 4. Usage meters

Never deleted, only dark (moved off the TopBar into a hidden Home pane).
Now one builder (`src/runtime/harness/model-status.ts`) feeds
`/api/console/model-status` and `/m/api/settings/usage`; one presenter
(`packages/chat-engine/src/usage-presentation.ts`) feeds the desktop chips
(TopBar, subscriptions only), the Settings › Connected panel (every account)
and the phone Usage card. Grok is a real meter: xAI returns
`x-ratelimit-{limit,remaining}-{requests,tokens}` on every completion
(probed live through the daemon's token refresh), captured by
`recordByoRateLimit` in the BYO fetch wrapper. Every account shows today's
ledger spend. Codex's provider currently sends only the weekly window; the
5h slot is honestly absent.

## 5. Working-now count ("Running 8" with nothing running)

Two server lies: run files in `blocked_readiness` fell through the lifecycle
map as `accepted`; unfinished chat attempts with no lease holder reported
`unknown`, which the presenter may not demote. Now `blocked_readiness →
blocked`, and an unleased unfinished attempt older than 30 min reads
`stale`. Live after patch: 0 running, 7 need you, 30 stalled.

## 6. Tidy — one door for clutter, on both surfaces

`src/runtime/tidy.ts`: `planTidy(policy, now, scope)` (exact ids + counts,
nothing changes) and `applyTidy(plan, classes)`. Scope `stale` (age policy:
asks 24 h, runs 24 h, conversations 14 d) or `all`. Classes: updates
(marked read with the phone's live guards), asks (approval cards, plan and
trust proposals, check-ins, and workflow runs parked/asking — declined by
stopping), stuck runs (blocked/readiness/error run files and chat attempts
no runner holds), conversations (archived via `patchUnifiedSession`, never
deleted; idle clock = last `user_input_received`, since `updated_at` is
bumped by system events). Routes: `/api/console/tidy/{plan,apply}`,
`/m/api/tidy/{plan,apply}`. UI: desktop Settings › Clean up (Clear stale /
Clear all per class, Clear everything behind one confirmation), Inbox
"Clear all" on Needs you and Updates; phone Settings › Clean up. The phone
chat list now excludes archived sessions (`listSessions({archived:false})`).

## 7. Missed 9 am team Slack update

Yesterday's 4 pm run was interrupted by hotpatch restarts and resumed at
each boot until the boot-resume cap parked it (correct). The scheduler
treated any parked run as "awaiting approval" and silently skipped the 9 am
occurrence. At the next boot the parked run was cancelled, the missed
occurrence was accepted 46 min late, and the workflow's own runner refused
it (today's activity must run within 15 min of its occurrence). Fix: a
cap-parked run is marked `bootResumeParkedAt` and no longer holds the
schedule; a real approval hold that skips an occurrence now notifies once
per day. Pinned. The 4 pm run fires on time.

## 8. The one-shot build gap (buddy's "bretts-day" workflow)

A good plan died in Execute. Four failure classes, in order of leverage:

1. **Plan rigidity at an authoring step.** The reviewed plan bound the step
   to `workflow_create`; when its creation test said "found issues, left
   DISABLED", the model's repair call (`workflow_update`) was refused as a
   substitution twice, and the turn stopped at `repeated_refused_frame`
   with every later step unrun. FIXED: a reviewed `workflow_create` (or
   `workflow_from_session`) step is completed by its closed set of repair
   companions (`workflow_update`, `workflow_edit_step`,
   `workflow_apply_contract_fixes`, `workflow_capability_resolve`,
   `workflow_set_enabled`, `workflow_get`, `workflow_state`). Pinned.
2. **Operation names guessed by the model** (`OUTLOOK_OUTLOOK_LIST_EVENTS`
   → `exact_definition_unavailable`). The creation test reports "not
   connected or wrong name" and disables. OWED (design): resolve every step's
   operation at `workflow_create` time against the live catalog the same
   way chat discovery does — auto-rebind on one clear match within the
   toolkit, otherwise return the three real names — so the model fixes in
   one round, or never has to.
3. **Account choice** (two Fathom accounts → `account_selection_required`).
   OWED: pin the nominated default at creation; when ambiguous, hold ONE
   labeled question (the awaiting-capability path already exists) instead
   of disabling the workflow with opaque connection ids.
4. **Salesforce written as a shell command.** Workflow steps cannot run
   shell; the reviewed read `salesforce_sf_soql_query` is the step tool
   (workflow-run-readiness already admits it). OWED: the creator maps any
   Salesforce read to that operation and the tool guidance says so.

The strategic rule behind all four: a plan step that authors something
(workflow, space) is a FAMILY of calls, and the host resolves bindings at
write time from its own catalog rather than grading the model's guesses
after the fact. Reproduction needs the buddy's session export or daemon log
to confirm which frame was refused; the companion fix covers the case the
card text implies.

## Owed

- Items 8.2–8.4 above (creation-time resolution, account pin, Salesforce map).
- Release the ten in-flight chat markers whose prepared dispatch is weeks old
  (needs a release primitive in workflow-run-queue).
- Per-conversation archive on the phone.
- A catch-up policy per workflow (a late fire that the runner will refuse
  should be skipped with a notice, not run).
- Full suite on this wave (first run was cut by the tool's time cap; a
  detached run is in progress).

## 9. Space CLI sources execute (evening)

A Space data source declared as a frozen command line had never run: the
runner's CLI branch was an unconditional stub that answered "no shared durable
call authority" regardless of trust. A frozen argv whose head is a reviewed
CLI read is now compiled into that operation (catalog-driven: head plus the
declared argument map; prefix flags dropped; an undeclared option refused by
name) and runs through the same read-only kernel activation and the same
just-in-time acquisition a workflow step uses. No second executor, no shell.
The kernel hands back the carrier envelope; a clean JSON exit stores the parsed
payload so the view reads the command's own shape, a non-zero exit is a failed
refresh naming the exit and the stderr tail. One recogniser for that envelope
(`readHostCliEnvelope`) now serves both the Space write and the stored
tool-output reader. Live: the My Day Salesforce source refreshed with 41 open
opportunities, no approval card, alongside Outlook and Slack.

## 10. Space design layer

A view was authored from a blank page inside a 24 KB budget with no palette, no
theme, no font, no formatting helpers, and no components; the phone never sees
it. Every served view (and every published snapshot) now carries a framework
design layer: the shared semantic tokens in light and dark (following the
desktop's explicit theme through a `?theme=` handoff, else the system), a
zero-specificity base so any authored rule still wins, a full-width page
container, and a `.clem-*` vocabulary (KPIs, sections, lists, tables, tags,
buttons, empty, pending, error and source-freshness states). A pure helper kit
is merged into the frozen `clem` bridge: `clem.fmt` (money, number, dates,
relative time, plural, truncate, escape), `clem.ui` (HTML builders that escape
every field), `clem.sources()` and `clem.theme()`. The tool text describes the
layer, the kit, and a view standard: fill the frame, headline numbers, what
needs the user today, context grid, every state rendered. Existing views are
untouched until rebuilt.

## 11. The 15-minute triage runs

`scorpion-inbox-triage` ran 3 to 15 minutes every half hour. Two causes, both
visible in the journal: in three of eight runs the Codex brain started a
response after the inbox read and produced nothing actionable for 302 s before
the host watchdog fell over to Sonnet (the router's 150 s first-content budget
only guards a model that never starts); and every step re-typed its data
through the model's output, the publish step alone spending 2.4 min on 21 KB.
The publish step is now a model-free transform plus call step (the Friday
dashboard's shape); proven live in seconds. Converting the inbox read to a
call step worked once and then blocked on an empty capability observation
refresh, so it stays a model step. OWED: the Composio call-step observation
refresh returning nothing after the first run; a string-typed call argument
fed an object by a full-token template needs a transform (the set-data
contract could accept the object); creation-time compilation of single-tool
fixed-argument steps into call steps.
