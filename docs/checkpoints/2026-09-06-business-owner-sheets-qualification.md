# Business-owner qualification — sheet, CRM, enrichment and market leaders

**Final ownership transfer — September 7:** The owner has ended the reviewer role. The implementation agent owns qualification, checkpoint updates, UI integration and release preparation from here. No future reviewer response or live-window handoff is required. The recurring monitor is paused. Read the [final handoff](/Users/you/clementine-next/docs/checkpoints/2026-09-07-final-harness-handoff.md); it supersedes older coordination instructions below. Historical evidence remains scoped to its recorded build.

Owner direction, September6: after the tag, a business owner should be able to give Clem a Google Sheet, ask her to review it, cross-reference its accounts in Salesforce, collect additional “SCO data,” add a new section to the sheet, and identify potential market leaders. The owner mentioned about10hours remaining and explicitly asked not to rush the other agent. This is a concrete release qualification target; time does not replace proof. It is an example, not authorization to modify an unspecified live sheet or CRM. The intended “SCO” source remains to be clarified.

## Intended behavior

Clem resolves the sheet, authorized Google/Salesforce accounts, available schemas and requested enrichment source. She reads the whole relevant range, preserves stable row/account identifiers and detects missing or ambiguous matches. She uses an agreed definition of market leader rather than silently substituting a metric. Ask a focused clarification only for unresolved information that changes the result; useful read-only investigation can proceed first.

The dependency graph should follow the work:

1. Read the relevant sheet, headers and existing content; resolve companies/domains and keep source row identity.
2. Match those entities to Salesforce accounts and gather enrichment. Independent reads can run in parallel after their inputs are known; dependent reads wait for a verified match. Subagents are useful only where they can perform independent bounded work.
3. Join the records with source/time/confidence and preserve unmatched/ambiguous rows visibly. Do not silently drop pagination tails or manufacture a match.
4. Add the requested new section/tab/range while preserving existing formulas and unrelated cells. The accepted request determines the destination and authority. Do not send communications or edit Salesforce merely because it was used for lookup.
5. Read the exact written range back and compare it with the intended output; retain the write/result identity so retries or resume do not duplicate sections or rows.
6. Explain candidate market leaders using the agreed criteria and supporting data. Distinguish a measured ranking from insufficient or incomparable data, and link back to the resulting sheet.

The local loop inspects, corrects and verifies one piece. The graph represents dependencies and joins between pieces. Explicit Plan mode lets the owner inspect the proposed work and Execute a specific reviewed revision; internal graph execution is a separate mechanism and should not force every ordinary request through a user-facing planning ceremony.

## Qualification evidence

Prepare a synthetic/test-owned sheet and suitable authorized test data once prerequisites are ready. Do not use a new sheet/write to conceal a failed assertion. Use fresh wording and data so the journey exercises general behavior.

Record the combined source/build identity, selected review policy, accepted source/session/run, actual models, schema/tool discovery, exact account/object IDs and graph dependencies. Independently compare all requested input rows with CRM/enrichment matches and final output; check preservation of prior cells/formulas, no unauthorized changes, no duplicate writes, and clear missing-data outcomes. Judge input must contain applicable evidence or exact retrievable handles; a local-workflow-only receipt contract must not become a Google Sheets prerequisite.

Include an interruption after some reads and another after the write has settled but before final response. Resume the same accepted work, rejoin completed nodes and reconcile the existing write rather than restarting it. Include a user correction to matching or ranking criteria, confirm correct supersession and reuse the authorized correction in a fresh session. Keep durable owner instructions distinct from one-task exceptions and imported sheet text.

Completion review on, deliberately off, and intentionally selected same-provider behavior must preserve the same execution authority and deterministic receipt/readback checks. Terra+Opus is a selected qualification configuration, not required access for every owner.

The owner has now requested a broader live campaign immediately after the current implementation round:12 core journeys, approximately30–40 accepted turns including variations, followed by this connected journey as its prerequisites become available. Prepare this dataset and assertions in parallel; pending SCO clarification must not stall native, policy, recall, learning or recovery tests. [Expanded live campaign](/Users/you/clementine-next/docs/checkpoints/2026-09-06-expanded-live-qualification.md).

