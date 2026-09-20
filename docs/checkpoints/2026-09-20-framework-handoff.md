# Clementine framework handoff — September 20, 2026

User priority: high intelligence, accurate execution, speed and token efficiency. Memory is a discovery accelerator, never a tool allowlist. Clem must be able to discover and use configured native tools, local MCP, CLI and Composio operations even when they are absent from memory. Maintain current schema/account/effect validation; write policy must not become a blanket read/discovery gate.

## Ownership and running patch

- Shared checkout `/Users/nathan.reynolds/clementine-next`, branch `main`, last checked HEAD `e5a75f5a`. Other Claude agent works in this checkout. Preserve all existing changes and `apps/usage-sidecar`; do not stage or revert the entire worktree.
- Other agent owns UI and final merge. This work is framework-only; no final commit/tag/push made here.
- Installed app `~/Applications/Clementine.app`, live home `~/.clementine-next`, version3.18.17/schema81. Current installed fingerprint `30a87ba1c633a4787d389aa4990c425684a5965fe096bdc3795139ac94d231ad` (supersedes f920aea3; see optional-null correction below).
- User requires installed hotpatch/live-home acceptance. Never run destructive test resets against live home. Pure/read-only retained-evidence checks are distinct from model acceptance.
- Test models restricted to Grok/GLM. Worker configuredGLM4.5Air is actually served asGLM5.3Flash; corrected receipts report the served model. Do not claim exactGLM4.5Air validation. Claude OAuth belongs to Clem; CLI login status is not its authority.

## Framework changes and evidence

1. Exact multi-operation Composio discovery resolves all explicitly named operations and ranks them before result-window truncation. Actual candidate/installed metadata checks passed for APIFY_ACTOR_RUN_GET and APIFY_GET_DATASET_ITEMS. No memory lookup is required to resolve their exact current contracts.
2. Worker model receipts retain provider-reported model metadata rather than labeling a substituted served model with the requested alias. Pure transport/route tests and installed GLM probe passed.
3. workflow_run_status exposes persisted detailed failure reports. Workflow goal review includes compact identities of authenticated successful reads, with full evidence retained by reference. This fixed an opaque creation-test failure and a false missing-read finding without forcing the judge to pass.
4. Fresh reviewed Execute projects older recallable preparation once while preserving exact current request/plan and all new frames. Original recorded request replay fell from163011 to106625serialized task characters. Live event reduced estimated historical context50337→23454tokens. Full original projected Execute saved the correct Space but was cancelled after its third Grok response stayed pending; no cause was established. Do not call that run an end-to-end pass or infer quota/auth failure.
5. Latest patch resolves an exact configured native planning reference directly during publish_plan when no current-source disclosure exists. It derives the actual registry/schema/carrier/variant, uses the existing host-issued disclosure boundary, and retains argument validation. Changed/ambiguous/corrupt existing disclosures are not overwritten. Unknown names, invented effects/variants and forged candidates are rejected. MCP/CLI/Composio discovery paths remain available and unchanged by this native optimization.

Latest code for items4–5: `src/runtime/harness/retained-history-prefix.ts`, its pure test, `src/runtime/harness/loop.ts`, `src/runtime/harness/local-planning-capability.ts`, `src/tools/publish-plan.ts`. Other changes above are recorded in the current-framework-state checkpoint; inspect shared diffs before merging.

## Live acceptance already performed

- Four delegated reads: native file, local CLI, DataForSEO MCP documentation, Composio Drive lookup. All actually executed; host receipts/usage confirm Grok+GLM.213seconds and222692input tokens including84928cached: correctness pass, efficiency not qualified.
- Controlled native workflow read/deterministic aggregation:240rows, A120/14400 and B120/14520. Model-authored initial output-contract error repaired. Installed review-only recheck passed3/3 without repeating workflow execution; historical warning was preserved.
- Original retained Plan→Execute Space passed, with independently inspected dark390×844 preview and matching installed mobile data projection. Paired physical-phone UI not tested.
- Retained synthetic memory inference recovered correct support3814,3815 and distinguished inference from user preference.91seconds; not a broad memory or matched cold/warm benchmark.
- GLM recovery after cancelled write-plan: fresh reviewed Plan54.3seconds, Execute39.4seconds, Grok4.3 verified both. Exactly space_get/get_view/preview once each; no writes, no repeat of saved Space. Native screenshot independently inspected. The smaller recovery branch did not trigger the new history projection; do not use it as proof that the cancelled projected run passed.
- Latest native-plan lookup check: fresh source268659/session sess-desktop-c9288c8df389925bb63df74b directly nominated space_get_view and space_preview. publish_plan returned ready/reviewStatuspassed on its first call, without preliminary tool_search or business execution. Final terminal/usage audit is recorded in the current-framework-state checkpoint and native-plan-lookup-summary.json.

