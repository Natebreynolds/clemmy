<!-- Amendment record. Normative. Written 2026-08-22 in response to the vision statement:
     "run long horizon tasks no matter the tools a user wants to connect — truly a personal
     assistant that grows with the user as they use her."

     Every invariant below is a mechanically checkable restatement of a sentence the doctrine
     already contains, attached for the first time to something that can fail. Each cites the
     real violation it would have caught. Apply into blank-state-universal-execution.md and
     north-star-unification.md when those documents are not under active edit. -->

## North-Star Amendment — Catalogued is not usable

**Status: Normative.** Amends `docs/blank-state-universal-execution.md` §4, §5, §16, §25, §26.0, §26.3, §26.6, §26.11, §27, and `docs/north-star-unification.md` "Release gate for the migration". Adds no new controlling document. All code-level counts, caller censuses, and file citations belong in `docs/migration-status-2026-08-21.md` per `blank-state-universal-execution.md:10-12`; the rationale block at the end of this amendment is the exception permitted for the amendment record itself and is not doctrine.

---

### 1. §4 Definitions — new rows

Insert into the definitions table at `blank-state-universal-execution.md:143-163`, after **CatalogSnapshot**:

| Term | Definition |
|---|---|
| **BindableCapability** | A catalogued operation whose identity, frozen input schema, effect classification with provenance, exact `AccountBoundInstance`, current `CapabilityManifest`, and complete lifecycle-port set all resolve with no further provider call. |
| **DiscoveredCapability** | A catalogued operation that is not bindable. It may be described, ranked, and cited. It may not be compiled into an executable node, and it MUST NOT be reported to the user as connected. |
| **BindableFraction** | Per carrier kind, bindable capabilities ÷ catalogued capabilities, measured on a packaged clean home immediately after provisioning and before any turn. |
| **LifecyclePort** | One of the six functions a carrier must supply for every operation it catalogues: argument compilation, invoke, result normalisation, reconcile, cancel, verify. |
| **NormalisationFailure** | A business dispatch whose provider response the host received in full but cannot map into the required result contract. It is an `UncertainEffect`, not a failure. |

---

### 2. §5.13 — new principle

Insert after §5.12 (`:351-355`), before `## 6. Target architecture`:

#### 5.13 Catalogued is not usable (CAT-6 / CAT-7 / CAT-8 / TRUST-2)

Knowing that a tool exists and being able to use it are different states, and only the second one is a product. The capability truth pipeline in §5.10 is ordered correctly and the implementation may invert it: enumeration can write the retrieval index and leave the trusted contract for "later", where later never arrives on a cold install. Progressive discovery (§7.2) licenses deferring a schema load; it does not license discarding a schema the provider already handed over, and it never licensed a deferral with no producer.

Three postures follow:

- **Provisioning deposits what it was handed.** A carrier adapter that receives an input schema, an effect declaration, an account identity, or a provider observation timestamp in its enumeration response persists each one to that fact's single canonical owner in the same operation that writes the retrieval index. This does not make the index a writer of schema truth — `:325` stands unchanged. The enumerator is not the index; it hands each fact to the store that owns it. Discarding a bind-required fact the provider already returned is a provisioning defect, not a deferral.
- **The lifecycle is closed over the catalogue.** A carrier that catalogues an operation can compile arguments for it, invoke it, normalise its response, and reconcile it. Refusal, when a carrier genuinely cannot support a lifecycle port, is typed and happens at install; it never happens at invoke, and never after a crossing.
- **The gap is measured, not narrated.** Every install reports `BindableFraction` per carrier kind. A carrier kind with a non-zero catalogue and a zero bindable fraction is a decorative carrier: the user sees connected tools and the executor sees none. That is a release-blocking defect, not a degraded mode.

Fail-closed rule: a `DiscoveredCapability` may not be compiled into an executable node, and the reason it is not bindable surfaces as a typed `DependencyRequest` of kind `capability_contract_missing` or `capability_certification_required` (§5.11). It MUST NOT surface as `connection_missing`, and it MUST NOT surface as silence.

---

### 3. §25 — new invariant rows

Insert into the catalog at `:1606-1671`, each within its existing family, in family order. `TIME` is a new family; it is argued as new rather than folded into `BUDGET`, because `BUDGET-1` governs declared budgets and these govern host constants that no budget declares.

