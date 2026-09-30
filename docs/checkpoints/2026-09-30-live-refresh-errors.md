# Live refresh errors — 2026-09-30, 07:00 PT

Owner reported many workflow-update errors. Read-only investigation; no
workflow retry, source repair, settings change, provider call, build or patch.
An optional clarification is pending about whether the owner means these
notifications or a separate interactive workflow edit.

## Installed identity

Authenticated loopback `GET /api/console/build-info` reports packaged 3.18.23,
SHA `019e8d9d505ab07e9332737b7f1f149b7bb14295`, fingerprint
`5d300f69d5abbedbf89a6ccb63339b9b33794cac33c9f78b0391e3552b90219b`,
schema 82, PID 72427, started 2026-09-30T10:32:31.086Z.
The contextual-connection work through `d8393bb9a` and the unfinished model
invocation ledger are not installed. Main remains `4e2efe15b`; the other lane
is clean at `76c53a1ea` on `claude/two-modes`.

## Evidence and distinct causes

The latest 07:00 run of `friday-dashboard-daily-refresh`, occurrence
`trigger-9fc78e29452a2ba6bc320b01f3ce838c`, completed. The log records zero
partial failures, blocked steps or advisories. Harness event 331820 records
the successful `space_set_data` settlement, with a result handle and physical
dispatch identity. Do not confuse the adjacent source alerts with failure of
this workflow, or claim this proves all dashboard content is correct.

`space-schedule-state.json` records eleven unresolved source streaks:

| Class | Sources | Evidence |
| --- | --- | --- |
| Retired local script execution | `darrin-sennott-deal-risk:risk`, `market-leader-send-contacts:contacts`, `team-sales-weekly:weekly`, `james-english-pipeline:pipeline`, `james-english-pipeline:transcript_matches` | `local_runner`; shared durable call authority absent; no process started |
| Prior declined approval | `past-due-opportunities:workflow_state` | `not_approved`; approval `apr-9d5e` declined 2026-08-14; no process started |
| Provider definition cannot be refreshed | `my-day:emails`, `my-day:slack`, `my-day:slack_dms`, `daily-brief:calendar`, `daily-brief:inbox` | `operation_version_rebind_requires_accepted_source`; no provider business call |

Four fresh notices at 14:00:14Z cover the last three local-script sources
and the declined approval. Each was delivered to desktop, Slack and Discord,
so four distinct source failures can appear as twelve alerts across surfaces.
These are the third matching failures in each source's tracked streak. The
older two local-script streaks already have `told: [local_runner]` and are
backing off. The five provider-definition failures have not reached the
three-failure notification threshold yet.

The runtime's `runScript` compatibility entry point has returned without
executing since `60db67d8b9` (2026-08-25). The newer
`a701760ee` (2026-09-25) reports repeated source failures and backs off;
it did not introduce that execution refusal. Today's evidence alone does not
date when each personal source first stopped working.

## Framework defects to address

1. Scheduled read preparation calls `ensureWorkspaceReadClassification`
   without a durable accepted source. It can warm a current manifest, but
   `prepareWorkflowStepExternalCatalog` requires source evidence when the
   provider version/definition moves. The provisioner validates a real
   `user_input_received` record, so passing invented IDs or bypassing the
   check is not a fix. Establish a truthful scheduled-occurrence preparation
   identity compatible with the existing durable execution contract; preserve
   exact operation/account binding and revalidate effect classification.
   Reproduction must cover cold/warm, moved definition, multiple accounts,
   changed-to-write refusal and restart/retry ownership before live acceptance.
2. Local-script sources still pass through approval/trust handling and can
   remain scheduled even though their execution entry point cannot run them.
   Resolve capability availability before requesting futile approvals.
   Integrate supported local execution with the shared kernel, or present a
   truthful, actionable unsupported-source state. Do not restore an untracked
   raw subprocess path, override old refusals, or migrate personal sources.
3. An old declined approval must remain declined. Its UI recovery must not
   promise that approval alone fixes an executor that is unavailable. Separate
   authorization state from execution capability.
4. Group simultaneous source failures by Space/refresh occurrence and show
   each exact source and action underneath, using the same durable notice
   identity across channels. Do not hide failures, mark stale data fresh, or
   change the owner's notification destinations as a workaround.

At the time of the initial diagnosis no fix or live acceptance was claimed. The affected source declarations
and notification state were only read. Coordinate with the two-modes lane
before changing shared shell/consent/UI paths. Keep this incident distinct
from the unfinished connection-continuity budget work.

## Source repair and bounded verification

The contextual-connection branch now supplies a durable
`workspace_read_preparation_started` record for a refresh's exact saved source.
It is a system record, private to the runtime, not a fabricated user message.
The record binds the declaration digest, operation, optional saved account and
occurrence. The shared provisioner, routing policy and capability-resolution
recorder recognize that source for the single declared READ only. The existing
read kernel still owns the actual provider dispatch, settlement and dataset
observation; its occurrence names the preparation source sequence.

Key properties:

- Cold and warm refreshes revalidate the provider definition. The previous
  warm/unpinned shortcut no longer bypasses refresh-time preparation.
- Exact saved accounts remain exact. Unpinned reads retain the ordinary
  owner-taught read default or a sole connected identity. Neither that default
  nor a new connection can silently replace the predecessor manifest's
  selected account. No model interprets a structural saved account choice.
- A different operation, write effect, changed arguments/account/schedule,
  archive/removal or source edit during lookup cannot reuse the old record to
  publish read proof. A publication fence and a final pre-activation check
  reopen the saved declaration. Manual refresh of a paused Space remains
  supported; scheduled preparation requires an active Space.
