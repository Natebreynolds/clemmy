# Correctness qualification — 2026-09-27

The owner explicitly said “Run correctness now.” Correctness runs are authorized under the current machine load; latency measurements still require an idle machine. No unrelated services were stopped. No live model calls, hotpatch, main merge, push or tag were performed in this wave.

## Full suite

Clean detached source e57b2e2dca32d25733e0b7a3e17f974de4c94752: 18,352 tests, 18,344 passed, 2 failed, 6 skipped, zero cancelled. Both failures reproduce in a separate two-file run (8 passed, 2 failed). This is not a full green qualification.

1. familiar-work-binds-directly: the learned Drive operation actually completed with zero discovery, but the test expected skill_read in the first schema block. The lean desk deliberately defers its schema. The corrected fixture now performs a real call_tool → skill_read dispatch on that same learned turn and checks the handler's exact missing-skill response, while preserving zero discovery, exact provider-call counts, and the ordinary reading/carrier surface. It does not promote schemas or change runtime policy to satisfy the old assertion.
2. objective-judge-instructions-cache: the test expected review effort to be dropped for Codex/BYO, contrary to the provider-neutral effort repair already in 9b2da1e62. The revised pin requires explicitly requested effort to reach every provider, with and without evidence tools, and requires omitted effort to remain omitted for each. Actual wire capability mapping remains adapter-owned.

These test files did not exist at v3.18.21. Transplanting their exact original bytes into the clean last-tag checkout produced 4 passes and 6 failures: both named tests fail there at earlier/different assertions because the newer behavior is absent. This does not establish that the candidate's particular assertion failures were inherited. Temporary files were removed and the checkout is clean.

The corrected files plus real deferred-tool reachability and model-wire registry coverage pass 57/57. Root typecheck passes. No runtime source was changed for these two corrections.

## Hundred-worker journey

The fixture now intercepts the current host model boundary rather than only the legacy Claude SDK worker seam; all child acceptance, dispatch, concurrency, settlement, reduction and retained-result readers remain production code. It asserts all 100 model calls use the configured worker model and zero legacy worker crossings occur.

Plan authority is checked through the accepted source and durable work contract, not disappearance of the plan schema. The source's bounded 64-row view discloses its full 100-item count; the real tool_output_query retrieves all 100 exact identifiers before fan-out. The complete ordered aggregate remains retained. The model gets a smaller bounded projection with handles; after database close/reopen, a real recall_tool_result call retrieves an exact 4,000-character omitted middle span. Packet ordering is checked on decoded JSON, avoiding vacuous comparisons against missing escaped-wire keys.

The journey passes independently and inside the canonical suite: 100 item completions, 100 worker model calls, one parent write and one readback, zero replay on reopen, 102 retained item/aggregate outputs, bounded concurrency, blocked adversarial worker write, ordered output, at least the existing 85% shared prefix, and unchanged digest thresholds. The test uses recording responses; this is neither provider-cache proof nor billed-token/latency evidence. A leftover diagnostic variable in the first fixture revision was corrected before the passing runs.

## Canonical journeys: release still held

197 tests: 169 passed, 28 failed, zero skipped/cancelled. The run used e57b2e2dc plus the above 100-worker test correction. Passing coverage includes the 10,001-partition workflow through pilot, recurrence, fresh-process restart/backpressure/retry/deduplication; five actual process-death cuts of result ingestion; generated Space and workflow create/edit/run after OS-process restart; long worker fan-out; and cross-surface continuation.

Remaining failures are in balanced ordinary-channel stops, the capability lifecycle corpus, the ordinary conversation corpus, local/external provider-neutral planning cases, and the restaurant-to-Sheet natural/byte-ledger fixtures (the natural test is imported twice). Several stop on assumptions about pre-disclosed capabilities or schema visibility; no blanket stale-test or inherited-failure waiver is justified. The named assertions must be reproduced, attributed and repaired without removing effects, approval, account, context or completion checks.

Full logs and named failure details are retained under output/release-3.18.22-2026-09-27/correctness-*. The live-home sentinel cannot certify unchanged files while the installed daemon owns ongoing writes. These disposable-home test results do not replace installed-app/live-home acceptance.

## Still owed

Resolve all named journey failures; rerun the required suite/journeys on the final clean release revision; rebuild after commits; verify the served installed identity after the coordinated hotpatch; run controlled workflow author/enable/execute, approval correction, long conversation, fan-out and no-replay acceptance; measure matched end-to-end latency and all-lane usage on an idle machine; complete release packaging/signing/version/main/tag checks. Installed runtime remains 9b2da1e62 and no new release is claimed.
