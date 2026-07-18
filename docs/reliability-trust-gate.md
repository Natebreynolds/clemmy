# Reliability Trust Gate

**Status:** Focused trust gate implemented and green; soak still required  
**Date:** 2026-07-17

## Objective

Clementine must not repeat an external mutation merely because a response was
lost, a process crashed, or the daemon restarted. If local evidence cannot
prove whether a mutation committed, the occurrence stops for verification.

## Invariants now enforced

1. **Durable intent precedes structured dispatch.** Direct mutating workflow
   calls persist both intent and the started boundary before invoking a
   provider.
2. **Ambiguity never auto-retries.** A started call without a durable provider
   result or proven no-commit failure is treated as ambiguous.
3. **Receipts keep stable identity.** Run, step, fan-out item, tool, account,
   and normalized arguments participate in the mutation slot and fingerprint.
   Mutating `loopUntil` is prohibited, so a loop-attempt identity cannot grant
   permission for another dispatch.
4. **Fresh retries cannot hide old evidence.** Whole-run, failed-item, and
   background-task resumes inspect the source occurrence and preserve its
   receipt-bearing session.
5. **Live work cannot overlap a retry.** External retry surfaces require a
   terminal source run. Only the runner has the narrow authority to enqueue a
   successor after execution has actually settled.
6. **Trigger acceptance follows durable queue acceptance.** A trigger receipt
   becomes `enqueued` only after its run and immutable acceptance marker are
   durable.
7. **Cancellation is durable authority.** Workflow and background cancellation
   cannot be overwritten by a stale starter or worker settlement.
8. **Terminal publication has one authority.** The first terminal publisher
   atomically installs both the terminal projection and its exact report-back
   envelope; stale observers cannot repeat terminal side effects.
9. **Correctness persistence fails closed.** Corrupt/unwritable receipt,
   cancellation, trigger, or ownership state never grants permission to mutate.

## Implemented boundaries

### Structured workflow mutations

The direct-call ledger uses:

```text
intent -> started -> failed
                  -> receipt -> commit
```

- `intent` without `started` proves dispatch did not begin.
- `started` without a terminal phase is ambiguous.
- `failed` is retryable only when the provider response proves no commit.
- `receipt` and `commit` replay the saved result without redispatch.
- Cross-process slot and started claims admit one dispatcher.
- Corrupt shape, fingerprint, path, or phase agreement fails closed.
- Receipt directories survive normal workflow-event retention.
- Mutating structured calls cannot use `loopUntil`; mutating fan-out recovery
  parks whenever an item may have committed.
- First admission snapshots the exact mutation contract. A retry is rejected if
  the definition drifted, the source occurrence lacks required evidence, or a
  plain step became a new structured mutation.
- Normal, dry-run, and creation-test queue installation is create-only, with
  collision-safe retry rather than overwrite.

Plain/agentic mutating steps do not pretend their best-effort telemetry is a
receipt. A crash-resumed run with missing or incomplete lifecycle evidence
parks before an uncompleted plain mutation. Read-only work remains resumable.

### Workflow retries and cancellation

- Whole-run retries inspect every mutation receipt and completed mutating step.
- Failed-item retries inspect the exact fan-out item receipts.
- A running source cannot be requeued from the dashboard, gateway, or Tasks UI.
- Workflow cancellation first installs an immutable, fsynced receipt; stale
  record writes are coerced to cancelled state and admission checks it again.
- Self-heal and goal re-pursuit recheck cancellation immediately before
  applying or enqueueing a successor.
- Cancellation, cancelled projection, and its exact failed report-back envelope
  are committed under one run-record lock. The first cancellation reason wins,
  and cancellation clears parked metadata.

### Terminal publication and report-back

- Run records use a cross-process token lock bound to directory device/inode
  generation. Malformed, duplicate, or unexpected ownership evidence fails
  closed.
- The first terminal publisher commits the immutable business projection and
  exact report-back envelope in one fsynced boundary. Later observers are
  read-only for terminal side effects.
- Origin acknowledgement is tracked independently from dashboard notification.
  Each origin has a stable acknowledgement id; duplicate delivery counts as an
  acknowledgement and delivery failures remain retryable.
- Origins attached after completion reopen pending report-back instead of being
  silently dropped. Attachment, report-back, retention, and scheduler reaping
  share the same run-record authority.
- Corrupt report-back evidence is quarantined and retained. The scheduler reaper
  refuses to remove pending, corrupt, or quarantined terminal records.
- Stable Outcome card ids let the watchdog recover publication without creating
  duplicate terminal cards.

### Background tasks

- Interrupted, failed, and aborted resumes reattach to the same task and run
  session; legacy clone chains resolve to the latest receipt-bearing owner.
- Restart recovery parks all interrupted work for explicit verification when
  the best-effort ledger cannot prove safety.
- Per-task token leases serialize writers across processes.
- Pending-to-running, cancellation, parked-state resolution, and worker
  settlement use expected-state transitions, so stale observations cannot
  resurrect or terminalize cancelled work.

### Trigger inbox/outbox

Schema V4 records `pending`, `enqueued`, `cancelled`, and
`needs_verification`, with each receipt bound to its trigger configuration
generation:

- readiness and queue failures remain pending with bounded backoff;
- distinct durable deliveries each own a run, while redelivery of the same
  receipt converges on one run;
- obsolete trigger configurations terminally cancel their pending payloads;
- malformed filters fail closed;
- disable/replace and claim-to-queue acceptance share a serialized generation
  boundary, so a stale claimant cannot install a run after revocation;
- legacy non-fsynced `run_id` rows migrate to `needs_verification`, not assumed
  success;
- registry snapshots are read inside the serialized SQLite generation update;
- V2 acceptance markers remain proof after normal run-file retention.

### Process and queue ownership

- The daemon singleton, workflow queue, and shared run-record locks use token
  ownership plus directory device/inode generation binding.
- A paused creator cannot publish into a replacement pathname generation.
- Stale reclaimers remove only the owner token they observed.
- Deterministic multi-process ABA tests cover these ownership boundaries.

## Verification gate

The completed focused gate is:

- **747/747** non-overlapping focused checks passing across workflow execution,
  receipts, run records, cancellation, report-back, scheduling, triggers,
  background tasks, daemon ownership, runtime outcomes, and integrations;
- root and desktop TypeScript typechecks and production builds passing;
- root and desktop dependency audits reporting zero known vulnerabilities;
- lockfiles reproducible in dry-run clean-install checks.

The current implementation has deterministic crash/concurrency tests for the
critical ownership transitions. Broader power-loss, disk-full, and permission
fault injection, plus a clean daemon restart/recovery soak, remain rollout
requirements rather than claims of completed coverage.

## Deliberately deferred

- Provider-native idempotency keys where a provider exposes them.
- Replayable durable receipts for every agentic/harness mutation; today those
  paths park conservatively after a crash instead.
- Operator UI for resolving `needs_verification` trigger and mutation receipts.
- Retention/compaction policy for cancellation and receipt evidence.
- Pinned-goal success finalization and auto-self-heal proposed-fix application
  still need to split asynchronous judging from a short, locked
  commit-and-requeue transaction. Their cancellation checks are hardened, but
  this larger transactional authority boundary is not claimed complete.
- Atomic notification-store-to-external-delivery receipts belong to Outcome V2;
  the current report-back gate covers durable workflow-origin publication.
- The shared Outcome V2 artifact/evidence/delivery contract described in
  `docs/outcome-v2.md`.