Evidence lives under ignored `output/weekend-harness-2026-09-19/`: rounded-glm-summary.json, rounded-native-summary.json, rounded-memory-summary.json, rounded-space-summary.json, context-space-summary.json, context-recovery-summary.json, native-plan-lookup candidate/installed/build/hotpatch logs, and native-plan-lookup-summary.json. Read summaries before large raw event/model-request artifacts; never dump credentials or full settings.

## Remaining work / limits of the handoff

- No matched speed/token superiority benchmark has passed. Avoid claiming smaller serialized context equals measured provider-cost or latency improvement. Unreturned model requests have unknown usage, not zero cost.
- Full projected write-plan completion, broader recovery reliability, proactive memory learning and paired mobile UI still need evidence. UI acceptance belongs with the UI agent; coordinate at merge.
- Paid50-firm California PI research stays stopped:150rawcandidates retained, three DataForSEO requests totaling$0.09. No Apify run or final Google Sheet. Do not repeat paid requests or automatically restart this task. Existing cancellation consumed its Execute claim; use retained receipts when user explicitly resumes.
- Preserve the test fixtures/evidence for comparison. Pick the next test because of a concrete change or unresolved risk; do not repeatedly rerun the entire matrix.
- Recheck active runs and configured models before restarting or patching. Brain should be restored toGrok4.6 after temporary GLM checks; workerGLM4.5Air/judgeGrok4.3. All fixture session pins changed for tests should be restored too.

## Discovery audit after handoff preparation

Read-only source review confirms memory is not a prerequisite in the discovery paths examined:

- `tool-search-tool.ts` invokes preferred configured sources, then broad provider sources unless an acquired live read or reviewed exact receipt already answers the query. A missing memory match does not return an empty tool list by itself.
- `tool-search-provider-sources.ts` Composio search uses the memory index as ranking hints, then makes a live filtered provider search. Exact operation lookup revalidates current definitions. Weak/tied memory nominations fall through to live discovery.
- The external MCP path resolves an exact current operation or refreshes the connected server's tool inventory and ranks it. This path does not require a stored memory match.
- Native plan lookup derives configured registry/schema contracts independently of memory. It still rejects unconfigured or invented references. CLI coverage in this handoff is the earlier controlled live CLI execution; this source review is not proof every installed binary works.

This is architectural evidence plus the earlier representative live tests, not an exhaustive guarantee that every connected provider/tool is usable. Authentication, unavailable servers and changed schemas remain real runtime dependencies and should produce specific recovery guidance instead of being misreported as missing memory. No additional model calls, app writes, hotpatch or business tests were performed for this review.

## Measured next optimization candidate (not implemented)

`accepted-plan-execution.ts` currently sends the entire prepared structure to the model, including host authority metadata and its execution draft. An offline measurement of the two retained native Space plans found about6798characters could be removed from each ~30700-character structure by replacing verbose native authority metadata with short operation identity and omitting the host-only execution draft. Actual steps, schemas and descriptions were preserved in that hypothetical view. The read-only recovery structure had4902characters of similar overhead.

This is only a native-plan measurement, not a proposed blanket deletion: provider identity/account/verification semantics may carry material information. Any implementation must preserve the immutable full artifact and host validation, assess every consumer of the model-facing plan, and pass real execution/recall acceptance. The schema bodies remain the largest component. See `output/weekend-harness-2026-09-19/plan-bookkeeping-audit.json`. No runtime change or model call was made for this measurement.

Reusable regression coverage now lives in `src/runtime/harness/selected-native-plan-lookup.test.ts`: four passing pure checks for host-issued native contracts, unknown/noncanonical references, missing configuration/invented effects, and schema-change revalidation. It substitutes an in-process observation seam only; no database reset, isolated home, model call, app configuration change or tool execution. Run with `CLEMMY_ALLOW_LIVE_HOME_TESTS=1 node --import tsx --test src/runtime/harness/selected-native-plan-lookup.test.ts`; output is retained in selected-native-plan-lookup-regression.log. This test-only addition does not change the installed hotpatch.

## Performance priorities from completed runs

