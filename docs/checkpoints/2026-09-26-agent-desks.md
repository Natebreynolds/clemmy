# Agents you work in — Phase 1 checkpoint (2026-09-26)

Branch `claude/agent-desks`, based on `claude/checker-evidence` 31ffcf4d0 (the
installed weekend branch). Plan page: claude.ai/artifact/JzXpnz6jgNRemMkJQtovqL.
Owner direction (09-25): the desktop Agents section should hold specialized
agents Clem creates for a kind of task that the user opens and works in; later,
agents that work together (rooms) and stay alive (responsibilities, not timers).

## What was true before

Three unrelated things were called "agent": desktop team agents (two records
untouched since June 30, a coordinator "blocked" hourly since Aug 13, waking
only behind `AUTONOMY_V2_AGENTS` and the proactivity policy, both off); phone
"named agents" in a JSON store nothing in the turn path read; and fan-out
workers (148 runs in September) that no page showed. Desktop chat could not
address an agent at all.

## What this branch does

- **One record** (`src/agents/agent-record.ts`): `agents/<id>/agent.md` in the
  vault, the file the phone, the desktop and `create_agent` all edit. Fields
  the product uses: name, handles, instructions, skills, workflows, tools,
  model, memoryScope, createdFrom. Older team-era fields survive a save
  untouched. Phone JSON profiles are folded in on first read (none existed
  live). A record that says nothing about waking gets no cadence.
- **Binding** (`src/agents/agent-binding.ts`): one rendering of an agent's
  context (instructions + pinned SKILL.md bodies, capped) used by chat turns
  and workers. A session is bound once at creation (desktop
  `POST /api/harness/chat`, phone `POST /m/api/chat/send`, body `agentId`;
  included in the payload hash only when set; a branch successor copies it).
  `composeSession` resolves the binding; `harnessInstructions` places the
  context in the stable prefix before the cache sentinel; pinned workflows
  keep `workflow_get`/`workflow_run` first-class. `run_worker` takes
  `agent` by name: unknown refused with the saved names listed; the agent's
  model role applies only when the caller named no model; run records carry
  `boundAgentId`. `turn_model_routed` carries `agentName`, so both receipts
  read "Agent · <brain> did the work…". A skill pinned by the agent counts as
  loaded for the bulk-work hold.
- **API**: `/api/console/agents` list/get/create/patch/delete/catalog,
  `/api/console/agents/:id/work` (threads + workers), `/api/console/sessions?agent=`;
  session summaries carry `agentId`/`agentName`. Graph, comms and autonomy-run
  routes removed with the page that showed them.
- **Desktop**: roster → workspace (`/agents/:id`, `/agents/:id/t/:sessionId`):
  threads rail, thread, record + recent work panel; composer agent chip; turn
  header and thread tag name the agent. Swarm cards, message graph, comms
  timeline, trace drawer gone.
- **Phone**: same store; "Message" opens a conversation bound to the agent.
- **Measurement**: `measureAcceptedTurn` gains `toolSearchMs` (time inside
  top-level `tool_search`, call→return by call id).

## Owed before this is done

1. Live acceptance in the installed app against the live home with a named
   fixture agent (FRAMEWORK-TEST prospect research desk): create it, work in
   it on desktop and phone, have a fan-out bind a worker to it, read the
   receipt, delete it and confirm nothing is orphaned.
2. The kill criterion: the same asks in plain chat and in the desk, compared
   with `npm run measure:turns` (tokens, wall time, `toolSearchMs`, repeated
   explanations). If the desk is not faster and cheaper, it is clutter.
3. Tool-family scope narrowing (`tools` is stored and shown, not enforced:
   `McpToolScope` intersection plus a Composio toolkit filter are the levers).
4. An agent's `model` for the chat brain (workers honor it; the brain keeps the
   owner's routing until refuse-not-swap fallover is handled).
5. `gatherSessionSkills` does not see agent-pinned bodies (reviewer view);
   only the bulk-work hold was taught.
6. Clem-driven creation as one card in chat (Phase 2); `agent_propose` and the
   drafts section stay until then. Plugins shipping agents.
7. Phase 3 subtraction: autonomy-v2 as a user-agent runner, the env vars, the
   team comms tools, the metrics job, the execution controller's `delegate`.
8. Phase 4: rooms and heartbeats.

## Build note

`apps/console-web` declares `@xyflow/react` (WorkflowCanvas) but the shared
node_modules does not have it, so `npm run build:console-web` cannot pass
here without an install; the UI typecheck is otherwise clean and the vite
bundle builds with that module externalised.
