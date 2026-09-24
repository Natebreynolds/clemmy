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

## Release sweep: workflow completion chronology

The idle-machine full-suite diagnostic was stopped before completion after exposing multiple named failures and prolonged files. It is not a full-suite pass. Per-name candidate/last-tag attribution is retained in /private/tmp/clem-takeover-full-attribution/results.json; the baseline useChat case needs a retry after resolving its dependency import, and fresh-source-session-independence passed alone on both revisions. Historical failures are not release clearance.

A new workflow regression was reproduced in automation-pilot-production-convergence: dataset projection was timestamped before goal review, and that timestamp replaced whole-run finishedAt. Recurrence then correctly refused a goal verdict newer than the purported completion. Whole-run completion now retains its actual post-review time. A separate persisted projection timestamp is passed through both immediate and recurrence finalization, with exact receipt matching and a prohibition on projection timestamps after completion. Historical records retain the old fallback. Tests cover successful recurrence activation plus mismatched and future projection timestamps.

Three approval/resume runner fixtures now serialize the exact accepted-source identity and card key expected by the current host. Sequential resumed tool batches stay bound to the original accepted task; the synthetic approval control event remains the terminal control source. The harness execution is recorded in this file, so this verifies runner orchestration, not installed execution. Original behavioral assertions remain.

Combined workflow ceiling/resume, pilot convergence, and canonical finalizer checks: 24 pass, 0 fail (/private/tmp/clem-takeover-workflow-final.log). These changes are not yet installed. Typecheck and diff check passed. Full suite, installed workflow acceptance, final efficiency measurements, release packaging, main integration and tag remain owed.

Latest owner direction: retain completion judging before delivery, watcher behavior and full evidence access; do not move learning/delivery boundaries or turn on reviewer hedging as an unmeasured shortcut. First measure bridge preparation and verify reviewer caching. Existing memory preparation already overlaps compaction; MCP scope consumes learned candidate matches, so independence must be established at the actual production entrypoint before parallelizing. Windows packaging is requested; the release workflow has a Windows build and asset-verification job, but no Windows artifact has been built or validated for this candidate.

## Reviewer accounting and preparation instrumentation

Live source 294854's usage rows report zero cache reads on the large watcher/completion requests, but their promptComponents were copied from the ambient brain frame. The request-local model-route diagnostics instead show watcher stablePolicy 2,277 bytes/catalog 77 bytes and completion stablePolicy 8,256 bytes/catalog 2,146 bytes, with different policy digests. Thus the reported shared 12.6k-token reviewer prefix was not established. Both actual prefixes are below the adapter's currently configured 4,096-token Opus cache threshold. No provider minimum or expected speedup was inferred from those estimates, and no padding, model substitution or hedge change was made.

The shared model-route wrapper now scopes reviewer component estimates to the actual ModelRequest, including subsequent lookup/repair requests and streamed calls. The usage writer prefers this request-local observation over the adapter's ambient parent estimates. Actual billed token totals remain provider-reported. Worker role changes clear inherited reviewer estimates. The regression captures real usage rows through the shared wrapper, fails without the override, and proves ordinary/streamed calls use their respective inputs rather than inherited brain catalog/memory. Focused accounting plus bridge checks: 131 pass, 0 fail; typecheck and diff check passed. Logs: /private/tmp/clem-preparation-accounting.log, /private/tmp/clem-preparation-accounting-types.log, and /private/tmp/clem-reviewer-accounting-red.log.

The respond bridge now emits one content-free turn_phase_timings observation before harness dispatch, with request-local monotonic offsets for accepted source, checked clarification, continuity, material-source resolution, graph observation, and dispatch entry. It does not add an await or change stage ordering, does not measure model runtime configuration before respondViaHarness, and is outside execution authority. No installed timing improvement is claimed; next hotpatch must collect the actual offsets.

The last-tag useChat attribution retry now reproduces the same stale wording assertion as candidate; log /private/tmp/clem-takeover-full-attribution/00-tag-retry.log. This resolves the earlier dependency-related attribution gap, not the failing test itself. Release work remains open.

## Release contract cleanup and installed candidate