Consolidated comparable fields (not comparable workloads) are in `output/weekend-harness-2026-09-19/performance-evidence-summary.md` and `.json`. Highest-priority finding: four delegated reads consumed156481brain input tokens versus41202worker input tokens, a3.8×ratio, with six parent searches. Optimize parent context/discovery before assuming still-smaller workers solve total usage. Review accounted for11.2–32.8%of input across the recorded completed cases; preserve its correctness checks while reducing repeated evidence/objective content. These cases have different histories/models/workloads, so their times/token totals must not be presented as an A/B win. Unreturned request cost remains unknown. User's sidecar is unchanged.

## Empty-memory regression evidence

A focused existing pure test passed: `tool-search-own-catalog-rank.test.ts`, test name `empty memory fetches the callable successor instead of dispatching an unmaterialized row`. It exercises the actual search broker with injected provider metadata and publication: an initially deprecated Outlook operation causes an exact lookup of its current successor, whose schema-backed candidate receives the mocked publication reference. No stored nomination is supplied. This verifies broker fallback behavior, not real authentication, real authority issuance, or external execution. Log: `output/weekend-harness-2026-09-19/empty-memory-successor-regression.log` (1 passed). No runtime edits or model calls.

Also inspected existing `composio-bounded-live-search.test.ts`: it explicitly checks that provider-returned read and write operations absent from its seeded memory remain discoverable, while a memory-only nonexistent operation is excluded. That fixture resets its own isolated home; it was **not run** and is not live-home acceptance evidence. Remaining cold-discovery acceptance should record that a selected operation was absent from the live capability index before discovery, then verify its actual installed-app execution receipt. Do not clear the user memory to simulate this.

## Live cold-fixture selection audit

Read-only live per-machine index inspection found active entries for all four configured DataForSEO top-level operations: docs_index, docs_list_sections, docs_search, and api_request. The installed server package also confirms the three documentation tools plus generic API transport. Therefore another documentation call must not be reported as discovery of a top-level operation absent from memory. No memory was cleared and no model/provider call was made. Evidence: `output/weekend-harness-2026-09-19/cold-mcp-fixture-audit.json`.

Distinguish two acceptance cases: (1) discover and execute a connected top-level operation absent from the capability index; (2) use documentation to discover an unfamiliar endpoint behind an already-known generic API transport, then execute that endpoint with its documented schema. Case 2 matters for DataForSEO coverage but does not substitute for case 1. A never-used tool can already be present in the provisioning-derived index; absence of a usage receipt alone does not establish absence from memory. Preserve the pre-discovery index observation and actual execution receipt for whichever case the next agent tests.

## Installed Composio metadata and ranking check

Two bounded metadata-only lookups for `Apify read actor build log` completed in2232ms and2060ms through the installed provider source. The live index held2010active Composio identities; all20returned identities were already present. This did not produce a naturally cold fixture. Intermediate source results unexpectedly led with SLACK_FIND_USERS, but feeding those actual returned candidates into the installed tool-search broker correctly ranked APIFY_ACTOR_BUILD_LOG_GET and APIFY_GET_LOG first; all eight visible results were Apify, with no delete/abort operations on that page. This rules out the suspected final-ranking defect for this query; do not change ranking based solely on raw provider-source ordering.

No model or business tool call, no authority publication, no memory deletion, no app configuration change. Discovery can refresh metadata caches. Evidence/helper: `output/weekend-harness-2026-09-19/cold-composio-metadata.json`, `.log`, and `check-cold-composio-metadata.mjs`. The broker check reuses the returned candidate array; it is metadata integration coverage, not a model-driven execution run.

## Final model-context refinement and live acceptance

Implemented a deliberately narrower refinement than the hypothetical bookkeeping removal: `reviewed-plan-model-view.ts` omits only five recognized64-character local-registry validation hashes from the model-facing prepared bindings. `accepted-plan-execution.ts` uses that view. Full immutable artifacts, account/effect/destructive semantics, descriptors, tool names, schemas, exact arguments, source identities, steps and executionDraft remain intact. Provider identities and unrecognized versions/values remain unchanged. Inspection found executionDraft presence controls Execute instructions in orchestrator, and its topology/evidence carry semantics; do not remove it wholesale. Two pure regression tests pass, including artifact immutability and preserving digest-shaped business data.

Three retained four-binding plans each lose1780serialized characters; this is a context-size measurement, not a provider-token or latency A/B claim. Build and installed hotpatch passed. Current fingerprint f920aea33e5669a316ac608aa0b21e85f08b0719ce1b31794f874b0647b606cb, version3.18.17/schema81.

