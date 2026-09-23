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
