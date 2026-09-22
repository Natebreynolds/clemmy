# Clementine framework handoff: Jev, reliable execution, latency and token efficiency

**Prepared from September 21 live records and source at `24676b91`, on shared `main`.** The checkout was clean before this document was written. This is an implementation handoff, not a declaration that the candidate is ready. Refresh source ownership and the running build before acting.

## Mission and north star

Make Clem a first-class assistant that grows with the user: it remembers useful preferences and successful methods, resolves conversational references, discovers unfamiliar tools, performs the work, verifies the outcome, and recovers without requiring repeated prompting. It should become faster because it understands the task and avoids unnecessary work—not because it hides capabilities, skips unfinished requirements, or declares success prematurely.

Jev should be a small, fast decision layer around the main reasoning model. Use it where a typed decision demonstrably replaces expensive reasoning or improves the next action: selecting relevant capabilities, evaluating evidence, identifying a concrete missing requirement, or selecting a recovery. Keep rich planning and synthesis with the brain. Deterministic orchestration should handle known iteration, data movement, identifiers, receipts, deduplication and resumptions.

Measure success together: correct finished deliverables, elapsed time, total model usage, user interventions, and reliable recovery. A cheaper failure is not a win. A successful tool call is not proof that the whole request is complete. A faster answer that leaves expensive reviewers running is not necessarily more token efficient.

## Scope and operating instructions

- Framework work only. Do not repair or migrate personal/business Spaces, rewrite the owner's workflows as a workaround, clean personal memories, or change integrations to make a test pass. Preserve the token-meter work and other agents' edits.
- Read the continuity files first: `docs/checkpoints/2026-09-19-current-framework-state.md`, `2026-09-19-active-configuration.md`, `2026-09-19-weekend-refinements.md`, and `2026-09-19-live-acceptance.md`. They are chronological evidence; their opening snapshots are not current configuration.
- Inspect `docs/JEV-AGENTIC-HARNESS-IMPLEMENTATION-BRIEF.md`, but use this document's newer findings where they supersede its historical priorities.
- Verify other agents' current branch, worktree and ownership. The visible Claude task used a shared checkout and committed other in-progress framework changes together. Do not assume a commit title describes its complete scope.
- Acceptance must use the installed app and live home with named, controlled fixtures. Pure/unit tests remain useful, but isolated-home success is not live acceptance. Never run destructive fixture resets against the live home.
- Use Grok/GLM for generative acceptance tests under the user's latest model constraint. Jev decision calls are in scope. Do not spend Claude/Codex quota on test runs. Record requested and actually served models, including workers and reviewers; substitutions are not a pass for the requested provider.
- Clem owns Claude OAuth. Standalone Claude CLI login and a UI usage badge are not sufficient evidence of Clem's connection or actual provider rejection. Do not change credentials or provider routing as an unrequested workaround.
- Native Space/workflow tools, local MCP, CLI and Composio must remain discoverable and usable. Respect existing authorization for external writes; ask only for genuinely missing choices or authorization. Reading/discovery must not become an arbitrary approval exercise. Preserve exact account binding, write receipts and replay protection.
- Do not publish a release merely to avoid installing and accepting a candidate. Use the supported installation mechanism, verify served bytes, preserve rollback and report exactly what was tested.

## Evidence inventory and release state

This review inventoried **all 64 input events** in the local live database from September 21 midnight Pacific (07:00 UTC) through the evening capture after UTC midnight: **47 desktop, 16 workflow, one worker**. It used the existing read-only `scripts/session-comparison.ts::measureAcceptedTurn` for accounting, not a new token calculator. There are 59 canonical owned-terminal measurements. Five inputs cannot be measured that way: 274141, 274452, 278159, 278477 and 278480. Missing owned terminals include resumed/worker/synthetic paths and are not automatically failures.

Companion evidence:

- `output/jev-handoff-2026-09-21/run-ledger.md`: every input, recorded status, time, model calls and tokens.
- `output/jev-handoff-2026-09-21/accepted-turn-audit.json`: exact session/source identities, per-tool and per-model counts, attribution certification, and measurement errors.
- `output/jev-review-watch/checkpoint.json`: incremental reviewer notes; not a release certificate.

The ledger includes scheduled business runs so they are not silently excluded, but their success is not controlled framework qualification. This review did not replay external actions or independently re-query every business record. “Done” below means the recorded terminal unless stated otherwise. Inputs and outputs containing private records are deliberately not copied into this handoff.

Known build history:

| State | What is established | Limitation |
|---|---|---|
| September 21 stabilization overlay | Checkpoint records v3.18.17, fingerprint `395a0e7db2b1a39ba9d7b2756affbbd43fc56208b20fc11a5dbd5b516e11b2cb`; see `2026-09-21-stabilize-hotpatch.md` | Later runs used evolving patches; do not assign this fingerprint to all of them |
| `f7aca711` | Record projection improvement committed | Payload replay is not a full live performance benchmark |
| `7c7c1325` | Native embedding startup loads removed following the crash loop | First-use native safety and restored semantic recall need explicit acceptance |
| `v3.18.18` / `16bb2cbc` | Public release independently verified as published, non-draft and non-prerelease | Publication is not installed acceptance; rejected-Jev fallback remains a concern |
| `69da86a2` | Recovery bound plus broad Jev changes committed across 21 files | Not a recovery-only candidate; includes pruning, schema preloading and parallel review |
| `24676b91` | Additional once-only recovery test | Does not itself prove recovery after genuine checkpoint progress |
| `3.18.19-rc.1` | Agent reports successful macOS artifact and failed Windows artifact upload | This reviewer did not install or accept it; establish its exact commit before promotion |

At handoff, a read-only request to the running build-info endpoint returned HTTP 401 with the available local credential. **Current installed fingerprint is therefore unverified.** Do not infer an authentication defect from that result or claim Git HEAD equals installed bytes.

## Today's material outcomes

Input tokens include cached input. All table numbers below were refreshed through the canonical measurement tool. They are not billed cost or matched experimental comparisons. Worker descendants require separate reconciliation before claiming all-in task cost.

| Source | Work | Recorded outcome | Seconds | Model calls | Input tokens | Interpretation |
|---|---|---|---:|---:|---:|---|
| 273280 / 273514 / 273798 | Salesforce person plus calendar | Done | 165 / 154 / 214 | 16 / 13 / 17 | 397,473 / 574,003 / 540,012 | Both providers reached; substantial retrieval overhead remained |
| 274725 | Calendar today | Cancelled | 4,181.9 | 150 | 4,932,090 | 153 `workspace_roots` calls; runaway, not a slow success |
| 276365 | Calendar retry | Blocked | 186.7 | 9 | 142,916 | Ten repeated root calls stopped; containment, not completion |
| 276796 | Two deliverables | Done | 56.0 | 9 | 134,148 | One local write and an unavailable second input; inspect criteria and honest-blocker semantics before calling it full delivery |
| 276915 / 276961 | Calendar today | Done | 72.7 / 58.1 | 5 / 5 | 98,444 / 93,853 | Calendar call plus a result query |
| 277007 | Add lunch | Done | 59.9 | 5 | 113,311 | Provider creation receipt inspected previously; no independent subsequent readback in this review |
| 277099 | Plan/create outreach workflow | Cancelled | 506.4 | 17 | 420,682 | No plan publication; two drift instructions delivered and ignored |
| 277671 | Calendar today | Done | 65.1 | 5 | 70,996 | No result-query round; lower input than 276961, but slower |
| 277737 | Remaining calendar today | Done | 128.4 | 7 | 106,953 | Simple lookup still slow |
| 277795 | Calendar today | Done | 84.5 | 9 | 186,433 | Two searches and result query returned |
| 277906 | Calendar tomorrow | Done | 80.8 | 6 | 54,733 | Fewer tokens do not establish a latency win |
| 277962 | Calendar tomorrow | Blocked | 301.5 | 16 | 145,423 | Capability ID used as result handle; 13 query attempts; no calendar dispatch |
| 278113 | Calendar tomorrow | Done | 94.6 | 7 | 51,594 | Two worker calls; reconcile worker source 278159 separately |
| 278199 | Calendar tomorrow | Done | 85.0 | 7 | 151,914 | Search, calendar invocation and result query |

Additional outcomes are in the full ledger: arithmetic and no-referent clarification, local file tasks, interruption/resume, inbox lookup, scheduled Apify/Composio work, Slack/Sheets work, and approval continuation. Fresh-session “handle that” clarification is not proof that follow-up reference resolution works with a real antecedent. The interrupted file resume source 276514 wandered and was cancelled; it is not a passed resume test.

Sources 278302 → 278480 show an external Slack operation waiting for approval and later capturing a result after approval. This is useful workflow continuation evidence; it is not new authorization for the receiving agent to send messages or re-run that business workflow.

## Implementation priorities

