# Dev end-to-end testing runbook

How to run Clementine in **dev** (source via `tsx`, no DMG) and exercise every
surface end-to-end. Written for the north-star hardening branch
`feat/approval-parking-durability`.

## 0. One-time: avoid colliding with the installed app

The released **Clementine.app** runs its own daemon against the shared home
`~/.clementine-next` and listens on a localhost port. To test dev cleanly, do
ONE of:

- **A — quit the installed app** (simplest): `osascript -e 'tell application "Clementine" to quit'` then run dev against the real home (you keep your vault, Discord, Composio, Salesforce auth).
- **B — isolated home** (zero risk to the installed app): set `CLEMENTINE_HOME` to a scratch dir and `npm run init-home` first. You lose existing auth/integrations, so Discord/Composio surfaces won't work — use this only for the workflow-engine + Activity tests.

For the full Discord/desktop-sync test you want **A**.

## 1. Flags for this branch (all default-OFF; turn on what you're testing)

Add to the `.env` the dev daemon loads (`~/.clementine-next/.env` for option A):

```
WORKFLOW_APPROVAL_PARKING=on   # parked-approval runs free their slot; reaper re-admits
WORKFLOW_STEP_RETRY=on         # transient step failures retry w/ backoff (set step retry_budget)
WORKFLOW_CONTRACT_OUTPUT=on    # verify step output vs declared contract before completing
TOOL_CHOICE_CONTEXT_INJECT=on  # remembered tool choices injected into context (learning)
UNIFIED_SCOPE_GATE=on          # "show MY accounts" resolves scope before querying
```

Already default-ON (no action): `WORKFLOW_STEP_AGENT`, `WORKFLOW_TYPED_CONTRACT`,
`WORKFLOW_SELF_HEAL`, `LARGE_TOOL_OUTPUT_DIGEST`, `CLEMMY_CONFIRM_FIRST`,
`CLEMMY_SCOPED_RECALL`, `CLEMMY_WORKFLOW_WATCHDOG`, `CLEMMY_WORKFLOW_RUN_LANE`.

Optional fast-feedback overrides while testing:
```
CLEMMY_WORKFLOW_PARKED_STALL_MS=120000   # surface a parked run after 2 min (default 1h)
CLEMENTINE_WORKFLOW_RETRY_BASE_MS=500     # quicker retry backoff
```

## 2. Launch dev

```
# terminal 1 — daemon (webhook + workflow lanes + watchdog + Discord if enabled)
cd ~/clementine-next
npm run build            # compile dist (also the desktop daemon source)
npm run daemon:start     # or `npm run daemon -- --foreground` to watch logs live
npm run daemon:logs      # tail

# terminal 2 — desktop shell (Electron, talks to the same daemon)
cd ~/clementine-next/apps/desktop
npm run dev              # tsx src/main.ts  (live-reload main process)
```

Health check before testing: `npm run doctor`.

## 3. Per-surface end-to-end checklist

### Workflow runs + Activity monitoring
1. Author or trigger a workflow (Console → Workflows, or via chat "run <workflow>").
2. **Activity feed** should show the run with **plain-language** status/kind/preview
   and a milestone **timeline** — not raw `turn_started`/`condenser_applied` events
   (that's the new `activity-format.ts`). The "Technical details" toggle still shows
   raw events.
3. Confirm the run reaches `completed` (or a legible `needs attention`) and a
   completion notification fires.

### Approval parking (the durability fix)
1. Enable a workflow with a `requires_approval` step (e.g. a send step).
2. Trigger TWO runs at once (or set `CLEMENTINE_WORKFLOW_RUN_CONCURRENCY=1`).
3. Verify the second run **progresses while the first is parked** on approval
   (parking freed the slot) — first run shows `parked`, second completes.
4. Approve the first → it **resumes to completion** within ~15s (reaper re-admit).
5. Negative: reject it → run ends loudly (`needs attention`/error), never stuck.
6. Orphan net: leave a run parked > `CLEMMY_WORKFLOW_PARKED_STALL_MS` → the
   watchdog posts "still awaiting your approval" (never silent).

### Step retry (long-running without failing)
1. Add `retry_budget: 2` to a step whose tool can hit a transient error.
2. Force/observe a transient failure → Activity shows `step_retry` attempts with
   backoff, then success. A deterministic failure (bad input/contract) does NOT
   retry — it fails fast.

### Contract verification (completes workflows correctly)
1. Give a step an `output` contract (e.g. `verify: { url_present: ['url'] }`).
2. Make it return no url → the step **fails the contract** (step_failed), the run
   does NOT record it as completed, and resume won't treat the bad output as done.

### Tool-choice learning + measured hit-rate (ever-learning)
1. With `TOOL_CHOICE_CONTEXT_INJECT=on`, do a task that discovers + remembers a
   tool, then repeat a similar task next turn — Clem should reuse the remembered
   tool (visible in the "Remembered Tool Choices" context block) instead of
   re-discovering.
2. The nightly autoresearch report (vault `00-System/autoresearch/<date>.md`) shows
   a **"Tool-choice learning"** section with a recall **hit-rate** — and tool_choice
   no longer pollutes the tool-health table.

### Scoped chat (delivers the right answer)
1. With `UNIFIED_SCOPE_GATE=on`, ask in chat "show my <owned records>". Clem should
   resolve scope (recall the owner filter / ask one clarifying question) before
   querying — not silently return everyone's records.

### Discord delivery + desktop↔Discord sync
1. With `DISCORD_ENABLED=true` + bot token (option A), DM the bot or mention it in
   an allowed channel → Clem replies in Discord.
2. The SAME conversation/run appears in the desktop **Activity** feed with the same
   friendly phrasing (shared `activity-format.ts`), and a workflow completion
   notification is delivered to BOTH the desktop and the Discord channel.
3. Notifications: trigger a delivery failure (e.g. bad webhook) → you get a
   user-facing "delivery failed after N attempts" notice, not silence.

## 4. Notes / known limits

- All new behavior is flag-gated; with flags off the daemon behaves exactly as the
  released app.
- The macOS packaged app can't spawn child deterministic-step scripts (TCC
  sandbox) — that only affects deterministic `scripts/` steps and only in the
  packaged app, not dev. (See memory: macOS TCC blocks child node CLIs.)
- Full deferred/known-issue list + commit map: memory
  `project_northstar_hardening_resume.md` and `project_measured_learning_loop.md`.
