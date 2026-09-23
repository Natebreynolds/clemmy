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

## Create then manage artifact lineage (source287277)

Installed bfb7bd07c completed the controlled author→readback→enable→run once→
verify323→disable→readback task. Exact-source evidence and canonical measurement
are under output/harness-acceptance/2026-09-23-bfb7bd07c. Wall132471ms,
16 top-level calls including6 discovery calls;277079 uncached input tokens,
3 uncertified usage records. One canonical terminal287510, original attempt
completed, one succeeded workflow run, final saved fixture disabled. No speed
win claimed. Independent API checks confirmed run1790159971966-a3772f.

Live plan initially rejected create_new workflow destination with later lifecycle
operations. The submitted graph had dependsOn but no dataFrom; rejecting mere
ordering is correct. However, even adding dataFrom could not fix it because
creation and enablement have different purpose labels. The repair also falsely
said no shown capability could create the destination. The model removed the
destination on retry rather than retaining the complete typed intent.

Candidate fixes the shared artifact-lineage predicate: existing same-purpose
contracts remain supported, while a write that creates the same deliverable
family with the same output contract can feed a different-purpose lifecycle
operation through explicit dataFrom. A workflow_run output remains a different
contract from workflow_revision. No tool/model/provider-name branching or
execution authority change. Repair uses this same host predicate to identify
already-cited creation/lifecycle operations and asks for explicit data lineage
instead of another discovery search or removal of destination metadata.

Regression red: explicit create→toggle data lineage failed before the fix;
run-receipt data lineage correctly rejected. Added repair test requiring cited
operation IDs, explicit dataFrom/dependsOn and preserved destination, without
false cold discovery guidance. Existing order-only/cross-family/wrong-posture
negative cases remain. Logs /tmp/clem-artifact-lineage-{red,green,final,final2,
types,integration}.log. Tests are recording/fixture checks, not live acceptance.
The candidate must be built after committing and reaccepted in the installed
app before claiming this live planning defect fixed.

Validation complete:72/72 focused checks on final predicate,21/21 production
plan/execute and host resolution/read integration checks; typecheck passed.
Sentinel not performed while live daemon owned the home. No full-suite or
journey acceptance claimed. Final predicate retains previous same-purpose
compatibility in addition to the newly tested typed lifecycle route.

## Lifecycle proof regression pinned (unfixed)

Live9ec source287511 failed cleanup despite a successful product323 run. Exact
record and operator-only fixture disable:
output/harness-acceptance/2026-09-23-9ec240523/README.md. Do not claim this
candidate accepted. The lineage admission repair worked with destination kept;
subsequent revision proof did not. Installed fixture now disabled by operator.

New production test in native-space-plan-read.integration.test.ts:
"a created workflow remains completed after its planned enable revision and database reopen".
Real scoped discovery→plan_task→work_call(create disabled)→work_call(enable)→
selected metadata read, recording model only. Both mutations return success;
expectedWorkPlanLines reports create=open, enable/verify=blocked_on_dependency.
Red reproduced in /tmp/clem-lifecycle-proof-red2.log. Initial red log was a test
setup mistake (missing hostTurnEngine/context identity); red2 is the actual
live defect. Do not weaken the satisfied assertions or mark this fixed.

Proof diagnosis: native-revision-commit-proof requires current artifact bytes
for every past commit; authorized successor revision invalidates predecessor.
It also routes ANY dataFrom edge to a Workspace-specific content-derivation
proof, which cannot verify workflow identity consumption. Preserve the existing
native-space negative assertions for unrelated byte drift, missing artifact,
source/contract mismatch and tampered retained result. Historical completion
needs exact settled successor lineage, not nominal tool success or order alone.
An existing workflowActivationSuccessor mechanism recognizes exact source/call-
bound priorDigest→facts transitions for verification activation. Evaluate reuse
before introducing another mechanism; it currently does not cover foreground
native lifecycle writes. Runtime proof fix and live reacceptance remain owed.

### Candidate proof fix

Native revision dependency proof now separates exact historical commit evidence
from current artifact verification. Both use the same sealed selection, accepted
source/task/contract, successful mutating settlement, host local-envelope binding,
argument digest and canonical retained result. Historical mode is private: it
cannot independently satisfy a public proof. Identity lineage requires one exact
prior write per declared data source, matching artifact handle/createdId/revision
output contract, a real dependency edge and settlement before successor binding.
Non-identity lineage still goes through the existing stronger content derivation.

If original bytes changed, completion requires a later settled revision in the
same contract, causally ordered after it, sharing explicit artifact data lineage,
with matching handle/id/output contract. Current bytes must verify at the end of
the chain. This covers sibling lifecycle actions that both reference creation,
not just a simple linked list. No unrelated current revision, other source,
order-only write, missing file or malformed receipt is accepted. No dispatch or
replay authority is created. Existing activation helper remains unchanged: it
handles source-bound automatic verification activation, not arbitrary plan nodes.

Production regression expanded through disable (both enable and disable reference
creation), verification, final-byte drift and database reopen. Direct-only chain
first failed at enable=open after disable (/tmp/clem-lifecycle-chain-red.log),
then full native production file passed7/7 (/tmp/clem-lifecycle-chain-green.log).
Existing Space tampered-byte/missing-artifact/tampered-retained-receipt/source-
identity negatives remain intact. Typecheck passed. Broader affected dependency
and explicit plan/execute tests are running in /tmp/clem-lifecycle-affected.log.
Candidate is not installed/live accepted yet. Do not count fixture cleanup on
source287511 as acceptance or claim performance gains from failed work.