### 1. Repair the capability → invocation → result chain before narrowing tools further

**Observed failure:** source 277962 selected a remembered calendar operation at event 277967 with `skipDiscoverySearch:true`. Clem then sent that `cap:resolved:...` capability ID as `call_id` to `tool_output_query`, with dummy filters, repeatedly. There was no real calendar call. The governor labeled attempts `unmetered_attempt`; the repeated-call guard eventually escalated, and the user got a generic internal-failure reply.

**Current code:** `src/runtime/jev/proven-operation.ts`, `src/agents/orchestrator.ts`, `src/agents/tool-catalog.ts`, `src/tools/work-call.ts`, `src/tools/call-tool.ts`, result-query/handle resolution, and `src/runtime/harness/host-no-progress-projection.ts`.

The current remembered-strategy path accepts a single lexical match without its former score condition, treats identical tool sets as interchangeable jobs, and can take the top match when Jev fails. The narrow tool set retains only `ask_user_question` from the acquisition kernel and also filters generic dispatch, workers and search on the skip path. Guidance says to search if the operation is insufficient; that promise needs a real reachable mechanism.

Implement and prove:

- A disclosed capability must expose an actually callable carrier with the exact argument schema and account context in the final model tool surface, not just in a catalog.
- Distinguish capability identity, logical call identity, physical dispatch identity and result handle. A capability ID cannot be treated as existing results or empty data.
- Treat remembered strategies as recommendations until current-request coverage is established. Matching tools do not prove matching objectives, filters, accounts or all requested steps.
- On uncertainty, missing carrier, stale schema/account or incomplete coverage, restore discovery in the same turn without requiring the user to restart.
- Make retained results cheaply addressable after dispatch. Inspect smaller subsets instead of re-reading or repeating the provider call.
- Test a remembered calendar lookup followed by a mixed calendar-plus-attendee-research request needing an unfamiliar tool. Include local MCP, CLI, native tools and Composio, not calendar alone.

### 2. Make workflow authoring and execution a continuous, honest path

**Observed planning failure:** source 277099 spent over eight minutes exploring existing workflows, memory and schemas without publishing a plan. Both drift instructions were delivered; adding another warning is insufficient.

**Reported creation failure:** the other agent's release notes describe repeated Market Leader Outreach creation tests with ambiguous Salesforce accounts, lost choice options and cascading `build_batch` failures. This review verified the corresponding source fix, but has not independently tied that other-machine report to an exact local source. Keep that distinction.

**Implemented:** `641b1769` preserves a recoverable capability pause as `needs_choice`, renders account choices, and marks dependent checks `unverifiable`; the unresolved choice prevents the creation test passing. This is progress, not complete choice-to-execution recovery.

**Still open:** `readmitCapabilityBlockedRun` in `src/execution/workflow-runner.ts` writes `status:'running'`. Reusing that path for a creation test could convert a preview into real execution. The current creation-test report promises rebind/retest/enable, but does not itself implement an in-place answer-driven resume. It also says “ready except for one thing” whenever any step needs a choice, which can overstate readiness when independent failures coexist.

Required framework rules:

1. Plan, creation-test/preview, Act and Execute remain explicit modes. Plan may investigate authorized read-only sources; a plan is not permission to perform its future external writes.
2. An explicit revision keeps the plan identity, references the exact prior revision/digest and preserves unchanged requirements. Use the existing `base_ref_json`/artifact machinery in `src/tools/publish-plan.ts` and `src/runtime/harness/plan-artifacts.ts`. A new revision invalidates stale execution references appropriately. Do not add keyword-only revision routing.
3. The current execution path uses exact revision references and `plan_execution_claimed`. Absence of obsolete `plan_approved` events does not prove execution authorization is missing.
4. Account selection binds the chosen identity, not catalog order. Preserve choice-set freshness and immutable admitted definition. Re-test after schema/account/definition changes; do not transplant an old pass onto new bytes.
5. Preserve the original mode across a pause and restart. Answering a creation-test question must continue testing with mutations still previewed. Only an authorized execution may dispatch them.
6. Keep dependency states truthful: an upstream choice differs from a provider failure, an optional lookup, a previewed mutation and a real missing requirement. Report independent failures individually. Optional lookups and their fallback must not both be mandatory graph dependencies.
7. Ensure a response to the choice reaches the exact saved draft/test, binds the account, re-tests and reports the outcome. Auto-enable only under the user's captured activation preference and a pass for the exact current definition.
8. Known batches should iterate deterministically with stable member IDs, pagination/completeness evidence and per-member receipts. Retrying a failed member must not duplicate completed writes.
9. Unknown execution outcomes require reconciliation before retry. Preserve existing external-write authorization and receipt protections.

