# Migration status annex — 2026-08-21

Status: Dated inspection. Not architecture. Re-audit before treating numbers as current.

Doctrine: [blank-state-universal-execution.md](blank-state-universal-execution.md)

---

## Stage 0 production path (chat)

```
ingress (gateway / console / discord-harness / mobile)
  → appendEvent user_input_received          [accepted-source writer]
  → compileTurnGraph / prepareDurableAcceptedTurnCompile
  → interpretAcceptedSource (host compile or semantic port)
  → recordTurnGraphShadow (event still named shadow; loop treats it as authority)
  → dispatchAdmittedSource
       conversation → model reply, tools stripped
       typed        → runAdmittedTurnGraph (full graph scheduler)
       blocked / needs_input → commitTurnOutcome
  → if conversation: runConversation model loop (tools remain for non-conversation)
  → commitTurnOutcome / deliverOutcome
```

Live typed callers of `dispatchAdmittedSource`: `src/runtime/harness/loop.ts` (turn start and resume). Tests also call it directly.

`runAdmittedTurnGraph` live caller: `dispatchAdmittedSource` only.

No `legacy` dispatch kind remains. After semantic participation, an unbound **write** is `blocked`/`needs_input` — it must not fall through to the conversation loop (north-star cutover). Unbound **reads** may still answer in conversation. Typed dispatch runs only with a bound `operationId`.

---

## Writer matrix (this slice)

| Fact | Canonical writer | Store | Overlap / predecessor |
|---|---|---|---|
| Accepted source | `appendEvent` `user_input_received` | `harness.db` events | none |
| Semantic proposal | `interpretAcceptedSource` / `admitTurnSemantics` | events + interpretation rows | host compile vs model port (same admit) |
| Requirement coverage | `admitRequirementCoverage` (this slice) | derived, hashed onto source | none previously |
| Control complexity | `assessControlComplexity` (this slice) | derived, hashed onto source | altitude router / expected-work (do not mint TEP) |
| Graph / TEP | `compileTurnGraph` via `prepareDurableAcceptedTurnCompile` | `turn_graph` event | event type still says shadow |
| Graph admission | `admitGraph` | in-memory + journal | none |
| Advisory index | `recordCapabilityOperations` | `memory/capability-index/.../capabilities.db` | **was minting trusted manifests** via `registerIndexedCapabilitiesForTurn` — de-authorized this slice |
| Trusted contract | adapter → `capability-manifest-store.install` | harness manifests | index must not write here |
| Live observation | `registerIndependentCapabilityObservation` | observation store | index was forging `origin: independent` — de-authorized |
| Account instance | manifest `accountId` + live identity | capability-live-identity | none |
| Invocation plan | `ResolvedCallAuthorityV1` / sealed node binding | physical_dispatches | host-bind `.find()` is SELECT-1 defect |
| Logical call | `commitLogicalCallSettlement` | logical_call_settlements | |
| Physical crossing | `beginPhysicalDispatch` / `claimPhysicalIo` | physical_dispatches | |
| Settlement | `settlePhysicalDispatch` | physical_dispatches | |
| Evidence / readback | construct-run verify + artifact records | events + artifact tables | role mega-switch in `admitted-construct-run` |
| Dependency | `parkDependencyRequest` (this slice) | `dependency_requests` | `connection-request.ts` is an incomplete subclass; do not dual-write |
| Wake | `satisfyDependencyRequestsNow` | same table | `scheduleConnectionRequestWake` predecessor |
| Outcome | `commitTurnOutcome` | `conversation_completed` | `deliverOutcome` for async lanes |

Stores: `harness.db` is the kernel store. Workflow lane still has separate `workflow-graphs.db` / filesystem receipts (annex gap, not this slice). Index DB is advisory only.

---

## Phase writer matrix and deletion list (Stage B: direct read)

| Field | Old writer | New writer | Deletion / de-authorization |
|---|---|---|---|
| Index as bind authority | `registerIndexedCapabilitiesForTurn` installs `trusted: true` + `lifecycle: current` + independent observation | descriptors only (`hostDescriptorsFromCapabilityIndex`) | **De-authorize install/observe/register from index hits** |
| Bindable catalog filter | `catalogEntriesForAcceptedSource` admits `indexedIds` | frozen ∩ proofs ∪ adapter-attested only | **Remove index-id branch** |
| Direct retrieve executor | `runAdmittedTurnGraph` / `runGraph` | `runDirectNodeInvocation` | Direct mode MUST NOT call the general scheduler |
| Missing-capability stop | `unboundConstructStop` / `parkConnectionRequest` (family gaps) | `parkDependencyRequest` | ConnectionRequest remains unmigrated; this slice does not call it |

