# Learning backlog before evidence expiry

The owner wants the bloated harness refined and combined with the installing
agent's work. That agent retains installation, signing, restart and tag ownership.
This change adds a bounded read-only learning census, not deletion authority.
It does not enable chat TTL, change memory extraction, alter task completion or
run a model. No live rows were removed or rewritten in this wave.

## Implementation and checks

`src/memory/learning-retention-inventory.ts` accepts an existing database handle
without importing migrating/configured stores. It uses numeric rowid seek pages
and short deferred snapshots, with separate batch, child-row and cooperative
time budgets. Negative rowids, partial coverage, unknown schema/status/counts,
missing members and contradictory parent/child completion are handled explicitly.
Output contains counts and numeric inspection cursors, not conversation text,
paths, session IDs, tool arguments, proposed fact text or model credentials.

Completed intake with unavailable result evidence is `source_unavailable`.
Dead-letter/failed extraction remains failed. Completed shards with missing
reflection receipts remain unresolved; intentionally skipped extraction needs
its own durable disposition before it can be distinguished from missing proof.
Buffered receipts or pending proposals remain pending even when the extractor
or its parent batch says completed. Structured task evidence, resource pointers,
write acknowledgements and empty/control/failed-tool dispositions are counted
separately from semantic extraction. They are not declared disposable.

`scripts/inspect-learning-retention.ts` requires an explicit database path,
opens read-only/query-only with a bounded busy timeout and rejects linked or
replaced database identities. It creates no store, runs no migration or learning
drain and issues no retention write. Example:

```sh
npx tsx scripts/inspect-learning-retention.ts --db /explicit/path/memory.db
```

The new seven-case focused suite passes, as does the source typecheck. It covers
unavailable evidence, buffered/pending proposals, dead letters, missing receipts,
contradictory completion, mutation-free query-only inspection, private-content
exclusion, numeric pagination, child/time limits and unavailable old/corrupt
schemas. Isolation sentinel was NOT PERFORMED while live daemons owned/wrote
the home. These checks do not qualify cleanup or the combined release.

## Live metadata characterization

The candidate module was transpiled separately and read the real memory store
through the installed app's native SQLite driver in verified RunAsNode mode.
It was not installed into the runtime. Source module/binary hashes and served
identity were held before/after. Store handle was read-only/query-only,
`total_changes()` stayed zero and data_version did not change during this scan.
No runtime/model/configuration imports or provider calls were involved.

Observed installed source: `4e4787f3b647cc8fe859b6a56bd91922b392df59`,
fingerprint `9acbe13fdac49bcc68fdd939a1db36d150d22a95770eda765c80ec3bf8535e01`,
schema91, PID16431. Twenty-six pages inspected 1,656 learning batches with no
inspection exclusions. The per-page inspection durations summed to 207ms;
this excludes process/identity calls and is not a foreground latency benchmark.

| Learning projection classification | Batches |
| --- | ---: |
| No semantic extraction required | 947 |
| Extraction completed; no pending proposals observed | 310 |
| Learning still pending | 298 |
| Learning failed/dead-lettered | 3 |
| Unavailable source member(s) | 97 |
| Completed shard missing reflection receipt | 1 |

The unavailable-source batches contained 429 unavailable members. Observed
candidate statuses while examining completed shards included 1,553 pending,
942 promoted and 2,770 rejected. These are a subset of the candidate ledger,
not global memory totals or a count of facts safe to remove. Existing older
conversations outside typed learning intake are not covered by this census.
Separate short snapshots do not make a global atomic snapshot or a durable
certificate. All observations have `deletionAuthorized=false`.

Receipts and logs are in this lane's ignored `output/storage-efficiency/`:
`learning-retention-live.json`, immutable timestamped live receipts,
`learning-retention-live-probe.log`, `learning-retention-inventory-tests.log`
and `learning-retention-typecheck.log`. No raw conversation/result content was
written to these artifacts.

## Integration and next required work

The installing agent advanced beyond our original37a66130c base, through the
saved-agent roster and current-only health fixes to4e4787f3b. Their five changed
paths were compared; this learning inventory touches none of them. They are now
preparing schema92: two receipt-lineage triggers must read the verified history
view rather than the `[]` inline placeholder for histories >=32KiB. That repair
is a prerequisite before broad automatic conversion. Preserve their in-flight
schema changes and large-frame pin; never copy this older branch over them.
The worker derives its schema expectation from HARNESS_SCHEMA_VERSION, so
rebuild/requalify it with the final combined source instead of loosening its
contiguous schema guard. Their earlier full-suite process ended without a
terminal summary in the inspected log; a related-check run is now live. Neither
observation establishes a new combined green release.

Next, prove current task/provenance/tool-learning/approval/replay consumers for
the learning-settled subset. Preserve independently verifiable learned route
certificates, receipt identities and readable history before releasing bulky
payload references. Unavailable, failed or pending extraction must never be
classified as unneeded merely because it produced no facts. Rejected proposals
are explicit outcomes, but do not alone retire the containing conversation or
tool result. Decide a user-visible history retention policy separately.

Then qualify a small installed/live-home expiry batch, dependency races,
restart/continuation and no repeated completed write. Physical SQLite shrinking
is a separate idle maintenance/capacity/recovery qualification; deletion alone
makes pages reusable and WAL checkpointing does not compact the main file.
Keep code/source committed, final build, installed identity and live acceptance
separate. This census is intentionally not wired synchronously into the Storage
page: Settings must not inherit a foreground learning scan. UI integration
should consume an off-main cached observation and label partial/subset coverage.
