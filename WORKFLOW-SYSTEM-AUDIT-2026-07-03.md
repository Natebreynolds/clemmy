# Workflow System Audit — 2026-07-03

Five parallel deep-reads of the workflow subsystem (authoring, execution, loop semantics, self-heal/self-improve, visibility), synthesized against the north star: **workflows are loops Clementine creates, that auto-heal and auto-improve after they run — best-in-class visibly and execution-wise.**

Audited as-is on `reliability/live-run-cluster-2026-06-30` including the uncommitted working-tree changes (live-research contract hardening + self-heal ungated-send guard — both good, both noted below).

---

## Verdict

The execution core is genuinely strong — arguably already ahead of most agent harnesses. The premise ("loops that auto-heal and auto-improve") is **half true today**:

| Pillar | Grade | One-line reason |
|---|---|---|
| Execution reliability | **A−** | Event-log resume substrate, verify-before-complete, consistent side-effect algebra across 4 independent guards |
| Authoring pipeline | **B+** | One canonical write path, auto-repair, creation smoke test — but the most common loop-authoring defect ships as a warning |
| Loop expressiveness | **C** | forEach + loopUntil + goal re-pursuit are real but narrow; no while/until-external-state, no event triggers, no cross-run "new items" primitive |
| Auto-heal | **B** | Real, bounded, reversible, guarded — but prompt-rewrite-only, single-step, self-graded by the same model |
| Auto-improve | **C−** | Failure-only; successful runs never tighten their workflow; fast loop (Doctor) and slow loop (nightly proposer) don't share signals |
| Visibility | **C+** | Desktop live run view is good; channels are blind mid-run; past-run inspection UI doesn't exist despite all data being recorded |

**The dominant pattern across all five audits is "designed but dark."** The event-trigger registry, the branch/condition graph executors, `transcript_chunk` streaming, the board/queue cockpit endpoints, `attempt_record` timelines, task vitals — all built (often tested), zero non-test consumers. This is the Agentic Employee Mandate finding again: the path to best-in-class is mostly **WIRE, not build**.

---

## What is genuinely strong (do not churn)

- **One shared harness loop.** Chat turns and workflow steps both run `runConversation` (`src/runtime/harness/loop.ts:1442`); THE FORK is closed at the loop level. The one true second loop body is the Claude Agent SDK step lane (`workflow-runner.ts:1450`).
- **Durable event-log substrate.** Append-only `events.jsonl` per run; `computeResumeState` (`workflow-events.ts:381`) replays into completed steps/items; contract verification happens **before** `step_completed` is emitted, so a bad output is never resumable as done.
- **Consistent side-effect safety algebra** across four independent guards: retry suppressed after a send fired (`workflow-runner.ts:2193`), no brain-switch after an external write (`:2162`), no goal re-pursuit past an irreversible step (`:4228`), and (uncommitted) no self-heal re-run with an ungated send step (`:4148`).
- **Author-time hardening**: single canonical write path `commitAuthoredWorkflow` shared by create and promote; deterministic auto-repair (`workflow-enforce.ts:403`); real read-only smoke test at creation, save-disabled-until-pass (`orchestration-tools.ts:892`).
- **Approval UX** — best-in-class across desktop/Discord/Slack/mobile: durable parking (`ParkRunSignal`), buttons + typed fallback + edit modal, restart-safe recovery cards.
- **Honest, guaranteed-once report-back** with watchdog ground-truth cross-check against the notification log (`workflow-watchdog.ts:233`).
- **Reversibility discipline** on every self-edit: backups + `revert heal <id>` (`workflow-diagnosis.ts:501,530`), re-validation via `checkWorkflowForWrite` before any write.

---

## Theme 1 — Loop expressiveness is the biggest gap vs. the premise

"Loop" today means exactly four bounded things: `forEach` over a materialized array (200-item window, `workflow-runner.ts:161`), `loopUntil` retry-until-own-output-contract-passes (1–5 attempts, `:2001`), transient retry, and whole-run re-queue (goal re-pursuit / self-heal / cron). All healthy and bounded. What cannot be expressed:

