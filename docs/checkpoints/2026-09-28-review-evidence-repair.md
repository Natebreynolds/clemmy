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

## Rejected optimization and corrective candidate

Installed 3cd97c973, source316763, completed in 418.033 seconds with 29 brain rounds, 1,625,243 recorded input tokens (472,091 uncached), and 33,668 output. The initial review request was 109,451 normalized bytes. A fast negative review completed, but its full confirmation timed out; the subsequent final review also timed out and delivery was explicitly unreviewed. This is a regression, not acceptance. A cancellation request arrived after the run had already completed; it did not abort this run.

The shared packet cap hid selected evidence, leading to unverified findings and repeated read/discovery work. This candidate removes that cap for targeted retained pages and restores their full presentation, retaining the smaller ordinary bulk-read previews, nested CLI JSON queries, authenticated default record paths and judge cancellation. The previous shared-cap test asserted the rejected optimization's behavior, not a release invariant; it is replaced by a counterexample that requires full selected evidence across many pages. No capability or accuracy requirement is relaxed to make a test pass.

The same live run repeatedly searched for the Salesforce connection hostname. CLI status already probes an auth document but discarded its public instance origin. The corrective framework adds an optional catalog-declared JSON path for a public HTTPS connection origin. The generic health engine reads only that field from stdout, refuses credential-bearing/non-origin URLs, binds it to the reported account, and drops it after a failed refresh. The catalog declares Salesforce's existing result.instanceUrl field; no new command, shell permission, default-account change or credential read is introduced. CLI inspection exposes only a fresh origin alongside the account. Origins from another account must not be inferred to match an explicitly targeted query.

Origin extraction and tool-surface regression pins failed on the old implementation (two failures); all 107 focused checks passed with one pre-existing skipped contract case after the fix. Typecheck passed. Selected-page preservation is additionally checked against the regressing implementation before restoring the correction. Installed acceptance, exact-candidate full checks and final packaged signing remain owed. No tag or claim of zero regressions.

## Installed corrective repeat and discovery follow-up

Served a0b6e5e333, fingerprint 0f1d08e27de17d0b59ec3c82b93e79ed627823355430906690207cb6e4fce23d; daemon and both web trees match. Native files unchanged and executable verification passed; full bundle resource seal remains invalid after runtime-only patch.

Controlled CLI origin check source317096 passed in 5.866 seconds, two brain rounds, one CLI inspection and a real positive Jev completion verdict. It returned the signed-in account and its public connection origin. Recorded total input31,186, uncached17,106, output779; totals include attributed supporting calls, not just the two brain calls.

Identical Salesforce repeat source317130: 174.799 seconds, 16 brain rounds, 590,537 recorded input tokens, 96,713 uncached, 16,924 output. Relative to46b775545 this is19% faster,38% lower total input and24% lower uncached input in this single stochastic run; it is not a controlled causal attribution. The Grok review request was159,808 normalized bytes and still timed out. The turn explicitly stands unreviewed, so these savings do not qualify a tag. Cancelled reviewer remote usage remains unknown rather than zero. It retrieved7 incoming EmailMessage rows and supplied links, but did not perform the earlier Task/activity cut; do not claim coverage equivalence or complete correctness from matching the7 alone.

The live search for `salesforce sf cli org display instance url` put unrelated authorized Outlook and Slack operations ahead of relevant choices. A ranking boolean was treating any acquired planning authority as query relevance. Only an acquired read that actually answers the current query may now receive that precedence. Other authorized operations remain available, and exact selection, effect checks and account authority stay unchanged. A failing regression pin reproduces an unrelated authorized calendar read outranking native Space creation. The two older acquired-precedence pins now supply a query that actually names that inventory read, preserving the query-bound behavior they claimed to test.49 related ranking/namespace/exact-selection/CLI checks passed. CLI inspection metadata now advertises its safe connection-origin output;9 relevance checks pass including the live URL search shape. This discovery follow-up still needs build/installed qualification.
