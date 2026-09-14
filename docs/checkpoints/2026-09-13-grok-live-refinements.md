# Grok live replay and connection refinements — 2026-09-13

## Scope and running build

The owner asked to continue testing with Grok and refine the harness. The combined checkpoint is `b2a91bb39f6ddbbdbfc8952fcad66006b66dde1b` (version 3.18.5). No new gates, task limits, business vocabulary, UI changes, commits or tags were added in this pass. Source dev PID 18563 on port 8520 was kept running during qualification. The new connection changes are uncommitted; do not assume that already-running process has reloaded them.

Evidence: `output/reviewer-monitor/2026-09-13-grok-current/`.

## Correction to the earlier login diagnosis

An expired access-token timestamp did not require a new Grok login. The real dev daemon refreshed its own xAI grant through the existing request-time refresh path. A no-tools live chat returned `13`, with a served Grok4.6 response and owner-selected Opus5 completion review. The refreshed grant expiry was 2026-09-14T02:42:22.557Z. The probe retained only status and usage identity, not credentials. This supersedes the reconnect instruction in the previous checkpoint.

Isolated proofs receive an access-only snapshot, never the production rotating refresh token. No proof process refreshed or copied that refresh grant.

## U — current checkpoint Plan → Execute

Session `sess-desktop-4d6eb3d284a03e7fef9282c9`, source sequences 1 and 149. Live Grok4.6 with selected Opus5; synthetic read-only research-lab, actual native local file authoring. No real customer services were modified.

- Plan: 294,058ms (4m54s), published revision1, inspected both nested contracts, disclosed relevant memory, no premature research or business write, completion verified.
- Execute: 790,013ms (13m10s), exact approved page/API arguments, independent reads in parallel, synthesis, one successful file write, eventual readback, completion verified on reply/objective/artifacts. No tool refusal and no duplicate write.
- A Grok stream stalled after the successful write. The existing host recovery emitted `model_stall_retry` at235, discarded the incomplete model frame, preserved the settled write, then read the file at242 and finished at265. The readback did not happen until after recovery. This is evidence for recovery correctness in this case, not acceptable latency.
- There were two accepted completion verdicts, one per source. Usage records contain three Opus requests in Plan and two in Execute, including advisory work; do not report only two total judge calls. Six completed Grok usage rows per source do not count the stalled stream as a completed billable response. Its token cost is unknown.
- The saved markdown SHA256 is `6b4e8f55edc87b53cb4f964950ca1ba8936531fffdd2c6e39ad0cfbef578cded`. The completion artifact digest refers to the host receipt, a different object. Do not equate those digests.
- Both test phases passed the declared U assertions. Before starting U, the inherited fixture was corrected to permit a rewrite only after an intervening negative judge and to distinguish the test-only eight-call continuation deferral from a tool refusal. U needed neither exception: one write, zero refusals. Prior R failures remain preserved.
- All 4,130 attested source/runtime files stayed unchanged throughout U. The daemon stopped and sanitized successfully. Its disposable dependency cache was removed after termination; database, logs, raw events, reports and artifacts remain.

### Quality and latency limits

The briefing covers the requested matrix, sources, unknown prices, directional metrics and opportunities. It still occasionally promotes limited homepage observations into stronger exclusivity claims, such as Birch being the only fit. Opus accepted it. Treat this as a calibration gap, not perfect content qualification. The judge already has a source-grounding instruction; another task-specific phrase is not a demonstrated fix.

The post-write wait exposes an avoidable model decision point: the approved readback already has its exact tool and path. Investigate executing fully bound, dependency-ready steps through the existing graph authority before changing retry policy or reducing reasoning quality. A single live sample is not a controlled performance comparison.

## Connection defects reproduced and repaired

Two synthetic controls against the unchanged checkpoint showed four simultaneous requests making four refresh calls, and a late successful refresh restoring a disconnected grant. Repository regression tests reproduced six failures. The wire adapter had a related fault: refresh failure or a disconnected grant fell through to the cached bearer. Two transport tests reproduced those failures.

Changes:

- `auth-store.ts`: concurrent refreshes share one in-flight operation per grant in the daemon. A new sign-in can refresh independently; late success or failure follows the current persisted grant and cannot overwrite a replacement or undo a disconnect. Failed refreshes preserve the existing grant and release the in-flight state for a later retry.
- `byo-model.ts`: OAuth-backed requests use the current bearer. Missing grants and refresh failures no longer silently send a stale credential. Existing request retry behavior owns transport errors. Explicit API-key providers retain their static path.
- `xai-auth-refresh.test.ts` and `byo-bearer-refresh.test.ts`: concurrency, success/failure after disconnect, replacement login, overlapping replacement refresh, failure/retry, fresh/no-grant paths, rotating cached clients, no stale dispatch, and explicit-key control.

