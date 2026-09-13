# Plan continuation and discovery repair — 2026-09-13

> Combined checkpoint update: the owner has now authorized committing this harness together with the desktop/mobile UI work after successful compilation. See [the combined checkpoint](2026-09-13-combined-harness-ui-checkpoint.md) for build results and dev launch. Earlier candidate entries below retain their historical qualification limits.

> Current status (2026-09-13, candidate T frozen): Build, 618/618 focused isolated tests and hotpatch --check pass. The installer pins T and is ready for the next local test, not a release sign-off. R Claude completed Plan→Execute with a verified briefing after Opus correction, but retained original test failures, model argument repairs and nearly twelve-minute Plan latency. Q Grok Execute remains unexplained and unqualified; its stored access grant is expired. No app hotpatch, commit or tag has been applied.

## Status and ownership

This is the harness-only repair pass after the owner stopped the installed Grok + Opus Plan run. Nothing in this pass is committed, pushed, tagged, or installed. Existing UI/Home work remains owned by the other agent. The main checkout contains substantial earlier uncommitted work; the `before/` snapshots below distinguish this pass from that work.

The failed installed source is preserved through its cancelled terminal: session `sess-mob-f4374fb96657c874ac229dd3fc4ddaf6`, accepted source **199225**, terminal **200417**, **24m 7.7s**, **124 settled attempts**, no published plan, no business writes. See [the corrected installed-run analysis](2026-09-13-installed-grok-plan-review.md). Exact Google Doc create searches did materialize; the prior broad claim that they did not is withdrawn there.

Evidence root: `output/reviewer-monitor/2026-09-13-plan-continuation-fixes/`.

## Changes and why

1. **Tell the truth at an activation boundary.** `host-model-result-receipt.ts`, `next-edge.ts`, and `host-turn-runner.ts` preserve the host-authored `activation_budget` reason on an unstarted call. Its next action says to reuse the same arguments under a fresh call ID if still needed, preserving successful siblings. It no longer tells the model that valid arguments need repair. The raw result receipt remains canonical and validated on reopen. No production budget was increased.

2. **One charged attempt per logical call.** The live forced-continuation control reproduced double charging in wrapped local calls, refusals, and the accepted native MCP carrier. The host charged the model intent, then an inner wrapper charged it again. This could trip the ceiling inside an already-entered carrier and fail checkpoint commitment. `hostOwnsLogicalCallAccounting` checks the current host context plus exact source/call identity. Same-call transport mirrors retain that charge; another source, another call, or a genuine batch item does not. This changes accounting, not consent, capability, or provider authority. Owners: `brackets.ts`, `call-tool.ts`, `inner-dispatch.ts`, `accepted-mcp-carrier.ts`.

3. **Use the same configured discovery instance through either entry point.** A live Grok turn wrapped `tool_search` in `call_tool`. The direct tool knew its connected providers; the global tool reached by the wrapper returned `brokerCoverage: builtins_only`. Exact searches therefore returned unrelated built-ins despite a connected MCP server. `orchestrator.ts` now passes the turn's actual first-class local instances through `BuildCallToolOptions.localToolOverrides`; the shared inner dispatcher uses that same instance with the existing schema, reachability, and wrapper checks. An override never makes an excluded name reachable. This is a generic instance-ownership fix, not a provider or business-term rule.

4. **Keep exact discovery navigation through compaction.** `discovered-tool-context.ts` rebuilds a current-source map from settled `tool_search` results. It preserves exact names, capability references, account observations, blockers, and schema handles. The Plan model receives that map after history filtering on every step. All disclosed schemas, including inline ones, get durable content-addressed handles from the existing store. These are historical navigation hints, never new execution authority. They do not invent missing actor inputs or endpoint schemas. Raw results remain available. A regression fixture covers real settlements, history collapse, SQLite reopen, and exclusion of another source.

5. **Review new evidence without resending the full accumulated history.** Advisory trajectory checks carry authenticated handle/digest/outcome metadata for all retained reads, expand newly observed distinct content once per review window, and represent tool-search results as navigation rather than repeated schema dumps. Prior-window and duplicate content explicitly say they were not included in full. New API documentation remains intact; no semantic keyword filter or arbitrary task-fact clipping was added. The frontier and prior verdict are recovered by exact source and objective digest. Unavailable reasons are now recorded. Full completion review continues to receive its existing complete evidence view. This incremental advisory view is not a completion certificate; a prior unavailable window does not become reviewed evidence merely because its cursor advances.

6. **Keep prior work advisory and name its reader.** Prospective background-task context identifies `background_task_status` and does not impose an unrelated reconciliation prerequisite on a fresh read-only plan. `check_delegation` now reports missing/wrong identifiers as repairable argument failures instead of successful reads. Useful related memory stays available.

7. **Do not infer connector bans from pieces of their names.** A configured `Research Lab` made “do not perform the research yet” compile into a connector ban. `mcp-tool-scope.ts` now uses complete configured names and existing canonical aliases for access constraints. It no longer manufactures authority aliases from each component word. Tests also cover other generated names, explicit full-name exclusions, allow-only with an exception, and blanket connector refusal.

8. **Correct zero-retention compaction.** `slice(-0)` kept every completed pair when the caller requested zero retained pairs. The zero case now yields an empty retained set. Normal retention settings are unchanged.

## Test evidence

- The local accounting regression failed before its fix, then passed. Same-call native MCP execution is tested with the host counter already at its one-call ceiling; it performs one metadata probe and one business read, charging exactly one model intent.
- The configured-discovery regression failed before its fix, then passed. Its denied-name control proves that the configured instance does not bypass a turn exclusion.
- Candidate B's combined suite: **679 tests, 678 pass, 0 fail, 1 skip**. The subsequent configured-discovery/inner-dispatch/orchestrator subset passed **141/141**.
- Candidate C combined: **756 tests, 755 pass, 0 fail, 1 skip**.
- The subsequent malformed-work-carrier / host-runner / public-progress subset: **281 pass, 0 fail**. The new mixed-frame regression failed before the parser attestation and passed afterward. Do not add overlapping counts together.
- Candidate D combined: **693 tests, 692 pass, 0 fail, 1 skip**.
- Candidate E combined: **769 tests, 768 pass, 0 fail, 1 skip**. Exact file selection is in `candidate-e-test-files.json`. Build and diff whitespace checks passed.
- The isolated runner's real-home sentinel is **not performed** while the installed daemon owns that home. This is not a claim that the sentinel passed. Unit fixtures use isolated homes.

## Earlier frozen candidate C (failed live; do not install)

Candidate C directory: `output/reviewer-monitor/2026-09-13-plan-continuation-fixes/candidate-source-c`.

- HEAD: `2be6fa443c136580dccad413706a57c66e424a49`, dirty snapshot.
- Source fingerprint: `5d947a0fae1a8cd6ae826b737e05f15cd49092b8cc4e01a7c3bca0e3f0bbb3c5`.
- Dist digest: `737cee1540b8afa4b8f16ad036ebb6ee42af8d4163beeb487b0c09e4f3078892`.
- Schema version: **81**.
- `candidate-c-build.json`, `candidate-c-files.json`, and `build-c.log` record the build.

## Live qualification and limitations

The isolated fixture uses real Grok 4.6 model calls against a local MCP research service: a source brief, an actor-specific contract, substantial API documentation, and a future local briefing. Its eight-call activation setting deliberately forces continuation for the test; it is not a production cap change. There are no customer-account reads, emails, or business writes in the fixture. Any Execute writes are confined to its disposable local workspace.

Earlier failed legs are retained:

