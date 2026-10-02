# Checkpoint 2026-10-02 — wave 15: harness fixes + premium UX pass one

**Installed:** `2a34785ec` (claude/premium-ux), then the release commit on top of `e0ce7a94d` (Goals) as wave 16, by the guarded runtime hotpatch
`output/wave-1001/apply-wave-15.command` in the calendar-discovery worktree, at
05:01 UTC 10-02, onto the signed 3.18.24 bundle; predecessor `71a3bc427`
(wave 14). Built from the clean detached worktree `~/clem-worktrees/premium-ux-suite`.
The running daemon serves `2a34785ec` from the bundle; the served console
(`assets/index-Bg5nEb-B.js`) and phone (`main-BuzdomnF.js`) assets equal the
build. Native shell rollback copies are in that recipe's `rollback-*` folder
for the 05:01 UTC run.

**What the wave carries:** the 10-01 harness fixes through `914324109` (lock
freeze, account re-check, resumed-run watchdog, non-zero local commands,
first-try carried writes, self-named requirement ids, input defaults, usage
attribution) and the premium UX brief's first slice
(`output/premium-ux-handoff-2026-10-01/`): Needs you on desktop and phone, Today
(From Clem, the Needs you column, Space tile menus) and the sidebar. The shared
decision presenter is `packages/chat-engine/src/decision-presentation.ts`;
`packages/**/*.test.ts` joined the default suite.

**Evidence:** suite on `2a34785ec` 19,468/19,478 (one 1 s scheduler latency
budget missed at load ~40, passes alone 3/3); live A/B B8 12/12 done, 12/12
assertions, 0 repairs, fixtures exact, usage certified; B8x reruns of the two
median flags clean. UI before/after was captured read-only on live data (the
phone capture pairs one headless device and revokes exactly that device).

**Open:** chat working room; phone From Clem; Needs you search/filter; a "Run
failed" workflow notice can carry no workflow reference (no link possible);
physical iPhone and dark theme unchecked; targeted acceptance of workflow
author/enable, connection/approval correction and desktop↔phone continuation
not yet run live.

**Later the same night (waves 16–18):** wave 16 installed the first release
commit (Goals page); wave 17 df8f719b2 (Noticing closed-question fix,
superseded failures, chat labels); then the Claude refresh hardening, the
same-thread sync-lock fail-fast, the default-Node PATH fix and the tracing fix
were added and the release commit was moved back on top so the installed
revision is the tagged one. The live home was cleaned of test clutter on the
owner's approval (backup at ~/clementine-cleanup-backup-20261002). Clem's own
Claude grant has been dead since 00:06Z 10-02 and needs the owner to sign in.
