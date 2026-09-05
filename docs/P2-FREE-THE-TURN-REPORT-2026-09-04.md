# P2 — Free the turn: implementation and acceptance report

Date: 2026-09-04, America/Los_Angeles. Some evidence timestamps are 2026-09-05 UTC.

**Status: P2 implementation delivered; local verification green; live acceptance
partial.** The original canary reached a resumable account question with no
external write. Cross-family foreground auditing is proven on the wire, but the
eight-worker acceptance failed. These results do not justify a tag-readiness or
universal no-dead-end claim. P3 has not started. The v3.16.0 tag remains withheld
pending the owner's explicit go.

## 1. Authority, scope, and frozen implementation

The owner explicitly authorized `Start P2`. The scope is §5 P2 / defect class D2 in
`docs/BEAT-THE-HARNESSES-DIRECTION-2026-09-04.md`: make bounded recovery usable,
recognize real host progress, preserve tools needed to repair or pivot, and publish
an honest resumable stop without an extra tool-free model turn. §12 was re-read
at the commit boundaries; reviewer entries have not been rewritten or deleted.

Frozen acceptance source:

- SHA: `4ed325eb6c36c0ae8bd00fce2d027e56e6cdc7e5`.
- Checkout: `/private/tmp/clem-p2-frozen.BgMA1B`.
- Source fingerprint: `d84899e5ef3649fa9a74ec83338522339de330d6eebea540e0b6419413017091`.
- Version/schema: `3.16.0`, schema `77/77`.
- Isolated canary boot reports that exact SHA, `gitDirty:false`, and the frozen
  checkout's `src/index.ts` as its entry point.

The implementation is organized into these commits:

| Commit | Change |
| --- | --- |
| `658b12c2` | Expose scoped `run_worker` delegation before plan compilation. |
| `ce05be82` | Spend bounded retries without discarding typed recovery, exact questions, or the first provider rejection. |
| `b8f334e9` | Project settled call authority and bounded host repairs without requiring an expected-work graph. |
| `7bd17d6f` | Keep recovery executable; remove tool-free terminal turns; publish retained, resumable stops and carrier-repair feedback. |
| `4ed325eb` | Refresh the implementation manifest for the frozen source. |
| `82e067f1` | Follow-up: discriminate legacy schema refusals by canonical attempted operation and arguments. Not present in the frozen live runs below. |
| `72e9228c` | Refresh the implementation manifest after the legacy schema-repair follow-up. |
| `5b8c3267` | Preserve the reviewer's appended feedback, including closure of the bare-schema item. |

Measured from `ed12a63a` to frozen `4ed325eb`, the four changed
production TypeScript files contain **178 additions and 251 deletions: net −73
lines**. This excludes tests, documentation, and the generated manifest. The
subtraction claim is about the production diff, not the size of the whole commit
series including regression coverage. For the final production source through
`82e067f1` (manifest `72e9228c`), the same comparison is **211 additions and 259
deletions: net −48 lines**. Both live traces below remain tied to `4ed325eb`; the
follow-up was verified locally and was not retroactively included in those runs.

The reviewer classifies the three-line `run_worker` removal as D5/P5 scope rather
than D2. It is explicitly recorded here as a small scope extension. The owner
authorized P2 and requested the parallel-audit setup; the executing agent inferred
removing the measured exposure wall as a bounded prerequisite for that request.
The owner did not separately name this exact predicate. The reviewer accepted it
as a tested subtraction supporting the no-dead-ends requirement.
No further P5 work was taken on under that exception.

## 2. What changed and what each fix proves

### Retry accounting and typed progress

A new typed consequence spends one token from the declared retry budget instead
of setting the remaining budget to zero immediately. Different repairs retain their
discriminator and count as bounded structural progress. An unchanged failed repair
still stops within its limit; argument churn, new call identifiers, and catalog
alias changes do not manufacture authority or replenish the budget.

The current stop stage survives state serialization and publication. A stopped run
names the stage it actually stopped on, rather than a historical failed row that
happens to remain in memory.

### Discovery and read tools remain available during repair

Host-side recovery retains the refused carrier alongside the turn's proven read
and discovery controls. A model that needs to look up a current schema, inspect
retained data, or choose another proven capability can make that call. Each call
still passes its existing dispatch authority and consent checks.

