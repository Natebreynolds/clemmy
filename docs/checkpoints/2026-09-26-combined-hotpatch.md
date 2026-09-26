# Combined hotpatch candidate — 2026-09-26

Owner authorized takeover and installed-app hotpatch after the other agents paused. Integration lives on codex/combined-hotpatch-0925 in a separate worktree. Main and paused agents’ dirty work are preserved. This is a hotpatch candidate, not a release tag.

## Included source

Base eaa2d9a12 (checker evidence): revised-approval chronology, familiar direct tools and preserved normal tool surface.

| Combined commit | Original commit | Change |
| --- | --- | --- |
| 820f2a6a3 | 6e75990fb | Approval amendment and answer forwarding |
| b64cab102 | 8df09bccf | Learned tool freshness on unreadable or changed observations |
| 27c89367d | 6e78f2ebd | User-selected fallback judge, desktop/mobile and runtime |
| 6103999db | 8b5c4c68e | Exact requested worker model resolution |
| ed3477d53 | 72e7bf698 | Model receipts and keep-model offer |
| f2d854f6a | ed1c0c324 | Mixed-kind retained-record ranking and removal of forced decimal rounding |
| a701760ee | 74124b043 | Standalone Space source failure backoff |
| b261ac590 | a129c24c1 | Recover stale ownership without cancelling unfinished work after a later message |

## Verification before build

Combined isolated focused batch: 1,132 passed, zero failed/cancelled/skipped, 42 selected files, 188.8 seconds. Includes changed tests, judge boundary/quota/pin/substitution, restart, queue, Space runner/scheduler, notifications and host-turn behavior. The runner did not perform its live-home inactivity sentinel because the installed daemon was active; no isolation proof is claimed from that sentinel. The tests themselves use the isolated runner.

The full suite and release journeys have not been rerun; this candidate is not tag-qualified. Final typecheck/build/install results and controlled live acceptance are recorded outside the fingerprinted source tree in output/combined-hotpatch-2026-09-26.

## Explicitly excluded paused work

Uncommitted wk-landed-writes: earlier-attempt evidence handles are not fully registered; repeat-write prevention and successful-terminal mapping still need review and pins.

Dirty wk-quiet-failures workflow-notification bundle: latest dedicated test still emits two notifications where one is expected (3 pass / 1 fail). Its independently committed Space backoff is included.

Unhanded-off people-hints work is excluded. None of these worktrees was reset, stashed or modified. See output/combined-hotpatch-2026-09-26/paused-workflow-review.md.

## Install and live acceptance owed at commit time

Build this exact committed source and both web apps. Use the recorded Terminal .command recipe, hold a pending updater before quitting, retain bundle backups, launch ~/Applications/Clementine.app by path, and compare served gitSha/fingerprint with the built stamp. Do not re-sign native executables.

Preserve current DeepSeek brain and saved model choices. Controlled generative acceptance must avoid Claude/Codex quota; use an approved economical provider and restore any temporary review-model choice. Check fallback persistence, exact model/tool receipts, a named safe manual workflow, continuation and no replay of completed writes. No personal workflow migration or real outbound messages. Record missing acceptance explicitly; do not conflate passing unit tests with installed-app proof.

The original installed app before this takeover served 6a042ae79 with fingerprint 72238d65c42799a6184d019ba1160c5de374c5f46c07bb1574a7a6c04f92d82f, schema 82.
