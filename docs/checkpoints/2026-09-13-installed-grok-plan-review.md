# Installed Grok Plan run — discovery does not converge

## Current disposition

The owner stopped the run. The exact terminal is **200417**, **2026-09-13 14:08:59.767 UTC**, status **cancelled**: “Stopped — this turn was cancelled. Nothing further will execute.” Elapsed time was **24m 7.7s**, with **124 settled attempts**, no published plan and no business writes. The reviewer did not restart or modify this run. `events.json` is complete through that terminal; `summary.json` and `usage.json` retain their explicitly earlier observation window.

This installed connected-tool run is **not a qualification pass**. Earlier successful isolated Claude fixtures remain valid only for their narrower cases. Subsequent repairs and their qualification are recorded in [2026-09-13-plan-continuation-fixes.md](2026-09-13-plan-continuation-fixes.md).

Installed candidate C source fingerprint: `22bd669e3ab6a8a4da266624674e54415956b3df09c6f61c9695401e723787e6`. Installed daemon PID 6767. Session `sess-mob-f4374fb96657c874ac229dd3fc4ddaf6`, accepted source **199225**, accepted at **2026-09-13 13:44:52.063 UTC**. The owner requested a Plan from their Google Doc using Apify and DataForSEO, with a new Google Doc as the eventual execution deliverable. Mobile submitted `taskMode.kind: plan`.

Evidence is under `output/reviewer-monitor/2026-09-13-execute-recovery/installed-grok-plan/`: `events.json`, `summary.json`, `usage.json`, `request-audit.json`. The observer opens the installed SQLite database read-only. The request audit authenticates stored model-request payloads and records only tool-result/schema metadata, not private model reasoning or secrets.

## Confirmed observations

- Grok 4.6 actually served the brain requests. High reasoning was selected for explicit Plan, including both continuations. This is a host effort-selection observation, not a new assertion that the provider honored a particular wire effort field.
- Completion policy captured owner-selected Claude Opus 5 at source acceptance. By the usage snapshot there were **7 served Opus responses**: **5 completed trajectory reviews**, plus two additional auxiliary responses. Do not call all seven completion judges. Of the five trajectory verdicts, four were on-track and one reported drift. The drift was delivered at event **199591**. Four later trajectory checks were unavailable. **Zero final completion judges** had fired.
- The entire source document was successfully returned at **199301**, without omitted fields, clipped strings, or provider truncation. Its brief asks about naming, product/service architecture, pricing, technical strategies, value propositions, and an evidence-backed competitor matrix and opportunities.
- Memory recall and skill retrieval worked. A later `memory_search` supplied unsupported `limit:10`, was refused before dispatch at **199549**, then repaired successfully at **199629**. Do not describe memory as entirely broken.
- At event **200080** (13:59:54.578 UTC), elapsed time was **902.515 seconds**, with **88 settled tool attempts**, **zero business writes**, **zero published plans**, and **no terminal**. These counts exclude mirrored tool events. They do not include the six undispatched calls described below.
- Usage captured around this observation: Grok 23 served responses, 938,337 cumulative input tokens including 266,368 cached; Opus 7 served responses, 561,330 cumulative input tokens with no reported cache hits. The largest served Opus input was 174,522 tokens. These are cumulative request usage, not the unique conversation length or cost estimates.

## What is going wrong

### 1. Known capabilities and findings do not remain easy to use

Authenticated request **3** contains complete schemas for Apify's actor runner and DataForSEO's `api_request`, `docs_search`, and `docs_index`, as well as Google Doc read schemas. Those tool-result JSON bodies are not clipped in the actual normalized model request. The 8,000-character clipping in the activity log is a separate presentation layer: `hooks.ts:117/638`.

Nevertheless, the model repeatedly searches for those same operations and recalls the same already-read Google Doc. At the first continuation, request **10** retains only the recent `docs_index` schema result in its tool-result history. Six generic undispatched-result messages occupy the rest of the recent history. Request **16** still carries all six of those messages while schemas have been reacquired. This supports investigating the active capability/finding projection across condensation and continuation; it does not prove every schema vanished from every possible host store.

Relevant owners: `src/runtime/harness/compaction.ts`, `model-request-provenance.ts`, `dependency-request.ts`, `src/tools/tool-search-tool.ts`, and `src/agents/orchestrator.ts`. Preserve the durable raw evidence. Give the brain a compact current map of selected capabilities, exact schema handles, decisions already made, and the specific unresolved questions. Reacquiring metadata should not substitute for progress toward a plan. Do not solve this by another mandatory stage or a prompt that forces a tool count.

