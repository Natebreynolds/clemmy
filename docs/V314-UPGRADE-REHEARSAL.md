# Clementine v3.14.0 upgrade rehearsal

Date: 2026-08-22

This is the release gate for preserving a v3.14.0 home while moving it to the
current worktree. It never opens `~/.clementine-next`, never starts the daemon,
never contacts a provider, and never executes a workflow. The fixture and both
upgrade boots live below the operating system's temporary directory.

## Exact release provenance

The published `v3.14.0` tag peels to commit
`18c5bcc72c921da2855fedea88509c2f5e6b7237`, whose tree is
`0673704264723e2acb43c4c3820a1d15787b4c7d`. The rehearsal archives that commit
directly and confirms its `package.json` version is `3.14.0`.

The tag's and current tree's lockfiles differ only in the root package version
fields. The script removes those two metadata values and requires the remaining
lock graphs to be byte-equivalent before it lets the tag checkout use the
installed dependency tree. If dependencies drift, the rehearsal refuses to
claim exact-tag execution.

## Durable-store inventory

### Numbered or explicitly versioned SQLite authorities

| Store | v3.14.0 | Current target | Upgrade behavior | Rehearsed |
|---|---:|---:|---|---|
| `state/harness.db` | migration 20 | exported `HARNESS_SCHEMA_VERSION` (55 at this writing) | numbered, transactional migrations 21 through current; contiguous ledger required | Yes, using a real v20 database created by tag APIs |
| `state/memory.db` | migration 32 | 34 | v33 adds fact FTS; v34 adds recall-run tombstones; opening an old DB must first make an immutable pre-migration backup | Yes, including backup existence and second-open idempotence |
| `state/workspaces.db` | `PRAGMA user_version=3` | 5 | v4 adds workflow binding/run projection/partition tables; v5 adds the canonical-entity projection head; Space remains a read model | Yes, with a v3 Space and dataset observation |
| `state/workflow-triggers.db` | schema contract 4 | 4 | additive shape validation; no release-boundary version change | Yes, with an exact event trigger compiled by v3.14 |
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

- one completed chat session with user and assistant events;
- one durable memory episode, one grounded person identity, and one active
  focus;
- one workflow with manual, cron, and event declarations, plus workflow state;
- one dormant, non-auto-advancing execution record;
- one Space and one current document observation;
- one pending and one resolved canonical approval, plus matching legacy-file
  approval generations;
- one bound and one pending artifact slot;
- one silent notification with no delivery destination;
- representative `.env`, MCP config, and user-profile files.

It deliberately creates no tool dispatch, trigger delivery, queued workflow
run, notification delivery job, background task, or pending action. That makes
any such carrier after migration an unambiguous replay bug.

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

The automated test deletes only the temp root it created after verifying that
the immutable snapshot existed. The normal CLI never deletes its output.

## Required pass conditions

The current gate requires all of the following:

1. The seed starts at harness 20, memory 32, and Workspace 3.
2. The first current store boot reaches every exported current schema target.
3. Harness and memory migration ledgers contain every version without gaps.
4. Every SQLite database reports `integrity_check=ok` and zero FK violations.
5. A second fresh-process store boot produces the identical logical snapshot.
6. Every pre-existing non-SQLite file keeps its exact digest.
7. Conversation, memory, entity, focus, approval, artifact, workflow trigger,
   Space, dataset, execution, notification, and configuration identities remain.
8. Workspace v4/v5 projection tables exist and are empty rather than inventing
   bindings from names or prose.
9. The immutable v32 memory backup exists before memory crosses to v34.
10. Neither boot creates work, dispatch, trigger-event, workflow-run, pending
    action, nor notification-delivery carriers.

## Honest remaining release blocker

This gate proves schema/store migration, not the entire daemon's recovery
behavior. A real daemon boot invokes reconcilers, sweepers, timers, notification
delivery, workflow queues, and machine-scoped recovery. Running that against a
synthetic healthy fixture would not cover the historical partial/corrupt states
that matter, while running it against the live home would be unsafe.

Before tagging, make a WAL-consistent, sanitized copy of a representative
v3.14 user home into a disposable temp directory, preserve an immutable copy,
then run the full current daemon twice with all network/provider carriers
disabled and assert zero duplicate work or notifications. That is a separate
release gate; it must never be approximated by hand-copying a guessed schema.
