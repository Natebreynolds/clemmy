# Proactive offer lifecycle: defer, revise, withdraw

Follow-up to `2026-09-22-proactive-offer-session-routing.md`. The original routing checkpoint describes the earlier immutable-content slice; this checkpoint records the added lifecycle behavior.

## Implemented

- `snoozeProactiveOffer(id, expectedRevision, userId, until)`: persist the user's requested revisit time. Hidden from the ordinary offer list until due; early Discuss is refused. An existing conversation is retained. Dates must be valid and future; postponement beyond the offer's expiry is refused.
- `reviseProactiveOffer(input, expectedRevision)`: explicit trusted-producer amendment under an immediate transaction. Content revisions are stored in an append-only history table. Older cards can no longer discuss or dismiss the changed offer. The original conversation, dismissal, and snooze state survive the amendment. Amendments cannot silently change the artifact kind or originating conversation.
- `withdrawProactiveOffer(id, expectedRevision, userId, reason)`: persist why the supporting context is no longer applicable. Withdrawn offers are hidden and cannot be discussed, revised, or resurrected through identical publication.
- Optional producer-supplied `expiresAt`: expired offers are excluded from the ordinary list and cannot be discussed. No invented default expiry or new timer was introduced.
- The existing schema upgrades transactionally, preserving conversation bindings and recording the initial content revision. Concurrent initialization remains in the same SQLite transaction domain as sessions.

Snooze expiry is evaluated when listing/engaging, without a new heartbeat or model call. A due snoozed row still carries its persisted snoozed state and timestamp until engagement changes it to `discussing`; clients should use the server's available-offer list rather than independently deciding when to resurface it.

## Tests and evidence

The three new lifecycle contract tests initially failed (5 passed, 3 failed). After implementation, **88 tests passed, 0 failed** across proactive offers and the harness event log. Includes restart, preserved dismissals, stale card rejection, expiry/withdrawal, invalid snoozes, scope-change refusal, original-schema upgrade, and two-process engagement. Typecheck passed; no model calls were made.

Logs: `/tmp/offer-lifecycle-before.log`, `/tmp/offer-lifecycle-integrated.log`, `/tmp/offer-lifecycle-types.log`.

## UI integration contract

Continue to derive audience identity from authenticated server context. Dates for “not now” must come from an actual user choice or established user preference; do not silently choose an arbitrary recurrence. A content revision conflict should refresh the offer and explain that its context changed, not automatically apply the old decision to the new revision.

Discuss still grants no task-execution authority. Opening or postponing an offer creates no accepted user turn. Only the ordinary chat ingress can accept the user's actual instruction, with the exact stored context attached and evidence treated as data.

## Still owed

These functions are framework building blocks. Autonomous offer producers, semantic deduplication across different producer IDs, current-evidence validation before an accepted action, authenticated route registration, context injection, and desktop/mobile screens remain unwired. Do not advertise this as an operational proactive-offer feature yet.

UI and shared-route work remains with the other agent. No hotpatch, live-home mutation, or external action was performed. Full suite/journeys were skipped while the design agent was active. The isolated runner could not perform its live-home sentinel while the daemon owned that home.

After combining changes, live acceptance must show a single thread on desktop/mobile, “not now” surviving restart, revised evidence invalidating an old card, dismissal staying dismissed, and the user's actual response reaching an ordinary task with the right context. No latency savings are claimed from unit tests.