- `live-off-missing-backend/`: the proof home copied model selection but omitted xAI's credential. It failed before a model response. The driver now uses an access-only snapshot of the currently valid xAI grant; it never copies or refreshes the production refresh token.
- `live-off/`: the forced boundary reproduced the nested double-charge/checkpoint failure. The reviewer stopped this isolated daemon after preserving the failure. It is not a completed Plan.
- `live-b-off/`: continuation worked, but generic wrapped discovery could not reach the connected provider. Stopped after identifying that defect. This driver disabled completion review but mistakenly left the separately controlled trajectory watcher enabled; its unavailable watcher events are not proof of “all review off,” and no Opus response was served.
- `live-c-off/`: failed after **701.4s**, terminal `exact_checkpoint_admission_exhausted`, no Plan. Both review features were off. Connected discovery and the budget continuation worked. A model stream then hit the existing **600s mid-response silence watchdog**; the model subsequently returned more calls. One `work_call` omitted `args_json`, and the missing local parser proof let its unknown effect poison the entire accepted source (`host effect violation: unknown`). Concurrent healthy reads could no longer settle. The malformed-envelope integration control reproduced this causal chain. The home was stopped and sanitized with its DB and forensic log retained; no customer business operations were called.
- `live-d-off/`: reviewer-cancelled after **470.6s** during a prolonged model request. It stopped cleanly, produced a cancelled terminal, and the proof home was sanitized and retained. This is not a completed Plan. The candidate D heartbeat field did not reach the parent across the shallow-copied physical context; see the E correction below.

**Opus live qualification remains pending.** The access-only Claude seeder cannot obtain a token covering the test window. The owner has been asked to sign back into Claude. No refresh grant is copied into a proof home or rotated from a competing process. This does not prove that installed Claude is broken, and these fixes do not change Claude authentication dependencies.

The synthetic connected-tool fixture is narrower than the original installed Google Docs/Apify/DataForSEO journey with existing memory and account state. A pass here still requires repeating that installed journey after hotpatch before making broader release claims.


## Candidate D additions

9. **A schema error is local to its call.** `work-call.ts` now registers the same exact SDK-parser invalidity proof used by `call_tool`. Only inputs rejected by that exact parser qualify; a valid input or replaced/copied invoke cannot use it to acquire execution authority. Missing `args_json` returns a repairable refusal without entering the effect body or poisoning healthy parallel reads. The new mixed-frame integration fixture completes, reopens SQLite, redeems the refusal and successful sibling, proves zero crossings for the malformed call, and keeps the accepted source usable. No conflicted source is reopened by fiat.

10. **Pending-model status survives its own heartbeat.** The old status check compared only the newest event with `prompt_composition`. Its own heartbeat immediately made that comparison false, so it reported “no change” while a request was outstanding. `host-turn-runner.ts` now owns an in-flight count in the active context and clears it in `finally`; both fresh and resumed heartbeat callers read that fact. The text says it is awaiting the model response, which does not claim the model is doing useful work. Tests cover subsequent heartbeats, request completion, and rejected requests. This is liveness metadata, not a new gate, progress credit, or raw reasoning disclosure.

11. **Correct inventory guidance.** `mcp-status-tools.ts` no longer tells every native MCP caller to use `call_tool`, which the action control surface cannot use for external MCP tools. It points to the exact invocation contract already discovered, or an exact-name discovery when missing. Large-schema guidance also stops recommending a deliberate validation failure.

Candidate D: `output/reviewer-monitor/2026-09-13-plan-continuation-fixes/candidate-source-d`.

- Source fingerprint: `636060b5ca671acb5ed835db456f5bcd57a61973642e60ccfcbfa5deceb17730`.
- Dist digest: `ba13b3b841f82bfac3bd07a8ead4cca97d3d14f8c25feafdfe2203974b95ac4a`.
- HEAD remains `2be6fa44`, dirty snapshot, schema **81**.
- Build passed. `candidate-d-build.json` pins it; `candidate-d-files.json` records copied paths; `candidate-d-test-files.json` records the exact combined test selection.
- Nothing in this pass has been installed or committed. Installed daemon PID 6767 was left alone throughout these proof runs.


## Candidate E — failed Execute qualification

Candidate E retains D's functional fixes and corrects propagation of its model-request liveness state. The counter now lives in a shared object initialized at the run-context boundary, so shallow-copied physical attempts and the outer heartbeat observe the same pending request. It still clears in `finally` on either completion or rejection.

The initial liveness fixture accidentally swallowed its inside-model assertion through `Promise.allSettled`. It was tightened to assert the observed parent state **after** the call. That corrected regression failed on D (`0` seen while the request was active), then passed on E (`1` during the call, `0` afterward). The resulting host/brackets/public-progress subset passed **386/386** before the combined E suite above.

- Directory: `output/reviewer-monitor/2026-09-13-plan-continuation-fixes/candidate-source-e`.
- Source fingerprint: `4340c3fb6bf3494220af14ef891ca49964f779830205e12972ec8284b63f45bf`.
- Dist digest: `9879ecf27db5b30b21f52c450499c61bbfede64e20da2c1485371a2de1f67d47`.
- HEAD `2be6fa44`, dirty snapshot, schema **81**.
- `live-e-off/` uses the same fixture with reviews off and eight-call activation stress. A proof-only fetch observer forwards response chunks unchanged and records timing, status and byte/character counts. It never records request bodies, credentials, or model reasoning text. This observer is not part of the hotpatch.
- **Plan passed in 208.8 seconds (3m 29s)**, with one published ready revision, both reviews off, full nested contracts and the relevant owner preference in its text. The independent provider-log check confirms only brief/contract reads before Execute. Automatic activation continuation worked.
- **Exact Execute failed after 183.1 seconds**, with no research operation or file write. Twice `plan_task` rejected the host-generated graph with `dag_kind_mismatch`: the native reads produce `result`, while the file writer accepts `evidence|artifact_content`. The reviewed compute step was correctly retained in the outline and its output binding; the tool-only projection flattened its ordering ancestors, and the validator incorrectly type-checked `dependsOn` as raw data flow. Clem ultimately asked the owner to revise the graph. This is a host defect, not a missing user decision. Calling the published plan “executable” before activation was proven was premature. Candidate E is not qualified for installation. The isolated daemon stopped and its home was sanitized with the failure retained.
- The provider fixture logs operation identity as `name`; the initial driver's pre-approval check used `tool`. That was corrected in the saved driver after launch. The running E process still has the old check, so the reviewer must independently verify the Plan interval against the `name` field before claiming no premature research. The raw provider log and source event boundaries are preserved for that check.

One deferred telemetry distinction: automatic continuation intentionally skips another automatic memory-primer lookup while retaining prior context, but reports the same `explicit_request_opt_out` reason as an owner memory restriction. This is misleading attribution, not evidence that the owner forbade memory or that explicit memory tools are unavailable. No recall-policy change was made for it in this pass.


## Candidate F correction — ordering versus payload lineage

`turn-semantic-proposal.ts` now type-checks `dataFrom` when a canonical explicit topology is present. `dependsOn` continues to require successful prerequisites and undergoes the existing unknown-node/cycle checks. Legacy proposals with no topology keep their prior check. No capability descriptor, effect, account or provider schema is widened. The immutable reviewed outline still enforces the compute output and exact `/content` binding at dispatch. Kind mismatch diagnostics now preserve required ordering instead of instructing Clem to remove it.

The discriminating semantic regression failed on the old code with the same `result`→`artifact_content` mismatch, then passed. Its direct-data-transfer negative and absent-prerequisite negative remain rejected. The semantic/publication/exact-Execute subset passed **77/77**; the native MCP → synthesis → local file → readback activation/reopen fixture passed in the **30/30** carrier suite. Its first two attempts had fixture defects (missing logical-call frame, then mismatched accepted-source prompt), corrected by using the real host runner and exact accepted Execute text. These were not production fixes.

