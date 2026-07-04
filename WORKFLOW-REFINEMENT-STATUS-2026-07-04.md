# Workflow Refinement — Status vs. Goal (2026-07-04)

**Goal:** auto-healing and workflow learning 100% dialed in · authoring robust and clear · workflows execute predictably.

All work below is committed to `reliability/live-run-cluster-2026-06-30`, pushed (no tag). Full suite **4517/0**. Each item was typechecked, unit-tested, and (where deterministic) compiled-dist smoked. Nothing has been live-run against real tools yet — that's the one gate before a release tag.

---

## Pillar 1 — Auto-healing: robust (5 of 6 phases; 6th deferred with reason)

Self-heal went from **prompt-rewrite-only** (cosmetic) to a genuine repair loop:

| Capability | What it does | Commit |
|---|---|---|
| Diagnose the chain | Re-roots onto an upstream empty producer instead of blaming the symptom | RSH-4 `f03fb3bf` |
| Recall known-good fixes | A fix that stuck before is handed to the Doctor as a hint | RSH-5 `c3082b3d` |
| 4 structured fix kinds | prompt · output contract · input binding · tool surface | RSH-1/3 |
| Cross-family veto | A different model family must approve an auto-fix (no self-grading) | T3.2 |
| Pre-flight probe | A contract fix is checked against real output before any re-run (free) | RSH-2 |
| Auto-revert | A healed re-run that doesn't stick is rolled back | T3.2 |
| Fix-memory | A fix that sticks is remembered so the workflow stops failing the same way | RSH-5 |

**Phase 6 (grounding → auto-heal) — deliberately NOT built.** Grounding *detection* already exists and is comprehensive (`CLEMMY_OUTPUT_GROUNDING_GATE` on by default; the Claude-SDK pure-text lane is advisory-checked, other lanes are covered by the write-boundary numeric gate). The only gap is *feeding a grounding failure to auto-heal*, which is tuning-sensitive (a false positive triggers an unnecessary re-run) and must be calibrated against live grounding-failure data. Shipping it inert would be over-complication. **Gated on live tuning.**

## Pillar 2 — Workflow learning: complete

Four mechanisms now form a loop that sharpens *and forgets what stopped working*:
- **Fix-memory** (RSH-5) — remembers proven fixes.
- **Doctor → proposer** (T3.3) — recurring failures surface as nightly proposals.
- **Success-path contract tightening** (T3.1, conservative — only shape invariant across ≥3 clean runs, so it can't false-fail).
- **Pattern-store health/decay** (`4c2749f4`) — records failures too; a since-degraded workflow drops out of recall until it succeeds again.

## Pillar 3 — Authoring: robust and clear

- **Structured tool-call nodes** (CALL-1 `73ee6e28`) — `step.call = { tool, args }`. Known tool + known args are now **data**, not prose: validatable at author time, and the answer to "should tool calls live in the prompt?" (no).
- **Promotion captures structure** (CALL-2a `c7bfc700`) — a promoted run emits the real `{tool, args}` as a call node instead of downgrading to prose.
- Plus the earlier cluster: event/webhook triggers, cross-run watermark, loopUntil probe, forEach auto-repair, validation + auto-repair pipeline.

## Pillar 4 — Execute predictably

- **Zero-model structured calls** (CALL-1) — deterministic, free, un-phantomable.
- **Deterministic per-item fan-out** (CALL-2b `757566bc`) — `forEach` + `call` runs the tool directly per item, zero LLM per item. **Read-class only** (see below).
- On top of the all-lane **phantom-completion guard** (T1.1), the durable resume substrate, and the T1 correctness surgeries (synthesis protection T1.2, partial-batch resilience T1.3).

---

## What remains — and why each needs LIVE TESTING before it ships

These are the honest, deliberate deferrals. Each is a real capability, but each carries a risk that can only be retired with live validation — not more autonomous code:

1. **Send/write per-item call fan-out** ("for each lead → send email", zero-model). Blocked at validation today. A direct call records no `external_write` event, so the crash-resume / retry double-act guards can't see it → a per-item send could **double-fire to real people**. Needs per-call idempotency tracking + a live send test. *Highest-value remaining item; also the one that must not ship un-tested.*
2. **Grounding → auto-heal.** Needs live grounding-failure data to calibrate the false-positive rate before it's allowed to trigger re-runs.
3. **`system_event` internal triggers.** The webhook path is live; the internal-event path is machinery-only until a real producer emits (composio trigger listener) — verify live.
4. **Non-composio call tools** (CLI / local MCP) and **self-heal `edit_call`** — lower value until call-node workflows exist in the wild.

## Recommended next step

A **live smoke of the whole workflow system** against real tools — a real trigger firing a run, a `loopUntil` probe polling live state, a heal auto-reverting, the watermark skipping seen items, a read-class `forEach`+`call` fan-out — before cutting a release tag. The autonomous, unit-testable work is done; the remaining risk is exactly the kind that only a live run retires.
