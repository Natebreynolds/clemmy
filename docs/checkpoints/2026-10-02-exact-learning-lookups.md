# Exact learning lookups — 2026-10-02

Continues the owner's database-efficiency goal alongside the premium-UX work.
This wave removes whole-session loading from learned-read proof lookup. It is
not a new memory system, an authorization shortcut, a retention policy, or a
claim that raw learning evidence can now be deleted. No production rows were
changed and no model calls were made.

## Change

Schema 91 adds three non-unique, partial event indexes: receipt identity,
receipt accepted source, and settlement accepted source, each ordered by seq
inside its exact session. They contain lookup keys, not copies of transcripts
or returned payloads. Existing duplicates and event bytes remain unchanged.
The migration builds indexes once; its cost on the live database remains to
be measured during controlled installation, not assumed free.

Four shared event-log lookups replace repeated `listEvents(sessionId)` calls:

- Exact receipt ID returns at most two witnesses. Canonical learning requires
  exactly one; duplicates remain ambiguous. The legacy resolver retains its
  original first-record behavior for noncanonical IDs.
- Exact accepted source loads its user event by the sequence primary key,
  with session and event-type checks; never a latest-message fallback.
- Settlement lookup walks the indexed accepted source newest first, stopping
  at the nearest matching tool before the receipt. It returns failures too,
  so an older success cannot displace a later failed settlement.
- Legacy alias recovery without a receipt ID loads only the exact source's
  receipt events, newest first. It does not truncate them or substitute a
  procedure-wide provenance claim.

Consumers are the learning worker's durable-receipt check, receipt resolver,
canonical receipt/result-shape validator, alias-origin recovery and accepted
source resolver. Account, schema, evidence digest, exact source/attempt,
accepted task, effect, dispatch state, result cleanliness, complete-set shape
and live-contract checks remain at their existing authority boundaries.
Actual result-shape verification still redeems the exact result bytes. This
wave does not replace that verification with remembered prose.

## Traps pinned before commit

SQLite initially chose the broad session/type index for the settlement query,
even with the expression index present. Bind these lookup queries to their
schema-owned indexes and assert the actual captured SQL plans use them with
no table scan or temporary sort. A missing required index refuses the lookup
instead of silently reverting to a whole-session scan.

SQLite `lower()` folds ASCII only; the historical verifier uses JS Unicode
case folding. Keep tool matching in JS while iterating the indexed source.
SQLite JSON booleans also become 0/1. Recheck typed source equality in JS so
`true` cannot impersonate source sequence 1. Exact user-input matching keeps
the text-type guard; numeric text cannot be coerced into an alias proof.

The first test draft tried to insert malformed JSON through an existing schema
that already evaluates JSON in its older index/trigger paths. That was an
invalid fixture setup, not a storage regression. The final isolation pin uses
a valid, large unrelated body and a parser sentinel that fails if a lookup
hydrates it. Historical incomplete receipt records and duplicates are pinned
through the actual v90-to-v91 migration without changing their bytes.

## Evidence

Five new pins passed: exact/cross-owner source resolution, duplicate refusal,
Unicode and typed identity, newest-failure and receipt cutoff, unrelated-body
isolation, actual index query plans, and migration preservation/integrity.
The earlier 127 related event-log, receipt, learning, source-selection, worker
and held-startup regression cases passed. After the final typed-source guard,
19 checks passed, including the new pins, legacy source selection, held-child
cutover and v3.14 upgrade rehearsal. Typecheck passed. These checks overlap;
do not add their totals as unique coverage. Logs are under ignored
`output/storage-efficiency/`.

Matched controlled benchmark: one disk-backed long session with 10,000
unrelated 2-KiB result events plus one exact source, settlement and receipt.
Compared the original modules from `c968e6103` with the new modules on the
same database, alternating order across 16 trials after warmup. Every trial
returned identical verified receipt, alias match and source phrase.

| Combined lookup | Before | After |
|---|---:|---:|
| Median wall | 70.159 ms | 0.088 ms |
| Worst/p95 of 16 | 83.714 ms | 0.153 ms |
| JSON rows opened per trial | 20,007 | 4 |
| JSON bytes parsed per trial | 41,921,407 | 717 |

This is lookup-component evidence on a controlled fixture, not live response
latency, token savings or physical disk reclamation. Zero model calls and zero
production writes. Script, retained original modules and measured JSON are in
`output/storage-efficiency/exact-lookup-benchmark.*`. The full suite previously
ran at `305bc3d40`, not this newer runtime wave; its historical result does not
qualify schema 91. The runner's live-home sentinel remains NOT PERFORMED while
the real daemon owns the home.

## Integration still owed

The prior clean candidate included premium-UX through `2ed7effc3`; recheck that
lane before integration. Commit and rebuild this wave, then qualify the new
combined source, coordinate one guarded Terminal/signing install and confirm
the served source/fingerprint/schema. No main mutation, tag, hotpatch or idle
conversion activation has happened in this wave.

Installed/live-home acceptance remains mandatory: desktop/phone storage,
old/new exact histories, controlled old-row conversion/reopen, long-task and
completed-write recovery, and learned-tool retrieval with identical scope and
proof after a long session. Only then activate the idle converter and measure
backlog reduction and separately qualified physical reclamation. Compact
certified learning before dependency-aware raw expiry is a later requirement;
these indexes reduce lookup work but still depend on durable raw proof.
