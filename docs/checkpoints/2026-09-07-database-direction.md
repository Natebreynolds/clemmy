# Database direction for Clem

## Recommendation

Keep SQLite for the current local-first, single-owner daemon. Consider PostgreSQL for a future shared cloud service with multiple independent writer processes/servers and centralized operations. The importance or size of Clem's memory alone is not a reason to migrate. SQLite's own guidance supports application-local storage and recommends client/server databases for many concurrent writers or direct network database access. [SQLite deployment guidance](https://www.sqlite.org/whentouse.html).

This is a recommendation based on the current product and observed failures, not a completed storage benchmark. The README describes a local-first single-owner product. Recent retained-result failures arose from invocation identity, producer/carrier matching, reader routing and context projection. A database replacement preserves those bugs unless their contracts change. No measured SQLite contention, throughput limit or corruption has been established by this review.

PostgreSQL is a reasonable server-side candidate if deployment changes; its concurrency model supports simultaneous sessions through MVCC. That does not automatically supply offline desktop behavior or synchronization, which require explicit ownership and conflict semantics. [PostgreSQL concurrency model](https://www.postgresql.org/docs/18/mvcc-intro.html). Mobile requests through the local daemon do not by themselves require a new database. An execution graph also does not by itself require a graph database.

## Concrete checks before the beta

The inspected `eventlog.ts:928`, `src/memory/db.ts:2295` and `src/spaces/workspace-db.ts:221` open separate SQLite stores using WAL, `synchronous=NORMAL`, foreign keys and a 5-second busy timeout. Recheck line numbers after edits.

1. **Durability of effect records:** evaluate `synchronous=FULL` for the canonical action/settlement ledger and benchmark its latency. In WAL mode, NORMAL can lose recently committed transactions on power loss or an OS crash, while FULL syncs the WAL at transaction commit. This is different from an ordinary application-process crash. [SQLite synchronous semantics](https://www.sqlite.org/pragma.html#pragma_synchronous). An externally completed action whose local receipt is lost creates replay risk; stronger syncing alone still cannot atomically commit a remote API effect and a local receipt. Persist intent, retain idempotency/reconciliation identities, and reconcile uncertain outcomes before retry.
2. **One source of truth:** canonical operation/source/target identity and settlement state must be transactional where they share a database. Search indexes and context projections must be rebuildable and must not overwrite authority. Across separate database files and external artifacts, define recoverable ordering rather than assuming one transaction covers them all.
3. **Backup and recovery:** exercise the existing supported live-backup path and restore into a disposable home; verify accepted objective, pending activation, tool bytes, receipts and learned facts remain consistent. Do not copy a live main database file alone and call it a safe backup. Validate migrations on restored data.
4. **Measure before changing engines:** record busy/lock failures, transaction duration, WAL/checkpoint growth, event-loop delay from synchronous calls, and indexed recall latency under a realistic concurrent workload. Keep write transactions short and network/LLM calls outside them. SQLite WAL allows readers alongside a writer but still has one writer at a time. [SQLite WAL documentation](https://www.sqlite.org/wal.html).
5. **Keep the storage interface coherent:** finish the canonical retained-result API rather than adding another database or another reader-specific authority interpretation. Retrieve full evidence through paging/projection with stable lineage. Full-text/vector indexes assist retrieval; they do not replace the execution ledger.

## Migration trigger

Revisit PostgreSQL when a concrete requirement calls for a shared multi-server service, centralized availability/backup operations, or measured write contention that remains after transaction/index fixes. Document consistency, tenant ownership, local/offline behavior and migration/recovery tests before choosing it. Do not add a SQLite/Postgres dual-write architecture merely to keep options open.

For this tag, prioritize correct persistence contracts, durable effect reconciliation and proven recovery. The current evidence does not justify a database migration as a release dependency.
