# Clementine v3.14.0 upgrade rehearsal

Date: 2026-08-27

This is the release gate for preserving a v3.14.0 home while moving it to the
current candidate. The store rehearsal never opens `~/.clementine-next`; its
packaged companion installs an actual npm tarball, boots that daemon twice, and
exercises the installed product against the same disposable migrated home. The
only model endpoint is a loopback fixture server. Every path remains below the
operating system's temporary directory.

## Exact release provenance

The published `v3.14.0` tag peels to commit
`18c5bcc72c921da2855fedea88509c2f5e6b7237`, whose tree is
`0673704264723e2acb43c4c3820a1d15787b4c7d`. The rehearsal archives that commit
directly and confirms its `package.json` version is `3.14.0`.

The script removes only the root request record from each lockfile and requires
every installed non-root package record to be byte-equivalent before it lets the
tag checkout use the current `node_modules`. A promoted direct dependency is
therefore allowed only when the exact installed package already existed in the
v3.14 graph; any installed dependency drift refuses exact-tag execution.

## Durable-store inventory

### Numbered or explicitly versioned SQLite authorities

| Store | v3.14.0 | Current target | Upgrade behavior | Rehearsed |
|---|---:|---:|---|---|
| `state/harness.db` | migration 20 | exported `HARNESS_SCHEMA_VERSION` (73 for the current candidate) | numbered, transactional migrations 21 through current; contiguous ledger required | Yes, using a real v20 database created by tag APIs |
| `state/memory.db` | migration 32 | exported `MEMORY_SCHEMA_VERSION` | numbered migrations 33 through current; opening an old DB must first make an immutable pre-migration backup | Yes, including backup existence and second-open idempotence |
| `state/workspaces.db` | `PRAGMA user_version=3` | 5 | v4 adds workflow binding/run projection/partition tables; v5 adds the canonical-entity projection head; Space remains a read model | Yes, with a v3 Space and dataset observation |
| `state/workflow-triggers.db` | schema contract 4 | 4 | additive shape validation; no release-boundary version change | Yes, with exact cron and event triggers compiled by v3.14 |
| `state/prospective-intentions.db` | schema metadata 1 | 1 | no release-boundary version change | Yes, created by the v3.14 trigger sync and integrity-checked |
| `state/model-route-metrics.db` | schema 1 | schema 1 | no release-boundary version change | Inventory only; the representative fixture does not route a model |
| `memory/capability-aliases/<machine>/aliases.db` | additive store, privacy `user_version` up to 2 | same contract | machine-local learned alias index | Inventory only; no discovery is run |
| `memory/procedure-artifacts/<machine>/procedures.db` | additive artifacts/pointers store | same contract | machine-local procedural memory | Inventory only |
| `state/workflow-graphs.db` | additive graph store | same contract | graph definitions/nodes/edges/patches | Inventory only; the fixture workflow is intentionally not promoted to a graph |
| `state/durable-fanout/<machine>/fanout.db` | additive plans/activations/windows | same contract | machine-local execution carrier | Inventory only and required to remain absent in the zero-replay fixture |
| `state/handoffs/<machine>/handoffs.db` | handoff record v1 | v1 | machine-local continuation carrier | Inventory only and required to remain absent in the zero-replay fixture |
| `state/operational-telemetry.db` | additive telemetry | additive telemetry | observational, not execution authority | Yes, because tag API calls naturally create it |
| `state/capability-index/<machine>/capabilities.db` | absent | `user_version=2` | new rebuildable capability index | Fresh-current-store coverage only; it does not migrate v3.14 user truth |
| `state/canonical-entities/canonical-entities.db` | absent | schema/digest contract 1 | new normalized entity, evidence, resolution, quarantine, and coverage authority | Separate focused tests; no v3.14 rows exist to migrate |
| `state/automation-opportunities/<machine>/*.db` | absent | proposal record v1 | new inert automation-opportunity review store | Separate focused tests; no v3.14 rows exist to migrate |

Coordination-only SQLite files such as the external-write admission lock DB and
pending-action transition lock DB are not user-state migration authorities.
They must not appear during this store-only rehearsal.