The frozen F combined suite passed **905 tests: 904 pass, 0 fail, 1 skip**, across the 28 explicit existing files in `candidate-f-test-files.json`. Build and `hotpatch-daemon.mjs --check` pass; this check means the build is internally consistent, not live-qualified yet.

- Directory: `candidate-source-f` under the evidence root.
- Source fingerprint: `ef6bdc60e555adf416f4f45a306ee71053d1a25e3104309eb5c98fd36106bd8e`.
- Dist digest: `1c9e15a7a1f9adefb3dd47a18f868ffc82b6c8ed3805e7cf207944c1270d1909`.
- HEAD `2be6fa44`, dirty snapshot, schema **81**.
- `live-f-off/` uses real Grok 4.6 with both review switches off; its failed outcome is recorded below. Execute assertions require one actor research call, one metric call, one successful file write, no refused Execute attempts, a synthesis step, a real served Grok response, and a done terminal. File quality still requires reading the artifact; these assertions alone do not certify its prose.


## Candidate F live result and G correction

F Plan passed in **187.1 seconds**, reading the brief and nested contracts with no research or write before approval. Exact Execute activated the original revision successfully on its first `plan_task`. It then failed at the next edge: three valid native MCP `work_call` reads were refused before provider I/O with “exact accepted work/consent admission is missing, consumed, or mismatched.” No actor research, metrics or local write ran. Two attempted synthesis placeholders were rejected because the required reads had not succeeded. The reviewer cancelled this isolated Execute at **286.0 seconds**; the cancelled terminal, DB, provider log and sanitized home are retained in `live-f-off/`. This is a failed qualification, not a pass.

The native carrier required a one-shot mutation-consent token for every `work_call`, while the host issues that token only for mutations. G limits that requirement to non-read manifests. Reads retain the exact accepted call, durable host binding, current manifest/catalog/schema/port and final provider revalidation; the real `work_call` still admits the frozen requirement and arguments. The integration control now enters that actual carrier after Plan publication, SQLite reopen and graph activation, proving a successful read with precisely one metadata probe and one business crossing. It failed with the same live refusal before the fix.

The mutation negative control uncovered a second identity mismatch: the shared native carrier used a read-only planning-definition reader even for a write. The definition validation was factored into an effect-neutral identity reader. The read-planning wrapper retains its `effect === read` condition, so this does not grant write authority through read discovery. A current native write now reaches the intended missing-consent refusal before any metadata or business I/O. Its test also proves the write is still excluded from read-planning authority. No send/destructive consent was relaxed.

G focused tests: **35/35** native carrier tests, plus the earlier **41/41** read and consent subset. Counts overlap. A nonexistent `live-read-planning-authority.test.ts` argument was ignored by that runner; it is not claimed as coverage. Final G selection will assert every path exists. G combined qualification passed **917 tests: 916 pass, 0 fail, 1 skip**, across 31 explicitly verified existing files (`candidate-g-test-files.json`). Build passed.

- Frozen directory: `candidate-source-g`.
- Source fingerprint: `33e6a711c46e2244ac958b9d78dcff203012afbd1d90522859dfc50d0d6344b7`.
- Dist digest: `324e5cda06404a803bfc495dd169b2ed6a31590a1a0d6465d1227213c65d2b56`.
- HEAD remains `2be6fa44`, dirty snapshot, schema81.
- `live-g-off/` is running the full Grok Plan → exact Execute control. Its result is pending; nothing has been installed or committed.

G progress at 2026-09-13 16:03 UTC: Plan passed in **237.8s (3m 58s)**, six served Grok responses, eleven settled logical calls, and one automatic activation continuation at the test-only eight-call boundary. It used high effort before and after continuation. Provider calls before approval were exactly `read_brief`, `actor_definition`, and `api_reference`, once each. Memory preference was explicitly carried into the plan. Execute activated that exact revision on its first attempt, performed `actor_run` and `api_request` once each successfully, and recorded the full synthesis. The subsequent model request is still pending, with only stream keepalives arriving after its initial output; there is no save or completed Execute proof yet. The heartbeat correctly says it is awaiting the model response. Do not confuse correct continuation/hand-off with latency qualification.

The frozen G daemon-only installer passed its five isolated staging/rollback tests and its read-only source/dist consistency check. Nothing was applied to the installed app. Those checks are separate from live qualification.

## G final result and H interruption repair

G Execute ended **blocked at 694.9s**, before the fixture's 720s deadline. There was no write or readback. The response stream emitted its save preamble and then only keepalives for approximately ten minutes. The existing host silence watchdog retired that request; the compatibility adapter then returned its partial preamble as a completed response. That produced an ordinary `run_completed` followed by the delivery validator's `verification_required` hold. The validator correctly refused to certify a nonexistent file, but its final text still promised the future save instead of naming the interrupted model request. This is not a completed Execute, nor merely a provider-only problem. `live-g-off/` retains the raw events, timings, four successful settlements, and the recorded synthesis as `retained-synthesis-not-delivered.md`. The isolated daemon stopped and was sanitized. There were zero tool refusals and exactly one of each intended research read; those specific handoff fixes held.

H changes the transport and host-frame handoff, not business authority:

- The fallback boundary checks each attempt's own abort signal before returning a buffered response or yielding another stream event. A synthetic completion from a retired attempt cannot escape. A typed host deadline also survives an adapter's generic abort error.
- The one-step model adapter rejects a response from an aborted request. A completed fallback rescue can carry a private, exact-signal association from the fallback boundary, so the original aborted signal does not incorrectly kill its healthy rescue. Provider payloads cannot manufacture that association.
- The host retries an interrupted streamed model frame from its accepted history using the existing model-stall retry setting. Partial text and partial tool intents never entered history or dispatch, so a mid-stream interruption does not justify dropping the whole task. Already settled tool work remains complete. Outstanding buffered paid requests keep their existing non-replayable treatment. No timeout or production retry cap was raised.

Four new controls failed before the fix: two adapters returned partial completions after retirement, and two host controls admitted the retired frame's tool call. After the correction, the focused **412/412** suite passes, including retry disabled, one retry with exactly one subsequent write, no repeated prior read, no partial response in history, legitimate fallback rescue, and owner cancellation. The first implementation incorrectly rejected an existing unscoped rescue test; that failure is preserved in `h-green.log`, and the exact-signal response association corrects it. H combined qualification passed **1,056 tests: 1,055 pass, 0 fail, 1 skip**, in the 34 explicitly verified existing files listed in `candidate-h-test-files.json`. Build and read-only installer consistency check passed. The H fixture allows 30 minutes per mode so a genuine model-stall recovery can finish; this is a test observation window, not a production setting or latency pass criterion.

Frozen H identity:

- Directory: `candidate-source-h` under the evidence root; HEAD `2be6fa44`, dirty snapshot, schema81.
- Source fingerprint: `dbefc431df3cec7aa84c2b58b3f9384771aeb7840d7eb1885c0cbca67b0a639c`.
- Dist digest: `c1329c2661b1f7707a2aaf12e09dc3cc1829928e73f461753a1dac96c3828453`.
- First H live: `live-h-off/`, session `sess-desktop-1687f67890029c50ddbe6616`. Plan passed in **176.6s**, with one repaired publication/other-call batching refusal. The proof driver then refused to submit Execute because its disposable volume had 1.7GiB free, below its existing 2GiB reserve. No Execute source was accepted. The daemon stopped and its home was sanitized; this is a test-environment interruption, not an Execute failure or pass.
- Removed only `runtime/uv-cache` directories from this pass's stopped, sanitized C/D/G/H proof homes, preserving all databases, plans, receipts and logs. Available space rose to 2.8GiB before rerun, 2.5GiB after provisioning.
- Same frozen H build rerun: `live-h2-off/`, session `sess-desktop-d842a1c881a83cef0a8a85bb`; currently pending, reviews disabled. No Opus result is claimed.


