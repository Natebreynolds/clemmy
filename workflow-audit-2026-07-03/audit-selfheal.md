# Workflow Self-Heal / Self-Improve Audit — Clementine harness

## Orientation: there are THREE separate loops, not one
The "self-improvement" premise is actually three disconnected mechanisms with different triggers, speeds, and gates:

| Loop | Trigger | Speed | Auto-applies? | Home |
|---|---|---|---|---|
| A. Doctor self-heal | a run with a `{blocked:true}` step | immediate (post-run) | yes, bounded + guarded | `workflow-diagnosis.ts`, runner `tryAutoHealAndRequeue` |
| B. Contract hardening | workflow write/repair (create/enable) | write-time | yes, at write only | `workflow-contract-proposals.ts` + `workflow-enforce.ts` |
| C. Improvement proposer | nightly 3am maintenance tick | ~daily | no — human-gated | `autoresearch/improvement-proposer.ts` |

Two red herrings in the brief's file list: `src/shared/workflow-scoring.ts` is a text tokenizer for workflow name-matching (NOT run scoring), and `src/memory/workflow-change-bus.ts` is an SSE pubsub for UI refresh (NOT a learning bus). Neither participates in self-improvement.

## 1. Automatic post-run pipeline (workflow-runner.ts:4767-5260, success path)
1. `executeWorkflow` → `detectBlockedSteps(stepOutputs, order)` (`4778`) finds blocked / self-reported-failure / forEach-failure steps.
2. `detectEmptyDeliverableReads` (`4794`) — inform-only advisory.
3. Target judge `judgeWorkflowTarget` (`4831`) — fail-open, detection-only; skipped if a pinned goal exists.
4. Pinned-goal validation `validateGoal` → `decideGoalRunOutcome` (`4871-4922`) — can repursue/satisfied/escalate/advisory; records `attempt_record` events (`4904`).
5. Diagnosis — only `kind:'blocked'` steps (`4980-4993`): `diagnoseWorkflowBlock` → `recordProposedFix` persists a ProposedFix.
6. Cross-fire ledger `recordWorkflowOutcome` (`5023`).
7. On clean runs only (`5031-5053`): `distillSkillFromSessions` (`5034`) + `recordSuccessfulWorkflowPattern` (`5045`).
8. Auto-heal `tryAutoHealAndRequeue` (`5114`).
9. `renderLegibleOutcome` (`5215`) + voice rewrite + notification.
Error path (`5405-5455`) mirrors: `recordWorkflowOutcome(false)` then diagnose + recordProposedFix for the escalation offer.
Wired vs dormant: all of the above is wired, default-on (`WORKFLOW_SELF_HEAL` defaults 'on', `workflow-diagnosis.ts:41`). Disconnected: the nightly proposer (loop C) never reads run-completion signals, and the Doctor's persisted ProposedFix files are never mined by the proposer.

## 2. Auto-heal on failure (workflow-runner.ts:4123-4190)
Applied AUTOMATICALLY, but through a narrow guarded gate: requires `selfHealEnabled()` + diagnosis + proposedFix (`4132`); chronic-failure breaker `shouldStopAutoHeal` (`4136`); ONLY `kind==='edit_step'` with `autoApplicable && newStepPrompt` (`4144`) — a full prompt rewrite; bounded by `CLEMENTINE_WORKFLOW_SELF_HEAL_MAX_ATTEMPTS` default 2 (`4070`,`4147`); side-effect guards `hasUngatedIrreversibleAction` (`4106`, uncommitted) + `hasCompletedUpstreamMutation` (`4082`). Everything else (reconnect/adjust_input/manual) is LOGGED + OFFERED for human `apply fix <id>` (`recordProposedFix` `4991`, `renderLegibleOutcome` prints the offer at `workflow-diagnosis.ts:673`).

## 3. Do successful runs generate improvements?
Largely NO — success improves recall, not the workflow definition. On a clean run only `recordSuccessfulWorkflowPattern` (`5045`) + `distillSkillFromSessions` (`5034`) fire; neither tightens prompts/bindings/contracts. The only machinery that edits a workflow definition from history is the proposer, and its two workflow-facing detectors are FAILURE/COST driven: `proposalsFromStepFailures` needs a problem recurring in ≥2 runs (`improvement-proposer.ts:297`), `proposalsFromStepMetrics` fires on cost/latency outliers (`470`). A workflow that succeeds loosely is never tightened.

## 4. Proposal application gating + uncommitted diff
Three channels with different auto-apply semantics:
- Doctor ProposedFix (`workflow-diagnosis.ts:444`) → auto-applied by loop A under the `4144` guards or by human `apply fix`. `applyProposedFix` (`561`) snapshots a backup (`586`) and re-validates via `checkWorkflowForWrite` (`581`) before writing.
- Contract upgrades (`proposeWorkflowContractUpgrades`, `workflow-contract-proposals.ts:430`) — auto-applied but ONLY at write/repair time inside `checkWorkflowForWrite`'s repair pass (`workflow-enforce.ts:513-539`); also the manual `workflow_contract_proposals` tool with `apply=true` (`orchestration-tools.ts:698`). Never triggered by a run outcome.
- Nightly proposer — NEVER auto-applies. Two walls: `proposerEnabled()` to draft (default on, read-only, `94`) and `approveEnabled()` + explicit human `approveProposal` to apply (`617-665`).

