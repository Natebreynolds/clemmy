# Loop Semantics Audit — Clementine Harness

Read-only, working tree as-is (`reliability/live-run-cluster-2026-06-30`). All citations `file:line`.

## TL;DR verdict

"Loop" collapses three distinct machines, at very different maturity:

| Sense | What it is | Strength | Reason |
|---|---|---|---|
| **(a) Harness agentic loop** | think→act→observe turn loop in one run | **Strong** | Single shared `runConversation` in `loop.ts`; chat and workflow steps use the *same* implementation |
| **(b) Scheduled recurrence** | a workflow re-firing over time | **Partial** | Cron works well; `webhook`+`system_event` trigger kinds are declared in a schema **nothing consumes** |
| **(c) Intra-run iteration** | `forEach` + `loopUntil` + run-goal re-pursuit | **Moderate** | Batch fan-out over a *materialized* list is real/typed. **No "for each new item since last run"** primitive |

The owner's premise — "loops Clementine creates that auto-heal and auto-improve after they run" — maps to (b) + auto-heal, the weakest-to-middling area. Auto-heal is typed and real; auto-*improve* is thin. Event-driven recurrence ("for every new lead") does not exist as engine machinery.

## 1. Harness loop vs workflow steps — is there a FORK?

The loop is `runConversation` at `src/runtime/harness/loop.ts:1442` — bounded: `while (stepIndex < maxSteps)` (`loop.ts:1570`), `maxTurns` (`loop.ts:1472`), `maxWallMs`. A resume twin `runConversationFromResume` exists (`loop.ts:4209`, loop at `4330`).

Each workflow step runs its own harness loop — **the same one**: `runStepViaHarness` (`workflow-runner.ts:1362`) calls `runConversation` (`workflow-runner.ts:1538`) with a 15-min wall clock. A workflow of N steps = N sequential harness loops (plus one per forEach item).

**On THE FORK:** callers of the shared `runConversation` include `respond-bridge.ts` (chat), `discord-harness.ts`, `claude-agent-brain.ts`, AND `workflow-runner.ts` + `goal-resume.ts`. So chat turns and workflow steps **share one loop implementation** — the fork is not two loop engines. It lives at *entry/config*: chat = orchestrator agent + ~120-min budget; workflow step = constrained `workflow-step-agent` (`useWorkflowStepAgent()` default on, `workflow-runner.ts:3879`) + 15-min budget + plan-scope grant. **The one genuinely separate loop body** is the Claude Agent SDK step lane `runClaudeAgentSdkWorkflowStep` (`workflow-runner.ts:1450`) — that's where per-brain behavioral drift can actually live today.

## 2. Scheduled recurrence, triggers, overlap

**Only cron fires.** `processWorkflowSchedules()` (`workflow-scheduler.ts:185`) is polled every daemon tick (`daemon/runner.ts:1414`), matches `wf.trigger.schedule` vs wall clock (`cronMatches`, `workflow-scheduler.ts:157`), writes a queued run (`enqueueScheduledRun`, `:388`); `processWorkflowRuns` drains it (`daemon/runner.ts:1446`). Well-built: misfire catch-up collapsing a missed window to one run, 24h cap (`scheduleCatchupWindow`, `:91`, `MAX_CATCHUP_MINUTES` `:79`); timezone-correct (`wallClockInZone`, `:130`).

**Overlap:** `MAX_PENDING_PER_WORKFLOW = 3` (`:294`) — beyond 3 queued/running, new fires are skipped with a user notice (`emitQueueBackpressureNotice`, `:328`). Overlap is prevented by default anyway: `runDrainConcurrency()` defaults to **1** (`workflow-runner.ts:3870`, global serial drain) and `processWorkflowRuns` single-flights (`workflowDrainInFlight`, `:3794`). Same-workflow/same-inputs also dedupe (`findDuplicateQueuedWorkflowRun`, `workflow-run-queue.ts:26`). No per-workflow mutex beyond that if an operator raises concurrency.

**Gap:** `workflow-trigger-registry.ts:12` declares `manual|schedule|webhook|system_event` with full SQL schema + dedupe templating (`:101`) + a `workflow_trigger_events` table — but `grep -rln workflow-trigger-registry src | grep -v test` = **zero** non-test importers; `system_event`/`webhookPath` outside the registry+tests = **zero**. Event/webhook recurrence is designed-but-dark. A legacy `CRON.md` path also still fires (`schedule_list`, `workflow-schedule-tools.ts:251`).

## 3. Intra-run iteration — "check 50 prospects each morning"

All three are code-level, not prompt instructions:

**(i) forEach fan-out** — `workflow-runner.ts:2652-2910`. `step.forEach` names an upstream array (`resolveForEachSource`; `coerceToArray` `:2656`), keys each item, **skips completed items on resume** (`ctx.completedItems` `:2671`), runs with bounded concurrency `RUNNER_CONCURRENCY=5` (`:154,:2697`) in windows of `forEachMaxItems()=200` (`:161`, window loop `:2883`). Each item spawns its own `runStepViaHarness` (`:2784`). Per-item failures accumulate (`ctx.forEachFailures` `:2903`) and failed items re-run in isolation later (`requeueWorkflowFailedItemsFromRun`, `workflow-run-queue.ts:336`); send-items are crash-resume idempotent (`:2739`).

