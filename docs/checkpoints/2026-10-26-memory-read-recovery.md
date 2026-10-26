# Memory correction read recovery — 2026-10-26

The controlled installed q2 run on source `5079bf5f4` supplied a read receipt
from its earlier seed request to `memory_remember.correct`. The exact-source
guard correctly rejected it before review or mutation. The public tool then
reported an uncertain correction outcome, and the run asked `placeholder`
instead of obtaining a fresh read. Neither record changed. That run did not
exercise the mixed-target completion hold.

## Change

- Before redeeming a correction's retained read, check that the named logical
  read belongs to this session, accepted source and task, and is `memory_read`.
  An absent/wrong-tool read uses the existing nominal no-write refusal and
  argument-repair classification. An existing read still requires the unchanged
  canonical successful-settlement, crossing, payload and observation checks.
- Keep already-published native tools declared read-only and idempotent available
  during a settled repair. This also permits fresh native evidence after a
  provider argument refusal. It neither certifies the previous operation had no
  effect nor grants a different write. Unknown/frozen effects and explicit
  reconcile, ask and stop consequences retain their existing restrictions.
- State the current-request read requirement in the correction input contract.

No new retry budget, governor state, review pipeline, schema, or tool pair is
introduced. The original exact-source boundary, correction scope, unchanged
clauses, semantic grant, cancellation checks and atomic mutation remain.
Automatic intake may have made a separate change; this refusal describes only
the current tool invocation. Missing/corrupt current-read evidence and possible
postcommit exceptions remain uncertain.

## Evidence and remaining qualification

Evidence is retained under
`output/end-to-end-review-2026-10-26/memory-stale-read-recovery/` in the primary
checkout. The actual registered memory handler reproduced the original defect
before the change. The canonical local settlement and recovery-surface test
separately reproduced exclusion of the fresh read. Initial fixture wiring
failure is retained separately and is not counted as a defect reproduction.

The focused memory suite passed 28 cases; recovery projection passed 71 and
governor integration passed 13. A composed production-host test also passed
using the real registered local memory adapters: stale-read refusal, fresh
canonical read, one exact correction, and no owner question or approval.
Its primary responses and source-bound semantic grant are deterministic test
fixtures, so this is host-path coverage rather than live model acceptance.

The semantic question boundary is a separate open issue: a correctly formed
question can publish before completion review assesses its usefulness. A prior
trajectory verdict cannot certify a later candidate. Do not treat recovery of
the stale read as proof that arbitrary bad questions are prevented.

Build, installed identity, live observations and precise acceptance limits are
recorded separately after freezing the source. Native delivery, Windows
acceptance, exact primary-provider attribution and cost savings are not implied
by source tests or a Mac daemon hotpatch. No tag or publication is authorized.
