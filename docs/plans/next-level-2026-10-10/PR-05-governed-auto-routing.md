# PR-05 — Governed auto-routing for helpers: the route policy gets a door and a log

Size S · risk opt-in (default off, byte-identical) · depends on PR-01, PR-03

## Why

`src/runtime/harness/route-policy.ts` is a complete adaptive selector: an offline
daemon job groups outcomes by (role, intent, provider, model), scores them with
`DEFAULT_ROUTE_SCORE_WEIGHTS` (`model-route-metrics.ts:95`: success .45, objective
.25, tool success .15, latency .06, cost .05, tokens .02, fallback penalty .02),
and the hot path picks by Thompson sampling with guards: an unmeasured default is
never switched away from, a measured low scorer is never picked, the candidate's
provider must be connected now, a deny list, and a cost tolerance of 1.25× the
default. It is consulted after explicit bindings and before the static default,
and with the flag off resolution is byte-identical (characterization-tested).

It is off (`CLEMMY_ROUTE_POLICY` default `off`, `:107-108`), has no UI, is not a
developer flag, and its decisions are invisible. The owner's stated wish is a
harness that gets smarter with use; this is the one piece that already learns.

## Change

1. **Scope it to helpers first.** Add `CLEMMY_ROUTE_POLICY_ROLES` (default
   `worker`), read in `pickRoutePolicyModel`, so the policy is consulted only for
   the listed roles. Brain stays out. Judge may be added only with a family guard:
   when `judge` is listed, a candidate in the resolved brain's family is ineligible
   (reuse `chooseBoundaryJudgeFamily`; add the guard beside the live-validation
   guard). Writer, memory and quick remain outside the policy as today.
2. **One switch, both surfaces.** Settings → Models → Advanced: "Let Clem pick
   helper models" (off), with the sentence: "Clem will choose among the helper
   models you connected, from how they have done for you, and never pick a pricier
   one than your default or change your brain." Writes `CLEMMY_ROUTE_POLICY` and
   `CLEMMY_ROUTE_POLICY_ROLES` through a new `PATCH settings/models/route-policy`
   (and `/m/api/` twin), using the same env-write path `persistModelRoleSetting`
   uses, never `updateEnvKey` directly.
3. **A visible log.** Every policy pick already records a decision row with
   source `policy`. Project `route_policy_updated` (the job's event) and a new
   `route_policy_pick` (role, intent?, fromModel, toModel, reason enum:
   `score | explore | default`) through `public-presentation.ts`; the PR-01
   scorecard shows "picked by Clem" counts per model, and the PR-06 turn receipt
   shows "helpers: Kimi K3 (Clem's pick)" when a pick was made.
4. **The suggestion that turns it on.** PR-03's R7 fires when two worker
   candidates have ≥ 8 samples each; the yes applies the switch; `followUp` after
   50 helper calls compares worker p50 and objective rate and can raise "turn it
   back off?".
5. **Off means off.** The toggle off clears the flag; the policy table keeps
   accumulating (as today, "rows power the dashboard either way").

## Files

- `src/runtime/harness/route-policy.ts` (roles guard, judge family guard, pick event)
- `src/runtime/harness/model-role-settings.ts` (persist), `src/dashboard/console-routes.ts`,
  `src/channels/mobile-routes.ts`
- `src/runtime/harness/public-presentation.ts` (two events)
- `apps/console-web/src/screens/settings/ModelRolesCard.tsx` (Advanced), phone `RoleSheet.tsx`
- `src/runtime/harness/model-recommendations.ts` (R7 enabled)

## Tests

- Existing `route-policy` characterization (flag off ⇒ byte-identical) stays and is
  extended: roles guard excludes brain even when listed; judge candidate in the
  brain's family is ineligible; writer/memory/quick never consulted.
- Settings round trip on both routes; a malformed roles list is refused.
- Projection coverage for the two events.
- Scorecard "picked by Clem" counts from fixture decision rows.

## Done when

With the switch off nothing changes; with it on, on the installed app, a fixture
worker intent with two measured candidates shows picks in the scorecard and the
turn receipt, and turning it off restores the default resolution immediately.

## Do not

- Do not let the policy touch the brain, a saved agent's pin, or an explicit rule.
- Do not raise the cost tolerance or weaken the quality floor to make it pick more.
- Do not enable it by default, or from a suggestion without the owner's yes.
