# Native lifecycle acceptance and artifact dependency proof

## Verified live on installed 74e8fe9eb

Both Opus5.5 and GPT6Sol completed controlled author→readback→enable→run once→
verify323→disable→saved-state verification, across background continuation.
Opus source287946 terminal288131 done, fixtureharness-plan-author-0923-74e,
run1790162685962-12ad8b. Sol source288132 terminal288364 done, fixture
harness-plan-author-0923-74e-sol, run1790162890619-81d2f8. Both original attempts
completed; independently verified exactly one successful run and disabled final
saved state. No operator cleanup. Active brain restored to Opus5.5.

Coverage matters: Opus's plan used ordering only (empty dataFrom, destinationnull),
so its pass does not prove the native identity-derivation branch. Sol retained
create_new destination and repaired explicit create→enable/disable dataFrom;
that live trace exercises the newly fixed terminal identity proof. Preparation,
receipt redemption and atomic publication share the cycle-free native proof core.
Never import runtime stores into terminal-publication-proof. Never count physical
run_completed (handoff) as canonical conversation_completed. Never trust prose
completion over stored status, or remove derivation obligations to get green.

Local evidence: output/harness-acceptance/2026-09-23-74e8fe9eb{,-sol}/README.md,
accepted.json, events.json, measurement.json, readback.json, runs.json. Raw traces
stay ignored/local; do not publish them wholesale. Commit/source and installed
fingerprints are in accepted.json. Main remains e77215d00; owner edits untouched.

Opus:87.543s,12top-levelcalls,3searches,213074uncachedinput. Exact attribution;
2uncertifiedusagecalls. Sol:152.693s,16calls,6searches,413258uncachedinput,
3uncertifiedusagecalls and2unscoped-window records; not fully certified accounting.
No general speed/cost claim from one loaded-machine sample. Opus context estimate
17836→31589tokens, initialschemas9783tokens. JIT/learned discovery and retained
prompt growth remain work; three searches do not establish proactive tool reuse.

## Fixing the previously attributed declared-effect regression

Existing test `a second DECLARED effect is its own requirement — the send never
dies as already-executed` failed at74e's parent and lasttag8c11 with bound instead
of work_dependency_pending (/tmp/clem-lifecycle-{head,tag}-attribution.log).
The generic external-success fallback treated a declared artifact creator with
missing verification contract as an ordinary completed invocation. Absence of
that contract does not prove that no artifact proof was owed.

Candidate narrows only that fallback: frozen selected metadata, or current
manifest metadata for legacy unsealed calls, identifies create_new destination,
explicit verification, or atomic content semantics. These require existing
artifact proof instead of nominal success. No provider/model names or new flags.
Non-artifact external jobs retain exact-success discharge with their original
reconciliation/result checks; do not restore the earlier paid-research deadlock.

Original pin plus unfamiliar declared creator and generic-job positive case pass
11/11 (/tmp/clem-artifact-discharge-final.log). Native lifecycle7 and workcontract19
checks passed in /tmp/clem-artifact-discharge2.log (36 including the earlier10
bypass tests). Adjacent atomic/receipt/write-evidence/verification35 checks pass
(/tmp/clem-artifact-proof-adjacent.log). Backend typecheck and diff check pass.
Isolation sentinel not performed while daemon owns live home. Full suite/journeys
remain unqualified on busy machine. These isolated pins are not live acceptance.

Next installed check must redeem the already-paid historical DataForSEO response,
not rerun the paid call or resume its cancelled workflow. Existing helper:
main/output/weekend-harness-2026-09-19/check-paid-result-progress.mjs. It checks
exact historical requirement discharge and wrong-source rejection with zero
model/business calls. The old authority remains closed/conflicted; do not reopen
or reset it. This narrow installed proof is not a fresh provider write canary.

## Remaining release work

No tag/push. Full release scope remains docs/NEXT-TAG-HANDOFF-2026-09-22.md section6,
including physical-mobile approval/restart/double tap, durable pilot/Space,
uncertain-write crash matrix, judge quota fallback, latency walls, trajectory
trust decision, cold unfamiliar provider, and bounded test-debt/full-suite gates.
Do not substitute these lifecycle fixtures for that broader evidence.
