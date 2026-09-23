# Jev routing and release continuation — 2026-09-23

## Current evidence

Worktree `harness/3.19`; shared main remains e77215d00. Owner/UI edits on main
were not touched. Installed app independently reports b30faf84f, fingerprint
5c96825d8eb1553b5288da5a7f2762767899d051a62f481be5b83d4f270bde61,
daemon47649. This checkpoint and the routing fix below are not installed yet.

The prior goal turn inspected current routing but implemented no change. This
continuation reproduced and fixed a request-fidelity defect and completed the
outstanding store-upgrade evidence check. The overall tag goal remains open.

## Fixed: late constraints disappeared before Jev ranking

`prepareSharedEvidenceDecisionsWithJev` normalized whitespace and passed only
the first800 characters of its caller's request. A late read-only instruction,
negation or exact search string could be lost before ranking skills or memory.
The production skill-ranking caller is in `src/runtime/harness/loop.ts`.
Preserve the complete caller-supplied request; keep compact candidate labels,
existing candidate limits, deadlines and fallback behavior unchanged. This is
not a full conversation or tool-schema injection and grants no tool authority.

Regression captures the actual outbound request for ranking-only, primer-only
and combined adapters. It uses a late no-write constraint and significant
whitespace, and verifies HTTP413 retains original candidates/hits. It failed
without the fix (10pass/1fail) and passes with it. Focused control-plane,
SystemOne, catalog and tool-surface suites:47/47. Typecheck passed.
Logs: `/tmp/clem-jev-routing-request-{red,green,types}.log`.
No real-provider or installed-app acceptance claimed for this new change.

## JIT implementation target still owed

The latest inspected Opus frame used about10485 estimated schema tokens of
17804total. `plan_task`2840, `run_worker`1329 and `work_call`1280 are major
contributors. Native workflow/Space authoring schemas were already absent in
that frame. The old registry-only72KB audit is not a model-wire baseline.

Current hot-set selection uses always-loaded acquisition tools, explicit names,
verified workflow matching, memory and recent use. Jev's shared ranking adapter
does not yet select the whole per-request tool surface. Do not describe this
request-fidelity fix as implementing that selection or saving tokens.

Next implement relevance selection from compact, live capability descriptors,
skipping semantic calls when an exact validated match already resolves the
request. The selected surface must preserve full-catalog discovery on misses,
new tool needs and Jev unavailability. Selection is advisory, not authorization.
Native, CLI, MCP and Composio must remain reachable through existing bindings.

Before deferring structural schemas, preserve runtime-instance identity:
`plan_task` and `run_worker` are constructed inside the orchestrator, and their
inner frame rules/continuation behavior cannot be replaced by a registry stub.
Generic call_tool reachability already includes structural controls; it is
incorrect to claim dispatch is entirely absent. What remains unproven is exact
same-turn schema acquisition and frame parity after initially hiding them.
Pin Plan/Execute, fan-out, source approval, retry/restart and unfamiliar tool
discovery before claiming schema reduction safe. A smaller list alone is not
acceptance. Measure total calls, uncached input, schema tokens, first-content
and terminal wall on matched live tasks, including Jev overhead/cache behavior.

## Release evidence recovered

Exact b30 release assets56/56 and release closure138/138 already passed.
The actual v3.14 store rehearsal exited0 with ok=true and18/18 checks, including
target schemas81/36/5 and second-boot comparison. Summary retained at
`output/harness-acceptance/2026-09-23-b30faf84f/release/upgrade-summary.json`.
It is a disposable representative fixture, not live-home acceptance or a
packaged daemon upgrade. No recovery workers, timers, providers or workflow
dispatch were exercised. Production-history corruption/partial-write and
machine credential cases remain unproven.

Full suite/journeys remain pending; machine still has a busy Chrome renderer.
No tag, push, or fresh hotpatch in this continuation. Original release scope,
mobile approval/recovery, broader tool acceptance and package gates remain open.

## Unified discovery now calls Jev for ambiguous candidates

The pre-existing block in tool-search-tool.ts claimed to rerank through Jev but
only concatenated exact and fuzzy rows. The new production caller ranks compact
metadata from the unified native/MCP/Composio/reviewed-local discovery window
before schema selection/materialization. It uses the existing shared adapter,
remaining broker deadline (at most the existing1200ms relevance allowance), and
original ordering on unavailability. Exact selections, requests already naming
operations and retained pages do not pay for ranking. No candidate is removed.
Existing acquired-read, explicit namespace, effect compatibility and lifecycle
precedence still wins over semantic scores. Jev supplies no dispatch authority.
This improves discovery after tool_search; initial brain schema selection and
runtime structural-tool deferral are still owed. No token or latency win yet.

Regression exercises the actual registered tool_search with compact candidates
from multiple sources, verifies changed ranking plus schema disclosure, exact
bypass, namespace precedence, page reuse without reranking and HTTP503 fallback.
It failed against80cf9a212 because zero Jev requests were made. Focused broker,
control-plane, catalog and surface tests:88/88; typecheck passed. Logs under
/tmp/clem-jit-broker-{red,final,types2}.log. The runner cannot certify its live-home
sentinel while the installed daemon is active; isolated tests are not live proof.

Also restored explicit JSON-encoded-string guidance and the structured example
on workflow_create.inputs, matching workflow_update. The unchanged existing
schema-contract test failed on both pre-change80cf9a212 and last tag8c11aa3c0,
with the same missing guidance; it now passes. This did not relax its assertion
or alter workflow execution. Tag attribution: /tmp/clem-jit-schema-last-tag.log.

