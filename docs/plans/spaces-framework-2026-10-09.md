# Spaces as a framework

2026-10-09 · status: proposed, waiting for the owner's go · owner of the plan: Claude (Spaces), coordinated with the agent working on the harness

## The idea in one paragraph

A Space is a place where Clem and the owner work together on something that keeps changing: a pipeline, an inbox, a content calendar, an ads account, anything. Every Space has four parts, and the framework owns how they connect so Clem only has to decide what goes in them:

1. **Data**: the Space's records, kept with history so it always knows what changed.
2. **Feed**: one workflow that fills the data. Fetching is done by direct calls (Composio, a reviewed command-line tool, MCP), which cost no model tokens. Model steps are used only for judgement: sorting, summarising, drafting. The workflow owns the schedule.
3. **Page**: whatever the owner can imagine, built from the data.
4. **Conversation and actions**: the owner and Clem both act inside the Space, and what they do flows back into the data and the feed.

Nothing in this plan limits what a Space can be. Checks stay advisory, except where something demonstrably breaks the page. There is no scenario-shaped code and no provider operation names compiled into code.

## Where it stands (live home, 2026-10-09)

| What | Today |
|---|---|
| Who feeds the 18 active Spaces | 10 only by their own built-in reads · 3 by built-in reads *and* a workflow (two schedules) · 2 by a workflow that names the Space only in its instructions · 1 by nothing · 2 one-off snapshots |
| Workflow ↔ Space link | A typed binding exists (`WorkflowSurfaceBindingV1`: workflow, Space, role primary/supporting, `scheduleAuthority: 'workflow'`). Its only writer is the automation read-pilot approval path (`automation-read-pilot-control-plane.ts:1289`). One binding exists, for a test fixture. The console links workflows to Spaces by scanning workflow text for the slug (`space-routes.ts:48`). |
| Writing into a Space from a workflow | Already works: a `call` step to `space_set_data` runs as a reviewed local write and is recorded as a history entry with cause `reviewed_local` (`workspace-set-data-carrier.ts:128-183`). Most workflows still end with a prose "space_refresh" line instead. |
| Direct calls | `call` steps run with no model for Composio, reviewed CLI reads, MCP reads and reviewed local tools (`workflow-runner.ts:3711-3884`). `workflow_create` already tells Clem to prefer `call`/`transform` (`orchestration-tools.ts:1090`). Only 4 of 32 live workflows use them; most are one long model step. |
| Schedules | Two schedulers on the daemon loop: workflows (`workflow-scheduler.ts:945`) and Space sources (`spaces/scheduler.ts:214`). They share the same cron primitives. |
| Owner in the loop | Workflow approval gates with "request changes → revise → re-ask" (`workflow-runner.ts:6477`, `:1336`) land in the inbox only. A gate carries no link to the Space its work is for. |
| History | Every data write is an observation with a cause and a link to the previous one (765 scheduled, 307 manual, 59 from workflows…). `space_diff` and `space_history` read it. Pages almost never use it (the Daily Brief's "What changed" is fixed text). |
| Guidance | `space_set_data` tells Clem to "reserve it for fixes" and to use built-in reads for the normal case, which is the opposite of this plan. Three places still teach the retired script runners. |

## The contract

### 1. Data

- A Space's data is a set of **collections**, the existing source keys of `data.json`. A collection name is the contract between the feed and the page.
- Every write is an observation with history, as today. Nothing changes in storage.
- **Owner edits are an overlay, not a write-over.** When the owner edits, adds, checks off or hides a record in the page, that change is kept as an owner layer keyed by the record's id. The page shows the feed's records with the owner layer applied. A feed run replaces the feed's records but never the owner layer, and the feed can read the owner layer as input (for example, "skip leads I marked done"). This is local work: no card.

### 2. Feed: one bound workflow

- **The binding is derived from what the workflow does, not declared separately.** When a workflow is saved (`compileWorkflowForWrite`), each `call` step whose tool is a reviewed local write to a Space dataset, with a literal Space and collection in its arguments, binds that workflow to that Space and collection.
  - Recognition is by the tool's registered capability (local execution through the Space dataset carrier), not by a tool name list.
  - The first feeder of a Space is `primary`; later ones are `supporting`. Removing the step retires the binding.
  - Bindings use the existing `WorkflowSurfaceBindingV1` rows and store.
  - Prose mentions never bind. A Space named only through a run input is shown as an advisory note ("this workflow writes to a Space chosen when it runs").
- **One schedule.** A bound Space has no schedule of its own: the feed workflow's trigger is the schedule.
  - "Refresh" on a bound Space runs the feed now.
  - The Space scheduler keeps serving unbound Spaces exactly as today.
- **Built-in reads become feed steps.**
  - A Space's data source maps one-to-one onto feed steps:
    - a Composio read → a `call` step;
    - a reviewed CLI read → a `call` step;
    - its transforms → a `transform` step;
    - then one `space_set_data` `call` step into the same collection.
  - New Spaces are built this way from the start.
  - An existing Space is converted only when Clem is changing its sources anyway, and she says so in her reply. Its schedule moves to the workflow at the same moment.
  - Legacy script runners cannot be converted mechanically. Clem rebuilds them as direct calls when she next works on that Space.
- **Default to direct calls.** Fetching is a `call`, shaping is a `transform`, and the model is used only where judgement is needed.
  - Codify-on-author (`workflow-execution-mode.ts:96`) extends from Composio-only to every catalog operation the runner can already dispatch with no model (reviewed CLI and MCP reads).
- **The Space shows its feed.** A feed line sits in the Space header:
  - the workflow's name;
  - its last run (when, ok or failed) and its next run;
  - Run now;
  - a link to open the workflow.

  A failed run says what failed in plain words, with "Ask Clem to fix".

### 3. Page

- Anything. It reads collections through `clem.data()` / `window.__SPACE_DATA__`, as today.
- **New data arrives in place.** A page that registers `clem.onData(callback)` receives new data over the existing bridge port when a feed run lands. Scroll, filters and drafts survive. Pages that don't register keep today's reload.
- **The app draws the frame, so every Space gets these for free:**
  - freshness per collection;
  - the feed line (§2);
  - **what changed** since the previous run, from observations (`+3 new · 1 changed · 2 gone since 7:00 AM`, expandable). It is shape-derived only;
  - approvals waiting for this Space (§4);
  - failures with the one fix.

  A page never has to rebuild these, which removes the Daily Brief class of bug, where a page promises a feature it never wires up.

### 4. Conversation and actions (two-way)

- **Record edits from the page**: `clem.update(collection, id, patch)`, `clem.add(collection, record)`, `clem.hide(collection, id)` write the owner layer (§1). They are local, card-free and recorded with the owner as author.
- **Approvals inside the Space.**
  - When a bound feed's step waits on the owner, its gate carries the Space id.
  - The Space shows the waiting item with the exact content, using the same card design as chat: Approve, or "Change it" in words. That uses the existing request-changes revise loop.
  - The inbox still shows it too.
  - External writes keep their one plain-English card.
- **Ask Clem about this.** `clem.ask(text, context)` is gesture-gated. It posts into the Space's conversation with the selected record attached.
- **Clem lives in the Space conversation.** It already has its own session (shown again on reopen once commit 71e7210b2 is installed) and memory scope. From there she can change the data, the page or the feed. `space_get` shows all three, including the feed's last and next run.

### 5. Phone

The phone renders the frame (feed line, what changed, approvals) and the collections natively from the existing mobile projection. Pages stay desktop-only.

## Guidance changes (Clem's side)

- Rewrite `builtin-skills/workspace-builder` around the four parts, in this order:
  1. choose the collections;
  2. `workflow_create` the feed (direct calls, a transform, `space_set_data`) and run it once;
  3. `space_save` the page reading those collections;
  4. `space_preview`.

  Split it into a "create" part and an "edit" part, and drop the runner material.
- `space_set_data`'s description: "the way a feed writes a collection" (from a workflow step), and the fix-a-row case from chat.
- Remove the retired-runner advice in `computer-tools.ts:401` and in the repo skill `salesforce-deal-risk-workspace`. The live-home user skill `space-recipe-report` is the owner's, so ask before touching it.
- One-off reports: a feed with a manual trigger that has run once, so "Run again" regenerates the report.

## Build order

Each step ships on its own and is checked live in the installed app with a controlled test Space built around a new scenario each time: a social post queue, an ads budget watcher, a content calendar synced to a site. The inbox-triage Space is the regression check.

1. **Bindings on the normal path + the feed line.** Derive bindings at workflow save, and backfill them for the two live workflows that already write with `space_set_data`. This is a display-only derivation; no Space changes behaviour. The Space header shows the feed, and Run now works.
2. **One schedule.** Bound Spaces drop their own schedule, and Refresh means "run the feed". Add the source → feed-step converter, used only when Clem edits sources.
3. **Creation + guidance.** New Spaces are built feed-first (§ Guidance), and codify-on-author is extended.
4. **The frame.** Add what changed, freshness, approvals in the Space, failures, and `clem.onData`.
5. **Two-way.** Add the owner layer, `clem.update/add/hide`, `clem.ask`, and the feed reading the owner layer.
6. **Phone.** The frame and collections in the mobile projection.

## Decisions for the owner

1. **Fold built-in reads into the feed workflow.** *Recommended.* New Spaces from the start; existing ones only when Clem is changing their sources. The alternative keeps two ways to feed a Space and two schedules.
2. **One-off reports get a manual-trigger feed.** *Recommended.* The alternative keeps static snapshots with no link to how they were made.
3. **Owner edits survive feed runs as an overlay.** *Recommended.* The alternative is that every run overwrites them.

## Coordination with the harness work

- Shared ground:
  - `compileWorkflowForWrite`;
  - the approval-gate metadata in `awaitDeclarativeStepApproval`;
  - the daemon-loop scheduling phases.
- A feed run that only reads and writes its Space is local work. It stays on the reads-get-Jev-only review policy; a full review applies only to external writes or creations.
- Changes ship as small commits with patch files in `~/clem-worktrees/takeover-kit` while the other agent owns the install.

## Not in this plan

- Moving the Space scheduler off the main loop: refresh timings measured fine. Revisit if stalls return.
- Lock-free Space reads: the poll measured 10–30 ms.
- Pruning view history and orphan folders: a separate housekeeping round.
