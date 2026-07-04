# Workflow Execution Subsystem Audit — Clementine Harness

Scope: `src/execution/*` (runner, scheduler, watchdog, preflight, enforce, step-binding, step-output-verify, transient-error, bounded-pool), `src/execution/workflow-events.ts`, the step judges, and the harness step lane. Audited as-is with the uncommitted working-tree changes present.

## 1. Execution model end-to-end

The pipeline is **deterministic orchestration wrapping LLM leaf work.**

**Trigger → enqueue (deterministic).** Three enqueue paths all write a JSON run record into `WORKFLOW_RUNS_DIR`:
- Schedule: `processWorkflowSchedules` (`workflow-scheduler.ts:185`) matches cron against the wall clock each daemon tick, dedupes per workflow-minute, backfills missed windows into a single catch-up run, and writes a `queued` record (`enqueueScheduledRun:388`). Cron matching is pure code (`cronMatches:157`).
- Manual/chat/dashboard/webhook: run-queue tools (outside this subsystem) write the same record shape.
- A richer typed trigger schema exists (`workflow-trigger-registry.ts`) with deterministic dedupe keys + a SQLite table, but it is **schema-only** — the live scheduler still uses the file/minute-key path, not this registry.

**Drain → run dispatch (deterministic).** `drainWorkflowRuns` (`workflow-runner.ts:4017`) scans the dir, filters to `queued`/`running`/fresh `dry_run`/`creation_test`, and hands eligible runs to `runBoundedPool` (`bounded-pool.ts:20`). `processOneRunFile` (`4444`) branches on status (not-found, dry_run preflight, creation_test, disabled gate) then calls `executeWorkflow`.

**Step DAG (deterministic planning, LLM execution).** `executeWorkflow` (`3530`) computes resume state from the event log, then loops: `planWorkflowExecutionBatches` (`3100`) topologically sorts steps by `dependsOn` into ready-batches; each batch runs under `Promise.allSettled` (`3656`). Per step, `executeStepVerified → runStepVerifiedAttempt → executeStep` dispatches by shape: **deterministic** script (`2616`, no LLM), **forEach** fan-out (`2653`), or **plain** LLM step (`2915`, via `runStepViaHarness:1362` — the LLM decision boundary).

**Verify/judge → next step (deterministic gate + LLM judge).** Every shape funnels through `finalizeStepOutput` (`2376`), which coerces JSON-in-text to the declared contract (`coerceOutputForContract:2290`), runs the deterministic `verifyStepOutput` (`step-output-verify.ts:80`), and only then emits `step_completed`. Optional LLM judges (skill-execution, target, goal) run around this. Output feeds `stepOutputs`, unblocking dependents on the next batch iteration.

**Synthesis + report (mixed).** An optional synthesis LLM pass (`3711`) aggregates outputs; a large terminal block then judges the goal, decides re-pursuit/self-heal, and reports back.

So **planning, dependency resolution, retry/fallover policy, contract verification, side-effect classification, and reporting are all code.** The LLM owns only step-body execution, synthesis prose, and the advisory/goal judges.

## 2. Runtime looping

**There is no general bounded-loop / repeat-until-condition primitive.** Iteration exists in five narrow forms:

1. **`forEach` fan-out** over a *materialized* upstream array (`executeStep:2653`; `coerceToArray:843`). Unbounded lists are processed in windows of `forEachMaxItems()` (`2883`) but the list is fixed at fan-out time — you cannot express "keep paginating until the API returns no more."
2. **`loopUntil` contract loop** (`runWithContractLoop:2057`) — re-runs a single step up to `loopUntilMaxAttempts` (default 3, clamped 1–5, `2001`), appending failure evidence each attempt (`2088`). **Narrowly gated:** `stepLoopUntilEnabled` (`1991`) requires a declared `output` contract AND excludes forEach/deterministic/send steps. The only runtime "loop until a condition" is *retry a plain read/compute step until its output contract passes.*
3. **Transient retry** (`runWithStepRetry:1928`, `for(;;)` at `1941`) — infra-blip retries with backoff, gated by `isTransientStepError` (`transient-error.ts:27`).
4. **Brain fallover** (`executeStepVerified:2111`) — re-runs the whole step on the next provider on a transient/unparseable failure.
5. **Whole-workflow re-run** — the workflow-level "loop": goal re-pursuit re-queues a fresh full run (`decideGoalRunOutcome:4251`), self-heal re-queues (`tryAutoHealAndRequeue:4123`), and the scheduler re-fires on cron.

**Dynamic step counts do not exist** — the step list is static per definition. A "loop" is fan-out over a known list, per-step retry against a contract, or a re-queued re-run of the whole workflow.

