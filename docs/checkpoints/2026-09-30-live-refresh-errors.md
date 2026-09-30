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
