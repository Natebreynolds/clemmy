# Planning and review refinements — 2026-09-13

The owner requested careful, minimal refinements and one hotpatch for the next live test. This pass changes the measured discovery/review failures, not the general execution architecture. No commit, push, or tag is requested.

## Why

The Terra/Grok Plan run (source 201075) returned no published plan. Both account-review model calls succeeded after approximately 19 seconds, but discovery had raced each against eight seconds and already reported review_unavailable. A later no-progress stop ended the task. The document-creation definition and active connection were present.

The earlier Grok/GLM run (source 200514) produced one trajectory evidence packet of 1,069,776 bytes. Four full-page searches contributed 890,748 bytes; only 21,979 markdown bytes were exact repeats. GLM's context admission correctly rejected the oversized request. No replacement judge ran. Six other trajectory checks returned on_track. Full source analysis and timing are in `output/reviewer-monitor/2026-09-13-research-user-live/REVIEW.md`.

## Changes

- A current discovery invocation now awaits account-model work without spending its short metadata timer. The existing invocation cancellation and model transport still own cancellation/termination. Metadata I/O remains timed. The timer is paused only around the account review and resumes with its remaining budget. Parent and worker discovery share the same path; direct Composio discovery uses it too. No new queue, database, approval, or model conversation was added.
- Indexed operation nomination now discovers definitions without a preliminary account-model review, matching the existing exact-name and remembered-definition paths. Definition metadata grants no execution authority. The existing staging owner still checks the selected account before publishing an executable capability reference. Tests explicitly reject a conflicting account at this boundary.
- Oversized trajectory evidence is partitioned against the selected judge's existing context admission. All source characters are retained, including Unicode and the final portion. The same existing reviewer evaluates each portion with the shared objective and progress context; it is told not to infer absence from a portion boundary. Any negative survives later on-track results. A failed portion returns unavailable, never complete coverage. Coverage includes the original evidence digest, character count, and portion count.
- An unavailable, stale, foreign-source, or unreadable trajectory review no longer advances the evidence cursor. Its evidence remains available to the next check. Completion certification is distinct: these advisory portions do not claim a single reviewer compared every source jointly, and the final completion evidence/authority contract was not relaxed.
- Plan guidance distinguishes preparation from exhaustive execution, encourages reuse of retained evidence and schemas, and permits independent preparation while a future requirement is unresolved. The watcher can identify repeated successful retrieval that is no longer answering a remaining question. Recalled procedures cannot introduce unrelated mandatory deliverables. These are general instructions, not task/provider keyword exceptions.
- A session-history receipt combined with max_turns now returns the precise, nominally repairable argument conflict. Retrying without max_turns uses the same receipt, boundary, and digest. Principal and snapshot validation remain intact.

## Verification

The focused set passed 119 tests with one existing skip. A broader 245-test run passed 243, with one existing skip and one prompt assertion mismatch. The instruction to discover missing operations was restored, then the affected surface suite and hotpatch tests were rerun. See final logs under `output/reviewer-monitor/2026-09-13-planning-review-refinements/` for final counts and build/install evidence.

The actual Agents Runner and provider request path were exercised using local stubbed model transports and an observed small context window: every original evidence character was reconstructed from the actual requests; a decisive final-source negative survived; an unavailable second portion produced no positive verdict or completed coverage; the selected judge did not fall back to the working brain. These are local integration tests, not live LLM qualification.

The production daemon was left running during tests. The isolated runner's full live-home before/after sentinel cannot prove immutability while that daemon writes its own state; no such proof is claimed. Tests used disposable homes. No external business operations were performed by this pass.

## One live qualification after installation

Run the same research request in Plan using Terra as brain and Grok as judge. Verify: full source document read, useful reviewable plan published, account review awaited rather than mislabeled unavailable, no unnecessary schema rediscovery, no proposed business mutations in Plan, correct selected models, meaningful progress display, and recorded evidence coverage for any partitioned review. Then assess the plan against the document's five research categories and its proposed source/verification method.

Live success remains unproven until that run finishes. Latency improvement from reduced redundant collection is model behavior to measure, not guaranteed by a prompt edit. This pass does not remove all harness deadlines, replace the no-progress governor, or claim that a multi-portion advisory review is full terminal certification.