- No schema migration is needed for this fix. The unfinished model-invocation
  migration/ledger remains separate and must not be included in a hotpatch.

Evidence (recording transport and metadata fixtures; no live provider/model
calls):

- `/tmp/clem-scheduled-read-source-green.txt`: **148/148** across exact provider
  publication, Space read authority, account routing, external-catalog
  preparation, capability resolution, chat event coverage and public
  presentation. This precedes the final preservation of the taught default.
- `/tmp/clem-scheduled-read-default-green.txt`: **53/53** on the final account
  routing/publication code, including the added taught-default versus
  predecessor-account case. These overlap the earlier run.
- `/tmp/clem-scheduled-read-schema84.txt`: **25/25** on the final publication
  and Space-authority suites with the unrelated unfinished migration removed
  temporarily. Exact original schema bytes were restored in `finally`.
  This proves independence from the model-invocation ledger draft.
- `/tmp/clem-scheduled-read-source-red.txt`: removing only the new source
  handoff makes **both** cold/pinned and warm/unpinned real-provisioning
  regressions fail at definition recovery. Exact original source bytes were
  restored in `finally`.
- Runtime typecheck output: `/tmp/clem-scheduled-read-source-tsc-final-3.txt`.
  `git diff --check` also passed.

The two positive regressions use the real proof recorder, account routing,
successor registration and shared read kernel. They assert one exact metadata
repair, one provider read, the same account/arguments, a saved dataset result,
zero fabricated chat messages and a preparation record surviving journal
reopen. The readiness bootstrap and provider edge are fixtures, so these are
not installed-app acceptance. Additional cases cover missing account, a
different operation, a write declaration, a source edit during lookup, and a
taught default conflicting with the predecessor account.

Fixture corrections made during development: the isolated transport must be
bound into the attested artifact as well as the source singleton; the daemon
readiness controller is not booted in this fixture; and a formerly local-
registry fixture named like a provider read now supplies an actual Composio
manifest so it exercises the new refresh-time revalidation. The failed
intermediate runs are superseded by the evidence above, not claimed green.

The live-home sentinel reports **NOT PERFORMED** while daemon 72427 owns and
writes the live stores. The daemon was not stopped. No isolation or live
acceptance conclusion is inferred from that sentinel.

Still owed: reconcile with the other agent's candidate, build/install one
combined revision, then exercise controlled saved-source refreshes through
the installed app/live home with exact accounts and provider versions. The
two Daily Brief sources explicitly save an account; the three My Day sources
do not, so verify their actual fresh account/default resolution rather than
assuming all five failures disappear. No personal declaration was changed.
Legacy script execution, the old declined approval's recovery UX, grouped
failure notices, original connection-continuity work and full release
qualification remain open. This change is not a claim of a general latency
improvement or readiness to tag.

## Executor readiness before compatibility approvals

Follow-up source repair on `codex/contextual-connection-ui`, after `1a4e6fdeb`.
This removes a misleading approval path; it does **not** implement a replacement
executor for arbitrary legacy scripts. The other agent remains clean at
`76c53a1ea` on `claude/two-modes`. No source declaration, credentials, mode,
notification destination, installed bundle or running process was changed.

`space-data-runner-trust.ts` no longer registers compatibility approval cards.
An installed legacy runner or unsupported frozen command reports the missing
executor with `local_runner` / `local_command`, rather than `not_approved`.
A frozen command must compile its entire argv into a supported reviewed read;
a command-head match does not suffice. Supported reads proceed to the existing
read kernel without an unrelated human trust grant. That kernel still proves
the current descriptor, binary, arguments, connection/account and call authority.
No new raw spawn path or effect-classification bypass was added.

When refresh encounters an old pending card for the **exact** declaration/hash/
schedule snapshot, it retires that card (or expires it) and projects the existing
waiting observation to an error. Repeated reconciliation is idempotent and does
not retire another source's card. Existing human denials/cancellations remain in
the registry and cannot silently become permission, including when a command
later becomes a reviewed read. Changing a runner or cadence does not create a
new futile card. Existing offline approvals still consume their one-shot recovery
claim and report the actual failed refresh; a missing executor's outcome now
explains that repair is required instead of inviting an identical retry.

Save-time warnings and the Workspace context no longer teach the model that
editing an old runner and approving it will restore execution. They preserve the
saved data and point to a supported read source or an ordinary workflow publishing
through `space_set_data`. The existing Workspace-context size pin stays unchanged.
No personal source was migrated and no background task was launched to repair it.

### Verification

- `/tmp/clem-space-executor-readiness-final-2.txt`: **96/96** across nine focused
  suites: runner, historical terminal decisions, smoke, scheduler, Space read
  authority, failure backoff, save-time enforcement, Workspace context and CLI
  argv compilation.
- `/tmp/clem-space-executor-readiness-schema84.txt`: the same **96/96** with the
  unrelated in-progress schema-85 files temporarily restored to committed
  schema 84. Their exact draft bytes were restored in `finally`. This change
  does not depend on the unfinished model invocation ledger.
- A new positive fixture provisions a real executable through the existing
  reviewed-CLI descriptor/carrier, drives manual and scheduled Space refreshes,
  observes one physical process per occurrence, checks the exact accepted query,
  and verifies the dataset rows. It asserts zero compatibility approval rows.
  The binary only reads/writes its isolated fixture files; no actual business
  CLI, credentials, network provider or model is used.
