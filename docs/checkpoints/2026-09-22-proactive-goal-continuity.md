# Proactive goal continuity and overlapping heartbeats

## Verified changes

Work is on `harness/3.19`, isolated from the UI agent. No UI files or live-home configuration changed.

### Stop stale resumes at the execution boundary

Previously the heartbeat listed active goals, scheduled a resume, ignored a failed scheduling result, and launched from the earlier snapshot after asynchronous imports. A pause or completion between eligibility and launch could therefore leave a stale resume in flight.

- Scheduling now refuses parked goals and goals with self-driving disabled, as well as non-active goals.
- The evaluator honors a refused schedule and passes the persisted scheduled record forward.
- Immediately after asynchronous setup, the launch wrapper reloads the goal. It verifies active/self-driving status, parking, session identity, deadline, and the scheduled resume count/time before invoking execution.
- The directive is constructed from the newly read goal and current stored observations. The ordinary orchestrator remains responsible for memory/preferences; no alternative prompt/memory pipeline was introduced.

Two existing-path regression tests failed before the fix: a paused goal still fired, and a completed goal still fired. Baseline: 15 passed, 2 failed.

### Do not mistake quiet execution for an idle session

Event age is insufficient when a model/tool call runs without new events. Production now checks the current run-attempt lease before scheduling and again before launch. A session reservation also covers asynchronous setup and the entire background resume, released in `finally` on completion or failure.

An overlapping tick skips without spending another resume slot. Busy work is checked before budget/progress parking, allowing an already-running final budget slot to settle. Tests cover overlap, release after setup failure, pause/complete/disable during setup, a session becoming busy during setup, and fresh progress reaching execution.

The session reservation is process-local. Existing durable run leases remain the cross-process authority; this change is not a new distributed lock or proof of cross-process exactly-once execution. Goal-file scheduling itself is not a transactional cross-process claim.

### Feed current watch findings back into goals

The observation selector recognized `inbox-monitor` and `calendar-monitor` but not the current `calendar-watch` producer. A regression test using a matching current watch finding failed (24 passed, 1 failed). The selector now recognizes that source while preserving relevance, age, deduplication, and output bounds. The unrelated calendar finding in the same test stays excluded.

The production observation read now happens once at launch, after setup and revalidation. Re-orientation telemetry is emitted there too. No extra model call or full-history scan is added.

## Validation

**95 passed, 0 failed** across:

- `src/execution/goal-resume.test.ts`
- `src/agents/goal-contract.test.ts`
- `src/agents/plan-proposals.test.ts`
- `src/runtime/prospective-adapters.test.ts`
- `src/runtime/prospective-intentions.test.ts`

Typecheck and diff whitespace check passed. All tests used disposable homes and injected execution; no Grok, GLM, Claude, Codex, or Jev calls were made. Logs: `/tmp/goal-continuity-before.log`, `/tmp/goal-watch-before.log`, `/tmp/goal-continuity-integrated.log`, `/tmp/goal-continuity-types.log`.

## Skipped and still owed

- No installed-app hotpatch, real background resume, phone action, or external write was performed. No measured live latency/token savings are claimed.
- Full suite/journeys were not run while the UI agent was active. The isolated runner's live-home sentinel was unavailable while the live daemon owned that home; that is not live acceptance.
- Test on the agreed combined build: start a controlled goal, hold a long-running step across a heartbeat, confirm no second resume, pause before a queued resume starts, and verify the goal stays stopped. Repeat with completion/self-driving disabled. Then introduce a relevant watch finding and inspect the next resume's observation receipt.
- Retained user-preference correction affecting a later live task is still a separate owed acceptance case. These tests prove fresh goal progress, not the entire learning system.
- The evaluator's `fired` result means the resume callback was invoked/queued; it is not proof of physical execution or successful completion. UI must continue to use durable run state.
- Continue the UI mapping in `2026-09-22-send-identity-and-proactive-reviews.md`: running work in kanban; useful outcomes on Home; decisions in Needs you; learning detail in Memory; future commitments in Goals.

## Continuity traps

Never infer idle from silence alone. Never use a goal snapshot captured before an `await` as current execution authority. Never consume another resume slot just because the prior run is slow. A watch producer rename can silently sever the feedback path; contract-test current producers as well as historical notifications. Rebuild after the final commit because HEAD and checkpoint docs affect the fingerprint.
