# Storage progress and idle conversion worker — 2026-10-02

Continues the owner's storage-efficiency goal. The previous goal turn made
source/build progress; this turn adds truthful desktop/phone space reporting
and a tested worker for historical conversion. No production rows were converted
or deleted, no app was installed, and main/tag remain unchanged.

## Storage reporting

Settings now distinguishes the database's allocated pages from pages available
for reuse. These are SQLite snapshot metadata, not an additional contribution
to the filesystem total. Allocation can include recent journaled pages. Free
pages remain allocated on disk; they are not bytes reclaimed from the SSD.

The same shared presenter on desktop and mobile explains this and reports
historical conversion counts and net logical payload reduction. It does not
claim a conversion is running or that space was freed. Blocked conversion is
visible without exposing its rowid, source, local paths or contents. A server
predating this addition remains compatible. A corrupt/unavailable database is
unavailable data, never successful zero usage.

The reader opens the existing database **read-only**, with a 50 ms lock timeout,
reads page metadata and at most four progress rows, and runs no migrations,
history scans, decryption, credential reads or model calls. Symlinked state
folders/database files and hardlinked DB files are refused for this measurement.
The opened file identity is rechecked before returning. Filesystem totals can
still be partial and remain explicitly lower bounds. The existing shared
in-flight scan/two-minute cache also caches these metadata.

Read-only live-home sample: first inventory read 2,287.64 ms, cached read
0.018 ms, event-loop p99 10.805 ms / maximum 10.953 ms. This was a candidate
module measurement, **not installed-app acceptance**. It reached the 100,000
entry limit and correctly reported a lower-bound total of 23.913 GB. No model
calls. Do not compare this with the earlier eight-second time-limited scan as
a controlled speed improvement; the stopping condition and filesystem changed.

## Conversion worker

`runHistoryStorageMaintenance` performs a bounded lane on its own thread and
SQLite connection. It does not import config/eventlog, migrate a store, load
credentials, execute a task or publish a recovered write. It requires the
current contiguous schema and an existing DB. It yields when any run attempt
is unfinished or a SQLite writer owns the lock, and rechecks foreground work
under the writer lock before **each** row. A new task therefore does not wait
for the whole conversion batch. No main-thread conversion fallback exists.

Calls for one DB share an in-flight promise until the worker actually exits,
including after timeout termination is requested. The worker has a ten-second
watchdog. Keep the finite awaited worker referenced: the first attempt unref'd
it and the test process exited with unresolved promises; that lifecycle defect
was fixed before commit. Source-mode bootstrap registers tsx through its API,
as the existing memory-backup worker does, so `.js` specifiers resolve to source
`.ts` modules. The packaged entry uses compiled `.js` directly.

A pass selects the least recently visited unblocked lane, processes up to 16
rows with a 50 ms cooperative deadline, and starts with a 2 MiB input budget.
When the next row needs more, its metadata determines a larger budget up to the
32 MiB codec ceiling. A later oversized row yields at the cursor and is picked
up on a following pass; it is not silently skipped. A row above the codec
ceiling remains inline, preserving the absence of task-size gates. Transactions
and original evidence predicates are the same as the preceding converter wave.

This worker is **not scheduled by daemon maintenance yet**. First install the
compatible reader and qualify it in the live home, including a controlled
legacy conversion/reopen. Then add its idle maintenance cadence in a subsequent
reviewed commit. This sequencing is deliberate: installing this candidate must
not immediately rewrite the historical backlog before reader acceptance. Do
not call this automatic backlog reduction delivered yet.

## Checks

- Nineteen combined focused cases passed: converter/foreground yield, actual
  worker thread, exact restores, single-flight, active-work and writer deferral,
  noncontiguous/missing-store refusal, page/logic accounting, old-schema read,
  corrupt/linked-store refusal, inventory and shared UI truth.
- Console storage authorization check passed in the earlier seven-case status
  set. Existing device authorization remains in front of the mobile endpoint.
- Typecheck passed before final status-label refinement; final backend and both
  UI builds are required at the clean combined commit.
- Desktop 1100×920 and phone 390×844 preview renders passed six-category,
  horizontal-overflow, runtime-error, Refresh and unavailable-not-zero checks.
  Corrected the preview harness to use the console Tailwind working directory
  and phone's actual `#app` scroll root; inspected both rendered images.
  This is component preview QA, not real installed Settings/iPhone acceptance.
