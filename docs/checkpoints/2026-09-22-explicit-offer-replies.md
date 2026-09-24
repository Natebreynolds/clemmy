# Explicit proactive-offer replies

## Implemented

`bindProactiveOfferReply` binds an authenticated audience, owned chat and exact accepted user source to one reviewed offer revision. The binding is durable, transactionally serialized and immutable on retry. Several offers may share a chat; an explicit binding selects the intended one. A resolved, expired or changed bound offer supplies no context and never falls back to a different offer.

The existing shared harness context renderer consumes this binding before its compatibility first-reply lookup. Only the selected offer enters volatile context; stable context remains unchanged. No model call, synthetic user input, execution approval or new session is introduced.

## Ingress contract for the UI agent

1. Discuss the exact offer revision through the existing resolver and navigate to the returned session.
2. Send the offer ID and reviewed revision alongside the real user reply. Derive userId from authenticated ingress, never from client-supplied audience data.
3. While accepting that user source, bind it using `bindProactiveOfferReply({ sessionId, sourceUserSeq, userId, offerId, revision })`, before dispatch to any brain. Acceptance and binding must share the ingress transaction; do not dispatch an unbound source after a binding error. Preserve post-commit event publication when integrating this transaction.
4. Carry that exact sourceUserSeq into normal execution and retries. An idempotent repeat preserves the binding even if the offer has since resolved; a different offer/revision for the same source is rejected.

This patch supplies the binding API and its actual context consumer. Authenticated route/acceptance integration remains owed; it does not claim end-to-end UI wiring. The compatibility path still cannot prove human provenance for an unmarked background input. Only authenticated ingress may invoke the explicit binder.

## Verified

42 focused tests passed across proactive offers and harness context, without generative calls. TypeScript check passed. Fixtures cover restart persistence, ambiguous shared chats, immutable retry, withdrawal without fallback, foreign audience, synthetic input, stale revision, pre-engagement input and selected-only volatile rendering.

Logs: /tmp/offer-reply-binding-tests.log and /tmp/offer-reply-binding-types.log. Disposable test homes only; live acceptance is still owed. Full suite and journeys were skipped while other work continued. No latency/token savings claim.

## Continuity and traps

The UI handoff is now committed on main at c4a82eecc. Its latest screens are not installed and its checkpoint records the combined live acceptance owed. Do not hotpatch this older harness branch over those changes. No tag, merge or install performed in this slice.

Goal-to-Space production remains open: `GoalRecord` in memory/goals-list.ts is a lightweight saved-goal store, distinct from the active goal contract. Its owner defaults to `clementine`, which is not an authenticated audience. Do not equate those stores, infer a user from that field, or publish blanket Space suggestions on every upsert. Resolve ownership, existing Space links and goal lifecycle first. General memory-to-goal generation also remains open.
