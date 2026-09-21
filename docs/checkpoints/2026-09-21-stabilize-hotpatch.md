# Stabilize hotpatch — 2026-09-21

Installed overlay on `~/Applications/Clementine.app` v3.18.17, schema 81.
Source fingerprint: `395a0e7db2b1a39ba9d7b2756affbbd43fc56208b20fc11a5dbd5b516e11b2cb`.
Daemon pid at install: 11736. This is an overlay, not a version bump.

## Owners merged

Execution: preserve/stop looping source 274725; identical retained results meter `task_work` and escalate exact-args repeats; `skipDiscoverySearch` only while a disclosed ref is currently callable.
Completion: removed Jev INCOMPLETE→DONE override; a `retained_projection` completes only the source result it names.

Loop receipt: `output/weekend-harness-2026-09-19/loop-274725-preserved.json`.
Combined live receipt: `output/weekend-harness-2026-09-19/stabilize-combined-validation.json`.
Calendar retry: `output/weekend-harness-2026-09-19/stabilize-calendar-retry.json`.

## Live fixtures (this fingerprint)

| Fixture | Source | Outcome | Tokens (prompt / uncached / output) | Wall |
|---|---|---|---|---|
| Calendar first | 276365 | blocked `control_no_progress_exhausted` after 10× identical `workspace_roots` | n/a (blocked) | ~187s |
| Calendar retry | 276915 | done; 0 searches; first `OUTLOOK_GET_CALENDAR_VIEW`; Jev completion fast | 98444 / 48716 / 586 | 73s |
| Interrupt | 276476 | cancelled after first `tool_search`; terminal status cancelled | 26192 / 25552 / 185 | 19s |
| Resume | 276514 | branched to a new session; leftover cancelled | n/a | wandered |
| Two deliverables | 276796 | write succeeded, missing file absent; Jev incomplete then grok-4.3 done | 134148 / 68612 / 607 | 56s |
| Discovery | 276863 | `tool_search` then `OUTLOOK_GET_MAIL_FOLDER`; done | 105750 / 59862 / 386 | 59s |

Late reviews are included in those usage rows (grok-4.3 Settings judge and Jev completion). Isolated combined tests: 241 pass.