## Current evidence and ordering

C30 now adds representative live graph execution: three real workers independently reviewed account/renewal, usage/adoption and invoice data, then the parent merged24 accounts correctly by ID. All fields, flags, totals and ranking match independent expected data. It took135s; it is not20–30minute endurance, interruption recovery or live Google Sheets/Salesforce proof. Scoped owner teaching/correction/fresh-session reuse is also demonstrated. Clean local Workflow create/edit and selected same-provider/off policy positives remain valuable.

C31 improves conditional recovery retirement and completes one live task after a pre-write restart. Its save path still fails a stale-instance metadata preservation control, and post-write recovery remains unqualified. This does not close the sheet scenario's settled-write/rejoin requirement.

The broader22-turn campaign exposed the continuity work required before this scenario is dependable: post-write restart rebuilt conflicting authority; a late old response poisoned the next accepted Plan revision; mixed native reads cannot be bound into a valid Plan; cold recall spends model turns draining unrelated indexing; an exact missing local workflow name silently selected a different saved workflow. These are concrete local harness failures, not evidence of a cross-app account exploit. Repair the shared boundaries while preparing exact test sheet/account/enrichment inputs and the combined UI. Full completion/learning and actual source/account/row identity/readback remain required.

[Full C30 ruling and next correction batch](/Users/you/clementine-next/output/reviewer-monitor/2026-09-06-c30-review.md). On the successor, rerun affected failures and retained positives before completing this real connector journey. Preserve partial results and exact receipts; do not recreate a failed write or relabel local synthetic analysis as live Sheet/CRM qualification.

The implementation lead now maintains this scenario and the canonical checkpoint. The owner’s10-hour estimate does not authorize rushed changes, reduced checks or a promise of readiness. No finite test proves perfect execution for every future request.

The bounded architecture map confirms existing dependsOn/dataFrom topology, parallel read waves, packet workers with durable results and parent lineage, and exact revision Execute rejoin. It also records current batch/topology limits and compose-only external worker authority; do not assume arbitrary per-row DAG expansion. [Current graph/loop implementation and proof boundary](/Users/you/clementine-next/output/reviewer-monitor/2033-review/owner-sheet-journey-architecture.md)

Final C31 review adds a verified local post-write restart positive. It also demonstrates why the business journey must accept corrections end to end: the worker answered an owner's replacement request, but a judge using the old objective forced the original work to continue. Include a natural mid-journey amendment/replacement and verify the current objective, exact rows/ranges and prospective effects through review/recovery. One local retained Workflow receipt does not qualify the connected sheet/CRM/enrichment journey.
/Users/you/clementine-next/output/reviewer-monitor/2026-09-07-c31-final-review-0142.md

## September 7 qualification update

Frozen C31 proved natural cold recall and cancellation respected by the actual completion judge, but an ordinary Space read→edit lost its active attempt owner and looped through review without writing. Plan revision also changed unrequested layout/data. These are direct prerequisites for a dependable Sheet→CRM→enrichment→write graph: independent reads must rejoin an active owner, the corrected objective and selected rows must survive continuation, and review must preserve the owner's unchanged cells/content. Exact connector inputs remain pending; this pass ran no Sheet/CRM/SCO effects and proves no cross-app completion. Complete the measured continuation/native/revision batch, then qualify this end-to-end scenario on the integrated build.
[Current evidence](/Users/you/clementine-next/output/reviewer-monitor/2026-09-07-c31-frozen-qualification.md).

## C34 implication for the business journey — September 7, 04:38 UTC

A local CREATE workflow request was substituted with an UPDATE of a pre-existing artifact. The completion judge saw the current artifact and accepted the end product; dispatch had no independent owner mutation-scope comparison at the graphless native consent seam. This does not establish a matching connector defect. It reinforces the existing business acceptance requirement: writing a new Sheet section, cross-referencing Salesforce and modifying existing records/ranges are different authorized effects. Verify each operation's actual accepted account/target/change scope and preserve unrequested data, including legitimate mixed-operation lineage, regardless of whether optional completion review is enabled. The full connector journey remains unqualified. [C34 ruling](/Users/you/clementine-next/output/reviewer-monitor/2026-09-07-c34-review.md).