- `/tmp/clem-space-executor-readiness-red.txt`: restoring the old trust module
  makes both new unsupported-runner/CLI regression pins fail (**2/2 red**).
  Exact current source bytes were restored in `finally`.
- `/tmp/clem-space-executor-readiness-outcomes.txt`: **32/32** runner and
  historical-terminal checks after the final outcome-copy refinement (overlaps
  the 96 above; do not add the counts). The missing-executor outcome explicitly
  requests repair and does not say to retry.
- Final TypeScript passed in
  `/tmp/clem-space-executor-readiness-tsc-final-3.txt`; `git diff --check` passed.

Historical-decision tests now explicitly seed the persisted old card shape;
they no longer require current production code to recreate the bug before
checking recovery. This preserves restart, terminal projection, no-process,
old-denial and idempotency assertions. Two backoff fixtures previously used a
local-registry manifest pretending to be a provider read; after `1a4e6fdeb`,
refresh correctly revalidates metadata and those fixtures failed. They now
supply an actual fixture Composio manifest, connected namespace, metadata
revalidation and independently observed catalog. The actual read kernel,
physical fixture port, failing/recovering reads, scheduler and notice assertions
remain real. These intermediate failures were corrected, not waived as
pre-existing production defects.

The live-home sentinel remains **NOT PERFORMED** because daemon 72427 is active.
No full corpus, journeys, build, hotpatch, paid-model test, live business call or
installed acceptance was run. Source-test success is not evidence that the
owner's installed sources have recovered.

### Remaining incident work

- Integrate supported legacy-script execution through the shared tracked shell/
  workflow machinery, or complete an owner-reviewed source redesign separately.
  Do not reopen the retired subprocess path or claim arbitrary code is read-only.
- Group simultaneous failure notices without hiding exact source failures or
  changing delivery destinations. This patch does not reduce cross-channel
  fan-out or suppress genuine failures.
- Review the combined candidate with the shell/two-modes lane, build and install
  it once, verify the served fingerprint, and run controlled live-home source
  refreshes. Check saved/implicit accounts and provider-definition recovery.
- The independent connection-continuity lifecycle/usage ledger, public recovery
  controls and full release qualification are still unfinished. Do not tag this
  branch or expose Execute Continue as if those obligations were complete.

## Grouped source reports and reliable notification admission

Follow-up after `4ee7f6261`. This is source work, not a hotpatch. Ownership was
rechecked: the shell/two-modes worktree is still clean at `76c53a1ea`.

Simultaneous sources reaching the existing failure-notice threshold now form
one report **per Space per scheduler evaluation**. Every source keeps its own
failure count, typed reason, repair guidance, observation and backoff. Different
Spaces remain separate. A single-source report retains its original id and
format. A group id is derived from sorted member-streak ids, independent of
iteration order and delivery time; mixed causes remain separate in metadata.
The phone banner names the number of sources without quoting their data.
Destination selection is unchanged. This consolidates reports; it does not
suppress genuine errors, merge unrelated tasks, or automatically repair data.

Review found a second defect: `recordSourceRefreshFailure` marked a code told
before `addNotification` succeeded, and its catch discarded the write failure.
The scheduler now commits an immutable pending report with the streak state
before attempting notification admission. A partial notification/queue write
keeps that outbox entry. The next scheduler tick retries the exact id and
original timestamp, even with no due source; it does not rerun reads to send
an alert. Existing notification admission recovers its own queue on stable-id
retry, preserving destination receipts. Restored outbox metadata admits only
failure-report fields, never arbitrary routing/approval authority.

Both scheduled refresh and paused-Space retry now use the existing shared file
lock across their state read/awaited work/write. This prevents one entrypoint
from overwriting another's outbox generation and serializes concurrent ticks.
State saves flush the file and renamed directory before notification admission.
The source retry policy and catch-up behavior are unchanged. Legacy decline
copy no longer suggests that a refresh click erases an old decision.

Verification:

- `/tmp/clem-grouped-source-notices-green.txt`: **63/63** across source backoff,
  scheduler, notification delivery and notification durability.
- `/tmp/clem-grouped-source-notices-schema84.txt`: **20/20** source/scheduler
  checks on committed schema 84 with final locale-independent ordering and
  outbox-id validation. The unrelated schema-85 draft bytes were restored in
  `finally`. These counts overlap; do not sum them.
- `/tmp/clem-grouped-source-notices-red.txt`: restoring the previous scheduler
  makes both new integration pins fail (**2/2 red**). Exact source bytes restored.
- Final TypeScript passed in `/tmp/clem-grouped-source-notices-tsc-final-2.txt`.
  `git diff --check` passed.
- The grouped test drives three due sources across two Spaces and two concurrent
  scheduler calls: two reports, three failures, one observation per source per
  occurrence, and unchanged per-source backoff. The recovery test forces the
  actual notification delivery-queue write to fail after record persistence,
  interleaves paused-Space retry, reloads the JSON state and admits exactly one
  queued notification without another source refresh. This is disk reload
  evidence, not a killed-daemon or installed-phone acceptance claim.

No models, live provider calls, external messages, app restart, install, build
or tag. Live-home sentinel still **NOT PERFORMED** with daemon 72427 running.
Installed acceptance must confirm readable desktop/mobile details, navigation,
one grouped report on each configured destination, and retained per-source
failure/recovery facts. Existing delivered alerts were not deleted or rewritten.

### Execution integration is still real work, not an approval toggle

