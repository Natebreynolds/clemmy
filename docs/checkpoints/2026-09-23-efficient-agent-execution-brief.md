# Clementine: efficient everyday work without losing intelligence

Evidence-based execution brief for the active harness agent. Written September 23 PT / September 24 UTC, 2026. This supplements the existing release handoff; it does not replace its open gates.

## Objective and boundaries

Make familiar work take the shortest verified path while unfamiliar work remains discoverable and complex work retains plans, memory, approvals and execution receipts. Reduce user repetition, time to useful output, total model rounds and uncached tokens. A large context window is capacity, not an operating budget. Cached context still consumes time and money. Accumulated conversation history remains a harness responsibility.

Work through existing routing, capability, memory, execution and accounting mechanisms. Do not add another planner, another memory authority, provider-name branches or prompt-only fixes. No regression can be guaranteed by assertion: demonstrate the relevant invariants and state remaining uncertainty.

User approval for an external effect and the user's explicit Plan-mode review must remain meaningful. Removing redundant internal gates is not permission to remove human-in-the-loop workflows. An exact previously approved execution may activate without another model decision; an unapproved plan may not.

Keep work in the existing harness worktree, preserve the other agent's edits, and do not tag or merge without the existing release procedure. This brief was added as a document only; its author made no runtime changes or live calls for this review.

## Current source and evidence

At writing:

- Worktree: `/Users/nathan.reynolds/clementine-next-harness-3-19`, branch `harness/3.19`, clean before adding this document.
- HEAD: `fcacf2b2ebc23e38b5b345b2c62dda070d2b63c6`, latest checkpoint commit.
- Installed daemon: `d8362bf691bb5783c938fc71bd154e9deb1f36b7`, fingerprint `ed7098034e2a830204f8e271efdd1a5ecc0387c4058f446d9aa105d05204abbc`, PID 88701, schema 81.
- Main remains a separate checkout. Recheck current state before editing or hotpatching; these identifiers will age.

Primary evidence: `docs/checkpoints/2026-09-24-harness-takeover-prefix-stability.md`, especially sections 6–7. Its live measurements are the implementing agent's recorded evidence; this review inspected the code and served build, but did not independently rerun those tasks. Use the named source receipts to verify each claim.

| Source / scenario | Wall | Brain frames | Largest prompt | Uncached tokens | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 293703, heavy-session status before fixes | 282.4 s | 5 | 121,449 | 295,037 | Incorrect: said Space held nothing |
| 293870, same heavy session after history changes | 79.6 s | 3 | 44,705 | 91,252 | Correct five records and caveats |
| 294013, history plus planning-schema changes | 42.2 s | 3 | 48,801 | 90,722 | Correct table with four fields |
| 293783, earlier fresh-session status | 70.1 s | 5 | 20,214 | 83,775 | Correct status per checkpoint |

These observations support a substantial improvement in this scenario. They do not establish a general benchmark win: the initial answer was incorrect, several fixes intervened, cache/provider conditions can vary, and these are individual runs rather than repeated matched cohorts. The 79.6→42.2 s difference with nearly unchanged uncached tokens especially requires latency attribution before assigning the whole gain to one patch.

Additional recorded facts:

- Heavy history was 886 KB: 451 KB prior reasoning, 288 KB old tool results. Large-window compaction had not fired.
- Source 293870 condenser: 121,374→21,551 estimated tokens, 47 results clipped, 72 pairs collapsed, no Layer 2 summary.
- Original pilot `trigger-cbba991a` completed with five canonical records and provenance. Recurrence remains inactive and requires separate approval.
- Source 294013 repeated two reads whose complete results were already present. The identical-call guard was advisory.
- No `proven_operation_selected` appeared for that repeated status question. The latest checkpoint attributes this to retrieval turns not recording learned strategies. Verify the recorder's exact eligibility before implementing the fix.
- The earlier Together 402 cleared per the implementing agent's checkpoint. Do not continue presenting it as an active blocker without fresh evidence.

## Existing architecture to extend

The relevant path already exists:

```mermaid
flowchart LR
  A[Accepted user request] --> B[Relevant memory and proven strategies]
  B --> C[Direct match or bounded Jev selection]
  C --> D[Validate current schema, account and callable capability]
  D --> E[Small first-turn context and exact tool surface]
  E --> F[Brain chooses arguments or answers]
  F --> G[Shared tool kernel and effect authority]
  G --> H[Settled result and durable receipt]
  H --> I[Answer or next planned step]
  I --> J[Learn verified reusable strategy]
  D --> K[Bounded discovery when evidence is missing]
  K --> E
```

| Responsibility | Existing implementation |
| --- | --- |
| Before-first-model strategy preparation | `src/runtime/harness/loop.ts`, `prepareProvenOperationForRequest` call before agent construction |
| Strategy selection and current-operation publication | `src/runtime/jev/proven-operation.ts` |
| Bounded Jev selection | `src/runtime/jev/control-plane.ts`, `selectProvenRunStrategyWithJev` |
| Strategy storage/learning | `src/memory/run-strategy-store.ts`, `src/runtime/harness/host-run-strategy-learning.ts` |
| Tool promotion and model surface | `src/agents/orchestrator.ts`, `provenDisclosure`, `resolveHotSet`, `resolveToolSurface` |
| Live capability validation | Capability catalog, resolution, manifests and proof-provisioning modules under `src/runtime/harness/` |
| History reduction | `src/runtime/harness/compaction.ts`, `budget.ts`, caller in `loop.ts` |
| Execution, tool results and recovery | `host-turn-runner.ts`, shared call/settlement/checkpoint modules |
| Explicit usage roles and measurements | `src/runtime/usage-log.ts`, `scripts/measure-source-turn.mjs`, `scripts/measure-prefix-drift.mjs` |

The inspected proven-operation function explicitly provisions Composio operations and promotes eligible native tools. This alone does not establish equivalent warm-start behavior for all MCP and CLI operations. Demonstrate those paths; if incomplete, extend the common capability mechanism.

Jev selects among relevant candidates; it must not invent executable schemas or grant authority. Direct confident matches need not incur a Jev call. Memory may suggest an account, but the host must validate that it is still connected and matches the user's scope.

## Work package 1 — close the retrieval learning loop

First trace why successful retrieval does not produce a reusable strategy. Extend the existing recorder rather than building a parallel store.

Record only supported successful behavior: accepted objective, actual effective operation identities, resolved account scope, schema/version references, necessary dependencies and settled outcome. Parameterize time, entities and identifiers; never store today's dates, result rows or a particular person's data as universal arguments.

Exclude unresolved/failed-open completion, partial work represented as complete, guessed operation identity and failed tool attempts from success promotion. A model saying “done” is not sufficient evidence. A useful partial strategy may be retained only as explicitly partial, without suppressing discovery for the rest of the request.

For “What's on my calendar today?” the warm path should supply the current calendar-read operation, schema or executable binding, resolved account, timezone and current date interval before the brain's first tool decision. It should not inject a transcript of earlier calendar sessions. Multiple accounts require the existing explicit/default account policy, not an arbitrary cached choice.

Acceptance:

- Cold run discovers and performs the read correctly.
- Warm paraphrase uses the learned operation with zero model-driven discovery calls when the live binding is valid.
- A compound request, such as calendar plus drafting a follow-up, does not lose the additional capability because a calendar strategy matched.
- Account disconnect, schema drift, provider removal and daemon restart recover through current validation/discovery without executing stale bindings.
- Prove native, Composio, MCP and CLI cases using controlled read-only fixtures. Do not silently generalize from calendar alone.

## Work package 2 — stop repeat reads without fabricating freshness

Source 294013 supplies a concrete regression shape: identical reads repeated despite complete retained results. Pin that shape first.

Use an exact resolved-operation identity, account, normalized arguments, source and relevant version/state identity to decide whether a settled read can be reused. Reuse only when the tool's semantics and freshness policy permit it. Invalidate after relevant writes, explicit refresh, changed parameters/account or known state/version changes. Polling a changing run's status is not equivalent to rereading an immutable artifact.

Return the original retained result and provenance through the existing result/settlement mechanism. Do not mint a second provider crossing or pretend a fresh observation occurred. Unknown or unavailable prior results require honest recovery.