## 3. Concurrency & isolation

Two independent bounded tiers:
- **Run-level:** `runDrainConcurrency()` (`3870`) defaults to **1** (`CLEMENTINE_WORKFLOW_RUN_CONCURRENCY`) — runs drain **serially by default**. `inFlightRunIds` (`4038`, `4047`) prevents double-pickup.
- **Step/item-level:** `RUNNER_CONCURRENCY` defaults to **5** (`154`, `CLEMENTINE_WORKFLOW_CONCURRENCY`). Ready steps in a batch run concurrently (`3656`); forEach items run via `runWithConcurrency` (`900`) capped at `min(RUNNER_CONCURRENCY, maxItems, pending)` (`2697`).

**Per-run isolation** is via the durable event log: each step gets its own harness session `workflow:<runId>:<stepId>` and per-run `events.jsonl`; item progress is keyed by run+step (`217`) precisely because two forEach steps in one batch run concurrently. `runBoundedPool` guarantees one bad run cannot strand the others (`bounded-pool.ts:12`).

## 4. Failure handling & restart survival

- **Transient classification** (`transient-error.ts`): regex + status-set (408/429/500/502/503/504/529), a non-retryable override for approval/contract/missing-input phrasing, cause-chain recursion, and status-in-message extraction for SDK-wrapped errors. `isUnparseableToolCallError` (`51`) is fallover-eligible but not same-model-retryable.
- **Retry** (`runStepVerifiedAttempt:2173`): transient-only, budget-bounded, backoff, **suppressed once a send already fired** (`stepSendAlreadyFired`, `2193`) to prevent double-send.
- **Brain fallover** (`executeStepVerified:2111`): step-boundary provider switch (Codex→Claude→BYO), guarded by `canSwitchBrainForStep` (`2162`) which refuses to re-run a step that already recorded an `external_write`.
- **Watchdog** (`workflow-watchdog.ts:344`): observe-only scanner on its own timer, detecting `queued_not_draining` (5m), `running_silent` (10m no harness events), `parked_awaiting_approval` (1h), `terminal_unnotified` (3m–12h), with a notification-log ground-truth cross-check (`reportedBackRunIdsFrom:233`) so it never false-alarms a run that did report back.
- **Approval parking** (`awaitDeclarativeStepApproval:1705`): registers a durable approval row, throws `ParkRunSignal` to release the pool slot; `reapResolvedParkedRuns` (`3814`) flips the run back to running once the approval clears. Unattended scheduled runs auto-approve **non-send** gates but never send-class gates (`1738`).
- **Crash/restart resume:** the durable `events.jsonl` is the resume substrate. `computeResumeState` (`workflow-events.ts:381`) replays events into completed steps, completed forEach items, failed steps, and an `inFlightStepId`. Completed steps/items are skipped on resume; a step that *started but never completed* and has an external side effect is **halted, not re-run** (`shouldHaltResumeForSideEffect:3504`, thrown at `3565`) → needsAttention for human confirmation. `reconcilePendingWorkflowRuns` (`5525`) surfaces in-flight runs at startup; parked runs survive as status `parked`. Key guarantee: `finalizeStepOutput` verifies **before** emitting `step_completed`, so a contract-rejected output is never resumable as a valid done step.

## 5. Gates & judges in the step lifecycle

Ordered by position in `executeStep`:
1. **Declarative approval gate** (pre-exec, `2608` → `awaitDeclarativeStepApproval`): runner-owned, parks the whole run until a human resolves. Can block indefinitely (bounded by the approval-wait budget).
2. **Missing-required-input fast-fail** (`bindStepInputs`, `step-binding.ts:124`): loud named error before the agent runs.
3. **Phantom-completion guard** (`isPhantomStepCompletion:3188`, applied at `1495`): a send/write step that called zero real tools is rewritten to `{blocked:true}`.
4. **Skill-execution HARD gate** (`3000`): a `usesSkill` step whose renderer script never ran **throws**.
5. **Skill-execution advisory judge** (`workflow-step-judge.ts`): detection-only, records a non-failing advisory, never blocks.
6. **Output-contract verification** (`finalizeStepOutput:2376` → `verifyStepOutput`): type/required_keys/non_empty/min_items/path_exists/url_present. **Blocks** (throws `WorkflowContractViolationError`, deterministic so no transient retry).
7. **Empty-deliverable-read detector** (`detectEmptyDeliverableReads:3228`): post-run, inform-only needsAttention.
8. **Run-level judges** (terminal): `judgeWorkflowTarget` (legacy fuzzy, advisory) and `validateGoal` → `decideGoalRunOutcome` (can re-pursue or escalate).

## 6. Uncommitted git diff summary

Two additive, defensive changes:

