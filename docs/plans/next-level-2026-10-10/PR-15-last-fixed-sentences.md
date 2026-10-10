# PR-15 — The last fixed host sentences, and the stale pins behind them

Size S · risk low · depends on PR-00 (baseline) · the owner's 3.18.33 rule, finished · clears nine baseline failures

## Why

v3.18.33's rule: the harness never speaks for Clem; it hands her the facts. The
baseline suite still fails on exactly the places where a fixed host sentence
survives, plus three pins that went stale when wording changed on purpose. All
found by running the files one at a time on `b0612dd` (2026-10-10).

### Real defects

| File · case | What the test demands | What the code does |
|---|---|---|
| `respond-bridge-one-gate-wiring.test.ts` · "completed-work recovery candidate … a genuine no-work candidate stays blocked" | An ownerless stalled terminal (a workflow-owned session with no completed work) never tells the user to "ask me / continue / retry / resume" | `respond-bridge.ts:766-768` ends with "The run stopped before it produced a safe final answer, so this request is still unfinished. **Ask me to check what completed and what remains before continuing.**" |
| same file · "ownerless narration give-up closes factually without asking for a continuation" | Same, on the SDK-brain narration give-up path | `respond-bridge.ts:2717` same sentence; `:2204` names the brain ("The first brain stopped …") |
| `src/runtime/graph/turn-graph-semantics.test.ts` · "a participated failed admission stays graphless and commits a blocked zero-tool terminal" | A blocked zero-tool terminal carries no instruction to the owner | `src/runtime/harness/public-presentation.ts:298` ends with "…Ask me to check the capability details and any completed work for this exact request before continuing." |
| `claude-agent-brain.test.ts` · "SDK brain keeps a still-pending automatic memory capture non-done" (two wordings) | A reply that claims "Saved — your smoke marker is …" while the automatic memory capture has no host receipt yet ends `unverified` / `blocked`, never `success` | ends `success` with the claim intact |

The first two are the same defect the v3.18.32 notes record as a known limit
("the hard reconciliation block, when it is right, still speaks machine text").
An ownerless terminal has nobody to "ask me" to; the sentence is an instruction
to a person who is not in that conversation. The third is the "done is evidence,
not prose" law on the legacy SDK lane, which v3.18.30 says "runs only for
sessions persisted on it".

### Stale pins (wording changed on purpose; the pin was not moved)

| File · case | Pinned | Current, intended |
|---|---|---|
| `loop-structured-output-guard.test.ts` · "parse error with no recoverable text → safe fallback string" and "parse recovery does not reuse stale assistant text" | `/couldn't be structured/` (the sentence `turn-decision.ts` now keeps only as `LEGACY_STRUCTURED_OUTPUT_RECOVERY_FALLBACK` for historical rows) | `STRUCTURED_OUTPUT_RECOVERY_FALLBACK` = "Clementine couldn't prepare a usable reply. Ask me to check what completed and what remains before continuing." |
| `claude-agent-brain.test.ts` · the two "prepared workflow batch / handoff" cases; `discord-harness-terminal.test.ts` · "provider replied means dispatch ACK delivered…"; `discord-harness.test.ts` · "async dispatch releases only its exact placeholder…" | "Started — I'll post the result here when it's ready." | "Queued — waiting for the workflow to start. I'll post the result here when it's ready." (`public-presentation.ts:608`; the 10-07 checkpoint records this wording change and that one pin was updated, not these four) |

## Change

1. **Ownerless and blocked terminals state facts only.** In `respond-bridge.ts`, the two
   `commitBridgeBlockedTerminal` texts (`:766-768`, `:2717`), the brain-naming
   sentence at `:2204`, and the blocked zero-tool terminal in `src/runtime/harness/public-presentation.ts:298` become one shared factual close with no instruction, for
   example "The run stopped before it produced a safe final answer; this request
   is unfinished." When the session has an owner conversation and a model is
   reachable, hand the fact to one tool-less call on the turn's own model (the
   v3.18.33 path for "when the host has to stop a turn, Clem says why") and keep
   the factual sentence only when the model itself failed or the owner pressed
   Stop. `resumable:false` stays.
2. **Pending capture is not success.** On the SDK-brain lane, when the automatic
   memory capture has no host receipt at terminal time, the terminal is
   `unverified` with a `blocked` presentation and the reply does not carry the
   saved claim (the test's exact assertions). If the owner would rather retire
   the SDK lane than fix it, the lane's tests move to `.legacy` and the lane is
   documented as frozen; either way the baseline stops carrying the failure.
3. **Move the six stale pins** (two structured-output, four queued-workflow
   wording) to the intended sentences. Do not change the sentences.
4. **One place for the fixed sentences that remain.** `turn-decision.ts` already
   holds `MISSING_REPLY_USER_FALLBACK`, `STRUCTURED_OUTPUT_RECOVERY_FALLBACK` and
   `STALLED_WORK_USER_FALLBACK`; the respond-bridge sentences join them so a
   future wording change moves one constant and its pins together. Each constant
   gets a one-line comment saying when it is allowed (model failed, owner stop,
   ownerless terminal).

## Files

- `src/runtime/harness/respond-bridge.ts`, `turn-decision.ts`, `src/runtime/harness/public-presentation.ts`
- `src/runtime/harness/respond-bridge-one-gate-wiring.test.ts`,
  `loop-structured-output-guard.test.ts`, `claude-agent-brain.test.ts`,
  `src/channels/discord-harness-terminal.test.ts`, `src/channels/discord-harness.test.ts`
- the SDK-brain terminal path for pending capture (`claude-agent-brain.ts`
  around the `memory_signals_captured` → terminal verdict)

## Tests

- The nine baseline cases above go green; the two ownerless cases assert on the
  regex they already carry (`/ask me|continue|retry|resume/i`).
- New: a stalled terminal **with** an owner conversation and a reachable model
  yields Clem's words (fixture model returns a sentence) and the factual sentence
  only when the model call fails.
- Journeys that pin the old sentences (grep `safe final answer` under
  `src/journeys`) updated in the same commit.

## Done when

The nine cases leave `docs/checkpoints/2026-10-10-ci-baseline.md`; a workflow-owned
fixture session that stalls ends with a factual sentence and no instruction;
and no production path outside `turn-decision.ts` carries a fixed sentence that
addresses the owner.

## Do not

- Do not change the queued-workflow or structured-output sentences to satisfy a pin.
- Do not make the ownerless path call a model; there is no conversation to answer in.
- Do not widen into the reconciliation stop's Clem-voice rewrite (PR-13 item 8) unless it falls out of §1 for free.