The tool-free last-word model round trip has been removed. The host publishes the
typed stop and durable retained-work summary directly, including a current stage,
an executable next edge, and resumability. Local fixtures assert that publication
does not make an additional model request.

### The graph projection recognizes work the host already performed

Settled host capability bindings contribute operation, account, and schema facts
directly to the governor. A graph-free call is no longer invisible merely because
there is no expected-work graph for it. A bounded structural carrier repair also
counts as progress. Its corrective explanation travels on the existing per-call
diagnostic channel and is consumed once, so the model can converge on the repaired
frame.

The graph remains a projection of accepted work and settled facts. This change
does not grant a catalog entry independent dispatch authority.

### The SDK exposes fresh delegation

The measured premium-audit smoke failed before P2 because `run_worker` existed in
the agent's raw tool list but the SDK's `isEnabled` filter hid it until a plan had
been compiled. The predicate and its unused import were removed.

The regression uses the SDK's actual filtered surface, then invokes `run_worker`
with fresh accepted input and no expected-work contract. It proves that the worker
runs while retaining the accepted source, worker restrictions, a finite turn
budget, and a denied external MCP scope. Delegation does not mint a planning
contract. The original regression failed at the missing enabled tool before the
subtraction and passed afterward. The later live test reached a further
pre-dispatch refusal and started no workers (§7); SDK exposure is therefore the
proven result, not end-to-end delegation success.

### Exact questions and provider rejections survive new authority

Two safety findings were fixed during verification:

- Newly acquired operation authority must not erase an exact pending user
  question. The question, option order, purpose, and allowed argument keys remain
  bound; a paraphrased question or changed options cannot silently substitute for
  that exact choice.
- The first provider rejection must remain recorded when the same call also
  establishes a new capability binding. Otherwise, recording the binding clears
  the failure and accidentally buys another repair cycle. The first failure now
  retains its one bounded repair; an unchanged repeated rejection terminalizes.

These are generic state/authority corrections. They add no provider-named
production branches, new flags, or alternate authority tokens.

## 3. Protected invariants

None of the §3 authority, settlement, consent, or physical-crossing files was
changed in this P2 series. In particular:

- A physical external crossing still has one CAS lease.
- An uncertain external write remains reconcile-only; a retry cannot blindly
  replay it.
- Exact operation, schema, account, effect, and accepted-source checks remain at
  the execution boundary.
- Result handles and settled effect receipts remain authoritative across restart.
- The existing consent reducer still decides allow, deny, or ask. Exact user grants
  remain required for send, delete, admin, and sealed bulk work.
- A wider recovery tool surface does not authorize an external effect.
- Migrations 76/77 and prior migration files were not edited.

The canonical live objective permits drafts and explicitly prohibits sending.
Nothing in this phase changes that limit.

## 4. Local verification

All exit statuses below are the command's real exit status, captured directly.
No test or artifact command was graded through `head`, `tail`, or another pipe.
The suites overlap; their test totals must not be added together as a unique-test
claim. A new full-repository suite has not been claimed for P2.

| Verification | Result | Evidence |
| --- | --- | --- |
| Host/governor focused integration and regression set | 252/252 pass; exit 0 | `/private/tmp/p2-host-governor-review.log` |
| P2 regression set | 414/414 pass; exit 0 | `/private/tmp/p2-regression-final.log` |
| Protected-boundary floor set | 96/96 pass; exit 0 | `/private/tmp/p2-floor-final.log` |
| Final implementation typecheck | Exit 0 | `/private/tmp/p2-typecheck-final.log` |
| Final source typecheck, main checkout on the identical settled source | Exit 0 | `/private/tmp/p2-typecheck-frozen.log`; despite its filename, this did not run from the detached frozen directory |
| Implementation artifact emission | Exit 0 | Executing-agent command receipt; manifest commit `4ed325eb` |
| Implementation artifact `--verify-current` | Exit 0 | Executing-agent command receipt on the frozen implementation |
| Reviewer schema-fallback regression set | 91/91 pass; exit 0 | `/private/tmp/p2-review-regression.log`; follow-up `82e067f1`, outside the frozen live runs |
| Reviewer follow-up typecheck | Exit 0 | `/private/tmp/p2-review-typecheck.log` |
| Reviewer follow-up artifact emission and `--verify-current` | Both exit 0 | Executing-agent command receipts after `82e067f1`; manifest commit `72e9228c` |

