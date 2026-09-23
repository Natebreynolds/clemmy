# First proactive producer and accepted-reply context

## Implemented

### Receipt-backed skill offer

After `skill-distiller.ts` successfully persists a new draft, `publishLearnedSkillOffer` reads the stored skill and verified learning receipt. For an owned originating chat it publishes one durable skill offer and adds `proactiveOfferId` to the existing draft notification metadata. It asks whether the learned approach should be general or specific to that work.

This is an offer to discuss/refine an **already saved draft**, not a claim that clicking Discuss creates a skill. The producer performs no new synthesis or model call. Unverified/quarantined/non-draft skills, missing skills, non-chat origins, and origins without a known audience do not generate an inferred offer. Repeated publication preserves dismissal. Publication errors cannot fail the already-saved skill.

The shared offer store is now reached by a production memory-learning path. Goal and Space opportunity generation are still outstanding; this slice does not implement them.

### Exact accepted-reply context

Engagement records the current user-event sequence boundary and reviewed content revision in the same transaction as the session binding. Repeated taps on the same revision do not reset it. A newly reviewed revision arms context against the then-current boundary.

`proactiveOfferContextForTurn(sessionId, sourceUserSeq)` resolves only the first non-synthetic accepted user event after that boundary, for the owning chat. Withdrawn/dismissed/expired offers and unreviewed revisions contribute nothing. Multiple eligible offers in one reused chat return no automatic context rather than choosing arbitrarily; explicit offer-reference selection in the chat ingress remains needed for that case.

The context is structured advisory data: offer ID/revision, summary, why-now, evidence references, and the optional question. It creates no synthetic user message and grants no task authority. Underlying evidence still needs ordinary live verification before an action.

The shared harness memory renderer now includes this section only in volatile/all context with an exact source sequence. The orchestrator and Claude adapter forward that sequence. Stable prompt prefixes remain unchanged, and later user turns do not repeatedly receive the offer payload. No Claude/provider model calls were made during validation.

## Verified

**59 tests passed, 0 failed** across proactive offers, harness context, skill-offer production, and skill distillation. Typecheck and diff whitespace check passed.

Coverage includes first-reply-only context; no context for another chat, later turns, synthetic continuation, or withdrawn/unreviewed content; unchanged stable context; one owned skill offer with persisted evidence; no offer for unverified/missing drafts; preserved dismissal; and the earlier simultaneous two-process engagement and schema-upgrade cases.

Logs: `/tmp/offer-producer-context-tests.log`, `/tmp/offer-producer-context-types.log`. Tests use disposable homes and stored fixtures, with no generative model calls.

## UI integration and remaining acceptance

- The UI agent still needs to register authenticated offer routes, render the offer and its evidence, and make Discuss navigate to the resolver's returned session. The existing draft notification now provides its exact offer ID.
- In a reused conversation with multiple outstanding offers, send an explicit reviewed offer reference through normal chat ingress; do not infer which one “yes” meant. Automatic context intentionally does not guess.
- The current mechanism recognizes synthetic continuation rows marked `synthetic: true`. It does not establish human provenance for arbitrary unmarked background sources. The live ingress must preserve source provenance; explicit offer-reference binding remains the stronger path for ambiguous shared sessions.
- First-reply context is not automatic task acceptance. Actual user instructions continue through the ordinary authorization/authoring path.
- Skill approval/retirement and corrected source evidence still need producer reconciliation/withdrawal. Stored evidence references are provenance, not a substitute for fresh validation.
- No installed-app hotpatch or UI/live acceptance was performed. Full suites/journeys were skipped while the other agent worked. The live-home isolation sentinel was unavailable while the daemon owned that home.
- Required live case: verified draft → offer → Discuss on desktop/mobile → one conversation → user refinement with original context → normal skill update and a verified receipt. Also test a pivot to unrelated work, dismissal, and revised evidence. No speed or token-savings claim until matched live measurement.
