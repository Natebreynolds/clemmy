# Plan convergence and adaptive reads — 2026-09-12

Latest follow-up: [Execute recovery, waiting plans and memory — 2026-09-13](2026-09-13-execute-recovery-and-memory.md). It records subsequent failures, corrected terminal/revision handling, plain-text partial plans and the newest qualified hotpatch candidate. Use that document's disposition and build identity for the next test.

## Purpose and scope

The installed Sonnet Plan run, accepted source **198975**, produced a useful plan but took **513 seconds**. Its review is preserved at `output/reviewer-monitor/2026-09-12-plan-review/installed-plan-198975/REVIEW.md`. The owner approved four framework refinements: converge on the right tools, align planning and review, support additional investigation during Execute, and keep unrelated prospective memories out of the task.

This pass changes the harness. It adds no approval stage, task vocabulary, service-specific workaround, business-effect exemption, or model-required result field. Existing UI/Home work is untouched. No commit, tag, push, installed-app restart, or live business-account write was performed.

## Changes

1. **Discovery uses the actual integration and schema.** Ranking recognizes a namespace written with spaces (for example, Google Docs), while preserving alternatives. Generic MCP operations can match through input descriptions, properties and examples. This affects both provider-side candidate selection and the combined result list. Ranking does not mint capabilities. Plan guidance reuses exact known operations and reads the selected nested contract rather than repeating broad searches or a whole documentation index.

2. **Brain and judge agree about preparation and freshness.** The effective Plan objective still requires reading supplied inputs now. It permits an execution refresh when freshness, an expected change, or verification warrants it; the former absolute prohibition contradicted the brain's instructions. The existing completion reviewer is asked to report material gaps together and distinguish optional improvements from failures. For a prepared-plan review, successful `tool_search` dumps are omitted because the candidate carries its selected contracts. Actual input reads, failed attempts, and full business evidence remain. Ordinary completion review is unchanged.

3. **Additional reads can support an approved plan.** A contextual `work_call` read using a capability reference no longer masquerades as a reviewed step ID. It uses the existing exact host attestation, source, schema, account and dispatch checks. A read claiming an actual reviewed step still has to match its prepared arguments. Extra reads neither discharge required graph nodes nor permit different writes. The host only performs planned-native-read preparation for a call that actually claims a planned requirement; otherwise that preparation could execute a supplemental read before its own dispatch lease existed.

   Model-authored synthesis automatically snapshots supplemental observations available at that point, alongside its declared dependency digests. No new argument is required from the model. These observations are provenance, not an assertion that the model used every result or independently verified its conclusions. Reopening verifies the retained bytes. Replaying identical synthesis keeps its original snapshot; later readback cannot rewrite the provenance of an earlier write. Older flat dependency records still reopen.

4. **Prospective memory requires topic relevance.** Two integration names shared by otherwise different objectives no longer suffice to inject an unrelated scheduled workflow. Short relevant follow-ups in the same session, explicit durable references and commitment overviews remain available. Scheduler activation, procedural memory and general memory search were not removed or changed.

## Failure found while verifying

The new missing-source → alternate-source test exposed an existing file-tool defect. `read_file` returned a missing-file message as ordinary text; the ledger reported success without a retained successful result, so checkpoint finalization held the run. Missing and non-file paths now return the existing typed argument-failure result, for both `read_file` and `convert_to_markdown`. The failure can reach the model and an alternate read can proceed. This does not report a missing file as successfully read.

The first integration attempts failed at successive real seams: reviewed-call matching, frozen-work admission, local versus catalog attestation, and premature planned-read preparation. Those checks were corrected at their owners. The test then needed room for its added nested tool invocations; its expected model frames and exact successful write count remain asserted.

## Verification

- Focused suite: **116 passed, 1 skipped, 0 failed**.
- Additional regression suite: **123 passed, 0 failed**. Six integration cases overlap the focused suite; do not add the totals as unique coverage.
- TypeScript check and candidate build passed; `git diff --check` passed.
- Integration coverage includes missing supplemental read → alternate read → recorded synthesis → SQLite reopen → one exact write → contextual readback; supplemental digest tampering; compatibility with older result records; rejection of changed reviewed read arguments and unplanned writes; and no duplicate effects on replay.
- Provider plan execution, checkpoint recovery, local read admission, carrier schemas, discovery ranking and orchestrator tests passed.
- Tests use the isolated runner. Its installed-home sentinel cannot certify an unchanged installed home while the existing app daemon is running; the runner reports that limitation. The tests themselves use isolated homes.