Additional causal evidence, included in or overlapping the sets above:

- Fresh worker surface/invoke: initial RED exit 1; final orchestrator and worker
  packet parity run 77/77, exit 0. Logs:
  `/private/tmp/p2-worker-exposure-red.tap` and
  `/private/tmp/p2-worker-exposure-suite.tap`.
- Public stop propagation: actual `runConversation → runTurn → commitTurnOutcome`
  receives the host's typed result; error, public text, and persisted presentation
  remain byte-identical; resumability is true; current-stage metadata and the next
  tool edge survive; one public terminal is committed. Focused result 1/1, exit 0:
  `/private/tmp/p2-public-governor-stop.tap`.
- Stalled provider attempt: paired production-host fixtures with and without a
  typed pre-content stall assert the same governor budget. The stalled case has
  one additional provider attempt and no additional settled tool result or
  governor charge. See `host-no-progress-governor.integration.test.ts`.
- Fallback behavior: the real fallback adapter tests prove watchdog retirement
  admits a fresh rescue signal, preserves user cancellation, and demotes the
  stalled brain. Focused existing suite 5/5, exit 0:
  `/private/tmp/p2-stall-fallover-existing.tap`.

The early focused runner invocations reported that their live-home sentinel could
not establish isolation while the main daemon owned that home. Their test bodies
used private temporary homes. Those early runs are causal regression evidence,
not a claim that the live-home sentinel passed. The final acceptance runs and
frozen daemon identity are the phase's primary evidence.

## 5. Reviewer feedback disposition

The §12 review at approximately 22:05 accepted the retry decrement, recovery
surface, last-word deletion, and settled-binding/host-repair projection changes.
The following items must remain explicit in the final report:

1. **Bare `schema_invalid` without a repair key:** the reviewer identified a
   remaining collision when the projection cannot derive a discriminator and
   requested operation-id plus argument-digest discrimination before P3.
   The frozen P2 canary contained **zero bare `schema_invalid` stages**. That
   observation does not refute the unexercised collision. Follow-up `82e067f1`
   adds a canonical operation/argument digest when no failing-path repair key is
   available. Formatting or call-id churn does not create another stage; changed
   arguments distinguish only finite repair stages and do not create authority
   or an unlimited retry budget. The regression set passed 91/91, exit 0, and
   typecheck exited 0. The reviewer's §12 22:20 append explicitly closes this item.
   This fix is not included in frozen SHA `4ed325eb` or the two initial live
   traces; those had zero occurrences of the affected bare stage. The final
   direct-auditor live test below includes the fix on clean `5b8c3267`.
2. **Provider-proven failure and armed cooldown:** the implementation includes a
   real `withModelFallback` test named “a provider-proven failure arms cooldown
   before exactly one bounded rescue attempt” in `fallback-model.test.ts`.
   A typed model rate-limit failure arms the primary's cooldown before the rescue
   executes; a failed rescue cannot start another ladder; the next invocation
   skips the primary while its cooldown is armed. This is a model-provider
   transport property. Separately, `provider_repair` governs a tool/provider's
   known-terminal rejection: one repair-or-alternative opportunity, then an
   unchanged rejection stops. These are distinct layers; the fallback cooldown
   test must not be represented as proof that every business-tool retry has a
   timed cooldown. The test passed as `ok 50` in
   `/private/tmp/p2-floor-final.log:366`, within the 96/96 run whose real exit
   code was 0. This closes the model-provider cooldown interpretation. If the
   reviewer intended a new timed business-tool cooldown, that is a different
   requirement: none is added or claimed here. `retry_host` remains the existing
   checkpoint-owned, bounded host recovery, not a provider cooldown.
3. **Worker exposure scope:** recorded as the reviewer-accepted D5/P5 extension
   in §1 above; no further scope expansion is implied.

No reviewer entry has been silently reconciled against the document body. Any
remaining disagreement belongs in the final phase report for owner/reviewer
arbitration.

