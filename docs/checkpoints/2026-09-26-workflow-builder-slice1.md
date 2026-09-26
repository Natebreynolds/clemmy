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
