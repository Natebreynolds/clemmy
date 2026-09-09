# Slimming the harness around the owner's job

Owner-requested direction after the Salesforce-to-Sheet failures. This extends the [targeted recovery correction](/Users/nathan.reynolds/clementine-next/docs/checkpoints/2026-09-07-sheets-recovery-steering.md). Implementation retains the live window and integration ownership; the reviewer monitor stays paused.

**The aim is fewer decisions for Clem to negotiate with the host, while preserving precise execution checks.** A multi-tool task is not inherently a planning ceremony. Ordinary conversation should be able to read, inspect, correct, ask a genuine question and continue. Promote work into a durable graph when dependencies, independent workers, waiting or recovery benefit from it; explicit user Plan remains an inspectable mode with exact Execute.

Do not translate this brief into another universal planner, extra approval layer, English intent grammar or a replacement harness. Consolidate the existing production paths and retire superseded ones in the same change. Keep native Workflows, Spaces, full tool contracts, source/account boundaries, Stop and evidence-based completion.

## What the retained runs actually establish

Source 144363 took 469.828 seconds and recorded 35 top-level calls: 19 Salesforce reads, 8 searches, 4 prior-result retrievals, 2 memory recalls, a session search and a progress update. Source 143751 logged 59 calls, including 13 searches, 28 Salesforce reads and 10 prior-result retrievals, before its driver cancelled at 15 minutes. Source 146042's Plan run blocked after a progress-note refusal and two locally refused follow-up reads.

The initial host prompt estimate for 144363 is 15,918 tokens: 9,882 tool-schema tokens and 3,002 memory-context tokens. These are instrumentation estimates, not verified billed tokens or proof that every schema is waste. Its recorded condenser collapsed ten tool pairs, reducing an estimated 39,895 tokens to 21,487. That transition is not established as the terminal cause. Tool-return event strings include clipped previews; summing their sizes would not measure full provider results.

The demonstrated stopping bugs are in the targeted brief. The areas below are simplification priorities supported by those traces and bounded source inspection; proposed performance improvements still need measurement.

## 1. Give ordinary execution and recovery the same view of the job

Today the mode check, registry, capability-resolution projection, dispatch and recovery can disagree. In the Plan failure a reviewed Salesforce read executed successfully twice but disappeared from recovery's available carrier set because a separate resolution inventory contained only Google Sheets writes. A host-only progress note was exposed, refused, then recommended as recovery.

Derive the model-visible tools, mode restrictions and recovery choices from a consistent current view of accepted work and available capabilities. Reuse the existing durable records and exact execution boundary. The view should carry the effective objective, adopted corrections, mode, resource/account identity, settled results, unfinished work and lifecycle. It is a projection of existing truth, not a new source of permission.

When an edge check refuses an operation, return the specific constraint and an actually available next action. Do not let downstream governors reinterpret that result into a contradictory story. Typed reads and permitted progress conversation should survive a recoverable refusal. Business writes in Plan still wait for exact Execute.

**Proof:** ordinary and recovery routes agree on the same source-bound read; Plan progress → read → publish succeeds with zero business writes; an actual prohibited write remains prohibited. Name which old projections/branches were removed or unified, not merely the new exception added.

## 2. Stop making Clem rediscover tools and accounts she already resolved

The runs repeatedly search for Sheet creation and updating, sometimes returning unrelated local tools. The second Normal run gets an update capability reference, then later receives an account-selection requirement for that operation. This needs an exact source/account/revision trace, not an assumption that every repeat was unnecessary.

Provide authoritative exact-name lookup alongside semantic discovery. A known slug should resolve its current definition or a clear absence; do not bury it in a fresh broad ranking. Keep complete schema retrieval distinct from discovery and make paging/reassembly host-managed where the existing carrier can do it reliably. A small initial catalog must never make the full schema inaccessible.