1. **Event-driven recurrence — designed but unwired (#1 blocker).** `workflow-trigger-registry.ts:12` declares `manual|schedule|webhook|system_event` with a full SQLite schema and dedupe-key templating — **zero non-test importers**. Only cron fires. "When a new lead arrives, run X" is impossible as engine machinery.
2. **No cross-run watermark / "for each NEW item since last run."** `forEach` iterates only a list materialized inside the current run; novelty detection is pushed into the LLM prompt — exactly the prompt-over-code pattern the house rules forbid.
3. **No while/until over external state.** `loopUntil`'s only exit is the step's own output contract (`stepLoopUntilEnabled`, `workflow-runner.ts:1991`); "keep paging until no cursor" / "poll until job done" cannot be authored. No dynamic worklist (an item can't enqueue more items).
4. **No conditional branching in the executed model — the machinery exists, stranded.** `condition`/`branch`/`join` node types and `applyWorkflowGraphBranchDecision`/`applyWorkflowGraphPatch` executors are defined (`workflow-graph.ts:7-21,238,281`), but `compileWorkflowStepsToGraph` emits only `step` nodes + `dependency` edges (`:119,295-298`) and the runner uses the graph purely as a visualization snapshot (`workflow-runner.ts:4712`).
5. **The most common loop-authoring defect ships.** "For each of the 25 firms…" without `forEach` is a **warning**, not an error or auto-repair (`checkParallelismHint`, `workflow-validator.ts:503,793`) — the workflow saves and runs serially in one context, silently dropping the tail. Two fan-out altitudes coexist (typed `forEach` vs prompt-nudged `fanout-advisory.ts`); which one fires depends on authoring luck.
6. **Promotion drops all iteration fidelity.** `trace-to-workflow.ts`: a tool called N times becomes one step with a prose hint (`:156-158`); no data-flow inference (`getToolOutput` imported, deliberately unused, `:320-322`); no parameterization. A promoted "loop" is authored as a single non-looping step.

## Theme 2 — Self-improvement only fires on failure, and its loops don't talk

Three disconnected mechanisms: **A. Doctor self-heal** (immediate, auto-applies narrowly), **B. write-time contract hardening** (create/enable only), **C. nightly improvement proposer** (3am, human-gated).

1. **Successful runs never tighten their own workflow.** Clean runs only write a recall pattern + distill a skill (`workflow-runner.ts:5031-5053`); the proposer's workflow detectors are failure/cost-only (`improvement-proposer.ts:297,470`). "Every run makes the workflow better" is false for the common loose-success case.
2. **Doctor and proposer don't share signals.** The Doctor persists a rich root-cause + rewrite per failed run (`workflow-diagnosis.ts:444`); the proposer never reads `workflow-fixes/` — it re-derives from raw events at the 3am tick. Same-day repeat failures get no proposal; the diagnosis is discarded for learning.
3. **Auto-heal self-grades and never scores the result.** `autoApplicable` is decided by the same fast model that wrote the fix (`workflow-diagnosis.ts:399-404`); no new-vs-old quality comparison after the re-run. A heal that unblocks but degrades the deliverable resets the failure streak and reads as success. Violates the "judge a different family" directive for an auto-mutating action.
4. **Auto-heal is prompt-rewrite-only and single-step** — only `kind==='edit_step'` with a full `newStepPrompt` auto-applies (`workflow-runner.ts:4144`); diagnosis covers only the first blocked step (`workflow-diagnosis.ts:391`). Corrected tool bindings, contract repairs, input fixes all fall to manual.
5. **Pattern store has no quality gate, decay, or removal** — monotonic `successCount`, latest-run overwrite (`workflow-pattern-store.ts:203-218`), token-overlap recall (`:233`); stale/degraded patterns propagate into every future model step prompt (`workflow-runner.ts:3596`).

## Theme 3 — Execution correctness holes (small, surgical, high-trust-impact)

1. **Phantom-completion guard covers only the SDK lane.** `isPhantomStepCompletion` applied at `workflow-runner.ts:1495` (Claude SDK path); the orchestrator `runConversation` path returns at `:1672,1680` with **no phantom check**. A send/write step on Codex/GLM that emits prose without calling a tool passes as silent success — the exact unattended failure the guard exists to stop. **Most impactful single fix in this audit.**
2. **The synthesis pass is unprotected.** Single attempt, `maxTurns:8`, not contract-verified, not phantom-guarded, no brain fallover (`workflow-runner.ts:3711`) — a provider blip at the finish line fails the whole run.
3. **One batch failure fails the run and cancels sibling parks** (`workflow-runner.ts:3683-3685`); completed siblings are durable but there's no partial-batch retry.
4. **Remediation always re-runs the ENTIRE workflow** — goal re-pursuit and self-heal re-queue full runs, re-doing all upstream read work; no failing-sub-graph re-pursuit.
5. **Run drain is serial by default** (`runDrainConcurrency()` → 1, `workflow-runner.ts:3870`); one long non-parking run head-of-line-blocks the queue; the watchdog detects but doesn't fix.
6. **SDK step lane needs parity tests** against the shared loop — it's the one place per-brain behavioral drift can live (memory: the codex 0.12 regression class).

## Theme 4 — Visibility: the data is recorded; the consumers don't exist

1. **No past-run inspection UI (biggest visibility gap).** `run_summary` (emitted "for a future run-view consumer", `workflow-runner.ts:5188`), `attempt_record` with per-attempt criterion diffs + `{durationMs, tokens, toolCalls}` (`workflow-events.ts:88-101`), judge verdicts, per-step cost — all persisted, none rendered. Clicking a finished run opens no transcript.
2. **The cockpit is ~90% done server-side and unconsumed.** `GET /api/console/board` + per-run queue reconstruction (`console-routes.ts:6256,6230`; `reconstructWorkflowRunQueue`, `workflow-events.ts:469`) are built and tested; `console.ts` never fetches them. Task vitals (duration/effort/spend, `console-routes.ts:6123`) likewise computed, never read.
3. **Channels are blind during workflow runs.** The enriched "step X of Y · 12/50 items" heartbeat exists but is emitted `silent:true` (`workflow-runner.ts:304,315`) and delivery drops it. Discord/Slack users see nothing between kickoff and the terminal report. (Desktop↔Discord parity is a stated product principle — this is the largest parity break.)
4. **`transcript_chunk` streaming is declared and dead** (`workflow-events.ts:79`; only a test references it). No surface shows a step thinking/writing mid-run.
5. **Desktop live run view is 1s polling** (`console.ts:17613`) while three SSE streams already exist next door (`console-routes.ts:7784,7960,8021`) and every workflow event already mirrors into operational telemetry (`workflow-events.ts:215`).

---

## Prioritized roadmap (forward-only, extend canonical primitives, no re-architecting)

### P0 — Correctness surgeries (small diffs, big trust)
1. **Generalize the phantom-completion guard to the orchestrator lane** — apply `isPhantomStepCompletion` at `workflow-runner.ts:1672/1680` exactly as at `:1495`. Fixes the class for all brains.
2. **Protect the synthesis pass** like any step: contract-verify, transient retry, brain fallover.
3. **Partial-batch resilience**: on a batch member failure, let completed siblings stand (already durable) and stop cancelling sibling parked approvals; requeue only the failed sub-graph.

### P1 — Loop expressiveness (the premise; mostly wiring existing designs)
4. **Wire the trigger registry**: consume `system_event` (internal bus first — email-poller, composio triggers) and `webhookPath` in the daemon tick alongside cron. The schema, dedupe, and table already exist.
5. **Cross-run watermark primitive**: typed per-workflow cursor state (`lastSeen` keys persisted like schedule state) + a `forEach` mode that fans out only unseen items. Kills the "LLM decides what's new" prompt pattern.
6. **`loopUntil` v2 — external condition**: allow the exit condition to be a declared check (a deterministic script or a read-tool probe with a contract), enabling paginate-until-done / poll-until-complete, same 1–5 bound and side-effect law.
7. **Escalate multi-item-without-forEach from warning to auto-repair**: `autoRepairWorkflowDefinition` already exists as the mechanism; rewrite the step into list-step + forEach-step when `checkParallelismHint` fires with high confidence, else hard-error with the fix text.
8. **Promotion fidelity**: in `trace-to-workflow.ts`, infer `forEach` from N same-slug calls with list-shaped args, and wire `{{steps.<id>.output}}` bindings via the already-imported `getToolOutput`.

### P2 — Close the improvement loop (make "every run improves the workflow" true)
9. **Success-path tightening**: run the (new, uncommitted) contract-hardening propose/apply pass on run *outcomes*, not just at write time — observed outputs are the ground truth for tightening `required_keys`/`min_items`/`verify`.
10. **Doctor→proposer signal sharing**: proposer mines `workflow-fixes/` ProposedFix records instead of re-deriving from raw events.
11. **Heal scoring**: judge auto-applied heals with a different model family and compare post-heal run quality vs. pre-heal (attempt records already carry the metrics); auto-revert on regression using the existing backup + `evaluateAppliedProposals` machinery.
12. **Pattern store hygiene**: score + decay + last-N-outcomes instead of monotonic overwrite.
13. **Widen auto-heal fix kinds** beyond full prompt rewrite: tool-binding correction, contract repair, input adjustment — all already re-validated by `checkWorkflowForWrite` before write.

### P3 — Visibility (wire the dormant server side)
14. **Run inspector**: render a finished run's `events.jsonl` — step timeline, attempt records, judge verdicts, per-step cost. All readers exist (`listAttemptRecords`, `run_summary`).
15. **Ship the board/queue cockpit**: consume `/api/console/board` + `reconstructWorkflowRunQueue` in the desktop UI.
16. **Un-silence long-run progress in channels**: threshold-gated (e.g., runs >2 min) edit-in-place progress message from the existing enriched heartbeat. Restores desktop↔Discord parity.
17. **Emit `transcript_chunk` + ride the existing telemetry SSE** to replace 1s polling.

### P4 — Structural (decide deliberately, after P0–P3)
18. **Activate graph branch/condition execution** for the narrow cases P1 doesn't cover — the executors exist; this is the one item with re-architecture risk, so do it last and only if real workflows still can't be expressed.
19. **Sub-graph re-pursuit** replacing whole-run re-queues (token cost).
20. **SDK-lane parity conformance tests** vs. the shared `runConversation` (the codex-0.12 lesson, applied to steps).

---

## Note on in-flight work

The uncommitted working-tree changes (another session) are additive and align with this audit: live-research output-contract hardening (`workflow-contract-proposals.ts` + `workflow-enforce.ts:524-528`) and the self-heal ungated-irreversible-action guard (`workflow-runner.ts:4106,4148`). P2 item 9 is the natural extension of the former from write-time to run-outcome-time.

Source reports (full detail, per subsystem): `workflow-audit-2026-07-03/audit-{authoring,execution,loops,selfheal,visibility}.md`.
