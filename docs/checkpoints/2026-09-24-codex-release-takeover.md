# Release takeover — 2026-09-24

Owner requested takeover through optimization and tag. Work remains on harness/3.19; main and its owner edits are untouched. No tag is justified yet.

## Recovery and verified checks

- Preserved both diffs, unmerged index entries and all affected file bytes under /private/tmp/clem-takeover-preservation-20260923-224145. Confirmed stash@{0} exists; restored only the three accidental stash-conflict paths to HEAD. Staged objective-judge work survived. No stash was dropped.
- Reviewed staged verdict repair. Fixed missing invalidDetail propagation/type; preserved the complete prior review instead of clipping at 6,000 characters, with context admission before repair. Added late-negative-finding regression.
- Removed a byte-identical duplicate verified-read block from Jev completion requests only when the full block already appears in evidence. Distinct evidence stays whole. This is payload deduplication, not review removal or a new completion authority.
- Focused judge + Jev checks: 84 pass, 0 fail. Typecheck passed after diagnostic propagation fix (before subsequent Jev-only change; rerun pending). These are disposable-home recording checks, not installed acceptance.
- Current host runner: 311 tests, 291 pass, 20 fail. Last-tag whole-file baseline: 297 tests, 255 pass, 42 fail. Counts are NOT per-failure attribution. Separate per-name candidate/tag runs are in progress under /private/tmp/clem-takeover-failure-attribution.

## Required continuation

1. Complete per-name attribution and repair failing fixture/runtime contracts without weakening assertions or production authority.
2. Measure reviewer spend; use exact evidence retention and attribution, not arbitrary truncation or skipping completion reviews.
3. Build and hotpatch through the Terminal recipe after committing; verify installed fingerprint and live exact-source reviews.
4. Installed-app continuity, resource freshness/reuse, native authoring/workflow/HITL and MCP/CLI/Composio acceptance remain owed.
5. Full idle-machine tests/journeys and package/upgrade/release gates on the final candidate, then merge/tag only that verified series.

No release, full-suite, latency improvement or live judge-repair success is claimed by these focused tests.

## Installed acceptance and reviewer cost

- Installed 0693a9ab8 via Terminal command, Developer ID signing and verification; fingerprint cf3ad523f0f77036e94aa6b1f4cbb4525b37e2f5db1af617b5021e3ca8e6b3dc. App UI archive digest unchanged. Rollback in /private/tmp/clem-takeover-patch and daemon dist.backup-NDHT08.
- Repeated the exact three fictional prospect draft-only request. Parent source 294694 in sess-desktop-7f1c79608e9ef856beedd471 completed in 92.6 s with a real positive completion verdict after a genuine draft inconsistency was corrected; no failed-open completion. This did not force a malformed verdict, so the repair branch itself remains recording-tested, not forced live.
- Parent-only measurements: 263,922 uncached tokens; 232,819 reviewer, 27,017 brain, 4,086 router. Three workers have separate accepted sources (294724, 294727, 294730); their totals are 25,108 / 26,484 / 22,811 uncached. Combined total 338,325. Do not label parent-only totals as the complete task cost. Existing measure-source-turn.mjs produced each measurement; receipts in /private/tmp/clem-takeover-live/baseline-parent-and-workers.json.
- Cross-worker evidence duplication pin failed before fix (same reference rendered 3 times). One per-render content dictionary now spans authenticated parent/worker lineage; every receipt and request scope stays visible and original worker evidence stays redeemable. Distinct results stay whole. A retained full page and bounded source view never share a presentation key. Completion contract suite: 47 pass, 1 existing opt-in private fixture skipped. Live benefit pending.

## Test debt attribution and first production migrations

All 15 previously failing top-level names were run individually on the candidate and v3.18.19; all reproduced. Logs and per-name results: /private/tmp/clem-takeover-failure-attribution/results.json. This establishes history, not release clearance.

Seven fixtures now pass together via the production host: fresh bare greeting, lifecycle pre-invoke limit, native MCP limit, terminal tool behavior, truncated-response retry, stale-text rejection, and canonical admitted argument projection. They use real accepted-source metadata and sealed envelopes; the MCP case materializes an adapter-shaped recording server through the production carrier. Original body-count, ordering, no-repeat, paired-receipt and terminal assertions remain. The greeting uses the explicit bare greeting case; ambiguous greeting-prefixed hosted requests retain the separate regression coverage. No runtime authority was loosened.

An attempted shared component-helper migration was discarded because supplying metadata alone did not satisfy actual execution authority and created a new fixture failure. The original unowned component helper is unchanged. Remaining fixtures require individual migration, not broader bypasses. Typecheck and diff check pass. Whole-file rerun and full release gates still owed.

## Second installed comparison and completed host repairs

- Installed e2da75df4 with fingerprint ffb6de90690057864ce40462426a7fb272ea58e1958a6fd51b01f65f64ab8708 through the signed Terminal recipe. UI archive unchanged; daemon rollback dist.backup-GIV5bd.
- Identical three-prospect input, source 294854 / sess-desktop-c8b485fc112f97747d26c285, completed with a real positive judge verdict. Wall 74.9 s versus 92.6 s. Parent uncached 122,513; reviewer 86,951; child sources 294922/294925/294928 add 34,209/30,228/30,852. Combined 217,802 versus 338,325 (35.6% lower). Parent brain frames increased 4→5; reviewer frames fell 4→3. This is one matched request, not a repeated benchmark or attribution of the entire improvement to deduplication. Receipts: /private/tmp/clem-takeover-live/dedup-parent-and-workers.json.
- Five further fixture migrations preserve original assertions through exact accepted-source production execution: mixed-read clarification; FunctionTool/control errors (fatal bodies assert entered exactly once through the recording provider); uncertain sibling drain; tool ceiling drain; max-turn terminal. Together with the first seven, these eliminate stale fixture authority assumptions without adding a runtime bypass.
- The remaining eight failures (three top-level settlement component tests) came from eager recall-preview identity resolution even for unchanged short strings. Preview identity is now resolved lazily only when retaining a large result. Production invocation admission, ledger settlement, and model provenance are unchanged. Large-result missing-identity refusal has a new pin; short-result passthrough does no recall-storage lookup. Original settlement tests and their assertions are unchanged.
- Whole host runner plus preview tests: 316 pass, zero failures/cancellations/skips; /private/tmp/clem-takeover-host-preview.log. Earlier failing attribution remains available. The attempted migration of manually injected settlements into a physical tool body was discarded: production correctly refuses a fabricated pre-dispatch settlement while its physical call is in flight.
- Always use run-tests-isolated.mjs, including focused tests: static imports can bind configuration before a test file sets its own home. An initial direct invocation produced authority-payload failures; subsequent accepted results use the outer isolated runner. Live-home sentinel cannot claim isolation while the installed daemon owns and writes its home; final full run should stop the idle daemon first.
- Still owed: final candidate build/install, repeated benchmark cohort, installed continuity/reuse/workflow acceptance, full suite/journeys/package/upgrade checks. No tag is cleared by this checkpoint.
