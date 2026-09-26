# Learned operation-delivery freshness — 2026-09-25

## Verified

Worktree: `/Users/nathan.reynolds/.codex/worktrees/learned-tool-freshness/clementine-next`.
Branch: `codex/learned-tool-freshness`, based on integrator commit `00bc1d417`.
This is a separate framework correction for review and integration, not an installed candidate.

The existing learner retired an old verdict only after successfully preparing a new readable definition. Missing, blank or oversized metadata returned first. That left a previously learned “delivers nothing” verdict usable, even when the input schema was unchanged and the current description was unavailable. An older queued/in-flight reading could also write that verdict back. The scheduler stopped observing definitions altogether when either its six-new-learning budget or its 32-entry queue was full.

The correction:

- Observing an unreadable or no-longer-eligible definition retires its prior stored verdict and invalidates its queued/in-flight reading by exact provider/operation identity.
- All definitions supplied to the scheduler are observed, even after its model-work limit is reached. The existing scheduling and concurrency limits remain unchanged.
- Superseded work exits before screening, or before the judge if the definition changes during screening. A late judge cannot write a superseded verdict.
- Unrelated operations are preserved. Composio retains its case-insensitive operation identities; native MCP retains exact case and a separate namespace.
- Tool availability and execution routes are unchanged. Without a current learned exception, the existing structural consequence and consent behavior apply. This adds no model call or new tool gate.

Evidence is in the main worktree's ignored output directory:
`output/northstar-review-2026-09-25/learned-tool-freshness/`.

| Check | Result |
| --- | --- |
| New learner regressions against original runtime source | 11 failed, 7 passed; stale verdict/race/cap failures reproduced |
| Learner plus real host consent path after initial correction | 27 passed |
| Final learner, host consent integration, and risk-loader suites | 53 passed, 0 failed |
| Backend typecheck | Passed |
| Model requests | Mock Jev and judge only; no paid generative calls |
| Definition invalidated while queued | 0 screen calls, 0 judge calls |
| Definition invalidated while screening | 0 judge calls |

The final focused command was:

```sh
node scripts/run-tests-isolated.mjs \
  src/runtime/harness/learned-operation-delivery.test.ts \
  src/runtime/harness/host-interactive-consent-learned-delivery.integration.test.ts \
  src/runtime/harness/external-capability-risk-loader.test.ts
```

The actual consent integration first learns a readable definition and proves it proceeds without a send card. It then observes the same operation/schema with missing description and proves the next accepted source uses the existing send consent path. No new model work is required to retire the exception.

## Skipped

- No build, hotpatch, app restart, live model run, personal workflow changes, tag, main merge, or edits to another agent's checkout.
- No full suite or journeys while the other agents are running their own work.
- The isolated runner's live-home sentinel could not certify isolation while installed daemon PID 21905 owned the home. The final run reported concurrent `secretsMeta` change. The tests use disposable homes and mocked models; this is not a claim of installed-app acceptance or proof that live state was unchanged.
- No production latency benchmark. Saved model-call counts are deterministic fixture evidence, not an asserted live speedup.

## Still owed

1. Integrate with the current combined candidate, alongside `6e75990fb` (approval-amendment authority). At the last ownership check, that approval commit still was not in the integrator branch. Do not assume another agent has picked it up because a handoff exists.
2. One coordinated installed-app acceptance in the agreed quiet window, after a combined build and exact build-info fingerprint check. Use a named controlled fixture, never mutate a personal provider definition or workflow. Exercise unchanged-definition reuse, fresh missing-description invalidation, a changed-definition race, and the resulting next-source consent behavior; retain one accepted source, one terminal, exact settlements and matched timing/call/token evidence.
3. Recheck the discovery ingress gaps below before describing this as freshness across every tool route. The patch guarantees invalidation for definitions actually supplied to the learner; it does not discover changes by itself.

## Follow-up for the discovery/integration owner

Independent review confirmed these gaps in the base candidate. They remain outside this patch:

- `src/tools/tool-search-provider-sources.ts`: named and remembered exact-discovery branches around lines 2360–2465 can return before `scheduleOperationDeliveryLearning`; `materializeExactProviderBatch` does not observe delivery definitions itself. A freshly materialized exact operation can therefore bypass this learner.
- Fuzzy discovery passes only `merged.slice(0, 20)` around line 2551. Definitions outside that slice remain unobserved even though this patch observes every scheduler input.
- Both production learning call sites await `learnComposioOperationEffects` before scheduling delivery learning (around lines 1660 and 2542). Invalidation should occur synchronously on fresh metadata before another awaited classifier can leave an old verdict visible to concurrent work.
- `CurrentExternalCapabilityDefinitionV1` in `external-capability-risk-loader.ts` contains no description; `learnedDeliverySemantic` checks the input-schema digest, not the description digest. Do not claim that execution independently verifies description freshness.
- Only Composio discovery currently calls this scheduler in production. Native MCP identity behavior is tested, but this does not claim a new native MCP learning ingress.
- `forgetLearnedOperationDelivery` already catches store-write failures and returns false. If durable deletion fails, a stale row can still be read. This pre-existing persistence-failure case is not changed or certified by the patch.

Recommended next integration: separate synchronous observation from bounded background scheduling, observe every fresh provider definition at its common ingress (including exact materialization), and do so before awaited effect learning. Keep model-work bounds, retry policy and discovery fallbacks. Add an actual provider-ingress regression: learn an operation, return its fresh exact definition with unchanged schema and absent description, then prove the next accepted source uses the existing send behavior without new model calls. Coordinate that change with the agent owning familiar/direct tool binding.

## Continuity traps

- A queue budget limits new learning work; it must not silently authorize reuse of stale observations.
- An unreadable new definition is still evidence that the old learned verdict cannot be assumed current.
- Ignoring an old result only after the judge returns avoids stale storage but still wastes calls; check before each model stage as well.
- Durable removal, the next accepted source, and a previously accepted approval resume are different contracts. This patch does not retroactively rewrite an already accepted source or its exact approval binding.
- An independently prepared hotpatch from an older branch can overwrite newer combined framework changes. Use one combined candidate and the required Terminal/signing procedure.