Logs: `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-verification/`.

## Candidate and live qualification

Candidate source fingerprint: `4ee9d7148465ee8f885a163ba8ce9d3b16bb962a5c5823e534c666c17757a6d6`.

Live qualification uses isolated daemons, Sonnet 5 as brain and owner-selected Opus 5 as completion judge. The driver is `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-qualification.mts`. It checks exact accepted sources, served model identity, high Plan effort, saved-plan review, business mutations, output bytes/content, and final verification. It retains failed attempts rather than silently repairing the test artifacts.

The first journey refreshes three inputs changed after Plan and saves their current bytes. The second exercises a project record changed after approval, a missing reference, an alternate source, synthesis and one saved briefing. The completed observations and failed attempts are recorded below.

### First live journey: passed

Evidence: `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-live/freshness-claude-sonnet-5-1789274594976/result.json`.

| Turn | Source | Wall time | Parent model requests | Result |
| --- | --- | --- | --- | --- |
| Plan | 1 | 135.175 s | 4 | First publication accepted; high reasoning on the Claude wire; delegated read completed; zero business writes; Opus final review verified. |
| Execute | 98 | 33.920 s | 4 | Three current source texts saved exactly, three writes, no refused/failed attempt, no plan revision; Opus final review verified. |

Both terminals matched the judged objective and response; Execute's three artifact digests also matched the current files. The isolated daemon was stopped and its retained home sanitized. These are individual observations, not a controlled speed comparison with the installed eight-minute research request.

The original connected Google Doc + Apify/DataForSEO journey has not been rerun on this candidate. Local live proofs and controlled discovery tests do not establish that journey's latency or correctness.

### Second live journey, first attempt: failed and retained

Evidence: `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-live/adaptive-claude-sonnet-5-1789274822218/result.json`.

Plan took **347.049 s** and was accepted on its second publication. The first draft tried to iterate over interpreted compute output, which the current collection contract does not support. It then represented an optional reference and its fallback as two mandatory successful producers. Execute recovered the missing facts from the fallback, but synthesis could not consume the nonexistent required source. It stopped after **138.065 s**, with **zero files and zero writes**. The full assertion set failed. This is not a successful adaptive qualification.

There were also two malformed once-cardinality calls, an identical failed-read retry, and a changed-argument retry. Those errors are retained. The Plan review passed an unusable recovery structure; it did not prove that recovery worked.

Follow-up correction: the Plan instructions, `publish_plan` dependency description, execution activation response and completion review now describe the same contract. Required graph nodes must succeed. Conditional investigation belongs in the reviewed synthesis method, where supplemental read-only observations are available and retained; a fallback and the lookup it replaces must not both become mandatory success dependencies. Indispensable reads stay required. This adds no model-required field and does not waive failed nodes after approval. Existing saved plans with such a dependency still require revision; this change does not silently rewrite them.

The affected regression suite after that correction passed **125 tests, 1 skipped, 0 failed**. Typecheck passed. The unchanged live test was rerun on a fresh build; see the result below.


### Second live journey, after correction: passed

Evidence: `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-live/adaptive-claude-sonnet-5-1789275444407/result.json`. Served candidate: `fef2b2b8998dc095467bb1cf1b734a1e697c796a6c44c847461a8a27295d8f2c`.

| Turn | Source | Wall time | Parent model requests | Result |
| --- | --- | --- | --- | --- |
| Plan | 1 | 130.478 s | 6 | Ready plan with a required current read, adaptive investigation/synthesis, one write and readback. Zero business writes. One malformed-JSON attempt repaired before publication; no hidden retry. Opus final review verified. |
| Execute | 77 | 67.409 s | 8 | Primary reference missing; alternate source read; current facts synthesized with retained supplemental evidence; one write; exact readback; no reauthoring or user question. Opus final review verified objective, reply and current artifact bytes. |