Live Execute source268699/session sess-desktop-c9288c8df389925bb63df74b consumed the previously ready read-only plan-c03d0882-d49c-4aee-b361-19f5ec8a4844 revision1 digest4278a79d5db731ccf86d5d61eacd26eb1ab91596fb8ed65473132786c0a0bfff. Completed38.294seconds: space_get_view and space_preview once each, no writes/searches. All three actual archived model requests contain the projected two-binding structure, preserving steps, schemas and null read-only draft. Grok4.3 verified/fulfills review; independent captured-image inspection confirms Native tools and Memory scope both Pending, legible at dark390x844. This does not close the earlier full write-plan acceptance gap or physical-phone UI acceptance.

Actual usage: GLM5.3Flash3calls55949input17216cached519output; Grok4.3judge1call10569input192cached23output. Total66518input including17408cached. No Claude/Codex test calls. Grok4.6 restored globally and test-session pin; no active foreground runs at terminal audit. Paid research still stopped. No commit/tag/push, UI/sidecar untouched by this change. Evidence: model-view-execute-summary/events/usage.json, model-view-request-audit.json, model-view-execute-preview.png, reviewed-plan-model-view-test/build/hotpatch logs and replay.json under the output directory.

### Model-context refinement: local write-plan acceptance

Installed f920aea3... also passed a fresh GLM Plan→Execute with one controlled local Space creation. Session sess-desktop-2ad32ad617c9f0ab6eca3cfa, Plan source268753 completed62.600s; Execute268803 completed59.033s. Plan75af84a3-354f-4b65-b9a1-c4f1d714143a revision1 digest4e56a48807ae82a88bb28d5fa00f02f9db2761cbf3aa64745b10f9e603bead36. Grok4.3 verified/fulfills both. Exactly one actual space_save and one actual space_get; plan_task{} activated the intact saved draft, and plan_step_result recorded compute completion. All six archived Execute requests preserve the exact three steps/write draft and schemas while omitting local validation hashes. Independent live files confirm framework-model-view-write-1789943386115 at version1, createdAt==updatedAt, records exactly[{marker:verified}], empty sources/actions. Grok restored globally and fixture pin, zero active runs at terminal audit.

Efficiency still incomplete: Plan searched once then repaired an invented id key using publication patching. Execute initially added limit:null and offset:null absent from approved arguments; exact-call validation refused before dispatch, and Clem repaired its call. Optional-null equivalence is a concrete next candidate to investigate against the actual native handler/contract; never blanket-allow argument drift or drop meaningful provider nulls. Plan usage GLM3calls61645input16320cached2088output plusGrok judge2calls17974input832cached49output; Execute GLM6calls170322input66432cached875output plusjudge1call16684input192cached21output. Cached counts included in input.

Evidence model-view-write-summary.json, per-phase status/events/usage, retained plan-artifact.json and model-view-write-request-audit.json under output/weekend-harness-2026-09-19. This closes write-path acceptance for the hash-only model projection, not the earlier cancelled long-history execution or a matched token/speed benchmark. No runtime changes this turn; no paid research restart, no Claude/Codex tests, no commit/tag/push.

### Optional-null correction, installed30a87ba1

Root cause confirmed: ordinary reviewed-step comparison required byte-identical object keys, while reviewed collection-member comparison already accounted for the native args_json adapter filling omitted nullable properties. Unified that existing local-only normalization through reviewed-local-null-arguments.ts and used it in both reviewed-plan-runtime.ts comparison paths. Only actual nulls for named schema-nullable properties absent from the approved expected object are added to the comparison view. No stored plan mutation, provider normalization, non-null default guessing, unknown-field allowance, or overwrite of approved values. Actual call authority/schema/account and host dispatch checks remain.

Two pure tests pass. Exact retained rejected call268847 reproduced the failure on the prior installed code, then passed candidate and newly installed gate replay against the actual live-home reviewed plan/source268803. A changed slug, limit21 and unknown:null still refuse. Installed materializeLocalRuntimeToolArguments independently returns identical prepared args for the observed omitted-versus-null forms; no handler/business dispatch was invoked. This is precise production-gate and adapter validation, not a new end-to-end model run. No model tokens or repeated writes spent.

Build/hotpatch passed; installed version3.18.17/schema81 fingerprint30a87ba1c633a4787d389aa4990c425684a5965fe096bdc3795139ac94d231ad. Grok4.6 brain, configuredGLM4.5Air worker, Grok4.3 judge verified after restart. Prior live read/write acceptance remains evidence for preceding hash-only patch, not a claim that this exact build has completed a new model run. Logs/checker under output/weekend-harness-2026-09-19/reviewed-local-null-*. No commit/tag/push, paid research remains stopped.