## 6. Same-task live canary — resumable account question, zero writes

Task: `bg-graph-driver-tag-canary-20260904`.

Exact objective bytes, unchanged:

```text
Find five suitable prospects in Salesforce, enrich them with DataForSEO, use my outbound skill to prepare and validate the outreach locally, then create five Outlook drafts. Do not send anything.
```

Objective SHA-256:
`1a24a4992bf18e8031dc0cb4766d06025a543db699216756193a3c9c170dc1cf`.

The existing isolated P1 task was resumed in place. It was not replaced with a
new easier task. The before/receipt evidence retains contract version 1, zero
contract revisions, requested model `claude-sonnet-5`, and the exact task ID and
objective above. This canary preserves its original Claude-worker / Codex-judge
orientation rather than borrowing the changed main DEV configuration.

Evidence directory: `/private/tmp/clem-p2-canary-evidence.DB85wN`:

- `before.json`: prior task state and unchanged invocation contract.
- `preflight.json`: frozen SHA/build identity, objective digest, model roles, and
  both Claude and Codex available.
- `resume-receipt.json`: HTTP 200, `ok:true`, accepted resume at
  `2026-09-05T04:43:49.290Z`.
- `daemon.log`: frozen build boot, background task start, and subsequent runtime
  events. The isolated listener is port 64241.
- `after.json` and `driver-outcome.json`: final observed task state and preserved
  contract/model after the resume.
- `acceptance.json`: source-bound terminal, event counts, governor decisions, and
  retained-work result. The stop/collection procedure exited 0.

The P1 baseline was an honest pre-write block, specifically
`control_no_progress_exhausted / resumable:false`. P2 acceptance requires the same
failure class to expose a resumable current-state stop with a named next edge and
at most one wasted model step, or to make verified forward progress beyond it.
Only the effect ledger can establish that drafts were created.

Observed result at `2026-09-05T04:47:31.027Z`, approximately **3 minutes 42 seconds**
after the accepted resume:

| Fact | Observed value |
| --- | --- |
| Background task status | `awaiting_input` |
| Public outcome | `needs_input`, question presentation, `resumable:true` |
| Public identity | Source user sequence 229; terminal event sequence 440 |
| Current typed stage | `input_required:account_selection` |
| Exact question / next edge | `Which connected account should I use?` |
| Task snapshot | `outcomeSnapshot.resumable:true`; nextAction retains the same question and checkpoint summary |
| Retained products | Five `read_file` result handles listed in the public result |
| Successful external writes | 0; no settled external-write attempt is recorded |
| Tool-call event rows | 26 `tool_called`, 26 `tool_returned` |
| Settled dispatch/attempt rows | 21 `provider_dispatch_started`, 21 `provider_dispatch_settled`, 21 `tool_attempt_settled` |
| Bare `schema_invalid` stages | 0 |
| Tool-free last-word turns | 0 |
| Task, objective, requested model, contract | Same fixed task; objective unchanged; `claude-sonnet-5`; contract 1; no revisions |

The task-level log line, now present:

```json
{"level":30,"time":1788583651095,"pid":22176,"hostname":"MBA-NREYNOL-HPA","name":"clementine-next.background-tasks","taskId":"bg-graph-driver-tag-canary-20260904","questionId":"bgq-bg-graph-driver-tag-canary-20260904-mtnwixmo","msg":"Background task paused for clarifying input"}
```

The old `control_no_progress_exhausted / resumable:false` wall did not recur. The
run performed work and reached an account-selection question. Its exact question
and retained-work summary survive into both the public terminal and the task
snapshot. This is a different, resumable stop, not a reproduction of the old
terminal with only its resumability bit changed. The governor fixtures provide
the direct before/after proof for the original failure shape.

This run does **not** establish that the task completed end-to-end or that any
Outlook draft exists. It also does **not** establish the whole-run claim “at most
one wasted model step”: there were multiple tool/control attempts, and their
global waste was not independently classified. The collector's `modelSteps:0`
field is not a usable model-call count—17 prompt-composition events exist, so zero
cannot be interpreted as no LLM work. The supported narrower findings are zero
last-word turns, a resumable current-state question, retained evidence, and no
recurrence of the old terminal.

