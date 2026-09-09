# Post-v3.16.1 harness refinements — 2026-09-08

## Candidate and ownership

The other agent stopped at `8d5ca856bc279b881dc522560b8938c61e5edee3`. This pass owns the refinements below. No release version was changed and no tag or push was performed.

The authoritative refinement candidate is now `/Users/nathan.reynolds/clementine-next-post-3161-review`, branch `codex/post-3161-refinements`, runtime-code commit `9ae684ef19e1954a228f531a8fe64021f9c4c116`, followed by test-only commit `c1a7dd1e`. Branch `codex/beta-freeze-20260908` also retains that commit. The original `/Users/nathan.reynolds/clementine-next` checkout is unrelated dirty work and was left untouched.

The earlier live runs used `/Users/nathan.reynolds/clementine-next-live-iteration-31`. During the second full suite, an external process switched that checkout from the candidate branch to `ui/spaces-live` at 18:40:36 Pacific and reset that branch to `origin/main` (`8d5ca856`) at 18:40:58. The source therefore changed under running tests. That run is invalid qualification; its module-export and implementation-generation errors must not be presented as isolated regressions in the frozen refinement candidate. No source was reset or overwritten to fight the other process. Reports were copied to the private candidate, and the full suite restarted there. `output/post-3161-live/checkout-collision-reflog.txt` preserves the observed reflog. Merge the preserved harness candidate with completed UI work before building a combined tag; do not assume the UI checkout still contains these refinements.

The five-turn live matrix below qualified code `82488b4426b2661387d8d52e7579b77901e1380d`. The subsequent workflow display correction is recorded separately; do not relabel those five runs as having used the later commit.
Source fingerprint: `9d2bba9c7a8f1adfe6db7fcc04673f533e9e19db221dcaf512a16661c33484d9`.
Schema: 80. Version remains 3.16.1. The fingerprint includes Git HEAD and documentation. Each report retains the exact fingerprint it exercised; do not carry an old fingerprint forward after any commit.

## What changed and why

1. **A single connected account needs no account judge for a read** (`0bd29df0`). `src/tools/source-account-routing.ts` now returns current-source evidence for the only live connected identity. Source ownership, principal, connection revision, inactive-account rejection and write review still apply. This removes a model round trip where there is no account choice to make. A dead-judge control proves the read succeeds without calling it and a write still uses the existing review path.

2. **Schema defaults no longer corrupt workflow settlement** (`af533e91`). The real failed workflow call omitted `inputs`; schema parsing inserted `inputs:null`. The accepted call retained its local-write classification, but the nested settlement compared only the original argument digest, lost that classification, and contradicted the accepted invocation. The successful local result then entered checkpoint-finalization retries and blocked. `src/runtime/harness/brackets.ts` now follows the existing source-owned capability binding when its effective argument digest matches the parsed call. It adds no admission check or new dispatch path. The test uses the actual call-tool/inner-dispatch boundary, queued and disabled workflow responses, one execution, checkpoint persistence and database reopen. The original disabled-workflow trace did not prove a workflow had run; that distinction is preserved.

3. **Optional completion review sees complete retained source evidence** (`5a1ca884`). A 24,000-character head/tail cutoff made two opposite middle facts produce the same judge input while the receipt still claimed complete coverage. Removed that cutoff from `src/runtime/harness/host-turn-runner.ts`. A test at the real host-to-judge boundary retains and exposes each complete payload. The existing model-context admission remains. This trades the earlier cheap-but-incomplete review for truthful review; it is not a token-saving claim. The review switch and ordinary chat eligibility are unchanged.

4. **Workflow completion is judged against its authored steps** (`43bbba80`). A live workflow returned exactly the literal sentence its step required. Its separate workflow-level judge saw only the descriptive text and a non-empty-output criterion, then invented a need for check results or an artifact. `src/execution/workflow-objective-judge.ts` now supplies authored steps and output contracts, preserves full objective and input text, and explains that descriptions do not invent additional work. The verdict parser and disposition policy were not weakened. A control fails without the actual step instruction and passes with it; subsequent live runs complete correctly.

