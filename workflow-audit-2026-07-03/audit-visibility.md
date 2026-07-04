# Workflow Visibility / Observability / UX — Audit

## The one architectural fact that shapes every answer

Two rendering paths, with sharply different observability:
- **Ad-hoc chat turns** run through `runDiscordHarnessConversation` (`src/channels/discord-harness.ts`) / `handleSlackHarnessMessage` (`src/channels/slack-harness.ts:319`) with a **live channel transport** — the user watches one message edit itself in real time.
- **Workflow runs** execute headless in `src/execution/workflow-runner.ts` with **no channel transport**. They persist events to a per-run `events.jsonl` and reach channels only through the fire-and-forget notification pipeline (`src/runtime/notifications.ts` → `src/runtime/notification-delivery.ts`).

Net: a channel user **watches** a chat run; a workflow run is **fire-and-forget** — they hear from it only on an approval park or at the end. The rich live view exists only in the desktop app and on mobile.

## 1. Events emitted and consumers

Durable **append-only JSONL log**, not an in-memory bus. `appendWorkflowEvent` (`workflow-events.ts:171`) writes one atomic line per event to `runs/<runId>/events.jsonl`. **~45 event kinds** (`workflow-events.ts:39-79`): run/step/item lifecycle, `attempt_record`, `run_summary`, graph node transitions, checkpoints/rollback, triggers, approvals, `tool_called/tool_result`, `transcript_chunk`. Runner emits from **47 call sites**. Every emit also mirrors into operational telemetry via `mirrorWorkflowOperationalEvent` (`workflow-events.ts:215`).

**Consumers:** `console-routes.ts` (desktop live poller, reads via `readWorkflowEvents` at `:2805`); `mobile-routes.ts` (per-step tail + SSE); `board-summary.ts` / `agent-system-metrics.ts` (aggregates); `workflow-runner.ts`/`workflow-scheduler.ts` (crash-resume replay, `computeResumeState` at `:381`); `autoresearch/improvement-proposer.ts` (mines history).

**Dead in the pipe:** `transcript_chunk` — declared "streaming text from LLM, for live UI" (`workflow-events.ts:79`) — is **never emitted and never consumed**; only a test references it (`workflow-events.test.ts:106`). Streaming step text is designed-but-unwired.

## 2. What the user SEES live, per surface

**Desktop app** (richest, but confined to the Workflow Studio editor): after RUN/TRY the SPA polls `GET /api/console/workflows/:name/runs/:runId/events?since=<t>` **every 1000ms** (`console.ts:17613`) and paints per-step **status pills** + a **step output panel** (`ev.output`/`ev.error`, `console.ts:17639-17684`), a **Cytoscape flow graph** recoloring nodes per event (`console.ts:15634`), and live **forEach counters** ("3/100", `console.ts:17666`). Plus a Workflow Home "ACTIVE RUNS" strip showing `inFlightStepId` (`console.ts:16133`). It is **polling, not SSE** — SSE exists only for file-changes, the global action bus (`console-routes.ts:7784`), operational telemetry (`:7960`), and chat sessions (`:8021`), **not workflow step progress**.

**Discord:** during a live run, **effectively nothing per-step**. The enriched heartbeat ("step X of Y · 12/50 items", `workflow-runner.ts:304`) is emitted `silent:true` (`:315`) and silent notifications skip delivery; `notification-delivery.ts:126` also drops heartbeat/progress-titled notifications. Discord gets only the approval card and the terminal report. (The 30s pulse + streaming tail at `discord-harness.ts:2231`,`1576` are the chat path only.)

**Slack:** same per-step silence, plus two extras — the native **assistant-pane** streams a play-by-play and drives `assistant.threads.setStatus` (`slack-harness.ts:204-306`, chat path only), and **App Home** has an **"In flight (N)"** section listing running workflows w/ elapsed + `⏳ needs approval` (`slack.ts:280-295`), republished on `app_home_opened` and after approve/reject. That App Home snapshot is polled, not live.

**Mobile:** only channel with true per-step workflow visibility — `GET /api/workflows/:name/runs/:runId/events` (`mobile-routes.ts:1076`) + session SSE forwarding `step_started/completed`, `tool_called`, `approval_requested` (`mobile-routes.ts:160-204`,`790-850`).

## 3. Run history / inspection — the weakest area

Backend records far more than any UI shows.
- Desktop "RECENT RUNS" lists only status/id/timestamp/input + cancel (`console.ts:17865`; route `console-routes.ts:2621`). Workflow Home shows last 20 with a NEEDS ATTENTION state (`console.ts:16157`).
- **Per-step inspection of a PAST run is not wired.** `applyStepEvent` only paints the currently-active polled run (keyed off `wfActiveRunId`); no path replays a finished run's `events.jsonl` into the step cards. Clicking a historical run opens no transcript.
- Recorded-but-unrendered: `run_summary` (`workflow-runner.ts:5188`, emitted with `because`/`artifacts`/`needsAttention`, commented "for a **future** run-view consumer"); **`attempt_record`** with per-attempt criterion failures, fixed/new/still-failing diff, and metrics `{durationMs, tokens, toolCalls}` (`workflow-events.ts:88-101`), plus a `listAttemptRecords` reader built "to render an attempt timeline" (`:300`). Grepping `console.ts` for these + per-step token cost returns nothing. **Judge verdicts, attempt/retry records, and per-step cost are recorded but not viewable.**
- What IS wired: failed-item listing + one-click retry (`console-routes.ts:2682-2745`).