## H2 live recovery and I presentation correction

H2 Plan passed in **247.0s**, six served Grok responses, fifteen settled calls, one automatic eight-call continuation, no pre-approval research or write. Its exact Execute revision activated on the first attempt and performed both research operations once, then recorded synthesis. The next model stream emitted a short save preamble but no tool arguments and kept sending keepalives. At **16:40:52 UTC**, H rejected that interrupted frame and issued `model_stall_retry` (`preContent:false`, `rejectedFrameExecuted:false`). This is live proof of the corrected interruption/retry boundary, not yet proof of a delivered artifact. The run remains pending.

The exact persisted model request was reopened through `projectModelRequestProvenance` successfully. Its catalog exposed a separate contradiction: `plan_step_result` correctly described reviewed model-authored synthesis and host-filled dynamic bindings, but the generic `work_call` description said model-authored content must never be a compute operation. The approved plan's own synthesis path was legal; its advice disagreed. That is a confirmed presentation defect, **not an isolated explanation of the provider stream stall**.

I keeps all H transport/authority fixes and corrects that presentation:

- The host-planned carrier explains the reviewed `plan_step_result` path and tells the model to omit arguments the host fills from retained output. Ordinary direct work still composes its content in the consuming write. The legacy proposal carrier retains its own actual compute limitation.
- The current proposal-free frozen carrier no longer instructs `proposal:null`, which its strict schema rejects; the legacy schema's instruction is unchanged.
- Disclosed capability references are described as direct-call identifiers. An activated plan uses its exact frozen requirement ids.

The actual Plan → reopen → synthesis → bound write integration fixtures now check the real Execute tool description as well as the existing dispatch/bytes behavior. Frozen and legacy carrier tests prove their descriptions match their different schemas. Main focused tests **19/19**; the frozen I selection including installer staging/rollback tests **24/24**. I changes descriptions only relative to H's previously passing 1,055/1,056 (one skip) suite; overlapping counts are not additive. Build, diff whitespace, and read-only installer source/dist consistency checks passed.

- Frozen directory: `candidate-source-i`.
- Source fingerprint: `3ea02a640adefd49122a50cf23b5dd22eb4123e8549d95f79e49d0ef4e5c5167`.
- Dist digest: `9812537c4da49efb30ff84968393ccf883a2bed6862bf84c9f1d79ccd2fe58c1`.
- HEAD remains `2be6fa44`, dirty snapshot, schema81.
- `before-i/` preserves the prior files. `candidate-i-build.json` and `candidate-i-files.json` identify the candidate.
- Fresh same-fixture I run: `live-i-off/`, session `sess-desktop-3fb31601c9d2bdf159dc4344`, both reviews off. Pending.
- Removed only download caches from this pass's stopped/sanitized B, initial, and missing-backend proof homes to make space. Their evidence remains.

Installed app and main package manifests both specify the same Claude/Agents dependency versions, package3.18.5. No authentication dependency was changed or installed. This does not substitute for a served Claude/Opus live test, which remains pending owner sign-in. The installed daemon and original stopped source remain untouched.


## H2 and I final failures; J definition comparison

H2 Execute ended **failed at792.7s** after the one real `model_stall_retry`. Its second stream again stopped after a short preamble with no tool arguments. The terminal was generic and omitted the underlying error; no `run_failed` row or full exception survived in the retained forensic log. The precise final failure cause remains unproven. No research was repeated, no write occurred, and no false completed model frame was admitted. All three delivery assertions failed. This is recovery-attempt proof only, not successful recovery or acceptable latency. `live-h2-off/` and the sanitized stopped home are preserved.

I Plan passed **156.1s**. Its Execute failed **121.3s** later: both prepared research reads encountered `native MCP preparation refused: live definition drifted` at the metadata probe, before either research operation ran. Rediscovery eventually ended `catalog_snapshot_identity_mismatch`. No artifact or write. This uncovered an order-sensitive `JSON.stringify` equality for provider-definition objects. The corrected control reorders only the definition's outer properties, proves the manifest digest remains identical, then exercises the actual preparation probe: both read and write cases fail with the same live drift refusal on the old comparison. J compares those already validated closed objects canonically; real field changes remain mismatches. It does **not** change the persisted manifest hash dialect, provider schema, effect, consent, account, or invoke port.

The first ordering fixture also reordered nested behavior hints and incorrectly assumed the existing manifest digest would be unchanged. Both its red and first green runs failed at that assumption rather than the intended preparation edge. Those logs are retained (`j-order-red.log`, `j-green.log`); they do not prove the drift regression. `j-order-red-corrected.log` is the discriminating before-fix result at `prepareProductionMcpInvocation` for both read and write. The production hash dialect is deliberately left unchanged; migrating nested-hint serialization is separate work, not part of this repair.

At approximately16:49UTC the access-only Claude check succeeded via the current Claude Code credential, expiry23:39UTC. No refresh token was copied or rotated. Opus qualification is now runnable, but no accepted judge response is claimed until the next live run proves it.


J final frozen build: source `2f7bfa8087cbedecc374136f84b5cdaa2ca32aad2af562de285bd5906b9f327b`, dist `e40973b5262084b06298cd08535350865fee81cb1c2e2462006a20c8de76213f`, HEAD2be6fa44dirty, schema81. The corrected focused suite passed **54/54**; combined frozen selection passed **1,066 tests:1,065pass,0fail,1skip** across36verified files. Build and pinned daemon-only installer `--check` passed. `hotpatch-plan-continuation.sh` pins both fingerprints and is prepared but not applied. The real-home sentinel remains not performed while installedPID6767owns the home.

Live qualification still pending: `live-j-off/` runs Grok4.6 without either review feature. At16:54UTC another model stream paused after a brief preamble during Plan, before the nested contract reads. This disproves any claim that the stream-silence pattern is specific to the save transition or solely explained by its corrected compute instruction. `live-j-claude-on/` independently runs the identical local fixture using configured Sonnet5brain and owner-selected Opus5review, now that an access-only credential is available. This is same-provider review qualification; it cannot stand in for a served Grok+Opus pair. Concurrent proof homes have separate databases, destinations, and provider logs; overlapping latency is not a controlled performance comparison.


## J Claude failure and K/L corrections (current candidate)

J Sonnet5 + owner-selected Opus5 completed Plan with **awaiting input after622.5s**, without a published plan, research or write. This is a failed qualification, preserved in `live-j-claude-on/`. It served20Sonnet responses and12Opus responses. Three completion reviews returned corrections (events232,241,250), in addition to trajectory reviews. Opus correctly rejected price-absence claims based only on root pages and then rejected guessed pricing/subpage URLs. Two other findings were wrong: it read the host-derived tool-only `executionDraft` as the full graph, so it repeatedly declared a retained synthesis step missing; it also demanded directory creation even though `write_file` already creates missing parents. The no-progress reducer then counted three host-requested review revisions as zero-gain plan attempts and stopped at event255 (`control_no_progress_exhausted`). This was a harness-directed stop, not the model independently abandoning the work.

K fixes the second discovery path missed by J. The shared live-read materializer still compared external-definition objects with order-sensitive JSON equality, and only reused a current base ID, ignoring its current reacquired replacement. New production-MCP controls fail before the correction for reordered identity metadata and repeated discovery after a retired base ID, then pass through SQLite reopen and an actual read crossing. Canonical comparison changes equality only, not the persisted hash dialect. Reuse searches only current same-scope manifests matching the complete attested identity; retired references stay retired. Focused native materializer/carrier selection **43/43** passed (`k-green.log`).

L makes reviewer feedback and host progress agree:

- The Plan review context names `structuredPlan.steps` and its dynamic bindings as the complete reviewed graph. It explains the tool-only `executionDraft` projection, so an intentional compiler representation is not mistaken for a missing synthesis dependency.
- Prepared local bindings carry the actual configured tool description alongside the exact schema. `write_file` describes its existing automatic parent-directory creation; no new tool, permission, or filesystem effect was added.
- A real host-accepted completion-review repair is journaled with its existing exact plan/objective digests. New diagnostic evidence counts as progress. Repeated identical findings, changing only a draft/event/call ID, failed-open reviews, malformed identities and other accepted sources do not. The cumulative diagnostic identity survives reopen. This removes incorrect retry charging; it does not raise the generic retry limit or turn model prose into tool authority.

The first L green attempt exposed two incomplete wires: the projection's event-type filter did not yet read judgment events, and the configured local tool projection dropped descriptions. Those failures remain in `l-green.log`. Both paths are now wired; the focused selection passed **366/366** (`l-green-2.log`). Unit counts overlap the combined selection. The real-home sentinel was not performed while installedPID6767 owned the live home; isolated tests are not a sentinel proof.

Frozen L source **84ee44ea64ec9b18eef74dccca3c8d8e6c04d91e7674d9cea99d6a6931efd66a**, dist **2fc8f8531be44d9336248d0a653c28e98feb2ce3ceea5e7def14a98290fde33e**, HEAD2be6fa44dirty, schema81. `candidate-source-l/`, `candidate-l-build.json` and `candidate-l-files.json` identify it. Build passed. The combined40-file qualification and fresh `live-l-claude-on/` Plan→Execute test are pending. No installed files changed and no commit/tag was made.

The L proof corrects an over-specific test assertion before execution: the owner request did not require one actor batch. One reviewed batch of three URLs and a reviewed three-member fanout are both valid. The driver now checks each approved vendor URL is fetched exactly once, one comparative-metric read, one successful file write, no refused Execute attempt, and a verified owner-selected Opus completion verdict. The previous J failure remains unchanged and did not reach Execute. This assertion change does not credit its failed Plan.

L combined frozen qualification completed: **1,153 tests,1,152pass,0fail,1skip**,40verified files,56.0s (`qualification-l-tests.log`). The pinned installer now targets L and its read-only check passed. New local live session `sess-desktop-42f6328dda993b99334a2f98` in `live-l-claude-on/` is still pending. These facts do not yet establish a completed Plan→Execute journey.

J Grok review-off final: Plan blocked after **1,273.6s**, two interrupted response streams, one existing `model_stall_retry`, no published plan and no research/write. Unlike G's partial-completion defect, the final outcome is truthfully `model_stalled`, resumable, with retained work and no claim of completion. Wire evidence shows keepalives without tool arguments; this does not establish the upstream cause of the repeated stalls. `live-j-off/` and the stopped/sanitized proof home remain preserved. Grok latency and successful Plan→Execute qualification remain open.


## L phase-boundary failure and M correction (latest frozen candidate)

L Plan did not qualify. The first completion finding at121 was correctly stamped `planReviewRepair:true`; the following governor event125 credited new evidence and reset no-progress attempts to0. The reviewed graph and local directory behavior were no longer incorrectly rejected. But while repairing the plan, the model performed an API target probe and two actor fetches (including guessed subpages) despite the owner prompt explicitly deferring business research until Execute. The reviewer cancelled only this isolated proof; `live-l-claude-on/reviewer-stop.json` records the cancellation, and its failed result/events remain intact. This is live progress-accounting proof, not a Plan boundary or Execute pass. No file write occurred.

M makes the retained feedback phase-aware. Plan publication corrections keep `phase:plan` in the same source-bound, digest-validated recovery state. The feedback explicitly asks for revising methods, dependencies, preparation and verification; a review cannot authorize owner-deferred work. The judge context likewise preserves the deferred-work boundary and does not treat an empty or irrelevant memory search as a prerequisite. Relevant remembered assumptions still need disclosure. This adds no tool gate or lexical task classifier and does not make all planning reads forbidden. It is model guidance; a live test must still demonstrate compliance.

The host-runner suite passed **275/275** on M. The initial M test failed only because its assertion searched an escaped request JSON string for unescaped inner JSON. It now parses the actual retained feedback message and checks `phase:plan`; that initial failure is retained in `m-tests.log`, followed by `m-tests-2.log`. L's40-file combined suite remains1,152pass/1skip; those counts are not additive, and M's changes are isolated to host feedback/context and its tests. M build passed.

Frozen M: source **0e4140026b8de5a16a8d857416506e99573bb966f391a99307961277cee1c457**, dist **62ac81a117da075402755632646726992e8ff3f3e49c7fb9bc32e6accea80cf4**, HEAD2be6fa44dirty, schema81. Directory `candidate-source-m/`; identity in `candidate-m-build.json`. Fresh Sonnet5 + Opus5 live qualification `live-m-claude-on/` is pending. Installed app remains untouched. Removed only download caches from the stopped, sanitized J-off/J-Claude/L-Claude proof homes to meet the isolated driver's disk reserve; all evidence remains.


## M live Plan pass, Execute admission failure; N fix

M Plan passed at462.6s with Sonnet5 and owner-selected Opus5: metadata/contract inspection only, no deferred business research or write, and an accepted completion verdict verified at publication. It still took multiple plan repairs and nearly eight minutes, so this is functional Plan proof rather than premium latency. The separate Execute source208 failed at19.1s before research or writing: the host itself compiled154-character reacquired capability references into a semantic schema capped at128. Three identical plan_task attempts could not repair a host-authored ID. All M evidence remains in live-m-claude-on/result.json; the stopped home was sanitized and retained.

The earlier catalog regression tested host catalog acceptance alone; the submitted proposal, grounding descriptor and grounding verdict still used the stale128 bound. N uses the existing shared work-ID schema for those catalog references and the same shared pattern for catalog validation. It does not broaden semantic labels, skip exact catalog membership or change authority. New controls exercise154-character reacquired references and the shared512-character boundary, reject unissued/invalid references, and reproduce the actual native MCP Plan → reopen → activation failure before the fix. n-red.log and n-integration-red.log are the discriminating failures; n-green.log passes92/92 across the four focused files. The integration control uses a real host-minted reacquired MCP ID. Installed app remains untouched; N build/live pending.

N frozen source **96a61eba3e2cc1b244a87423e067261bb6ed96b2e9bef2bca5b25a21f4910955**, dist **2665e0ff95e2caa6f4225d20138b2b7fdcf442d550fee503973cd86c34adf400**, HEAD2be6fa44dirty, schema81. Build and pinned installer --check passed. Seven-file frozen qualification passed **125/125** (`qualification-n-tests.log`); includes actual reviewed provider/collection journeys and strict schema conversion. This overlaps the focused count. The real-home sentinel remains not performed with installedPID6767 active. Live session `sess-desktop-fbd3521203ad54e779afff1b` is running in `live-n-claude-on/`. No application files, commits or tags changed.


## N Plan passed; mixed-discovery Execute refused; O in progress

N Plan passed at526.6s, with one accepted Opus verdict following two negative completion reviews. No deferred research was performed. This remains slow and required nested-argument repairs, so it is not a latency qualification. Execute source243 activated the exact reviewed plan on its first plan_task; the128-character mismatch is live-fixed. The brief re-read and comparative API read ultimately succeeded, but all vendor-page calls were refused with the generic reviewed-call identity message. The reviewer cancelled this isolated Execute after101.6s; no briefing/write occurred. `live-n-claude-on/reviewer-stop.json` records cancellation. The failed report is retained and is not repaired into a pass.

