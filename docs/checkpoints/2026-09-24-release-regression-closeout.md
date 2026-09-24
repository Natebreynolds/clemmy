# Release regression closeout — September 24

The owner prioritized main, the release tag, live workflow authoring/activation,
and a verified run of the existing Platform 49 workflow. Optional optimization
is stopped. Preserve the saved workflow's rules and independently check effects;
a terminal succeeded label is insufficient.

## Full-suite evidence

Clean bb13116fc, installed fingerprint
2a85448cd5125e2d25290630a0f1c13aaff2b4dae81317cebe3982d63011af0b,
completed the serialized isolated suite with the installed app stopped:
17,186 tests, 17,175 passed, five failed, six skipped, no cancellations,
3,153,328 ms. This is not a release pass. The five failures reproduced alone
at bb13116fc and all five passed alone at last tag v3.18.19 (8c11aa3c0).

- Three `production-mcp-read-carrier.test.ts` mixed-discovery cases:
  read, reacquired=false, mixed=true; both literalControls variants when
  retired=false and the retired=true variant.
- `tool-search-namespace-successor.test.ts`: unrelated lifecycle replacements
  do not precede a plain-language local operation.
- `tool-search-tool.test.ts`: first discovery preserves a proven ref when
  Composio fuzzy search and staging both wedge.

Full output and candidate metadata are preserved in the ignored
`output/release-candidate-bb13116/`. Attribution logs are
`/private/tmp/clem-five-failures-{bb13116,v31819}-alone.log`.

The full-suite live-home sentinel also reported a harness shared-memory file
change. Database, WAL, memory, authentication, and contract hashes were unchanged.
Readonly SQLite observations can update its shared-memory bookkeeping, but
the process responsible was not established. Do not call that a clean isolation
pass or dismiss it as proven harmless. Avoid live SQLite inspection during the
next isolated gate; retain the sentinel unchanged.

## Narrow corrections

The ranking adjustment had treated only the first verb as the operation's
purpose, so `append` on a spreadsheet outranked a local file tool whose opening
purpose is `Create, append to, or overwrite`. Recognize the initial action phrase
up to sentence/clause boundaries or an article introducing its object. Later
instructions about other operations remain ordinary searchable text. Ranking
remains advisory; no provider, tool, or model names are added to decisions.
The generic compound-purpose pin checks both candidate orders and retains both
tools. An intermediate whole-first-sentence variant broke reminder discovery;
it was rejected, and the original reminder/schema assertion passes unchanged.

Mixed MCP fixtures create both a broad and an exact manifest for one operation.
Their subsequent operation-name disclosure selected a different manifest than
the plan cited. The removed global-card refill had masked this inconsistency.
Disclose the exact observed manifest ID used by the plan and assert that the
returned reference is identical. Keep original transport execution, dependency,
literal-control, retirement, restart, and physical-call assertions. Do not
restore unrelated global catalog entries to the source's card.

The stalled-source fixture described its healthy operation only as "A separately
proven provider capability" and relied on provider score 1000 to surface it.
Give that fixture its actual read-record purpose. Keep the stalled source,
independent disclosure, deadline, exact returned reference, timeout report,
and no-pagination assertions. This does not claim vague provider metadata is
semantically understood or that source-supplied scores establish authority.

Targeted final catalog/discovery/relevance group: 87/87 passed. Full MCP file
passed within the earlier 94-test discovery run; that run's sole failure was the
intermediate reminder regression, subsequently corrected above. Typecheck passed (`/private/tmp/clem-release-closeout-typecheck.log`). The
new exact-commit full gate, installed live acceptance, journeys, packaging,
merge, and tagging remain required. No release is claimed here.

## Live acceptance and Windows

After rebuilding and hotpatching through the existing Terminal recipe, confirm
served fingerprint. Have Clem author, verify, enable, and run a named controlled
workflow. Then exercise the authorized existing Platform 49 workflow without
editing its definition: verify current headers and owned-cell limits, Slack
read-only behavior, incremental writes/deduplication, truthful report-back,
review verdict, exact settlements, and one terminal with no open owner.

Windows production signing secrets were absent at the last check. Do not bypass
the production signing gate or represent an unsigned private candidate as a
signed Windows release. Recheck availability before publication.

## Second full gate and selected-window call accounting

a5fcba79f was built, Terminal-hotpatched, signed and strictly verified with
fingerprint 1951d3476677ddc779e97ab5434fca904abb5b0ea997ded7e82ba98fbb897644.
The complete two-worker run finished in 1,916,893 ms: 17,187 tests, 17,180 passed,
one failed, six skipped, no cancellations. Live-home sentinel stayed unchanged;
no live SQLite observations ran during the gate. All five earlier failures passed.
Evidence: ignored `output/release-candidate-a5fcba79/full-suite.log`.

The sole failure was `provider-keyword-relaxation.test.ts`'s production planning
long-role card. It selected the correct current web-search tool and schema with
one fuzzy request. Its call-count assertion expected two exact provider requests,
but only the hydrated successor and native tools made this page, so there was no
cold provider row to materialize. The failure reproduced alone at a5fcba79f;
v3.18.19 passed alone. This is not a failed discovery or a reason to restore an
unnecessary network call.