---

## Hardcoding / order defects still in tree (not all closed this slice)

- `host-bind-operations.ts` uses `entries.find()` (registration/catalog order).
- `admitted-construct-run.ts` branches on `capabilityRole` (source/collection/transform/destination/readback).
- `accepted-goal.ts` text regex for families (admitted destinations no longer select ceiling from family string).
- `production-capability-adapters.ts` still names sheet/calendar slugs at the adapter edge (allowed); graph core must not import them.

---

## Selected Stage B slice

**Fully bound cold read in `direct` mode.**

Least complex sufficient: one operation, no second sink, no human boundary, no outliving the activation, no partial completion. The 48s calendar-read vs 1.7s provider call is the diagnostic. Graph scheduler is disproportionate.

Not claimed: walking skeleton, bounded_loop pagination, async jobs, G-FLYWHEEL corpus, packed-candidate hermetic run.

---

## Baseline (2026-08-21, before this slice’s code)

Focused related tests (conversation short-circuit, indexed catalog, metamorphic rename) were green. Full typecheck/build/packed-candidate were not re-run as a clean baseline on this dirty worktree; see Stage B results in the implementation report.

---

## Slice 2026-08-21 (SDK reach + first-use bind + proportional dispatch)

Verified against this dirty working tree. Not tag evidence.

### Production path change

```
admit-and-compile
  → recordConnectedGoalCatalog          [adapter-owned live facts]
  → registerProofProvisionedCapabilities [attested catalog entries]
  → registerIndexedCapabilitiesForTurn   [descriptors only]
  → freezeCatalogSnapshotForSource
  → dispatchAdmittedSource
       conversation → model reply
       direct       → runDirectNodeInvocation (no general scheduler)
       other modes  → runAdmittedSourceGraph
       missing contract / family gap → parkDependencyRequest
```

Predecessor de-authorized this slice: `typed-source-dispatch` no longer calls `parkConnectionRequest`. `registerIndexedCapabilitiesForTurn` remains descriptors-only. Direct retrieve no longer pays `runAdmittedSourceGraph`.

### Writer matrix (unchanged owners)

| Fact | Canonical writer | Predecessor |
|---|---|---|
| Advisory index | `recordCapabilityOperations` | must not install manifests |
| Bindable catalog | frozen snapshot ∩ attested ∩ (host_only ∪ this-source selected ids) | index ids |
| Direct retrieve | `runDirectNodeInvocation` | general graph scheduler |
| Missing contract / family gap park | `parkDependencyRequest` | `parkConnectionRequest` (wake still in `capability-enumeration` / `connection-request`) |
| Outcome | `commitTurnOutcome` | none |

### Isolated tests (this run)

- kernel TAP: 28 pass / 0 fail (`kernel-isolated.tap`)
- SDK TAP: 89 pass / 0 fail (`sdk-carriers.tap`) including Claude Agent SDK `query`, MCP SDK `Client`, Codex `configureHarnessRuntime`
- `tsc --noEmit` exit 0

### Source daemon boots (this run)

Two consecutive `tsx src/index.ts service` boots on disposable homes: `/api/status` healthy in 5s, SIGTERM stop. Not the installed-app home.

### Live proof (`--allow-dirty-dev`, sourceClean=false)

| Brain | converse-first | capability-reconnect-resume |
|---|---|---|
| Claude | FAIL 6/8 — `new_goal` + openSlots + `work: null` is `illegal_relation_payload`; zero outward tools | PASS 20/20 |
| Codex | FAIL 6/8 — same unadmitted copy | FAIL 10/20 — workflow `prepare` blocked before typed park/resume |

Dirty-dev banner retained. No git tag, push, or deploy.

### Remaining (not this slice)

- `satisfyConnectionRequestsNow` still walks `connection_requests`; enumerator wake not folded onto `dependency_requests`.
- `host-bind-operations.ts` still `.find()`s; `admitted-construct-run.ts` still branches on `capabilityRole`.
- Bounded-loop runner not landed; fanout still uses the durable scheduler.
- Workflow lane still has separate `workflow-graphs.db`.

---

## Clean-tree proof — 2026-08-21 later (`82e17946`)

