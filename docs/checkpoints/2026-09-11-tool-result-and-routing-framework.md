# FRAMEWORK — Tool results are artifacts; routing is the host's job

Design agreed with the owner 2026-09-11. Not built yet. Build order in §5.

Everything below is measured from the live eventlog (2026-09-04 → 09-11) and the
real `~/.clementine-next` tree, not inferred.

---

## 1. The thing nobody had noticed: two of the three tiers already exist

| tier | where it lives | count | durable | cross-session | navigable |
|---|---|---|---|---|---|
| tool **shapes** (input schemas) | `memory/tool-contracts/<machine>/` | **2,000 JSON** | yes | yes | by slug |
| tool **choices** (procedural) | `memory/tool-choices/<machine>/` | **489 markdown** | yes | yes | by intent slug |
| capability index | `memory/capability-index/<machine>/capabilities.db` | — | yes | yes | yes |
| tool **results** (the data) | SQLite `tool_outputs` | **8,053 rows** | **14-day TTL** | **no** | **`call_id` only** |

A tool-choice record already has the shape the owner described, success counts
and all:

```yaml
intent: create google doc and batch update insert inline image and text
choice:
  identifier: GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN
  successCount: 13
  lastSuccessAt: '2026-08-18T19:46:00.761Z'
fallbacks: []
```

**Results are the only tier that is ephemeral, session-locked, and addressable
only by an opaque id the model must have personally witnessed in a
`[clipped: …]` stub.** That asymmetry is the whole problem.

`searchToolOutputs`, `recentToolOutputs`, `getToolOutputSlice` — every read is
`WHERE session_id = ?` (`src/runtime/harness/eventlog.ts:6528`, `:6588`,
`:6944`). `reapStaleToolOutputs` defaults to 14 days (`:6665`).

---

## 2. What the week actually measured

| | |
|---|---|
| discovery + memory calls | 1,758 |
| turns that searched | 304 |
| …that never ran a business call | **165 (54%)** |
| …that issued a **byte-identical** repeat query | **150 (49%)** |
| worst single turns | 23 searches / **1 distinct query**; also 17/1, 15/1, 15/1, 13/1 |
| discovery governor verdicts | **752 admitted / 9 denied** (98.8%) |
| …admitted with `knownCapability: true` | **293 (38%)** |
| `recall_tool_result` + `tool_output_query` | **642** calls pulling parked payloads (correct behaviour, not waste) |
| `tool_choice_recall` | **3** calls all week |
| memory-using turns opening 2+ memory doors | 23 of 68 (**34%**) |

Two conclusions follow directly.

**Clipping was a false lead, and this is the correction.** An earlier draft of
this document claimed 65% of `tool_search` results were clipped and that
clipping "cuts the answer". Both were wrong, and the error is instructive: the
`[clipped: …]` cap at `hooks.ts:635` is inside `appendEvent(type:
'tool_returned')` — it bounds the EVENTLOG's stored copy at 8,000 chars, not the
model's context. The full payload goes to `tool_outputs`.

Pulling the full 15,469-char payload for the live 2026-09-11 failure settles it:
it contains **no `GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT` at all**. Twenty results
across three pages, every one a built-in. Clipping never cut the answer; **the
answer was never in the result.** Reading a truncated observation as a truncated
model input is exactly the trap in §4.3 of the 09-11 plan-mode handoff.

What is real: the recall behind the stub is **session-locked and expires in 14
days**, and the 642 recall calls are the model correctly pulling parked
payloads, not waste.

**Prose does not route.** `tool_choice_recall`'s own description says "CALL THIS
FIRST before reaching for composio_search_tools". It was called 3 times against
813 searches. 489 procedural records exist and are consulted essentially never.
The memory is not missing; nothing routes to it. Routing must be structural —
the host consulting the index, not a sentence asking the model to.

---

## 3. Design decisions (owner, 2026-09-11)

1. **The result folder is a PROJECTION.** SQLite `tool_outputs` stays
   authoritative — it carries attestation and the write-verification chain.
   The folder is a navigable mirror written alongside it. Additive; no existing
   authority moves.
2. **The index crosses sessions; payloads stay scoped.** A durable searchable
   index of result summaries + paths is readable from any session by the same
   principal. Fetching a full payload from a different session is an explicit
   second step, so old conversations do not bulk-bleed into a new turn's
   context.
3. **Keep the index forever; LRU the payloads.** Summaries and paths are small
   and kept indefinitely — she always knows a result existed even when the bytes
   are gone. Payloads bounded by a size budget with least-recently-used
   eviction, replacing the flat 14-day delete.

---

## 4. The framework

### 4.1 Results become artifacts

```
~/.clementine-next/runs/<run-id>/
  index.md                       one line per result: seq, tool, subject, bytes, path
  results/<seq>-<tool>-<subject>.json
```

Written as a projection of `tool_outputs` on settle. `file_query` already reads
files (99 calls/week), so the read path exists on day one.

### 4.2 Semantic addressing

A result must be findable by **run + tool + subject + time**, not only by a
`call_id` the model had to witness. This is what makes "the Salesforce pull from
last Tuesday" a thing she can reach without having been in that conversation.

### 4.3 A search that names an operation must be able to return it

Measured across 694 stored `tool_search` payloads (2026-09-04..11):

| | |
|---|---|
| searches returning **any** provider row | 397 of 694 (**57%**) |
| queries naming an **exact** provider slug | 114 |
| …where that slug was **not** returned | **38 (33%)** |
| …of those misses, results with **zero** provider rows | **37 of 38** |
| miss-turns where NO search in the whole turn returned a provider row | **18 of 27 (67%)** |

