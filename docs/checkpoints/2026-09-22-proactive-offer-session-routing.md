# Proactive offers: one conversation across surfaces

## Implemented framework foundation

`src/runtime/proactive-offers.ts` provides a durable offer-to-chat binding in the harness database, in the same SQLite transaction domain as sessions.

- Publishing an offer stores its kind, summary, why-now context, evidence references, optional context question, owner, and optional originating chat. Publication creates no session and runs no model/tool.
- First engagement reuses the specified owned originating chat or creates one deterministic chat for the offer. Simultaneous desktop/mobile engagement returns the same session. Session creation and offer binding commit atomically.
- Repeat engagement and restart reuse the binding. A missing previously bound conversation is reported explicitly, not silently recreated under a different identity.
- Dismissal persists. Republishing identical content cannot revive a dismissal or reset a discussion. Conflicting content requires explicit producer reconciliation; no overwrite or inferred new authority.
- The resolver returns offer context alongside the session ID, without inserting a synthetic user turn or granting execution authority. Original chat metadata is preserved.
- Wrong audiences, wrong revisions, missing origins, and foreign/non-chat origins fail before chat creation.

Entry points: `publishProactiveOffer`, `getProactiveOffer`, `listProactiveOffers`, `discussProactiveOffer`, `dismissProactiveOffer`.

This is **not yet wired into HTTP routes, UI cards, normal chat context loading, or autonomous offer producers**. No end-to-end feature or live acceptance is claimed.

## Route/UI integration handoff

Use authenticated console/mobile routes and their established shared owner identity. Never accept `userId`, evidence, origin session, or the offer body from an untrusted Discuss request. Resolve the stored offer server-side from ID and expected revision.

Suggested route contract (paths are proposed, not registered):

- `GET /api/console/proactive-offers`: bounded available offers for the authenticated owner.
- `POST /api/console/proactive-offers/:id/discuss`, body `{ expectedRevision }`: resolve the conversation; return `{ sessionId, offer }`.
- `POST /api/console/proactive-offers/:id/dismiss`, body `{ expectedRevision }`: persist dismissal and return the updated record.

Mobile must use the same backend record and owner mapping, not a separate local session or offer store. Confirm how current desktop/mobile authentication maps to the existing session `userId` before shipping. A client-supplied session ID cannot override the stored origin/binding.

Home's optional offer opens Chat at the returned session. Relevant goal/Space entry points use the same resolver. Memory receipts open Memory details; create an offer only when there is a substantive question or opportunity. Keep optional offers out of the urgent Needs you counter. Running work stays in kanban.

Chat must render the stored offer as contextual introduction (summary, why now, evidence detail, optional question). On the user's first actual reply, the normal authenticated chat ingress should resolve the exact offer reference and carry its context through the existing context mechanism. Treat evidence content as data, not system instructions. Preserve ordinary accepted-turn identity, cancellation, approval, and tool authority. **Do not automatically submit the offer as a user command when Discuss is clicked.** Do not fabricate assistant transcript events or bypass the normal ingress to start a run.

Offer discussion and artifact creation are distinct. “Discuss” authorizes discussion, not creating a goal, Space, or skill. The user's subsequent instruction uses the ordinary authoring tools and completion receipts. Link the resulting object back to the conversation after creation is verified.

## Validation and limits

Five isolated tests passed, including restart persistence and a simultaneous two-process engagement race. Typecheck passed. No model calls or live-home mutations were performed. Logs: `/tmp/proactive-routing-tests.log`, `/tmp/proactive-routing-types.log`.

The runtime offer records are immutable in content for this first slice; revision 1 is checked on every engagement/dismissal. A reviewed amendment/supersession flow, snoozing, expiry, semantic deduplication across different producer IDs, goal/Space origin resolution, evidence revalidation before execution, and offer generation remain follow-up work. The UI must not claim these are implemented.

Required combined-app acceptance: publish one controlled fixture; engage on desktop and phone simultaneously; confirm one thread and the same introduction; reply on one surface and continue on the other; dismiss another offer and restart; verify it remains dismissed; verify Discuss produces no run or external effect. Then drive one real accepted offer to a verified native object through ordinary chat.

The other agent owns the UI and shared console/mobile routes. A coordination question is pending before editing those files. Rebuild after commits; no hotpatch over their newer backend without a combined candidate.