The fixture now exercises both the real mixed surface and a provider-only
surface. Both retain the exact first result, schema, deprecated-row exclusion,
one fuzzy request, and bounded lifecycle hydration assertions. The provider-only
variant must select cold rows and verifies the second request contains exactly
those rows, excluding the hydrated successor and every off-page candidate.
The mixed variant allows no second request when no cold row is selected.
Full file: 14/14 passed (`/private/tmp/clem-planning-card-final.log`). This update
changes only test coverage and this checkpoint; runtime bytes are unchanged.
Final exact-commit gates and installed workflow acceptance remain owed.

## Installed workflow authoring: correct work, unreviewed goal

9877d9978 built and passed Terminal hotpatch/signature verification. Served
fingerprint 3b5b72c0448920fe36fca5a07421c98252e6ccbfcc0a420f4f43a9092f24bea0,
daemon69607. Source295938, session sess-desktop-864ee7e8f18b3653cce870da, created
`harness-release-9877d997-check`, passed its creation test, enabled it, read back
enabled=true, then ran saved workflow1790248549015-42a436. Actual local input
contained three records with amounts7,9,11. Final result COUNT3/TOTAL27 is correct.
No schedule, external effect, or business workflow mutation. Source finished
with no open attempts. Evidence under `/private/tmp/clem-release-9877d997-live/`.

This is NOT clean acceptance: the goal review failed open with the generic
`judge unavailable`, and the run delivered a truthful unreviewed advisory.
Whole-objective pass=false; no verifier success is claimed. Transport failures
also appeared in other services near that time, but the root judge error was
discarded, so do not infer quota exhaustion, bad credentials, or a network cause.

A second class defect was visible in its criterion receipt: the COUNT/TOTAL
criterion passed deterministically merely because its source JSON path existed.
The separate objective review prevented verified overall success. Restrict that
shortcut to complete existence-only claims; calculations, content constraints,
and qualifications after a path go to the existing batched semantic review.
Plain existence claims retain deterministic handling. Keep extraction separate
from proof. Three content-shaped negatives reproduce the previous false pass.

Strict single-objective and checklist reviewers now preserve the already
redacted/bounded underlying error and parse-repair diagnostics. A real route/
Runner test with fake provider wires reproduced the old lost diagnostic and
proves no extra attempt or provider substitution. Both red pins failed on9877.
Final focused review group123/123, caller group54/54, typecheck passed.
Logs `/private/tmp/clem-live-workflow-review-{red,green,callers,typecheck}.log`.

Canonical source measurement:159.2seconds,453464prompt,248664uncached input,
12139output,27model records,9top-level tool calls. Ledger labels13 records brain,
including three Opus records during discovery and ten DeepSeek records; do not
call this an exclusively DeepSeek brain benchmark or infer a fallback without
further attribution. Reviewers:7Opus records/112688uncached input. Creation test
and child-run attribution must be respected in any later comparison. No general
performance claim. Platform49 has not been rerun in this acceptance wave.


## 05f90b16 installed acceptance and recovery blockers

Installed SHA05f90b16a/fingerprint006e8e8690406e0ebae632add8aef1b24b8ef38621a288178ed3337553dee88c
passed the controlled saved workflow again: source296144,
session sess-desktop-3a82cfead514bfafd9a8a5df, run1790249277793-c3d101,
COUNT3/TOTAL27, enabled=true, goalValidation.pass=true, judgeFailedOpen=false.
One source terminal, no open attempts. Run took18.4seconds; this is not matched
against the earlier author-and-run request. One runId/run_id schema repair.

Platform49 run1790249457091-f42225, childsource296305, was cancelled after
recovery failed. The write review correctly refused a proposal lacking evidence.
Then a proven GOOGLESHEETS_BATCH_GET through composio_execute_tool was refused
by the recovery surface, which admitted the prior write's inner name but not
this known read. The permitted diagnostic only showed its first12 entries;
absence from that event did NOT prove call_tool was absent from the full set.

A subsequent held workflow consumer finished its run attempt as interrupted at
11:34:02.832Z while same-source recovery was still armed. Resumed tools then
failed child_lease_activation_failed; a second source296473 also started.
Do not weaken dispatch-lease checks: the consumer must preserve its real owner.
No external mutation crossed in this child ledger. Independent before/after
FORMULA reads of Log A1:Z500 and Daily Digest A1:Z200 matched exactly. This does
not certify uncaptured cells. Evidence: /private/tmp/clem-release-05f90b16-live/.

Framework candidate: admit exact proven inner reads during zero-crossing repair,
without granting every operation in the carrier; retain normal schema/account/
effect checks and no admission during uncertain effects/reconciliation. Workflow
held consumers retain their exact attempt, authored scope and cancellation
registration until the exact typed terminal; peer holds still close the loser.
The terminal releases the scope and registration. Diagnostics name the actual
surface and exact read operations instead of an incomplete first12 list.