```
q="GOOGLESHEETS_INSERT_DIMENSION"
got  agent_run_get, agent_runs_recent, answer_check_in
```

This is **not a ranking failure** — the ranker never saw the operation. It is a
SOURCING failure: for those turns `tool_search` could not return a provider
operation at all. `queryExplicitlyNamesTool` (`tool-jit.ts:149`) is a boundary
regex and matches fine; the exact-name path at `tool-search-tool.ts:1138` checks
provider candidates too. Both are irrelevant when `sourceCandidates` is empty.

The structural candidate, read in code at `orchestrator.ts:3523`: when
`carrierWork` is false, `buildScopedLocalToolSearch(discoverableNames,
'call_tool')` attaches **no candidate sources and no planning disclosure**.
NOT yet proven at runtime — see §5 move 1.

### 4.4 The host routes, the model does not

Before any discovery door opens, the host consults procedural memory and the
capability index. The governor already computes `knownCapability` (true on 38%
of admitted searches) and **does nothing with it**. A byte-identical repeat
inside one turn should return the prior answer plus any refs staged since, and
cost nothing.

### 4.5 Subtract doors

Four discovery doors (`tool_search`, `composio_search_tools`, `mcp_list_tools`,
`local_cli_list`) and five memory doors (`memory_recall_all`, `memory_search`,
`memory_search_facts`, `session_search`, `session_history`) over three stores.
34% of memory-using turns open 2+ doors because the model is choosing an index
instead of stating an intent. Collapse toward one discovery door with a provider
filter and one `recall` with a scope argument.

---

## 5. Build order

Smallest first; each is independently valuable and independently shippable.

| # | move | new storage? | why first |
|---|---|---|---|
| 1 | **Make provider-blindness visible** (§4.3) | none | DONE — two fixes were aimed wrong before this was measurable |
| 1b | **Fix whichever §4.3 turns out to be** | none | attach sources where missing, or fix the broker for exact-slug queries |
| 2 | **Host consults procedural memory before a discovery door** (§4.4) | none | 489 records already exist; makes routing structural instead of prose |
| 3 | **Free, answer-bearing repeat inside a turn** (§4.4) | none | kills the 49% byte-identical repeats; governor already has the signal |
| 4 | **Cross-session result index** (§4.2, decision 2) | index only | the "every session" fix |
| 5 | **Run folder projection + LRU** (§4.1, decision 3) | folder | the navigable shape; replaces the 14-day reaper |
| 6 | **Subtract doors** (§4.5) | none | do last — it moves surfaces the earlier moves depend on |

1–3 need no new storage at all and address every number in §2 except the
session-locking. 4–5 are the storage work. 6 is the subtraction, deliberately
last so it does not churn surfaces mid-build.

---

## 6. Seams

- clipping: `src/runtime/harness/compaction.ts:204` (the stub), and whatever
  budgets the result body before it
- recall: `src/tools/recall-tools.ts` (`recall_tool_result`, `tool_output_query`)
- result store: `src/runtime/harness/eventlog.ts:6183` `writeToolOutput`,
  `:6528` `searchToolOutputs`, `:6944` `getToolOutputSlice`, `:6665`
  `reapStaleToolOutputs`
- procedural memory: `src/memory/tool-choice-store.ts` (`recallToolChoice:1062`,
  `rememberToolChoice:1221`)
- discovery governor: the `discovery_governor_decision` emitter — it already
  carries `knownCapability`, `replay`, `consumedBudget`, `allowance`
- staging → callable: `src/tools/tool-search-provider-sources.ts`
  `stageDisclosedPlanningProviderCandidates`

## 7. What shipped today, and why it is only half of move 2

`948709c8`, `0a1c7da5`, `52b3da74`, `09ed086c`:

- Composio discovery now stages callable entries (was: a door that could never
  produce a callable operation — 0 `capability_resolution` events in the failing
  session; 7 in the next run, with zero `candidates=0` refusals)
- a model-guessed account is discarded rather than reported as disconnected
- the tool-free check-in survives an authority conflict instead of returning
  0 bytes
- the search now reports what staging proved

**The last of those is prose in a tool result.** It is the right content and it
tells the truth, but it is the same weak mechanism as the
`tool_choice_recall` line that gets ignored 810 times out of 813. If it works,
it works because the model cooperated. **Move 3 is the durable version** — it
does not need the model's cooperation at all.


---

## 8. Move 1 status (2026-09-11)

`tool_search_scope` now records `providerSourceCount`, `providerSourceKinds`,
`planningDisclosureWired` and `carrierWork` (`orchestrator.ts`, pinned in
`src/agents/tool-search-surface.test.ts`). Telemetry only — nothing about what
is searched changed.

This is deliberately instrumentation rather than a fix. Two "obvious" fixes were
aimed wrong in one session:

1. **Clip by relevance** — the clip was the eventlog's own copy, not the model's
   context. Withdrawn in §2.
2. **Fix ranking** — 37 of 38 misses had zero provider rows; the ranker never
   saw the operation. Withdrawn in §4.3.

Both were plausible from a truncated observation and wrong against the full
payload. **Read the stored `tool_outputs` row, not the `tool_returned` event,
before concluding anything about what the model saw.**

Next: read the new fields off a live turn, confirm or kill the `carrierWork`
hypothesis, then fix the lane that is actually blind.
