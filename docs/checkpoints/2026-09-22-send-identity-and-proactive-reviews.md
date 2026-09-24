# Send identity and proactive review follow-through

## Verified

Two framework fixes on `harness/3.19`, separate from the UI agent's active main branch:

1. A second accepted request in one chat could reuse the SDK call ID and lose its send mirror. Hook regression failed with one notification instead of two (34 passed, 1 failed). Mirror keys now include the durable accepted source sequence when supplied by the harness. The source is retained as notification metadata. Replay of that source remains stable across a fresh process; another source gets a separate mirror. Invalid supplied sequences are rejected. Dispatch and approval policy are unchanged.
2. Approving, rejecting, or superseding an identity/SOUL proposal left its notification unread. Three regression assertions failed before the fix (6 passed, 3 failed). Resolution now retires that specific notification after persisting proposal state. Repeated resolution attempts also retry notification retirement without reapplying the proposal. Notification-store failure cannot turn an applied identity change into a reported application failure.

Combined validation: **55 passed, 0 failed**, covering hooks, mirrors, identity evolution, and the two-process approval race. Typecheck and diff whitespace check passed. No model/provider calls were made; the identity distiller was a fixture.

Logs: `/tmp/clem-source-mirror-before.log`, `/tmp/clem-identity-before.log`, `/tmp/clem-send-proactivity-after.log`, `/tmp/clem-send-proactivity-types.log`.

## Proactive UI: actual source locations and next integration

Read-only inspection of main at `bf09b1d25` found:

| Existing surface | Authority/data | Integration direction |
| --- | --- | --- |
| Advanced → Autonomy (`screens/advanced/AutonomyForm.tsx`) | `/api/console/watches`: calendar and workflow-suggestion status, findings, cadence | Make the last useful finding and watch purpose discoverable from the relevant goal/Space. Keep detailed watch configuration here. Quiet checks are not alerts. |
| Goals (`screens/Goals.tsx`) | Prospective commitments backed by source stores | Show why future work exists and connect outcomes to its goal; do not turn the index into a second scheduler. |
| Memory (`screens/Memory.tsx`) | `/api/console/context/identity-proposals`, approve/reject routes | Keep the full diff/evidence review here; expose a pending proposal through the shared actionable-decision projection, with a direct review destination. |
| Kanban (`screens/BackgroundTasks.tsx`) | Canonical active-work projection | Detailed running work belongs here, as the owner clarified. No duplicate Working now pane on Home. |

The new shared `src/dashboard/needs-you.ts` covers multiple decision types but has no explicit identity-proposal integration in the inspected revision. The UI agent owns that in-progress projection/route integration. Do not manufacture a second local unread counter or infer pending state from notification text. Read pending proposals from their durable store; display resolved proposals as history, not decisions.

Next joint slice: one real watch finding, one personality proposal, and one goal-linked workflow. Home shows useful outcomes and decisions; kanban shows execution; Memory shows learning detail; Goals shows progress and the next purposeful commitment. Reuse existing state; rendering adds zero model calls.

## Skipped and owed

- No UI files, personal Spaces, provider configuration, or live-home data were changed. No hotpatch or external send was performed.
- Installed-app acceptance remains owed after the combined candidate is agreed: phone approval after restart plus repeated tap, one physical send, one mirror; then verify proactive decisions retire consistently on desktop and mobile.
- Full suite/journeys were not run while the other agent was active. These targeted checks do not establish a regression-free release or latency improvement.
- The isolated runner could not perform its live-home sentinel because a daemon owns the home. This is not a live acceptance result.

## Memory traps and identity boundaries

- Never key a notification by a provider call ID alone. Accepted request identity survives retries; physical attempt IDs and wall-clock times do not identify a logical send.
- Older callers without accepted-source attribution retain their existing session/call key. A source-less legacy row cannot prove ownership of a source-scoped send; do not silently suppress the new send on that assumption. Historical ambiguous rows are not automatically migrated.
- Reuse of the same call ID within the same accepted source is not separately disambiguated by this fix. That requires proving the logical dispatch identity, not adding a timestamp or physical lease. This notification fix is not a proof of exactly-once external execution.
- Resolved proposal state and unread notification state live in separate stores. Retirement is best effort and retried on repeated resolution; a process crash between stores still needs projection-level reconciliation from the authoritative proposal store.
- Docs and HEAD affect the build fingerprint. Rebuild after the final commit; do not patch an older harness branch over newer UI backend routes.