The briefing correctly reports budget **237 with unit unknown**, delivery **Thursday with date unknown**, the literal changed status marker with its meaning unresolved, and exact source paths. It identifies the failed reference as attempted rather than read, and calls the fallback's “approved” label a source claim. It does not invent a currency, a delivery date, or contents of the missing file. The prose is somewhat longer than this tiny fixture needs; this proves recovery and evidence handling, not premium writing across every task.

Opus served one completion review for Plan. Execute served one trajectory review and one completion review. Both completion verdicts were accepted with owner-selected same-provider provenance. The live supplemental observations are recorded with synthesis; SQLite reopen and digest-tamper checks are covered by the integration test, not by a daemon restart in this live run.

An additional discovery regression found that deduplicating query words before matching multiword namespaces lost the second integration in a query such as “Atlas Calendar and Atlas Docs.” Namespace matching now preserves word order and repetition; lexical term scoring still deduplicates. The discriminating test failed before the correction and passed after it. The discovery suites passed **32 tests**.

## Final build and next local test

The final candidate is rebuilt after this checkpoint because documentation participates in the repository's source fingerprint. The exact final build identity and final repeated live qualification results are recorded outside that fingerprint in:

- `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-verification/final-build-check.json`
- `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-live/final-freshness/result.json`
- `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-live/final-adaptive/result.json`

Use each result's actual `pass`, source identity and served build stamp; an expected result path is not itself a success claim. The final chat response reports the observed outcome. Logs and artifacts include unsuccessful prior attempts and are not overwritten to repair assertions.

Next installed test: after a successful build check and qualification, quit Clementine normally and run the existing daemon-only hotpatch script, then reopen the app. Start a fresh Plan for the original Google Doc + Apify/DataForSEO brief, inspect the selected sources and prepared operations, and Execute the exact reviewed revision. Compare discovery calls, repeated documentation reads, completion-review retries, first visible progress and total duration against source 198975. The local proof does not replace this connected-provider journey. A previously approved plan with both optional and fallback reads as mandatory dependencies must be revised; we do not silently alter its approved graph.

No commit, tag or push has been made. No installed hotpatch has been applied by this pass. The hotpatch script preserves installed UI and authentication dependencies; Claude ran successfully in the isolated live tests.

## Final-candidate repetition exposed another defect

Candidate `e813e4a17a6b7366553295e9ecbf05da7707261f2b3a8ccb1eef4be606e6a4eb`:

- `final-freshness/result.json`: **passed**, Plan 184.419 s, Execute 33.278 s, three exact writes. One plan preparation repair was needed for a compute-as-collection producer.
- `final-adaptive/result.json`: **failed**, Plan 123.561 s, Execute reached the test's 720 s timeout without a done terminal. The fallback read worked. Synthesis initially used the wrong shape, then the model repeatedly transcribed different bytes into the consuming write. One shortened paragraph was eventually written, but it omitted the literal current status and the planned Markdown structure. Opus rejected it. The run then tried to revise a completed create operation, which the existing reviewed contract did not permit. Do not label this candidate qualified.

That finding changes the handoff between graph nodes. The host now materializes declared dynamic arguments and per-member bindings from their exact retained producer results before execution and metadata recovery. It uses the already reviewed binding; it does not ask the model to reproduce the same long text in a second call. The model can omit those bound fields. If it supplies a differing transcription, the bound value owns that field. Static fields, operation, account, schema, result provenance and member identity still have to pass the ordinary checks. Missing or invalid producer evidence is not synthesized. No tool or additional permission is added.

The synthesis tool also describes the current plan's actual consumed output paths and types, alongside its existing parameters. A whole-text binding calls for a string; an object binding names its actual fields. This is contract information, not a new required payload field.

Regression proof: the modified integration test failed in **three cases** before materialization and all **six cases passed** afterward. These cover omitted content, a deliberately different transcription, a per-member write with empty arguments, exact bytes after reopen, no repeated effects, and static-destination/operation/source isolation. The additional suite passed **106 tests**, including a 50-draft Composio fixture whose fake provider asserted every exact payload and account, plus checkpoint recovery. The final targeted edge suite passed **14 tests**. Typecheck and whitespace checks passed. These suites overlap; do not sum them as unique tests.