- Static history-reader sweep found only admissions/checkpoint INSERTs on raw
  owner tables outside schema/conversion code; all runtime history consumers
  use the verified readable views. No provider quota was spent.
- The runner's live-home isolation sentinel remains **not performed** because
  the real daemon owns this home; fixture checks supplement production gates.

## Other agent and next integration

Other lane remained clean at `2ed7effc3`. Its actual completed suite task
`b9geja672` returned exit 0: 19,491 tests, 19,483 passed, 8 skipped, zero failures.
That qualifies its source only, not these additional storage commits. Its
latest handoff said code was finished but wave 22 was waiting for installation
approval after a rejected follow-up installer. Do not run competing installers
or treat that pause as an installed receipt. Our source includes its two latest
worker/project commits. No message was sent to it.

Recheck ownership and installed SHA, finish checks on the combined source, and
coordinate one guarded Terminal/signing install. Pending mobile-readiness patch
`004cfd7e7` is a separate unmerged obligation; current relay/setup code does not
contain its equivalent checks. It must not be silently called shipped or lost.

Remaining full-goal work: shared integration; installed desktop/phone storage
and old/new exact history acceptance; long-task recovery/no completed-write
replay; controlled legacy conversion; activation of idle scheduling; measured
backlog conversion; separate qualified physical reclamation. Later dependency-
aware retention must first preserve certified learning and exact receipt lookup.

## Reclamation and build compatibility traps

The bundled SQLite 3.53.2 preserved hidden rowids in the composite-primary-key
source-table experiment, while a plain unindexed table's rowids changed during
VACUUM. A disk-backed pin now checks a partially converted composite-key source
through VACUUM, cursor continuation, exact restored bytes, foreign keys and
integrity. This is not permission to vacuum the live DB: qualified physical
cutover still must verify all durable cursor/table identities for the actual
schema and native SQLite version, alongside task/receipt proof. If a future
schema/library changes those rowids, reset/rebuild cursors through a sanctioned
recoverable cutover before restarting maintenance. Never rely on a generic
whole-DB vacuum as an untested shrinking shortcut.

The first phone build rejected a discriminated union whose one arm grouped two
state literals, although the root compiler accepted it. Split those literals
into separate arms so both compiler versions narrow identically. Rebuild all
artifacts after this fix; the earlier console-only pass is not a combined build.

## Combined regression run and import-boundary correction

The frozen combined source `305bc3d400389dbd55a129fc421ae10b47260934`
completed its full suite on October 2 at approximately 10:27 UTC: 19,522 tests,
19,513 passed, one failed, eight skipped, zero cancellations. The sole failure
was `held parent and migration child have exact minimal runtime import closures`
in `src/daemon/cutover-hold-structure.test.ts`. The new exact-history schema and
decoder leaf was absent from that test's two explicit dependency manifests.
No new npm package, SDK, credential loader or task runtime entered the migration
child; the held foreground parent's dependency closure was unchanged.

Corrected both exact manifests to name `accepted-model-history-store.ts`.
Kept exact equality and the existing package lists; no wildcard allowance or
weakened boundary. The correction changes a structural test only, not runtime
behavior. All 36 targeted cases then passed: held startup structure, real
cutover integration, exact history store/converter, actual maintenance worker,
and the v3.14 upgrade rehearsal. Full log and targeted log are respectively
`output/storage-efficiency/combined-full-suite.log` and
`output/storage-efficiency/final-boundary-pins.log`.

The eight full-suite skips remain unexercised: the no-CLT branch on this CLT
machine, local exact Facebook retained-data control, the p3 retained draft
snapshot-dependent replay, and five installed-browser rendering checks. The
runner's live-home sentinel is also NOT PERFORMED while PID 64188 owns and
writes the live home. Neither the fixture suite nor this structural correction
substitutes for installed-app/live-home acceptance. The full suite ran at the
frozen SHA above; do not describe it as a zero-failure full run at the subsequent
commit. Rebuild after committing this checkpoint and test correction.

The other branch was rechecked clean at `2ed7effc3` after the run. Its changes
are included in this candidate. Main and its worktree remain untouched; the
storage candidate is not installed, scheduled for conversion, or tagged.
