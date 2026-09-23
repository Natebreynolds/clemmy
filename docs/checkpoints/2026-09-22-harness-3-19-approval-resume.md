# Harness 3.19 — approval/resume candidate preparation

Status: implementation prepared; **not live accepted**. This is section 6 item 1 of
NEXT-TAG-HANDOFF-2026-09-22.md, not completion of that item or the eight-item plan.

## Verified

- Own worktree: `../clementine-next-harness-3-19`, branch `harness/3.19`, based
  on shared main `a7796c523`. Remote `v3.18.20` was absent when checked.
  No changes to main, UI-owned paths, or the owner's uncommitted handoff.
- Installed build observed read-only: gitSha `fcaa8754f18ced897901ffe7f4c271a0db907ac6`,
  fingerprint `c33943ab5a108cdc0a806da4e2b653eb4a79b028d8cac16c23802abc456a18c9`,
  entry beneath `~/Applications/Clementine.app`. This is NOT this candidate.
- Found and pinned a mirror identity defect: call IDs reused across sessions
  collapsed different sends into one notification. Missing IDs were replaced
  with wall-clock timestamps, making replay identity unstable.
- New identities hash the exact session/call tuple. Missing durable identity
  produces no fabricated mirror. Exact legacy mirrors are retained on replay;
  another session's legacy row cannot suppress a new send. No execution or
  approval authority changed.
- Before fix: mirror suite 3 passed / 2 failed (the two new regression names).
  After fix: 38/38 across external-send-mirror and approval-registry suites,
  including a fresh child-process mirror replay and existing approval reopen /
  once-only claim coverage. Typecheck passed. These are credential-free isolated
  checks, not installed-app acceptance; no model calls were made.
- Logs: `output/harness-3-19/approval-resume/{mirror-before,focused-after,typecheck}.log`.

## Skipped

No app restart, hotpatch, provider send, mobile approval, full suite or journeys.
The installed app remains owned by the UI/release cycle. The isolated runner's
live-home sentinel explicitly did not run because a daemon owns the live home;
do not describe the test result as sentinel certification.

## Owed for item 1 acceptance

1. Confirm the UI agent is outside its patch cycle and retain rollback identity.
2. Obtain the owner's private test destination and phone participation. Prepare
   one exact gated message and let the owner approve it on the phone after the
   restart, including the repeated tap; never approve business messages as a
   substitute for this controlled fixture.
3. Use the documented Terminal .command patch recipe, build after the final
   commit, launch by full app path, and match served gitSha/fingerprint before
   driving a fixture. Preserve UI-owned installed assets.
4. Record one accepted source/terminal, durable approval, exact physical
   dispatch/settlement, provider readback, and exactly one in-app mirror after
   restart/double tap. Match before/after work and report wall time, calls,
   input/cache/output tokens and attribution limitations. None measured yet.
5. Broader mirror recovery after settlement but before notification publication
   remains outside the focused identity fix; inspect it during the crash canary.
6. Do not land on main before the UI agent's tag. Rebase afterward and review
   each series. Do not tag from this branch.

## Memory: traps to carry forward

- A provider/model call ID alone is not global identity. Scope persistent
  projections by the exact durable owner and call; timestamps are not replay IDs.
- Changing a projection ID needs a legacy replay check or upgrades re-notify users.
- The installed daemon can differ from both HEAD and the handoff's recorded SHA.
- `open -a Clementine` selects a stale bundle. Launch by full path.
- Any commit, including this checkpoint, changes the build fingerprint: build
  afterward. A successful build does not authorize interrupting a UI patch cycle.
- Fixture generators and registry tests do not prove physical phone interaction,
  one provider effect, or delivery. Keep those acceptance claims separate.

## Continuation: mirror lifecycle evidence

The initial candidate `aa71887d7` built successfully with source fingerprint
`1a9d3589c200d172f9df1bb5093e2b6dbca701b3342c0618a63b565106feb71a`.
It was not installed. Main still had no remote v3.18.20 tag on recheck; the UI
agent was actively editing its shared feed routes. No installed-app changes made.

Further focused approval-path checks passed 53/53: source ownership,
checkpoint continuation, chat approval resume, replay retirement, and hooks.
Inspecting those hooks exposed two more first-item mirror defects:

- A successful return that omitted arguments lost its mirror even though the
  admitted start carried them.
- A successful-looking end with no admitted start could create a send mirror.

Two provider-neutral fixture tests failed before the correction (32 pass,
2 fail). Hooks now retain send arguments only for their admitted lifecycle,
release them on its end, and publish the mirror only for the paired current
start. This does not grant or modify dispatch authority. Afterward the hooks
and mirror suites passed 41/41. Logs: `hooks-before.log`, `hooks-after.log`,
`approval-path.log` alongside the earlier evidence. Live phone/restart proof
and complete physical-settlement accounting remain owed as above.

Memory trap: an SDK end callback need not repeat arguments, and callback success
alone is not evidence of an admitted send. Use the paired start's original input;
never reconstruct its message from a clipped event preview or unrelated end.

## Continuation: fresh-process approval race

Candidate `795ece4f7` built successfully at fingerprint
`c855d16a879200afecc6cc853397d2bb552776cba36026fd7d5369b93dd3c53b`.
It remains uninstalled. The remote tag is still absent and the shared UI routes
are still being edited; the installed build remains `fcaa8754`.

The existing duplicate-resolution pin calls resolve twice sequentially. The
existing restart pin closes and reopens the database in the same process.
Added a separate credential-free fixture that shuts the parent connection,
starts two fresh processes, waits until both are ready, then releases both to
resolve the same approval. A second pair of fresh processes claims that exact
grant. All workers have deadlines and are reaped before fixture cleanup.

Before correction, the exact grant claim failed twice with `database is locked`
at approval-registry.ts's consumption UPDATE. Both deferred transactions can
read an unconsumed approval, and one cannot upgrade its stale read snapshot to
a writer after the other commits. The one-shot UPDATE prevents a duplicate
winner, but the loser throws rather than returning the settled consumed state.

All three registry read/consume transactions now use BEGIN IMMEDIATE through
the existing transaction API. The writer reservation precedes the read, so a
competing claimant reads the committed result. Exact card, lifetime, payload,
and pending-action-owned checks remain intact. No generic retries, changed
approval policy, provider conditions, or model calls were added.

Verified after correction: 41/41 in approval-restart-race, approval-registry,
approval-resume-source, approval-resume-continuation, and
approval-replay-retirement.red. This includes both exact-card and session-claim
fresh-process races. Typecheck passed. Evidence: `race-before.log`,
`race-after.log`, `race-typecheck.log` in the candidate output directory.
This is a grant-concurrency pin, not a real provider dispatch or mobile proof.
Live canary and matched task usage remain owed.

Memory trap: sequential duplicate calls and closing/reopening one connection do
not exercise concurrent-process WAL read-to-write upgrades. Approval-consuming
read/modify/write transactions need the writer reservation before the read; a
conditional UPDATE alone prevents double consumption but not SQLITE_BUSY.
