# Empty workflow ownership reads no longer manufacture durable groups

## Measured cause and class correction

Qualification of storage candidate eda1a15df found a remaining 50ms ordinary-chat p95 gate violation. A recording filesystem/SQLite profile attributed about 20.6ms median to four filesystem syncs per turn. Two correctly persist the encrypted model request and its directory. Two instead publish a workflow group lock owner merely to read pending dispatch ownership. That empty read also left a hashed source-group directory for every chat, indefinitely.

readPendingWorkflowChatDispatchOwnership now observes the group directory without creating it, scans canonical run records for legacy/pre-index held ownership, and observes the directory again. If both observations are absent and the canonical fallback has no matching run, it returns the same null result without acquiring/persisting a group lock. Current admissions create the parent while taking the group lock before publishing a canonical held run; the second observation catches admission that begins during enumeration. A writer that begins later is ordered after this read, as it can already acquire the old lock after a locked reader returns. This observation grants no execution or consent authority.

If group evidence or a legacy held record exists, the original locking, immutable preparation/admission validation, activation/close state checks and canonical readback remain. Unknown directory access and non-directory/symlink group paths throw rather than claiming absence. Actual writers still fsync their authority and lock publication. No model name/provider choice/rollout switch or durability bypass was added.

## Pins and measurements

The new absence pin fails before correction: eight empty ownership reads create eight group directories. Legacy canonical held ownership with no group index still returns its exact pending record. Four new pins pass: no creation, canonical legacy fallback, a real admission published after the first empty enumeration, and invalid group-path refusal. The interleaving pin exercises the ordinary queue and durable preparation callback; it does not provision a fake success receipt.

Five-file regression run: 165 tests / 164 pass / one failure. No workflow queue/origin-group/run-record/delivery semantic case failed. The only failure was the ordinary-chat timing gate at median 30.848ms / p95 51.869ms. A subsequent standalone uninstrumented ordinary journey passed all three tests at median 30.384ms / p95 49.599ms. Both timing observations remain in evidence. Do not call the failed batch fully green or generalize a close hardware-dependent threshold into a release latency guarantee.

Matched component benchmark: 16 measured alternating trials after two warmups, same absent source identities and isolated filesystem fixture, original eda1a15df method versus corrected method. Original median 11.516458ms (max 17.064042), two fsyncs and one persistent directory per read. Corrected median 0.0679165ms (max 0.169583), zero fsyncs and zero created directories. Both return exactly null. This is the empty ownership component, not installed turn latency or token savings. Original function bytes match the peeled last tag's method exactly; source-attribution hashes are recorded separately from a test receipt.

Typecheck passed. Evidence is in output/storage-efficiency/{empty-ownership-pins,empty-ownership-regressions,empty-ownership-ordinary-standalone,empty-ownership-typecheck}.log and empty-ownership-benchmark.json. Original fsync/profile probes are recording fixtures and not acceptance of an instrumented production runtime. All tests used isolated homes; the live-home sentinel was not certified while the user's daemon owns that home.

## Still owed

Commit/build the combined source, run required checks at its exact clean revision, and resolve or transparently attribute any named failure. Coordinate the owner-approved Terminal window and consistent pre-schema-91 database recovery snapshot. Then verify installed/served identity, both UIs, recovery without repeated writes, exact learned tool lookup and a small controlled history conversion in the live home. Only then schedule off-main historical conversion and measure reusable versus physically reclaimed bytes. No live history, credentials, personal Space/integration, main branch or other agent's source has been changed. No provider/model call, hotpatch or tag has occurred.

## Last-tag pin and read-only live inventory

Ran the new no-creation and legacy-held pins against a detached v3.18.25 runtime (7d9ade6f9), adding only those assertions to its test file. It returned two tests / one pass / one failure: the no-creation pin produced eight group directories; legacy canonical held ownership passed. This is a matching pin on the last-tag runtime, not attribution from a different old conversation cohort. The temporary baseline worktree is owned by this task and may be removed after retaining its log.

A metadata-only live inventory found 191 canonical workflow run JSON files (2,835,804 bytes) and 3,489 origin-group directories. No file contents were read, no old group was deleted, and no old group was classified expendable. The current correction prevents empty queries from adding new directories; it preserves the legacy canonical fallback, which still scans all run files. A certified legacy ownership index with outside-edit freshness is separate future optimization, not silently assumed by this shortcut.