5. **Retrieved workflows are useful context, not a compulsory detour** (`e9db1ccb`). A Terra Space creation matched a qualification workflow by shared name/date words and was told to READ ITS STEPS FIRST. It obeyed, then took a six-call path and activated Plan. `src/runtime/harness/context-packet.ts` now says to use a retrieved workflow when its purpose and steps actually help, and that a candidate does not prove accounts or capabilities apply to the current request. Relevant workflow reuse remains available, including the Facebook-report reuse described in the older handoff. Workflows still run only when requested. No keyword blacklist, extra judge, automatic execution, Plan refusal, or tool removal was introduced.

`3a4f0283` and `82488b44` refresh the implementation-artifact source attestation. The source daemon was rebuilt with backend and mobile assets from the same code before each live window.

The first full-suite run exposed a real side effect: `deriveLegacyWorkflowRunGoal` also feeds the saved/displayed desktop goal, so appending step JSON there leaked internal evidence into the UI. `6d1bf9fb` moves the step payload to the judge prompt only; existing display/persistence assertions remain unchanged. All 110 workflow-objective, contract-proposal and dashboard tests passed after correction, as did typechecking. `9ae684ef` updates source attestation. The first broad run was deliberately stopped after this failure and is retained as `full-suite.log`, not reported as a full pass.

## Live evidence before the display correction

Five sequential turns passed their original expectation objects on the source fingerprint above. Every turn ended `done`, with zero activated plans and no refused settlement. Mutating rows here distinguish local saves/control calls from external writes: workflow dispatch is one local control mutation, Firecrawl is one non-mutating provider crossing. No outbound email or message was sent.

| Journey | Brain | Brain requests | Canonical tool calls | Mutations | Plan | Wall time |
|---|---|---:|---:|---:|---:|---:|
| Run saved manual workflow | GPT Terra | 2 | 1 | 1 local dispatch | 0 | 39.3 s |
| Create task-table Space | GPT Terra | 3 | 2 | 1 save | 0 | 41.9 s |
| Connected Firecrawl lookup | GPT Terra | 3 | 2 | 0 | 0 | 33.5 s |
| Same-session targeted Space edit | GPT Terra | 6 | 5 | 1 save | 0 | 56.4 s |
| Replay saved workflow with Opus | Opus 5 | 2 | 1 | 1 local dispatch | 0 | 35.4 s |

Completion review stayed enabled, with owner-selected Opus 5. All five published a verified review reference; the Opus run also exercises the same-provider setting. This does not newly qualify every learning consumer or a provider-unavailable path.

The Firecrawl capability-resolution event contains `host:read_single_account`, demonstrating the account fast path live. Its one optional completion review is a different operation from account selection.

The second Space's saved data and HTML were captured before and after the edit. Cedar and Harbor were preserved. Southgate changed to Ready, with corresponding mobile record, summary card and status style updates. The first Space's edit had also passed on the earlier candidate with its own before/after proof. This is an artifact comparison, not a claim that every metadata byte stayed unchanged.

Local evidence (ignored output, retained for review):

- `output/post-3161-live/build-2.json`
- `output/post-3161-live/final-live-matrix.json`
- `output/post-3161-live/05-workflow-rerun-report.json`
- `output/post-3161-live/06-space-create-report.json`
- `output/post-3161-live/07-single-account-read-report.json`
- `output/post-3161-live/08-space-edit-report.json`
- `output/post-3161-live/09-workflow-opus-report.json`
- `output/post-3161-live/space-1940-edit-diff-proof.json`, plus both saved Space snapshots

The initial replay was expected to retain the old Opus selection, but the actual route ledger showed Terra. That was corrected explicitly, followed by the explicit Opus selection and a separate Opus replay. The first replay is a Terra qualification; the final replay supplies the same-model before/after. Even the latter is a sequential live observation with additional conversation history, not a randomized performance experiment.

