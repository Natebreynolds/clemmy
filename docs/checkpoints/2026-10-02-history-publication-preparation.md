# Exact history preparation outside the writer lock

## Defect and resulting behavior

The schema91 installed converter did UTF-8 encoding, JSON parsing, hashing,
compression and exact decompression inside `BEGIN IMMEDIATE`. The existing
50ms work limit only yields between rows. A10.84MB retained history took587ms
in the earlier private in-memory characterization, excluding disk/WAL I/O.
Starting the worker on a separate thread did not free its SQLite writer lock.

The converter now reads cursor, next row, body and any existing encoded object
in a short deferred snapshot. It closes that snapshot, prepares or independently
verifies a private encoded copy, then acquires the writer lock. It rechecks the
cursor, numeric row ordering, representation, source proof and foreground work.
Object insertion, source reference and cursor still publish in one transaction.
A competing converter causes a fresh read; writer contention is deferred rather
than recorded as damaged evidence. Damage stays blocked at the original cursor.

The unchanged schema90 SQL fence still compares exact decoded object bytes
against the **current** OLD source JSON and protects every semantic field and
hidden rowid. Publication avoids copying that large body into JavaScript again.
There is no authority granted by preparation or by a history reference.

## Exact verification without repeated codec work

Preparation fully validates the encoded stream using the ordinary strict reader:
bounds, codec, consumed stream length, exact UTF-8, SHA256, JSON array and count.
The validated BLOB remains private behind an opaque frozen handle. Existing
objects are verified and copied without recompression; caller buffer mutation
cannot change the prepared bytes.

During one synchronous publication scope on one connection, the SQL scalar can
return that verified text only if its actual BLOB **byte-for-byte** matches the
private copy and codec, plaintext length, digest and count all match. A different
BLOB, encoding, stream suffix or metadata falls back to the complete strict
reader. Source-byte equality remains enforced independently by the SQL fence.
This witness is released after success or exception; ordinary subsequent reads
decode afresh. It is not a model/tool result cache, proof-by-metadata shortcut,
learned permission, account-routing change or weakening of any approval gate.

Ordinary new-admission/checkpoint storage still uses its existing path. No SQL
schema change, provider call, task-size gate, retention policy, deletion, native
shell change or physical reclamation command is introduced.

## Evidence and limits

Two real-connection foreground/cursor tests failed on the original converter.
A separate strict-codec test failed while verification still ran under the
writer. Final pins cover foreground arrival during preparation, concurrent
cursor advancement, same-length source damage with unchanged declared proof,
object/source/cursor rollback, substituted metadata/BLOBs/trailing streams,
private-copy ownership, reuse without recompression, exception cleanup, numeric
rowids and reopen/readback. Source logs and receipts are under
`output/storage-efficiency/` in the storage worktree.

Actual immutable live-home history bytes were read through the installed native
decoder and checked against the complete watermarked manifest. Conversion ran
only in private in-memory SQLite with the installed native driver. Three
alternating pairs per case, after the broad suite process ceased:

| Case | Installed writer median / maximum | Candidate writer median / maximum | Total median, installed → candidate |
| --- | --- | --- | --- |
| New object |537.267 /551.557ms |48.369 /52.270ms |537.497 →545.379ms |
| Existing object |383.492 /393.035ms |50.026 /57.136ms |383.680 →234.527ms |

The source was10,837,989 bytes; the encoded object was7,791,256 bytes. Exact
readback passed every case; existing-object insertion added0 encoded bytes.
Model calls0; production rows changed0. The immediate span includes acquisition,
body and commit in the private memory DB. This is characterization of actual
retained bytes, **not** production disk/WAL contention, a causal user-visible
latency benchmark, installed acceptance of these new modules, or SSD savings.
Candidate modules were narrowly transpiled for the probe, not a release build.
The50ms deadline remains cooperative; it is not a hard per-row ceiling.

Receipts bind module source hashes and installed source
`37a66130c3099d678a280dd8998b5e05376d9ef6`, fingerprint
`9a2a520582394c58b8e7b9445a7eb5a067fce0866ab2cd708ef12d21bde2c0a7`,
schema91. That installed source contains d02e75466 and leaves automatic backlog
conversion unscheduled. Earlier pressure, failed identity attempt and red-pin
logs are retained; later measurements do not erase them.

## Integration and acceptance still owed

The other agent owns all installation/signing/release actions. Do not place an
unreviewed scheduling commit under its current tag. Review and rebuild the exact
final combined source; prior d02 suite receipts do not qualify later runtime
changes. The preparation fix is independently cherry-pickable from the earlier
cadence commit; picking it alone does not activate maintenance.

Before enabling automatic conversion: qualify the compiled worker, simultaneous
foreground admission during large preparation/publication, normal and maximum
representation sizes, actual installed single-flight/yield/reopen behavior,
plans/corrections/pending approvals and absence of completed-write replay. Then
measure the backlog reduction and reusable pages separately from actual SSD
reclamation. Restore/backup/headroom and quiescence must be proven before any
physical rebuild; never restore an old snapshot over later accepted user work.

The remaining structural storage goal is exact shared history segments/deltas
and independently verified learned-tool certificates before bulky evidence may
expire. Whole-history compression alone does not eliminate unique-prefix growth.
No memory-quality or model-token win is inferred from these storage measurements.
