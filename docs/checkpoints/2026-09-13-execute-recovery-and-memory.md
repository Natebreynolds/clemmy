# Execute recovery, waiting plans and memory — 2026-09-13

## Installed follow-up — 2026-09-13 13:39 UTC

After the qualification below, the owner explicitly requested quitting and hotpatching Clementine. Clementine was quit normally, the frozen candidate installed with `hotpatch-tested-candidate.sh`, and the app reopened. Installed source fingerprint and full dist digest match candidate C exactly. New installed daemon PID 6767 owns listening port 8520. Backup: `/Applications/Clementine.app/Contents/Resources/daemon/dist.backup-YJDDNV`. Proof: `output/reviewer-monitor/2026-09-13-execute-recovery/installed-hotpatch.json`. No commit or tag was made. The connected-tool installed journey is still pending; the disposition below records the earlier pre-install qualification.

## Disposition

The candidate is ready for an **installed local hotpatch test**, not a release tag. No commit, push, tag, installed hotpatch, installed-app restart, or real business-account write was performed. The existing installed app/daemon at PID 48159 was left running. UI/Home work belongs to the other agent and was preserved.

The owner asked for fewer interruptions, useful planning that carries into Execute, and relevant memory whose influence and confirmation status are visible. This pass implements those refinements and follows failures through the final completion boundary, rather than accepting a successful tool call as proof that the whole task completed.

## What changed

1. **An approved task can correct its own native local file.** A newly recorded synthesis may revise the file written by that same approved step. It must retain the same accepted source, prepared `write_file` operation, destination and producer binding. The host preserves prior bytes and receipts and checks the observed preimage again under the file lock. An intervening edit prevents automatic replacement. This is not a retry grant for external sends, creates, arbitrary destinations or collections.

2. **Corrections reach final completion.** Every successful business crossing enters the resolution ledger, even when its requirement already earned progress credit. Previously the progress deduplicator also suppressed actual observations. Proven revision lineage identifies the current output for coverage and final verification, while the old writes remain in the ledger and immutable history. A missing replacement observation, changed producer, mismatched receipt, or corrupted retained preimage cannot remove an obligation. The latest output still requires ordinary current-content proof.

3. **A planned readback refreshes after its upstream file changes.** The earlier read stays historical; it cannot satisfy the new output generation. The replacement read retains its actual point-read contract instead of falling back to a collection/exhaustion requirement merely because the observation has a new ID. Clean unchanged reads still reuse retained work.

4. **Waiting is a resumable state.** An existing completion judge's `awaitingUser` result becomes `needs_input`, with the actual question, rather than `done`. A published `needs_input` plan behaves the same with completion review on or off. If a supposedly ready plan still needs a decision, the existing reviewer can request a readiness correction. There is no added review pass or approval stage.

5. **A question does not require an executable graph.** `publish_plan` accepts `full_text` with `readiness: needs_input` and no structured outline. The saved partial has no executable steps or bindings. The existing ready-revision requirement still prevents its execution. Answering continues planning. Ready plans still carry their prepared structure; this does not silently downgrade malformed executable plans.

6. **Memory and freshness remain distinct.** Relevant remembered preferences, skills and procedures can influence a plan. The plan should identify material memory influence, distinguish standing preferences from mutable facts and label unconfirmed assumptions. Approval does not verify those assumptions. New Execute observations supersede older observations for the same source/subject, including newly null or absent fields. The full approved method and destinations remain intact. No compulsory memory search or per-memory confirmation question was added.

7. **Content review checks claims, not just persistence.** The existing brain/judge instructions distinguish a matching file/readback from a supported conclusion. Material specificity and claimed certainty must agree with source evidence and adopted constraints; interpretations remain labeled. This is general guidance, not a currency rule, fixture vocabulary or another gate.

Changed-file inventory: `output/reviewer-monitor/2026-09-13-execute-recovery/candidate-files.txt`. Key owners are `reviewed-file-correction.ts`, `local-file-revision.ts`, `reviewed-plan-results.ts`, `expected-work-admission.ts`, `logical-call-settlement-store.ts`, `expected-work-observed-projector.ts`, `obligation-manifest.ts`, `bound-read-evidence-contract.ts`, `host-turn-runner.ts`, `loop.ts`, `publish-plan.ts`, `accepted-plan-execution.ts`, `objective-judge.ts`, and the orchestrator guidance.

## Failures retained, and what they proved

- Candidate A's adaptive live run: Opus rejected an invented currency unit. Clem corrected the same file successfully, then final publication blocked because the original receipt was no longer current. This proves live dispatch correction, **not completed recovery**. Its full assertion result remains failed.
- Extending repository tests through terminal preparation exposed the missing second operation in the resolution ledger. An intermediate apparent pass had skipped the obsolete write without proving that the replacement remained an obligation. The final tests explicitly require one current write obligation, both actual write observations, and refusal of invalid/missing replacement lineage.
- Candidate B completed its adaptive journey but invented an unsupported dollar sign; Opus missed it. The live result remains failed. That is why claim grounding was tightened.
- Candidate B's clarification cases reached resumable input state but wasted 116–193 seconds investigating and repairing a partial graph. The review-on test also failed its explicit-question assertion: the team question was implicit in blocker prose. Candidate C uses the partial-plan path and asks explicitly.
- Two preliminary standalone judge controls were invalid fixtures: one omitted the required `skills` context; the other inherited an empty role override and served the default Sonnet model. Neither qualifies Opus. The final control asserts the captured Opus selection before calling, records the served model, and passes. All attempts remain available.

