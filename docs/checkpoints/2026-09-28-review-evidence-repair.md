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

## First installed repeat and follow-up

Installed db082f426, fingerprint 535e850e1b0f68d75285ebcc25d36ff50c3af91cf9ea49847d975c9866ff5635, source316560:
191.601 seconds, 23 brain rounds, 980,924 recorded input tokens (116,412 uncached), 16,157 output. The review request fell from 385,886 to 191,159 normalized bytes, but Grok4.7 still hit its 90-second deadline. No completed reviewer usage returned: unknown remote spend is not zero. This is not successful release acceptance, and a single stochastic repeat does not establish causal brain efficiency.

Follow-up changes share the existing model-relative inline read budget across original results and selected pages, including worker scopes; source-bound lookups retain every complete result. Write receipts and plan review are unchanged. Authenticated record paths guide the reviewer's default record query, including empty result lists beside larger carrier metadata arrays.

CI investigation found two additional issues: learned procedure recall rendered the previous request's target in its title; it now renders operation knowledge without copying old request values. Today routing and CLI recovery fixtures assumed the old direct Home route and a locally installed binary respectively. The routing fixture now checks both ordinary Today landing and explicit New Chat/seeded composer routing; recovery fixtures explicitly supply installed-binary resolution while preserving the exact once-only recovery assertion. The existing learned-hint integration pin reproduced the target leakage before its fix. The recovery failures were observed on CI and passed on the developer Mac; this platform dependency is the defect in their fixture setup, not evidence of repaired OS credentials.

Related CI/recall suites: 74 passed. Shared completion-budget/host suites: 391 passed, one skipped, zero failed. Latest follow-up still requires its own build and installed acceptance. No tag yet.
