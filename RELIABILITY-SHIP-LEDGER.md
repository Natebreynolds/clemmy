# Reliability Ship Ledger — Clementine

Started 2026-06-18 · Branch `feat/background-tasks-board` · Base commit 8b4ca61

A self-paced reliability loop: each iteration audits the running harness worst-first,
fixes one verified class of bug in code, verifies (suite + gate bench + typecheck),
commits on this branch, and records here. STOPS only at SHIP-READY (all four ship
criteria green AND zero open HIGH). Never pushes a release tag — that's the human's call.

## Status: IN PROGRESS
Suite: **PASS 2826/0** · Gates: **PASS 8/8** · Typecheck: **clean** (backend + desktop) · Open HIGH: **0 known**

> Sweep is EARLY: only the safety-gate chain + the verification baseline have been
> probed so far. Status stays IN PROGRESS until memory, scheduling, the workflow
> engine, model routing, tool/MCP routing, background tasks, and the console/API
> have each been swept worst-first and found clean. "Open HIGH: 0" = none *found
> yet*, not "sweep complete."

## Findings
| # | Sev | Area | Gap (one line) | Status | Fix (commit / files) |
|---|-----|------|----------------|--------|----------------------|
| 1 | HIGH | Safety gates / CI | Gate regression bench scored 1/8 — its "prevented" verdict required a THROW, but since the gate-unification (a3832fb) recoverable gates soft-RETURN a corrective error (block the action without throwing). The gates were NOT bypassed (unit tests green); the **detector** was broken and would have masked a real future gate regression — and it's a ship criterion (`npm run bench:gates`). | ✅ Fixed | `scripts/harness-gate-benchmark.ts` — score prevention by the fired `guardrail_tripped` event (faithful for both throw + soft-return), not `threw`. Bench 1/8 → 8/8. |

## Order of attack (worst-first, next iterations)
1. **Memory & brain** — `src/memory/{recall,facts,maintenance,reflection}.ts`: recall pool fidelity (stored-embedding round-trip), decay/dedup correctness, consolidation/UPDATE paths. Data-loss class = HIGH if found.
2. **Scheduling & background** — `src/execution/{workflow-scheduler,background-tasks}.ts`: missed-fire / double-fire, stuck-in-queue watchdogs (the daemon log showed `Workflow runs stuck in queue` + `Background tasks went silent` repeatedly — characterize whether that's a real stall or benign).
3. **Workflow engine** — `src/execution/{controller,workflow-runner}.ts`: forEach crash-resume, partial-failure reporting honesty, the intent-routing seams just added (Seam B), step model override interplay.
4. Model/role routing (`model-roles.ts`), tool/MCP/CLI routing, console/API, then desktop↔Discord parity.

## Deferred (MED/LOW, with rationale)
_(none yet)_

## Notes / context
- A concurrent agent has uncommitted in-flight feature work in the tree (Seam A chat
  run_worker + authoring auto-tag: orchestrator/sub-agents/worker-job-packet/
  workflow-builder/orchestration-tools). This loop commits ONLY its own audit fixes;
  it does not commit or revert that in-flight work. The suite is green WITH it present.
- Severity guide: HIGH = wrong output / data loss / broken run / gate bypass / every-turn-or-user. MED = degraded/recoverable. LOW = cosmetic/rare.
