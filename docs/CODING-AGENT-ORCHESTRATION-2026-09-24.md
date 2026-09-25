# Coding-agent orchestration — Clem drives Claude Code and Codex

Status: design agreed with the owner 2026-09-24. Slice 1 built on this branch
(see §9); not yet installed or accepted in the live app.
Branch: `claude/coding-agents` (worktree `~/clem-worktrees/coding-agents`).

## 1. What the owner asked for

Clem connects coding-agent CLIs (Claude Code, Codex) to local projects and
GitHub repos and becomes the orchestrator: she plans coding tasks, hands them
to a coding agent, waits on it or lets the user watch it live, and steps in.
Motivating flow: an automatic workflow reads a task tracker (the owner's is
monday.com), Clem turns items into coding tasks, and Claude Code does them in
a local repo.

Owner decisions (2026-09-24):

| Question | Decision |
|---|---|
| Where the agent works | Its own git worktree on its own branch, per task. The user's checkout is never touched. |
| How far Clem goes on her own | Whatever the user tells her. The user's instruction sets the finish line; unstated means stop at a ready local branch and ask. |
| Watch experience in v1 | All of: Clem ↔ agent dialogue, step in mid-run, take over in Terminal, phone live card. |
| Agents | Same experience for every agent. One contract, one provider bridge per CLI. |

Framework rules that apply: tracker-neutral (no provider slugs in source; the
ratchet is `src/no-hardcoded-provider-pins.test.ts`), gates at the write
boundary with the irreversible-send floor kept, the model reasons about the
user's words (never regex), never bill a user API key, one owner per
subsystem, acceptance in the installed app against named fixtures only.

## 2. What exists, and why it is off

`src/execution/guest-harness.ts` + `src/execution/guest-run-jobs.ts` (landed
ed9e2486c, 2026-07-30) spawn `claude -p … stream-json` / `codex exec --json`
inside a roster project, parse the stream, scan changed files, and report back
to the origin chat. It was hand-validated on both CLIs.

`project_run start` has refused since 60db67d8b (2026-08-25) with
`durable_delegated_execution_root_required`
(`src/tools/project-run-tools.ts:55`). The defects it names are real:

- the child process had no durable owner (in-memory Map + `state/guest-runs.json`
  in whichever process imported it; the MCP stdio child could start runs the
  daemon's kill route could not reach);
- exit code 0 was promoted straight to success;
- a restart orphan-failed every running job;
- one-shot mode with stdin ignored, so no steering, no follow-up, no resume;
- the child inherited the full daemon environment (`mergedSpawnEnv`), and
  Claude ran `--permission-mode acceptEdits` with bare `Bash`, so none of
  Clem's shell, destination, or send gates applied.

Already usable as-is: the CLI catalog entries for `claude-code` and `codex`
with read-only auth probes (`src/integrations/cli-catalog/catalog.ts:521-560`),
auto-connect, the 30-minute auth sweep, the Connect screen pills, the
workspace roster (`listWorkspaceProjects`, `src/tools/shared.ts:743`), and the
live pipe (harness eventlog → public projection allow-list → action bus → SSE
→ `reduceActivity`).

## 3. Architecture

### 3.1 Provider bridge — one contract, one adapter per CLI

```ts
interface CodingAgentBridge {
  start(input: { cwd; brief; model?; agentSessionId? }): AgentHandle;
  resume(input: { cwd; agentSessionId; message }): AgentHandle;
}
interface AgentHandle {
  events: AsyncIterable<CodingAgentEvent>;   // normalized, see below
  steer(text: string): Promise<void>;         // mid-turn note
  followUp(text: string): Promise<void>;      // next turn, same session
  interrupt(): Promise<void>;
  close(): Promise<void>;
  agentSessionId(): string | null;            // resumable id
}
```

| Capability | Claude Code | Codex |
|---|---|---|
| Transport | `@anthropic-ai/claude-agent-sdk` `query()` (already a dependency, 0.3.280), `pathToClaudeCodeExecutable` = the user's CLI | `codex app-server` JSON-RPC over stdio (experimental; fallback `codex exec --json` + `exec resume`) |
| Working folder | `cwd` = the task worktree | `thread/start { cwd, sandbox }` |
| Live events | SDK messages + `includePartialMessages` | `item/*`, `turn/plan/updated`, `turn/diff/updated`, `item/commandExecution/outputDelta` |
| Steer mid-run | `Query.streamInput()` | `turn/steer { expectedTurnId }` |
| Stop | `interrupt()` / `close()` | `turn/interrupt` |
| Permission prompts | `canUseTool` callback | server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` |
| Resume / follow-up | pre-minted `sessionId` persisted before spawn, `resume`, `persistSession: true` | `thread/resume { threadId }` (id known only after `thread/start` returns) |
| Take over in Terminal | `claude --resume <id>` in the worktree | `codex resume <id>` in the worktree |

Normalized `CodingAgentEvent` kinds: `agent_message` (+ deltas),
`agent_plan`, `step_started` / `step_output` / `step_finished` (command,
file edit, search, web), `diff_updated`, `permission_request`,
`turn_completed` (usage), `error`. Each bridge is pinned by a replay
conformance suite: recorded provider streams in, normalized events out.

### 3.2 The durable root — the coding-run store

A new root, not a background task, in its own database file
(`state/coding-runs/<machine>/coding-runs.db`, schema chain of its own) rather
than a harness.db migration: several agents hotpatch the same installed app,
and two branches that each ship a different harness v82 would silently skip
one another's tables in the live home. The run's harness session and events
stay in harness.db; no harness migration is needed (`events.type` has no
CHECK, only the `EVENT_TYPES` gate). Rationale (planner report, 2026-09-24):
background tasks are JSON files with their own lease, their executor is
hard-wired to Clem's brain (`respondPreferHarness`), and their per-call wall,
auto-continue, judge self-resume, and restart-safety check read Clem's own
ledgers, which a CLI run never writes. `subagent-runs.ts` is a best-effort
completion log, not an owner.

- Tables:
  - `coding_runs`: run id, `session_id` (`coding:<runId>`), origin session,
    origin source-user seq, origin accepted task and logical tool call id
    (UNIQUE → admission is idempotent), harness, project path, worktree path,
    branch, base commit, agent session id, brief, finish line, state
    (`admitted | running | detached | resuming | settling | settled`), stop
    request, deadline (4 h across restarts), resume count, timestamps.
  - `coding_run_settlements`: immutable by trigger. Outcome
    (`completed_verified | completed_unverified | failed | blocked |
    cancelled`), head commit, commits, diffstat, dirty flag, test command,
    exit code and tail, final message, completion verdict, receipt digest.
  - `coding_run_report_backs`: outbox with a monotonic acknowledged-at.
- `src/execution/coding-run-store.ts` is the only writer (CAS transitions).
- Ownership is the store's own lease (owner `daemon:<pid>:<nonce>`, 60 s,
  renewed every 15 s), not harness `run_attempts`: those are built around
  Clem's own turns (supersession, workflow handoff, restart safety, board
  visibility all key off them). Stop is a store flag any process can set; the
  owning executor polls it. At start the executor releases runs leased to a
  PID that signal 0 proves dead, so they resume at once instead of after the
  lease lapses; a synchronous exit hook closes every agent process.
- **Only the daemon spawns.** `dispatch_coding_task` writes an admission row
  and returns (`project_run` keeps status, kill and runs; its `start` stays
  closed and points at the new tool); a drain on the existing daemon timer (next to `runner.ts:2967`)
  claims admitted and resuming runs. No new scheduler.
- The agent's inner tool calls are NOT `tool_called` / `tool_returned` and do
  not enter the per-call dispatch kernel. They are `coding_run_activity`
  events on the coding session. `dispatch_coding_task` is a control receipt
  like `dispatch_background_task` (terminal tool, transferred terminal,
  consent-given write, finish-phase tool) and shares its alignment floor.
- Credit to the origin's expected work only from a `coding_run_settlements`
  row with outcome `completed_verified` (same principle as
  `expected-work-delegation.ts`; its v81 table needs a child contract the CLI
  never has, so a later migration adds a coding-run discharge).

### 3.3 Isolation and environment

- Worktree per run: `git worktree add -b clem/<slug>-<shortId>
  <BASE_DIR>/worktrees/<project>/<runId> <base>`, created idempotently by the
  executor. The run's `cwd` never changes (Claude transcripts are keyed by
  directory, so resume needs the same path).
- Scrubbed child environment built from an allow-list (PATH, HOME, locale,
  terminal basics, git/ssh agent), not `mergedSpawnEnv()`. Removed explicitly:
  Clem's `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, every `CLEMENTINE_*` /
  `CLEMMY_*`. The CLI uses its own sign-in (the one the Connect card shows).
  A run never bills an API key.
- Project and user MCP config stays off (`--strict-mcp-config` /
  `mcp_servers={}` equivalents); connector calls go through Clem.

### 3.4 Permission policy — Clem answers, the user decides sends

Every permission prompt from the agent reaches Clem's policy:

- Inside the run's worktree (read, edit, create, local commands such as
  install, build, test, `git add` / `git commit` on the run's branch):
  Clem allows without asking.
- Off the machine or outside the worktree (`git push`, `gh pr …`, publish,
  deploy, network mutations, writes outside the worktree, touching other
  branches): allowed only when the run's finish line (3.5) already carries the
  user's decision for that exact effect and destination; otherwise it becomes
  a user decision through the approval registry (desktop card, Inbox, phone,
  notch). Slice 1 denies these outright.
- Existing classifiers are reused, not duplicated: `classifyShellNetworkMutation`,
  `expandLiteralShellCommands` (opaque wrappers fail closed),
  `assertCommandAllowed`, `shellCommandTouchesSensitiveData`, `isSensitivePath`,
  plus a list of developer credential locations and Clem's own home.
- The enforcement point is the agent's PreToolUse hook, which fires for every
  tool call even when a settings rule would pre-allow it; `canUseTool` answers
  with the same policy as a backstop. Only the project and local settings
  layers load, so the user's personal allow rules and MCP servers do not.

### 3.5 Finish line — set by the user's words

The run contract carries `finishLine`: `local_branch` (default) |
`pushed_branch` | `draft_pr` | `pr`, plus an optional tracker update. Clem's
model derives it from what the user said when dispatching (or from the
workflow definition the user authored). An explicit instruction that names
the effect and destination counts as the human decision for that send. If
the user said nothing, Clem stops at a committed local branch and asks.

### 3.6 Clem ↔ agent loop and the honest receipt

1. Clem writes the brief: objective, constraints, acceptance criteria, the
   test command she will run, and the finish line.
2. The agent works; events stream live.
3. At the agent's turn end the executor builds a receipt: `git rev-list
   base..HEAD`, `git diff --stat`, `git status --porcelain`, the test command
   run by the host in the worktree, and the agent's final message.
4. The completion judge checks the receipt against the objective.
5. Not done → Clem sends a follow-up in the same agent session (bounded
   rounds). Done → settle; carry out the finish line; report back.

Outcome rules: judge unavailable → `completed_unverified`, never verified. An
empty diff is never success. Exit code alone means nothing.

## 4. Watching and stepping in (v1: all four, every agent)

New public event types: `coding_run_dispatched` (origin session),
`coding_run_activity` and `coding_run_settled` (coding session). Each needs
its `EVENT_TYPES` entry (no migration; `events.type` has no CHECK), an
explicit `projectData` allow-list case with `redactSensitiveText` on text,
the bridged-type set (the shared `bridged-activity.ts` and the duplicate at
`console-routes.ts:15056`), and a `reduceActivity` case (unknown types fall
through to `prev`, so older phone bundles are safe).

- **Dialogue view.** Clem's brief and follow-ups, the agent's plan and
  messages, its steps (commands, file edits, tests), a live diff, the
  permission asks, and Clem's review verdict, laid out as a conversation
  between Clem and the agent. It appears in the chat card, the tasks board
  drawer (streaming, not polling), the run page, and the phone.
- **Step in.** A note typed on the card reaches the agent at its next step
  (Claude `streamInput`, Codex `turn/steer`). Permission asks appear as
  decisions. Stop works from the card, the board, and the phone, and the chat
  Stop cascades to runs whose origin is that chat.
- **Take over in Terminal.** Clem interrupts and closes her connection, moves
  the run to `detached`, and opens the user's Terminal in the worktree with
  the resume command (server-resolved, like `terminal-handoff.ts`). "Hand
  back" re-attaches with `resume`, re-reads git state first, and continues.
  Verify whether an interactive resume forks the session id.
- **Phone.** Live card in the chat stream, run screen, approvals, stop, steer.

## 5. Connecting agents and repos

- A "Coding agents" card: installed or not, signed in as whom, one-tap
  sign-in (Terminal hand-off), default agent, default model per agent.
- Projects gain repo facts: remote URL, default branch, current branch,
  uncommitted changes, open Clem branches. "Connect a GitHub repo" = pick a
  local folder or clone it with `gh`.
- Remove the stale "runnable via project_run" copy once start works again.

## 6. Workflows and tracker intake

- A workflow step that dispatches a coding run parks (like `awaiting_input`)
  and re-admits when a settlement row exists (`reapResolvedParkedRuns`). The
  15-minute step wall does not apply to a parked step. Only then does
  `project_run` leave the workflow-step block list.
- Tracker intake is a scheduled poll today: a `call:` read bound at authoring
  time through tool search (no provider code). Push triggers need a relay,
  because the webhook binds to loopback and `fireWorkflowSystemEvent` has no
  producer.
- Clem turns new items into proposed coding tasks and checks them with the
  user once; approved tasks dispatch as coding runs; the finish line decides
  PR and tracker updates.
- A project Space shows incoming items, active runs, branches, and PRs, with
  a `_mobile` summary.

## 7. Slices

Each slice ends with installed-app acceptance against a named fixture repo
(`clem-coding-fixture`, created for this purpose; never a personal project),
three live traces before claiming it works, and the owner's OK before a tag.

1. **Durable Claude Code run from chat.** v82 tables, store, daemon executor
   on the Agent SDK, worktree, scrubbed env, live `coding_run_*` events on
   desktop, stop (card, board, chat cascade), honest receipt, report-back,
   restart → resume. Off-machine effects denied.
2. **Step in and follow up.** Steering, permission policy with user
   escalation, follow-up rounds, take over / hand back, the dialogue view on
   desktop and the phone card.
3. **Codex on the same contract.** app-server bridge and conformance suite.
4. **Connect.** Coding agents card, repo facts, clone.
5. **Workflows.** Parked coding step, tracker intake, finish-line PR and
   tracker updates, project Space.

## 8. Traps to respect

- `start` must never spawn; the MCP server is a stdio child of the brain.
- Don't write the agent's inner calls as `tool_called`; they would feed
  Clem's restart safety, adjudication, and write accounting.
- `isConsoleVisibleHarnessSession` would add a second board card for an
  active `coding:` session; exclude it.
- Chat Stop only cascades while the origin attempt is active; afterwards stop
  comes from the card or the board.
- The mobile bridge predicate lacks `sess-worker-` and console keeps its own
  copy; move both to `bridged-activity.ts` rather than adding a third.
- Use a `coding-<runId>` activity row id; `dispatch-` rows are closed by
  `conversation_completed`.
- `approvalWaitParkMs` defaults to 10 minutes and `EXECUTION_APPROVAL_FNS` is
  keyed on Clem's tool names; neither fits native `Bash` / `Edit` asks yet.
- Steering is limited to `sess-|space-|discord-` sessions; coding sessions
  get their own delivery path through the bridge, not the host steer notes.

## 9. Slice 1 as built (2026-09-24)

New: `coding-run-store.ts`, `coding-run-policy.ts`, `coding-run-git.ts`,
`coding-run-env.ts`, `coding-agent-bridge.ts`, `coding-agent-claude.ts`,
`coding-run-receipt.ts`, `coding-run-executor.ts` (all in `src/execution/`).
Wired: `dispatch_coding_task` + `project_run` (`src/tools/project-run-tools.ts`),
the dispatch control-receipt sets, `EVENT_TYPES`, the public projection, the
shared activity fold (one live row per run in the dispatching chat, desktop and
phone), origin-chat bridging and replay (desktop and phone), the chat Stop
cascade, the daemon start, board cards (`sourceKind: 'coding'`, streaming the
run session, with a stop endpoint), and `/api/console/coding-runs[/:id[/stop]]`.

Not in slice 1: the dialogue view, steering, permission escalation, take-over,
the phone run screen and stop, Codex, finish lines beyond a local branch.