Root: objective discovery and exact MCP discovery left two current manifests for the same operation/account/schema. The host call selector ignored the capability already named by the approved step and rejected name-only multiplicity. N's retained actor manifests differ in ID, purpose and provenance; they are not interchangeable authorities. O retains the exact reviewed selection when resolving the call, rather than collapsing manifests, reviving a revoked reference or asking the model to change approved arguments. Exact account/schema/effect/port and final reviewed-call checks remain. The first mixed-discovery control (`o-mixed-red.log`) passed because it restored only one transport after reopen and did not reproduce the live condition. `o-mixed-reopen-red.log` restores both current transports after reopen and fails both mixed cases. The selection fix passes those controls (`o-mixed-green.log`).

O also exposes the existing deterministic host binding failure reason where a missing attestation previously became a generic argument mismatch. Nested argument preparation now names the failing parent, bound leaf or exact schema-failure pointers. These messages contain no argument values. No preparation rule, business-operation limit or approval gate was added. Combined O tests/build/live still pending.

O focused combined suite passed330/330. Additional collection controls carry the mixed-discovery identity through a reviewed forEach member and assert the exact approved capability owns dispatch; revoking that identity immediately before the read proves the host neither substitutes its unreviewed current sibling nor crosses the provider. All38 native-carrier controls pass (`o-collection-and-retirement.log`). The first O build failed TypeScript because preparedBindings is generic Plan JSON, not statically an array. This is a build failure, not a runtime proof; adding an explicit array/record guard fixes that access. Candidate O was not served before this correction.

O frozen source **28a98928ec6c4c13278cfb8baf1cb4dc41192191d8a88aa17571bc1fa7240d2d**, dist **496665efbf801b85323573ba188873b8896e3e747faf0cc8d3274a04b9f3f929**, HEAD2be6fa44dirty, schema81. Build-o-2 and pinned installer --check passed. Eleven-file combined selection **426/426** passed; after the explicit array/record guard, host-runner and native-carrier selection **313/313** passed on the final frozen bytes. These counts overlap and are not additive. Live `live-o-claude-on/` is pending. All earlier evidence remains intact.


## Candidate O final ruling and P repair

O is **not qualified**. Its source fingerprint was `28a98928ec6c4c13278cfb8baf1cb4dc41192191d8a88aa17571bc1fa7240d2d`, dist `496665efbf801b85323573ba188873b8896e3e747faf0cc8d3274a04b9f3f929`. Sonnet5 with owner-selected Opus5 completed Plan in 352.7s. Execute took 331.7s, wrote a briefing and corrected it after Opus feedback, but ended blocked. The driver truthfully failed: no done terminal; duplicate research; two file writes instead of one; no verified terminal review reference. See `live-o-claude-on/result.json` and the full events.

The source was Execute 215 in `sess-desktop-d8ed489137fc8df60e01db91`. The three initial reads were submitted together: brief, vendor pages and comparative metrics. The approved graph made the latter two depend on the brief. The scheduler classified all as parallel reads, so the dependent calls used the existing safe-read fallback before their prerequisite settled. Their successful results were durable, but lacked expected-work bindings. The synthesis reader consumes those exact bindings, so it asked for the already successful research again. **This is a host scheduling defect; the provider reads succeeded.** P orders calls inside an existing read wave by the existing approved graph, regardless of model call order, and leaves independent children parallel. It retains effect barriers, original result pairing and failure draining. It adds no owner approval or business classification. Legacy unbound settlements from already failed runs are not retroactively relabeled as graph-bound proof.

The terminal error was separate: `durable record count does not match the raw collection`. Native MCP retained its three business records inside one JSON text block at `result.content.0.text`. Handle creation already parsed that shape correctly; evidence receipt issuance used a separate plain-property reader that could not follow the array/text boundary. P removes that duplicate parser and uses the existing `recordsAtRecordPath` shared with result handles and universe sealing. Counts, digests, unknown completeness and continuation checks remain recorded. The existing finite-returned-set rule for unknown completeness is unchanged; this pass does not newly certify exhaustive source coverage.

Opus actually steered O's content: completion verdict 395 rejected unsupported service-model specificity and an invented definition of mention counts. The corrected file passed verdict 416. Two writes here include a legitimate reviewer-directed correction, not evidence of an accidental duplicate create. The one-write test still failed and has not been relaxed. O terminal 424 was blocked by the independent receipt defect despite the positive judge verdict.

P regression proof expands the real native-MCP fixture through published Plan → SQLite reopen → Execute activation → reverse-ordered dependent read frame → synthesis → one local write → readback → reopen → terminal preparation and commit. `p-native-red-2.log` reproduces the wrong provider order. `p-native-terminal-red.log` reproduces O's exact terminal error after scheduling is fixed. `p-receipt-red.log` isolates the MCP text/count mismatch. Earlier P fixture attempts also exposed test-only mistakes (dependency list ordering, omitted local tool reachability and trailing newline); their logs are retained and are not counted as production defects. Tests additionally preserve independent-read concurrency and drain/stop semantics.

O stopped and sanitized normally; its database, reports, plans, provider receipts and both writes are retained. Only its inactive dependency-download cache was removed after checking that no process still owned that isolated home. The installed daemon PID 6767 has not been stopped or modified.


P also removes the duplicate plain-property parser from `terminal-publication-proof.ts`. Extending the fixture from preparation to actual terminal commit exposed this second failure: `receipt record projection does not match its raw payload` (`p-integration-green.log`, despite the filename, is a failing intermediate run). `p-terminal-green.log` then passed **81/81** through terminal commit.

Frozen P: source `66f8ff6c63c0965cdabfa0886f9a04989144a9351075d2e80a672093618c1640`, dist `0d9e5430fce2d9afcd46dccf73c02c97d5a1a0ea8ecf141095501e6110d1284a`; build passed. Frozen qualification: **492/492 tests across 14 existing files** (`candidate-p-test-files.json`, `qualification-p-tests.log`). Counts overlap earlier runs and must not be added. Real-home sentinel was NOT PERFORMED because installed PID 6767 still owns its home; no isolation sentinel pass is claimed. Fresh Sonnet5 + owner-selected Opus5 live Plan→Execute is running under `live-p-claude-on`. The pinned installer now points to P; it has not been applied.


P's first live Plan passed in **383.5s**, accepted Opus completion at event149, plan150, done157. Execute **never started**: the proof driver's 2GiB temporary-volume reserve rejected the next submission after dependencies had consumed the remaining margin. This is an environment interruption, not a failed Execute or a full live pass. Report: `live-p-claude-on/result.json`; driver error: `live-p-claude-driver.log`. The stopped P home was sanitized; its disposable `runtime/uv-cache` was removed only after no owning process remained.

To provide enough disk headroom without losing evidence, the source and dist directories of inactive candidates A (unsuffixed) through H are compressed under `archived-candidate-bytes/`. Every archived regular file was SHA256-compared to the original before removing those two duplicate directories. Per-file hashes and an index are stored beside the archives; docs, scripts, build manifests, test logs, all live homes and raw result evidence remain. Restore an old candidate's src/dist by extracting its corresponding archive into that candidate directory. P and the current pinned installer are untouched. A fresh P2 live run uses the exact same frozen P bytes and unchanged assertions.


## P2 live failure and Q repairs (current work, not installed)

P2 used the unchanged frozen P bytes with Sonnet 5 brain and owner-selected Opus 5 review. Plan passed its assertions in 577,975 ms. Execute failed in 45,838 ms, before any business read or file write. Evidence: `output/reviewer-monitor/2026-09-13-plan-continuation-fixes/live-p2-claude-on/` (result and exact source events). The proof daemon is stopped, its home sanitized and retained. Installed daemon PID 6767 was not touched.

