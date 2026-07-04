# Robust Self-Heal — Design & Build Plan (2026-07-04)

**Problem statement.** Today's workflow self-heal auto-fixes exactly ONE thing: a single step's prompt (`edit_step` + `autoApplicable` + `newStepPrompt`, `workflow-runner.ts:tryAutoHealAndRequeue`). Everything else — a broken tool binding, a wrong/too-strict output contract, a bad input, a multi-step interaction — is only *diagnosed and offered* for human `apply fix`. And a workflow that returns **plausible-but-wrong data that satisfies its contract** never triggers the loop at all; it passes as success. Prompt-rewrite-only self-heal is cosmetic. If "auto-heal and auto-improve" is the north star, the healer must repair the failures workflows actually hit.

This plan makes self-heal robust **without** raising the blast radius, and sequences it so it ships as its own verified effort — NOT bolted onto the current release.

---

## The safety insight that makes this buildable

The reason self-heal is prompt-only today is over-caution, not a real safety requirement. The blast-radius controls all sit on the **re-run**, and they are **fix-kind-agnostic**:

- no goal re-pursuit / re-run past a completed irreversible step (`runUnsafeToRepursue`, `hasCompletedUpstreamMutation`)
- no auto-heal when the workflow has an ungated irreversible send (`hasUngatedIrreversibleAction`)
- retry suppressed after a send already fired (`stepSendAlreadyFired`)
- cross-family judge veto on the applied fix (T3.2, `judgeHealCrossFamily`)
- backup + auto-revert if the healed re-run doesn't stick (T3.2, `selfHealBackupId`)
- bounded attempts (`selfHealAutoMaxAttempts`, default 2) + chronic-failure circuit breaker (`shouldStopAutoHeal`)
- every edit re-validated by `checkWorkflowForWrite` before write

None of that cares what *kind* of edit produced the re-run. So we can widen the **fixer** as long as each fix is (a) re-validated, (b) backed up + auto-reverted, and (c) subject to the same re-run side-effect gate. **The restriction to prompt-rewrites guards the edit; the real danger is the re-run, which is already guarded.**

---

## Robust self-heal is TWO problems

### Problem A — the FIXER is too narrow (widen the fix kinds)

Extend `applyProposedFix` / `WorkflowDiagnosis.fix.kind` beyond `edit_step` to the kinds that map to real failures. Each carries the concrete structured edit (not just a description), and auto-apply is gated by the affected step's **side-effect class**:

| Fix kind | What it changes | Auto-apply gate | Safety notes |
|---|---|---|---|
| `edit_contract` | the step's `output` contract | read/write step, always | **safest of all** — validation change, not behavior; no re-execution risk. Loosen a too-strict contract causing false failures; tighten a too-loose one passing garbage. |
| `edit_binding` | tool slug / params on the step | read-class step, or write with `loopSafe` | send-class → escalate (never auto-rebind a send) |
| `edit_input` | an input binding or a declared default | read-class step | a wrong input on a read is safe to correct + re-run |
| `edit_step` (today) | the step prompt | unchanged | keep as-is |

Rule: **any fix kind auto-applies IF the affected step is read-class (or a `loopSafe` write) AND the fix does not touch a send.** Send-class fixes stay human-gated exactly as today. The cross-family judge (T3.2) must veto **all** auto-applied kinds, not just prompts.

### Problem B — the DETECTOR is too narrow (catch what currently passes)

You cannot heal what you do not detect. The nastiest class — plausible-but-wrong output that satisfies its contract — passes as success, so the loop never engages. Add a **grounding judge on the final deliverable**: does the output's claims match the tool results actually captured during the run? On mismatch → fire `needsAttention` (→ the heal loop). The machinery half-exists (`ungrounded_output` advisory, `judgeWorkflowTarget`) — today it advises instead of triggering heal. Different model family, fail-open.