Preflight verifies the configured judge role and both providers' availability.
This canary ended through the exact ask path, not an objective-completion verdict;
no judge transport claim is made for that path. The separate Codex/Claude test
below proves the pinned Claude judge actually reaches the transport. It ran with
routing mode off and is not an all-in routing-mode acceptance claim.

## 7. Parallel audit — configuration and watcher wire succeed; fan-out acceptance fails

The owner's requested settings were applied through supported console APIs on
the main DEV listener at port 8520. No source files were changed to configure
them, no daemon restart was performed for that settings operation, and it made no
live LLM calls.

Verified readback:

| Setting | Selected value |
| --- | --- |
| Active brain | `codex_oauth`, `gpt-5.6-terra` |
| Default worker | `gpt-5.6-terra` |
| Judge | `claude-sonnet-5` |
| Chat trajectory watcher | On, interval 4 tool calls |
| Workflow trajectory watcher | On, interval 2 steps |
| Cross-family judging | On |
| Model routing mode | Off |
| Existing design-worker override | `claude-opus-4-8`, preserved unchanged |
| Provider readiness | Codex available; Claude available |

The API readback and persisted-key comparison verified that unrelated configuration
was preserved. At that moment, main DEV was PID 13241 on the earlier clean
`a58c34c0` boot. Its active-work endpoint reported zero active tracked sessions,
pending approvals, or background tasks. These observations describe that time;
re-check active work before any later stop/reboot.

The subsequent isolated live audit test ran on frozen `4ed325eb`. Its evidence is
`/private/tmp/clem-p2-audit.Suyi4z/evidence/acceptance.json`, session
`sess-desktop-34db3a332f4010dd2a7b0460`. The collector returned **exit 4** and
`ok:false`: this is a failed end-to-end acceptance result.

The requested proof was one eight-item worker batch, real Codex worker reads of
each item's value in an isolated nonce mapping file, exact returned nonce receipts, worker concurrency, and
actual Claude auditor intervals overlapping those workers. Actual results:

| Observation | Result |
| --- | --- |
| Actual Claude watcher calls | 5, all `claude_code_headless`, actual model `claude-sonnet-5` |
| Watcher results | 5 passed; 0 blocked, advisory, timeouts, invalid, or errors |
| Judge/brain families | Claude / Codex; `selfJudge:false` |
| Watcher latency | Average 2,857 ms; maximum 2,988 ms |
| Worker start/result/route records | 0 / 0 / 0 |
| Exact per-worker nonce receipts | 0 of 8 proven |
| Worker/auditor overlap | None; no worker intervals exist |
| Mutations / pending approvals | 0 / 0 |
| Application terminal | `done`, `resumable:false`, despite text saying the requested batch could not complete |
| Acceptance verdict | Failed; collector exit 4 |

The five actual watcher wire intervals were:

```text
2026-09-05T04:48:55.177Z → 2026-09-05T04:48:58.064Z
2026-09-05T04:49:39.691Z → 2026-09-05T04:49:42.644Z
2026-09-05T04:49:40.114Z → 2026-09-05T04:49:42.770Z
2026-09-05T04:50:05.459Z → 2026-09-05T04:50:08.288Z
2026-09-05T04:50:06.269Z → 2026-09-05T04:50:09.158Z
```

The watcher transport receipts include provider session identities and token/cost
accounting, so this is actual Claude wire evidence rather than route metadata.
All five watcher intervals overlap three successful Codex Terra brain calls.
The first watcher interval is entirely inside a Codex Terra brain call
(`04:48:55.172Z`–`04:49:01.756Z`). This proves foreground brain/auditor
concurrency, but is not the stronger required worker/auditor overlap. No worker
existed to overlap.

The public result said the nonce batch could not be completed because `run_worker`
was refused before dispatch and marked unavailable. It did not invent nonce
values. Nevertheless, the persisted application terminal was `done` with reason
`success`; that is a completion-classification defect for this unmet local task,
not an acceptance success. The final objective-completion judge was a self-family
Codex hedge (`selfJudge:true`), distinct from the five cross-family Claude watcher
calls (`selfJudge:false`). That distinction is another reason not to equate a
configured judge pin with every final verdict coming from Claude. P1's
external-effect ledger rule cannot be cited as proof that every local task's
completion grading is already correct.

