# Spelling is not identity — removing the naming priority from the framework

Status: **plan, not yet implemented.** Audience: whoever executes this wave.
Owner's framing, 2026-09-18: *"There should be nothing in the code that is spelling
out tool names. It's all about discovery and the memory when Clem does a good thing
with a good tool."*

---

## 1. The defect, measured

Two counts, taken 2026-09-18 on `main` at `5f0fdae3`:

| Measure | Count |
|---|---|
| Sites type-testing an operation with `/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/` | **21**, across 17 files (9 Category A, 11 Category B, 1 Category C) |
| Non-test files containing hardcoded carrier/tool literals | **108** (41 occurrences in `host-turn-runner.ts`, 31 in `brackets.ts`, 29 in `tool-effect.ts`) |

That regex is Composio's *spelling convention* used as a *type test*. A reviewed CLI
read is `lower_snake` (`salesforce_sf_soql_query`), so every one of those sites
silently answers "not an operation" for it.

### What that cost, concretely

One workflow — `friday-sales-leadership-email`, whose first step is a Salesforce CLI
read and whose last step sends mail — hit **twelve** of those sites in sequence. Each
produced a different symptom, which is why it read as twelve bugs:

1. creation-test gate (`workflow-enforce.ts`) — workflow auto-enabled having never validated its read
2. step tool-surface lock (`workflow-step-agent.ts`) — step advertised `toolCount: 0`
3. explicit-operation catalog preparer (`workflow-step-external-catalog.ts`) — `status: 'none'`, no ports reconstructed
4. `tool_search` named-operation detection (`tool-search-tool.ts`) — exact id answered with `space_save`
5. carrier set was Composio-only — a named operation had no carrier to reach it
6. discovery sources never built for a locked step
7. `planningIdentity` passed as `undefined` — reviewed-CLI source was `null` for **every** workflow step, always
8. MCP scope lock collapsed to `null` on a non-MCP name, silencing *all* discovery
9. live-read source hardcoded `carrier: 'work_call'`, ignoring its own parameter; a step has no `work_call`
10. `exactComposioOperationFromQuery` uppercased the name, claimed it for Composio, refused on "no salesforce connection"
11. `localPlanningRowStatus` returned `unsupported_unmaterialized` before consulting the carrier
12. no `call_tool` dispatcher mounted for a locked step

Failure text walked forward each time — *no tools* → *discovered but not executable* →
*no connection* → *not materialized* → *discovered but not executable* — which is the
signature of one defect with many faces, not many defects.

### Why patching it repeats

Every previous repair **added a spelling** rather than removing the test:

- 2026-09-11 (inbox triage enabled unverified) → added the UPPER_SNAKE branch
- 2026-08-27 (seq 90427, model re-searched while holding the tool) → added the carrier-keeps rule

Both are still in the code. Both failed again on 2026-09-18, one carrier over. The six
commits on `wave/plan-binds-execution-tools` are an improvement — they ask registries
first — but they keep shape as a fallback, so they are the same shape of fix. **A fix
that adds a name or a spelling is the bug wearing a new coat.**

---

## 2. The target shape

The framework already has everything needed to stop guessing. It simply does not ask.

**Carrier is declared, never deduced.** `CapabilityManifestV1` carries
`providerKind ∈ { local_registry, composio, native_mcp, reviewed_cli }` plus `effect`,
`accountId`, and the invoke port. An operation *states* what performs it.

**Discovery answers "what can I use for this?"** The registries that own identity are:
the reviewed-read descriptor registry, the shipped CLI catalog
(`CLI_CATALOG` / `catalogReviewedReadsOf`), and the current callable catalog
(`currentManifestOperationContract`).

**Memory ranks it.** `tool-choice-store` already records `successCount` /
`approvalCount` per choice — what Clem actually used successfully. That is the ranking
signal, not lexical relevance.

So one question, asked one way:

```ts
operationIdentity(name) -> { operationId, providerKind, effect, carrier } | null
```

Nothing downstream re-derives any of those from the string.

---

## 3. The 21 sites, classified

Not all 21 are the same. Two categories, and only one is the bug.

### Category A — legitimately Composio-specific (9 sites): KEEP, but narrow

These ask *"is this a Composio slug?"*, which is a fair question inside a
Composio-only code path. The defect is only when their answer is consumed as
"is this an operation **at all**".

| Site | Question it asks |
|---|---|
| `tools/composio-carrier.ts:95` | Composio slug shape |
| `integrations/composio/client.ts:1986` | normalize an action slug |
| `runtime/harness/auto-remember.ts:59` | remember a composio call |
| `runtime/harness/composio-carrier-completion.ts:64` | settle a composio carrier |
| `tools/pending-action-admission.ts:53` | bare composio action slug |
| `runtime/harness/capability-resolution.ts:491` | resolve a requested composio target |
| `runtime/harness/execution-gate.ts:162,393` | composio read-rule lookup |
| `tools/tool-search-provider-sources.ts:1570` | composio candidate validation |
| `tools/operation-name-identity.ts:91` | a composio slug named in a query **before discovery has seen it** |

**Action:** rename each to say `composio` in the identifier (several already do), and
assert by test that no caller outside a Composio path consumes them. No behaviour
change.

### Category B — universal type tests (10 sites): DELETE, replace with identity

These decide "is this an operation" for *all* carriers, and are the bug.