| ID | Normative invariant |
|---|---|
| **CAT-6** | Every lifecycle port is total over the operations its carrier catalogues; no port branches on, compares against, or keys a lookup by a literal operation, toolkit, product, or binary identity, and no port terminates in an unmatched-identity error. |
| **CAT-7** | A carrier adapter persists every bind-required fact its enumeration response already contains to that fact's canonical owner, in the same operation that writes the retrieval index. |
| **CAT-8** | A capability is `connected` only when bindable; bindable fraction is measured per carrier kind on a clean home before any turn, and a carrier kind with a non-zero catalogue and a zero bindable fraction fails release. |
| **TRUST-2** | Every trusted-artifact route named as the condition for executability has at least one shipped non-test producer exercised by a gate; a route with no producer is documented as a block, not a condition. |
| **EFFECT-6** | A provider response received in full but not normalisable is an `UncertainEffect` that reconciles; it never yields `failed` for a crossing that may have committed. |
| **BUDGET-2** | Every budget field has a type-level representation of no ceiling; no validator forces and no caller invents a finite number to express an unbounded run. |
| **TIME-1** | Every duration, count, or size bounding a user's work derives from the admitted plan's activation policy or user budget policy; no execution-path literal bounds a task, and a runaway detector never doubles as a work ceiling. |
| **TIME-2** | Every elapsed bound declares exactly one disposition — renewal while progress continues, or exhaustion into a durable checkpoint with a named live resumer — and park text never promises a wake kind with no consumer. |
| **TIME-3** | Every staleness gate names a refresher with a live non-test caller on the path it guards, and its freshness window is not shorter than the refresh cadence of the cache feeding it. |

---

### 4. §26.11 — fourth exception clause

Replace the paragraph at `:1940`:

> Adapter and recipe exceptions are explicitly allowlisted. They cannot construct task authority, reserve physical dispatch, call a provider outside the shared adapter port, **or enumerate the operations they serve.** A provider identifier may appear as adapter data — a manifest field, a schema key, a compiled argument — and may never be the predicate of a dispatch, normalisation, reconciliation, effect-classification, or evidence-verification branch. An adapter whose lifecycle ports resolve through a closed identity set is not an adapter; it is a hardcoded vertical wearing an adapter's filename. Every permitted recipe identifier must pass live revalidation, provider-rename, and stale-hint fallback tests.

This is the clause whose absence made the current violation compliant. It is stated as a prohibition on the *predicate*, not on the *string*, so manifest data and compiled arguments remain legal and only control flow is constrained.

---

### 5. §26.3 — carrier conformance is driven per operation

Append to §26.3 (`:1775-1786`), reusing its own idiom from `:1777`:

> Conformance is driven **per operation from the live catalogue snapshot**, not per carrier from the registry and not from a hand-maintained slug list. For every catalogued operation the matrix exercises argument compilation, invoke, result normalisation, and reconcile against a randomized conforming fake provider whose identifiers are generated, not enumerated. An operation no lifecycle port resolves fails the gate at catalogue time. A carrier that does not support cancellation, verification, reconciliation, or mutation produces a typed refusal at install; it is not required to pretend support, and it may not defer that refusal to invoke.

---

### 6. §26.6 — new crash-matrix injection point

Add to the injection list at `:1844-1860`:

> - host-side result-normalisation failure after a complete provider response (the wire returned cleanly; the host has no mapping into the required result contract).

Acceptance for this injection: the task settles as an uncertain effect and reconciles. A `failed` or non-resumable `blocked` terminal for a crossing whose world-state assertion shows a committed provider write fails the gate, regardless of what the host could parse.

---

### 7. §16.7 — new blank-state UX scenario

Add after §16.6:

#### 16.7 Connected but not bindable

The user connects a toolkit. Enumeration succeeds and hundreds of operations become searchable. No operation can be compiled into an executable node, because a bind-required fact is absent or a lifecycle port does not resolve. Clem states which fact is missing and who can supply it, as a typed `DependencyRequest`. Clem does not say the tool is connected, does not offer to run work through it, and does not report the shortfall as a missing connection. If the shortfall is structural for the whole carrier kind, Clem says so once, at connect time, rather than per request.

---

### 8. §26.0 — discharge the mapping the contract already requires

`:1695` requires that every §25 invariant map to at least one automated gate and that CI reject unmapped invariants. The document has never supplied the mapping, and `G-FLYWHEEL` — defined normatively at `:351` and `:355` — is absent from its own family table at `:1699-1712`. Add `G-FLYWHEEL` to the family table, and add the mapping table below it. New invariants map on arrival; an invariant added without a row is rejected by the same rule that rejects unmapped gates.