The other lane's shell improvements operate on accepted chat `work_call`s.
Our source branch does not yet include that lane's `run_shell_command` ordinary
local-change and off-machine approval work. The reviewed-local workflow carrier
currently covers file reads, file revisions, artifact bundles and Workspace
datasets; it has no general shell adapter. `workflow-node-invocation-executor`
explicitly distinguishes attested computation from opaque execution. Simply
relabelling a script as a read/compute capability, reusing an old trust card,
or calling the retired `runScript` body would bypass those contracts.

The remaining supported-script route needs an owned scheduled occurrence,
exact declaration/entrypoint binding, the existing shell effect/consent checks,
shared logical and physical dispatch/settlement, bounded result handling, Stop
and restart behavior, and no replay when an earlier process may have produced
side effects. It must be reviewed together with the other lane rather than
copying a raw spawn into Spaces. No claim is made that this notification change
restores the five retired script sources. Combined integration, the original
connection/budget lifecycle work and installed/live qualification remain owed.


## Combined source review with the shell/two-modes lane

A separate integration checkout now combines committed source from
`codex/contextual-connection-ui` at `8460a88a5` and `claude/two-modes`
at `76c53a1ea`. Its branch is `codex/connection-shell-integration` at
`/Users/nathan.reynolds/.codex/worktrees/connection-shell-integration/clementine-next`.
The other agent's worktree remained clean at the same revision after checks.
Main, the installed app, credentials and personal Space declarations were not
changed. The three-file model invocation ledger/schema-85 draft remains only
in the original connection checkout; it is deliberately absent here.

The one textual conflict was the host turn's terminal reducer. Both inputs
are retained: the active agent needed for connection/recovery handling and
an exact approval id from the shell lane's queued-card materialization. Taking
either side wholesale would discard a feature. The remaining source merged
without textual conflicts; that alone is not a regression acceptance claim.

Verification on the combined tree (committed schema 84):

- `/tmp/clem-connection-shell-integration.txt`: **114/114**, covering ordinary
  shell execution, off-machine command/card/approval execution, chat approval
  resume, connection execution closure, source connection checkpoints, source
  budgets, Space read authority, legacy Space decisions, source backoff and
  scheduler notification admission.
- `/tmp/clem-connection-shell-consent-integration.txt`: **42/42**, covering
  approval-resume source compilation, consent policy/direct dispatch, approved
  write-kind routes and pending-action routes. The source-compilation file was
  mistyped in the first command; it was explicitly run at its correct path in
  this second check. The first count does not claim coverage of that file.
- `/tmp/clem-connection-shell-integration-tsc.txt`: TypeScript passed.
- `git diff --check --cached` passed; no unresolved merge paths.
- These use controlled fixture models and loopback endpoints, not paid models
  or external sends. No full suite, journeys, build, installation or live-home
  acceptance was performed. The isolation sentinel reported **NOT PERFORMED**
  because the running daemon (72427) owns and updates the live home; this is
  not evidence that the fixture run wrote to it, nor a claimed isolation proof.

This is a combined **source** candidate only. Its new fixes are not installed.
The other lane's checkpoint records installed `019e8d9d5`; no new served
fingerprint was created or claimed by this integration. A coordinated build,
install, served-identity check and named controlled live refreshes remain owed.

### Next implementation boundary

The five retired Space script sources still have no execution carrier.
The shell lane explicitly tests that `run_shell_command` has no workflow
`localExecution` contract. Adding that field alone would misrepresent opaque
execution as a reviewed/reconcilable adapter. The existing deterministic
workflow runner also does not solve this by being callable: its admitted
workflow revision, run, step, pinned script and terminal lifecycle belong to
that workflow, not to a saved Space source. Calling its spawn helper directly
would lose those properties.

The bounded next slice is a source-owned local execution adapter under the
existing durable call kernel: bind an exact scheduled occurrence, saved
manifest and script revision; run the existing guarded process substrate;
settle physical execution once; publish source data only after successful
structured output; preserve any uncertainty after a process was started.
Keep script execution's effect truthful, retain exact consent and prior
human declines, and do not infer read-only behavior from a filename/hash.
First pins must cover changed bytes, wrong occurrence, refusal before spawn,
nonzero exit, timeout/Stop, completed-call replay and interrupted-call recovery.
Do not migrate the owner's manifests or launch their existing scripts to
paper over the missing framework carrier. This work is not yet implemented.


## Process cancellation prerequisite for scheduled local execution

On combined source `1b94cbeec`, review of the shared process substrate found
that `spawnSandboxedScript` terminated only the interpreter process and had
no caller cancellation signal. A nested CLI could survive a timeout. Existing
deterministic workflow steps also bypassed the run's cancellation watcher
while waiting for the script. This is a separate framework defect discovered
during adapter work; it is not claimed to be the cause of the morning's
`local_runner` refusals.

The shared process substrate now accepts the owning run's AbortSignal. An
already-aborted owner starts no process. A started process reports `spawned`
even when later cancelled, and cancellation is distinct from timeout or a
launch failure. On POSIX the child starts in an owned process group; Stop,
timeout and output overflow terminate that group and escalate to SIGKILL.
A wrapper's early close also kills remaining group members instead of
assuming its close means every child exited. Timer/listener cleanup is tied
to the one process outcome. Windows uses taskkill /T /F, with a direct-child
fallback if that mechanism fails; Windows behavior was not exercised here.
This is process-group ownership, not an OS confinement claim: deliberately
escaped processes and already-produced effects are not rolled back.

Deterministic workflow steps and loop probes now register an abort target
with the same per-run watcher used by model/tool attempts. It still reads
cancellation state once per run rather than once per fan-out child. The
exact target is removed in finally. A stopped script throws the existing
WorkflowRunCancelledError, preventing retry or success publication; a final
cancellation check also covers Stop arriving as the child exits. An unrelated
run retains its own watcher and can finish normally. No approval semantics,
credentials, source declarations or model routes were changed.