### 2. An internal call boundary tells the model the wrong story

At **199635**, the host hits `tool_calls_limit:64`; **199636** automatically resumes the same source. The source does not die. But authenticated request 10 shows a six-call frame whose every result says another call could not safely proceed, asks for `repair_arguments`, and directs the model to replan. No frame member provides an actual originating argument fault. This is attached to a call-budget continuation, not evidence that all six calls had invalid arguments.

The same source reaches another 64-call boundary at **200065** and resumes at **200066**. The right fix is truthful continuation ownership and results: distinguish an internal scheduling yield from an operation failure, retain/reissue only the unstarted work correctly, and preserve successful discoveries. Do not merely increase 64 or convert healthy progress into a terminal. Inspect the admitted model frame, checkpoint result projection, and budget-resume branches in `src/runtime/harness/host-turn-runner.ts` and `loop.ts`.

### 3. Trajectory evidence grows until review becomes unavailable

Trajectory evidence rises from 59,277 bytes to 416,767, then 457,491. Later unavailable checks carry 566,877, 689,148, 744,983, and 897,870 bytes. Large API documentation, indexes, and unrelated task inventory are entering the same retained-read evidence packet as the actual research brief. Actual served Opus requests reach 159k–174k input tokens.

`startHostWatcherCheck` in `host-turn-runner.ts:3228` requests `sourceSettledReadEvidence(..., omitSuccessfulDiscovery:true)` yet native/provider documentation reads remain in the packet. `watcher-judge.ts:296` requests complete-prompt admission and collapses failures to null. `objective-judge.ts:537/560` has a context-admission check and preserves a reason, but the watcher drops that reason. Context pressure is the leading explanation for the later fast unavailability; the event does not preserve enough detail to certify that as the sole cause.

Fix the evidence roles and review input, not truthfulness: distinguish task evidence from capability documentation and discovery receipts, preserve exact references to all retained data, and include the evidence needed for the specific review. Do not arbitrarily truncate task facts and call the result verified. Carry unavailable reasons into telemetry. Review must remain optional and work with same-provider owner selection.

The drift verdict also said Apify had no retained availability check, despite earlier exact account-backed discovery. Verify that omitting successful discovery does not make the watcher mistake omitted capability evidence for absent capability evidence.

### 4. Prior work becomes an unrelated investigation

The initial prospective packet includes a prior background-task candidate and tells the model to reconcile its child before duplicate work. The run then invokes `check_delegation` without an identifier, lists many unrelated completed tasks, and tries the background ID `bg-mtxgda57-b45f11` through a delegation lookup. It receives “Delegation not found” but both such tool replies settle as succeeded. It repeats this later.

Inspect `projectedIntentionState` / `buildProspectiveIntentionContext` in `src/runtime/prospective-intentions.ts:944/975`, `backgroundProspectiveDefinition` in `prospective-adapters.ts:257`, and the typed background/delegation lookup tools. A relevant old task can inform the proposed plan. A fresh read-only planning request should not automatically inherit a reconciliation prerequisite from an old task. Supply the correct resource type and current status when citing it; retain uncertainty honestly and avoid guessing a different lookup family. This must preserve useful memory and recall, not disable them.

### 5. Selected tool preparation still does not converge

Correction after the authenticated request audit: exact searches for `GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN` **did materialize successfully**, at events **199518, 199804, 199886, 200007 and 200277**, with a selected account and the same valid capability reference `cap:resolved:googledocs_create_document_markdown:definition:6501a94154b822d9361b1dc9`. The earlier diagnosis that this operation repeatedly remained unmaterialized was too broad. Its successful availability did not make the whole planning process converge.

DataForSEO's authenticated request schema was also present early. The remaining distinction is between knowing a generic tool schema and preparing its nested operation: Apify needs an actor identifier and actor-specific inputs; an API carrier needs the selected endpoint contract. Preserve those findings through continuation. Do not widen capability authority or add authoring requirements to fix a falsely diagnosed availability problem.

## Next qualification

First reproduce the two strongest deterministic defects from this preserved run: budget-yield frame results and selected-schema/history retention. Test the watcher with a small task source plus large capability documentation, preserving the source evidence contract while avoiding repeated irrelevant full-document review. Then repeat this real Plan journey with Grok + Opus and review disabled, and follow a ready plan into Execute. Assert actual publication/terminal status, source identity, successful discovery reuse, current memory influence, business writes, delivered judge steering, and unavailable reasons. A successful source read or auto-resume alone is not completion.

No runtime edits or hotpatches were performed during the installed-run observation. The subsequent repair pass is recorded separately; it has not been committed or tagged.