→ **"check 50 prospects each morning" works today**: scheduled trigger fires; step 1 yields a 50-element array; step 2 `forEach: '{{step1}}'` fans out 5-at-a-time, resumable, per-prospect isolated.

**(ii) loopUntil — the only thing literally named "loop"** — `workflow-runner.ts:1991-2251`. A step with `loopUntil`+output contract re-runs itself injecting the contract-violation evidence (`runWithContractLoop`, `:2057`) until pass/exhaust; bounded 1–5, default 3 (`:2001`). Side-effect law (`stepLoopUntilEnabled`, `:1991`): reads loop freely, writes need `loopSafe:true`, **sends never loop**, forEach/deterministic excluded. This is self-correction, not iterate-over-data.

**(iii) Run-goal re-pursuit** — `workflow-runner.ts:4201-4280`. If the whole run's success criteria aren't met, re-queue the entire workflow with the shortfall folded into the prompt (`workflowRunGoal` `:4207`, decision `:4271`), bounded by `clampGoalMaxAttempts`.

**The gap for the premise:** all three iterate a list *materialized inside the current run*, or retry the same work. No "for each NEW lead / row added since last run" primitive — that needs either the unwired event triggers (§2) or cross-run watermark state the engine doesn't carry. Today "new" is the LLM step's job inside its prompt.

**Altitude split:** when a step does NOT declare `forEach`, fan-out degrades to prompt nudges (`fanout-advisory.ts`, `fanout-directive.smoke.test.ts`). So identical intent runs as typed resumable fan-out OR one fragile agent turn depending on authoring.

## 4. Auto-heal / auto-improve

**Auto-heal is real + typed** — `workflow-runner.ts:4059-4183` + `workflow-diagnosis.ts`. On a blocked run: `diagnoseWorkflowBlock` (`workflow-diagnosis.ts:391`) → `recordProposedFix` → `applyProposedFix` edits the def → `requeueWorkflowFromRun` exercises it (`workflow-runner.ts:4177`). Bounded: `selfHealAutoMaxAttempts` (`:4070`), chronic-failure circuit breaker (`:4132`), hard refusal on ungated irreversible action or already-completed upstream mutation → escalate to human (`:4149-4158`).

**Auto-improve is thin.** Attempt records (`attempt_record` events, per-attempt cost/diff) + failure ledgers (`workflow-failure-ledger.ts`) give the *substrate*, but the closed "run→measure→durably rewrite to be better" loop is advisory/manual and only fires on failure — no success-path improvement loop.

## 5. Termination bounds (all healthy — no unbounded agent-facing loops)

| Loop | Bound | Location |
|---|---|---|
| Harness turn loop | maxSteps/maxTurns/maxWallMs | `loop.ts:1472,1570` |
| Workflow step | 15-min wall clock | `workflow-runner.ts:172,1538` |
| forEach | window 200, concurrency 5, per-item wall clock | `workflow-runner.ts:161,154,2883` |
| loopUntil | 1–5, default 3 | `workflow-runner.ts:2001` |
| Run-goal re-pursuit | clampGoalMaxAttempts | `workflow-runner.ts:4214,4271` |
| Self-heal | max attempts + chronic breaker | `workflow-runner.ts:4070,4132` |
| Scheduler overlap | MAX_PENDING=3; drain serial | `workflow-scheduler.ts:294`; `workflow-runner.ts:3870` |
| Schedule catch-up | 24h cap → 1 run | `workflow-scheduler.ts:79,91` |

Daemon `while(true)` (`daemon/runner.ts:1408`) is the intended staggered poll loop.

## 6. Verdict + top 5 gaps

**Strong/weak:** (a) harness loop = **strong, genuinely unified**. (b) recurrence = **cron strong, event triggers missing**. (c) intra-run = **batch fan-out strong; cross-run/new-item iteration missing; auto-improve immature**.

1. **Event-driven recurrence designed but unwired.** `webhook`+`system_event` schema exists (`workflow-trigger-registry.ts:12,32-79`) with dedupe machinery, **zero non-test consumers**. "When a new lead arrives, run X" is impossible; only cron fires. #1 blocker for the "loops that react to the world" premise.
2. **No for-each-new-item across runs.** `forEach` (`:2653`) only iterates a list materialized in the current run; no cross-run "already processed" watermark. Novelty detection is pushed into the LLM prompt — the prompt-over-code pattern the owner's rule forbids.
3. **Auto-improve is instrumented, not automated.** Attempt records + failure ledgers exist, but the durable run→measure→rewrite loop is advisory and fires only on failure (`applyProposedFix` inside self-heal, `:4132`).
4. **Two fan-out altitudes coexist.** Typed `forEach` (`:2653`) vs prompt-nudged fan-out (`fanout-advisory.ts`). Which fires depends on authoring → identical intent can run as resumable typed fan-out or one fragile turn. Consolidate at author time.
5. **The Claude Agent SDK step lane is a real second loop body** (`workflow-runner.ts:1450`), separate from the shared `runConversation`. The chat-vs-workflow FORK is mostly closed, but this brain-specific lane is where divergence actually lives; it needs parity tests against the shared loop.