Verification (controlled temporary homes, no model/provider traffic):

- `/tmp/clem-deterministic-process-stop-final.txt`: **33/33** across the shared
  substrate, deterministic workflow runner and durable cancellation tests.
  Pins include pre-launch cancellation with no marker write, nested children
  that ignore SIGTERM with inherited or detached stdio, nested-child timeout,
  synchronous launch argument failure, active workflow Stop, no step-completed
  event for the stopped process, and an unrelated concurrent run completing.
- `/tmp/clem-deterministic-process-stop-overlap.txt`: **3/3** existing workflow
  checks for Tasks-board Stop during an approval wait, exact approval-resume
  attempt identity, and the Tasks-board cancellation source.
- `/tmp/clem-deterministic-process-stop-red.txt`: **6/6 expected failures** when
  both production modules are temporarily restored to `1b94cbeec`. Candidate
  bytes were saved and restored exactly in finally; no test process remains.
- `/tmp/clem-deterministic-process-stop-tsc.txt`: TypeScript passed.
- The broad live-home isolation sentinel remains **NOT PERFORMED**, because
  daemon 72427 owns and writes that home. These are fixture checks, not
  installed-app acceptance. No full suite/journeys/build/hotpatch/tag was run.

The other agent's `claude/two-modes` checkout remains clean at `76c53a1ea`.
Main and the installed app were untouched. This fixes cancellation for an
existing execution surface and supplies a prerequisite for the scheduled
adapter. The five retired Space scripts are **still not executable** through
that adapter; their durable source/occurrence binding, authority, once-only
settlement and restart recovery remain the next implementation work. The
wider connection-continuity ledger and release qualification remain open.

## Saved-source execution carrier: exact one-occurrence admission

Implemented after `09895a3c7` on `codex/connection-shell-integration`, alongside
the unchanged `claude/two-modes` lane at `76c53a1ea`. This is a source candidate,
not an installed fix and not permission to restore the old raw `runScript`.

The new internal `workspace_source_script` operation has no model/CLI lanes.
Its registry contract selects a host carrier through the existing emitted
invoke port. It is classified as opaque `admin` execution, never a read or a
reversible dataset write. Ordinary shell retains its existing separate path;
it did not gain a workflow execution contract. The compiler accepts explicit
host-authored admin preparation while still rejecting read/write/send
escalation to admin.

`workspace-script-authority.ts` prepares an exact shared v3 one-shot consent
request and activates only its resolved, approved registry row. Arguments bind
the Workspace, saved source ID, whole source declaration digest, entrypoint
digest, manual/scheduled cause and durable occurrence. Neither activation nor
reentry invents a fresh occurrence. Old runner trust does not satisfy this
contract, and none of the owner's past decisions were modified. New admission
requires the saved declaration and entrypoint still to match. Recovery uses
the retained activation/plan/canonical arguments, without readmitting the work.

The host carrier requires the module-minted call attestation and exact live
dispatch lease. It rejects archive/status/declaration/content drift, ambiguous
executor declarations and symlinked Workspace/data/entrypoint paths before
launch. It reads and hashes one open file and runs a private sibling snapshot
with the same extension and parent directory, using the shared guarded process
substrate and scrubbed environment. The logical/physical kernel retains the
result once. Reentry into a claimed/uncertain process never dispatches again.
The script's stdout must be one JSON document; script-authored receipt or
authority fields remain nested data and cannot become host evidence. The
host receipt proves entrypoint exit and output, not arbitrary downstream
business correctness or a committed dataset.

Two framework defects were exposed by driving this carrier through the real
shared kernel and fixed there:

- The kernel checked AbortSignal before admission but did not carry it to an
  already-running tool. It now passes it through the existing tool-abort
  context. The script combines it with its authority/lease cancellation fence,
  so Stop reaches the owned process group. A caller that merely observes an
  already-claimed occurrence cannot abort the winning call.
- A known refusal before process launch became `uncertain_write`. A small
  host-only WeakSet now distinguishes a host-proven no-dispatch error from
  provider text, error names or serialized lookalikes. The kernel preserves
  the exact refusal as zero-body. Started processes that fail, time out, stop
  or return malformed output remain uncertain and cannot silently retry.
  Preparation/network failure behavior outside this host proof is unchanged.

Verification on this source candidate, with no paid models or live providers:

- `/tmp/clem-workspace-script-final.txt`: **82/82** across the new script tests,
  existing shared read kernel, reviewed local tools/storage/capability,
  registry classification, effect-direction checks and existing local v3
  workflow integration.
- `/tmp/clem-workspace-script-terminal.txt`: **2/2** additional checks for
  physical lease revocation without an AbortSignal and malformed JSON after
  successful process exit. The first draft of the revocation test called the
  terminal closer mid-I/O; that correctly returned `not_ready`. The test now
  revokes the exact physical lease through the existing recovery fence rather
  than mistaking a refused terminal close for cancellation.
- `/tmp/clem-workspace-script-red.txt`: **4/4 expected failures** with the
  kernel temporarily restored to `09895a3c7`: three drift refusals were
  mislabeled uncertain, and Stop did not reach the child. Candidate bytes were
  restored exactly in finally and verified by SHA-256.
- `/tmp/clem-workspace-script-tsc-final.txt`: TypeScript passed.
- `/tmp/clem-workspace-script-artifacts-verified.txt`: emitted component
  artifacts verified current; manifest digest
  `399bb957ca9670dbc9427ba1e4bde692d9650dc3e4b0709fefeb717e9fb09610`.
