# Slack preparation, approval and effect receipts — 2026-09-28

## Observed run and boundaries

Session `sess-desktop-02e425788f2987cfc1614160`, installed source `74fcd619fb1424e44774abf33c6849f728e140da`.
Read-only trace inspection; no approvals clicked, messages dispatched, settings changed, or live-home fixture resets. Evidence snapshot: `output/slack-approval-review-0928/evidence.json` in this worktree. Last observed event 322424; no active attempt, two message approvals still pending. A pending turn is not completed delivery.

User sequence: Salesforce SDR meetings → account notes/lead origin → website research → two Slack drafts → “lets send those please” → two DM-opening approvals. Clem resolved both intended Slack user identities. The four research/drafting turns reached success terminals. This audit confirms the execution sequence, not independent factual verification of every sentence in the business briefs.

Earlier recoveries: two generic shell calls were refused before dispatch and redirected to the exact reviewed Salesforce query tool; one SOQL ContentDocumentLink semi-join failed and was repaired by separate queries; tool_output_query received an invalid order value and recovered. Preserve the reviewed CLI routing and schema validation; improve first-frame guidance rather than weakening them.

## Approval sequence and truthful effects

- 322378/322379: `SLACK_OPEN_DM` approvals, apr-i9wh/apr-ppg1, both classified as irreversible sends. They contain users, no message content.
- 322386: first approval accepted. 322392 unnecessarily presented a generic input question while another approval remained.
- 322398: second approval accepted. Calls 322403/322410 each dispatched once.
- 322409/322416: both provider replies explicitly state `ok:true`, `already_open:true`, `no_op:true`, and return channel IDs.
- 322408/322415: the host nevertheless projected successful external writes under the predicted send classification. Public receipts counted those as “2 writes confirmed.” Those receipts did not prove messages were sent.
- 322422/322423: two separate `SLACK_SEND_MESSAGE` cards, apr-n080/apr-qjjo. Latest terminal 322424 awaits their approval. No send dispatch is present in the audited snapshot.

The actual send approval boundary held. The defects are unnecessary setup approval, inaccurate effect receipts, vague partial-approval presentation, and expensive continuation. Do not merge setup authority with delivery authority or replay this business run as a test.

## Causal findings and evidence limits

The structural classifier can treat the DM noun as a send. Existing operation-delivery learning is the correct extension point: Jev screens the current definition; the configured judge confirms; only then can a definition-bound non-delivery verdict refine that structural result. The live store contains no accepted Slack verdict. Two Jev delivery calls are recorded during draft preparation. Therefore “Jev never ran” is false. Non-learning outcomes were debug-only, so the retained evidence does not establish which operation failed which stage.

Separately reproduced code gap: deferred exact preparation materializes full provider definitions but did not schedule delivery learning. Exact materialized search also bypassed the fuzzy-path scheduling. Fixing those paths improves coverage; it does not establish that either gap alone caused this live refusal. First encounters and unavailable/uncertain reviews may still ask. No new blanket allowlist or lower confidence threshold is introduced.

Receipt cause: settlement recognized the provider success envelope but discarded the explicit no-op. The event/public/progress paths inherited predicted effect rather than observed effect. A successful prerequisite can return an existing resource without creating a new one.

## Framework changes in this candidate

1. Schedule existing delivery learning from current exact provider definitions on deferred preparation and materialized exact search. Do not learn from index prose or user-intent summaries. Existing deduplication, freshness, disagreement, schema/account and actual-send checks remain.
2. Log bounded delivery-learning outcomes and definition digests at info level, without tool payloads or private text, so absent learning is attributable.
3. Preserve explicit successful provider no-op evidence as structured settlement detail. Inspect acknowledgement fields, not business records or prose; no_op does not prove a failed response succeeded or authorize retries.
4. Carry observed no-change through host and SDK bracket terminal projections. Keep success/settlement and exact result handles, but separate unchanged operations from confirmed changes in work reports, audit counts, run progress and public receipts. The existing shared desktop/mobile reducer renders these as returned operations rather than confirmed write cards.
5. Pin durable replay: one physical call, one terminal, no repeated operation, no confirmed write, clean settlement audit. Real sends still require their existing consent.

Historical journal rows are not rewritten. This candidate does not retroactively repair old receipts lacking the new observed-effect field. Grouped approval UX, readable recipient labels and generic partial-approval terminal copy remain follow-ups, not implemented claims.

## Measured baseline

Canonical per-call usage, grouped by accepted source (including attributable side work); approval resumes stay on source 322354. These are different tasks, not matched benchmarks. One zero-usage uncertified Jev row on source 322095 is reported separately from certified totals.

| Source / stage | Calls | Input | Cached input | Uncached input | Output |
|---|---:|---:|---:|---:|---:|
| 322023 / meetings | 10 | 107,684 | 57,344 | 50,340 | 5,680 |
| 322095 / notes | 13 (12 certified) | 259,575 | 166,336 | 93,239 | 13,826 |
| 322209 / websites | 13 | 422,772 | 317,120 | 105,652 | 4,718 |
| 322287 / Slack drafts | 12 | 194,274 | 111,616 | 82,658 | 4,085 |
| 322354 / send request + setup approvals | 8 | 125,353 | 10,304 | 115,049 | 2,217 |

The last stage includes two DeepSeek brain frames with 118,370 input tokens combined. The two approvals introduced roughly 45 seconds of human waiting between first cards and second approval, followed by roughly 11 seconds to the real-send cards. Do not call human waiting model latency. No after-patch efficiency win is claimed.

## Verification and remaining acceptance

- Initial focused group: 40/40 passed.
- Host/audit/public/progress/discovery group: 110/110 passed.
- SDK bracket group including added no-op parity: 109/109 passed.
- Existing learned-delivery consent integration pins passed, including real sends, schema drift, explicit notification controls and unavailable evidence.
- Behavioral red check on pre-fix source: exactly the new host no-change/replay and deferred-definition learning pins fail for the expected missing behaviors (log `/tmp/clem-slack-regression-before-valid.log`). An earlier partial revert was invalid due to mixed module exports; it is not regression evidence.
- Typecheck passed before final small parity edits; final build/check still recorded in output receipt separately.
- These are prerequisites, not live acceptance. The isolated runner explicitly cannot certify a global-home sentinel while the installed daemon is active; tests use their fixture homes, and no live reset was used.

Before claiming the extra setup approval eliminated: run current-definition learning with the real configured Jev/judge, verify an accepted verdict and exact risk projection, then perform controlled installed-app/live-home acceptance. If the judge disagrees or cannot classify, record that outcome rather than suppressing approval. Test partial approval, exact two-send receipts, and reopen/restart without replay using controlled fixtures; never resend these business messages. Preserve pending business approvals through any coordinated hotpatch. No tag or new installed acceptance claimed by this document.