The decisive scope failure was host-generated Execute context being fed to natural-language connector-access inference as owner speech. The published outline's clause “not a separate mandatory graph dependency): (i) call research-lab__api_request” was interpreted as excluding Research Lab. Both initial and resumed Execute logged that exclusion; native enumeration then returned no current definition and reported definition drift. This is not evidence that the connector itself changed. Q uses the durable literal Execute owner source plus adopted owner steering for that inference; original owner history still enters the ordinary continuity resolver. Both orchestrator and Claude callers are wired. Reviewed plan bytes still govern the task and exact per-call preparation. Explicit owner connector prohibitions remain enforced.

Q also corrects a reviewer context mismatch: the brain receives curated MEMORY.md through its instruction producer, independently of semantic memory-search hits. The judge previously saw an empty search but not that context, and falsely rejected an existing owner preference. Producer-owned memory fragments are now matched against the final model request and durably retained only after an accepted model response. Completion and trajectory review read that exact source snapshot rather than reloading the current vault. Digest validation detects changed retained bytes; this context never grants effects or converts a remembered factual assumption into a current observation.

Two latency repairs: publication now reviews the current prepared candidate directly instead of letting a pending advisory about an earlier draft force another model turn; ordinary advisory steering and owner-selected completion review remain. Advisory evidence windows now select the latest completed window, not the earliest, so third and later checks no longer repeat the prior window's read bytes. Completion evidence remains comprehensive.

Discriminating evidence: `q-scope-caller-red.log` fails when only the owner-source caller fix is removed; `q-memory-discriminating-red.log` fails when captured context is omitted from completion review; `q-advisory-window-red.log` fails when the old window selection returns. The earlier `q-memory-red.log` was NON-discriminating because its assertion ran inside a fail-open judge mock; it must not be counted as causal proof. Corrected assertions are outside the mock. `q-focused-green.log` passed 92 tests; `q-host-focused.log` passed 18 tests, overlapping later qualification. Q frozen build/live qualification still pending at this note. The P installer is not a qualified fix for this P2 failure.


Q frozen build: source `6b58a4e902c9369687be561d0b4feaf1690de41ba6c60a5a4a2f38af72fbe8c7`, dist `fa0369b6131708c309ff24ace87cdaff5107baa12129ac790334fc0a77519195`. `candidate-q-build.json` and `candidate-q-files.json` pin it. `build-q.log` passed; `qualification-q-tests.log` passes **578/578** across the 17 existing files in `candidate-q-test-files.json` (focused qualification, not the full repository suite). Real-home isolation sentinel explicitly **not performed** because installed daemon PID 6767 owns that state; disposable test homes remain in use. `live-q-claude-on` is the ongoing unchanged-fixture run. Candidate Q source/dist are frozen while it serves.


### Q Claude live result — completed work, one fixture assertion mismatch

Sonnet 5 + owner-selected Opus 5: Plan **253,995 ms**, then Execute **132,082 ms**. The plan needed one substantive completion-review correction, then published. Execute reached the same connector that P2 lost, read the approved batch and metrics, saved one file, recovered across the forced eight-call test boundary, and delivered `done`. Terminal `verified`, `replyMatches`, `objectiveMatches`, `artifactsMatch` are all true; current receipt bytes and actual target file hashes independently match. Three completion reviews (one Plan correction, two positive) and five completed advisory checks occurred. This is live same-provider Sonnet/Opus evidence, not Grok qualification.

The original driver **failed one assertion**: it hard-coded only three homepage URLs, while the immutable approved revision deliberately added three /pricing URLs. Actual calls match all six approved URLs exactly; each originally requested homepage appears once. `q-claude-approved-plan-audit.json` and reproducible `audit-q-claude.py` separately prove that accepted-revision contract. The original result and failure are unchanged. This is not an unqualified original-matrix pass. Future fixture assertions were corrected before starting the next run: each requested homepage once, and the actual page-read multiset must equal the approved revision's declared URLs. No production rule, prompt, or model budget was changed for that correction.

Two model argument repairs occurred before the sole write: first synthesis submission contained a literal control character in JSON; a later write request supplied an unapproved `mode` field. Both were corrected, with no extra effect. Do **not** describe this run as zero-refusal: the existing driver checks only a settlement subtype and misses these two visible call errors. A remaining quality caveat is the report's inference of statistical non-distinguishability without sampling assumptions or a test; labeling an inference does not itself establish it. The fixture serves synthetic text for any requested URL and proves no real-world web availability.

`live-q-grok-on` has now started against the same frozen Q bytes with Grok 4.6 + owner-selected Opus 5 and the explicitly revised approved-URL assertion. No Grok result is claimed yet. The installer now pins Q but has not been applied.


## Q Grok final failure and R diagnostic/query repairs

Q Grok 4.6 + owner-selected Opus 5: Plan **422,627 ms**, assertions passed, published revision and accepted Opus verdict. It recovered across the forced eight-call test boundary. A roughly three-minute keepalive-only stream gap later resumed on its own; no watchdog retry occurred in that gap. Do not describe it as a permanently hung stream.

Execute source **156**, session `sess-desktop-5aaac10fcb3c14dd3a9a703e`, failed after **77,639 ms**, terminal203. The exact approved graph activated and the brief read succeeded; no page/metrics business research and no write occurred. No accepted Execute completion review exists. The next model stream was still recording keepalives when the failed terminal was observed. The durable terminal omitted failureDetail, no run_failed event exists, and retained process logging does not establish the cause. The boot-time port8441 conflict is unrelated evidence and is not assigned as the cause. **Grok Execute is not fixed or qualified by inference.** All events, wire counts, usage, and the failed result remain at `live-q-grok-on/`; its proof daemon stopped, was sanitized, and its home remains. Only its inactive dependency-download cache was removed after ownership and cleanup checks.

Two independently reproduced repairs are frozen in R:

- **MCP retained-result projection:** Q Grok's tool_output_query requested the correct API fields but saw the enclosing `{result:{content:[{type:text,text:JSON}]},complete:true}` transport. `recall-tools.ts` now uses the same canonical provider-result owner decoder as evidence readers, so requested schema fields or record pages come from the actual JSON payload. Both root and sealed MCP forms work, with structured/text agreement, conflict, failed-envelope and ordinary-business-object controls. Raw stored bytes remain unchanged. Explicit transport-field inspection remains available. Decoded paths are not advertised as raw-envelope `$fromToolOutput` paths. `r-query-red.log` has three discriminating failures before the change; `r-query-green.log` passes21 tests in recall-tools.test.ts. The nonexistent result-facts.test.ts argument in that early command contributed no tests and is not counted.
- **Exact terminal diagnostic ownership:** `loop.ts` now prefers the actual returned failure over the optional advisory run_failed event. If only an advisory diagnostic exists, it must name the exact accepted source. A missing event no longer erases a known error, and a prior request's failure can no longer be borrowed. Diagnostic detail stays private and bounded; public prose and terminal replay remain unchanged. `r-terminal-red.log` reproduces both defects; `r-terminal-green-2.log` passes7 reducer tests, including exact-source fallback, bounds and immutable replay. This repairs observability; it does not by itself identify Q Grok's exception.

Frozen R source **d8a927fe578e2d00d921a85ae02dd1e255a48c9ae55854bf8f1be1b20cd5f733**, dist **86843a84f428bb01d96b6acefd3ef35c8abb268ad0e3038a86649ba03470081c**. `candidate-r-build.json`, `candidate-r-files.json` and `candidate-r-test-files.json` pin it. Build passed. **613/613 tests passed across21 existing files** via scripts/run-tests-isolated.mjs (`qualification-r-isolated-tests.log`). This is focused qualification, not the full repository suite; counts overlap earlier tests.

The first R broad test invocation was the reviewer's launcher error: direct node --test omitted the repository isolation preloader/seal configuration. Its failures/cancellations are retained in qualification-r-tests.log and qualification-r-tests-rest.log (first capture is incomplete/truncated and explicitly noted). The corrected isolated runner passed; no source change was made to bypass those protections. Its real-home sentinel was **NOT PERFORMED** because installedPID6767 remains active; it reported no live-home change during that corrected run. No sentinel pass is claimed.

