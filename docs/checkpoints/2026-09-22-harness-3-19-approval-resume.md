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