Further live qualification of these final binding changes is recorded at:

- `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-live/bound-freshness/result.json`
- `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-live/bound-adaptive/result.json`
- `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-verification/bound-build-check.json`

Those exact machine results govern readiness. The earlier `final-*` paths remain as evidence, including their failure. The original connected research request still needs its installed-app rerun. Post-write semantic correction of a frozen create plan is not solved by this change; the fix removes the avoidable transcription cycle that caused the degraded write in this reproduction.

### Concurrent UI build boundary

The mobile UI agent continued changing `apps/mobile-web` during both final binding builds. Both builds correctly rejected a moving source fingerprint. Harness qualification therefore uses a detached worktree snapshot at `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-verification/candidate-source`, copied from the current uncommitted tree. No commit was made, and the UI agent's checkout was not paused or changed. The source modifications remain in the original checkout. Build checks and hotpatch must use the qualified snapshot, not the moving checkout. The `bound-*` evidence paths above point to the original checkout's output directory; their served stamps identify that snapshot.


## Binding qualification and final alignment correction

Candidate `38daa922bf5a948d997bcb6fca65dbb0fd10b925021a66460552c425532d8fd2`:

- `bound-freshness/result.json`: passed, Plan **108.967 s**, Execute **40.345 s**. Three writes used host-bound `/path` and `/content`; the bound events and exact output bytes are retained.
- `bound-adaptive/result.json`: failed. Plan **141.162 s**, Execute **563.508 s**. Supplemental recovery, first synthesis shape, host-bound content and one write all worked. The saved briefing nevertheless invented a currency and claimed an unperformed working-memory read. Completion review correctly rejected those claims. The subsequent repair ran into the frozen create contract; it eventually disclosed the defect but did not repair the file. The full qualification remained false. A disclosure and a done terminal do not prove the requested artifact was corrected.

Two framework mismatches were identified in that trace. Complex Execute was capped at medium reasoning because it was running in a chat session. Execute now uses the existing task-complexity tier (complex high, moderate medium, simple none), while Plan retains high and ordinary chat retains its existing policy. The actual outbound provider setting must still be checked live; a selection event alone is insufficient.

The completion reviewer and advisory watcher now receive historical read evidence from the exact approved Plan source. The same retained-byte redemption checks apply; unrelated session/turn reads are not imported. This evidence is explicitly labeled historical and is kept separate from Execute receipts: it cannot prove current state, a newly claimed read, or verification of a later write. Successful discovery dumps remain omitted from this preparation context. Plan prose alone does not prove a read happened. The missing working-memory read in the failed run remains unsupported; this change does not excuse it.

Execute guidance now asks the brain to compare its synthesized content against the objective, sources and success criteria before recording the value consumed by the write. There is no extra mandatory review call, approval, domain vocabulary or runtime validation gate. This is prevention, not a structural solution to post-write semantic repair of an immutable create graph; that broader gap remains open.

Final alignment results are recorded without overwriting earlier failures at `four-refinements-live/aligned-adaptive/result.json`, `four-refinements-live/aligned-freshness/result.json`, and `four-refinements-verification/aligned-build-check.json`, relative to the reviewer output folder. Their actual outcomes govern readiness; these path names do not imply success.


### Alignment qualification exposed a synthesis presentation defect

Candidate `b39089b0738a9e481912b7838b53caf2f7cbd294394012a782cb29d7cf7674b9`:

- `aligned-freshness`: passed, Plan **114.088 s**, Execute **43.368 s**, three exact writes.
- `aligned-adaptive`: failed the strict no-unexpected-refusal bar, Plan **113.607 s**, Execute **72.713 s**. It finished with one write and no false currency or unperformed-memory claims. High Execute reasoning was confirmed on the actual Claude wire, and both watcher and completion evidence included the exact historical Plan source. The first synthesis used an object when the approved consumer required a whole string. Its repair over-encoded the string, and the resulting file contained a JSON string literal with escaped newlines rather than usable Markdown. Opus accepted it. Manual artifact inspection caught what the judge missed; this run is not qualified.

