# Exact conversion of existing history — 2026-10-02

Owner's active goal: keep refining the bloated DB and merge with the other
agent when done. This wave implements the converter for existing admissions
and checkpoints. It has not changed any production history, installed an app,
merged onto main, or tagged. It follows the storage audit and the two preceding
storage checkpoint documents. Default history retention remains unchanged.

## Why this approach

The audit measured about 4.31 GB of repeated inline accepted histories, plus
6.32 GB of sealed request snapshots. These histories support recovery, exact
result grounding, review and learned tool evidence. Arbitrary age deletion would
break those dependencies. Exact compression/sharing reduces representation
cost without changing the model's restored context, permissions or task proof.
It does not itself save model tokens. The samples are not a monthly growth
forecast for a typical user.

Schema 89 addressed new history writes. Schema 90 adds a sanctioned conversion
for old rows, so the existing backlog can be reduced too. It replaces the two
unconditional source UPDATE fences atomically with stricter storage-transition
predicates. Every semantic column, including digests, counts, source, response,
authority, graph and times, must remain `IS` identical. Hidden rowid must also
remain identical. Each history pair either stays identical or changes from a
NULL object ref to an immutable object ref with the inline slot exactly `[]`.
The decoder must reproduce the **exact original UTF-8 bytes**, source digest
and item count. The migration does not drop DELETE protections. No-op updates,
content corrections, alternate refs, downgrade to raw storage and changes to
task evidence remain forbidden. Future migrations adding semantic columns must
regenerate these predicates to protect those new columns too.

This is a storage-format migration, not a general repair permission. A shared
object grants no access or execution authority and is not model-facing.

## Bounded and restartable

`convertAcceptedModelHistoryBatch` takes one of three lanes and explicit row,
input-byte and elapsed-time budgets. Defaults are four scanned rows, 4 MiB
raw input, and a 25 ms cooperative deadline. Time/row budgets yield between
rows; the byte budget is hard before admitting a body. A compressible-size
row exceeding the remaining byte budget is reported, not skipped. Codec bounds
remain 32 KiB–32 MiB. Outside those bounds, or if compression cannot save space,
the row stays inline; that does not restrict task execution.

SQLite `octet_length` inspects stored byte lengths without materializing the
body. Durable per-lane cursors retain counts, logical bytes removed, object
bytes added, state and a blocked rowid. Rowids are ordered numerically; reporting
them as text preserves integer precision. A sample found and pinned the initial
text-ordering bug before any production application.

Each row runs in an immediate transaction: reobserve cursor/source, publish or
reuse object, validate the storage transition, then advance cursor. Failure
rolls all of that back. A damaged row marks its lane blocked without exposing
payload text, and does not advance. Explicit retry can resume it; unrelated
lanes can continue. A concurrent writer must acquire the same SQLite writer
lock before observing/advancing the cursor. Reopen and subsequent calls are
idempotent. Caught-up lanes can inspect later appended rows.

The converter is not wired into the daemon's automatic maintenance yet. That
requires installed-app qualification and an idle scheduling policy, especially
for unusually large rows. No startup migration compresses gigabytes of data.
An in-process call must not nest inside a long outer transaction that changes
the intended per-row commit boundaries.

`scripts/inspect-model-history-storage.mts` is an argument-free read-only
inspection command. It does not migrate schema, apply conversions, access
credentials or call models. It samples the next 32 rows per lane and reports
allocated/reusable DB pages. It is not a whole-DB savings estimate. It works
against pre-89 stores too.

## Evidence

Nine new converter pins passed, including exact whitespace/Unicode bytes,
all fixture semantic columns, hidden rowid, substitution, count mismatch,
ref replacement, downgrade, publication/cursor rollback, corruption,
independent connections with an actual competing writer lock, reopen,
negative/numeric rowids, and atomic migration rollback to the original fence.
The initial object/converter/schema set passed 15 cases before the final
numeric-order pin; the final converter set passed all nine.

The existing batch/checkpoint and logical projection regression run passed 124
cases. The conversion/consumer/process/schema set passed 34 cases before the
last ordering pin; the final nine converter pins were then rerun. Typecheck
passed. These are fixture checks, not production acceptance. The test runner
correctly reported its live-home sentinel as **not performed** while another
daemon owned the changing home. Do not describe this as a certified full-home
isolation result. No model calls were made.

A read-only production sample copied the first 32 admissions and first 32
checkpoints into memory with all original column names. The converter ran on
those 64 source-shaped rows, and all original columns were compared exactly
through the restored views afterwards. Cross-table execution FK roots are not
recreated in this sample, so it supplements the real recovery pins rather than
replacing them. No sampled contents were written to the report or disk.

| Measurement | Result |
| --- | ---: |
| Histories converted | 11 |
| Original converted input | 845,587 bytes |
| Inline bytes removed | 845,565 bytes |
| Encoded object bytes added | 192,764 bytes |
| Reference bytes added | 704 bytes |
| Net logical payload reduction | 652,097 bytes |
| Batches | 27 |
| Largest measured batch | 5.36 ms |
| Total sample conversion time | 31.47 ms |

These are in-memory measurements, exclude indexes/metadata and disk reclamation,
and are neither a latency comparison nor a whole-database savings forecast.
The reproducible script/logs live under ignored `output/storage-efficiency/`.

## Integration and acceptance still owed

The other branch was clean at `2ed7effc3`, carrying the saved-agent project and
local-worker fixes; clean does not prove its owner has finished. The served app
was separately verified at `bfd3eaefa5158d80c5b14825e1ef9dbadd4f2843`, fingerprint
`45df3d06400cdea622d30c82b08a727fd4abf454091bf1c643db269447b76037`, schema 88,
PID 64188. Source, build, installed identity and live acceptance are different
states. Recheck the other lane before combining, never overwrite a newer app,
and respect installation coordination and quiet hours.

Rebase/combine final reviewed commits, build daemon and both frontends at the
clean combined revision, then use the coordinated guarded Terminal/signing
recipe. First qualify schema/readers against named controlled fixtures in the
installed app/live home: old/new history, long approved plan and correction,
forced compaction/reopen, fan-out identity, current model/tool/account routing,
review truth and no replay of completed writes. Then convert a small controlled
legacy fixture, verify exact restored proof after reopen, and measure DB/restore
latency before any broad backlog conversion. Storage Settings needs real
desktop and paired-phone acceptance too.

Logical conversion frees reusable SQLite pages; it does **not** shrink today's
physical DB automatically (`auto_vacuum=0`). Do not claim bytes removed from
inline JSON as disk space freed. Physical reclamation needs a separately
qualified idle/cutover procedure with sufficient space and recovery checks.
Existing sealed files cannot be rewritten under their committed file hashes.

Next architecture work: bounded collection of genuinely unreferenced objects;
compact certified learning projections and indexed exact receipt lookup before
raw transcript/result expiry; then bounded shared history segments if whole
history objects still produce excessive growth on long tasks. Avoid recursive
delta chains or using remembered success as current permission. Expose allocated
versus reusable space and maintenance progress truthfully in Storage; preserve
the quiet desktop/phone Settings presentation already implemented.
