# Memory at work — checkpoint 2026-09-27

Owner ask (2026-09-26): make the background memory model visible and changeable, and have the Memory tab show that work happening — what is working, which model does it, what it is doing and when — with enough visual life that the owner can see Clem refining their memory.

Branch `claude/memory-workers`, rebased on the shipping tip `c65a3e9c0` (claude/wf-builder-slice1). Not installed yet. The installer merges and installs; this branch does not install itself.

## What changed for the owner

- **Settings → Models, "Keeps your memory"** (desktop and phone). A new Settings-only model role. It governs the memory jobs that think: learning from finished conversations, settling conflicting facts, nightly patterns, skills from finished work, profile updates and imports. **Automatic** (the default) keeps today's model choice per job exactly; the row says whose model it borrows ("Uses the same model as Checks the work") and why it cannot serve when it cannot. Choosing a model makes every governed job use exactly that model; no stand-in.
- **Memory → "Memory at work"** (desktop panel on the Memory overview; phone card above the tabs with a full view). It shows:
  - a live line, which pulses only while a job runs in the daemon;
  - the model chip, with the model that last answered;
  - today's learning pipeline: read → noticed → kept or updated / left out → faded;
  - a 24-hour and a 30-day activity strip;
  - one card per background job: model, last run, next run, today's runs and tokens;
  - a timeline of what Clem did, with Forget / Bring back undo.
- Checks stay independent: the standing-instruction check and the memory-repair check stay on "Checks the work" and now say what they approved or stopped. The search index names the local embedder.

## Behaviour changes (each in its own commit)

- Memory model calls are now visible in the ledgers. Usage rows carry role `memory` (checks: `reviewer`) and channel `memory:<job>`. The route ledger records role `memory`, so memory calls stop feeding the judge's learned route policy. They were more than half of the judge samples.
- The route-metrics tables are rebuilt once at daemon boot so their role CHECK admits `writer` and `memory`. Before this, writer rows were silently dropped, and a memory or writer group would have rolled back the whole policy rebuild. Counts and row hashes are preserved. It takes about 3 s idle and 21 s on a heavily loaded machine, inside the readiness budget.
- **Learning waits instead of throwing work away.** While the memory model is paused, out of quota or not signed in, no part is claimed and nothing dead-letters. Before this, a pause dead-lettered parts after four claims. The Memory tab says why learning waits and until when. A timeout still spends a try.
- The nightly pattern run waits for a memory model instead of spending the day on a failure.
- `CLEMMY_REFLECTION` has one reader (runtime env), shared by the extractor and the nightly run.

## Records and retention

A job run is recorded in operational-telemetry.db (`memory_work_completed` / `memory_work_failed`): ids and counts only, never fact or conversation text. Daily counters live in `memory_work_daily`. Detail is kept 7 days and daily totals 90 days, then deleted on a persisted hourly clock. There are no harness.db or memory.db migrations; harness schema is 82, memory.db 36.

## Measured before the change (live, read-only, 72 h)

- Memory model work was about 850 calls and about 47% of priced cost.
- The post-conversation reflector ran about 210 times a day on the "Checks the work" pin.
- 1,199 claims produced 172 promotions. The lexical grounding check dropped 616, and 411 were parked for review. The set-aside backlog is about 1,290.

## Verification

- All three typechecks are clean.
- Every `src/memory` test passes: 1,283.
- Full suite at the pre-fix tip: no regressions. Every failing file fails identically on the base.
- A throwaway-daemon end-to-end run on both apps covered:
  - contract checks (101 snapshots, 0 violations);
  - undo from both routes and both UIs;
  - learning waiting with no sign-in (never claimed over 9 min);
  - nested runs folded into one row;
  - install-day strips;
  - 404/500 handling.
- The read model was run on a read-only copy of live data at about 1 ms per poll.

## Install notes

- Daemon hotpatch **and** both web dists (console-web, mobile-web). The daemon hotpatch does not carry them.
- The first boot rebuilds the route-metrics tables once (see above).
- console-web needs a node_modules that has `@xyflow/react`.

## Live acceptance owed (installed app, live home)

1. Settings → Models shows "Keeps your memory" as Automatic, with the checker's model and follows "checker".
2. After a normal conversation completes and Clem goes idle, Memory at work shows a learn run. That needs:
   - a route-metrics row with role `memory` and its served model;
   - a `model_call_completed` event on channel `memory:learn`.
3. A named fixture fact saved from Settings or chat shows as a reconcile row, only if the model was asked. Forget undoes it, and the fact is inactive.
4. The phone card matches the desktop.

## Owner decisions pending

- A cheaper default memory model. This needs a before/after quality measurement.
- Extractor refinements: an instruction cache point, larger shards, and the lexical grounding check that drops about half the claims.
- The set-aside backlog: drain it with the memory model, or expire it.
- Retention for reflection receipts, learning batches and the usage NDJSON files.
- Deadlines on memory model calls.
- A "Pause learning" control.
- One undo door for imports: soft forget or hard delete.
