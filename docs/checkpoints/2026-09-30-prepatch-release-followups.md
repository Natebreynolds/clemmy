# September 30 release qualification while the owner installs

The owner-facing hotpatch remains frozen at `104f2484d` in
`codex/connection-shell-integration`. These follow-ups live separately in
`codex/schema88-release-contract`; they have not been built, installed, merged
to main or tagged. The shell agent's lane remains at `76c53a1ea`, included in
the frozen candidate. No changes were made to its worktree or the excluded
model-ledger draft.

## Verified findings and corrections

- Exact-candidate release closure passed **141/141**. Release assets passed
  **58/59**; the sole failure, `the maintained upgrade contract names the schema
  shipped by this candidate`, found schema 82 in the maintained document while
  the candidate exports schema 88. Commit `ecdcfbaef` documents migrations
  83–88, preservation expectations and the distinction between migration
  rehearsal and installed acceptance. All **23/23** release-workflow tests
  passed on that commit without changing the test.
- Measurement qualification plus accepted-source usage and budget pins passed
  **112/114** at `104f2484d`. The two failures reproduced with that usage test
  file alone (**7/9**). Its migration fixture deleted only the v84 ledger row
  from a database already migrated to v88. Production migrations advance from
  the maximum recorded version, so they did not reconstruct that deliberately
  removed row. The usage reader correctly reported unavailable metering, and
  the next test inherited the same corrupted fixture. The file does not exist
  at the last tag, `v3.18.23`; this is an unreleased integration-fixture defect,
  not an attributed pre-existing tag failure.
- The fixture now constructs a separate real v83 store, advances it to v84,
  verifies that migration invents no usage, seeds it with actual production
  writer/source rows, and advances to the exported current version twice. It
  checks original rows, original migration timestamps, the contiguous ledger,
  foreign keys and integrity. It leaves the shared reader-test store intact.
  All **9/9** usage tests pass. No production metering, budget, migration,
  execution or review behavior was changed to make the fixture pass.

Evidence from the frozen integration tree is retained under
`output/release-qualification-104f2484d/`: `gates.json`, `measurement.json`,
their logs, and `upgrade-contract-fix.json`. Fresh qualification of this
follow-up series must be recorded separately; do not turn the old 112/114 run
into a pass by editing its report.

## Installation incident and remaining work

The owner's Terminal signing probes passed. Installation then stopped before
any application mutation or live migration because the fixed `pre-migration`
backup directory already existed from an earlier attempt. The first attempt's
termination is not established by the log. Installed predecessor hashes and
the source/build fingerprint were rechecked unchanged. No installer or app
process remained when inspected.

The ignored installation recipe now uses a fresh snapshot directory per
attempt, preserves the old backup, holds one lock through launch, and describes
the slow integrity-check stage. Lock concurrency/retry checks and syntax checks
passed. The owner was given the same corrected Terminal command. Do not bypass
the computer-use tool's explicit refusal of Terminal control.

Still owed: successful installation, served normal-runtime source/schema and
native-supervisor verification, controlled installed/live-home workflow,
approval, source-control, continuity and no-replay acceptance, and matched
wall-time and full-task usage measurements. Integrate these documentation/test
follow-ups into the eventual release series, rebuild the resulting fingerprint,
and complete exact-revision full-suite, journey and package gates before main
merge/tag. None of the checks above establish new speed or token savings.
