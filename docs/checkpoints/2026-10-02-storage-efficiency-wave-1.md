# Storage efficiency — first lossless wave, 2026-10-02

Owner mandate: reduce database growth without losing chat continuity, long task
recovery, approvals, completed effects or learned-tool efficiency. Work alongside
the premium-ux agent, then combine reviewed work before installation. No live
data was deleted or migrated during this wave; no model calls were made.

## Source and installed identity

Worktree: `.codex/worktrees/storage-efficiency/clementine-next`, branch
`codex/storage-efficiency`, initially based on `claude/premium-ux` at b13d2a29f.
The other lane advanced to 1eee0ee6b while this work ran. Its files and live app
were not overwritten. A final integration record must identify the combined
commit and source fingerprint after building; this document is not an install
receipt.

Read-only GET `/api/console/build-info` during this wave reported daemon
source 1eee0ee6b64e058a685e679d1f4ab595d395bd9b, fingerprint
1e93e65e72dbdbd038db6989a8f2ed4ae41595bbdeda2ff03b2def4f6e5f0e27,
schema 88, PID 45556. Native shell version was still 3.18.24: neither that version
nor a disk stamp is an authority for the served daemon's source. This storage
patch was not installed at that measurement.

The detailed prior audit is in the primary checkout's ignored output:
`output/storage-review-2026-10-02/REVIEW.md` and associated metrics. Most bloat is
execution representation: 4.310 GB of repeated admission/checkpoint histories
and 6.316 GB of owned encrypted request snapshots. Fact content itself was
846 kB; the whole memory DB was 141.67 MB. These are this heavily tested home's
measurements, not a typical user's monthly growth rate.

## Implemented

New model-request snapshot chunks use lossless DEFLATE before their existing
AES-GCM seal when it saves space. Incompressible chunks retain the original raw
codec. Signed URLs, manifests and provider returns retain their representation.
Original bytes, hashes, binding, chunk partition and published file reference
remain authoritative. The reader accepts old raw chunks and authenticated v2
compressed chunks, checks original hashes and lengths, and rejects unknown
codecs, changed binding, trailing streams and oversized inflation. Compression
is bounded by the existing 12,000-byte plaintext chunk; it does not introduce a
new task-size gate. Atomic publication and single-link/permission requirements
are unchanged. Identical replay adopts the original published file, even when
that file uses the legacy raw format.

The v1 outer file/reference envelope is retained; v2 names the authenticated
chunk protocol. New compressed chunks require the new reader. Older binaries
fail closed on them: do not promise a rollback to a pre-codec reader once new
snapshots exist. Existing files are not rewritten because their exact sealed
file hashes are already committed to provenance. Compression of future writes
does not reclaim today's DB or snapshot files.

Settings now has Storage on desktop and phone. It reports host file sizes for
conversations/run records, encrypted execution evidence, memory/learned tools,
backups, runtime/tool caches and other files. It discloses neither paths nor
contents. Both endpoints use their existing console or paired-device authority.
Caller query parameters cannot redirect the scan. The phone labels these as
computer storage; it does not claim to measure the phone's local storage.

The scanner performs asynchronous metadata reads in batches of eight. One
in-flight scan is shared, results are cached for two minutes, and each scan is
bounded to 100,000 entries/eight seconds. It measures canonical stores before
large software caches, skips symbolic links and counts hard-linked files once.
Partial results are visibly lower bounds, and inaccessible roots are unavailable,
not successful zero-byte results. Settings has no delete action.

## Measurements and verification

Sixteen recent live checkpoint histories were read through a read-only DB
connection, then round-tripped using a disposable encryption fixture. Only
sizes/timings were saved, never the history text or production vault keys.

| Metric | Measured |
| --- | ---: |
| Original sample bytes | 722,392 |
| Legacy encrypted representation | 1,789,743 |
| Compressed encrypted representation | 775,063 |
| Encrypted byte reduction | **56.69%** |
| Restore time median / max | 1.07 / 2.876 ms |
| Candidate persist time median / max | 18.852 / 30.525 ms |

