# Workflow builder, slice 1: a workflow opens to its graph (2026-09-26)

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

## Not in this slice (next)

- Slice 2: edit the everyday four in the panel through the shared step-edit path (backup,
  check, re-test if live), Undo, Test this step.
- Slice 3: the chat card from the saved definition, live redraw of the open page (the
  refetch half exists), Ask Clementine with the step already in context.
- Slice 4: the Last run tab and honest run statuses.
- A trap to keep in mind: git tracks `apps/console-web/src/app.tsx` in lower case while the
  file on disk is `App.tsx`; `git add App.tsx` stages nothing on this filesystem.

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