The 2c1a4ad13 build passed and the Terminal hotpatch completed Developer ID signing and strict signature verification. Installed daemon fingerprint: 654549ace9b66fbf0fb77c41ee4b5075b714fd867c1d85ff9b5375dca14c9ff5. Rollback dist.backup-QkW5lk and built-in skills backup-Dx7KDB remain in the app; patch/signature log /private/tmp/clem-release-refinements-patch/apply.log. The app UI archive digest stayed 44cf6d91df5d32c50c712d188178d4572e43fb6e01d28740e30823874942ce8e. Served-build verification and live run are still pending startup.

Four attributed full-suite failures are repaired without loosening runtime checks: empty completion still must be failed and never fabricated success, with the current public wording asserted; the Home mock must remain only the explicit preview route, now matching its existing deferred wrapper; BYO wire must preserve stable-first instructions and remove markers (the old legacy-order expectation contradicted the already-shipped cache improvement); and a provider-specific example was removed from an eventlog comment so the no-provider-pin ratchet passes without changing its ceiling. This intentionally updates the BYO wire expectation to the approved stable-first contract, not to the old cache-breaking order. The four full files pass 66/66; /private/tmp/clem-release-stale-contracts.log. Other full-suite failures remain open.

## Installed acceptance uncovered a worker-packet failure

GET /api/console/build-info confirmed installed packaged daemon 2c1a4ad13849870be4c517d34c95f52e45eac62a / fingerprint 654549ace9b66fbf0fb77c41ee4b5075b714fd867c1d85ff9b5375dca14c9ff5, PID 85067. App version label remains 3.18.19; final packaging/version alignment is still owed. Source is now ahead for test/comment cleanup and follow-up instrumentation; do not claim it equals installed HEAD.

Repeated the exact fictional three-prospect request: session sess-desktop-ad2d7bbc3e3acf9753e1fcf5, accepted source 295033. Terminal 295368 was needs_input, with the parent disclosing it wrote two drafts itself after workers hit max_turns. This FAILS the requested delegation acceptance, even though three draft texts were ultimately presented. Wall 189.8 s, combined uncached tokens 387,096 (parent 198,368; child sources 295133/295137/295141: 29,836/80,150/78,742). Measurements: /private/tmp/clem-takeover-live/refinements-parent-and-workers.json. No sends or CRM writes were requested.

The original three run_worker calls had distinct correct per-prospect instructions (events 295106, 295112, 295118). The quantified-work check rejected the initial shape; its numeric detector treated the review-count statistic 40 as a 40-item task. The parent's subsequent batch (295127) supplied all three item ids but retained Dana-specific shared instructions and itemContexts:null. Jev correctly accepted the three-item universe (295129), but that does not validate the per-item packets. Priya/Marcus workers consequently saw Dana instructions; watcher drift receipts 295318/295336 identified the conflict, and they spent turns searching before hitting their caps. Preserve the watcher: it caught the defect. Evidence: /private/tmp/clem-takeover-live/refinements-worker-packet-failure.json. The next fix must preserve distinct per-item packets across count/manifest correction; merely raising max_turns or accepting this parent fallback is not completion. Existing workerItemContexts validates supplied partitions, but null is allowed; workerCallItems intentionally merges item+items for compatibility, so rejecting that shape alone would neither fully solve this issue nor preserve the existing contract.

The new live bridge observation measured 9.78 ms, while accepted source to turn_model_routed took 4.653 s. The slow preparation is earlier than respondViaHarness; an additional runtime_configuration timing lane now brackets configureImpl for requests with an existing exact accepted source. It is not installed yet. Reviewer usage now shows its own request estimates (watcher instructions 569, toolSchemas 1), confirming the accounting correction live. Reviewer cache reads remained zero in this run.

A remaining recall test now asserts that objective-scoped retrieval excludes the unrelated newer write, while preserving the starred relevant choice and no-objective recency assertions. Its former index comparison assumed excluded material must still be injected. Full recall and bridge files: 168 pass, 0 fail (/private/tmp/clem-config-timing-recall.log); live-home sentinel was explicitly not performed because the running daemon owned WAL/SHM. This is focused unit coverage, not final isolation proof. Typecheck and diff check passed for this follow-up. No new full-suite pass, release/tag, or Windows artifact is claimed.

## Root fix for inline fan-out cardinality

The three original worker calls had no workManifest and each carried its correct prospect-specific packet. The existing quantified-work gate intentionally permits small chat batches without a durable manifest, but the detector missed inline `(1) ...; (2) ...; (3) ...` enumeration and selected the internal statistic `40 reviews`. That false large-batch classification forced the model into a shared-packet rewrite. Fixing only item+items or raising worker limits would not address this trigger.

