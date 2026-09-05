# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the owner-operator — a sales leader who runs Clementine as a personal
autonomous assistant across Salesforce, Outlook, Google Sheets, Slack/Discord, and
local files. He reaches the desktop main window between meetings, often for a
glance rather than a session; he reaches the phone to check what's running, answer
Clem's questions, approve a write, or start a new task. State of mind: busy, trusting
by default, intolerant of clutter and of being asked the same thing twice.
(Confirmed 2026-09-04 via interview; "command center" landing chosen.)

Secondary (confirmed design intent, not yet shipped to others): future users on a
blank home — the framework must work for any new user with any connected tools.

## Product Purpose

Clementine ("Clem") is an ever-learning, long-running personal agent that owns a task
end to end: discovers the right tools, reads, rehearses, writes, and reports back —
asking the user only when it genuinely matters. Success = the user can hand her a task
("find 100 market-leader accounts, put them in a sheet with why, check in with me
along the way") and trust the answer "done."

## Positioning

The mechanism a neighboring harness cannot truthfully copy: completion is graded on a
durable effect ledger (did the external write actually settle?), with one lease per
external crossing, never-blind retry of uncertain writes, and live re-observed call
authority — plus durable memory and a durable workflow engine (occurrence identity,
checkpoints, restart resume). The UI's job is to render that durable truth, never to
infer state from chat prose.

## Operating Context

Desktop: Electron shell loading the React console (`apps/console-web`, served by the
daemon at `/console`). Mobile: PWA (`apps/mobile-web`) + iOS wrapper, same event log
as desktop, pinned-TLS direct door + relay. Chat is the primary door; workflows,
background tasks, goals, workspaces ("Spaces"), memory, meetings, and connected
apps/tools are the durable objects around it. A mid-run "steer", same-turn asks,
approvals, and typed run terminals are engine facts the UI can show.

## Capabilities and Constraints

- Binding: first-party surfaces (desktop + mobile) only; no new channel builds.
- Binding: the UI renders canonical engine events/projections; it never infers
  "running/done/needs input" from assistant text.
- Binding: no hardcoded tool/provider lists or names in product code; no
  user-specific values baked in.
- Refinement, not rebrand (confirmed 2026-09-04): keep the incumbent identity —
  warm light canvas, orange accent, dog mark, existing type — while decluttering and
  restructuring; customization is a first-class product feature.
- Customization priorities (confirmed): which panes show and their order; nav
  hide/pin/reorder and default landing; personal pinned prompts/quick actions.
  Density/text size were NOT prioritized by the owner.
- Preferences must survive relaunch and, where sensible, be shared by desktop and
  mobile (server-side per-user record preferred; today's localStorage is wiped by the
  Electron session partition on every relaunch).
- Terminology in the product: Chat, Inbox ("Needs you"), Tasks (running work),
  Goals, Automate (workflows), Workspaces (Spaces), Connect, Memory, Meetings.
- Undecided: whether "Workspaces" becomes the primary organizing unit ("project")
  in the main window before the §14 backend work lands (session mount, one-sentence
  create). The UI may prepare for it but must not fake it.

## Brand Commitments

Name: Clementine ("Clem"). Mark: the pixel French-bulldog dog mark. Voice: a person,
not an engine ("Hey yeah, let me run that now") — never template-y system prose in
Clem's own bubbles. Existing visual identity in code is the authority for this
refinement (see `apps/console-web/src/styles.css`).

## Evidence on Hand

- Live engine event vocabulary the UI can render: `external_write_succeeded/failed/
  orphaned`, logical call settlements, physical dispatches, result handles, typed
  resumable terminals, `conversation_check_in` — verified 2026-09-04
  (docs/BEAT-THE-HARNESSES-DIRECTION-2026-09-04.md §13.4, §14).
- Current-state screenshot of the desktop main window (daemon offline) captured
  2026-09-04 and shared with the owner.
- Absent (do not fabricate): testimonials, customer logos, pricing, benchmarks.

## Product Principles

1. One truth, one door: each durable state ("needs you", "running", "delivered") has
   exactly one home in the main window; everything else links to it.
2. Glanceable first, deep on demand: the landing view answers three questions in
   one look; detail is one click, never a modal by default.
3. The user shapes the window: panes, nav, landing, and quick actions are
   preferences, persisted and shared across surfaces.
4. Render the ledger: what actually happened (receipts, settlements, terminals)
   outranks what was said.
5. Familiar over clever: standard nav patterns, consistent controls, restrained
   color; brand lives in precise details.