139/139 focused tests passed across nine files, followed by a successful backend build in the isolated refinement checkout. These include existing auth, provider routing, model adapter and selected-judge tests. The live-home isolation sentinel was NOT performed because the user dev daemon owns the real home; do not claim a sentinel pass. Refresh coordination is in-process; cross-process refresh serialization was not added or qualified.

## V — shorter Act qualification

V's first quick-read assertion failed because the inherited synthetic fixture assigned mention counts by request-array position. It returned7 for a single Cedar query, and Clem faithfully reported7. The same fixture also assigned service/software descriptions by position. Both defects were corrected in a separate v2 fixture, with actual MCP client controls for reordered and single-target requests and unknown-target rejection. The original V failure remains in `live-v-grok-on`; it is not evidence that Clem misreported the returned number. V did make a missing-argument error on api_reference, and the bridge erased its useful explanation.

V2 session `sess-desktop-c2d6fe423e9ae4952b77809d`, on the frozen auth-refinement build:

- Quick read:43,592ms, correct11 mentions/100 observations, zero Plan, zero mutation, verified Opus-reviewed terminal.
- Space create:128,137ms, one native space_save, correct table/dataset/mobile projection, zero Plan/refusal, verified terminal.
- Space edit:69,014ms, one native space_save upsert, zero Plan/refusal, verified terminal. The inherited test demanded space_edit_view and therefore FAILED. That was an over-specific oracle: save is the supported update operation and updated both the dataset and view.
- A separate `space-edit-behavior-audit.json` proves only Birch changed9→12 in the HTML, persisted dataset and mobile projection, with one authorized upsert. Other rows and HTML bytes are preserved. This audit does not erase the original tool-name assertion failure.

These use access-only snapshots, so their healthy paths validate model use with the adapter changes but do not exercise a real rotating-token race.


## Native MCP repair detail refinement and W

The actual V trace at65 exposed `native MCP operation returned isError`: production-mcp-read-carrier.ts discarded the provider's explanation before the model saw it. The fix preserves text blocks from both the SDK Array-with-metadata and ordinary MCP envelope; structured-only details are retained too. The existing typed isError flag still selects failure. There is no keyword-based authority, no conversion of arbitrary error text into success, and no new gate. The existing failure classification stays unchanged; unknown write effects are not declared safe to replay.

Three new controls failed before the fix. All44 native-carrier tests passed after it, including valid content discussing errors and non-text-error fallback. Together with the auth/adapter checks,183 focused tests across ten files pass. The final main backend build passes. No live-home isolation sentinel pass is claimed.

W session `sess-desktop-b02f1ab6cfb8a5e1ac58122f`, final main code, actual Grok4.6 + selected Opus5 with a synthetic MCP service:

- First provider read returns an expired-snapshot error and exact retry argument. The model receives that original explanation, retries once with snapshot_id=snapshot-current, and reports17 mentions/100 observations.
-35,855ms; zero Plan or mutation; completion verified. Exact provider error→model-visible detail→corrected arguments→successful result is live-proven.
- The strict W fixture FAILED because Grok also guessed arguments on skill_list and workspace_info. skill_list rejects its extra query field; workspace_info requires project_path. The model repaired/skipped these and completed. Preserve these two refused attempts as the next first-attempt/schema-disclosure issue; do not call W a clean-attempt pass.
- W's direct provider failure is still classified unknown on the read settlement. This pass restores useful explanation, not a new typed error taxonomy.

## Next priorities and release limits

1. Reduce avoidable model round trips between fully bound approved steps, particularly save→readback; preserve steering and existing authority at each dispatch.
2. Give the model sufficient invocation information for suggested native helpers, and avoid unrelated initial helper calls. W's exact two argument errors are the next controls; do not widen schemas or silently guess required values to make tests green.
3. Calibrate material factual/exclusivity claims against source coverage. Existing grounding instructions did not catch U's overstatement. Keep evaluation evidence separate from a judge's pass.

The latest source changes remain uncommitted. Dev PID18563 was not restarted, and no installed-app hotpatch, push or tag happened. The UI is untouched. All disposable test daemons were stopped and sanitized; raw failed runs remain. These are synthetic-service harness qualification results, not qualification of every real connected provider or every long task.