Important accounting distinction: answering a duplicate tool call from retained data can save provider I/O, but the brain frame that requested it has already been spent. To reduce brain rounds, make the prior evidence and completed status clear before that frame. Measure both effects separately.

Acceptance: an eligible duplicate performs one physical read; a write-then-read sees changed state; an explicit refresh reads again; two accounts never share cached results; restart preserves exact provenance; status polling still observes a new terminal. No general suppression of reads based on matching tool names alone.

## Work package 3 — prove compact state preserves the job

Keep the new separation between context-window safety and operating cost. `layer1CompactionBudgetForModel` now caps its budget at 200k, with the default 0.3 trigger giving a 60k pressure threshold for large-window models. This is a clipping trigger, not a guarantee that every request fits 60k: retained recent results, schemas and other layers still contribute.

The working context should include the current objective, user corrections, active plan/revision, completed steps, pending approvals and unresolved dependencies. Older evidence should be reopenable by stable references. Do not introduce a competing source of truth for these fields; project existing durable records.

Do not call reasoning deletion universally lossless merely because reasoning items disappear from a unit fixture. Establish that required decisions survive in authoritative state and that active provider frame-chain requirements remain satisfied. Inspect all compaction callers, including goal-stage checkpoints and continuation/restart paths. Prior completed-turn reasoning and in-progress tool-chain state are different cases.

Required continuity pin and installed-app scenario:

1. Accept a multi-step plan with a specific user correction.
2. Complete one controlled write and retain its receipt.
3. Leave a second effect awaiting approval.
4. Trigger history reduction and restart.
5. Recover the exact selected plan and correction, show the pending decision, and perform no duplicate first write.
6. Approve only the pending effect and verify exact final records and completion evidence.

Test retrieval of an old clipped result as well as the absence of unnecessary retrieval when recent evidence is already sufficient. Include a stale-memory correction in a later session.

## Work package 4 — measure the entire fast path

The current code caps Jev strategy selection at two seconds and has a ten-second provisioning budget. `publishCachedProvenOperations` can call `ensureToolSchema` before the later provisioning deadline is established. Audit the entire preparation chain, including cancellation and refresh, rather than assuming the named budget bounds every awaited operation.

Instrument: strategy lookup, Jev time, schema/cache validation, account resolution, provisioning, agent assembly, first provider byte, tool work, completion review and final delivery. Separate one-time cold work from repeated warm work.

On a valid warm match, avoid unnecessary provider enumeration or schema reload. Background refresh may help when existing freshness rules permit it, but never let stale memory authorize effects. When preparation fails or times out, preserve normal discovery and cancel/contain abandoned work; do not add a long wait and then charge the user for the same discovery again.

Use the newly explicit brain/worker/reviewer/router roles for accounting. Keep unknown attribution visible. A costlier model is not automatically the brain, and fewer tokens do not imply lower wall time.

## Work package 5 — consolidate planning carefully

The latest dependency trace establishes that `plan_task` still activates expected-work contracts for some foreground, Execute-mode and worker paths. It is not safe to delete solely because Plan mode exists. Native workflow/Space authoring does not depend on it according to that trace; verify callers when changing this boundary.

Potential narrow improvement: let the host activate the exact user-selected reviewed revision in Execute mode, eliminating a model round used only to repeat that decision. Preserve revision binding, consent lineage, restart behavior and the shared execution contract. Invalid/stale revisions must remain refusals, not automatic substitutions.

Broader consolidation into the typed action path and retirement of barrier/coexistence code should be separately reviewed work. Do not make a large planning rewrite a surprise dependency of this tag. Keep the on-demand schema change compatible with both paths until parity is proven.

JIT acceptance must include a turn that starts as retrieval and legitimately develops into planning. A deferred tool must remain discoverable with its exact current schema; loading a schema must not require repeated searching. The current fallback advertises deferred tools when acquisition doors are absent—preserve reachability.

## Acceptance and measurement contract

Suggested shape targets below are acceptance proposals, not claims that the current harness meets them or universal hard execution caps. Agree on them using observed task requirements; never terminate legitimate work merely to meet a benchmark number.

