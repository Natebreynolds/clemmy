# Workflow builder, slices 1–4: a workflow opens to its graph, a step is changed in place, Clementine's reply carries the workflow, and the last run shows on the graph (2026-09-26)

Branch `claude/wf-builder-slice1` (worktree `~/clem-worktrees/hotpatch-0926`), on top of
`claude/hotpatch-0926` 10b88cca9 (the installed 09-25 23:01 candidate: checker-evidence +
agent-desks + wf-builder-save). Plan page: claude.ai/artifact/8N4TwCEwwMn4zzBTiKwyUk.

## Owner decisions (09-25 ~23:15 PT)

1. Opening a workflow lands on a full page (decided 09-25 21:45).
2. A step's everyday four are editable directly: what it does, ask me first, keep going if it
   fails, run once per item. Everything else stays under Advanced or goes through Clementine.
3. Changing a live workflow keeps the safety net: pause, quick test, back on. The page says so
   before the save.
4. Step placement is saved beside the workflow, so every device sees the same layout. It is
   not part of the definition, so moving a box never triggers a re-test.
5. Clementine's chat card after a create or change shows a small graph with changed steps
   marked, plus Open to edit.

## What slice 1 does

- `/automate/:name` is the workflow's page (`apps/console-web/src/screens/WorkflowPage.tsx`).
  Top: the name, the description (click to edit), On/Off (turning on runs the creation test
  and follows it), the schedule in words, Run now (or the certification's primary action).
  Middle: the steps as the React Flow graph the daemon compiles, with the existing rewire /
  add / remove / revert / save. Right: the step you click, read-only: what it does (the stored
  prompt), how it runs (AI · model, Skill, Script, Direct call · tool), whether it asks first,
  keeps going on failure or runs once per item, what it waits for and what waits for it, the
  tools it may use, what it reads and produces, and any readiness verdict. "Ask Clementine
  about this step" opens chat with the workflow and step named (`/chat?prompt=`). Before a
  step is picked the panel shows the workflow's shape (steps, reads, writes, sends, approvals)
  and the certification summary. Advanced (collapsed; `?advanced=1` opens it): schedule,
  model pins, the Readiness panel, delete.
- Placement sidecar: `src/memory/workflow-layout.ts` reads and writes `<workflow>/layout.json`
  beside SKILL.md. `GET /api/console/workflows/:name` now carries `layout`;
  `PUT /api/console/workflows/:name/layout { positions }` stores it (400 malformed, 404 unknown,
  409 legacy single-file layout). Positions are pruned to the definition's step ids and
  rounded. No `workflow_changed` is emitted and SKILL.md is untouched (pinned).
- The console prefers the shared layout, falls back to the browser copy
  (`choosePositions`), and writes both after a drag (shared copy 600 ms after the drag ends).
- A refetch (the change stream fires on every daemon write) redraws the graph when there are
  no unsaved edits; with unsaved edits it says the workflow changed elsewhere and offers Reload.
- Automate list: name, description and "Open" go to the page; the readiness/primary-action
  button opens the page with Advanced expanded; `/automate?workflow=<name>` forwards there;
  `/automate/:name/canvas` forwards to the page; `/advanced/canvas` still lists workflows. The
  side panel (`WorkflowDrawer.tsx`) is no longer opened from the list; its Readiness panel is
  reused on the page and `WorkflowHowItWorks` still serves Create with Clementine.

Pins: `src/dashboard/console-workflow-layout.test.ts` (5), `apps/console-web/src/lib/
workflow-step-view.test.ts` (8). Root and console tsc clean.

## Slice 2: change one step (d7cd9b4d1, a82ca2d0a)

- The panel edits the everyday four: what the step does, ask me first, keep going if it
  fails, run once per item (choosing the step whose items it runs over, from the steps it
  waits for). Save sends only what changed (`stepPatchFromDraft`); a flag turned off is
  removed, not stored as false. Discard returns to the stored step.
- One path for every step edit: `src/execution/workflow-step-edit-live.ts` wraps the
  snapshot + validate + write of workflow-step-edit.ts and adds the live rule: a workflow
  that is on and whose execution surface changed is written off, its owner is notified, and
  a creation test is queued that turns it back on. `workflow_edit_step` (the chat tool) now
  calls it and still waits for the test; the console route returns at once and the page
  follows the test through the workflow's `creationTest` state. `optional` is now patchable.
- Routes: `POST /api/console/workflows/:name/steps/:stepId { patch }` (400 with the daemon's
  reason for an unknown field, a no-op, an empty prompt; 404 unknown step),
  `GET /:name/step-edits` (this workflow's reversible edits, newest first, no definitions),
  `POST /:name/step-edits/:backupId/revert` (404 for another workflow's backup).
- Undo last change reverts the newest edit of the open step, whoever made it. Test this step
  queues the one-step run (`POST /:name/run { targetStepId }`), follows it in the panel, and
  Open run lands on that run over the Automate list (`/automate?workflow=<name>&run=<id>`).
- The open step stays selected when the graph is redrawn after a save, an undo, or an edit
  from chat (a82ca2d0a; the first live pass lost the panel on every save).

Pins: `src/dashboard/console-workflow-step-edit.test.ts` (4: the four fields change and
nothing else moves, revert + listing + cross-workflow refusal, refusals write nothing, a live
workflow is written off with the test recorded); `workflow-step-view.test.ts` (+1 draft →
patch); chat tool suites 131/131 after the refactor.

## Live acceptance, slice 2 (09-25 23:56–00:00 PT, installed b6656b09c)

Installed together with the peer session's `claude/agent-switch` (merged --no-ff); build-info
served b6656b09c. Fixture `FRAMEWORK-TEST step edit fixture` (off; collect → summarize →
review), created through the API and deleted afterwards. On the served page:

- Changing summarize's wording and turning on Asks me first + Keeps going, then Save step:
  the panel stayed open, said "Saved.", and GET showed the new prompt, `requiresApproval:
  true`, `optional: true`, `dependsOn` untouched; `step-edits` listed one reversible edit
  described as "console step edit summarize (prompt, requiresApproval, optional)".
- Undo last change: the panel said the daemon's "Reverted … to its pre-edit definition" and
  GET showed the original step; a second revert of the same id is a 404.
- Runs once per item offers `collect` (what summarize waits for); Discard drops the draft.
- Test this step on collect (a no-tool step): the panel showed Queued → Done with Open run;
  the run record has `targetStepId: collect`, status completed; Open run landed on
  `/automate?workflow=…&run=…` with the run drawer over the list.

## Slice 3: Clementine's reply carries the workflow (598fec378, 6e178a7b5, f5c63d417)

- After `workflow_create`, `workflow_update` or `workflow_edit_step`, the reply shows a card:
  the workflow's name, what changed ("2 steps changed", "created · off until you turn it on"),
  the step chain by dependency level with changed steps marked and new ones labelled, and Open
  to edit onto `/automate/<name>`. Same card on the phone (informational, no link).
- The card is drawn from the SAVED definition, never the tool call. `withWorkflowCommit` (the
  helper every authoring tool returns through) publishes a `workflow_saved` event to the asking
  chat when the caller names the definition it started from (`before`, null for a creation):
  `src/execution/workflow-saved-event.ts` reads the file, builds the steps with the graph
  builder (effect, gates, dependsOn), and marks the step ids whose behaviour changed (prompt,
  dependsOn, gates, forEach, tools, call, skill, model, contracts; a reworded description marks
  nothing). The event names the exact accepted user input (`sourceUserSeq`).
- Every allowlist between the log and the screen admits it: `EVENT_TYPES`, the public
  projection (bounded, re-validated), the bridged lists, the chat engine's `ACTIVITY_FOLD_EVENTS`,
  the console's own delegation list in `useChat.ts`. The chat engine reduces it to a receipt-only
  row (`ActivityItem.workflow`); `workflowCards()` dedupes by workflow, newest save wins;
  `workflowCardLevels()` lays the chain out.
- Reopen: the transcript attaches each reply's saved workflows to that reply by exact source
  (`UnifiedSessionTurn.workflows`); the console maps them back into the same rows. The phone
  replays events, so it needed nothing.
- Create with Clementine draws its right-hand canvas from the same event (the stream withholds
  tool arguments, which is why its live draft never drew).
- Ask Clementine about a step still opens chat with `/chat?prompt=About the "<step>" step of my
  "<workflow>" workflow: `; the model reads the step with `workflow_get`. Putting the step in
  the session's context directly is not done.

Pins: `workflow-saved-event.test.ts` (3), `turn-receipt.test.ts` (+1 card), `transcript.test.ts`
(+1 reopen), `event-coverage.test.ts` holds; chat tool suites 104/104.

### Live acceptance, slice 3 (09-26 00:24–00:47 PT, installed 8c26a5daf → 6e178a7b5 → f5c63d417)

Fixture `FRAMEWORK-TEST card fixture` (off; collect → summarize → review), created by API and
deleted afterwards. Three real chat turns on the owner's brain asked Clementine to change the
summarize step's wording; each landed through `workflow_edit_step`.

- 8c26a5daf: the `workflow_saved` event was in the log (seq 306089, right session) but no card
  drew: two client allowlists did not admit it. Fixed in 6e178a7b5.
- 6e178a7b5: the card appeared live 21 s after sending, with the right subtitle and the changed
  step marked; reopening the conversation lost it because the transcript carries only text.
  Fixed in f5c63d417.
- f5c63d417: card live in 12 s; still there after a reload; Open to edit landed on
  `/console/automate/FRAMEWORK-TEST card fixture` with the three-node graph.
- Not live-checked: the phone card, and Create with Clementine drawing from the event.

## Slice 4: the last run on the graph, honestly (58327f815, 4117d82c9)

- A Last run tab on the workflow page (`view` state in `WorkflowPage.tsx`) colours each node by
  what the run did, from `GET /:name/runs/:runId/graph-overlay`: Done (with duration), Working,
  Waiting on you, Waiting for your answer, Waiting for a connection, Blocked, Redoing, Failed,
  Skipped, Not started. A recent-runs picker, a headline that counts states in plain words
  (`runHeadline`), Open run onto the full run drawer. The overlay refetches every 3 s while the
  run can still change (`runStillGoing`). Clicking a step shows why it waits or failed, what it
  produced, when it started and finished, tool calls, attempts, items, approvals, tools, models,
  and "Edit this step" back to the Steps view. Rewiring is off in run view.
- The daemon overlay (`src/dashboard/workflow-run-overlay.ts`) gained the states `blocked`,
  `awaiting_approval`, `awaiting_input`, `awaiting_capability`, `redoing` and reads the runner's
  tags for them: a park logged as `step_failed` with `meta.reason parked_on_*`; a deliverable-less
  finish logged as `step_completed` with `meta.blocked`; `step_invalidated` after a change request;
  `approval_requested` marks waiting until granted; and, found live, a declarative approval gate
  parks the run at `step_started` with `meta.gate: 'awaiting_approval'` and writes nothing else.
  Waits and blocks are counted on their own (`waitingSteps`, `blockedSteps`) so they never inflate
  failed or working; verdict labels and primary actions name the wait.
- Both client run readers (`apps/console-web` and the verbatim phone copy) already read the
  `parked_on_*` and `meta.blocked` tags; they now also read the gate at `step_started`, so the run
  drawer and the phone stop saying "running" for a step waiting on the owner.

Pins: `workflow-run-overlay.test.ts` (+2), `workflow-run-view.test.ts` (4), console
`workflow-run-detail.test.ts` (+1).

### Live acceptance, slice 4 (09-26 09:11–09:20 PT, installed 16d6c0168 → 4117d82c9)

Fixture `FRAMEWORK-TEST last run fixture` (collect → summarize → review with `requiresApproval`),
enabled directly (no external reads, so no creation test), run once from the API on the owner's
brain; it parked at the review gate (run status `parked`, approval apr-j30j). Cancelled and
deleted afterwards.

- 16d6c0168: the tab drew the run, collect and summarize Done with durations, but review read
  Working: the gate park is a tagged `step_started`, not a `step_failed`. Fixed in 4117d82c9.
- 4117d82c9: review reads Waiting on you on the node and in the panel ("Waiting for your
  approval; the run resumes once you decide", Next: Resolve approval); headline "Running · 2 done ·
  1 waiting on you"; the collect panel shows Done, what it produced, and its facts; Edit this step
  returns to the editable panel.

### Install coordination, 09-26 morning

The 09:02 install of 58327f815 replaced 83e196ee3 (clementine-next-f8's token-efficiency and
review-latency work, installed 08:23) and interrupted its measurement run; a peer's hold arrived as
the patch ran. Restored at 09:10 as 16d6c0168 = slice 4 + `claude/judge-latency` 9b8d05270 (f8's
shipping line, without the two measurement-only commits, at f8's request). Rule recorded: read
build-info and message peers before every quit; a peer's wait loop naming the bundle path blocks
`hotpatch-daemon.mjs`.

## Not in these slices (next)

- Slice 3 leftovers: phone card live check; Ask Clementine with the step in the session's
  context rather than a prefilled line.
- Slice 3 (done): the chat card from the saved definition, live redraw of the open page (the
  refetch half exists), Ask Clementine with the step already in context.
- Slice 4 (done): a few overlay verdicts still say "Needs attention · Review tool preflight" for a
  clean no-tool step (one advisory from harness evidence); worth a look, not a builder defect.
- Traps: git tracks `apps/console-web/src/app.tsx` in lower case while the file on disk is
  `App.tsx`, so `git add App.tsx` stages nothing here; and touching ANY file (even under
  docs/) during `npm run build` fails it with "source changed during candidate build".

## Live acceptance (09-25 23:29–23:31 PT, installed app, live home)

Hotpatched e6065c91a (fingerprint 631ad814ce54…) into `~/Applications/Clementine.app`
(daemon + console-web + mobile-web dists; backups `daemon/dist.backup-fciish`,
`apps/*/dist.backup-20260925-232901`); `/api/console/build-info` served the same sha.

Fixture `FRAMEWORK-TEST layout fixture` (3 steps: collect → summarize → review, the last with
`requiresApproval`), created through POST /api/console/workflows, turned off, and deleted
afterwards (404 and directory gone). Checked on the served page (headless Chromium, 1440×960):

- `/console/automate/<name>` renders the name, the description, Off, "Only when you start it",
  Enable workflow (the certification's primary action) and Run now.
- The graph draws the three steps at the sidecar's positions; clicking `review` fills the panel
  with the stored prompt, "AI · default model", "Writes", Asks me first = Yes, Keeps going = No,
  Runs once per item = No, Waits for `summarize`, Data "Reads summarize", and the Ask
  Clementine button.
- Advanced expands to schedule, models, readiness and delete.
- Dragging `review` 120 px down wrote the shared sidecar within 1.5 s: GET returned
  `review: {x: 600, y: 167}`; SKILL.md untouched; no `workflow_changed` (the list did not refetch).
- The PUT dropped a position for an unknown step id (`ghost`) as designed.

## The clock stamp (221db7398) and the heartbeats slice (09-26 morning, installed 999df3f92 → fbf740226 → b6541b6a8 → 689cce57c)

**Clem said Friday on Saturday (09:50 PT greeting).** The per-turn context was right (the Now
line is first); the model slipped and review let it through. Fix, not a regex: the same snapshot
is now also stamped LAST in the per-turn context as `## Right Now` ("Right now it is Saturday,
26 September 2026, 9:50 AM (PDT)."), minute precision, in the volatile tail so the cached prefix
is untouched (`src/agents/harness-context.ts`, `renderRightNowStamp`, VOLATILE_CONTEXT_TITLES).

**Heartbeats: one place for everything Clementine checks on her own.** Owner's brief: proactive
heartbeats that look at work done and offer help; the owner must be able to refine them along
with Clem; intelligence + token efficiency; Clem still a partner.

- Registry `src/agents/heartbeats.ts`: `work-review`, `calendar`, `workflow-suggestions`; one
  status shape (enabled, cadence in a per-heartbeat range, quiet hours, last tick, last finding,
  metrics, open items, recently retired, contract); `tickHeartbeat(id, source)` for Check now.
- Contract per heartbeat `src/agents/heartbeat-contracts.ts` → `state/heartbeats.json`: notify
  `quiet` (items stay in the app) | `push`, and rules in the owner's words, each marked `by:
  owner | clementine`. Duplicate / empty / too long / too many are refused, not silently kept.
- Work review `src/agents/work-review.ts` (pure) + `work-review-runtime.ts` (reads, Jev, state
  `state/work-review.json`). Deterministic reads: workflow run records (waiting statuses blocked*/
  parked/paused/awaiting_*; failures `failed`/`error` within 24 h; `creation_test`, completed,
  cancelled and one-step tries ignored), waiting chats from run-events, unsent drafts under
  `drafts/`. Waits are grouped per workflow / per chat title (one item, several refs), a wait
  counts after 2 h, a draft after 1 h, nothing older than 7 days. Each new item goes through
  Jev ONLY when the owner has rules (`tryJevHeartbeatItemVerdict`, channel `jev-heartbeat`,
  metric lane `heartbeat_rules`), 12 calls per tick, the rest held for the next tick rather
  than surfacing unjudged; Jev unavailable = keep the item (fail open, quiet). An item is a
  notification kind `execution` with `metadata.heartbeatId/itemKey/changeKind/refs/count`,
  `inboxOnly` when quiet; it retires on its own when the run resumes / chat is answered /
  draft leaves, and its card is marked read so it leaves Needs you. Needs you admits open
  heartbeat items (`src/dashboard/needs-you.ts`; note the older boolean `metadata.heartbeat`
  convention is skipped there, hence `heartbeatId`).
- Rules change → live items are judged again (689cce57c): a rule added later quiets open items
  it covers ("2 now skipped by your rules"), a removed rule brings them back with a fresh card
  ("2 back after a rule change"); once per rules version (`judgedAt` vs contract `updatedAt`);
  no rules = no model call; failures already shown are not live and are left alone.
- Surfaces: `/heartbeats` page (`apps/console-web/src/screens/Heartbeats.tsx`; nav entry lands
  under More for saved prefs): on/off, cadence words, delivery, last finding + metrics, open
  items, rules add/remove, Check now, Refine with Clementine (opens chat with the heartbeat
  named). Routes `GET /api/console/heartbeats`, `PATCH /:id`, `POST /:id/tick`, `POST /:id/rules`,
  `DELETE /:id/rules/:ruleId`. Tool `heartbeat_refine` (status | add_rule | remove_rule | set)
  edits the SAME contract, so a sentence in chat and a rule typed on the page land in one place.
  Registered in `src/tools/tool-registry.ts` (b6541b6a8): without the static registry entry the
  brain never saw the tool (10:48 live: it searched, then tried to hand-write
  `state/heartbeats.json` and the write boundary refused it, which is the right floor).
- Daemon: `startWorkReviewHeartbeat()` in `src/daemon/runner.ts`; policy `workReviewEnabled`
  / `workReviewMinutes` (60, 15–1440) in `proactivity-policy.ts`.

**Live acceptance (installed app, live home, headless Chrome):**
- First tick raised 3 duplicate chat items, no failures (records say `error`), 5 held on a
  budget of 6, Needs you empty → grouping, both failure spellings, 7-day cap, budget 12,
  Needs you admission, mark-read on retire (fbf740226). Second tick: "6 raised, 4 judged
  routine, 6 resolved"; Needs you showed 4 Still waiting + 2 Unsent draft.
- 11:00 PT chat: `About my "Work review" heartbeat: stop telling me about unsent drafts, I file
  those myself. Keep everything else.` → Clementine (DeepSeek V4.1 Flash as writer) called
  `heartbeat_refine`, rule landed in 34 s marked "Added by Clementine, from what you said", reply
  in 21 s / 2 steps and honest about what stayed. Tick: `0 raised` (drafts still open) → gap →
  689cce57c → tick: "2 now skipped by your rules"; rule removed → "2 back after a rule change".
  The test rule was removed afterwards; the owner-side fixture rule "Skip anything from test or
  fixture workflows (FRAMEWORK-TEST, harness-, clemmy-)" was left in place (added during
  acceptance; useful, owner may delete it on the page).
- Test chats archived; no fixtures left.

**Owed:** cancelling a workflow run leaves its approval card pending (rejected by hand,
apr-j30j); a rule change while Jev is dark retries every tick within budget (by design, costs
calls); calendar and workflow-suggestions heartbeats keep their built-in rules (owner rules are
kept and shown to Clementine, not yet applied by Jev); push delivery to the phone is the next
phase (no APNs key, PWA web push unverified).

## iOS notifications: why nothing arrives, and what changed (09-26 11:00–11:25 PT, installed 03e05703e)

**Read-only diagnosis (live home, no state touched).** The phone is the native Clem app
(`apps/ios`, SwiftUI shell around a pinned WKWebView; device `dev-W9RhYmCy`, seen today via the
relay). It registers for push through APNs only (PushRegistrar.swift → PinnedWebView →
`window.clemNative.registerApnsToken` → `POST /m/push/apns` → `upsertApnsDestination`). Today:

- `state/notification-destinations.json` does not exist: no phone (APNs or web push) was ever
  registered; the phone's session record has no `pushSubscribed`. The daemon log has no push
  line at all. So the token never reached the daemon: permission not granted, or APNs
  registration failed on the device (that build/App ID may lack the Push capability), or the
  bridge POST failed (it parks in localStorage `clem.apns.pending`). Which one can only be seen on
  the phone.
- `state/apns.json` does not exist and no `APNS_*` env is set: even a registered token could not
  be used. `src/runtime/apns.ts` needs `{ keyId, teamId, key | keyPath, environment }` with
  `environment` matching the build (Xcode Debug = sandbox, TestFlight/App Store = production;
  project.yml drives `aps-environment` from the configuration).
- Quiet hours are not applied in delivery at all (they gate producers only); live policy has
  them off.

**Three framework defects fixed (03e05703e), each pinned:**
1. Chat report-backs resolved only `web_push` destinations (three filters) → the native app's
   APNs destination was never a report-back target. One helper `phonePushDestinations` names
   both (`src/runtime/notifications.ts`; pin `runner-notifications.test.ts`).
2. The two-rules gate before a phone returned silently and the worker recorded that as
   delivered (`deliveredAt`, receipt). `deliverNotificationToDestination` now returns a
   `DeliveryOutcome`; a destination reached that chose not to interrupt is written as
   `deliverySkippedByDestination[id] = 'not_worth_interrupting' | 'channel_rules'`, settled, not
   retried, no receipt (`notification-delivery.ts`, `runner.ts`; pin in
   `runner-notifications.test.ts`). Test stubs returning nothing still count as sent.
3. A heartbeat item classified `neither` (no status, no question) so push mode could never
   buzz. An open heartbeat item (`heartbeatId` + `itemKey` + `needsAttention:true`) is an ask:
   `awaiting_you`; a bare `needsAttention` flag still is not (`notification-intent.ts`; pin).

**Legible on the page:** heartbeat status carries `phonePush { ready, reason, phones }`
(`src/agents/phone-push-readiness.ts`, from `listNotificationDestinations` +
`isApnsConfigured`); the Heartbeats page shows, under "reach my phone", "No phone is set up for
notifications yet…" or "…this Mac has no Apple push key yet…". Served now: all three heartbeats
`no_phone_registered`.

**Owner-side, cannot be done from here:** (a) Apple Developer → Keys → new key with Apple Push
Notifications service, download the `.p8`, note Key ID + Team ID; write
`~/.clementine-next/state/apns.json` `{ "keyId", "teamId", "keyPath": "<.p8 path>",
"environment": "sandbox" | "production" }` (topic defaults to `ai.breakthroughcoaching.clem`);
(b) on the phone: Settings → Clem → Notifications allowed; the App ID must have Push
Notifications enabled and the app rebuilt (Debug ↔ sandbox); relaunch Clem so it re-posts the
token; `notification-destinations.json` appearing is the proof. Then a work-review heartbeat
set to "reach my phone" is the live test.

**CarPlay (owner's ask for the mobile rebuild):** the native app exists, so CarPlay is
possible in principle, but Apple grants CarPlay entitlements per category (communication,
audio, navigation, EV charging, parking, food ordering, fueling, driving task) after an
application; a general assistant does not fit a category, and CarPlay shows notifications only
from entitled communication apps. A PWA cannot do CarPlay at all. The realistic path for the
rebuild: App Intents / Siri ("Hey Siri, ask Clem …", "what needs me") work in any CarPlay car
today without an entitlement; apply for the communication (messaging) entitlement if the owner
wants Clem's asks read out and answered by voice in the car. Not started.