The shared detector now recognizes structurally delimited, consecutive inline numbered lists as it already recognizes line lists. It uses the actual list length, keeps the item bodies, and retains single-parent/output and same-shape checks. It does not special-case prospects, ratings, models, or the number three. Nonconsecutive labels and parenthesized values do not constitute a structural list proof. Existing multiline handling remains preferred when present.

The new regression fails against HEAD's former detector with 40 != 3; after the fix the original three separate packet shapes pass the existing small-chat gate without a forced declaration or arbitration call. Tests also cover a twelve-member inline list, a single report's sections, and malformed sequences. Quantified-manifest plus context-packet suites: 65 pass, 0 fail; typecheck/diff check pass. Logs: /private/tmp/clem-inline-universe.log, /private/tmp/clem-inline-universe-red.log, /private/tmp/clem-inline-universe-types.log. This is a root-trigger fix, not proof that all possible model-authored shared packets are correct; the exact installed three-prospect acceptance must still be repeated. No watcher, completion judge, worker limit, or evidence check was removed.

## Exact live punctuation regression and fixture alignment

Installed f0911a0e8 (fingerprint dc69b724ef9b1aeabd9d22025ea6ba7bb9de7a779455691283dd79854f2e5dd0) still detected 40 on the exact fictional three-prospect input, source 295369 / sess-desktop-2b482db93cc5cb3272607c01. The request separates numbered entries with periods, unlike the semicolon unit fixture. Cancellation was requested to avoid further spend; afterward no open run attempts remained. This is not passing acceptance or a comparable successful speed measurement.

The structural parser now accepts sentence punctuation boundaries as well as list punctuation. The exact recorded fictional request is a regression pin, alongside the existing arbitrary-cardinality, malformed-list and single-output tests. No worker limit or review behavior changed.

Three attributed historical test failures are aligned with current contracts: workflow account choices include their existing display labels and current notification wording; native tools assert catalog discoverability, explicit schema selection and policy exclusion rather than unconditional prompt loading; owner-word repair seeds historical invalid facts with their original candidate/source linkage instead of asking current capture to admit them. Original authority, no-dispatch, exact retirement and orphan-preservation assertions remain.

The five focused files pass 81/81; typecheck passes. Logs: /private/tmp/clem-inline-sentences-contracts.log and /private/tmp/clem-sentence-final-types.log. The live-home isolation sentinel was not performed while the app owned WAL/SHM. Final idle suite and installed acceptance remain owed.

The runtime_configuration timing on source 295369 was 0.067 ms, and respond_bridge 4.209 ms; accepted source to routing was about 4.24 seconds. The unattributed delay precedes configureImpl, so investigate admission/replay/context setup rather than parallelizing dependent preparation speculatively.

## Sentence-separated installed acceptance

Signed Terminal hotpatch c2a0ada5d passed strict verification; installed build-info confirms fingerprint 2a81d003974a68834f5f3f9196d0e39d3a06c920ac043faf25de79cfb00df1b6, PID 7471. UI archive stayed unchanged. Rollback dist.backup-ZBcUR6 and skills backup-hQyB11 retained.

Exact fictional request source 295563 / sess-desktop-47b775ea1a58fb0b53ebf51b now detects three items. Three distinct worker packets returned ok:true with actual DeepSeek V4.1 Flash receipts (child sources 295626/295630/295634), no fallback. Opus first rejected a home-services wording violation, then accepted the corrected drafts in event 295719. Conversation terminal 295724 is success; no open attempts remain. This is a passing bounded delegation/review check, not broad release clearance.

Wall 77.5 s; parent uncached 163,540 including reviewer 132,417; combined parent and workers 225,915. Receipt /private/tmp/clem-takeover-live/sentence-parent-and-workers.json. This is materially better than the failed 189.8 s / 387,096 attempt, but slightly higher than the earlier successful 74.9 s / 217,802 run, so do not claim another measured efficiency win. Review caught a real issue and remains necessary. Preparation attribution, reviewer efficiency, remaining release tests, full idle suite and packaging remain open.

## Remaining contract migrations and compact-output fixes

