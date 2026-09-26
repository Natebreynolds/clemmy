# User-selected fallback judge — 2026-09-25

Owner request: “The user should be able to pick a fallback judge.”

## Behavior

Desktop Settings → Models and mobile Settings now expose **Fallback judge** beside the primary judge: Automatic, No fallback, or an exact connected model. They persist the same setting. The primary judge and worker/writer bindings are unchanged by saving it. An unavailable saved choice remains visible with an explanation.

The connected fallback catalog is independent of the brain's all-in API routing mode. A connected subscription model can therefore be chosen as fallback for an API brain. Ambiguous provider ownership is refused rather than guessed. Model IDs come from the existing connected catalog; this feature introduces no model-name policy.

The accepted request captures the fallback policy and resolved model/provider identity. API routes also capture the provider ID and endpoint, without credentials. API credentials may refresh; another configured API provider or endpoint may not silently replace the captured route. Native subscription routes retain the existing single-login-per-provider behavior: this feature pins the provider and model, not an OAuth account subject across sign-out/sign-in. Later Settings changes apply to new requests.

An explicitly selected fallback is sequential, never hedged. Completion review invokes it once when the primary is unavailable, quota-limited, encounters a qualifying provider/transport/authentication failure, or times out. A valid negative verdict, invalid-verdict repair exhaustion, context admission failure, and a user cancellation do not trigger another judge. Each attempt retains its existing deadline, so the failure path can take two deadlines. A timed-out primary is signaled to abort before fallback begins; a provider may still process an already submitted request.

The legacy Automatic behavior remains. No fallback removes alternate routes. A missing new setting inherits the existing `CLEMMY_JUDGE_CHAIN` policy; saving an explicit choice overrides that legacy policy without rewriting it. Invalid stored policy resolves to off, not automatic spending.

The other one-shot boundary checks retain their existing retry contract. Selecting a fallback must not promote it over a healthy primary merely because it is owner-selected or belongs to another model family.

A saved native fallback remains provisionally available while the provider catalog is refreshing after restart, with a visible provisional label. A completed catalog omission, disconnected login, or ambiguous provider identity remains unavailable.

## Implementation and integration

Branch: `codex/user-fallback-judge`, based on integration commit `6a042ae79a5d9e9593318b4197f13fe72408bce3`.

The change spans the shared policy/catalog, captured judge routing, desktop/mobile authenticated settings endpoints, and existing model settings controls. It does not change a live model selection, credentials, workflows, Jev decisions, review evidence, or the installed app.

API body: `{ "mode": "automatic" }`, `{ "mode": "off" }`, or `{ "mode": "model", "modelId": "<connected-id>" }`.

- Desktop PATCH: `/api/console/settings/models/judge-fallback`.
- Mobile PATCH: `/m/api/settings/models/judge-fallback`.
- Both return `{ judgeFallback }`; the snapshot includes connected options and saved-choice availability.
- Durable setting: `CLEMMY_JUDGE_FALLBACK`. Runtime caches are invalidated through the same mechanisms as other model settings.

## Validation and remaining acceptance

Focused tests use disposable homes and mocked model wires; they do not spend subscription/API quota. Tests cover authenticated save/reload, primary preservation, exact connected routing, unavailable choices, source capture, fallback failure, cancellation, timeout ordering, valid negative verdicts, and legacy policy.

Final verification: **195 focused tests passed**: 70 selected-fallback/terminal/openness cases; 86 legacy quota, exact-pin, boundary, attribution, settings, and rescue cases; 22 catalog cases; 15 UI helper cases; and two authenticated HTTP cases. Backend, console, and mobile typechecks passed. The cold-catalog regression failed before its fix (21/22) and passed after (22/22). One newly added runtime fixture initially declared its API model under two providers; correcting that fixture preserved the ambiguity guard, and the final runtime runs passed. Final command receipts accompany the integration handoff in `output/northstar-review-2026-09-25/user-fallback-judge/` in the main checkout.

The live-home sentinel cannot certify an unchanged home while the live daemon owns it. Its “NOT PERFORMED” result is not installed-app acceptance. No full suite, production build, browser visual acceptance, paid generative run, or hotpatch is claimed here.

The integration agent must include the feature in one reviewed combined revision, finish that candidate's required checks, rebuild after the final commit, and use the coordinated Terminal/signing hotpatch procedure during the agreed window. Do not install this isolated feature branch over newer integration work.

After installation, verify served build identity; save and reload the choice from desktop and mobile; restart and recheck the saved choice; run one controlled healthy-primary review and one controlled primary-failure review. Confirm the second uses precisely the selected model and provider route, its receipt names that reviewer, a healthy primary makes no fallback call, cancellation makes no fallback call, and no third judge is dispatched. For API routing verify the captured provider identity; for native subscriptions verify the current connected login. Restore the owner's intended setting after the controlled fixture. Record wall time and total reviewer calls/tokens. No real outage or exhausted allowance is needed: use a controlled fixture at the shared provider boundary.