- The script checks include pending/declined consent, wrong occurrence/cause,
  source/entrypoint/archive drift, symlink refusal, concurrency, Stop, timeout,
  started-process failure, untrusted output and one retained physical result.
- Two fresh-process checks remove isolated-transport markers but retain an
  explicit disposable home. They verify the emitted **production** invoke and
  transport digests, one logical/physical/settlement row, completed replay even
  after deleting the original script, and uncertain reentry without a second
  marker write. These are production-carrier fixture checks, not installed-app
  or live-home acceptance.
- Canonical argument order is significant in the existing v3 seal. Re-parsing
  the call with Zod before hashing silently reordered keys and correctly
  refused the binding. Activation now forwards the compiler's canonical object
  verbatim; schema validation does not replace those sealed bytes.
- Harness component artifacts were regenerated for these checks. The desktop
  app was not built, signed, installed, restarted or hotpatched. No full suite
  or journey run was performed. The broad live-home sentinel still reports
  NOT PERFORMED while the active daemon owns/writes that home.

Still owed before enabling scheduled scripts:

1. Wire a saved-source consent scope that explicitly covers its schedule and
   code revision, with revocation and prior-denial preservation. The current
   exact one-shot adapter is a prerequisite; do not create a fresh approval at
   every tick or turn old trust into new authority by inference.
2. Persist source-owned occurrence and activation/plan/argument recovery
   material before launch. Reopen that exact material after restart. An
   uncertain older occurrence must block automatic later ticks for that source
   until resolved; changing the occurrence ID is not recovery.
3. Connect scheduler/manual refresh and approval resolution to this adapter,
   preserving the existing refresh serialization and dataset observation
   transaction. Publish data only from a successful host result. Do not put
   untrusted script receipt fields on the approval/effect surface.
4. Exercise interruption between process return, kernel settlement and source
   observation commit. Test repeated scheduled occurrences, schedule/code
   edits, refusal/revocation, and cross-process restart of each gap.
5. Coordinate the combined build/hotpatch, verify served identity, then run
   named controlled installed-app/live-home acceptance before claiming the
   retired source failures are fixed. Personal source manifests remain intact.

Limits: this is process ownership, not OS confinement. Entrypoint bytes are
frozen; imported helpers, executables, account credentials and network state
remain live. Consent must disclose that scope. Hidden sibling filenames may
differ from code that assumes its original basename, though relative imports
and the parent directory are preserved. Windows process/path behavior is not
certified by the macOS checks. No performance or token improvement is claimed
from deterministic fixtures alone.

## Durable saved-script occurrence and dataset recovery

The follow-on source change adds `workspace-script-occurrence.ts` and migration
85. It is an internal source owner between the exact one-shot adapter above
and the existing dataset ledger. It does not yet enable the scheduler or mint
recurring consent, and it is not installed-app acceptance.

Before consent, the coordinator preserves the current file-backed dataset,
then records the exact source declaration, transforms, canonical arguments,
compiled plan, logical call identity and consent payload. One unpublished
occurrence per Workspace/source is enforced in SQLite. A new tick, changed
code or restarted daemon cannot bypass an unfinished/uncertain occurrence by
inventing a new ID. Pending, declined and unrelated approvals cannot activate
it. Historical trust records are not used as authorization.

Activation and the coordinator's address are deliberately separate durable
edges. The shared authority arm publishes activation events after its own
transaction, so wrapping it in another transaction would risk publishing an
event whose outer transaction later rolls back. Instead, the coordinator
records the exact approval address before arming and recovers a missing
activation address from the kernel's own exact session/logical-call journal.
It never re-prepares already-armed execution from possibly changed files.

The shared kernel still owns physical dispatch and its retained result. On
restart the coordinator registers the current host port, but reuses the saved
plan and canonical argument bytes. Successful host output is checked against
the occurrence, transformed with one retained observation time, and committed
through the existing Workspace observation transaction. Recovery checks the
observation's content digest as well as provenance; it heals a failed file
projection without running the script again. Memory/retention use the existing
idempotent finalizer. The source barrier releases only after publication.

A retry's `zeroBody` is not proof that an earlier process had no effects. All
unfinished/uncertain occurrences remain held. Explicit user resolution of a
declined, cancelled, changed or uncertain source is still part of the pending
consent/recovery caller work; this journal is not a new user-facing dead end.

Migration traps found and fixed in this slice:

- Historical v32/v40 upgrade rehearsals retain later tables while replaying
  migrations. The new table/index use additive `IF NOT EXISTS`, consistent
  with the existing schema migrations.
- Source ownership must survive session retention without making unrelated
  session cleanup fail. The journal intentionally has no cascading session
  foreign key; deleting a session cannot erase the source barrier.
- The untouched `connection-continuity` worktree has an uncommitted **different
  migration 85** for a draft model-invocation ledger. That draft is excluded
  here. If it is resumed/merged, renumber it after the accepted journal
  migration and rehearse the combined chain; never silently merge two v85s.

The app still requires a fresh build and coordinated hotpatch. The last
verified installed runtime was `019e8d9d5` / harness schema 82. The new source
expects schema 85. No live source manifest, personal workflow, credential,
setting or installed file was changed in this slice. The fixtures use named
disposable homes and never reset the live home.