Desktop/mobile plan ownership now uses a prepared reasoning-only fixture, with structured steps, an empty tool binding set and no preparation issues. It preserves principal, exact revision, unauthorized-control denial, busy-owner refusal and cross-surface replay assertions. Space route refusal assertions now match missing capability preparation rather than an inferred write classification; no-manifest dispatch remains forbidden. Existing cold durable-capability refresh/save tests pass alongside the route suite. This does not establish fresh capability acquisition from a Space declaration with no durable manifest. Combined three files: 39 pass (/private/tmp/clem-space-plan-release.log).

Cross-turn discovery now includes eight exact current-source discoveries as a positive control, because the shipped initial card intentionally excludes unrelated global catalog entries. All eight current disclosures remain present while the old source's exact disclosure remains excluded, with no duplicate events. All seven production-shape tests pass (/private/tmp/clem-cross-source-fixed.log). The source-identity contract was retained, not replaced with an empty-card assertion.

Compact structured projections now reclaim syntax space reserved for fields that were omitted. The same ranked order, existing values and total size bound remain; spare space can recover complete scalars or nested structured values but does not inflate omitted text blobs. A pure 25-row regression on HEAD leaves 893 of 4,000 characters unused and loses all 25 nested scalar values; the candidate retains them within 4,000. Proof: /private/tmp/clem-projection-old-pin.log. Existing calendar answering-field, opaque metadata, omission semantics and raw redemption tests remain green.

The real native-carrier check also exposed pre-existing double projection: nested control results formatted at 20k then crossed a 4k carrier, which digested projected JSON as text. Nested bracket presentation now uses the existing compact-carrier budget while its exact child receipt is available (explicit local-read budget still takes precedence). An authenticated same-invocation projection is byte-preserved on an implicit repeat formatter call; an explicit smaller budget still re-renders from original raw bytes. No receipt identity check was relaxed. An attempted retain-only nested formatting variant did not fix the issue and was discarded.

Six output suites pass 53/53 (/private/tmp/clem-projection-carrier.log); broader bracket/host/preview suites pass 425/425 (/private/tmp/clem-projection-host.log); typecheck passes (/private/tmp/clem-projection-types.log). The real-host annotated, unformatted-native and steering recovery assertions are unchanged. Isolated runner home sentinel was not performed while the installed daemon owned the live home. These changes are not yet hotpatched: installed remains c2a0ada5d. Full idle suite, rubric budget failures, installed follow-up and release packaging remain owed.

## Stable instruction budget and pre-bridge attribution

Shortened shared readiness, consent, read-scope and background-status wording while preserving their rules. Fresh-action instructions are 5,500 UTF-8 bytes, down from 6,296; full rubric is 31,829 characters, down from 32,689. The existing 5,500-byte and Phase-0 +5% guards were not raised. Snapshot goldens were updated only for this reviewed wording change. Interaction, consent, provider parity, workflow authority and orchestrator checks pass 116/116 (/private/tmp/clem-rubric-final.log). This is a measured reduction in prompt bytes, not a measured wall-time improvement or new policy enforcement.

Added one exact-source desktop_admission timing event immediately before bridge dispatch. Monotonic offsets cover recording the accepted source, executor scheduling, continuity routing when used, and entering the bridge. This is diagnostic only; it does not reorder or remove preparation. The authenticated desktop/mobile ownership test verifies one source-bound timing record with monotonic marks on the desktop path and retains all prior ownership/replay assertions. It passes (/private/tmp/clem-desktop-timing-final.log); typecheck passes (/private/tmp/clem-rubric-timing-types.log).

Next: build this candidate, install through the signed Terminal recipe, measure the new admission phases and compact-output behavior, and run the complete suite/journeys with the installed daemon stopped. The full-suite diagnostic never completed earlier, so fixing its known failures does not establish that the remaining unobserved tail passes. No merge, tag or Windows artifact yet.

## Fixed preparation cost attributed to lock-taking inventory

Signed installed c59765583 / fingerprint 7a1db3edbbf257b7099959cbeb065b9f0a893721fbfb0166ce6ef667c7e6bf9b passed the exact three-prospect request, source 295733 / sess-desktop-550cd7a243b959c6699e75a0. All three workers returned ok; Opus event 295930 accepted, terminal 295935 success, no open attempts. Wall 69.1 s, combined uncached 223,000 (/private/tmp/clem-takeover-live/compact-parent-and-workers.json). This is one observation, not a repeated average or isolated causal speed result. UI archive unchanged; rollback dist.backup-8I1MZL and skills backup-7gjASR retained.