Acceptance: create a named local workflow, encounter an intentional account-choice fixture, answer it, revise one requirement, test without side effects, execute the authorized version, interrupt after a settled local mutation, resume, and prove one effect per member. Include one independent failed step alongside `needs_choice` so the report cannot imply everything else passed.

### 3. Completion and recovery must use evidence, not optimistic shortcuts

In `src/runtime/harness/objective-judge.ts`, eligible Jev verdicts already return immediately. The fallback added in `4fb26849` reuses a not-done/blocked verdict after it failed the preceding acceptance conditions when the main reviewer is unavailable. Marking this `failedOpen` preserves reporting but does not prevent incorrect retries or stops.

Preserve the rejection reason. A reviewer outage must not promote unsupported DONE, BLOCKED or INCOMPLETE. Identify concrete unmet requirements and recover only those. Distinguish completed work with a verified limitation from a promise to work, a missing artifact and insufficient review evidence. Never coerce incomplete to done based on response similarity. Retained projections must cover their actual source lineage, not clear unrelated incomplete receipts.

The watcher currently records a `bound` escalation without enforcing it. Before enabling behavior, scope repeated findings to the same unresolved problem and current accepted objective; reset on relevant progress. Two unrelated warnings must not stop useful work. Delivery matters: injected-but-undelivered guidance cannot count as ignored. A recovery should change the action or present a precise honest blocker, not repeatedly tell the brain to behave differently.

For zero-progress tools, detect equivalent repeated arguments/results using actual evidence and freshness. Do not impose a blanket tool-call cap on legitimate long research, pagination or polling. Test changed arguments, changed results and worker progress alongside the unchanged-result failure.

### 4. Qualify restart recovery and semantic memory restoration

`69da86a2` adds an interruption-level durable bound after prior reentry exhaustion; `24676b91` tests once-only reconciliation. This addresses a repeatedly resumed old Execute frame, but historical exhaustion does not prove the current checkpoint remains stuck. Add “exhausted → checkpoint progresses → restart” and require current progress identity to prevent false termination. Verify the user’s `continue` makes progress without duplicating prior effects. Avoid absolute “nothing was lost or repeated” wording unless receipts establish it.

The agent corrected earlier historical claims: the acute recovery loop had no counter writer until an earlier fix; the residual restarted process repeatedly renewed its local budget. Do not repeat the old “28% ongoing load” claim as current incidence. Clean SIGTERM frequency is also not proof of a spontaneous bug: distinguish authorized hotpatches, application exits, updates, supervisor actions and actual crashes before changing restart policy.

The embedding startup crash was mitigated by removing eager native loads. The agent reported disabling the local provider temporarily and a local/hosted vector-dimension mismatch leaving lexical-only recall. That is reported history, not a freshly verified current state. Verify actual provider, dimensions, readiness, first-use inference and semantic recall in the installed app. A descriptor reporting enabled or an HTTP response does not prove embeddings work. Preserve old vectors through any future migration and never overwrite the only usable index before validation.

### 5. Optimize measured costs once the above path is reliable

- **Review scheduling:** current `objective-judge.ts` starts Jev and the configured reviewer immediately, then awaits Jev before consuming the other result. An accepted Jev answer leaves the larger request running. Compare sequential fast-first, measured delayed hedging and cancellation. Include after-terminal usage and provider cancellation limits. “Parallel” does not mean free or necessarily faster.
- **Compact evidence:** `f7aca711` favors varying small fields and completes them within budget. A replay retained titles/times in fewer characters, but variation is not task relevance. Constant currency/status/timezone can be decisive; attendee questions need attendees. Preserve task-required fields, identity, pagination, errors and raw retrieval. Test calendar, CRM, nested MCP output, empty results and long records. Compare model-visible wire bytes consistently, not mixed wrapper/payload sizes.
- **Stable prompt/cache structure:** measure before rewriting. Keep stable instructions/schema prefixes stable, dynamic evidence later, and avoid changing timestamps/order/IDs unnecessarily. Compare compatible provider/model/cache states. Cache percentages across unrelated brain and reviewer traffic do not prove a defect or an attainable target.
- **Schema heartbeat:** `src/runtime/jev/active-surface-heartbeat.ts` stages previously used schemas. Verify one in-flight refresh, attempt/time limits, outage backoff, account/schema invalidation and bounded writes. Its current warm limit counts successes, so failures can try more than that limit. Background work still consumes resources. Cached availability is not authority for external writes.
- **Workers:** use smaller capable Grok/GLM workers for independent bounded tasks when delegation saves total cost/time. Send only the objective slice, exact required schemas, relevant memory/evidence, output contract and write authority. Do not fan out a trivial single read just to demonstrate workers; do not remove workers globally because one such run was slow. Verify actual served models and join child usage to the parent.
- **Memory:** store successful method + prerequisites + scope + verification + failures, not every exploratory call as a successful procedure. Require actual delivered/reviewed outcomes before learning. Preserve corrections and supersession; do not turn task instructions into lasting preferences. Show that recalled memory changes a later action usefully, not merely that retrieval occurred.
- **Proactivity:** derive follow-ups from real user goals, relevant changed state and prior authorization. Keep unchanged checks quiet; avoid generating tasks, notifications or model calls to demonstrate proactivity.