## Failures kept as failures

On the first code candidate (`3a4f0283`, source `c0913aaf7cf1af86efc0411de1d5bf6273c04826e0587573c13a8dd7fc046db5`):

- Opus ordinary chat passed in 8.5 seconds with no tools.
- Opus workflow creation and same-session description edit passed in 41.1 and 20.3 seconds, one write each and zero Plan.
- Workflow run source 165015 returned the exact authored response but ended blocked because the workflow-level judge invented missing work. Its local settlement/checkpoint already worked; this exposed a second problem, not failure of the settlement fix.
- Terra Space creation source 165072 completed but failed the zero-Plan expectation: one plan, six calls, 79 seconds. That record remains a failed qualification. Its separate targeted edit passed in 52.2 seconds with one mutation and zero Plan.

The later successful creation used a new artifact, the same task shape and Terra, and took one search plus one save. No bound was relaxed, no failed write was hidden, and the old artifacts were not recreated to repair assertions. One successful fresh creation does not prove that the model can never choose Plan unnecessarily.

## Automated validation

**Full isolated suite passed on `c1a7dd1e`: 15,459 passed, zero failed, three skipped; exit 0; 1,784.1 seconds.** Four test workers. The owner daemon was stopped throughout, and the live-home sentinel reported no violation. Raw TAP: `output/post-3161-live/full-suite-c4.log`.

The qualification driver subsequently gained optional expected intermediate terminal statuses (`done` or `needs_input`) for a clarifying conversation. Default completion behavior and all effect assertions remain strict; blocked and failed never qualify. This changes only testing, not Clem's runtime. Seven driver assertion tests passed independently; the full suite above predates that script-only extension.

Before the last two refinements, 296 focused tests passed with one skip across the local-settlement, host-completion, carrier and read-routing batches. Workflow-objective tests then passed 24/24. A broader workflow/context batch had one case-sensitive assertion failure after the policy text changed capitalization; the existing explicit do-not-auto-run sentence was restored, and the final context suite passed 39/39. TypeScript typechecking and diff whitespace checks passed. All these tests use the isolated runner; earlier focused runs correctly reported that live-home isolation could not be independently certified while the dev daemon was active.

The second broad attempt, `full-suite-2.log`, was stopped after the external checkout switch invalidated it. A background start race had timed out in that run; its standalone recheck passed in 9.2 seconds without a code change. That recheck does not retroactively repair the invalid full-suite result. The first private attempt (`full-suite-isolated.log`) exposed missing frontend dependencies in the review-only checkout; it was stopped, and frontend plus backend dependencies were copied into independent local snapshots. The next default-concurrency attempt (`full-suite-final.log`) hit the existing 50 ms autonomy grace-clock assumption and two 10-second child-startup deadlines. The clock fixture alone was corrected in `c1a7dd1e` using its existing test clock; production grace and timeout settings are unchanged. All 54 tests in the three affected files passed serially. The definitive full rerun uses four workers and is retained as `full-suite-c4.log`. The earlier attempts are not full passes.

The other agent's full green suite was on `8d5ca856`, not these commits. Do not cite that earlier run as proof of this candidate.

## Limits and next refinements

These are known remaining areas, not new conditions placed in Clem's runtime:

- **Review cost and cache reuse remain expensive.** Final full-turn prompt totals ranged from 56,855 to 151,246 tokens across brain and auxiliary calls; these are total recorded input tokens, not the cost of the judge alone. Several turns had no cached input. Preserve complete evidence while measuring duplication and stable prompt prefixes; do not restore a head/tail shortcut under a full-coverage receipt.
- **The cancelled-worker checkpoint case is not independently closed.** The workflow argument-refinement case is reproduced and fixed. A generic claim that all checkpoint or cancellation failures are fixed would exceed this evidence.
- **Background async-read recovery continues to deserve investigation.** The prior daemon repeatedly logged a resumed durable async-read refinement owner. This pass did not establish its ownership/termination cause or alter recovery timers.
- **Older workflow-level evidence clipping remains.** This pass removes the new host completion-evidence cutoff and workflow objective/input cutoffs. `renderDeliverableForJudge` and legacy objective-judge paths still contain deliverable windows and truncation-shaped gap handling. Do not claim all truncation has been removed.
- **First-turn memory/day context, direct registered reads and carrier-related cache churn** remain follow-up work from the previous handoff. Preserve relevant workflow reuse while testing cold natural conversation; do not mandate every retrieved workflow.
- **Broader release coverage remains separate.** These five final turns cover Terra/Opus, one native workflow, Space creation/edit and one connected read. They do not establish Grok qualification, a complete Sheets→Salesforce enrichment journey, every cancelled-worker recovery path, or fresh rendered desktop/mobile UX. Desktop chat prominence was not changed in this pass; mobile assets were rebuilt, but that is not visual qualification.

The user also referenced historical first-turn/discovery and outreach handoffs dated 2026-09-07. Those files are not present in this private checkout; locate the archived originals before citing their contents or line numbers.

The direction remains: let Clem interpret the task and use relevant tools directly; retain the evidence needed to remember and recover; enforce ownership at real effects. Do not add planning gates to compensate for missing context or a broken carrier.

## Final runtime

The earlier daemon was stopped for the isolated full suite. The next live window is built from this private harness checkout. `output/post-3161-live/build-final.json` will record its actual source SHA, fingerprint, PID and entry once serving; report files retain build identity before and after each live case. A documentation commit changes the fingerprint even when runtime code is unchanged. No tag has been created.

## Ambiguous website partnership journey

The owner's website example is a separate qualification requirement: clarify the business brief, inspect relevant design/provider capabilities, offer useful directions, build an authorized local preview, incorporate feedback, pause, and recall the project from a fresh conversation after a daemon restart. The brief is fictional Juniper & Clay, beginning with a pottery studio for beginners and later revised to private group workshops. Deployment remains pending; no paid image generation or external publication is authorized by this qualification.

The predeclared six-stage specification is retained in `output/post-3161-live/website-journey-spec.md`. Reports use `website-*-report.json`, with a separate artifact/semantic review; an appropriate clarifying question is an intermediate outcome, not proof the whole website is finished. Results must be read from the completed reports, not inferred from this test plan. The five earlier simple live turns do not qualify this long journey.


## Website findings and the next refinements (September 8 Pacific)

The six-stage journey is now exercised, with failures preserved. It is **not an end-to-end pass**: the requested audience/CTA edit did not land. All six initial reports used `71e7bb8b` except the memory replay and cold recall, which used `b07bfd4a` (source fingerprint `ac73f3b5dd46bdc641076082848af338c3d25c72064bbd6760db9436293403c7`). All routed to Opus 5. Reports and independent review are in `output/post-3161-live/website-*-report.json` and `website-semantic-review.json`.

- Opening, source 165633: useful bundled brief question; no tools or writes; 19.1 s.
- Directions, 165654: read the installed design skill and offered two useful directions; 4 calls, 53.3 s. The Higgsfield availability claim exceeded the paginated discovery evidence; this does not prove no connection exists.
- Prototype, 165718: wrote two local files, zero Plan, 156.0 s. Independently rendered at desktop 1280 px and phone 390 px with no horizontal overflow. One repaired list_files argument refusal. Clem and the judge overstated readback: only 1,200 characters of HTML were read, no CSS. The host marked review verified with empty artifact coverage because ordinary write_file declares no receipt contract. This remains a real evidence gap.
- Feedback, 165805: first exact overwrite refused for missing current-source publication; after search it required approval because overwrite is declared irreversible/destructive. Zero writes; files unchanged; pending approval apr-9gl8 preserved.
- Pause, 165862: blocked after 10 calls. Two focus summaries exceeded 500 characters and two memory calls exceeded 800 characters.
- Pause replay, 165973: done, 2 model requests, one memory call, 33.8 s. The report's exact-capitalization assertion failed (no capitalized “Juniper”, though its directory was named), and remains failed. The saved fact was 632 characters: this replay does not independently isolate cap removal. Focus #145 still has status active with “paused” in its title/summary; no focus_park call occurred. The current-turn “just now” wording referred to prior reads.
- Cold recall, 166043: after an owned idle daemon restart, a fresh session recovered the direction, latest audience/CTA, exact file location, and the fact that retargeting had never happened. 4 model requests, 5 calls, 34.5 s, zero writes or Plan. Both semantic review and predeclared mechanical assertions passed. A list_files argument error still required repair.