Next production work remains explicit recurring source/schedule/code consent
with revocation and prior-denial preservation, scheduler/manual/approval
resolution callers, and an owner-visible way to resolve held work. Then build,
verify the served fingerprint/schema and run controlled installed-app/live-home
acceptance. There is still no basis for calling the retired script sources
fixed in the installed app or declaring a tag ready.

Verification of this occurrence slice:

- `/tmp/clem-script-occurrence-qualification-final.txt`: **131/131**, including
  19 occurrence checks, the earlier script carrier checks, dataset/history and
  finalization checks, event-log tests and schema readiness. The two earlier
  migration failures were introduced by this slice and fixed before this run;
  they are not described as pre-existing.
- Three checks use two fresh processes and the emitted production carrier in
  an explicitly disposable home: crash after kernel settlement, crash after
  observation commit, and uncertain execution. The successful cases retain
  one process crossing and one dataset observation after deleting the original
  script. The uncertain case keeps subsequent ticks held.
- Additional coverage includes the DB-commit/file-projection failure seam,
  concurrent reentry, pending/declined/wrong approvals, source edits before
  publication, preservation of the prior dataset before execution, exact
  stored-content checking, and the source barrier surviving session cleanup.
- `/tmp/clem-script-occurrence-red.txt`: **2/2 expected semantic failures** when
  baseline capture and stored-content verification were temporarily removed.
  The original candidate bytes were restored in `finally` and SHA-256 checked.
- `/tmp/clem-script-occurrence-typecheck-final.txt`: TypeScript passed.
- Component artifacts were regenerated; executable digests are unchanged,
  while the emitted manifest records the new schema input size. This is not
  a desktop build. No full suite, canonical journeys, model call, live provider
  request, hotpatch or tag was performed.
- The runner's broad live-home isolation sentinel remains **NOT PERFORMED**
  because live daemon 72427 owns that home. Disposable process fixtures are
  not represented as proof of installed/live-home behavior.

## Explicit recurring consent through the existing v3 kernel

The next slice adds `runtime/harness/saved-source-consent.ts`, schema 86, and
the occurrence coordinator's `activateWorkspaceScriptOccurrenceWithGrant`.
This is still internal source work: scheduler/manual entry points, scope-card
presentation/resolution recovery and user-facing revocation are not connected.
Do not offer these cards in production until their full resolution path exists.

One explicit `workspace_source_script_consent` approval names the Workspace,
saved source, entrypoint hash, whole declaration digest, runner, cron and time
zone. It says that manual runs and the saved schedule use local user credentials,
network and live dependencies, only while the approved source/script match and
until revoked. It does not call arbitrary script execution a read, imply an OS
sandbox or imply downstream business success from process exit. The card's
answer deadline is separate from this explicitly described recurring scope.

The approved card is consumed exactly once into a retained scope grant. Every
new occurrence gets its own v3 root and an exact consent derivation receipt in
the same activation transaction. No fake per-tick human approvals are created.
The module-minted authorization must match an authentic prepared call and the
durable source-owned occurrence. Wrong source, account, operation, runner,
schedule, zone, argument bytes, code or declaration cannot borrow the grant.
A structural copy of the authorization grants nothing. Existing one-shot and
canonical Auto consent paths retain their behavior.

Revocation is rechecked inside the activation transaction, before process
launch, and by the running carrier's cancellation monitor. Revoking a running
script stops its owned process and holds uncertain effects rather than retrying.
Historical consent remains readable after revocation, so completed results
can replay without re-executing or pretending the grant is still active.
An already-used/revoked approval cannot recreate an active grant.

Verification:

- `/tmp/clem-script-consent-qualification.txt`: **151/151** across new scope
  checks, saved-script execution/occurrence recovery, existing Space action
  v3 and Auto paths, generic v3 durable activation, reviewed local workflow
  execution and event-log migrations/retention.
- `/tmp/clem-script-consent-migration.txt`: **1/1** additional v85→v86 check:
  unfinished source owners survive unchanged; no grant is fabricated; migration
  replay is idempotent. Schema readiness now expects 86, not 85.
- The repeated-run check uses one real scope approval for scheduled → manual
  → scheduled execution and counts exactly three logical calls, three physical
  crossings and three settlements. Two further fresh-process checks use the
  emitted production carrier in named disposable homes, preserving active and
  revoked grants, completed replay, and one approval across restarts.
- `/tmp/clem-script-consent-red.txt`: **2/2 expected semantic failures** when
  the current-revocation and exact-cron checks were temporarily removed. The
  original candidate bytes were restored in `finally` and SHA-256 checked.
- `/tmp/clem-script-consent-typecheck.txt`: TypeScript passed.
- `/tmp/clem-script-consent-artifacts-verified.txt`: component artifacts verified
  source-current. This is not an app build or hotpatch.
- No model calls, live provider calls, personal source edits, full suite,
  canonical journeys, installed-app/live-home acceptance or tag occurred.
  The broad live-home sentinel remains NOT PERFORMED while daemon 72427 runs.

Next: the real refresh caller must select/recover the source-owned occurrence,
check current scope and historical denials, offer one readable executable scope
card when needed, and resume that exact occurrence after approval/restart. It
must preserve the existing Space refresh queue and reuse the coordinator's
committed observation rather than double-transforming or writing it twice.
Decline, revoke, source edits and uncertain effects need truthful actionable
states; none is permission to auto-clear the source barrier. Standalone approval
routing must recognize the new tool so a scope decision never starts a second
chat/worker turn. Only after these callers are complete should this candidate
be built/hotpatched for controlled installed acceptance.

The uncommitted model-ledger draft on `connection-continuity` still calls its
separate migration 85. It remains excluded. If resumed, renumber it after the
accepted 85/86 chain and test the combined upgrade; do not overwrite either
committed source-ownership migration.