## Measurement and acceptance contract

The earlier `no-jev-baseline.json` was contaminated with Jev calls; do not use it as a clean control. Later off/on pairs exist, but task/environment/cache differences and small samples do not establish a general advantage. Claims such as “41% reduction,” “all reviewed turns pass,” or “44% fail first pass” require exact-source denominators and matched conditions. Multiple verdict events are not necessarily independent turns or calls.

For every accepted comparison record: source/session/attempt and child identities; installed fingerprint; actual brain/worker/reviewer model IDs; effective Jev settings; initial tool surface; correctness rubric; time to first useful action and final answer; model critical-path spans; total input/cached/uncached/output and retries; discovery/result-retrieval rounds; user interventions; completed effects and independent receipts. Sum usage, not overlapping durations. Treat uncertified attribution explicitly. Count late/background reviews and failures.

Start with a small bounded acceptance set, then repeat only where changes or variance justify it:

| Case | Required proof |
|---|---|
| Simple known read | Correct answer, one real provider invocation when sufficient, no phantom-result query |
| Unfamiliar/mixed tools | Same-turn discovery of missing native/MCP/CLI/Composio capabilities |
| Long result | Required fields retained or accurately retrieved; no missing-as-zero claims |
| Workflow create/revise/choice | Exact draft continuity, correct account, truthful test report, preview preserved |
| Plan → Execute / Act | Correct authorized mode, exact revision, verified artifact and receipt |
| Reviewer unavailable | No invented success, false blocker or repeated completed work |
| Interrupted mutation | One physical effect, reconciled unknown outcome, safe continuation |
| Recovery after progress | Old exhaustion cannot stop a new advancing checkpoint |
| Memory correction | New-session behavior uses corrected scoped fact; unrelated facts preserved |
| Long task with workers | Correct independent outputs, complete child costs, relevant supervision |
| Desktop/mobile | Same state and recovery options; distinguish served assets from physical-device verification |

The original 50-firm research goal remains an eventual integration scenario: identify well-reviewed California personal-injury firms, discover suitable research/SEO tools, use Apify/Composio where useful and deliver structured Google Sheets data with sources and coverage. First qualify with a small named fixture and explicit batch/cost limit. Do not silently launch the full paid run or reuse a personal sheet as a test fixture. Criteria for “best reviewed” must be stated and evidence-backed.

## Receiving agent's delivery requirements

1. Recheck branch, ownership, current configuration and served fingerprint. State what is already implemented versus merely reported.
2. Reproduce one high-priority failing path with the smallest controlled live fixture; inspect existing source receipts first to avoid wasting tests.
3. Implement a narrow framework correction and meaningful negative/regression cases. Preserve exact revision, account and receipt semantics.
4. Accept it in the installed app/live home. A compiled bundle, pure test or branch predicate replay is insufficient.
5. Deliver a before/after table including correctness and all costs, a file/commit map, rollback procedure, remaining limitations and a clean handoff. Do not mark completion because the turn ended or a reviewer was unavailable.
6. Before a tag, identify the complete candidate diff and verify that acceptance covers all behavior changes bundled into it. Keep unqualified changes out of the accepted release candidate rather than describing them as a proven optimization.

**Immediate next move:** make the remembered calendar path callable and recoverable, then finish workflow choice → exact revision → safe test → authorized execution. Carry completion/recovery correctness alongside those fixes. Only then judge Jev and worker efficiency on matched successful work.
