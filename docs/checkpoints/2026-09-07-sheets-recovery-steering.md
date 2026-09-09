# Targeted correction — let Clem continue the Salesforce-to-Sheet job

Owner-requested follow-up review, September 7, 13:20 UTC. This is a focused intervention after the final handoff, not a resumption of the recurring monitor or a claim on the live window. The implementation lead retains ownership. No new LLM/provider calls, daemon changes or runtime edits were made for this review.

**Next priority: fix the contradictions between task mode, available tools, failure classification and recovery.** The observed task is ordinary business work that requires several tools and conversational updates. It should not require the owner to repair the harness's internal state. Preserve the accepted job and useful results while the brain changes a query or resolves a real missing choice.

## Exact failures, independently read from durable records

Serving at observation: `47e306fdf1ba2f415f6c0d2290b9beeb883251a67f3905a4a79b4a944dc7110c`, PID 68739, in `/Users/you/clementine-next-live-iteration-31`; disk matched boot. The original/UI checkout has also advanced; this is not a complete review of those changes.

| Accepted source | Task and recorded outcome |
| --- | --- |
| 143751 | Normal, 30 Tim prospect accounts → activity/domain → new Google Sheet. Grok 4.6. Driver timed out after 15 minutes and cancelled the attempt. 59 logged top-level calls. Do not call this a spontaneous governor terminal. |
| 144363 | Same 30-account request in Normal, Grok 4.6, current `47e306fd…` source. Blocked after 469.828 seconds, 8 main-model requests and 35 top-level calls including 19 Salesforce reads and 8 tool searches. Terminal 144629: `control_no_progress_exhausted / execution:unknown`. |
| 146042 | Ten-account variant explicitly in Plan, Claude Sonnet 4.6, same source fingerprint. Blocked after 65.983 seconds and 6 main-model requests. Two Salesforce reads succeeded. Terminal 146121: `control_no_progress_exhausted / recovery_surface_mismatch`. |

These are different scenarios/models, not a controlled model comparison. A Plan run should produce an executable reviewed plan, not create the Sheet before Execute. No completed Sheet is established by these traces; the two blocked terminals report no settled external write. Opus auxiliary usage must not be called accepted completion review.

### 1. Plan mode rejects its own progress conversation, then proposes an unusable recovery path

Source 146042 resolves Tim and receives six account rows from its query. At 146113, Clem calls `check_in` with a progress note saying that six accounts were found and activity details are next. At 146114 the host responds:

> PLAN_MODE_READ_ONLY: check_in cannot execute in Plan mode.

The refusal tells her to include that action in `publish_plan`. Registry declaration [tool-registry.ts](/Users/you/clementine-next-live-iteration-31/src/tools/tool-registry.ts:305) describes `check_in` as a mid-task progress message, with `runtimeEffect: host_only`. [accepted-task-mode.ts](/Users/you/clementine-next-live-iteration-31/src/runtime/harness/accepted-task-mode.ts:18) accepts read/compute plus selected controls; this host-only progress operation falls through to a business-effect-style refusal.

The governor records a repair with `recoveryToolNames: [check_in]` at 146115. At 146116 it records **continue / retry_available, with two retries remaining**. The next accepted model frame tries two Salesforce activity reads; both are locally refused and the run ends as a recovery-surface mismatch. The terminal recommends using `check_in`, the very tool Plan mode refused. This is a contradictory host contract, not proof that the model cannot understand the task.

There is a second concrete mismatch: [host-turn-runner.ts](/Users/you/clementine-next-live-iteration-31/src/runtime/harness/host-turn-runner.ts:7348) derives recovery's proven reads from `provenCapabilityEntriesForTurn`. The latest `capability_resolution` event contains seven Google Sheets **write** entries and no Salesforce read entry. Yet the Salesforce read was disclosed by the live-read registry and successfully executed twice. Recovery therefore loses that carrier through an incomplete projection of known capabilities. The read did not become unauthorized merely because a different inventory omits it. Revalidation at the actual read edge still applies.

The refused follow-up model frame also uses string `"null"` in several nullable carrier fields. That is a separate argument-shape issue to test; do not claim those calls would necessarily have passed every later check. The demonstrated stop happens at the recovery-surface check before those later stages.

**Correction:** express which bounded conversation controls are permitted in Plan using their actual contract, while continuing to block business writes and execution. Recovery must offer actions compatible with the accepted mode and the same current, source-bound capabilities that ordinary dispatch recognizes. Do not simply allow every host-only operation, whitelist all carrier effects, or disable Plan enforcement. A harmless progress note must not replace the user's job with a plan to send that note.

### 2. A query-shape failure becomes a permanent stop before the model can repair it

In source 144363, calls ending `-4` and `-5` in batch `call-91ed4e94…` attempt an `ActivityHistories` query. Both return a `ReviewedCliProcessError` with `MALFORMED_QUERY` and Salesforce's single-parent relationship restriction. Events 144606/144608 settle them as **unknown**, mutating false, zero recorded physical/host crossings. Events 144607/144609 show a generic string error saying “Please try again”; the useful provider diagnostic is cut off.

Other reads in that same batch succeed afterward, retaining Task and Opportunity results. The governor at 144626 still records **continue / retry_available, with two retries remaining**, but [host-no-progress-projection.ts](/Users/you/clementine-next-live-iteration-31/src/runtime/harness/host-no-progress-projection.ts:1172) maps `unknown` to `stop_factual`; [host-turn-runner.ts](/Users/you/clementine-next-live-iteration-31/src/runtime/harness/host-turn-runner.ts:7345) stops without another model step. The result is labeled no-progress exhaustion even though the last budget decision did not exhaust it.