## Repository verification

These are overlapping suites, not an additive unique test count:

- **67 passed:** revision lineage, full Plan → synthesis → correction → planned readback → SQLite reopen → terminal commit; settlement/progress separation; expected-work matching and observation projection; local file preimage protection.
- **578 passed:** host runner, conversation loop, resolution and obligation manifests, reviewed provider execution, and reviewed runtime. This includes the existing 50-draft fixture. It ran before the final partial-publication and claim-guidance edits.
- **11 passed:** follow-up read-contract and native Space Plan-read coverage after the observation-ID correction.
- **289 passed:** final partial publication plus host-runner coverage, including review on/off waiting and ready-to-needs-input repair.
- **121 passed:** objective judge and orchestrator regression coverage after the guidance changes.
- Candidate C compiled successfully; the build/source consistency check and `git diff --check` passed. No full repository suite was run.

Logs are retained under `output/reviewer-monitor/2026-09-13-execute-recovery/`. The isolated runner cannot certify that the installed home stayed unchanged while the independently running installed daemon writes there; it explicitly reports that limitation. The tests and live proof daemons use isolated homes.

## Final live evidence

Candidate C: Sonnet 5 brain, owner-selected Opus 5 completion judge when enabled.

| Journey | Accepted source | Time | Result |
| --- | --- | --- | --- |
| Relevant-memory Plan | 1 | 75.435 s | One accepted publication, five parent model requests, high Plan reasoning on the Claude wire, zero business writes, one accepted Opus completion review. |
| Execute changed record + missing reference + alternate source | 77 | 105.289 s | Eight parent model requests, one file write, fresh readback, one accepted Opus completion review; objective/reply/current artifact verification passed. No unsupported currency unit. |
| Partial Plan, review enabled | 1 | 23.682 s | Visible question, `needs_input`, resumable, zero business writes, no JSON repair detour. |
| Partial Plan, review disabled | 1 | 17.631 s | Visible question, `needs_input`, resumable, zero business writes and zero completion-judge calls. |

Reports: `live-c-memory-on/result.json`, `live-c-waiting-on/result.json`, `live-c-waiting-off/result.json` under the output directory above. Source sequences are scoped to the session in each report; they are not globally interchangeable.

Separate **controlled live judge calls** on Candidate C used supplied synthetic evidence, not a chat journey or real file receipts. Opus rejected unsupported specificity in 6.302 s, accepted the supported briefing in 5.060 s, and returned awaiting-user for the clarification in 2.167 s. All three retained exact owner-selected Opus provenance and no failed-open verdict. Report: `live-c-judge-controls-c/result.json`.

Candidate B additionally passed a review-disabled three-file Plan → Execute journey: Plan 104.018 s, Execute 33.272 s, three exact fresh writes, delegated Plan read, no completion-judge call. That is evidence for B, not an additional C live pass.

All proof daemons were stopped and their retained homes sanitized. These timings are individual observations, not a controlled benchmark or a latency guarantee.

## Candidate and next test

Qualified C source fingerprint: `22bd669e3ab6a8a4da266624674e54415956b3df09c6f61c9695401e723787e6`.

Qualified dist digest: `5ba4a5a16aefc8a4a544f2277654e5e8ccd2dea04f767df067873c0093dd2cc6`.

The built snapshot is `output/reviewer-monitor/2026-09-12-plan-review/four-refinements-verification/candidate-source`. It contains the pre-existing worktree snapshot plus this pass's owned files; it is not a new commit. Its backend build stayed fixed during live runs. `build-c-check.json` records the exact identity.

After quitting Clementine normally, run `output/reviewer-monitor/2026-09-13-execute-recovery/hotpatch-tested-candidate.sh`. It verifies both identities before installation, installs only this tested daemon build, retains rollback, preserves installed UI/authentication dependencies and reopens Clem. It has been staged and syntax-checked, **not run**. Do not substitute an older root `dist` build.

Next installed qualification: a fresh Plan for the original connected Google Doc + Apify/DataForSEO research request, then Execute that exact reviewed revision. Inspect relevance of memory, explicit assumptions, discovered nested tool inputs, current source evidence, useful progress, total latency and final content quality. That connected-provider journey has **not** been rerun here.

Limits to retain: the final live adaptive journey was a clean one-write run, not a forced post-judge correction; full corrected-revision completion is repository integration proof, supplemented by A's failed live correction and C's live judge controls. Prose still sometimes overstates an interpretation of the synthetic status token as malformed, even while preserving its literal value and labeling it unconfirmed elsewhere. Treat that as a writing-quality concern, not proof of source corruption. The evidence does not justify claiming universal task completion or a tag-ready release.