Fresh live-r-claude-on uses unchanged frozen R bytes, Sonnet5 plus selected Opus5, synthetic connected research-lab MCP, local-only output, and the previously corrected exact-approved-URL assertions. Visible tool errors are additionally recorded without relaxing the existing assertions. Result pending. A Grok repeat needs renewed access-only credentials: the installed grant observed at19:32UTC expires19:44:55UTC, too soon for the isolated full-journey provisioner. The user has been asked to reconnect; no refresh grant was copied or rotated. Installed daemon6767 and UI work remain untouched. The installer still pins Q until a new candidate is selected explicitly.


## R Claude final result and S repair guidance

The R live run is complete and its proof daemon stopped and sanitized. Source `217` in `sess-desktop-a663e7b8fa4a0fda5dd33745`: Plan **710,034 ms**, Execute **251,078 ms**. All approved homepage reads occurred exactly once and the metrics operation ran once. The final terminal is `done`, with reply, effective objective and current artifact digests verified. See `live-r-claude-on/`, `audit-r-claude.py`, and `r-claude-delivery-audit.json`.

The original strict driver **failed**, unchanged: it expected one successful write but observed two, and it observed a refused attempt. Opus completion review309 rejected the initial file's unsupported self-serve claim and price-premium inference; Clem corrected the same saved file, then review355 accepted it. Independent receipt/file hashing proves the first bytes are preserved and the final bytes match the latest receipt. This is legitimate correction, not an accidental duplicate create. The ledger-counted refusal321 was the fixture's deliberately low eight-call activation budget: no provider crossing, followed by an automatic continuation of the same accepted source. Neither distinction retroactively passes the original assertions.

There were also **two genuine model argument repairs**: call286 contained a literal newline inside JSON for `plan_step_result`, and call339 invented `cap:local:write_file:overwrite` instead of reusing the reviewed `save_briefing` requirement. The driver's settlement-subtype check undercounts these errors. Do not claim a clean attempt, premium latency, or flawless content: some service-model contrast remains stronger than the sparse sources support. Final file SHA256: `d1c325e5e2a505ca135767171ddf43a596f0613b5ccab3d1b089ae212275e95c` (6,975 bytes).

S changes only the publisher's existing repair guidance. It distinguishes an unknown/new step from a duplicate patch; adding, removing or reordering steps requires a complete replacement plan. It explicitly locates changed fields inside `changes`, says omitted full_text is retained, and warns that supplied full_text replaces the whole explanation rather than appending a change note. This responds to actual R repairs138/143/171. Publication validation and patch semantics are unchanged.

A reviewer correction: I initially inferred that the host patch merge retained a conflicting static argument when a dynamic binding was added. Inspection of full call162 showed that the model itself supplied both in a new complete plan. That was not a merge defect. I corrected the commentary and left the static/dynamic collision check intact.

`s-repair-red.log` reproduces the misleading new-step diagnostic. `s-repair-green.log` passes21 publisher/strict-schema tests, including retention across reopen and no publication from invalid patches. Frozen S built and passed **613/613** tests across21 files (`qualification-s-tests.log`). Source `4652f2cfa1130df55151baa834948ef1ed8cfa04fa24ab68586b54bdbc4bdae7`; dist `12b7444e4e04ead473a40a4ac09c63534e1a0c363096f62f7740167ad6617256`. No S live run occurred. The real-home sentinel was NOT PERFORMED while installedPID6767 owned the home; it observed memory WAL/SHM changes during this run, so no isolation sentinel pass is claimed.

## T lossless model-argument decoding

Q and R both spent a model turn regenerating a large synthesis because a literal line break appeared inside a JSON string. T's `model-tool-argument-json.ts` decodes only that uniquely representable spelling: raw control characters within a JSON string become Unicode escapes, then the complete result must parse as one object. Values are preserved byte-for-byte after decoding. Existing quoted/escaped text and Unicode remain unchanged. Missing quotes, structural damage, invalid escapes, trailing objects/text and non-object arguments are not repaired. Ordinary SDK schema validation, approved destinations and effect authority remain in place. There is no new model call, tool, approval or task limit.

The host uses the decoder at its existing argument materialization seam, before approval and dispatch. Original model bytes remain in admission/history, while all invocation checks consume the materialized values. The production native-MCP fixture covers real Plan publication, SQLite reopen, exact Execute, dependency ordering, malformed-newline synthesis, one write, readback, reopen and terminal commit. A separate SDK-tool fixture proves wrong types and unknown fields never enter the tool body after decoding.

`t-json-red.log` reproduces the failed synthesis/write before the integration. The first green attempt reached the write but exposed a fixture collision: the newly added second full journey reused the first journey's output path. Each source now gets its own output path. That failed intermediate is preserved in `t-json-green.log`. The corrected run `t-json-green-2.log` passes **322/322** tests, including all control characters, ambiguous/malformed negatives, existing escapes, actual SDK validation and original-history bytes. The first red failure is distinct from that fixture collision. Full frozen qualification is pending below. The R home retained its DB and receipts; only its inactive dependency-download cache was removed after confirming no owning process and successful sanitization.


### Frozen T qualification and next action

- Directory: `output/reviewer-monitor/2026-09-13-plan-continuation-fixes/candidate-source-t`.
- Source: `5ee221649568f6f6f7dc7200cfd85a8ff64f49dfd298f0a4d31646689ec56665`.
- Dist: `24e155b5feff76d2ccd9fc41e84b79c705c207cf27a4c330ced10c43488f8df5`.
- HEAD remains `2be6fa443c136580dccad413706a57c66e424a49`, schema81. `candidate-t-build.json` and `candidate-t-files.json` pin181 copied changed/untracked paths; these include earlier shared work, not181 new changes from T.
- Build passed (`build-t.log`); **618/618** tests passed across22 files (`candidate-t-test-files.json`, `qualification-t-tests.log`), no skips/cancellations. Counts overlap previous suites. `hotpatch-t-check.log` passed. This is focused qualification, not the full repository suite or a fresh T live run.
- `t-r-captured-json-audit.json` records successful decoding of the actual R call286, which strict JSON parsing rejected. It identifies the original compute step and markdown output shape. This is a captured-input replay, not an additional LLM run.
- InstalledPID6767 remained serving on8520. The isolated runner's real-home sentinel was **NOT PERFORMED**, with memoryDb/WAL/SHM changing while the installed daemon owned that home. Do not call that an isolation sentinel pass. T fixtures used disposable homes; no proof daemon is left running.
- `hotpatch-plan-continuation.sh` now pins T, verifies source/dist, preserves installed UI/authentication dependencies, and retains the existing rollback procedure. Only `--check` was run. No commit, push, tag or installation occurred.

The next decisive qualification is **Grok4.6 + selected Opus5 Plan→Execute on frozen T**, then the original installed connected-tools journey. `live-proof-t-grok.mts` is prepared with the prior strict assertions unchanged, so original R/Q failures are not rewritten. The stored Grok grant was rechecked and still expires `2026-09-13T19:44:55.974Z`, now expired. The user has already been asked to reconnect. No refresh token was copied or rotated, and another live Grok run has not started.

Keep the unresolved questions explicit: Q Grok's failed Execute had no retained cause; R/T preserve the returned error but do not prove a cause or cure. Planning still needs a latency/quality pass: R took11m50s and several substantive reviews. T targets observed avoidable repairs without weakening review. Do not add vocabulary gates, task ceilings, or new approvals to force this fixture green. For a later test-contract revision, distinguish a typed zero-dispatch activation deferral from invalid arguments, and a receipt-proven judge-directed correction from duplicate creation; record any revised expectations before the next run and preserve these original failures.