| Site | What it gates |
|---|---|
| `execution/workflow-enforce.ts:302` | whether a step needs a creation test |
| `agents/workflow-step-agent.ts:232` | whether a lock keeps a carrier |
| `execution/workflow-step-external-catalog.ts:39,40` | whether ports get reconstructed |
| `runtime/harness/callable-surface.ts:80` | what counts as a provider operation |
| `runtime/harness/discovery-boundary.ts:163` | exact-identifier vs natural-language search |
| `execution/workflow-validator.ts:545,941` | structured-call validation |
| `runtime/harness/accepted-source-catalog-scope.ts:33` | accepted catalog scope membership |

**Action:** each calls `operationIdentity(name)` and branches on the **declared**
`providerKind` / `effect`. No regex.

### Category C — presentation (1 site): leave

`runtime/harness/public-presentation.ts:640` decides what may ship as a call's public
identity. Shape here is a privacy conservatism, not a capability decision. Out of
scope; document the exception in-file.

---

## 4. Order of work (each step ships green)

**Step 0 — pin the truth first.**
Write `operation-identity.test.ts` asserting, for one operation of *each*
`providerKind`, that identity resolves and reports the right carrier and effect. This
test must be red for `reviewed_cli` before any Category B change and green after.
Nothing else moves until this exists.

**Step 1 — one owner. DONE (`0d70c7a7`).**
`operationIdentity()` answers from declaration for all four provider kinds, with no
shape fallback of its own. The Step 0 test was red for `reviewed_cli` before it
existed.

> **Correction, found by executing this step.** The plan originally said to delete the
> shape fallback in `operationNamedInQuery` too (`operation-name-identity.ts:91`).
> Trial-deleting it failed a pin: *"a composio slug no registry carries still resolves
> by shape."* That fallback is **load-bearing** — detecting a composio operation the
> catalog has not discovered YET is a real capability, and before discovery, spelling
> is the only signal that exists. It is therefore **Category A**, not B: narrow to
> composio, name it so, never let it answer "is this an operation" for other carriers.
> `operationIdentity` remains fallback-free, which is what matters.

**Step 2 — Category B, one site per commit, in dependency order.**
`callable-surface` → `discovery-boundary` → `workflow-step-external-catalog` →
`workflow-validator` → `accepted-source-catalog-scope` → `workflow-enforce` →
`workflow-step-agent`. Each commit: delete the regex, call `operationIdentity`, pin
with a red-before/green-after test naming the live failure it prevents.

**Step 3 — Category A narrowing.** Rename + caller assertions. Pure hygiene.

**Step 4 — carrier from declaration.**
Remove `PROVIDER_OPERATION_CARRIERS` (`workflow-step-agent.ts`) and the hardcoded
`carrier: 'work_call'` rows in `tool-search-provider-sources.ts`. A row's carrier comes
from its manifest `providerKind` mapped through one table, defined once.

**Step 5 — memory ranks discovery.**
`tool_search` orders candidates by `tool-choice-store` success/approval counts ahead of
lexical score. Exact-identifier hits still lead (already landed in `8dfc612c`).

**Step 6 — the literals.**
108 files is a separate wave. Scope it after Steps 0-5 prove the identity path, and do
it by replacing carrier literals with the Step 4 table, not by find-and-replace.

---

## 5. Guardrails

- **A new regex over an operation name fails review.** Add a `check:` script that
  greps for the UPPER_SNAKE pattern in non-test source and fails on any site not on the
  Category A allowlist. This is what stops carrier number three.
- **Every Category B commit needs a red-before proof.** Demonstrated by temporarily
  reverting the change and showing the test fails — the technique used on
  2026-09-18 for `f06a83e4` and `8a553414`.
- **Never quote a guarded sentence in a comment.** `tool-search-callable-refusal.test.ts`
  locates its guard with `src.indexOf('No returned candidate was materialized')`; a
  comment repeating that string shadows the real one and the pin fails somewhere
  unrelated. Cost one confusing red during Step 0.
- **Run `npm test` in ≤80-file chunks**, plus `npm run journeys` separately; the
  isolated suite excludes `src/journeys/*`.

## 6. Out of scope

- The 108-file literal census (Step 6 — its own wave).
- `public-presentation.ts` (Category C).
- The expired Outlook connection: `composio connections list` shows
  `outlook ['EXPIRED','EXPIRED']` while `googlesheets` and `slack` are `ACTIVE`. That is
  a real credential to reconnect, unrelated to this wave, and it is what
  `daily-standup-email` and `scorpion-inbox-triage` have been blocking on since 09-16.

## 7. What exists already

On `wave/plan-binds-execution-tools` (6 commits, ~4,500 tests green, unpushed):
`2afa112c` citations · `c97585b5` inheritance · `f06a83e4` creation-test gate ·
`8a553414` carrier retention · `8dfc612c` exact-id ranking · `fc3d78af` the probe.

Uncommitted in the tree: layers 7-12 (planningIdentity, MCP-scope fallback, carrier
honoring, Composio claim-skip, `localPlanningRowStatus`, locked dispatcher). These are
correct in direction but are Category-B-shaped patches; fold them into Step 2 rather
than shipping them as-is.

`scripts/probe-friday-leadership-creation-test.mts` is the instrument. It runs the real
authoring + creation-test path against the real `sf` CLI and model in an isolated
`CLEMENTINE_HOME`, touching no live data. Use it as the acceptance test for this wave:
the workflow completing end to end is the definition of done.
