# Review evidence repair — 2026-09-28

## Trigger and scope

Installed source 46b775545, accepted source 316308, completed the read-only Salesforce benchmark in 215.287 seconds with 20 brain rounds, 952,192 recorded input tokens (126,848 uncached), and 27,492 output tokens. Its completion review timed out and delivery explicitly stood unreviewed. This is not release acceptance. The earlier failed authentication run is not a successful speed baseline.

Framework repairs:

- Reviewer queries traverse nested JSON documents held in carrier strings, including CLI output. Explicit paths preserve the envelope; raw evidence remains unchanged. Ordinary prose is not parsed as structured data.
- Lookup-backed completion uses the existing recallable presentation budget for bulk reads instead of expanding every result to the larger window budget. Targeted retained pages and write receipts retain their prior presentation. Exact handles, request scope, digests, record paths and completeness remain available. A bounded preview cannot certify complete evidence for Jev, and omitted content cannot prove absence. Plan review keeps its existing presentation.
- Judge races send cancellation through the real Runner provider request at timeout or a competing verdict. Late cancellation errors cannot mutate an already settled timeout receipt or start a quota fallback. Exact reviewer selection and explicit fallback policy remain unchanged.
- Benchmark scoring distinguishes failed-open delivery from an actual passing verdict and preserves the original fulfillment bit and failure cause for inspection.

## Checks before installation

- Nested CLI evidence and transport cancellation regression tests both failed on the previous implementation.
- Reviewer, routing, fallback, evidence and scoring suites: 135 passed.
- Host completion, host turn runner and evidence suites: 397 passed, 1 skipped, 0 failed.
- Typecheck passed after these changes.
- A separate name-filtered attempt to reproduce the packet-size pin against the old source stalled and was stopped; it is not a valid red result. The packet-size/access-preservation pin passed in the complete suite.
- The isolated test runner could not certify a quiet live-home snapshot because the real daemon was active. Isolated checks do not replace installed-app acceptance.

## Acceptance still owed

Build and install this commit through the coordinated Terminal recipe, verify served identity, rerun the identical frozen-date Salesforce question with the current Together brain and Grok reviewer, independently inspect facts and review status, then perform exact-candidate release qualification. No live speed improvement or tag readiness is claimed here. The unchanged native executable signature is distinct from a fresh signed full package; runtime-only hotpatch does not restore the bundle resource seal.
