# Live benchmark

One shared way to measure Clem in the installed app: five owner-style requests,
live model calls, each followed to its end. Claude Code and Codex both use it so
an optimization is judged on the same numbers (see
`output/harness-coordination-watch/optimization-plan-2026-10-18.json`).

## Run an arm

```sh
# 1. Announce the window in your *-active.json coordination note: a brain or
#    judge switch moves every chat.
# 2. Choose the arm's models (through the app's own settings routes):
python3 -I scripts/live-benchmark/switch_brain.py codex_oauth gpt-6.1-sol
python3 -I scripts/live-benchmark/set_role.py judge gpt-6.1-sol
# 3. Run it against the build that is serving:
zsh scripts/live-benchmark/run_arm.sh <served-sha-prefix> <arm-label> <books-page>
# 4. Restore the owner's settings exactly and diff-check them.
```

Scenarios: a file-synced Space, an estimate over local data, a research report
written to a file, a drafted reply saved to a file, and a workflow set up, run
once and left off. They need `~/clem-fixtures/out/books.csv` and the
`~/clem-fixtures` watch notes. Use a fresh arm label and books page per run;
the label names the files and the Space.

## What it writes

`output/harness-coordination-watch/benchmark/<date>-<arm>/`: one log per
scenario (every tool call, card, question and the final reply) and
`scorecard.json` with each scenario's outcome, wall time, completion reviews,
and prompt / cached / uncached / output tokens per leg (brain, reviewer, worker,
memory, router).

## Cleanup

The arm's Space ("Shelf <arm>") is archived and its workflow deleted after a
backup (`~/.clementine-next/backups/live-benchmark/<arm>/`), with their unread
updates marked read. Nothing the benchmark did not mint is touched.

## Rules

- Installed app and live calls only; the test harness never stands in.
- One arm at a time; a cold first run teaches Clem operations a later arm reuses,
  so compare like with like (warm up, or two runs per arm).
- Premium models only with the owner's go.