Broader affected checks:42/43 passed. The one failure is
"a second DECLARED effect is its own requirement — the send never dies as already-executed"
(expected-work-bypass-evidence.test.ts): expected refused, observed bound.
Reproduced by that exact name on unchanged HEAD9ec240523 and last tag8c11aa3c0,
logs /tmp/clem-lifecycle-{head,tag}-attribution.log. It is pre-existing, remains
unresolved, and is not hidden or counted as a pass. Full release acceptance still
owes its contract review. Native successor proof checks cache verified nodes only
within a single proof invocation, avoiding repeated ancestor verification without
retaining stale state across calls. Final native fixture/typecheck rerun pending
in /tmp/clem-lifecycle-chain-final.log and /tmp/clem-lifecycle-types-final.log.

Final native regression rerun7/7 and backend typecheck passed. Candidate now
proceeds to commit/build. Live installed source remains9ec240523; the proof fix
has not yet been hotpatched or accepted. Full suite/journeys were not run on the
loaded machine, and isolation sentinel was not performed with the live daemon.

### Installed0bc follow-up: terminal gate still fails

Source287735 completes all workflow actions and keeps create/enable/disable
satisfied, including background continuation. Independent saved disabled state
and exactly one completed run verified. Canonical terminal287939 is nevertheless
blocked by content-derivation evidence required for artifact identity lineage.
Evidence: output/harness-acceptance/2026-09-23-0bcbb8b7c/README.md.
The production regression now extends through prepareAcceptedTaskTerminal;
it fails with the exact live reason (manifest derivation names no upstream
source evidence), /tmp/clem-lifecycle-terminal-red.log. This additional assertion
is uncommitted and must pass before the next candidate. No new runtime change
this acceptance turn; current installed0bc is NOT fully accepted. Do not weaken
the terminal gate or count the brain's done reply as completion.

### Terminal proof work in progress (do not hotpatch)

Candidate now exposes identityLineageVerified from the exact native revision
proof. Receipt issuance and ordinary redemption share verifiedNativeIdentityDerivation,
which rechecks exact source/task/contract/operation and proof, and does not bypass
structured content/count requirements. This makes prepareAcceptedTaskTerminal
ready in the regression. The test now additionally verifies final publication,
post-issuance file drift, actual commitTurnOutcome(done), and no extra model call
or mutation. This final boundary still fails with Workspace-only derivation:
/tmp/clem-terminal-publication2.log. The earlier publication log included a test
setup mistake (wrong acceptedTaskId source); fixed by loading exact work contract.

IMPORTANT architecture trap: terminal-publication-proof.ts is deliberately
cycle-free and takes the existing database transaction. Importing native-revision-
commit-proof there causes an eventlog/external-write-admission module cycle
(/tmp/clem-terminal-publication3.log). That import was REMOVED, not papered over
with a runtime callback or dynamic authority hook. Terminal source is unchanged.
Next extract a cycle-free shared proof core accepting db and validated adapters;
reuse terminal's exactSuccessfulResult/exactSealedNodeAuthority and preserve
exact expected-work contract/address validation. Do not bypass the transaction
boundary or duplicate a weaker identity check just to make publication green.

18 affected content-derivation/created-payload/explicit-plan integration tests
passed (/tmp/clem-terminal-affected.log), but final publication assertion remains
RED. Current source changes are uncommitted and must not be built/hotpatched as
an accepted fix. Installed app remains0bcbb8b7c, controlled fixture disabled.

### Native lifecycle terminal proof: candidate regression green

The previously red terminal boundary now shares a cycle-free native revision
proof core with execution and receipt issuance/redemption. Publication supplies
its existing transaction, exact sealed selection, exact successful result, and
canonical contract/address/authority validation. No runtime store imports were
added to the publication verifier. Pure contract value validation was extracted
unchanged so the transaction checks the same normalized topology and address.
Native identity lineage satisfies the existing derivation obligation; content
and structured collection obligations retain their existing proof path.

Production lifecycle fixture passes preparation, final proof, actual done
publication, durable reopen, and post-issuance artifact drift rejection. Added
negative cases corrupt contract metadata, authority contract identity, and the
selected call argument binding; each refuses completion and recovers on rollback
without another write or model turn. All7 native integration checks and59
adjacent contract/publication/content-derivation/receipt/explicit-plan checks pass.
Logs: /tmp/clem-cyclefree-native-negative.log, /tmp/clem-cyclefree-affected.log;
backend typecheck /tmp/clem-cyclefree-types2.log passed; diff check passed.
The isolation sentinel was NOT performed with the live daemon running. Full
suite/journeys remain unqualified on the loaded machine. The previously attributed
second DECLARED effect regression remains open, not silently counted as passing.

Next: clean commit/build, Terminal hotpatch on idle installed app, exact build
identity verification, and one controlled matched workflow lifecycle acceptance.
Live installed0bc is still the failed terminal baseline until that rerun proves
otherwise. Do not treat these isolated regressions as live acceptance or tag-ready.