Red pins: recovery selector12/13, workflow-owner5/6; full production host
read→refused write→fresh read→re-reviewed write failed with the read fix removed.
With the final fixes and complete diagnostics, 61/61 focused host/workflow/
recovery checks and typecheck passed. Logs: /private/tmp/clem-workflow-recovery-final.log,
/private/tmp/clem-recovery-typecheck.log.
No paid model tests. Never observe live SQLite during isolated sentinel checks.
Final hotpatch, Platform49 clean run, full gates, merge, push and tag remain owed.


## 45872c92 live recovery passes; reviewer evidence blocks completion

Installed SHA45872c922, fingerprintf83d605b93ab2ff320ca6d632d0326440ef683c01671d5950c026bff7b7a1d8b,
daemon2689; Terminal patch/signature verified, UI archive unchanged. Platform49
retry1790251019711-72a447, childsource296645, parent296601, preserved the saved
definition. A write refusal296751 was followed by successful evidence read296757:
the previously dead recovery edge now works live. No child_lease_activation_failed.

The run still did NOT pass. Mutation reviews repeatedly opened partial text
views, then asked the brain to re-read already retained data. The full proposal
(including its rules, args, and evidence index) was itself hidden behind one
large-result ref, wasting lookups before the reviewer could identify the evidence.
The reviewer also could not project tuple columns: query_evidence ignored fields
on array records and returned entire long rows. Its filtered output lacked source
indices, contributing to ambiguous row position reasoning. No sheet-specific
exception or consent bypass is an acceptable fix.

Cancelled at12:02:37Z after repeated unverified proposals. Exactly zero mutating
physical/host crossings in the child settlement ledger; both sources terminal,
zero open attempts. Receipts: /private/tmp/clem-release-45872c92-live/. This is
bounded recovery acceptance, not end-to-end Platform49 success or a speed win.

Next candidate keeps rules, proposed operation, small args and the authenticated
evidence index visible to mutation review; large args/schema remain whole in
separate scoped refs. Mutation evidence shares the existing inline allowance
across settlements, preserving every retained byte and exact request scope.
Other workflow completion evidence presentation stays unchanged. Reviewer JSON
queries now project numeric tuple columns and retain original zero-based source
indices after filtering, while counting over all rows. No writes or added tools.

Red/green evidence: packet visibility pin failed on45872; tuple-column pin failed;
production host compact-index pin failed with compact presentation removed.
135 focused review/host/workflow checks and typecheck passed. Logs in
/private/tmp/clem-review-evidence-{red,green,neighbors,typecheck}.log,
/private/tmp/clem-review-packet-red.log, /private/tmp/clem-compact-review-host-red.log.
Public hygiene also found four tracked handoffs containing personal paths/address;
portable home paths and an explicitly redacted address clear those findings.
Final candidate live acceptance and the release gates are still required.

## f6608b52 live: write verified, objective not accepted

Platform49 run1790251949224-825e58/source296865 finished with a completed step
but terminalOutcome=blocked, needsAttention=true, goalValidation.pass=false,
judgeFailedOpen=false. The objective reviewer rejected the missing workspace
refresh and missing thread/name checks; required output keys alone passed.
Do not call this clean workflow acceptance or automatically replay its write.
One Sheets batch update physically crossed at296935. Independent readback
against the pre-run baseline found changes only in Daily Digest row102,
columnsA:E/G:H (09/24/2026, zero counts, no-new-items text,05:12). LogA1:Z469
and existing cells in the observed DigestA1:Z200 window were unchanged.
Definition hash remained491efb983465afd1b174c797d2a4b62441af22141929dbc31c041766b9342bd7.
No Slack writes. All attempts ended before app shutdown.

Canonical child measurement:212.9seconds,30model records,822014prompt,
261344uncached input,26377output,10top-level tools. Brain14DeepSeek frames;
reviewer13Opus records/152906uncached; router3Jev. This incomplete run is not
an end-to-end speed acceptance. Raw receipts and independent readback are
preserved in ignored output/release-acceptance-2026-09-24/clem-release-f6608b52-live/.

The post-write space_refresh refusals reproduced without network/model calls:
resolveConfiguredLocalPlanningTool(work_call) returned z.toJSONSchema's result
including non-enumerable ~standard runtime metadata. Strict canonicalization
correctly rejected that non-JSON property before the mutation reviewer ran.
Publish the library-generated schema's JSON wire representation at the shared
local schema boundary; retain the original Zod argument validator and strict
canonicalization for arguments. No tool-specific permission or review bypass.
New actual-native-schema pins cover work_call and call_tool, preserve slug
constraints/optional source_id, and reach a recording mutation reviewer.
Red:work_call failed,call_tool passed. Green:37/37 local-planning,mutation,
and host-authored-send tests. Logs:/private/tmp/clem-native-schema-{red,green}.log.
Final live acceptance, exact-commit full gates, main and tag remain owed.