**HARSH caveat:** this is the exact class that can turn a GOOD run into a FALSE failure if it's trigger-happy — the same regression risk we just fixed in T3.1 by requiring invariance across runs. So Problem B ships **last**, behind a flag, off by default until proven on real workflows. Do not rush it.

---

## The two robustness multipliers

1. **Probe-the-fix before re-running the whole workflow.** Today a heal re-runs the *entire* workflow to discover whether the fix worked — expensive and slow to converge. Instead: after applying a fix to a read step, run **that single step once** against the same inputs; if it now returns contract-valid data, commit to the full re-run; if not, revert immediately and escalate. Reuses the creation-smoke-test executor (`queueWorkflowCreationTest` machinery — it already runs one read step in isolation). Biggest cost + robustness win; de-risks every widened fix kind, so build it early.

2. **Remember fixes that stick.** When a heal succeeds and the re-run passes, record `{workflowSlug, stepId, failureSignature, fixKind, fix}` as a pattern. Next occurrence of that signature → apply the known fix instantly (or surface it at authoring so the class is avoided). Reuses the `workflow-pattern-store` + the T3.3 doctor→proposer channel. THIS is the ever-learning payoff: the workflow stops failing the same way, it doesn't just recover each time.

---

## Model routing (honesty about the diagnosis quality)

Diagnosis currently runs on `MODELS.fast` (`workflow-diagnosis.ts:402`). Classifying a block is fine on fast; **writing a correct structured contract / tool binding is not.** Keep fast for detection/classification, but **generate the actual structured fix on a stronger model**, then judge it cross-family (T3.2) before applying. This is a small change to `diagnoseWorkflowBlock` — split "classify" from "author the fix."

---

## Build order (by value AND safety — do NOT reorder)

1. **`edit_contract` auto-apply** — safest, immediate value (kills both false-failure and garbage-pass in one move). Extends the T3.1 contract machinery + `applyProposedFix`.
2. **Probe-before-re-run** — the multiplier; de-risks everything after it, so it comes before the riskier fix kinds.
3. **`edit_binding` + `edit_input` auto-apply**, side-effect-gated + probe-verified.
4. **Multi-step chain diagnosis** — today `diagnoseWorkflowBlock` only looks at the *first* blocked step and misattributes when the real cause is upstream. Wire `detectEmptyDeliverableReads` into diagnosis so the fix targets the upstream producer. Harder; after 1–3.
5. **Fix-memory (remember what stuck)** — the learning loop; needs 1–4 producing real applied-fix outcomes to learn from.
6. **Grounding detector (Problem B)** — highest value for the subtly-wrong case, most tuning-sensitive; ships last, flag-gated, off by default.

Each phase: unit tests + a live smoke on a real broken workflow before the next. Every widened fix keeps the full T3.2 discipline (cross-family veto, backup, auto-revert, bounded, breaker, re-validate).

---

## What this explicitly does NOT change

- The runner / execution engine (the A− durable substrate stays untouched — self-heal only edits definitions + re-queues through existing paths).
- Send-class safety: no send fix is ever auto-applied; the ungated-irreversible + completed-mutation guards are unchanged.
- The graph branch/condition control flow (separate track; not part of self-heal).

---

## Honest ceiling

"Perfect / never breaks" is impossible — APIs and data shapes change out from under you. The achievable target is: **deterministic where it can be, model where it must be, self-healing across the failure classes that matter (contract, binding, input, upstream, grounding), and honest escalation for the irreversible ones.** That's a genuinely robust healer, not a slogan.

## Status of the prerequisite (shipped 2026-07-03/04)

Robust self-heal builds directly on what's already in the tree and green (4465/0): T3.2 (cross-family veto + backup + auto-revert + `selfHealBackupId` threading), T3.3 (doctor→proposer learning channel), T3.1-conservative (contract-evidence store — the same evidence discipline `edit_contract` will reuse). The foundation is in place; this plan is the widening.
