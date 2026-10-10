# PR-16 — Route outcomes on the host lane carry the verdict and tool success

Size S · risk additive (best-effort telemetry, never on the critical path) · depends on PR-00 · feeds PR-01, PR-03, PR-05

## Why

The route-metrics schema (`src/runtime/model-route-metrics.ts:48`) has room for
`objectiveMet` and `toolSuccess` on every outcome, and the policy's scorer
weights them at 0.25 and 0.15 (`DEFAULT_ROUTE_SCORE_WEIGHTS`, `:95`). Reading
the production call sites on `b0612dd` (2026-10-10):

| Recorder | Where | What it writes |
|---|---|---|
| `withModelRouteMetrics` (per request, host lane) | `router-model.ts:273` for the brain chain, `debate-model.ts:1031-1102` for the checker and judge | `status` (`success | fallback | failed`), latency, tokens, explicit cost. **No `objectiveMet`, no `toolSuccess`.** |
| `recordModelRouteDecision` + `recordModelRouteOutcome` (per turn, legacy SDK lane) | `claude-agent-sdk.ts:1497-1510` | status, latency, cost. **No `objectiveMet`, no `toolSuccess`.** |

`grep -rn "objectiveMet:" src --include=*.ts | grep -v test` finds no producer.
So the two signals the policy values most are null on every row, in every lane,
and `route-policy.ts:62-70` redistributes their weight onto plain request
success. "Success" there means the provider answered, not that the work was
right. The completion review that knows whether the work was right
(`goal_alignment_judged`, `host-turn-runner.ts:4791-4840`) and the settlement
ledger that knows whether tool calls landed are both on the host lane, a few
hundred lines away, unjoined.

Without this, PR-01's objective and tool-success columns are blank, PR-03's R2
("a faster helper, measured") can only compare failure rate and latency, and
PR-05 would let the policy drift toward the model that answers fastest rather
than the model whose answers pass review.

## Change

1. **A per-source outcome join, at terminal.** When the completion review
   settles for an accepted source (the point where PR-06 emits its receipt), look
   up the brain decision row(s) recorded for that source by `withModelRouteMetrics`
   (the decision carries `session_id` and the trace's source id; add the source id
   to the decision context if it is not there yet, `ModelRouteMetricsContext`) and
   update their outcome with:
   - `objectiveMet`: `verdict.done && !failedOpen` from `goal_alignment_judged`;
     `undefined` when the review was skipped or unavailable (never `false` for
     "not reviewed");
   - `toolSuccess`: true when every settled logical call of the source succeeded
     or was an honest empty result, false when any call failed after dispatch;
     `undefined` when the turn made no calls.
   Best-effort: wrapped like the observation writers ("telemetry never breaks a
   turn", `capability-resolution.ts:425`), off the response path, one SQLite
   statement.
2. **Helpers and the checker get their own signal.** For `worker` rows, use the
   worker's own result status (the `run_worker` envelope says whether the helper
   returned a usable result) as `toolSuccess`; for `judge` rows, `objectiveMet`
   stays undefined (a judge is not judged) and `status` remains the signal.
3. **The schema does not change.** Both columns exist; `recordModelRouteOutcome`
   already accepts them. Add `updateModelRouteOutcomeVerdict(decisionId, {...})`
   beside it, idempotent (last write wins, same values are a no-op).
4. **Trace it.** Append a `route_outcome_judged` row to the harness event log
   (not projected to the UI) with decision id, source id and the two booleans, so
   PR-01 can show "samples with a verdict" and the 10-02 measurement rules can
   audit it.

## Files

- `src/runtime/model-route-metrics.ts` (update helper), `src/runtime/harness/router-model.ts`
  (source id in the decision context)
- `src/runtime/harness/host-turn-runner.ts` (the terminal join, beside the
  `goal_alignment_judged` append)
- `src/runtime/harness/sub-agents.ts` or `worker-model-route.ts` (helper result status)
- tests beside each; `route-policy.test.ts` gains a case where objective evidence
  changes the pick

## Tests

- A fixture turn with a `done` verdict updates the brain decision's outcome to
  `objectiveMet: true`; a skipped review leaves it undefined; a failed-open review
  leaves it undefined; a `blocked` verdict writes false.
- A failed settled call writes `toolSuccess: false`; a turn with no calls leaves
  it undefined.
- The join never throws into the turn (fault injection on the SQLite write).
- Characterization: with the join disabled (`CLEMMY_ROUTE_OUTCOME_JOIN=off`, default
  on since it only writes telemetry) rows are byte-identical to today.
- The policy job scores a fixture table where two models tie on request success
  and differ on objective rate, and the policy prefers the one that passes review.

## Done when

On the installed app, after ten fixture turns, `state/model-route-metrics.db`
shows `objective_met` populated on brain rows for reviewed turns and
`tool_success` on rows whose turns made calls, PR-01's scorecard shows the
columns, and `measure:turns` shows no new model calls.

## Do not

- Do not treat "not reviewed" as `objectiveMet: false`.
- Do not put the join on the response path or let its failure surface to the owner.
- Do not change the scorer's weights in this PR.