Legacy encoding timings exclude durable disk publication; candidate persist
includes publication/fsync. They are not comparable end-to-end latency results.
These are recent history samples encoded as request snapshots, not all production
request layers, and not a promise of 56.69% savings across the whole home.

A read-only scan using candidate source against the live home hit its eight-second
budget and counted at least 23.207 GB. It counted 6.375 GB of harness DB/WAL/SHM,
6.324 GB of execution snapshots, 190.23 MB of memory/learning, 7.261 GB of backups,
at least 2.400 GB of software/caches and 657.34 MB of other files. Cached lookup
took 0.056 ms; this separate process's event-loop p99 delay was 12.894 ms and max
17.891 ms. The scan is not an installed-app performance qualification. A partial
scan remains partial on Refresh; the UI must not show it as a complete total.

Verified sets:

- 233 regression tests passed across mobile routes, accepted model batch
  checkpoints/process recovery, model request provenance and archived messages.
- 19 storage tests passed: legacy/new codec, mixed Unicode/random chunks,
  corruption/binding/inflation, racing publication, protected reclamation,
  metadata inventory and console authorization. After adding I/O batching, all
  three affected inventory/console tests passed again.
- Both newly targeted mobile storage/auth cases passed; twelve continuity,
  inventory and phone-settings URL cases passed.
- Backend typecheck passed. Desktop and mobile bundles built; final builds must
  be repeated against the final combined revision.
- Headless renders used real measured metadata, with API responses intercepted:
  desktop 1100×920 and phone 390×844 rendered all six categories, no horizontal
  overflow or page errors, functional Refresh and truthful unavailable state.
  These renders are component qualification, not an installed UI acceptance.
- Impeccable's mechanical detector reported no findings on the new components.

Evidence/scripts/screenshots live in this worktree's ignored
`output/storage-efficiency/`. Isolated regression homes are supplemental. The
runner's live-home sentinel could not certify isolation while a live daemon was
writing; do not describe that sentinel as passed. No destructive fixture reset
was aimed at the live home.

## Database work next

Do not delete transcripts or enable an age reaper as a shortcut. Raw admitted
history is consumed by checkpoint recovery, result grounding, local derivation,
async read refinement, pause proof and SQL `json_each` queries in model request
provenance. Changing only the checkpoint reader would silently break those
consumers. JSON wrappers disguised as message arrays are not the storage design.

Introduce a versioned immutable compressed history object keyed by its original
exact digest. Admissions and checkpoints should reference the same object when
their bytes match, preserving original source, authority, item count and every
proof digest. Begin with whole-object sharing plus compatibility readers; do not
add recursive deltas before bounding restore depth. Route every history consumer,
including SQL projections, through the same verified materialization boundary.
Keep the immutable schema constraints and source/graph/account checks.

Only then migrate existing records in restartable batches through a sanctioned
representation migration. Do not replace a sealed file underneath its committed
hash or switch off append-only constraints. Reclaim physical SQLite space
separately: deleting logical rows does not shrink this auto_vacuum=0 database.
Next separate compact certified tool-learning evidence from its bulky source
transcript so dependency-aware retention cannot invalidate useful learned routes.

## Qualification still owed

Combine with the other agent's final reviewed source, rebuild daemon plus both
UIs, coordinate one installation and confirm the served SHA/fingerprint. Before
calling this production-accepted, use named controlled live-home tasks to confirm
new snapshots decode through real provenance, old archives remain readable,
compaction/reopen and fan-out recovery preserve context, approved writes cannot
replay, and Settings works on the installed desktop and paired phone. Attribute
all model tokens separately; this wave has no token-saving claim. Do not tag on
the strength of fixture tests or the read-only scan alone.