Reuse an established account selection while its source, principal, relevant owner amendments and live connection identity remain valid. Recheck changed facts, not the same unchanged choice on every search. `source-account-routing.ts` already has an in-memory judgment cache: inspect misses, subject changes and persisted evidence reuse before adding another cache. Do not cache across a real owner/account change or fabricate a source quote. A configured same-provider or review-off user must retain an honest supported path; internal semantic routing is not the optional completion-review toggle.

**Proof:** repeated exact lookup within one task produces the same usable operation/account binding until a relevant revision changes; a real account change invalidates it. Report discovery, schema retrieval and account adjudication separately. A necessary schema-page read is not another failed tool hunt.

## 3. Make errors useful to the brain instead of promoting them into terminal policy

The Normal run received a concrete read-query rejection, but its carrier/settlement reduced it to `unknown`; recovery chose a factual stop while the budget still recorded two retries remaining. A different read could have been attempted without repeating a write.

Carry structured outcomes end to end: successful result, argument/query rejection, missing capability, missing authorization/input, transient read failure and uncertain effect must stay distinct. Preserve a useful diagnostic and access to its full evidence. A small display preview must not be the only surviving recovery instruction. Repair the underlying argument or choose another authorized read; keep successful sibling results.

Use a shared typed outcome through adapter, settlement, recovery and final response. Do not solve this with provider-error prose parsing in the authority layer or a blanket “all errors are retryable” rule. Unknown write effects still require reconciliation.

**Proof:** a real carrier-shaped bad query → useful model-visible diagnosis → corrected query → continued task; an uncertain write cannot take that repair shortcut. A negative result in one parallel read does not discard the successful reads.

## 4. Make fetched data a reusable working dataset

Large escaped CLI JSON, raw result replay and repeated recall can make a small business dataset expensive to use. The traces show condensation followed by retrieval; they do not prove data loss, nor that every repeated query was redundant.

Keep complete raw evidence durably addressable, while exposing a concise typed result: columns, row count, coverage, stable row/entity IDs, errors and an exact handle for the records. Let existing query/table operations filter, join and aggregate that retained dataset. Avoid asking the model to repeatedly reconstruct a 30-row account join from scattered transcript snippets or query Salesforce again for data already available.

Retain the active task's working facts through compaction: selected account, discovered schema references, requested criteria, candidate row IDs, verified results, unresolved fields and next dependency. Preserve exact values needed for the write; summaries must not replace authoritative data. Readback and digest comparisons should use exact records or artifact bytes outside the prompt.

**Proof:** after a forced context transition or restart, the same dataset produces the same rows and intended cells without repeating settled reads/writes unnecessarily. Include incomplete pagination, ambiguous matches and missing communication data. Do not claim missing rows are absent merely because an early query returned fewer than requested.

## 5. Keep transport bookkeeping out of the model's job

The model currently has to navigate nested carrier names, capability selectors, JSON serialized inside JSON and nullable transport fields. The Plan repair frame used string `"null"` for several nullable fields. That was not the observed surface-mismatch cause, but it is a separate avoidable failure opportunity.

Derive model-facing schemas/examples and host serialization from the actual callable contract. Where the host already knows source identity, a disclosed capability reference or a fixed transport wrapper, attach that deterministically rather than asking the model to reproduce it. The model supplies business arguments and chooses among genuinely different resources/actions. Preserve a single strict canonical call at dispatch, with exact schema/argument/account checks and a durable mapping to the model's request.

Do not silently guess missing business arguments, select another resource or widen scope. Complete the five-carrier audit and remove stale handwritten invocation examples rather than adding another corrective paragraph to the prompt.

**Proof:** the same operation produces the same canonical arguments through every supported carrier; ordinary calls do not fail because of host-generated nulls/IDs/wrappers; genuinely invalid business inputs receive a useful repair.

## 6. Let useful work continue; bound repetition by what repeated

Novel capability discovery is not the only form of progress. Reading another page, resolving a row, correcting an invalid query and consuming a retained result can all advance the job. Tool count alone should not force Plan or terminate productive work.