| Gate family | Invariants covered (this amendment) |
|---|---|
| `G-CARRIER-CONFORMANCE` | CAT-6, CAT-7, TRUST-2 |
| `G-BLANK-HERMETIC` | CAT-8 |
| `G-CRASH-RECOVERY` | EFFECT-6, TIME-2 |
| `G-STATIC-ARCH` | CAT-6, TIME-1, TIME-3, BUDGET-2 |
| `G-PERFORMANCE-SOAK` | TIME-1, TIME-2 |
| `G-FLYWHEEL` | FLY-1 |

---

### 9. §27 — Phase 2 exit criterion strengthened

Replace the exit criterion at `:2051`:

> Exit: adding a randomized conforming capability requires no core executor edit **and raises that carrier kind's bindable fraction, measured on a packaged clean home before any turn.**

A diff test alone passes an install where every connected capability is enumerated, indexed, retrievable, and permanently unbindable. Phase 4's exit at `:2095` already has the right shape and lands a phase too late to constrain the enumerator.

---

### 10. `north-star-unification.md` — release gate bullets

Add to "Release gate for the migration" (`:395-439`), in house style:

- a cold bindable-fraction report per carrier kind from a packaged clean home before any turn, with a zero fraction against a non-zero catalogue treated as red rather than as a degraded mode;
- a provider-neutral lifecycle proof in which a randomized fake carrier's generated operations compile, invoke, normalise, and reconcile with no edit to any lifecycle port and no unmatched-identity error path;
- a long-horizon soak proving that no host-side literal, lease expiry, freshness window, or activation budget can end a task — only a terminal Outcome, a user-owned gate, a user stop, or provably zero progress;
- zero `failed` or non-resumable `blocked` outcomes for crossings whose world-state assertion shows a committed provider write, including crossings whose response the host could not normalise;
- an enumeration-deposit equality check per carrier proving schemas, observations, and account identities stored equal those the provisioning response returned.

---

### 11. Rationale, and what these rules cost

Recorded here rather than softening the rules.

**CAT-6 makes shipping code illegal, on purpose.** The six-slug invoke switch and its unmatched-identity throw must go before the next tag. Half the cost is already paid — a generic, schema-grounded compile-and-invoke path exists in the tree and is simply not the port that gets registered, so that half is deleting a fork, not building a subsystem. The other half is real new work: generic write-response normalisation into `{id, handle, receipt}` does not exist. Under CAT-6 a carrier may not ship a write whose receipt shape is single-vendor, which means either a declared per-operation `resultContract` mapping derived from the frozen schema, or a typed install-time refusal for writes whose receipt cannot be derived. The second is cheap and honest; it will visibly shrink what the beta vertical can do until the first lands. That shrinkage is the invariant working.

**CAT-7 sits one inch from `:325` and must be read carefully.** `:325` forbids the *index* from authoring schema truth, and the index was right to refuse it. CAT-7 obliges the *enumerator* to hand the fact to the store that owns it. Without that distinction stated, CAT-7 reads as an OWN-1 violation and will be argued away exactly as `:1940` was used to bless the invoke switch.

**CAT-8 is red today for all three carrier kinds and will block a tag.** That is the point: an install where 2,414 catalogued operations produce one bound graph in 467 compilations is the product failing, and no existing gate reports it as anything. Expect pressure to make it a warning. A warning restores the current state exactly.

**TIME-1 forbids the graph admission literal, including `maxExpansions: 0`.** Honouring it requires implementing plan-owned activation policy, which doctrine specified at `:740` and nothing in the tree implements — `activationPolicy`, `elapsedMsPerActivation` and `automaticReentry` have zero occurrences. This is the most expensive rule in the amendment and the one with the largest gap between doctrine and tree.

**TIME-2 deliberately removes the escape hatch in `:1131`.** The existing "either renew … or checkpoint" disjunction is satisfiable by a bound that does neither, because neither branch is required to exist. Requiring exactly one, with a live caller, is strictly stronger and is what `north-star-unification.md:575-579` already means.

**The static tooth is weaker than §26.11 demands, and ships anyway.** §26.11 correctly says a text scan is insufficient alone. The source-assertion pins proposed here are text scans, in the idiom this repo already uses for architectural seams. They are the tooth that can land this week and they would have caught every hardcoding violation currently in the tree. They are a floor under the AST/registry analysis §26.11 requires, not a substitute for it, and the per-operation conformance case in §26.3 is the tooth that generalises: a lifecycle port with an identity branch necessarily has a none-of-the-above throw at the bottom; ban the throw and the branch cannot survive.

**Nothing here is a new opinion about providers.** Every rule above is a mechanically checkable restatement of a sentence the doctrine already contains — `:412`, `:404`, `:1131`, `:1135`, `:1426`, `:1616`, `:1695` — attached, for the first time, to something that can fail.
