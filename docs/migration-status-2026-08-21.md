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

No `legacy` dispatch kind remains. After semantic participation, unbound retrieve/act is `blocked`/`needs_input`, not an untyped tool loop. Conversation is the cheap mode of the same kernel.

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

- `new_goal` with explicit openSlots and no work must park `DependencyRequest` `user_input`, not fail admission as illegal payload (converse-first).
- `satisfyConnectionRequestsNow` still walks `connection_requests`; enumerator wake not folded onto `dependency_requests`.
- `host-bind-operations.ts` still `.find()`s; `admitted-construct-run.ts` still branches on `capabilityRole`.
- Bounded-loop runner not landed; fanout still uses the durable scheduler.
- Workflow lane still has separate `workflow-graphs.db`.
- Packed-candidate / clean-commit proof not obtained.