## 4. Approval / needs-input UX — strongest area

On park, `workflow-runner.ts:1799-1820` registers an approval notification (stable id `approval-<id>`, "reply `approve <id>` / `reject <id>`… parked on `<step>`"), re-emitted as a recovery card on restart (`:5333`). Delivery attaches **buttons** only for `kind:'approval'`: Discord `buildActionsForNotification` (`discord.ts:1115`), Slack `buildSlackActionsForNotification` (`slack.ts:462`), delivered as a **DM** (`notification-delivery.ts:239-295`); Discord adds an **Edit** button w/ modal pre-filled with tool args (`discord-harness.ts:1434`). **Two response paths:** button click (`clementine:approve|reject|edit:<id>`; Slack `app.action(/^clementine:.+/)` → `handleSlackAction`, `slack.ts:969`) or typed `approve <id>`. Duplicate delivery-card suppressed when a live inline card already showed it (`notification-delivery.ts:110-138`). **Desktop:** Home command center `needsYou` array (`console-routes.ts:7145-7197`) → NEEDS YOU cards with APPROVE/REJECT/EDIT (`console.ts:12407-12421`), plus a dedicated Approvals panel with "cancel all stale" (`console.ts:23653`). **needs_input:** next freeform channel message captured as the answer when exactly one task awaits input (`discord-harness.ts:1366`); Slack modal supported.

## 5. Report-back quality

Composed at `workflow-runner.ts:5235-5282`, sent as `kind:'workflow'` notification: escalation banner + success/needs-attention summary + advisory summary, then **rewritten into Clementine's voice** (`rewriteInClementineVoice`, `:5244`). Title varies honestly ("Nothing new —", "completed with N failures", "⚠️ needs attention"). Delivery is **guaranteed-once** via stable id + `notifiedAt` marker + watchdog, marked must-deliver (`notification-delivery.ts:153`).

Assessment: honest, voiced **prose** — but **not structured** on the channel surface. `forEachFailures`/`qualityAdvisories`/`artifacts` ride in notification metadata; a "📦 Produced:" line is appended only when concrete artifacts exist (`workflow-runner.ts:5198`). **No per-step breakdown, no judge verdicts, no links/attachments** in the Discord/Slack message. Per-step detail lives only in the event log, which no history UI renders.

## 6. Strengths + top 5 gaps

**Strengths:** durable crash-safe event substrate with replay-resume (`workflow-events.ts:8-37`,`:381`); rich ~45-kind taxonomy already covering nodes/checkpoints/attempts/cost; live desktop editor run view (step pills + flow-graph + forEach counters, `console.ts:17639`); best-in-class approval UX across all four surfaces; guaranteed-once voice-consistent honest report-back; Slack App Home "In flight" + mobile per-step SSE.

**Top 5 gaps:**
1. **Streaming step text is designed but dead** — `transcript_chunk` declared "for live UI" (`workflow-events.ts:79`) but never emitted/consumed (`workflow-events.test.ts:106` is the only ref). No surface shows a model thinking/writing mid-step. Wire the runner to emit it + a desktop consumer.
2. **No past-run inspection UI** (biggest gap: data exists, consumer doesn't). `run_summary`, `attempt_record` (`{durationMs,tokens,toolCalls}` + fixed/new/still-failing diffs, `workflow-events.ts:88-101`), and judge verdicts are persisted but unrendered — `applyStepEvent` only paints the live active run (`console.ts:17639`); clicking a finished run opens no transcript.
3. **Workflow live progress is 1s polling, not SSE** (`console.ts:17613`) despite three SSE streams already next to it (`console-routes.ts:7784`,`:7960`,`:8021`). Events already mirror to operational telemetry (`workflow-events.ts:215`) — ride that SSE for instant cheap updates.
4. **Channels are blind during workflow runs.** Heartbeats are `silent:true` (`workflow-runner.ts:315`); step events never reach Discord/Slack. A Discord owner sees nothing between kickoff and terminal report. Consider opt-in low-frequency edit-in-place progress, or surface the enriched "step X of Y" heartbeat non-silently on long runs.
5. **Kanban board + sub-task queue are built, tested, and unconsumed.** `GET /api/console/board` (`console-routes.ts:6256`) and `.../board/run/:slug/:runId/queue` → `reconstructWorkflowRunQueue` (`console-routes.ts:6230`, impl `workflow-events.ts:469`) fully reconstruct per-step queue status/forEach expansion, but `grep` of `console.ts` finds no fetch of `/board` or `/queue` — only `board-summary.ts` (Slack/Discord "status") + tests use them. A rendered board with the live sub-task queue is the obvious "cockpit," ~90% done server-side.

**Bonus:** task-detail `vitals` (duration/effort/spend, `console-routes.ts:6123`) is computed but never read by `console.ts`; the Evolution "Swarms & Loops" cockpit (`console.ts:24806`) refreshes only on panel-open, not live.
