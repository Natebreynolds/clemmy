# Paginated workflow read authority — v52 boundary

Date: 2026-08-22

## Why this exists

The v51 `workflow_v1_read_only` authority intentionally owns exactly one
logical and physical read. That is sufficient for a representative one-call
pilot, but it cannot prove an exhaustive collection. Treating pages as node
retries, node attempts, or run occurrences would fabricate workflow identity;
looping inside the v51 body would exceed its frozen call ceiling and leave no
durable cursor or aggregate truth.

v52 adds one paginated-read authority. It reuses the same logical-call,
physical-dispatch, settlement, immutable-port, result-handle, cancellation,
and approval kernels. It does not add another executor or a fake TurnGraph.

## Non-negotiable identity

One activation remains bound to the exact:

- workflow id, revision, and digest;
- run id and occurrence id;
- node id and positive node attempt;
- invocation-plan, binding-snapshot, and control digests;
- one-shot pilot authorization, when present;
- cursor contract and maximum page budget.

Each page is a child call, not another workflow activation. Its content address
binds:

- activation digest;
- zero-based page ordinal;
- prior page-receipt digest (`null` only for page zero);
- input cursor digest (`null` only for page zero);
- canonical provider-argument digest;
- exact operation/account/schema/live-binding identity.

The model never supplies page identity or cursor arguments. The host reads the
next cursor only from the preceding settled provider result and overlays it on
the one optional `continuation_cursor` argument declared by the approved plan.

## Durable state

Schema v52 adds normalized tables; it does not put page state in session JSON.

### `workflow_paginated_read_activations`

One immutable parent row containing the v51 workflow identity plus:

- `max_pages`;
- `cursor_argument`;
- `next_cursor_path`;
- `exhausted_path`;
- `aggregate_state` (`open`, `complete`, `partial`, `failed`, `cancelled`,
  `conflict`);
- exact next ordinal and latest page-receipt digest;
- terminal aggregate-receipt id/digest when closed.

### `workflow_paginated_read_pages`

One immutable-or-monotonic row per `(activation_id, page_ordinal)` containing:

- prior receipt and input cursor digests;
- canonical argument digest;
- deterministic logical-call and physical-dispatch ids;
- result-handle id and settled result digest;
- next cursor digest (never raw cursor bytes in authority/log rows);
- provider-declared exhausted truth;
- bounded item count and evidence digest;
- state and settlement timestamps.

### `workflow_paginated_cursor_visits`

One unique row per `(activation_id, cursor_digest)`. A repeated cursor is a
durable partial/conflict outcome, never another dispatch.

### `workflow_paginated_aggregate_receipts`

One terminal receipt binding the ordered page-receipt digests, total bounded
counts, final exhausted truth, coverage state, plan/binding/control roots, and
terminal outcome. Large result bodies remain behind page result handles or in
the normalized downstream store.

## State machine

1. Parse and re-observe the exact live read binding.
2. Atomically consume the exact pilot authorization and arm one paginated root.
3. Reserve page zero with no cursor and deterministic page call identity.
4. Use the existing logical/physical kernel and immutable invoke port.
5. Settle the page before interpreting continuation data.
6. Validate the configured exhausted and next-cursor paths against the settled
   retained result.
7. If exhausted is exactly `true`, atomically close the root with a complete
   aggregate receipt.
8. Otherwise require a non-empty canonical next cursor, insert its unique
   digest, and reserve the next ordinal from the exact prior receipt.
9. Stop as `partial` on budget exhaustion, missing cursor, repeated cursor,
   malformed evidence, cancellation, drift, or an unrecoverable page failure.

Page calls are sequential because page N depends on page N-1. Independent
partitions remain eligible for bounded parallel workflow execution outside
this cursor chain.

## Crash and replay

- Crash before a page physical-I/O claim: the exact page may resume.
- Crash after the claim but before settlement: no redispatch; recovery must
  reconcile or report `prior_crossing_unknown_no_redispatch`.
- Crash after page settlement but before next-page reservation: redeem the
  retained result, derive the same cursor digest, and reserve the same child.
- Crash after the final page but before aggregate closure: rebuild the ordered
  aggregate receipt from settled page rows and close once.
- Replaying a closed activation returns the exact aggregate receipt and page
  handles without another provider body.

No old timer, losing process, or later response may overwrite a settled page,
change exhausted truth, or close a newer generation.

## Completeness and claims

`complete` requires all of the following:

- every ordinal from zero through the terminal page exists exactly once;
- every logical and physical call is settled;
- the receipt chain and cursor-visit chain verify;
- the terminal result declares `exhausted === true` at the approved path;
- every page satisfies its evidence contract;
- no page is uncertain, failed, cancelled, malformed, or over budget.

Budget exhaustion, a missing/repeated cursor, unknown denominator, or any
unsettled page is `partial` or `unknown`. Those states cannot support `all`,
`every`, `none`, `top N of the full set`, or equivalent universal/ranking
claims. Publication consumes the aggregate completeness receipt, not model
prose and not the presence of one result page.

## Required APIs

- `armWorkflowPaginatedReadAuthority`
- `readWorkflowPaginatedReadAuthority`
- `reserveWorkflowReadPage`
- `mintWorkflowReadPageAttestation`
- `settleWorkflowReadPage`
- `closeWorkflowPaginatedReadAuthority`
- `redeemWorkflowPaginatedAggregate`
- `executeWorkflowPaginatedRead`

The public executor returns typed `completed`, `replayed`, `partial`,
`blocked`, or `failed` outcomes and the canonical aggregate receipt. It never
falls through to a model or legacy runner.

## Release tests

Use generated carrier/capability/field names and a true empty home.

1. Two pages exhaust, two exact crossings, one complete receipt, one terminal.
2. Ten thousand pages stay bounded by normalized rows and retained handles.
3. Missing cursor before exhaustion is partial and supports no universal claim.
4. Repeated cursor is detected before another body.
5. Maximum-page exhaustion is partial with exact counts.
6. Crash at every reservation/claim/settlement/advance/close cut resumes once.
7. Late losing-page completion cannot alter state or history.
8. Account/schema/effect/operation/port drift between pages blocks before the
   next crossing.
9. Cancellation before claim is zero-body; cancellation after claim settles
   the owned page before stopping.
10. Two independent partitions may run concurrently, while pages within one
    partition remain ordered.
11. A one-page response with `exhausted !== true` can never publish complete.
12. A closed replay returns the same aggregate digest and causes zero bodies.