[reviewed-cli-read-transport.ts](/Users/you/clementine-next-live-iteration-31/src/runtime/harness/reviewed-cli-read-transport.ts:115) already retains the structured process outcome on the error. The path needs to preserve typed read-failure/repair evidence through the real carrier and settlement, rather than only improving the text of an exception. Use provider-structured diagnostics where supported; do not route authority by English error wording or classify every unknown failure as safe to retry. Unknown writes must still reconcile before any repeat.

**Correction:** let a known read-only query rejection reach the brain with a usable diagnosis and an admissible alternative read path. Preserve successful sibling results. Let the model repair the query or choose a supported alternative, then continue toward the Sheet. The terminal should distinguish a real exhausted retry budget, a policy prohibition, missing input and an unresolved effect; these are different conditions.

### 3. Discovery and data shaping remain follow-through work

The first Normal run repeatedly searched for Google Sheet creation, sometimes receiving unrelated local tools. In the second, `GOOGLESHEETS_VALUES_UPDATE` is returned with a capability reference at 144454, but later exact searches produce `account_selection_required` at 144605; the create tool has the same status at 144575. Trace the current-source account selection and tool identity through the same request before declaring either a provider outage or a valid need to ask again. Preserve actual account authority; never invent a source quote to satisfy a gate.

Both long Normal runs condense large tool outputs and then recall prior results. Condensation itself is not proven as the terminal cause here. Verify that complete queried data remains recoverable and usable without repeated Salesforce reads, and use structured row joins/aggregation where available. A successful query returning six rows does not prove that only six accounts satisfy the owner's intended definition. Do not silently equate a general account activity date, an open future reminder, and Tim's actual last communication; verify the relevant fields/coverage and explain any shortfall rather than padding rows.

## Implement and prove one connected path

Before the next broad live retry, add regressions through the actual production boundaries:

1. **Plan conversation:** accepted Plan → successful read → progress update → another authorized read → publish a plan, with zero business writes. Include a forbidden write control and verify that recovery never recommends a mode-disallowed operation.
2. **Capability continuity:** a read from the reviewed CLI registry is usable after a repair transition even when the latest separate Composio resolution has only write entries. Ordinary and recovery dispatch must preserve exact source/account/schema checks.
3. **Read error repair:** real carrier-shaped structured query rejection plus successful sibling reads → repairable settlement → next model sees both diagnosis and retained data → corrected read succeeds. Include an uncertain-write negative control; don't generalize this into retrying unknown effects.
4. **Terminal accuracy:** a `stop_factual` decision must not be presented as exhausted retries when retries remain. User-facing language explains the missing work and a meaningful next choice, not `check_in`, result-handle IDs or internal recovery labels.
5. **End-to-end:** run one Normal ten-account journey with natural wording, and separately Plan → inspected plan → exact Execute. Verify eligibility, actual communication evidence, summary/domain columns, exact Sheet account/destination, written-range readback and no unintended effects. If fewer accounts qualify, return the truthful result and explain why. Once these work, restore the 30-account case; reducing row count is diagnostic, not the permanent fix.

Keep each failure and fresh successor result under its own fingerprint. Do not replay prior uncertain effects. No model/provider change, bigger timeout, prompt admonition or single healthy Workflow creation substitutes for these acceptance cases. The desired behavior is a coherent read → inspect → repair → continue → write → verify job, with normal conversation throughout.

## Separate outstanding scope finding — do not mark closed from one negative pair

The new [accepted-mutation-scope.ts](/Users/you/clementine-next-live-iteration-31/src/runtime/harness/accepted-mutation-scope.ts) freezes scope from the **first proposed mutation**, not an independently accepted owner operation/target contract. Its input has no target identity; successful creation of one artifact can unlock edits to another of the same kind; any later steer-note event reopens scope without proving delivery/adoption or relevant requested changes; recording failure is swallowed while returning allowed. The observed duplicate-first refusal is useful narrower coverage, not proof that the final handoff's accepted-owner-scope requirement is complete. This is a source finding, not a claim of a new live unauthorized effect or the cause of the Sheet stalls. Preserve it in the scorecard and finish it without placing another planning ceremony in front of ordinary reads.

## Evidence and coordination

The review retained three exact-session event snapshots, the last accepted checkpoints for 144363/146042 and host refusal receipts in [review evidence](/Users/you/clementine-next/output/reviewer-monitor/c35-sheets-review-1320). The original reports are [Normal task2](/Users/you/clementine-next-live-iteration-31/output/candidate35-live/sheets/task2.out.json) and [Plan ten-account run](/Users/you/clementine-next-live-iteration-31/output/candidate35-live/sheets/plan10.out.json). Source/trace review establishes the findings; no new repository tests or live success is claimed.

The other implementation agent is not present in this Codex task inventory, so this brief is written for the owner to pass along and linked into the shared checkpoint. Keep the recurring reviewer monitor paused; implementation still owns the daemon and live qualification. Address these two concrete stopping paths as the next connected correction, then prove the requested job end to end.

## Broader owner-requested simplification

The owner asked which additional areas should be simplified after these failures. The [harness simplification brief](/Users/you/clementine-next/docs/checkpoints/2026-09-07-harness-simplification.md) sets seven connected areas: consistent execution/recovery state, reusable discovery/account bindings, typed repairable outcomes, retained working datasets, simpler model-facing carriers, productive continuation and measured model/context overhead. It preserves this brief’s two demonstrated stopping paths as the first priority.
