# Shared exact model histories — 2026-10-02

This follows the storage audit and first snapshot/UI wave. Owner's active goal:
continue reducing database bloat, then merge with the other agent when done.
No production history has been migrated or deleted. This is a source candidate,
not an installed-app acceptance receipt, and it must not be called tagged.

## Representation

Schema 89 adds immutable `accepted_model_history_objects_v1` and nullable exact
object references to admissions and checkpoints. Large compressible histories
are encoded once with DEFLATE and addressed by SHA-256 of their original UTF-8
JSON bytes. Identical predecessor-checkpoint and successor-admission histories
reference the same object, including across source rows. Each original source
retains its own task identity, authority, graph binding, digests, item counts,
response chain and receipts. A shared byte object grants no cross-source access
or execution authority; there is no model-facing object lookup endpoint.

Small histories stay inline. Histories above the 32 MiB codec limit and
incompressible histories also stay inline. This is a representation choice, not
a new task-size gate. New reference-bearing rows have an explicit empty inline
slot and a foreign key to the object; they do not contain magic placeholder
messages. Insert triggers bind each reference to its exact source digest and
original item count. Objects cannot be updated; referenced objects cannot be
deleted. Publication is inside the owning immediate transaction and rolls back
if admission or checkpoint publication fails.

The additive migration leaves old rows byte-for-byte unchanged. It is idempotent
for sanctioned schema rehearsals that repeat migrations against an already newer
store. Runtime readiness now requires a contiguous schema through 89. A pre-89
daemon is not a qualified rollback reader for reference-bearing histories.

## All history consumers

Readable views expose the original JSON column names, materializing referenced
objects through one registered SQLite decoder. The decoder validates bounded
inflation, complete compressed-stream consumption, original byte length, SHA-256
against the **source row's expected digest**, exact UTF-8 and original item count.
Missing or corrupt content raises; it is never empty successful context.

The following runtime consumers use those views:

- Admission reopen, checkpoint reconstruction, publication and restart.
- Logical result projection receipts and `json_each` grounding in request
  provenance, including exact nested-carrier output versus raw inner output.
- Source connection pause proofs.
- Async read refinement storage/recovery.
- Local completion and host workspace derivation.

The underlying owner tables remain authoritative for FK/trigger topology and
retention. Existing constraints, source/account/tool authority and completed-write
reconciliation remain in place. Raw SQLite diagnostic clients must register the
decoder before querying the readable views; reading the underlying tables shows
storage slots, not materialized history. The daemon registers it through the
schema authority on every connection it opens/migrates.

## Measured sample

Read-only sampling paired 32 recent live successor admissions with their
immediately previous checkpoint when the original digests matched. Ninety-six
histories (pre-history, frame and prior checkpoint per pair) were encoded and
verified in an in-memory schema-89 fixture. No live rows or credentials were
changed, and no model was called.

| Metric | Measured |
| --- | ---: |
| Original repeated history bytes | 3,207,546 |
| Unique compressed objects | 25 |
| Encoded object bytes | 427,211 |
| Remaining inline history bytes | 369,536 |
| Source reference bytes | 3,200 |
| New logical payload bytes | 799,947 |
| Logical payload reduction | **75.06%** |
| Encode, reuse and verify sample | 41.35 ms |

This excludes B-tree/index overhead, object metadata and physical disk
reclamation. It is neither a whole-database savings forecast nor a matched
installed latency result. It also is not a token-saving claim: the brain sees the
same restored bytes. The reproducible script and JSON are in the worktree's
ignored `output/storage-efficiency/history-benchmark.*`.

## Verification

- Initial accepted batch/process/provenance regression set: 124 passed.
- New object/reopen integration plus existing checkpoint cases: 119 passed.
- Consumer regression set: 158 passed across checkpoint/process recovery,
  workspace derivation, local completion, memory context and schema rehearsals.
- Reader, migration reapplication, logical projections and schema readiness:
  15 passed. Four v69 rehearsal failures found in the first pass were caused by
  non-idempotent additive schema creation; the fix and explicit reapplication
  pin passed. They were not labelled pre-existing.
- All eight logical projection tests passed again after adding an assertion that
  the nested-result compaction/grounding case really uses compressed history.
- Source-owned digest substitution, corrupt content, immutable updates,
  protected deletion, SQL `json_each`, publication rollback, legacy inline reads
  and large-history reopen/reuse have explicit pins.
- Backend typecheck passed before final documentation/build; repeat against the
  final combined commit. Test fixture homes supplement production acceptance.
  The runner sentinel was not performed with an active live daemon.

## Existing data and next work

This reduces **new** database growth; it does not shrink today's 6.36 GB DB.
The old rows are append-only and remain untouched. Do not run an arbitrary
UPDATE, drop an immutable trigger, rewrite encrypted files under their committed
hashes, or enable broad age deletion to make the size number fall.

The next step is a sanctioned, restartable representation-only conversion. Its
schema must permit only a verified exact-byte transition from inline history to
an immutable object while every semantic column, source digest, count and owner
binding remains unchanged. Give each batch a durable cursor and a byte/work
budget. Pin interruption, concurrent publication, malformed data and reopen
before running even a controlled live conversion. Expose dry-run estimates
first. Physical SQLite reclamation requires a separate qualified cutover or
VACUUM procedure with sufficient space; this DB has auto_vacuum=0.

After that, separate compact certified tool-learning evidence from bulk historical
payloads before dependency-aware retention. Keep current tool/account/schema
re-attestation. A remembered tool success must not become permission to execute.

## Integration and installed acceptance

The other premium-ux lane continued beyond 1eee0ee6b to bfd3eaefa while this work
ran. Do not overwrite its newer app or assume that its release tag contains this
uninstalled source. Combine only final reviewed commits, build daemon and both
frontends, record the resulting SHA/fingerprint, then coordinate one installation.

Required controlled installed/live-home acceptance: old inline and new compressed
history reads; forced compaction and reopen with correction/approved plan; long
fan-out result identity; completed-write replay prevention; current tool/model/
account routing; completion review truth; storage Settings on desktop and paired
phone. Measure all calls/tokens and restore/response latency on matched work.
These gates remain owed even with green fixture tests.