## Production refresh, scope approval and restart callers connected

This follow-on connects `refreshSpaceData` to `workspace-script-refresh.ts`.
Manual refresh, scheduled refresh and creation smoke now reach the saved-script
occurrence owner. The retired `runScript` / unowned single-source APIs remain
zero-body. A supported saved source first receives one explicit recurring
scope card; approving it resumes the retained occurrence through the existing
Space queue, v3 kernel, process carrier and dataset transaction. Later matching
manual/scheduled occurrences reuse the grant without fabricating more cards.

Success already contains a committed observation. The outer refresh skips its
ordinary transform/write/finalizer for that result, preserving mixed-batch
alignment and avoiding duplicate publication. Replayed results retain their
observation ID, change state and saved-byte receipt. An unfinished occurrence
wins over a newer tick. A caller's stable refresh ID cannot change its cause.
Automatic `retry` can recover an existing/addressed occurrence; it cannot
invent a new manual run after the old one completed or before an owner exists.

Approval listeners register without reading the database. Daemon boot starts
recovery after the existing event-log migration/ownership fence. Desktop
approval control recognizes the scope tool as standalone work and completes
the exact control turn without launching another brain or competing executor.
The existing async Outcome surface reports the actual data-save result. Mobile
uses the shared approval registry; physical-device acceptance is still owed.

The caller preserves rejected/revoked decisions and reuses pending cards.
Exact obsolete pending legacy cards are retired before the executable scope
card appears; historical approval never becomes new execution authority.
Saved grants remain usable after approval registry retention. Unsupported
scheduled requests without a saved schedule do not get a futile card.

Failures of the supported carrier now use `script_held`, distinct from the
retired raw `local_runner` path. Scheduler notices no longer say that all
scripts are prohibited when a saved script is actually held. Legacy approval
handoffs awaiting the new scope report `needs_input`, not a failed execution,
and do not create an extra failed-refresh operational notice.

Verification and attribution:

- Initial caller/routing set: `/tmp/clem-script-refresh-tests.txt`, **83/83**.
- Expanded parallel set: `/tmp/clem-script-refresh-qualification.txt`,
  **264/277 passed**. Ten assertions still pinned permanent script unavailability;
  they were updated to assert pending consent rather than failed execution,
  retaining no-process-before-consent, baseline preservation, deduplication and
  last-success timestamp checks. Backoff tests now approve a real script that
  exits unsuccessfully, then prove one physical execution across later ticks,
  grouped notices and notification recovery. These were not skipped.
- That parallel run also failed `desktop qualified approval steers the live
  owner without authorizing its pending call` with `SQLITE_IOERR_SHMOPEN`,
  `production process restart recovers after_observation without duplicating
  execution` with `SQLITE_FULL`, and `mixed refresh batches keep result
  alignment and do not publish a script result twice` with a 10-second
  Workspace file-lock timeout. Disk availability after the run was 9.3 GiB
  (98% data-volume usage). Do not call these pre-existing or claim that the
  parallel run qualified the candidate; no HEAD/tag attribution was performed.
- All six affected suites rerun serially:
  `/tmp/clem-script-refresh-serial.txt`, **84/84**, including the three named
  failures above. The storage/lock failures did not recur on that run.
- After adding the retry-ownership fence, final affected refresh, runner,
  scheduler, backoff, creation-smoke and daemon-boot checks:
  `/tmp/clem-script-refresh-final.txt`, **86/86**. Counts overlap; do not add
  them into a fictional number of distinct tests.
- The new public-caller suite includes two production-transport fixtures,
  each across three fresh processes: approval persisted while offline and a
  SQLite publication-gap fault after the script completed. Recovery preserves
  one process crossing, one observation, one completion report and one card;
  a further restart adds none. No test transport or model provider is used.
- `/tmp/clem-script-refresh-red.txt`: removing the prior-decision fence makes
  the decline test fail because a replacement approval is offered. Original
  source bytes were restored and hash-verified before subsequent checks.
- `/tmp/clem-script-refresh-typecheck.txt`: TypeScript passed.
  `/tmp/clem-script-refresh-artifacts-verified.txt`: component artifacts are
  source-current. This is not an application build.
- The live-home isolation sentinel is **NOT PERFORMED** while daemon 72427
  writes that home. These disposable fixtures are not installed acceptance.
  No model calls, external sends, personal source changes, credential edits,
  application install/restart, main update, push or tag occurred.

Still owed before the combined hotpatch and tag qualification:

1. Finish owner-visible source controls for revocation, explicitly reconsidering
   a denial, changed-but-unstarted sources, and resolving uncertain effects.
   Never clear a held occurrence automatically just to get the next tick green.
   Reconsideration must address the exact state, preserve old receipts and
   preserve no-replay; it is not permission to execute another run by itself.
2. Complete/review card presentation and report-back recovery, including the
   gap after publication is marked complete but before its report is delivered.
   A source success in the ledger must remain distinct from delivery success.
   Check the readable controls on both desktop and mobile.
3. Recheck combined ownership, run remaining release gates on a suitably idle
   machine with sufficient storage, build once from the final reviewed source,
   then coordinate the Terminal/signing hotpatch. Verify actual served identity
   and migration to schema 86 before controlled installed-app/live-home tests.
4. Run the agreed workflow author/update/enable/execute, approval/correction,
   restart/cancel/no-replay, model/tool routing and long-task checks, followed
   by matched total-token and wall-time measurements. No live improvement or
   release readiness is established by this source slice.