New admission timings show 4,178.63 ms total, with continuity from 3.00 to 4,177.59 ms; configureImpl 0.062 ms and bridge 4.728 ms. The continuity inventory uses readWorkflowRunRecord for every historical run, taking/fsyncing write-style locks even on completed records. A read-only count found 339 run JSON files (4.6 MB, raw read/parse ~24 ms), versus 153 proposal files (~7 ms); no business data was modified.

The inventory now uses the existing atomic snapshot reader. Writers already publish whole JSON via atomic rename. This lookup supplies no execution authority: queueWorkflowRunInputResolution still locks and rechecks exact run, question, step, origin, unanswered status and cancellation before writing. New pins demonstrate that a live lock cannot block inventory or be modified by it, a replaced question rejects the old snapshot, and multiple/origin-mismatched questions remain unclaimed. The live-lock pin fails on the former implementation (/private/tmp/clem-inventory-red.log); all five related files pass 48/48 (/private/tmp/clem-inventory-green.log), typecheck passes (/private/tmp/clem-inventory-types.log). The change still needs installed before/after timing.

## Owned shell process cleanup before the full suite

Pre-suite process inspection found PID 86834, parent 1, consuming a core for ~50 minutes: a grep command searching the exact fictional prospects in the controlled failed worker run. Its parent was gone. Stopped only that positively identified orphan with TERM and verified it exited. macOS Spotlight and XProtect background work were also active; no system services were changed.

The shell timeout code used taskkill /T /F on Windows but killed only the wrapper on POSIX. A real process-tree pin reproduced two surviving descendants, including a child that ignores TERM, after the tool reported timeout. POSIX shell commands now own a separate process group and the hard deadline kills that owned group; Windows taskkill is unchanged. Typed timeout outcome and external-mutation uncertainty remain unchanged. The fixture cleans only its captured PIDs. Red: /private/tmp/clem-shell-tree-red.log; five shell suites pass 49/49 (/private/tmp/clem-shell-tree-green.log), typecheck passes (/private/tmp/clem-shell-tree-types.log). These checks ran with the app stopped and the isolated runner reported no live-home changes. Cancellation before the tool deadline is not newly qualified by this test.

Installed 87d4b6fa9 was signed successfully and held stopped for the full suite; the subsequent shell fix is not installed yet. The next build/patch must include it. Do not launch the app during the full isolated suite, which needs a stationary live home.

## Full-sweep failure attribution and runner repairs

Signed Terminal hotpatch 9e26f3211 completed with the app held stopped; log /private/tmp/clem-full-sweep-patch/apply.log, daemon rollback dist.backup-FsYJGO. The UI archive stayed unchanged. Served-build and installed preparation timing remain owed.

The full isolated sweep /private/tmp/clem-full-sweep-9e26.log reached 10,303 ordered top-level results before the outer watchdog ended it unsuccessfully. It is not a full-suite pass, and the later buffered files do not have an accepted result. No live-home sentinel violation was reported. Named failures were the concurrent accepted-source worker bootstrap and three discovery/graph-repair expectations; the latter file spent 319.8 seconds formatting an assertion failure. Current candidate/last-tag named attribution is in /private/tmp/clem-9e26-attribution/results.json: discovery fails on candidate alone and passes on v3.18.19; the worker passes alone on both but failed in the full sweep.

The watchdog itself lost the global result sequence at `ok 7351`, a file-only result numbered `755`, then `ok 7353`. It therefore timed out despite subsequent completed tests. A red pin reproduces that exact numbering shape (/private/tmp/clem-watchdog-red.log). The tracker now consumes one global result only when the out-of-sequence result pairs with the exact reported file boundary. Repeated chatter, arbitrary gaps and stderr TAP remain excluded. Worker tests now launch a JavaScript bootstrap that explicitly imports the TypeScript fixture through tsImport; the same two real workers, shared barrier, SQLite race and all branch/approval assertions remain. The combined runner/worker suites pass 18/18 (/private/tmp/clem-watchdog-worker-green.log).