**`workflow-enforce.ts`** — `autoRepairWorkflowDefinition` now also calls `hardenWeakLiveResearchOutputContract` per step (adds source-backed evidence keys to weak live-research output contracts), and `checkWorkflowForWrite` appends `workflowAuthoringAdvisories(def)` to its warnings. Both pull from the expanded `workflow-contract-proposals.js`. Non-blocking (warnings + auto-repair only).

**`workflow-runner.ts`** — adds `hasUngatedIrreversibleAction(steps)` (`4106`) + helper `stepRequiresApproval` (`4095`), exported for test (`1355`). Wired into `tryAutoHealAndRequeue` (`4148`): **self-heal now refuses to auto-rewrite-and-re-run a workflow containing any send-class step not protected by an approval gate** — escalating for human approval instead of silently re-running into an irreversible external action. Classifies via declared `sideEffect` then prose heuristic, consistent with `stepSideEffectClass`. Closes a real hole where a model-authored prompt fix could auto-continue into an unguarded send.

## 7. Strengths + top 5 gaps

**Strengths.** Event-log-as-resume-substrate is genuinely robust: verify-before-complete, per-item resume, and side-effect-aware halt give strong crash idempotency. Side-effect reasoning is consistent across four independent guards (retry-suppress-after-send, no-brain-switch-after-write, no-repursue-if-unsafe, no-self-heal-if-ungated-send). Transient/deterministic classification is careful. The watchdog's notification-log ground-truth check is a strong "reports back without fail" backstop. Failure surfacing is legible and never silently swallows.

**Top 5 gaps:**

1. **Phantom-completion guard covers only the SDK lane, not the orchestrator harness lane.** `isPhantomStepCompletion` is applied at `workflow-runner.ts:1495` (Claude Agent SDK path), but the orchestrator `runConversation` path returns output at `1672` and `1680` with **no phantom check.** A send/write step on Codex/GLM (or Claude's non-SDK lane) that emits prose without calling a tool passes as a silent success — exactly the unattended/yolo failure the guard exists to prevent (`3172` comment). Single most impactful gap.

2. **No runtime-discovered iteration, and `loopUntil` is narrowly gated.** `stepLoopUntilEnabled` (`1991`) excludes forEach/deterministic/send and caps at 5 attempts (`2001`); forEach requires a fully-materialized array (`843`). No pagination / "repeat until condition" / dynamic work-queue construct — such workflows must be modeled as whole-workflow re-queues (coarse, expensive).

3. **Run drain is serial by default** (`runDrainConcurrency()` → 1, `3870`). A single long non-parking run head-of-line-blocks the whole queue; the `queued_not_draining` watchdog is *detection*, not a fix. Parking releases the slot, but a genuinely long-running step does not.

4. **Both remediation loops re-execute the ENTIRE workflow.** Goal re-pursuit (`decideGoalRunOutcome:4251` → `requeueWorkflowFromRun`) and self-heal (`tryAutoHealAndRequeue:4123`) re-queue a full fresh run rather than the failing sub-graph. Bounded by `maxAttempts` + the `shouldStopAutoHeal` circuit breaker, but token-expensive and re-does all upstream read work. No step-scoped re-pursuit.

5. **Parallel-batch failure fails the whole run and cancels sibling parks.** In `executeWorkflow` (`3683`), one genuine step error in a `Promise.allSettled` batch throws for the entire run even though siblings completed, and cancels any sibling's parked approval rows (`3685`). Completed siblings are durable (resume skips them) but there is no partial-batch retry. Related: the **synthesis pass** (`3711`) runs a single `runStepViaHarness` attempt (`maxTurns:8`) that is **not** contract-verified, **not** phantom-guarded, and **not** brain-fallover'd — a synthesis-time provider blip fails the whole run at the finish line.

**Secondary notes:** crash-resume idempotency depends on tools emitting `external_write` events — a side-effecting tool that doesn't emit one is invisible to `canSwitchBrainForStep`/`shouldHaltResumeForSideEffect`; the mid-forEach-item crash window relies on `itemSendAlreadyFired` (`3352`). The live scheduler bypasses the deterministic `workflow-trigger-registry` dedupe schema, so cross-process double-fire protection rests on the shared `SCHEDULE_STATE_FILE` minute-key alone.

Key files: `src/execution/workflow-runner.ts`, `workflow-events.ts`, `workflow-scheduler.ts`, `workflow-watchdog.ts`, `step-output-verify.ts`, `step-binding.ts`, `transient-error.ts`, `bounded-pool.ts`, `workflow-step-judge.ts`, `workflow-enforce.ts`, `workflow-preflight.ts`, `workflow-trigger-registry.ts`.