Harness schema 69 adds `logical_model_result_projection_receipts`. Its exact
shape is metadata-only: accepted source/task/batch/call and settlement lineage,
result class, byte count, and SHA-256. It has no provider output, projected
content, or JSON payload column. The exact v3.14 fixture contains no eligible
current accepted-model checkpoint, so both store-only opens must leave this new
table at zero rows. A migration-generated receipt in this fixture is a failure,
not evidence to bless after the fact. The packaged two-boot work snapshot also
counts this table so a later boot cannot add or remove a receipt invisibly.

### File-backed durable authorities

These do not have one shared numbered migration ledger, so preservation is
checked at the byte level for every seeded file:

- `vault/00-System/workflows/<name>/SKILL.md`, workflow scripts, references,
  and per-workflow `runs/` logs;
- `state/workflow-state/`, workflow watermarks, workflow fix memory, contract
  evidence, and root run-queue records;
- `state/executions.json`, background tasks, batch runs, guest jobs,
  continuation capsules, handoffs, durable fan-out, and pending actions;
- legacy `state/approvals.json` plus canonical approvals in `harness.db`;
- artifact identities/scopes in `harness.db`, and file/resource payloads under
  the home when present;
- file-backed Spaces under `spaces/<slug>/` plus their SQLite temporal index;
- `state/notifications.json`, notification destinations, delivery queue, and
  durable recovery markers;
- `.env`, `mcp/servers.json`, auth metadata, secrets metadata/vault,
  `state/user-profile.json`, and machine identity;
- vault notes, goals, working memory, skills/plugins, memory procedure/workflow
  artifacts, proposal/check-in/monitor state, attachments, audit ledgers, and
  other state-directory JSON/JSONL stores.

The script snapshots the whole realistic fixture before migration. For every
pre-existing non-SQLite file, the migrated copy must retain the exact digest.
SQLite stores are compared logically because a valid WAL checkpoint can change
physical bytes without changing data.

## What the exact-tag fixture contains

The seed child process imports modules only from the archived v3.14 tree and
uses their public APIs wherever one exists. It creates:

- one completed chat session with user and assistant events, plus one exact
  source-bound run attempt deliberately left active for daemon-boot recovery;
- one real ambiguous write cut from a separate exact-tag process: the v3.14
  wrapper reserves `external_write`, validates an exact dispatch lease, enters
  a supplied adapter body, writes a ready marker, and is then SIGKILLed before
  any returned/failed/orphaned result can be inferred;
- one durable memory episode, one grounded person identity, and one active
  focus;
- one workflow with manual, cron, and event declarations, plus workflow state;
- one exact admitted cron occurrence at a fixed UTC minute, with its queued run
  and durable schedule receipt acceptance;
- one real event-trigger queue crash cut: v3.14 durably accepts the workflow run,
  then the fixture process is SIGKILLed before its SQLite trigger receipt commits;
  the workflow is subsequently disabled through the v3.14 store API so current
  boot recovery must reconcile/quarantine it without executing a model body;
- one dormant, non-auto-advancing execution record;
- one Space and one current document observation;
- one deliberately aged ownerless pending approval, which current boot must
  cancel exactly once through the dead-session reaper, plus one resolved
  canonical approval and matching legacy-file approval generations;
- one bound and one pending artifact slot;
- one silent notification with no delivery destination;
- representative `.env`, MCP config, and user-profile files.

It deliberately creates no successful tool/provider result, notification
delivery job, background task, or pending action. There are two accepted queued
workflow runs before packaged boot: the fixed cron occurrence and the event
occurrence cut before its trigger-row commit. The ambiguous write contains a
real adapter-body crossing but intentionally has no outcome. These are exact
crash carriers, not synthetic current-schema rows, and their identities must
survive the store-only migration unchanged.

## Run the gate

From the repository root:

```bash
npm run rehearse:upgrade:v314
```

The command prints the immutable snapshot, migrated copy, and JSON report paths.
It keeps all three by default for inspection and rollback. Every path is under
the OS temp directory.

Machine-readable output:

```bash
npm run rehearse:upgrade:v314 -- --json
```

Automated test:

```bash
node scripts/run-tests-isolated.mjs scripts/rehearse-v314-upgrade.test.mts
```

After committing the exact reviewed candidate and building that clean commit,
run the packaged two-boot gate:

```bash
npm run test:packaged-upgrade
```

That gate refuses a dirty worktree or a build stamp whose commit/source
fingerprint differs from the current clean candidate. It installs the npm
tarball into a fresh directory with no source tree, boots its real daemon twice,
and waits for an IPC first-tick recovery barrier rather than guessing from quiet
stdout. Between boots it uses installed `dist` modules to read the old
conversation/Space/workflow, complete one new cold host-owned turn, run the
migrated workflow, and create plus formally approve one new durable automation
project. Production convergence then parks that project at the exact
`capability_acquisition_missing` fixed point because the sanitized fixture has
no live-read adapters. The second boot must add no work or notification and
must reopen the exact post-exercise state.

The automated test deletes only the temp root it created after verifying that
the immutable snapshot existed. The normal CLI never deletes its output.

## Required pass conditions

The current gate requires all of the following:

1. The seed starts at harness 20, memory 32, and Workspace 3.
2. The first current store boot reaches every exported current schema target.
3. Harness schema 69 installs the exact metadata-only
   `logical_model_result_projection_receipts` shape and immutable lineage
   triggers. The v3.14 fixture has zero eligible projections, so both opens
   retain exactly zero receipt rows rather than inventing migration evidence.
4. Harness and memory migration ledgers contain every version without gaps.
5. Every SQLite database reports `integrity_check=ok` and zero FK violations.
6. A second fresh-process store boot produces the identical logical snapshot.
7. Every pre-existing non-SQLite file keeps its exact digest.
8. Conversation, memory, entity, focus, approval, artifact, workflow trigger,
   Space, dataset, execution, notification, and configuration identities remain.
9. Workspace v4/v5 projection tables exist and are empty rather than inventing
   bindings from names or prose.
10. The immutable v32 memory backup exists before memory crosses to the current exported schema.
11. Store-only opens preserve the one active attempt, unreleased dispatch
    lease, unresolved external-write reservation, admitted schedule occurrence,
    and exact trigger queue/pre-receipt crash cut without advancing any carrier
    or creating additional work, pending action, or notification delivery.
12. The first packaged boot interrupts the dead-process attempt exactly once,
    explicitly revokes its old lease with the closed boot-quarantine reason,
    records one manual restart decision/typed terminal, and never invents a
    physical-dispatch or write outcome.
13. The first packaged boot binds the pending trigger occurrence to its exact
    pre-crash run, preserves both schedule/event receipt acceptances, retires
    both disabled queued runs once, and emits each expected notification once
    without another queue admission or model/provider body.
14. The deliberately aged ownerless approval is cancelled once by the
    dead-session reaper; request/args/resume/presentation identity remains exact.
15. The installed exercise completes one cold turn and one explicitly re-enabled
    old workflow run, preserves the old conversation and Space, and records a
    revision-3 approved durable project through the formal approval control
    plane. Two explicit production convergence passes must yield one exact
    blocked advancement fixed point.
16. The second packaged boot is logically idempotent against the complete
    post-exercise SQLite-table and non-SQLite-file snapshot and performs zero
    repeated work or notification delivery. The report separately retains the
    strict raw diff; logical normalization removes only named heartbeat/scheduler
    observation timestamps, never an authority table, occurrence, or payload.
17. Schema v70 gives source-universe amendments an exact session-bound
    contract/event cascade, preserves standalone immutability, and leaves the
    migrated store free of foreign-key or integrity violations.
18. The candidate commit and runtime source fingerprint are recomputed after
    the rehearsal and must still equal the clean packaged build stamp.

## Honest boundary

This deterministic fixture is a sanitized representative v3.14 home produced by
the exact release APIs. It covers numbered migrations, two real packaged daemon
boots, an active owner, an ambiguous post-provider-crossing write, formal
approval quarantine, schedule and event receipt recovery, an old
workflow/Space/conversation, and newly written current authority. It is not a
clone of one user's historical corruption or machine credentials. A production
rollout should still take a WAL-consistent recoverable snapshot and run the
packaged rehearsal against an appropriately sanitized copy before overwriting
that user's home; the live home is never an acceptable test target. The loopback
model and empty provider inventory also do not replace the separate live-provider
and live durable-pilot canaries required before a major tag.