Keep one continuation owner and retained progress state through save/adopt/resume. Consolidate repeated no-progress and recovery decisions around actual state transitions. Distinguish unchanged failed attempts from a new diagnosis or repaired argument, and from useful evidence consumption. Keep a loop detector and practical cancellation/resource controls, but make their reasons and accounting accurate. An exhausted external test deadline is not a product-level proof of no progress.

Use bounded parallel reads after prerequisites are known, deterministic joins and resource-serialized writes. Make existing worker primitives available where configured and suitable; do not require subagents for a simple query or graph promotion for every extra tool. Investigate the observed `run_worker` discovery detour without claiming its absence caused the terminal failure.

**Proof:** useful multi-step work progresses across a held continuation; a genuinely repeated failure stops honestly; Stop cancels the correct task; settled effects are not replayed. Judge/no-progress counters survive adoption and obsolete work cannot continue after terminal.

## 7. Reduce unnecessary model overhead with a measured purpose for every call

The run report contains main and Opus usage, but a usage row or model name alone does not establish purpose, latency or accepted completion judgment. The initial prompt estimate also suggests auditing whether tool/control schemas and memory context are duplicated or irrelevant. It does not justify arbitrary schema truncation.

Inventory each model call by purpose: main reasoning, account selection, semantic interpretation, watcher, completion review or learning. For each repeated decision, explain what new fact required it. Reuse still-valid decisions and remove duplicative adjudication. Deterministic schema/hash/lifecycle checks should remain code where they already suffice. Use semantic judgment where meaning actually requires it, with the owner's selected provider policy and honest unavailable outcomes.

Keep optional completion review at meaningful deliverable boundaries rather than using it to compensate for broken tool admission. Review feedback can identify a missing requirement or framework mismatch and guide a bounded repair within the accepted job. It cannot grant permission or endlessly restart completed work. Avoid replaying unchanged full evidence when an exact durable artifact/dataset comparison suffices.

Make memory relevant to the task: retrieve the applicable owner procedure and corrections, retain provenance and scope, and fetch deeper history when needed. Distinguish general owner instructions from prior one-off campaign criteria so recalled context does not silently change today's request. Do not remove memory to make token counts look smaller.

**Proof:** compare the same real scenarios before/after with identical model configuration and case expectations. Measure successful task outcomes, interventions, corrected-error recovery, searches, schema fetches, repeated reads, main/auxiliary calls, actual usage and wall-clock critical path. Pair timings by request/call identity and account for overlapping spans; subtracting a naive sum of interleaved dispatch times does not measure host overhead. Event counts are not database latency. Preserve audit records unless profiling and equivalent coverage justify a storage change.

## How to deliver the correction

First finish the two demonstrated stopping paths and capability/account continuity. Then simplify the carrier/data path and measured duplicated model/context work. Complete continuation and exact Plan/Execute in the same release program. This is an ordering of connected changes, not permission to mark untouched requirements complete or keep producing tiny candidate handovers.

For every simplification, report: **which repeated decision or conflicting path was removed; what authoritative state remains; what regression proves the old path fails and the new path works; and the live outcome.** Prefer shared production boundaries over per-tool/per-provider exceptions. Include a non-Salesforce read→join→write case so the solution is not a special script for Tim's accounts.

The immediate acceptance case is still the owner's actual request: resolve Tim and the correct prospect list, verify the requested inactivity/last-communication criteria, gather domains and activity, create the authorized Sheet, read back exact cells and explain any shortfall. Separately prove explicit Plan → owner revision → exact Execute. Progress updates, genuine clarifications and corrections must remain part of the conversation throughout.

Judge the change by correct finished work and fewer avoidable turns—not lines deleted, an artificially small prompt, a larger timeout or a different model hiding the defect. This is how a slimmer harness moves toward the Clem North Star while retaining dependable execution.
