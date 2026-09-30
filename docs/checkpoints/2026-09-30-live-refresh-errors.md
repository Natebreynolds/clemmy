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
