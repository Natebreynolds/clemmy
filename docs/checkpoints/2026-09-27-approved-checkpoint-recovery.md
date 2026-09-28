# Approved-action checkpoint recovery — repair and release qualification

## Reproduced defect

A new focused production-path fixture in `src/runtime/harness/host-direct-write.integration.test.ts` first obtains a real host approval card, resolves it, and resumes through `runConversationFromResume` with the production orchestrator and tool kernel. The provider boundary is a recording port, not a live external service. A temporary SQLite trigger refuses only the result-projection receipt after the approved physical action has returned.

The action crosses the provider once. The resumed turn reports held/recovery_pending, but no recovery state is saved. The original business source already has its typed approval-pause terminal; `HarnessSession.saveRecoveryState` therefore rejects the resume's checkpoint with `source_terminalized`. The approval answer is a distinct accepted source. The fixture fails before its timer/no-replay assertions because the durable checkpoint is absent.

The identical added case also fails on the actual last-tag production tree, `v3.18.21^{commit}` (`07fb6f850`), with the same three source_terminalized save rejections. Only the new test was appended temporarily to the clean attribution worktree and its original bytes were restored afterward. This defect is inherited, but it blocks the new release's long-horizon recovery claim. It is not waived as pre-existing.

The failure is reproduced on candidate runtime `c4f8fed5d`. No live data, credentials, model settings or installed runtime were changed. No paid model calls were made. Receipts are retained locally under `output/release-3.18.22-2026-09-27/` as approved-checkpoint-candidate.log and approved-checkpoint-last-tag.log.

## Required repair

Keep business execution identity distinct from the approval answer that owns resumed delivery and the active recovery attempt. Persist and validate their exact continuation relationship through the existing approval/accepted-source owners. A paused original source must not prevent recovery of its legitimately accepted continuation, while a completed, cancelled, superseded or unrelated source must still be unable to resurrect work.

Do not simply remove terminal checks, rewrite accepted source IDs, clear a published terminal, replay the consumed approval, or retry the effect. The checkpoint must retain exact accepted batch/history/account/tool authority, and timer and restart recovery must adopt its settled result exactly once. Source-specific completion and model usage must remain attributable to the accepted continuation without changing the business authority.

Static inspection also finds the approval wrapper scheduling recovery with the approval-answer source while the recovery blob names the business source. That mismatch must be covered after the save defect is fixed; it is not yet independently exercised because the current pin stops before a blob exists. Review stale-blob retirement and continuation-owner fencing under the same two-source relationship.

The new pin expects one original approval card, one physical action, one eventual terminal for the approval answer, one post-result model continuation, and replay with no new model or physical action. A separate real-process restart case and an installed/live-home controlled acceptance are still owed. Existing plain resume, generic storage recovery and source-text wiring tests do not prove this composite boundary.

## Other qualification this wave

Public repository hygiene passes after removing a personal path from the earlier checkpoint. Release asset tests pass 58/58, and release closure passes 141/141, including the isolated v3.14 store-upgrade rehearsal. A newly maintained schema-document guard fails on the stale upgrade document and passes with the schema-82 target. Historical release notes remain unchanged. These are focused preflight results, not the exact final release gate or packaged-app acceptance.

The complete suite and canonical journeys still await an idle machine or the owner's explicit exception to the earlier scheduling rule. Full signed packaging, last-tag live performance comparison, installed long-conversation/fan-out/workflow acceptance and the tag remain outstanding. The goal remains active.

## Implemented repair and focused qualification

The bounded repair now keeps the original business request in the checkpoint and binds recovery delivery to the accepted approval answer. A persisted continuation link is validated against the exact session, accepted request, approval-answer event, decision and resolved card. Existing terminal and attempt ownership guards remain. The host reopens the existing batch and settled result; no consumed approval or physical effect is replayed. Boot recovery dispatches the delivery source while sharing the business frame's existing reentry budget with timer recovery.

A shared active-conversation owner also covers approval resumes. A new concurrent-entry pin first exposed a second activation returning completion before the actual answer finished. The fixed wrapper makes both callers await one activation, including the interval after checkpoint adoption. A separate cancellation pin exposed approval-answer Stop being ignored: recovery now observes either the original request's exact stop or its scoped delivery owner's exact stop, without using the latest unrelated input.

Evidence on the repair:

- 91/91 focused recovery tests pass with no skipped/cancelled cases. Includes real approved-effect storage failure, timer recovery, concurrent-entry joining, exact no-replay, foreign/malformed owner rejection, continuation fencing and stopped recovery.
- Real process-exit coverage prepares the approved action in one child process, terminates it with a durable held checkpoint, resumes through production boot recovery in a second child, and reopens completed delivery in a third. Across all three processes there is one physical effect, one post-result model call, one terminal for the approval answer, and no model/tool work on the final reopen. Providers are recording ports, not external services.
- Concurrent-entry and approval-control Stop pins failed before their respective fixes. Both cancellation targets now pass; existing parked-versus-unrelated cancellation cases remain green.
- 389/389 surrounding loop, restart-recovery, event-log, source-approval-checkpoint and approval-resume-source checks pass. This pack ran before the final narrow cancellation addition; the final 91-test pack and targeted four cancellation cases cover that addition.
- Root TypeScript checking passes after the final change. No paid model calls, settings changes, installed-app restart or hotpatch occurred.

Local receipts under output/release-3.18.22-2026-09-27: approved-recovery-pack.log, approved-surrounding.log, approved-concurrent-red.log, approved-stop-red.log, approved-stop-green.log and approved-typecheck.log. The isolated runner cannot certify unchanged live-home bytes while the installed daemon is active; these fixtures use disposable homes and are not installed-app acceptance.

The original failure descriptions above are retained as the red baseline. The runtime repair is source-qualified by these focused checks, not yet built, installed, live-accepted or release-qualified. The 100-worker journey assertion repair remains a separate unexecuted change. Complete-suite/journey scheduling still awaits an idle machine or the owner's answer to the pending scheduling question; the unrelated management notifier remains busy. Full release packaging/signing, matched live performance, and controlled installed long-chat/fan-out/workflow/approval recovery acceptance remain owed. Do not tag from these focused results alone.