The captured request provenance proves `run_worker` was present in request 3's
actual tool schema. The model emitted the correct eight-item call
`call_tBgF4tuqvCC6jxh3iTwnogOO` in accepted batch 3. Its host result receipt at
`04:49:01.836Z` records `refused_pre_dispatch`, recovery `replan`, effect `none`.
The checkpoint's diagnostic is only “This call was refused before execution. No
effect occurred; correct the call or choose another capability.” It was retried
twice and eventually marked `do_not_retry`. Thus the remaining boundary rejected
an advertised call before any worker started; this is not missing tool exposure
or a worker-auth execution failure. The narrower refusal reason was not retained
in these receipts/logs. An absent expected-work binding is observable but is not
by itself causal proof; the next red journey must use these actual call bytes.

The backend trajectory watcher exists, is advisory, and now has live cross-family
wire evidence. The requested premium workflow—Codex workers completing a batch
while Claude audits them in parallel—remains unproven because fan-out failed.
Healthy per-run audit visibility and the polished premium interface remain
separate product work; this report does not claim they shipped in P2.

### Final-build direct-auditor acceptance — PASS

A separate, explicitly narrower test ran on clean
`5b8c32673d4bc72526fe56f6b1dc1871caa46fcb`, including the review correction and
manifest. It asked the parent to read three authorized local files itself and
return both package versions and all eight exact random nonce values. It did not
ask for or permit worker delegation. Both the run driver and stopped-daemon
collector returned real **exit 0**; every acceptance assertion passed:

- Three actual successful reads, exact requested output, terminal `done`.
- A healthy real Claude Sonnet 5 watcher call, not a fabricated audit result.
- Actual watcher/brain overlap of **2,377 ms**, from
  `2026-09-05T04:58:46.837Z` to `04:58:49.214Z`.
- No workers, external writes, approvals, or unauthorized tools.

Evidence: `/private/tmp/clem-p2-direct-audit.NyLrmX/evidence/direct-acceptance.json`.
Session: `sess-desktop-88834526f986f81511293278`.
This verifies the configured foreground parallel auditor and live model behavior
on the final source. It does not replace or turn the failed eight-worker test green.
The isolated daemons were all stopped after evidence capture. Main DEV's clean
startup record is recorded in the phase closure below.

## 8. Phase boundary and release state

P3 has not started. No tag was created by P2. The report does not authorize one.

Main DEV was restarted once after the final implementation and report were
committed. The supported build/settings/active-work APIs returned exit 0 and:

- PID `51650`, listener `127.0.0.1:8520`.
- Boot `2026-09-05T05:00:04.510Z`, clean SHA
  `c2623d016b6fbe4d18b82839cddbaccc224f0635`, `gitDirty:false`.
- Source fingerprint
  `f54fc9788e4885c915c5e8a522718d34479bb20df92719e37a0aeed2961fa451`,
  version `3.16.0`, schema `77/77`, entry
  `/Users/nathan.reynolds/clementine-next/src/index.ts`.
- Brain/default worker Codex Terra; judge Claude Sonnet 5; both providers ready.
- Both watcher flags on, chat interval 4 and workflow interval 2; routing off.
- Zero active sessions, background tasks, or pending approvals at verification.

The subsequent phase-closure commit records this boot and changes documentation
only; the running production source is the final P2 implementation. Existing
session-specific model pins are not overwritten by the new default configuration.

The P2 code and local behavior checks are delivered. The original live run now
has a resumable next edge; the final direct-auditor acceptance is green. The
stronger worker test remains red, and the whole-canary ≤1-wasted-step bound was
not measured. These limitations are the phase report, not silently waived gates.
No P2 push/fast-forward or tag was performed on the strength of these mixed live
results. The parked stashes remain untouched.

Once the final P2 report is posted, the next phase-start question is `Start P3?`.
P3's proposed scope is the existing reducer/invoke write path, proven live write
catalog resolution, one attestation builder, and single-pass plan validation.
The §3 invariants continue to apply. Any P3-adjacent parked stash remains untouched
until that phase is explicitly authorized.
