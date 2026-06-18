# Codex Improvement Ledger — 2026-06-18

## Status: Suite PASS 2851/0 (1 skip) · Gates PASS 8/8 · Typecheck clean (backend + desktop)

## Improvements

| # | Type (test/consolidate/observe/perf/types) | Area | What & why it raises the floor | Files | Commit |
|---|---|---|---|---|---|
| 1 | test | Memory recall | Added DB-backed characterization tests for real FTS recall, path-prefix scoping, telemetry, and hybrid objective reranking. This pins the recall path beyond query-string escaping so future memory/ranking changes cannot silently leak stale vault areas or lose objective scope. Red check proved the objective-rerank test fails if scope reranking is removed from the FTS fallback. | `src/memory/recall.test.ts` | `test(memory): pin recall FTS characterization` |

## Next up

1. Add a scheduler/background-task characterization around queued-vs-running stale detection and report-back visibility.
2. Add lock-in coverage for goal-fidelity and destination gate benchmark traps around soft-return guardrail events.
3. Tighten model-role routing tests for workflow step intent fallback when a selected role binding becomes stale.