Candidate (no tag): `82e17946bf97c295d50967d1193d5c4f136f8b20` on `wave/one-gate-and-hardcode-subtraction`.

Adversarial check of `f713b731` / `6c7c8059` on a stashed-clean tree: not self-contained. `tsc --noEmit` failed (schema 42 vs migration 49, missing attested transport, unresolved typed-dispatch exports). Dirty-dev proofs of the full worktree are not tag evidence.

Follow-up commits that closed the kernel graph without tagging:

- `e0ae3cd6` — remaining identity, settlement, schema, and shipped-artifact modules so a clean tree typechecks and boots.
- `82e17946` — Codex workflow-step scorer expects `openai_agents_harness` (the committed SDK transport). `f713b731` had scored dirty-tree `host_harness`.

Measurement: detached worktree at `82e17946` with empty `PROOF_SOURCE_PATHS`. Runtime: `candidate-clean-tree` (`npm ci` + `npm run build` in an out-of-repo worktree). `sourceClean=true`, `sourceStable=true`. No `--allow-dirty-dev`. No dirty-dev banner.

| Brain | converse-first | capability-reconnect-resume | sourceClean |
|---|---|---|---|
| Claude | PASS 8/8 (wall 9.6s) | PASS 20/20 (wall 32s) | true |
| Codex | PASS 8/8 (wall 11s) | PASS 20/20 (wall 23s) | true |

Claude on `e0ae3cd6` was also PASS 8/8 + 20/20, `sourceClean=true`. Codex reconnect on that commit failed 19/20 solely on the stale `host_harness` score; production used `openai_agents_harness`.

Focused TAP on clean `e0ae3cd6`: 52 pass / 3 fail. The three fails are `shipped-implementation-identity.test.ts` `npm pack` / `prepack` (mobile-web tsc) and subsequent stamp mismatch — not the kernel admission/dispatch tests. Clarifying-open-slots, AUTH-5 catalog, proportional-control, requirement-coverage, SDK carriers, and physical-dispatch-grounding were green. `tsc --noEmit` exit 0.

`git describe --tags --exact-match` empty. No push, deploy, or daemon restart of the installed-app home. Main worktree remains dirty (~429 unrelated files).

---

## Clean-tree proof — 2026-08-21 later (`9e26685d`)

Next-tag candidate (no tag): `9e26685dcb8a6ae4b47b177e0b95339bc5d88e22`.

`82e17946` was not shippable as-is:

- Kernel TAP on a clean `82e17946` worktree: 27 pass / 1 fail. The two-teeth pin failed because `loop.ts` and `claude-agent-brain.ts` still called `recordTurnGraphShadow` and never entered `recordAcceptedSourceGraph` / `dispatchAdmittedSource`.
- Wiring that seam (`5f2b6db0`) made converse-first HTTP 500: `semantic port is unavailable`. Daemon boot did not call `configureTypedExecutionRuntime`.
- `9e26685d` installs that runtime at `startDaemon`.

Gating captures from clean worktree `/tmp/clem-kernel-clean` at `9e26685d`:

- `kernel-isolated.tap`: 28 pass / 0 fail
- `sdk-carriers.tap`: 9 pass / 0 fail
- `npm run typecheck`: exit 0

Live proof, `sourceClean=true`, `candidate-clean-tree`, no `--allow-dirty-dev`:

| Brain | converse-first | capability-reconnect-resume |
|---|---|---|
| Claude | PASS 8/8 (wall 22s) | PASS 20/20 (wall 35s) |
| Codex | PASS 8/8 (wall 6.6s) | PASS 20/20 (wall 27s) |

No tag.

---

## Session composition root — 2026-08-21 later (dirty tree, no tag)

Doctrine: [blank-state-universal-execution.md §6.1](blank-state-universal-execution.md) / **COMPOSE-1**.

Clem's DeepSeek-style adaptation: the loop stays task-blind; session identity mounts tools and primers.

| Identity | Mount | Kernel |
|---|---|---|
| `chat` | memory inject + connected surface | `dispatchAdmittedSource` |
| `space-<slug>` | workspace contract primer + `space_*` pin | same |
| `workflow:…` | saved-bundle allowlist | same |

Owner: `src/runtime/harness/session-composition.ts`. Consumers: Claude brain, Codex loop/orchestrator, console and mobile docks. Memory injects and does not grant reachability. Not tag evidence.
