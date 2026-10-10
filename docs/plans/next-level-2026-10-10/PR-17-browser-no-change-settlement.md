# PR-17 — A browser open that proved nothing changed settles repairable, not uncertain

Size S · risk low (settlement classification of one host-reported proof) · depends on PR-00 · two baseline failures

## Why

`src/runtime/harness/browser-no-change-settlement.test.ts` (added 2026-10-03,
`08289da6`, "A set-up cloud browser is the browser; local Chrome is the
fallback") pins two things:

| Case | Expects | Gets on `b0612dd` and on v3.18.34 |
|---|---|---|
| "a browser open that proved nothing changed settles repairable, never uncertain" | `settlement.outcome.kind === 'invalid_arguments'`, `detail === 'host_reported:browser_not_dispatched'`, `directive.requiresReconciliation === false` | `kind: 'uncertain_write'` |
| "with a cloud browser set up, the real local `browser_open` refuses without starting and settles repairable" | same | same |

The third case in the file ("the same failure text without the tool's own
identity stays uncertain") still passes, which is the point: a bare failure text
is uncertain, but the tool's **own** proof that it never dispatched
(`browserOperationProvesNoMutation(result)` →
`nonWriteTextResult('browser_not_dispatched', …)`,
`src/tools/browser-harness-tools.ts:31`; the cloud twin at
`src/tools/cloud-browser-tools.ts:134,143`) is a trusted exact pre-effect
receipt and must settle as repairable.

The failure predates v3.18.34 (verified in a worktree), so it is one of CI's 22.
Its most likely origin is the 10-07 refinement batch's settlement rework
(v3.18.32: "a provider's failure envelope alone no longer proves a mutation did
not commit … only an adapter's exact pre-effect proof closes a write as
failed"): the stricter rule stopped recognising the host's own `host_reported:*`
proof as that exact pre-effect proof. The effect on the owner: a browser task
whose open never started ends on "its effect must be reconciled before
continuing" instead of letting the model repair and retry, the opposite of
v3.18.33's "a failed local command keeps going".

## Change

1. In `src/runtime/harness/attempt-settlement.ts` around `:1506-1530`, where a
   classified `invalid_arguments` with a `host_reported:` detail is handled, keep
   that classification for `host_reported:browser_not_dispatched` and
   `host_reported:cloud_browser_not_dispatched` (and any other
   `host_reported:*_not_dispatched` the tools emit) **before** the batch's
   "failure envelope is not proof" rule applies. The host's own pre-dispatch
   refusal is the adapter's exact pre-effect proof the batch rule names.
2. `directive.requiresReconciliation` stays `false` for that outcome, so
   `settlementRequiresReconciliation` (`host-turn-runner.ts:7447`) does not hard
   block the turn.
3. The bare-text case (no tool identity) stays `uncertain_write`; nothing else
   in the classifier changes.

## Files

- `src/runtime/harness/attempt-settlement.ts` (one branch)
- `src/runtime/harness/browser-no-change-settlement.test.ts` (unchanged; goes green)
- `src/runtime/harness/attempt-settlement.test.ts` (one new case: a
  `host_reported:*_not_dispatched` detail survives the envelope rule)

## Tests

- The two cases green, the third still green.
- `attempt-settlement.test.ts`, the settlement audit and the crash matrix
  (`autonomous-send-consent` family) unchanged.
- Characterization: every other `host_reported:` detail keeps today's outcome
  (snapshot the classifier over the fixture set in `attempt-settlement.test.ts`
  before the change).

## Done when

On the installed app, with a cloud browser set up, a fixture turn that calls the
local `browser_open` ends with the model repairing (cloud browser used, or the
honest "nothing happened" reply) and no reconciliation stop; the two cases leave
`docs/checkpoints/2026-10-10-ci-baseline.md`.

## Do not

- Do not treat any provider's failure text as proof; only the tool's own
  `host_reported:*` pre-dispatch receipt.
- Do not touch the external-write reconciliation rule (`uncertainEffectStopsTurn`).