| Scenario | Required result | Efficiency target |
| --- | --- | --- |
| Warm calendar today, one resolved account | Accurate time range and events | Zero model discovery; normally one tool-selection frame plus one answer frame |
| Same task in aged conversation | Same accuracy, relevant corrections retained | History growth alone does not cause discovery or repeated reads; materially smaller request than pre-fix baseline |
| Unknown read-only MCP/CLI operation | Correct discovery, arguments and read | No repeated unchanged search; count every metadata and model step |
| Changed schema/account | Current valid binding or precise missing choice | One bounded repair path, no stale execution or endless discovery |
| Plan → approved execution → restart | Exact plan, no repeated completed effects | No model frame solely to restate an already accepted revision, if host activation is implemented |
| Approval workflow | Visible decision and exact authorized continuation | No duplicate dispatch from repeated taps/resume |

For each accepted source preserve: source/session IDs, served build fingerprint, effective models and roles, expected answer, independently checked result, terminal, physical crossings, model requests, schema/discovery calls, repairs, input/cached/uncached/output tokens, largest prompt, elapsed time and time to first useful content. Include routing, judge and recovery work. Use provider invoices only for actual billed amounts; label price-based estimates.

Use the existing measurement scripts after inspecting their arguments. Record prompt-layer bytes/digests instead of dumping private prompts. For live SQLite reads use read-only mode that sees the WAL; immutable mode can miss current events.

Start with one diagnostic pair. Once correct, run a small repeated matched set (at least three per case where affordable), with fixed model/task conditions and explicit cache/age conditions. Report individual results and medians/ranges; do not claim a reliable p95 from three samples. Never use a failed or easier task to advertise a general efficiency percentage.

## Before-tag order and stop conditions

1. Preserve the original pilot's completed evidence. Do not rerun it merely to regenerate a happy-path receipt.
2. Close retrieval learning and the repeated-read regression with focused red/green checks, then installed-app acceptance.
3. Prove continuity across reduction and restart before expanding compression or retiring planning mechanisms.
4. Run the matched cold/warm/aged measurements and investigate the remaining dominant latency component.
5. Complete the existing release gates independently: mobile approval/repeated tap, mutation crash matrix, reviewer availability, unfamiliar tools, remaining test debt, idle-machine full suite/journeys and installation/upgrade checks.

Stop promotion if results become incorrect, required evidence cannot be recovered, the selected account changes, a write repeats, an approval is bypassed, or memory suppresses discovery for uncovered work. Keep rollback and report the failing source. Do not add rollout flags or exceptions simply to make acceptance green.

Use the exact installed app path and approved Terminal hotpatch recipe, coordinate with the UI owner, verify idle execution before quitting, preserve backups, sign and verify, then check served build-info. Build again after commits because HEAD/docs/scripts/src affect the fingerprint. Never aim destructive fixtures at the live home. Use the owner's currently authorized generative provider; do not infer fresh authorization from stale checkpoints. No unsolicited Claude/Codex model tests.

## Deliverables to the owner

- Concise change explanation tied to observed failure/cost, with a reproducing test and exact implementation paths.
- Installed build and rollback receipt.
- Matched measurement table with correctness, all model roles and physical effects.
- Continuity/approval/replay evidence.
- Open gates and unverified claims, stated separately from completed work.

The desired product behavior is simple: Clem remembers how to help, prepares only what this request needs, acts through current tools, keeps the user in control, and reports what actually happened. The tag must be supported by that behavior—not by the number of architectural components added.

## Copyable instruction

Read this brief and the latest takeover checkpoint in the existing harness/3.19 worktree. Revalidate current source and installed build before relying on recorded state. Prioritize successful retrieval-strategy learning, freshness-safe reuse of settled reads, and a continuity test across compaction plus restart. Extend the existing Jev/capability/memory/kernel paths; do not create parallel authorities or relax human approval. Prove cold, warm and aged-session behavior on the installed app using matched tasks and complete role-attributed latency/token accounting. Keep plan_task consolidation staged and preserve current release gates. Report verified improvements, regressions and remaining work separately; do not tag on narrow tests alone.