The synthesis tool's public schema and examples were overly generic. When all the plan's consumed compute outputs are whole strings, `plan_step_result.data` now advertises the actual string type and plain-text semantics. Generic object-wrapper examples were removed. Mixed/object output plans retain structured data, and legacy encoded input stays supported. The runtime does not heuristically unwrap arbitrary user content or weaken validation. The actual built Execute tool surface is asserted in the integration test. **82 tests passed** after this change. The evidence handoff test separately passed with **28 passed, 1 skipped**; earlier fixture-authoring failures are retained in the logs and were corrected at the fixture.

The live driver now asserts actual Markdown structure as well as exact current facts and receipts. This is a qualification assertion, not a product gate. Final surface qualification runs are `four-refinements-live/synthesis-adaptive/result.json` and `four-refinements-live/synthesis-freshness/result.json`; build identity is in `four-refinements-verification/synthesis-build-check.json`. Do not substitute an older pass for either actual final result.


### Failed-call diagnostics must reach the reviewer

Candidate `55ba9f01f8390ef31631f65b443e688c1002536bfd2e3ca5cc51460ab565a37d` passed `synthesis-freshness`. `synthesis-adaptive` failed and is retained: the first synthesis now matched the declared string shape and wrote actual Markdown, but the text still guessed a currency. The reviewer instead objected to the statement that a referenced file was missing: its evidence contained only the broad `invalid_arguments / validation` class, while the exact returned diagnostic said `File does not exist`. It incorrectly concluded the file had never been checked. Execute took **247.760 s** and did not produce a verified done terminal. Do not credit that run as a success, and do not credit the schema change with eliminating semantic mistakes.

The read-evidence collector now includes the exact failed call's returned diagnostic, scoped by session, accepted source and canonical/call identity. It labels this as reported failure evidence, never a successful source read; the settlement status is unchanged. An unavailable failed-call diagnostic remains unavailable. A database-reopen test proves that a different call or source cannot supply the error. **29 tests passed, 1 skipped**. The query was also checked directly against the retained live failure and found the matching missing-file diagnostic.

The latest live qualification additionally rejects the fixture's invented `$237` currency even if a model judge misses it. Final paths: `four-refinements-live/diagnostic-adaptive/result.json`, `four-refinements-live/diagnostic-freshness/result.json`, and `four-refinements-verification/diagnostic-build-check.json`. Those results are pending until recorded; earlier passes and a successful build check are not substitutes.

## Remaining architecture limitation

A model can still write an incorrect artifact. These refinements remove avoidable discovery, transport, evidence and reasoning friction; they cannot guarantee a correct synthesis. The existing optional completion review happens after a write, and a frozen create graph can prevent the correction it requests. Repeatedly prompting a stronger model is not a structural solution.

The next bounded design should cover correction of an owned local artifact with an explicit revision lineage: keep the prior receipt, bind the corrected synthesis to a new revision, and verify the final bytes. It must not replay external creates/sends or quietly change destinations or accounts. A companion option is to use the already owner-enabled review on prepared content before publishing, retaining the review's objective/data digests and then checking delivered bytes. That would need its own tested stage semantics and must honor review OFF and same-provider configurations. Neither design is implemented or qualified here; no new mandatory reviewer barrier was added in this pass.


## Final observed disposition: not qualified for hotpatch recommendation

Final built source: **242012dca4bbf38c33a647ac3a62411af357793c0ab7afccf9008ad3b70b2600**, dist digest **7b57933518d61a6c2ec4d9f5372614b8fd5381557476513c84e525fe3cb3c496**. Build/check succeeded; the snapshot matches **2,940** tracked/nonignored harness files in the main checkout. Main checkpoint updates after the snapshot are documentary; build and qualification refer to the snapshot above.

| Journey | Plan | Execute | Reviewer disposition |
| --- | --- | --- | --- |
| Three changed input files | 171.897 s | 30.384 s | Passed. Current bytes, exact member pairing, three writes, no unexpected failures, selected Claude models and final review verified. |
| Changed project record plus missing reference | 110.674 s | 667.035 s | **Rejected by manual audit.** One file was written, but its comparison treated old planning values (100/Tuesday) as conflicting current facts even though the fresh primary record held null/null. Opus caught this. The frozen create operation prevented correction; the final response disclosed the error and asked about overwriting instead of fixing the artifact. |