Installed baseline discovery session sess-desktop-a76180a8c3973f6e1f3fb83c was
submitted once on b30faf84f. Await exact terminal and source accounting before
patching; then repeat its identical prompt on the new candidate. This checkpoint
is written before that acceptance and does not claim it passed.

## Runtime structural schema identity — discovery foundation

A scoped run_worker search could return its name with no schema even though
Clem had a callable foreground worker object. Static core-tool discovery does
not own that object: it is constructed in the orchestrator with parent-bound
execution and continuation closures. The schema lookup had no current runtime
metadata source. This prevents reliable JIT acquisition if the worker schema
is later removed from the initial frame.

The orchestrator now resolves its registry-declared worker discovery entry to
that exact runtime object. Scoped tool_search accepts a host-owned metadata
view, populated after structural tool construction and read at invocation.
Generic dispatch shares the same turn-owned objects. Metadata still does not
add allowed names, planning refs, grants, or execution rights. No structural
schema is hidden by this change; initial schema savings are still unproven.

Pins: the scoped builder returns current/rebuilt metadata and does not disclose
an excluded name. A recording-model turn through the real host runner and
production orchestrator retrieves the actual worker packet schema without
starting a worker. The latter failed with no schema until discovery's name
resolver included the actual worker object. Direct invocation of the wrapped
search without a host turn was rejected correctly (missing source/graph); the
final regression uses the host runner instead of bypassing that boundary.
Do not replace this with an unwrapped helper test.

Trap for the next JIT step: enabled-surface membership owns carried-control
resolution; source approval/restart can rebuild the agent. Any lazy activation
must survive the exact-source rebuild and reactivate the same runtime control,
not substitute the SDK worker handler or treat discovered metadata as authority.
The existing full worker packet remains visible pending that implementation.

Logs: /tmp/clem-jit-runtime-schema-{red,targeted,builder4,builder5,final,types3}.log.
This note is written before the full affected-suite completion/build. Installed
app remains671c620a9; runtime schema changes are not live acceptance yet.

Affected-suite completion:91/91passed, including real host worker-dispatch
recording-model variants, scoped/local discovery and action-control contracts.
Typecheck passed. Isolation sentinel was not performed while daemon82711 owned
the live home. The candidate now proceeds to its required post-commit build;
no live or token-efficiency acceptance is inferred from these unit results.

## Learned-tool and long-horizon follow-up

Owner priority: preserve the existing framework, use learned bindings before
first brain inference, and control per-call growth without losing the goal,
constraints, approved plan, unresolved work, or retrievable evidence. Plan to
execution and workflow author/enable/run/readback/disable remain live gates.

The existing host path already prepares proven operations before capability
construction. It bypasses Jev for a single lexical strategy or equivalent tool
sets and invokes Jev for ambiguous or staged candidates. Do not re-enable the
obsolete host capability hunt. Open concern: guidance clips cached schemas at
1,800 characters; the clipping can omit contract fields. No schema policy was
changed in this increment, and no efficiency improvement is claimed.

Fixed exact discovery of an already loaded first-class tool: the scoped search
set now includes visible first-class names, independently of deferred catalog
and execution authority. The production worker-schema test failed with an
explicit run_worker request before the fix and passes with it. Learned guidance
also now contributes its own provenOperation prompt-component estimate. A
production runTurn filter test verifies measurement and retained guidance after
compaction. This is attribution, not token reduction.

Compaction tests initially returned 34 pass / 4 fail. Reproduced all four named
failures at unchanged d8807b834 in /tmp/clem-context-head-0923 and last tag
8c11aa3c0 in /private/tmp/clem-last-tag-0922:
- inFlightCompactionThresholds — a caching wire scales, a non-caching wire does not
- summarizeOlderMessages — preserves compaction summaries instead of re-summarizing recall maps
- pressure collapse keeps parallel and sequential identical-result frames valid and retains the newest pair
- Layer 2 preserves complete tool arguments and results outside its prose summarization

These were fixture drift: automatic caching uses stable checkpoints without
larger thresholds; three small inputs produced token-expanding replacements
which production correctly rejected. Fixtures now exercise actual savings while
retaining exact evidence, recall-map, parallel-protocol and newest-result
assertions. Added an explicit regression requiring both tool compaction and
prose summarization to reject larger replacements. No compaction policy changed.

Validation: 61/61 combined compaction, proven-operation and production discovery
checks; 1/1 added nonexpansion regression; 1/1 runTurn measurement/compaction pin;
backend typecheck and diff whitespace check passed. Logs:
/tmp/clem-{context-final,context-nonexpansion,proven-meter,context-types}-0923.log.
Historical attribution logs: /tmp/clem-compaction-{head,tag}-0923.log.
Live-home isolation sentinel was not performed because daemon6402 owns the home.
These are isolated fixture checks, not installed-app acceptance.

Current main e77215d00 is an ancestor of our candidate. Owner/UI changes remain
untouched. Installed source remains d8807b834 until the next coordinated build
and hotpatch; do not attribute these new checks to installed bytes. The broader
release gates, live matched performance and long-horizon acceptance remain owed.

Plan follow-up: explicit-plan-execute integration and plan-continuity suites
passed 33/33 using recording/stub models. These cover prepared reads, approved
execution, repeated member read/write results across reopen, terminal proof,
source identity, and pending input continuity. Log:
/tmp/clem-plan-continuity-0923.log. Live build-info rechecked d8807b834,
fingerprint3123a52f5d0ae6593d35ee7b99f9891a0842386f6b76850cebe1bf16c185c8fc,
daemon6402. No new live acceptance or model-cost claim.
