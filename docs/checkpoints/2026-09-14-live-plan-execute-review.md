# Live Plan → Execute review, 2026-09-14

Read-only observation of installed 3.18.6. No run interruption, app restart, source fix, live database edit, or external write by the reviewer.

Session: `sess-desktop-fe74a1c10cefde3af99b09eb`. Plan source 204986; Execute source 205104. Evidence: `output/plan-execute-review-2026-09-14/events.json` and three complete stored research payloads. Last reviewed event 205273 at 17:46:42 UTC; execution has no terminal yet.

## Healthy behavior

Terra used high reasoning effort for explicit Plan. Read the existing document and open team comments, recalled memory, discovered tools, and published revision 1. Planning took 4m27s (17:17:11–17:21:38), including one broad discovery timeout. The owner approved through Execute revision 1 at 17:39:29. Execution reread the document and comments and ran the five planned terminology searches. No external document mutation has occurred as of this checkpoint.

## Primary defect: a page error invalidates a successful search

Three Firecrawl searches (AEO, AI SEO, AI Search) returned top-level successful:true, inner success:true, and ten web results each. A subset of rows includes metadata.error for failed scraping or CAPTCHA. `inspectProviderEnvelope` recursively classifies this as error_error at depth 5. `attempt-settlement.ts:1203` changes the whole successful search to unknown/provider_envelope_contradiction. The failed searches have full stored tool output but no successful durable result handle. Only two of five collection members satisfy the graph.

Pure local control using the real inspection function reproduces all three failures. Removing only per-page error/status metadata from in-memory copies changes all three to clean; raw retained outputs and the live ledger remain untouched. See classification-control.json. This establishes the trigger, not a proposed blanket deletion of error metadata.

Refinement: distinguish the call's transport verdict from per-item retrieval quality. Keep page failures visible and exclude unsupported page content from claims; retain usable sibling results. Preserve real envelope-level failures and uncertain-write protections. Avoid provider-specific vocabulary rules or blanket success overrides.

## Recovery defect: inconsistent state and no actionable dependency repair

`reviewed-plan-results.ts:78` reports only “Reviewed collection research-term-competitors is not complete.” It omits the three missing member identities and their recorded outcomes. By event 205273, five plan_step_result calls have failed without changing the dependency state.

At 205259/205265 a retry of an unknown read returns work_already_satisfied, detail “the prior unknown outcome authorizes no retry,” and repair “This requirement is already complete.” The attached graph simultaneously reports 2/5 instances and blocks the update. `expected-work-admission.ts:2159/2930` is the relevant denial path.

Refinement: one consistent member-status projection for scheduling, result resolution, and repair messages. Name incomplete member IDs and their outcomes. Distinguish retryable reads from ambiguous writes; avoid asking the model to repair synthesis JSON when its actual missing input is upstream research.

## Judge effectiveness and cost

Four completed Grok 4.6 execution trajectory reviews so far (205204, 205216, 205224, 205233), all on_track with empty steer. The latter two followed rejected synthesis calls. Evidence coverage sizes are 333654, 347938, 60321, and 60627 characters; these are character counts, not token usage or proof of a context-limit failure. Two large windows were followed by incremental smaller windows.

Refinement: ensure trajectory review reconciles dependency state, latest tool rejection and repeated failed attempts with the proposed next action. Content quality alone does not establish progress. Do not add more review calls to fix an evidence/state omission. Completion judging and final artifact quality remain unqualified until a terminal and saved-document readback exist.

## Secondary observations

The model's memory recall returned unrelated old draft-repair and test-specific instructions labelled as standing facts. No resulting task redirection is proven here. Audit provenance/scope and retrieval relevance before expanding memory injection.

Progress heartbeats exist, but at 17:45:13 claim waiting for the model for four minutes despite intervening model calls and failed tool submissions. They should expose the actual unresolved step and activity; rendered chat parity is not yet inspected in this review.

The plan's evidence criteria and in-place verification intent are sound. Its five seed terms should remain expandable if research reveals relevant terminology; whether the current graph allows that expansion is not established by this run. Do not treat five seeds as a general product cap.

## Follow-up

Watch this exact Execute source for a terminal, further retries, writes, readback, completion-judge events, and delivery. Preserve failures. Do not mark this journey qualified from a good-looking plan or a judge on_track verdict. Update this document with the final outcome before recommending changes as complete.

## Final outcome

Execute source 205104 ended blocked at event 205309, 17:51:22 UTC, after 11m53s. No document write occurred. The final reply correctly reported that the incomplete research collection blocked the update. The subsequent owner question (205310), asking whether enough research existed, ended at 205329: Clem said nine additional competitors were supported and that plan state, rather than lack of research, blocked the write. That is her claim; final document quality remains unverified because nothing was saved.

The watch for this exact Execute source is complete. Prioritize result-envelope scoping, accurate read-recovery codes, member-level dependency diagnostics, then existing judge/progress state alignment. The updater defect has separate evidence in `2026-09-14-update-repair-freeze.md`; both fixes are included in patch 3.18.7.


## Authorized patch and qualification

The owner subsequently nudged Clem in Act mode (source 205330). That turn performed one `googledocs_update_document_markdown` write (205363), read the document back (205374), and finished (205386). The blocked Execute and successful Act follow-up remain separate outcomes. This review establishes the write/readback, not an independent score of the document's substantive research claims.

Patch 3.18.7 changes shared framework behavior:

- Identified collection-item metadata remains retained but does not contradict the containing successful call. Outer failure flags, direct item failure flags, and unidentified error envelopes remain inspected. The exact three captured payloads now classify cleanly with all four page-level errors preserved.
- Unknown reads can recover through the existing admission path; uncertain mutations still require reconciliation. Unresolved requirements no longer report themselves completed.
- Incomplete collection errors identify member IDs, outcomes, and usable-result counts, directing upstream repair while preserving completed members.
- Existing trajectory review receives current execution dependencies and guidance about repeated downstream submissions. No new review call or approval gate is added.

Verification: 354 focused harness regressions, 55 release-asset checks, and 48 release-closure tests passed. A real Terra brain / Grok 4.6 completion-review journey passed Plan (180 seconds) and Execute (179 seconds) in an isolated home. Execution used a changed source value (237 rather than the planning snapshot's 100), recovered from a broken reference, retained unknown facts honestly, wrote one local artifact, and read it back without another owner nudge. Evidence is retained under `output/release-3.18.7/live-terra-grok/`; original captured-payload replay and compiled-runtime hashes are beside it.

This live run tests general Plan-to-Execute behavior with local evidence. The exact provider-envelope failure is proven by captured-payload replay plus settlement/SQLite-reopen regression tests, not a repeat live Firecrawl call. The wider unit suite was still running when these notes were written. The overlapping canonical journey run hit a 600-second file timeout on the 10,001-partition fixture; the broad suite also recorded child-process startup/barrier timeouts and a file timeout on the already-green focused Plan/Execute suite. These runs are retained, and affected files plus serialized journeys require uncontended requalification; final packaging gates must be rerun on the clean committed build. Initial dirty-tree packaging checks correctly refused stale build metadata / an uncommitted candidate. Do not waive those checks.