Discovery-governor tests now assert that ordinary discovery preserves the stable tool prefix and retains discovery/dispatch carriers while plan_task stays on demand. The two missing-write graph-repair fixtures explicitly use the production Act surface, which supplies their planning schema from frame one; all prior missing-write, no-substitution, exact call count and no-graph-on-refusal assertions remain. This distinguishes schema acquisition from graph repair rather than restoring automatic schema growth. The whole governor file passes 13/13 (/private/tmp/clem-no-progress-green.log). The separate structural-control lookup test still proves full schema redemption from the returned handle; these pins are not a new installed JIT planning acceptance.

Preserve and include the previously untracked 2026-09-23-efficient-agent-execution-brief.md as the historical owner-requested brief. Untracked docs participate in the source fingerprint, so leaving it untracked would make the installed candidate differ from a clean release checkout. Final builds and gates must follow the committed reviewed series. Remaining: unseen test tail, complete isolated suite, journeys, release/package/upgrade gates, installed live measurements and continuity/workflow checks, integration and tag. Windows production signing secrets are absent; the owner has a pending choice between supplying them and an unsigned private candidate. No Windows production release is cleared.

## Follow-up: cache accounting and contract fixtures (2026-09-24)

Candidate remains on harness/3.19, based on e9d682575. Installed app remains
stopped at the e9d hotpatch; the changes below are NOT live accepted or tagged.

- Found a real semantic fallback accounting defect: SDK cached input details
  were discarded when the adapter did not record its own usage. The same
  100-input/40-cached/10-output response debited 110 instead of 70 uncached-work
  tokens. Preserve cache details through the configured semantic completion
  and fallback recorder, retaining the existing exact-once adapter ownership.
  Red: /private/tmp/clem-semantic-cache-red.log (fallback fails, adapter passes).
  Green: /private/tmp/clem-semantic-cache-green.log, 9/9 including aggregate vs
  detail-row duplication and multiple raw responses. This corrects accounting;
  it does NOT reduce provider tokens or demonstrate latency savings.
- Typecheck passed: /private/tmp/clem-refinement-typecheck.log.
- Follow-up fixture group: /private/tmp/clem-fixture-contract-followup.log,
  144/145 passed. The one remaining assertion expected the old missing-memory
  reference wording. After aligning that assertion with the current explicit
  durable-reference message, /private/tmp/clem-memory-contract-green.log is
  24/24. Planned provider tests retain the fifty-write and reopen checks and
  now supply current-source disclosure instead of assuming a global catalog.
- Earlier purpose-ranking pin group remains 36/36 at
  /private/tmp/clem-purpose-rank-green2.log; broader ranking verification owed.

Remaining named failures are not waived: the loop exact-source collection
fixture now reports a durable-memory episode / accepted graph semantic-input
binding mismatch; the warm learned calendar fixture reports that the exact
connected-app definition did not reach fresh host planning. Diagnostics:
/private/tmp/clem-loop-warm-diagnostic.log. Neither completion authority nor
memory checks have been weakened. Other named failures in the tail attribution
ledger still need resolution before another full suite. No full green claimed.

Do not promise a few-second judge from cache or lookup handles: actual reviewer
prefix accounting differs from the previously reported brain prefix, and
handles can add lookup turns. Reviewer racing changes model selection and cost;
it remains unenabled. Keep watcher and judge gating intact. A rebuilt signed
Terminal hotpatch, served fingerprint check, matched live measurements, full
suite/journeys and release packaging gates are still owed before merge/tag.

## Memory completion and warm read follow-up (2026-09-24)

The previous loop diagnostics exposed TWO production defects, not just stale
fixtures. Neither is hotpatched yet:

1. Graph input hashes use trimmed original source bytes; memory intake stores
   normalized whitespace. Comparing the normalized text against the graph hash
   rejected valid multiline accepted requests. Bind the original bytes before
   verifying the normalized durable episode/candidates. Red new pin:
   /private/tmp/clem-memory-graph-whitespace-red.log. All eight intake tests
   passed in /private/tmp/clem-memory-graph-whitespace-green.log; this also
   cleared five previously failing loop completion tests.
2. A queued auto-memory candidate (without a verified memory-only receipt)
   allowed a bare acknowledgement to complete an unfinished action. Require
   prepare-and-redeem of the exact memory receipt instead. The pure memory
   classifier previously also demanded an explicit acknowledgement-only suffix;
   pure declarative explicit remember requests now use the same receipt checks
   without that extra wording. Secondary requests/actions/questions, storage
   integrity checks and provenance checks remain. New positive and compound
   negative pins cover the change. The exact-reply loop fixture now actually
   performs zero work instead of injecting an unrelated fixture settlement.