`e95e4912` removes the 500-character focus summary and 800-character memory_remember content limits. Forty-seven focused tests pass, including the actual registered schemas, full text retention, database reopen, and recall. No storage migration or authority bypass. Other focus workstate and output limits remain; do not claim all truncation is gone. `b07bfd4a` refreshes attestation; backend/typecheck and mobile build passed.

The next source refinement prepares a known exact native call inside the host before attestation, using the current configured dispatcher surface and the existing sealed catalog disclosure. The model no longer has to call tool_search merely to register that already-known operation for a fresh request. No old execution grant is reused. Exclusions, current schema checks, frozen graphs, exact arguments, consent and once-only dispatch retain their existing ownership. Eighteen focused tests passed, including the real orchestrator binding, changed/forged/source-mismatched definitions, native create/edit, and the exact overwrite reaching its existing consent pause on its first call. That last case proves removal of the discovery refusal, **not removal of the overwrite pause**. Earlier fixture mistakes are retained in intermediate logs; final log is `native-preparation-final.log`.

Next: retain durable prior file bytes and actual file evidence before relaxing ordinary overwrite classification; qualify the same feedback request against actual before/after files. Also keep tracking paginated availability overclaims, repeated list_files schema mistakes, stale one-off tasks injected as standing preferences, and focus lifecycle claims. None is closed by a generic “done” terminal.


## Recoverable native file revisions — implemented, live replay next

The discovery refinement is committed at `caea10f0`. The subsequent file refinement makes append/overwrite recoverable through prior-byte snapshots under the protected `state/local-file-revisions` store. It flushes the preimage and prepared journal before changing the target, writes the replacement atomically, and publishes a stable per-target descriptor. Create stays exclusive. A failed backup leaves the existing file unchanged; a failure after an effect is not falsely reported as no write. File permissions and append boundary behavior are retained. Existing typed-state, sensitive-file and installed-skill protections are checked against canonical paths as well.

The registry now declares `file_revision`, and append/overwrite are reversible. The existing exact-source consent and once-only dispatch own the call. There is no new model tool, judge, approval step, or Plan requirement. Optional completion review follows the protected descriptor to the exact file, validates the raw current bytes, and catches changes after judgment. A stable target handle preserves same-source revision identity. This closes the prior ordinary-file no-receipt contract in code; the next live report must establish it on the website journey.

The 24,000-byte write_file cap is removed. Actual registered-tool tests write and read back complete large HTML and multibyte text, perform a revision, retain exact prior bytes, and restore the original through the same tool. Tests also cover failed snapshot storage, symlink substitution, unchanged unrelated files, permissions, create exclusivity, and refusal to edit protected receipts. The `.env` control verifies the existing sensitive-path approval remains; an initial fixture used `.ssh/config`, which is not in the existing sensitive-path classifier and was corrected without widening that classifier.

Final focused batch: **393 passed, zero failed, one skipped** (`file-revision-final-checks-2.log`), including host turn execution, receipt evidence, completion contract, consent, registry, native authoring, and MCP carrier tests. Earlier logs preserve failures: one metadata expectation, one optional-boolean fixture, and canonical path aliases initially bypassing typed-state checks; all corrected before live cutover. The prior full 15,459-test suite predates these changes and is not current full-suite qualification. Native call preparation had its separate 18-test pass. Live revision case is predeclared in `website-07-revision.json`; original files and failed approvals remain intact until the new authorized edit.
