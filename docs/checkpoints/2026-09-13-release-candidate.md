# 3.18.6-rc.1 packaging checkpoint

The owner asked for the highest-value remaining refinement, followed by packaging, without adding more gates. This candidate preserves the existing harness and Home UI work and adds model-connection recovery and two small integration repairs found during release checks.

## What changed in this pass

The host previously recovered model stalls but let a dropped stream such as the observed `undici terminated` end the turn. It now uses the existing per-response retry allowance for recognized transport interruptions. Only accepted history is retried: tool calls from an incomplete response never execute, and completed tool receipts stay in the next request. Owner cancellation, permanent configuration failures, and an active buffered provider request are not replayed. If connectivity remains unavailable, the existing awaiting-input path saves history and presents a specific continuation question. No new Plan, approval, or task-size gate was added.

Release checks also exposed host execution guidance being parsed as requested business work: references to send/destructive consent invented an external-write obligation for a local-file plan. Graph classification now uses owner input with adopted steering and the selected plan text, while the model still receives the full execution guidance. The actual delegated Execute fixture now writes once and credits the parent. Home tools were also added to the existing Workspace feature bundle to match their registry declarations; the common hot-tool set stays small.

Runtime files: `src/runtime/harness/host-turn-runner.ts` the fresh/resumed awaiting-input branches in `src/runtime/harness/loop.ts`, `src/runtime/graph/turn-graph-shadow.ts`, and `src/spaces/workspace-context.ts`.

Controlled tests cover typed and raw transport errors after a completed write, rejected partial tool intents, repeated failure, cancellation, permanent errors, pre-content stalls with/without an active buffered request, and the actual loop's persisted continuation question. These are fault-injected model tests, not a claim that a live provider connection was deliberately severed.

Stale release assertions were corrected: the current chat width expression, a pending trust fixture whose fixed August date had expired, and the project manifest's new `home_get` read. `home_get` was reviewed as a fixed owner-local read with no arbitrary path, source refresh, workflow execution, or mutation. The direct-consent fixture was also updated for the already-shipped unknown-risk behavior: exact approval rather than an impossible argument-repair loop, with changed argument/account/schema and risk-subject rejection tested for both sends and unknown actions. Product trust expiry and tool admission were not loosened to pass tests.

The fifty-member fixture had a one-minute fixture deadline and stopped at forty under suite load; its test-only allowance now matches the isolated runner’s ten-minute file budget. Production task limits were not changed. The native workspace-root result is plain text, so its test now checks actual roots and completed-result evidence rather than a retired successful-envelope shape. Registry parity checks include Home and the existing parent-only plan_step_result control.

The final full run passed 16,107 tests with three skips and one remaining fifty-member fixture failure. A controlled reproduction identified another fixture defect: its independent observer returned the initial timestamp on every fresh check. The fixture now reports its actual observation time and deliberately ages the cached snapshot after the first batch so the regression is covered without waiting a minute. Production freshness rules remain unchanged. Keep the full-run failure and the separate red/green verification in the candidate evidence; do not call that full run all-green.

The earlier reported worker provenance failure passes with the supported isolated runner, which provisions the fixture seal key. Do not cite the earlier direct-run result as a confirmed production defect, or silently substitute it for a full-suite result.

## Evidence and boundaries

Current qualification and packaging results belong in `output/release-candidate-3.18.6-rc.1/`. Preserve failed runs and record follow-up results separately. This checkpoint is written before the build freeze; the output manifest records its final fingerprint, checksums, test results and live qualification.

The preceding real research document is complete and read back, with positive Grok completion review on its final bytes. That journey was assisted: approval and quality steering were provided, and the failed transport turn required an explicit retry. Its evidence remains under `output/reviewer-monitor/2026-09-13-plan-publication-owner/`. It is not an autonomous end-to-end pass of this new candidate.

Deferred observations include partial source-result error classification and broader progress/steering visibility around approval-resumed and background work. Do not label these as solved by connection recovery. The larger existing Plan/Execute, auth, evidence and Home changes remain part of the combined candidate and require their own regression coverage.

Version is a local prerelease, 3.18.6-rc.1. No tag, push, release publication, or automatic update feed publication is authorized by this packaging checkpoint. All work remains uncommitted unless the owner separately requests a commit. The installed app is not changed merely by building a package.