**Important qualification correction:** `diagnostic-adaptive/result.json` originally reports `pass:true`. That is a driver false positive, not a passing journey. The authoritative reviewer ruling is `diagnostic-adaptive/qualification-audit.json`, which records `qualified:false`. Do not overwrite the original report or hide the discrepancy. Five `REVIEWED_PLAN_CALL_REFUSED` returns happened before settlement, and the driver had waived the entire adaptive refusal list while only checking settled failures. The final judge also returned `awaitingUser:true`; the runtime nevertheless emitted `done` with `resumable:false`. The driver now rejects those pre-settlement reviewed-plan refusals and requires a positive, non-awaiting-user completion review for these fully specified fixtures. Those stricter assertions were applied as an audit to the preserved trace; no new live pass is claimed.

Both final isolated daemons stopped and their retained homes were sanitized. No installed daemon patch, UI edit, commit, tag or push was made by this work. The temporary candidate launcher was removed because the candidate is not qualified. The installed daemon remained the user's existing PID 48159.

### Next work, before calling Plan → Execute reliable

1. **Owned-artifact correction:** revise a synthesized output and its already-created local artifact with explicit revision/receipt lineage, preserving destination/account scope and protecting intervening owner changes. Do not simply remove the frozen-plan checks, rewrite prior evidence, or replay creates/sends. Owners: `reviewed-plan-results.ts` (post-write synthesis revision refusal), `reviewed-plan-runtime.ts` (exact operation/static argument matching), and expected-work/dispatch owners. Prove an initial bad synthesis → review finding → corrected synthesis → same-artifact revision → final correct readback. Distinct mutation counts must distinguish initial write and authorized correction; do not rewrite the clean-attempt fixture to hide errors.
2. **Waiting is not done:** preserve `awaitingUser` from `judgeHostCompletion` through its caller and terminal publication. Current decisive points are `host-turn-runner.ts` around the verdict return and final-frame completion branch (approximately lines 3705 and 8506 in this snapshot). A review accepting the need to ask a question cannot certify the requested artifact as completed. Test exact outcome, resumability and mobile/desktop presentation state through the existing typed lifecycle; UI rendering work remains owned by the UI agent.
3. **Current versus historical facts:** the model had the fresh bytes; this was not a missing read. Ensure the Execute context clearly separates immutable approved instructions from historical Plan observations, and that newer observations of the same source govern current factual claims. Avoid service names, task-word grammars, or silently discarding the approved plan. The old snapshot may be reported as history, not as a competing current source.

The original connected Google Doc + Apify/DataForSEO journey is still unqualified on these changes. Once the remaining correction/lifecycle work is tested, rerun that fresh Plan and Execute its exact reviewed revision before a tag decision.

### Owner clarification: relevant memory should inform the plan (2026-09-13)

Memory may influence a plan when it is relevant to the accepted end goal. Separating historical observations from current facts must not remove useful procedural memory, established preferences, prior decisions, or relevant skills. The plan should briefly identify material remembered context it relies on, explain how it affects the approach, and distinguish what is confirmed from what remains an assumption. A remembered fact is not confirmed merely because it was retrieved or repeated in the plan.

Use available evidence to confirm changeable facts before relying on them; an Execute refresh may satisfy a stated freshness need. Preserve established preferences and procedures unless the owner or current evidence changes them. Where a material uncertainty cannot be resolved through available reads, show it in the plan and ask only when it changes the work or requires an owner decision. This clarification does not add a mandatory memory search, extra approval stage, required JSON field, or separate confirmation question for each memory item.

Carry the relevant context and its evidence status into Execute. Approval adopts the proposed approach; it does not make old observations current or turn an unresolved assumption into a verified fact. Current observations of the same subject should govern current factual claims while the approved objective, preferences, and method remain available.

Qualification should cover a relevant remembered preference shaping the plan, an irrelevant memory staying out, a stale factual memory corrected by a current read, and a material unverified memory clearly marked without being presented as confirmed. This section records the owner's requirement for the next implementation pass; it is not a claim of new runtime behavior or a new live-test pass.