Warm read fixture migration: the old fixture forced plan_task for one calendar
read. The current foreground contract allows the exact learned capability ref
through work_call directly. The updated test retains one real governed provider
crossing, no discovery, two model frames, one terminal, exact settlement and
unavailable-review disclosure. No coordinated-plan coverage was removed from
three/fifty-write tests. /private/tmp/clem-warm-current-contract-green.log: 1/1.
The existing delivery contract can publish the result with an unreviewed notice;
verified=false / failedOpen=true remain asserted. This is NOT live review proof.
No orchestrator runtime change was retained from the diagnostic experiments.

Broad intermediate check: /private/tmp/clem-memory-loop-ranking-broad.log,
326/327 (the one failure was the pure-memory wording requirement above).
Current broader memory/Claude-adapter/loop run:
/private/tmp/clem-memory-completion-full-files.log, tool session 98581, still
running at this checkpoint (355 named tests had progressed, no failures seen).
Poll that exact handle or inspect its final summary; do not treat a partial log
as a pass. Latest typecheck: /private/tmp/clem-memory-refinements-typecheck.log.
Remaining tail failures in planning-card recovery, sealed CLI fixtures and
schema/workflow guidance still need resolution. Full sweep, journeys, rebuild,
installed live acceptance, merge and release remain owed. Windows signing
choice remains unanswered. Installed app is still held stopped at e9d682575.

Follow-up terminal evidence: session 98581 finished exit 0. The broad memory,
Claude-adapter and loop run passed 421/421 with zero failures/cancellations/skips
in 139.3 s. Typecheck session 42836 also finished exit 0. No running process from
this memory check remains. The final fixture cleanup removed a diagnostic that
called receipt preparation from an assertion; production receipt preparation
and its explicit positive/negative intake pins remain covered.

## Remaining tail failures closed before next full sweep (2026-09-24)

All named tail-failure groups have targeted passing coverage now. Latest group:
/private/tmp/clem-final-contract-files-green.log, 85/85, zero skips/failures;
/private/tmp/clem-disclosure-nomination-pin.log, 1/1;
/private/tmp/clem-release-refinements-typecheck.log, exit 0.

A further framework defect emerged while migrating recovery fixtures: repacking
one same-source disclosure filled empty card slots from the entire live catalog.
The red assertion is in /private/tmp/clem-final-contract-files.log. Repacking now
uses only the existing card plus exact request disclosures. Current-definition
validation, continuation inheritance, cold tool discovery and selected-operation
validation remain unchanged. The dedicated pin checks an empty initial card,
one disclosed reader, an unrelated configured reader, and reopen stability.

Fixture migrations are deliberate current-contract checks, not waived failures:
- Recovery fixtures carry exact sealed provider definitions and same-source
  disclosure instead of assuming automatic global inventory preload. The parent
  continuation still binds the same objective digest and inherits its disclosed
  operation; an unrelated new turn inherits nothing.
- Reviewed-CLI publication retains NO optional externalDefinition, a producer-
  sealed schema digest, strict revalidation and schema mutation rejection. Its
  exact CLI resolution is nominated for the accepted source before priming.
- Historical disclosure keeps the immutable initial snapshot unchanged; only
  valid current same-source disclosures extend the working card. Retired
  mutation/readback semantics remain excluded with zero provider bodies.
- Disabled named-workflow guidance preserves the requested saved workflow and
  uses authorized enable/verify/run, rather than silently substituting ad-hoc
  work. Both entry points share the tested message helper.
- Schema guidance now executes actual search and paginated local schema recovery
  across exact/fixed/mixed/fallback carriers. Inline schemas require no extra
  reads; omitted 100K+ schemas redeem losslessly with one provider search only.
- Toolkit citation positive control now explicitly requests toolkit use; merely
  mentioning a provider is not a request to bind it. Cited scope stays intact.

Runtime series: 9bacb1991 memory completion, 962deaf8a semantic cache accounting,
2bb14938a purpose ranking, c3a1139fb scoped planning-card repacking. Full candidate
sweep/build/hotpatch/live acceptance still required; these targeted results do
not constitute release approval. No tag/merge/push has occurred.
