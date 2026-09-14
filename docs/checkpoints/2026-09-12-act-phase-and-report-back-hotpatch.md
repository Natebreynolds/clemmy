# Act phase completion, report-back, and trajectory review — 2026-09-12

This daemon-only candidate builds on `2be6fa44` and the existing uncommitted Plan/Execute refinements. No commit, tag, installed-app restart, UI patch, or owner model-setting change is part of this pass.

## Why these changes

The installed Sonnet run in `background:bg-mtypq4xt-b4e72c` completed the requested outline at source 197842. The background owner then interpreted future-artifact wording as a missing current deliverable and reopened it as source 197918. That second run researched and created a Google Doc without an intervening owner instruction. Its final notification also went through a synthetic model turn that failed accepted-source priming. These are harness ownership defects, not evidence that a smarter model or another approval gate was needed.

The five Opus calls in that run were four account reviews and one trajectory review. No completion review ran: the captured completion-review policy was disabled. The old trajectory mount supplied tool counts and an empty latest note; its unrecorded verdict cannot be described as approval or corrective steering. The research quality review found source-identity and unsupported-claim errors. See the preserved evidence under `output/reviewer-monitor/2026-09-12-plan-review/installed-background-phase-drift/`, particularly `QUALITY-REVIEW.md` and `opus-call-attribution.json`.

## Implemented

- Removed background artifact/send keyword inference and its automatic objective-reanchoring assignments, on both ordinary completion and approval-resume paths. Completion belongs to the accepted host source. Existing typed external-effect obligations, actual write receipts, manifest coverage, held recovery, and deliverable readback remain enforced. A declared required write without its receipt still fails verification.
- Report-back publishes the worker's existing result through the canonical delivery committer. It does not invoke another agent, restate the goal, or grant tools to a machine notification. Stable source identity makes a repeated delivery idempotent and keeps a newer human input separate. Distinct questions and a subsequent completion remain distinct reports. The public renderer preserves the full worker text and partial-work evidence. Durable goal resumption remains with the goal scheduler.
- The existing trajectory watcher receives authenticated retained read results, current artifact evidence, the effective objective, and the latest public assistant note from this activation. It does not receive private reasoning or substitute tool counts for source content. Full evidence is admitted against the selected judge's context capacity rather than silently clipped.
- Each watcher check records its start, on-track/drift/unavailable result, evidence identity, and actual route when available. Injection, delivery after a model response, and discarded stale guidance are separate facts. Owner guidance is checked again after adoption immediately before the model request. Optional watcher disablement and unavailable reviews leave execution running; no extra approval or Plan gate was added.

## Qualification and scope of proof

Repository checks at preparation: 215 background/report-back/goal/transcript/memory tests, 297 harness/Plan/Execute/recovery/hotpatch tests, 22 watcher/outbox/terminal edge tests, plus four targeted production-host watcher tests. Type checking and whitespace checks passed. The watcher cases assert actual successful settlements, intact evidence, actual model-request injection, no extra brain continuation, unavailable/off behavior, and an obsolete-objective verdict being discarded. The earlier no-fanout fixture alone was insufficient evidence for successful parent reads; the new production-host cases assert their settlements explicitly.

The first live candidate passed Sonnet chat and four-source Plan with skill and saved preference, then stopped before Execute because temporary-disk free space fell below the proof runner's reserve. That interruption is retained and is **not** a passing full qualification. Only reproducible downloaded model caches in three stopped, sanitized proof homes were removed; their databases, logs, artifacts and transcripts remain.

Final live evidence and the final build identity are written to:

`output/reviewer-monitor/2026-09-12-plan-review/act-refinement-live/`

Read `READY.md` there for the final verdict, exact completed checks, and any failures; the JSON reports retain per-case assertions and model attribution. This checkpoint is intentionally written before the final build because documentation is included in the source fingerprint. Do not infer live success from this document alone.

## Limits to retain

This is a hotpatch candidate, not a claim of perfect research or universal long-horizon reliability. The watcher remains asynchronous and cadence-based, with its existing review budgets and fan-out trigger. It can finish too late to steer the last step. It is not a mandatory pre-write review or a substitute for optional completion review. Its limits bound review spending, not the amount of owner work. Broader semantic transition scheduling, durable watcher accounting across recovery, and rendered desktop/mobile qualification are separate work. These tests do not repeat the connected Google Doc write or qualify the original external research report as correct.

## Applying

Quit Clementine after any live work has safely finished, then run:

```sh
(
set -e
cd $HOME/clementine-next
NODE=$HOME/.nvm/versions/node/v22.22.0/bin/node
"$NODE" --import tsx scripts/hotpatch-daemon.mjs --check
"$NODE" --import tsx scripts/hotpatch-daemon.mjs
open /Applications/Clementine.app
)
```

The script checks the current source fingerprint, stages and verifies the copy, and retains the previous daemon for rollback. Any later source or UI edits require a fresh build before the preflight will accept it. The daemon-only patch does not install the separate frontend streaming/Home changes.