Uncommitted `workflow-contract-proposals.ts` diff (+148 lines) adds authoring-hardening for live-research steps: `stepHasWeakLiveResearchContract` (flags a non-deterministic research/SEO/scrape step reaching an external tool whose output contract requires only identity keys id/name/url and no evidence keys), `hardenWeakLiveResearchOutputContract` (rewrites it to require `sources`/`key_findings`/`source_errors` with min_items 1-3), and `workflowAuthoringAdvisories` (non-blocking warnings for weak-research contracts and for model-written steps that verify a local artifact path). Wired in `workflow-enforce.ts`: hardening auto-applied in the repair pass (`524-528`), advisories folded into warnings (`570`). This is WRITE/REPAIR-time only, not learned from run outcomes.

## 5. Cross-workflow learning
Yes, three channels: (1) Pattern store — a clean run writes a pattern keyed by objective; a future run of ANY workflow recalls top matches by name/description token overlap (`recallWorkflowPatterns`, `workflow-pattern-store.ts:233`, threshold 0.25) and injects `renderWorkflowPatternHint` into every model step prompt (`workflow-runner.ts:3596`, `applyWorkflowPatternHint` `966`). (2) Proposer `tool_desc`/`skill_pitfall` tighten shared tools/skills for all workflows once approved. (3) Skill distillation on clean runs. Weakness: recall matches on name/description tokens only (not tool set or step shape), so it can inject a hint from a since-degraded workflow.

## 6. Regression protection / version history / rollback
Strong on reversibility, weak on did-it-get-better: Doctor `recordFixBackup` before every apply (`workflow-diagnosis.ts:501`) + `revertWorkflowFix`/`revert heal <id>` (`530`); proposer step edits have their own backup namespace + `revertStepEdit` (`workflow-step-edit.ts`); every self-edit re-validated by `checkWorkflowForWrite`; bounded attempts + chronic-failure ledger auto-pauses (`workflow-failure-ledger.ts:95`); keep-if-better `evaluateAppliedProposals` (`improvement-proposer.ts:361`) measures REAL post-apply runs and drafts a step_revert on regression — but MANUAL, never auto-reverts (`399`). Gaps: pattern store has no version history, no score, no decay — `successCount` only grows and the latest run overwrites steps/tools/evidence (`203`), so a degraded-but-completed run silently overwrites a good pattern; keep-if-better only watches for the SAME normalized problem recurring (`388`), so it can't detect a heal that unblocked but worsened the deliverable.

## Strengths
Honest reporting (needs-attention vs completed; fail-open judges never turn a good 5am run into a false failure); pervasive disciplined reversibility (backups + explicit revert on both edit paths); real side-effect law prevents auto-heal/re-pursuit doubling irreversible sends (`4082-4113`, `runUnsafeToRepursue` `4228`); chronic-failure breaker stops the expensive re-run multiplier; proposer keep-if-better measured from real runs at zero tokens; strong content-hash dedup/idempotency (`98`).

## Top 5 concrete gaps
1. Successful runs never tighten their own workflow. Clean-run pipeline only writes a recall pattern + distills a skill (`workflow-runner.ts:5031-5053`); no detector proposes tighter prompts/bindings/contracts from success — the proposer's workflow detectors are failure/cost-only (`improvement-proposer.ts:297`,`470`). "Every run makes the workflow better" is false for the common loose-success case.
2. Fast loop (Doctor) and slow loop (proposer) don't share signals. Doctor persists a rich root-cause + rewrite every failed run (`workflow-diagnosis.ts:444`), but the proposer never reads `workflow-fixes/`; it re-derives from step_failed/attempt_record events only at the 3am tick (`observatory.ts:626`, `maintenance.ts:308/438`). Repeated same-day failures get no proposer proposal, and the Doctor's diagnosis is discarded for learning.
3. Auto-heal self-grades with the same fast model and never scores the result. `autoApplicable` is decided by the same low-effort model that wrote the fix (`workflow-diagnosis.ts:399-404`,`331`); `tryAutoHealAndRequeue` re-runs without comparing new vs old quality — only backstop is `checkWorkflowForWrite` (shape, not quality). Contradicts the "judge a different family" directive for an auto-mutating action; a heal that unblocks but degrades resets the failure streak (`workflow-failure-ledger.ts:72`) and reads as success.
4. Auto-heal is prompt-rewrite-only and single-step. `diagnoseWorkflowBlock` diagnoses only the first blocked step (`391`); auto-apply requires a full newStepPrompt (`4144`). It cannot learn a corrected tool binding, add/repair an output contract, fix inputs, or handle multi-step interactions — all fall to manual.
5. Pattern store has no quality gate, decay, or removal. Monotonic `successCount` + latest-run overwrite (`workflow-pattern-store.ts:203-218`); recall is pure name/description overlap (`233`). The hint injected into future runs (`workflow-runner.ts:3596`) can come from a since-regressed workflow with no corrective signal, propagating stale patterns cross-workflow.

Key files for follow-up: `workflow-runner.ts:4123-4190` (auto-heal), `:4767-5260` (post-run pipeline); `workflow-diagnosis.ts` (Doctor + backups); `autoresearch/improvement-proposer.ts` (nightly proposer + keep-if-better); `memory/workflow-pattern-store.ts` (cross-workflow recall); `workflow-contract-proposals.ts` + `workflow-enforce.ts:502-571` (write-time hardening incl. uncommitted live-research work).
