# Browser reads took the full write review (2026-10-14)

## Finding

The owner's rule (2026-10-08) is that a read gets Jev or the light review, and
the full other-model review runs only when something is written or created.
Browser reads broke that rule.

`cloud_browser_start`, `cloud_browser_open`, `cloud_browser_navigate`,
`browser_open` and `browser_navigate` are registry writes (`sideEffect:
'write'`). Their declared local semantics are `consequence: 'local_execution'`,
non-destructive, and `reversible` or `create_only`. Every call settles with
`mutating = 1`. `sourceWritesAtStake` exempted only restorable
`local_artifact` writes, so a turn that opened or moved a page got
`reviewStakes: 'write'`. That had three effects:

- Jev never ran (`reviewsWrite` skips the Jev-first path).
- The configured reviewer ran at full depth with the 180 s write deadline.
- A refused or failed navigate counted too, as an unlanded write.

## Live cost, installed builds, 10-12 → 10-14

Ten owner browser turns that wrote nothing took 20 completion-review calls,
266 s in total:

| Turn | Ask | Reviews | Review time | Brain time |
|---|---|---|---|---|
| 472806 | open facebook.com | 2 full | 23.2 s | 6.1 s |
| 472886 | open facebook.com | 2 full | 26.8 s | 7.0 s |
| 473491 | open facebook.com | 2 full | 29.5 s | 5.3 s |
| 473400 | open example.com (fixture) | 2 full | 36.0 s | 4.3 s |
| 478693 | open scorpion.co | 1 full | 9.1 s | 3.7 s |
| 479823 | open target.com | 1 full | 9.7 s | 4.5 s |
| 478762 | what do you see on the page | 4 calls | 55.6 s | 36.6 s |
| 479893 | find me a pokemon pillow | 4 calls (2 full reviews) | 46.3 s | 32.3 s |

Bound reviewer requests over the same window had a median of 22.3 s at full
depth and 15.2 s at fast depth. Since 10-12, Jev alone closed 13 read reviews
with no reviewer call.

## Change

Branch `claude/browser-review-depth-bdaa`, based on the installed
`bdaa37ef8`. The same change on `62f3a7143` is `212300973`.

- `restorableLocalExecution`: a non-destructive `local_execution` declared
  `reversible` or `create_only`. Today that set is exactly the five browser
  tools. `run_shell_command` is `ordinary_non_destructive`, and
  `cli_setup`, workflow definitions and Space definitions are other
  consequences, so none of them qualify.
- `sourceWritesAtStake` leaves such a write out whatever its outcome, except
  `uncertain_write`.
- `sourceAttemptedWrites` is unchanged. It still sets the review deadline and
  gates the historical-read closure.

Offline replay of the old and new rules over the live ledger (read-only, all
turns since 10-12 that settled a mutating call): 15 of 68 move from write to
read. All 15 are browser-only. The other 47 keep the full review: workflow
create/edit/run, notes, Slack/AIBS deletes, shell and file writes.

Tests: `host-turn-runner`, `objective-judge`, `workflow-completion-stakes`
and `workflow-objective-judge`, 531/531, plus `tsc --noEmit`.

## Still open

- The light review still costs a median 15 s per call when Jev does not
  accept. In 39 reviews since 10-12, Jev ran on complete coverage but did not
  accept, so the reviewer ran anyway.
- `judge:turn_semantics_account_selection` took 13.9 s on a one-tap calendar
  Accept (1,259 input tokens, reasoning requested `none`). It guards an
  external write, so it stays, but its latency is the provider's.
