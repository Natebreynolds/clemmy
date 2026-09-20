# Live acceptance ledger — September 19

**Current status:** see [current framework state](2026-09-19-current-framework-state.md).
The opening matrix below is the original snapshot; later dated entries supersede
its pending labels. Do not repeat completed checks solely because of that matrix.

Goal: one verified live build with reliable completion, useful durable memory,
truthful desktop/mobile state, and trustworthy matched-task cost measurements.
No isolated-home results qualify as acceptance. Preserve shared main work.

Running build for checks below: `6e15d3ac247a394e247f990399a7de7e854d22b20ba166c54f2146ca47e4dcab`.
Evidence files: `output/weekend-harness-2026-09-19/` (local, ignored).

| Requirement | State | Evidence / remaining scope |
|---|---|---|
| Configuration/authentication truth | Partly verified | Native Claude vault reauthenticated; installed adapter succeeds; webhook ignores request.model by documented surface policy, not auth fallback. Disconnected-state indicator consistency still needs repair. |
| Full Claude chat | Passed smoke | `claude-full-chat.json`: source 237657, actual Opus 5 on host_harness, result 391. Temporarily selected via normal active-brain API, restored Terra. No completion review occurred on this zero-tool reply; do not claim reviewed acceptance. |
| Plan prohibits business effects | Passed one scenario | Source 237677 published exact plan revision; artifact absent before Execute. `published-plan.json`, `plan-acceptance.json`. |
| Execute exact approved revision | Passed one scenario | Source 237727, artifact exact 32 bytes including newline, readback verified, Sol review verified=true. `plan-execute-result.json`. |
| Memory scope classifier | Passed four live cases | `live-memory-review.json`: task-only, recurring, mixed and quote; called installed code with real configured Sol. No persistent fact integration claim from these calls alone. |
| Durable capture + cross-session recall | Passed one scoped preference | Fact 3726 / candidate 2152643 promoted with provenance; new session recalled AMBER-ORCHARD and project-only scope. Initial fact included transient “Briefly acknowledge.”: quality issue still open. |
| Explicit memory correction | Passed one scenario | Source 237844 superseded fact 3726 with 3727 (VIOLET-ORCHARD), reviewed by Sol. Another fresh session recalled corrected value and scope. Test fact soft-forgotten afterward; zero active matching test facts remain. Receipts: memory-correction.json, memory-corrected-recall.json, memory-fact-evidence.json. |
| Inferred task-only/mixed candidate integration | Passed bounded cases | Candidate 2153059 rejected task-only text; 2153060 promoted only the recurring clause. Fresh session recalled title and scope. Recall question exposed separate project-requirement bug; fix and retest below. |
| Corrected answers rejudged | Passed one mechanism check | Live repair verdicts 238386 and 238388 have different reply digests, fresh review, rejection then acceptance. Independent link validation still found a separate defect; review success is not artifact proof. |
| Unchanged failures stop without waste | Pending | Need concrete live failure/retry evidence. |
| Act local artifact | Passed one scenario | Source 237907, Sol verdict 237955 verified=true, terminal 237959. Exact artifact and readback independently checked; `act-result.json`. |
| Local Space + workflow creation | Partial | Checklist Space saved correctly; local manual workflow disabled and unrun. Initial final answer failed review, repair invented invalid workflow route despite positive judge. Canonical link fix installed; execution and native link rendering still pending. |
| Repeated calendar/inbox reads | Pending | Three repetitions, independently verify records and all costs. |
| Restart/resume + long-chat compaction | Pending | Need running-work recovery and retained objective/evidence. |
| Desktop/mobile agreement | Partial | Desktop Update labeling verified; mobile asset bytes installed, physical mobile UI pending. |
| Matched Claude Code comparisons | Pending | Same model/task/tools; cold/warm/memory-assisted separated. |
| Release-installation parity | Pending | Installed local hotpatch verified; another user's install not yet qualified. |

## Measured cost, not a comparative claim

`acceptance-usage.json`: Claude chat 1 call / 16,110 input / 3 output tokens.
Plan 4 calls (Terra 3, Sol 1) / 49,937 input / 907 output.
Execute 5 calls (Terra 4, Sol 1) / 77,616 input / 505 output.
All three had zero recorded cache reads. These costs motivate a prompt/cache
audit after functional tests; do not claim an efficiency win.

## Next actions

Finish scoped memory recall/correction and soft-forget only exact test facts.
Investigate the measured cache/prompt overhead and any concrete live failures.
Patch only proven fixes, then rerun the affected live scenarios. Preserve all
pending matrix requirements; smoke passes are not whole-harness completion.

## Follow-up: memory framing, cache, and startup

The stable-prompt installed-adapter probe recorded 3,772 input tokens on each
of three identical Terra requests, with cache reads of 0, 0, and 2,816.
`stable-cache-probe.json` demonstrates working cache accounting for this case;
the task-level zero-cache results do not prove the cache is broken.

Explicit-memory extraction now removes a terminal standalone acknowledgment
request while preserving quoted values and standing acknowledgment rules.
All 66 pure extraction checks and the backend build passed. This is not yet a
live durable-queue acceptance pass. Latest installed source fingerprint:
`3321bfbe33a1784e28bf1b655bfd3b0ffce7e7991a74bbc46b639bc8bea8839f`.

At 16:35 UTC the desktop supervisor killed daemon 40684 after its 90-second
readiness deadline. The last daemon log was model-catalog initialization;
the exact blocking startup operation is not established. No memory-framing
retest was submitted. Desktop app control subsequently timed out, preventing
verified relaunch; user was asked to reopen the installed app. Claude sign-in
was already verified and is not this startup failure. Do not reset credentials
or declare the latest patch live-accepted. This documentation update postdates
the installed build.

## Auth availability consistency candidate

Changed `judge-family.ts::claudeAvailable()` to use the same
`getClaudeAuthSnapshot().configured` result as Settings. This removes the
independent rule that treated every stored refresh token as usable. Added
regression assertions covering expired/dead grants, valid fallback, valid
access despite a dead refresh grant, and reauthentication. The fixture suite
was not run against the live home. Backend build passed; a read-only check
against the actual vault reports configured=true, source=vault, and
judgeAvailable=true. This candidate is **not yet hotpatched or accepted in the
running app** because the startup/relaunch blocker persists. Current source
build therefore differs from installed fingerprint 3321bfbe33a1.

## Installed app recovered and memory framing accepted — 17:04 UTC

User reopening launched the different `/Applications/Clementine.app` (3.18.6,
git 32269b1e, fingerprint ba141b7d6c1d), against the same live home. After checking
zero active chat leases, quit that copy and opened the exact user-installed
`~/Applications/Clementine.app`. It successfully booted in about 15 seconds;
the authenticated build-info endpoint confirms 3.18.17 / fingerprint 3321bfbe33a1.
Home visibly loaded with neutral Update rows. The earlier startup timeout's
specific cause remains undiagnosed; the duplicate installation explains the
subsequent older UI, not necessarily the timeout itself.

Live source 237973, session `probe-memory-framing-1789837402144`, promoted fact
3728 with exact content `the Project Memory Capture Orchard 20260919 label is
"Briefly acknowledge."` and conversation provenance. The separate terminal
acknowledgment instruction was excluded. The exact synthetic fact was then
soft-forgotten and active=0 verified. Receipts: `memory-framing-live.json` and
`memory-framing-evidence.json`. This closes this bounded memory-framing bug.
The subsequent auth-consistency source change still needs hotpatch acceptance.

## Auth consistency installed — 17:05 UTC

Built and hotpatched the exact user installation; retained daemon backup
`dist.backup-l7AMm0` and skills backup `builtin-skills.backup-YFafu0`.
Running build-info confirms fingerprint
`2f94e7ae4d14715df44e145b6597b332631ee9ef1299c84612d87377c8a5bfc0`.
Live settings now reports Claude configured=true/source=vault and
brainsAvailable.claude=true, with active brain still codex_oauth.
Receipt: `auth-consistency-live.json`. Healthy connected state is verified;
no deliberate revocation or credential mutation was used to test a dead grant.
All broader pending matrix items remain open. Use the exact app path on each
launch; the older system-wide copy still exists and has not been deleted.

## Live inferred memory integration and recall-question repair

On build 2f94e7ae4d14, the real durable queue rejected task-only candidate
2153059 and retained only the exact standing clause from mixed candidate
2153060. Facts 3729/3730 contain only the future reporting preference, with
source provenance; a fresh session recalled its title and project-only scope.
However, the recall question itself became fact 3731 via the separate
`project requirement signal` heuristic. Facts 3730 and 3731 were soft-forgotten;
3729 was already superseded. Zero active matching synthetic facts remained.
Evidence: `memory-queue-live.json`, `memory-queue-evidence.json`,
`memory-queue-recall.json`, and `memory-queue-cleanup.json`.

Extended the existing durable-scope review to inferred project requirements;
explicit remember/correction paths remain separate. Built and hotpatched
fingerprint `ae58bbc473e10997331e04787f61a80e8599b4798c19e47209f518069a605f62`,
retaining daemon backup `dist.backup-Nys8Yj`. Exact recall-question retest
`probe-queue-recall-fixed-1789837747000` produced candidate 2153121 rejected as
a question, with no resulting fact. Receipt `memory-question-retest.json`.
Positive control candidate 2153122 promoted real future-project requirement
fact 3732 with the exact source clause. Its chat completed, and the active
synthetic facts were soft-forgotten; zero active matching queue/project-test
facts remain. Receipt `project-memory-retest-evidence.json`. These checks
validate bounded behavior, not all memory quality.

## Space/workflow creation and canonical links

Session `sess-desktop-08782ffaec6d7a3336e078a9`, source 238144, created
`harness-orchard-acceptance-20260919` Space and workflow. Space data contains
Plan/Execute/Memory verified, Recovery pending, and a mobile summary. Workflow
saved definition independently inspected: enabled=false, trigger.manual=true,
allowSends=false, one local write_file step with exact newline content. No
proof file exists; it has not been run. Original turn ended blocked (238333)
after repeated identical final replies omitted the requested workflow link.

Follow-up repair completed (238392), with fresh changed-answer reviews at
238386/238388. The judge accepted a fabricated `/workflows/<slug>` URL, but
the app has no such route; its actual drawer route is
`/console/automate?workflow=<encoded saved name>`. Added canonical URL to
workflow commit results and workflow_get metadata/full views. Build passed;
hotpatched fingerprint
`033f970c2eef22f5f543f7ff37cad243ca4cb636c44c101902a4414c000f5a6e`,
backup `dist.backup-6nazkz`. Fresh live chat `probe-workflow-link-1789838248890`
returned the exact canonical URL and correctly reported disabled/manual-only.
Browser verification was unavailable (in-app localhost blocked; Chrome surface
unavailable), so native navigation/rendering remains to be checked.

Receipts: `space-workflow-acceptance.json`, `saved-workflow.json`,
`space-workflow-outcome.json`, `space-workflow-repair-outcome.json`,
`workflow-link-live.json`, `space-workflow-usage.json`. Do not recreate the
existing acceptance artifacts on continuation. Next verify native navigation,
then explicitly run the local workflow and check exact output/recovery.

## Workflow execution blocker — 17:20 UTC

Normal API enable succeeded. First run was refused before queuing because the
author inserted the output directory as a required workspace project, absent
from the inventory. Cleared this unnecessary project dependency via PATCH;
the exact absolute-path write and all other semantics remain unchanged.
Retry queued run `1789838376792-6e3677`, but runtime held it as
blocked_capability: `write_file` not connected, provenNoDispatch=true.
Preflight had explicitly reported that same built-in tool ready. The output
file is absent. Cancelled this exact held test run through its normal endpoint
to stop automatic retry, then disabled the test workflow again; both verified.

Root path: workflow-runner calls ensureReviewedLocalWorkflowCapability, then
the live catalog compiler. The reviewed-local transport supports only artifact
bundles and Workspace datasets. write_file has local planning semantics but
no reviewed local execution contract; it returns not_reviewed and falls into
the external-style not-connected result. This is an actual structured-workflow
execution gap, not missing user authentication. Next implement the real local
file transport/reconciliation contract through the existing workflow kernel;
do not bypass dispatch authority, substitute a manual shell write, or claim
this scenario passed. Keep native link rendering and recovery pending.
Evidence: `workflow-run-acceptance.json`, `workflow-run-retry.json`,
`workflow-execution-blocker.json`.

## Local-file workflow adapter preparation

Extracted the existing registered write_file body as executeLocalFileWrite in
computer-tools.ts and moved its unchanged Zod schema into the storage-free
local-file-write-contract.ts (re-exported for existing callers). Chat still
uses exactly that body. Verified the body/schema match HEAD byte-for-byte
apart from indentation; backend build and diff checks pass. This is preparatory
source work, **not a completed workflow fix and not hotpatched**.

Next extend reviewed-local-tool-transport and the host storage carrier with
the file adapter, retaining manifest identity, safe mode, path guards, and
receipt-based reconciliation. Bare workflow args currently omit mode while
the strict registered schema requires nullable mode: handle canonical default
arguments explicitly before compiling, rather than silently broadening write
authority. Append/overwrite must not inherit create-only authority. Do not
claim content-addressed recovery merely because a file with matching bytes
exists; require the committed revision receipt and verify current bytes.
The installed build remains 033f970c2eef; the saved test is cancelled/disabled.

## Local-file workflow creation passed — 17:30 UTC

Implemented a reviewed create-only file execution contract using the shared
registered writer, through the existing manifest/host-storage/kernel path.
Reconciliation requires the exact encoded committed revision receipt and
current content verification; matching arbitrary file bytes alone do not pass.
Append/overwrite are deliberately not granted by this create-only contract;
their workflow execution support remains open. The shared chat writer retains
all modes and path protections. Two pure contract checks passed without home
fixtures or file writes. Backend build and diff checks pass.

First candidate recognized the capability but exposed the workflow argument
language's null limitation, before dispatch. Normalized only registered no-op
defaults to explicit mode=create / absent append. Installed final fingerprint
`0e2f3b58e1b569e05ca5d156d458ebf10ae40d17a25643606d862f6cf1536abe`,
retained backup `dist.backup-JLJamS`. Exact same saved workflow, run
`1789838990802-4b2152`, completed succeeded. Independent output read equals
`ORCHARD-WORKFLOW-OK\n`; goal validation pass=true, judgeFailedOpen=false.
Installed reconciliation accepted its real receipt and rejected a changed
digest. Test workflow disabled again after success. This is not proof of a
process-crash recovery or every file mode. No isolated-home acceptance used.

Receipts: `workflow-file-adapter-run2.json`, `workflow-file-adapter-result.json`,
`workflow-file-adapter-usage.json`, `file-adapter-contract-tests.txt`.
The usage file found no rows carrying this workflow run ID, despite a goal
judge running. Cost attribution remains incomplete; do not report zero tokens.

## Workflow token attribution candidate — 17:37 UTC

Confirmed live build remains 0e2f3b58e1b5 in ~/Applications, shared branch
main e5a75f5a. Two Sol usage rows during the successful workflow window carry
source=unknown, with no run ID. These remain unassigned; timestamps are not
proof of cost ownership. Traced normal workflow drain: run-level review runs
outside the step harness and has no model usage scope.

Added accounting-only workflow AsyncLocalStorage around each admitted drain
run. recordModelUsage uses that run source only when neither exact accepted
source nor explicit session is available. Step/chat identities retain priority;
no accepted user event is fabricated. Two pure concurrency/nesting checks and
backend build passed. Patch --check reports candidate fingerprint
5a1db3ed4bf9ef0431b1ec98106607b5f214b2fba08016a9a2ae279c94cef1b7.
This candidate is NOT installed or live-accepted: native app control reported
the Mac locked and automatic unlock unavailable. Asked owner to unlock; did
not kill the daemon to bypass normal app shutdown. Last live lease query was
zero, but recheck before stopping.

Next: normal quit, retained-backup hotpatch, exact user-app relaunch, fresh
manual test run with a new proof path (preserve workflow-proof.txt). PATCH
workflow steps through normal API, retaining manual-only/no-sends/goal. Verify
exact bytes, real passing review, and runId on actual model usage rows; disable
test workflow afterward. Evidence: workflow-usage-context-tests.txt and
workflow-usage-build.txt. Documentation changed after candidate build only.

Follow-up: Mac still locked on the next app-control attempt. All 25 pure usage
accounting/context tests now pass, including run-only source parsing into the
existing runId totals. No live-home fixture resets/writes were used by those
tests. Prepared (not applied) workflow-usage-patch-prepared.json with original
steps plus a fresh workflow-usage-proof.txt path. Saved test remains disabled;
live app unchanged. Candidate code unchanged; additional test/docs are newer
than the prepared build. Recheck app idle and source before installation.

## Workflow accounting live acceptance — 17:44 UTC

Mac unlocked; app control restored. Rebuilt because source fingerprint guard
correctly rejected the older candidate after test/docs changes. Normal quit,
installed hotpatch, exact ~/Applications relaunch verified fingerprint
`e738aed5b56e05eee5c3610a8a155fa5f6103ae6d7a3eba565ac66edae13447f`.
Backup dist.backup-4dl4Nr retained. UI assets unchanged.

Applied prepared fresh-path step through normal API, enabled manual-only local
test and queued run `1789839802387-c64cec`. Completed succeeded; goal pass=true,
judgeFailedOpen=false. Independent exact file content check passed. Disabled
workflow afterward. Three actual usage rows (two Sol, one Luna report-back)
now have source workflow:<runId>, kind workflow, and correct runId. Totals:
6153 input, 530 output, 1920 cached input. No accepted user seq invented. This
verifies attribution for this complete workflow, not universal accounting or a
comparative efficiency win. Receipt: workflow-usage-live-result.json.

Native UI: Space renders the four checklist rows (Plan/Execute/Memory verified,
Recovery pending). Its linked workflow button navigated to canonical
/console/automate?workflow=harness-orchard-acceptance-20260919. Final drawer
render still to observe. Space conversation pane says Ready to build despite
the adjacent already-rendered Space; potential misleading empty-state copy
remains. Physical mobile, crash recovery, append/overwrite, repeated reads,
long-chat efficiency and release parity remain open. Keep full goal scope.

## Duplicate create negative acceptance — 17:46 UTC

On installed e738aed5, intentionally reran the local manual test against its
existing workflow-usage-proof.txt, run 1789839908166-b0be00. File SHA256 and
mtime both unchanged. However this is NOT a full pass: run stayed running with
heldExecution recovery_pending. Events 238437–238439 record one dispatch,
provider outcome threw, then uncertain_write/unacknowledged_mutation. No false
success observed, but known refusal becomes indefinite recovery.

Root cause traced: executeLocalFileWrite returns the exact pre-write refusal
`Refused to overwrite existing file:`. executeReviewedLocalFile sees no commit
receipt and throws its generic missing-receipt error, losing known no-write
semantics. Next carry a typed definitive rejection through the existing local
carrier/settlement path; do not convert all thrown writes to known failures or
infer ownership from an existing matching file. Preserve ambiguous I/O failures
as uncertain. Then hotpatch and repeat negative acceptance before crash test.

Cancelled this exact run through normal API and disabled acceptance workflow;
confirmed cancelled, original digest/mtime unchanged. Receipts:
workflow-duplicate-run.json and workflow-duplicate-result.json. No code changed
in this turn. Crash interruption/recovery remains untested.

## Typed duplicate refusal installed — 17:51 UTC

Added nominal LocalFileCreateConflict at the locked revision check, before
file-content mutation. Shared chat writer preserves existing text behavior;
workflow carrier opts to preserve the typed conflict. Workflow kernel recognizes
only that actual class from local_registry as acknowledged failure; ordinary
errors, copied JSON and foreign providers remain uncertain_write. It records
the actual crossing, never fabricates zero-dispatch. Pure nominal/spoof checks
and backend build passed. Installed fingerprint
4bce2d8b81d9081b80de1f0c895bfd1348306f1600c500d07284e58544ff3213,
backup dist.backup-upt7aZ. UI assets unchanged, native app responsive.

Duplicate run 1789840171092-01cedf now terminates blocked, action stop_and_explain,
with exact existing-file refusal and no heldExecution. Original file digest
and mtime unchanged. Receipt workflow-duplicate-fixed-result.json.

Fresh positive run 1789840206490-00b401 wrote the exact requested bytes, but is
NOT full acceptance: goal judge passed existence and rejected content because
it saw only length/digest, not actual bytes. Run nevertheless has completed /
succeeded with goalOutcome=escalate (judge-only advisory path). This exposes
missing content evidence and conflicting status semantics. Prior judged passes
must not establish reliable content verification: digest alone is insufficient.
Next give workflow goal review verified retained artifact content (or exact
content evidence) and reconcile status semantics without hiding the failed
criterion or weakening it. Test workflow disabled, all proof files preserved.
Receipt workflow-conflict-positive-result.json. Crash recovery still pending.

## Verified file evidence and unmet-criterion reporting — 17:56 UTC

Added workflow-file-evidence.ts: reviewer open_evidence on a retained file-write
step reopens only its parsed local revision receipt, verifies current bytes,
and exposes actual UTF-8 (or explicitly labeled base64) content. Tampered
receipt digest returns no content. No arbitrary reviewer path reads, no digest
inference, and large content stays behind the existing bounded offset reader.
Changed goal_validation_unmet to require attention without authorizing replay;
updated the existing assertion. Backend build and diff checks passed. Read-only
live receipt check proved exact bytes and rejected altered digest. Did not run
the isolated-home workflow fixture suite.

Installed fingerprint 710b2dafa6a7e0a746089b4066704eaca50fa051391835826fd1b21f60d67f7b,
backup dist.backup-XRNe4B. Positive run 1789840439632-ebd8f1 independently wrote
exact ORCHARD-WORKFLOW-OK newline; judge passed both criteria and explicitly
cited verified 20-byte UTF-8 content, judgeFailedOpen=false.

Negative control 1789840497993-fb0832 wrote ORCHARD-NEGATIVE-CONTROL newline
while retaining the original goal. Judge identified the exact mismatch and
failed content criterion without failed-open. Engine status completed (steps
finished), terminalOutcome blocked, needsAttention=true. Delivered file remains;
this is no longer clean success. Restored prior positive steps and disabled
the acceptance workflow. No auto-replay observed; maxAttempts remained 1.
Receipts workflow-evidence-{run,result}.json, workflow-evidence-negative-{run,result}.json,
workflow-file-evidence-check.json. Crash recovery and broad acceptance remain
open; this increment verifies file-content review and negative outcome reporting.

## Live process interruption after committed write — 17:58 UTC

No active chat leases or recent running workflows before the test. On installed
710b2dafa6a7, queued manual local run 1789840609758-b2e574 against a fresh
workflow-restart-proof.txt. At status finalizing, after durable successful write
settlement and exact file creation, sent SIGKILL once to the API-verified daemon
PID 97652. Preserved pre-interruption state/receipt/events. Desktop supervisor
automatically restarted the same installed build as PID 4489. Did not requeue
or create a replacement run.

Same run resumed and completed succeeded with goal pass=true, failedOpen=false,
and verified exact content. Across restart there is exactly ONE provider write
dispatch; file digest and mtime unchanged. Three completed model usage rows
carry this run ID. An interrupted in-flight model request may consume provider
cost not reported back; do not claim billing-complete accounting for crashes.
Restored prior steps and disabled acceptance workflow. Receipts:
workflow-restart-run.json and workflow-restart-result.json.

Scope: proves recovery after committed step, during finalization. It does NOT
prove safety in the gap between physical mutation and receipt publication, nor
multi-step/append/overwrite crash recovery. Boot also parked ten OLD pending
runs at its resume cap; no attempts made to resume or reset those runs. Broader
calendar/inbox repetition, long-chat efficiency, mobile and release parity
remain open. No new source change or patch was needed in this test.

## Repeated calendar acceptance stopped on first invalid pass — 18:01 UTC

Live Terra session probe-repeat-calendar-1789840722486, accepted source238471,
requested all Outlook events September19 America/Los_Angeles, read-only. First
exact-day and equivalent UTC calls returned two all-day records ending Sept19
00:00 UTC, outside requested Sept19 07:00UTC–Sept20 07:00UTC range. Judge238512
correctly rejected initial list. Agent then queried the next day (empty), then
Sept19 00:01:00–23:59:59 local (empty). Judge238551 accepted a full-day no-events
answer, terminal238555 done. This is NOT an independently verified full-day
pass: final interval drops first minute/end boundary and provider discrepancy
is unexplained. Do not present the user's full calendar as verified empty.

Accounting: 10 model calls, 166398 input, 2698 output, 40448 cached input for
this single read including repairs/reviews. Four calendar calls plus discovery.
Stopped before repetitions2/3 to investigate known coverage failure and avoid
repeating waste. No external writes/sends. Retained provider payloads inspected
read-only from durable_result_handles; request/response/evidence receipts are
calendar-repeat-1-{request,response,evidence}.json. Next trace whether judge
read evidence includes actual query interval and binds exhaustive claims to
requested scope. Do not solve this by accepting narrower successful queries or
adding a canned Outlook-only prompt. Original three-repeat requirement remains
open alongside inbox/long-chat/mobile/release acceptance.

## Read request scope installed; calendar still fails — 18:06 UTC

sourceSettledReadEvidence previously showed payload/completeness without query
arguments. Added exact sealed-authority scope when available, else explicitly
labeled source/call-bound invocation scope from recorded tool_called events.
Legacy Composio reads have no sealed authority payload; they are not mislabeled
as reconstructed wire arguments. Scope is shown even for deduplicated payloads.
Live historical replay confirms all four ranges, including shortened last
range, survive. Build/diff passed. Installed fingerprint
925bbd01fa117ddc8e95e0ae79be9f86ba37d0f3594662bbff243cb11c00be00,
backup dist.backup-0C4kBo, healthy daemon checked before request.

Fresh identical request probe-calendar-scope-fixed-1789841083930 made one full
Sept19 local-day calendar call. Provider again returned two events spanning
Sept18 00:00UTC to Sept19 00:00UTC, outside requested day. Agent listed both as
Sept19 events; judge238597 accepted. Independent verification FAILS. Scope
visibility is useful but NOT a fix for the calendar failure. 4 model calls,
52272 input, 6656 cached,384 output; lower cost is not an efficiency win because
answer is wrong. Next trace provider dispatch/cache/date boundary discrepancy
and record-scope review, avoiding blanket trusts in successful query filters.
No writes/sends. Receipts calendar-scope-fixed-{request,response,evidence}.json
and calendar-scope-replay.txt. Three passing repetitions remain unfulfilled.

## Independent Graph comparison — provider returns same boundary records

Traced prepared dispatch: args are structuredClone'd and passed unchanged as
state.args to raw SDK tools.execute; result returns raw data. No local calendar
date transformation or read-result cache found in this path. Read-only direct
Microsoft Graph /v1.0/me/calendarView through configured Composio proxy, using
the same bound Scorpion connection ca_uDzrJqqniJFk, requested exact
2026-09-19T07:00:00Z through 2026-09-20T07:00:00Z with select=id,subject,start,end,isAllDay.
HTTP200 returned the SAME two all-day records with start Sept18 00:00UTC and
end Sept19 00:00UTC, no nextLink. Receipt calendar-direct-graph.json.

The first proxy attempt used raw-client snake_case account key against core's
camelCase API and returned missing-auth-context400 before a Graph result;
corrected after inspecting installed core implementation. No credential change,
CLI login, calendar edit, or message sent. Do not blame Clem serialization or
Composio's generated calendar tool for a discrepancy reproduced by direct
Graph proxy. Whether this is Graph all-day boundary semantics or another
upstream issue remains unproven. The reliable finding is that returned record
timestamps contradict treating them as events on the requested day. Next
ensure review checks record scope rather than treating query success as scope
proof; preserve raw evidence and report unresolved provider contradictions.

## Scope interpretation guidance and retained-call truncation — 18:13 UTC

Added shared READ_SCOPE_EVIDENCE_RUBRIC to all three brain rubric arrays and
completion judge: filtered request success is not proof returned records match;
compare dates/boundaries/timezones/account/filter, do not shrink range, report
provider inconsistencies. No extra judge call added. Built/hotpatched
c801e753e136ec0daed86581b4ae0b1f4f5c639a7de962986507a95342cc720f,
backup dist.backup-tMaxN3, live build verified.

Identical request probe-calendar-interpretation-1789841462282 source238602
selected OUTLOOK_GET_CALENDAR_VIEW. Brain noticed two events ending before the
requested date but still claimed no events. Judges238656/238658 blocked on
missing request-range evidence; final response includes a verification-failed
note. NOT a passing calendar result. Nine model calls,105238 input,23552 cached,
1108 output. Receipts calendar-interpretation-{request,response,evidence}.json.

Found why scope unavailable: composio_execute_tool mirror truncates args at300
characters. Exact source/call's enclosing work_call contains full638-character
invocation. Added a narrowly discriminated fallback to unwrap only recorded
work_call args_json/name before normalizing; never unwrap arbitrary result
fields. Read-only replay of this exact source now exposes both exact boundaries.
Backend build passed, but this LAST fallback change is NOT hotpatched yet.
Candidate build output read-scope-outer-build.txt; evidence calendar-outer-scope-replay.txt.
Installed remains c801e753. Rebuild after this doc edit before next patch, then
live retest. Scope visibility and honest failure improved; three successful
repeats and efficiency goals remain unresolved. Do not claim that the judge
actually assessed the returned-date contradiction in this latest run: its
recorded rejection was missing scope, not that contradiction.

## Installed scope fallback and repeatability audit — 18:23 UTC

Hotpatched recorded outer work_call scope fallback; current running installed
fingerprint 976d1e35fa441e5d0e89c184befa0cf6eb233a0a4382829395fb6104ee239708,
backup dist.backup-XdIo16. Rechecked actual packaged entry, main/e5a75f5a,
and active Codex brain; shared usage-sidecar edits preserved. No other active
Codex task appeared in the current task inventory. Claude vault configured.

Three identical full-day calendar prompts on this fingerprint:
- probe-calendar-outer-scope-1789841704402/source238663: GET with explicit
  America/Los_Angeles response timezone, select and top100. Complete two-record
  response shows Sept18 midnight through Sept19 midnight in that timezone.
  Answer excludes boundary-ending records, explains why, and says no events.
  Judge238704 accepts. Four calls,48843 input,16896 cached,390 output.
  Independently matches interval exclusion, but not universal upstream correctness.
- probe-calendar-full-repeat-2-1789841992477/source238709: GET omits timezone
  and select; same read repeated then deprecated LIST used. UTC records end
  Sept19 midnight UTC. Honest uncertain answer, judge238784 blocked.
  Nine calls,130136 input,16384 cached,1574 output.
- probe-calendar-full-repeat-3-1789842062740/source238789: LIST returns the same
  UTC records. Initial wrong-day times rejected by judge238829; corrected answer
  excludes them but asserts none. Fresh judge238831 rejects unresolved provider
  inconsistency. Six calls,85862 input,27648 cached,1123 output.

NOT three passing repeats. Results depend on selected operation, response
projection/timezone and interpretation. No calendar writes or external sends.
Receipt families calendar-outer-scope-* and calendar-full-repeat-{2,3}-* contain
requests, actual responses, full durable read payloads, events and usage.
The latter evidence results include string-encoded discovery payloads; parse
only when needed and avoid printing unrelated private calendar fields.

Next work: resolve calendar boundary/timezone semantics with authoritative
provider evidence rather than adding another generic uncertainty instruction.
Investigate discovery overhead: repeat2 returned unrelated Airtable create and
calendar create tools before the desired calendar read. Preserve capability
availability while measuring ranking and projection improvements. Prompt
component estimates are not provider-token truth; totals above use actual usage.
No overall efficiency/release-readiness claim. Broader acceptance remains open.

## Calendar semantics and discovery ordering — 18:26 UTC

Microsoft calendarView documentation confirms request offsets control the search
range; Prefer outlook.timezone controls returned representation, default UTC.
Source: https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0
Direct Graph proxy with identical full-day UTC range and explicit Pacific
Standard Time header returned the same two all-day records at local midnight
Sept18 to local midnight Sept19, with preference-applied confirmed. These are
calendar-date representations: do not blindly convert the prior UTC labels to
5pm appointments. This reproduces the timezone behavior upstream of Clem's
calendar tool. Raw receipt calendar-direct-graph-local-zone.json. Documentation
alone does not explain boundary inclusion or prove the full scenario accepted.

Live read-only discovery replay found AIRTABLE_CREATE_RECORDS score -11 with
providerRecommendedSuccessor=true ranked ahead of requested Outlook tools.
Both broker and merged catalog prioritized successors regardless of namespace.
Changed merged ordering so explicit provider namespace precedes lifecycle bonus;
same-provider successor priority and all capability visibility remain intact.
Focused handler regression passes without fixtures/resets or model calls, using
live-home test opt-in. This is candidate code, not yet installed at this entry.
Receipt calendar-discovery-broker-replay.json; new test
src/tools/tool-search-namespace-successor.test.ts. Calendar acceptance remains open.

## Namespace ordering hotpatched and live retested — 18:28 UTC

Installed/running fingerprint
5afeec88055eab274cedfe67aa81fac7dc94501e3ab3ecb048c5e54d77c4c8f6,
backup dist.backup-nyKt5U. Backend build and focused handler test passed; UI
assets unchanged. Checked zero active run leases before normal app quit.
App relaunched and actual build-info verified before live request.

probe-calendar-namespace-1789842403289/source238836 repeats the unchanged user
calendar prompt. Discovery query wording varied naturally. One discovery and
one calendar read, surfaced OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW first. Final
answer discloses out-of-range all-day records and uncertainty; judges238877
and238879 reject completion. Six calls,82330 input,23552 cached,2088 output.
NOT calendar acceptance and NOT a controlled efficiency comparison.
Receipts calendar-namespace-{request,response,evidence}.json.

Installed-module replay with the captured exact broker candidates and query
moves AIRTABLE_CREATE_RECORDS from unconditional first to position12, behind
all11 Outlook candidates, without hiding it. The broker capture contains no
calendar-read candidate, so this proves namespace ordering only, not complete
semantic read/write ranking. Receipt calendar-installed-ranking-replay.json.
The live full broker obtains additional candidates from the index. Remaining
work includes semantic operation relevance and all-day interpretation.

Desktop Automate visually renders workflow cards, but native accessibility
state exposed only shell controls after navigation (confirmed screenshot and
full AX tree). Saved-workflow drawer validation remains pending; no workflow
was enabled or run during this navigation check. Investigate accessibility
rather than claiming this screen passed.

## Correcting overbroad scope guidance — candidate

Repeated failures show our recent shared scope rubric conflated extra records
with incomplete query coverage. Judges explicitly demanded uncertainty merely
because complete correctly scoped reads returned non-overlapping records. That
is stronger than the evidence supports. Replaced the blanket inconsistency
instruction with separate coverage and membership checks: exact account/range,
filters/pagination remain required; demonstrably out-of-scope rows may be excluded;
extra rows alone do not force retry or imply missing records. All-day calendar
dates must not be presented as converted clock-time appointments. Actual
unresolved coverage/interpretation still requires specific uncertainty.
This does not hardcode this date, provider, result or answer. Live validation
must still reject narrowed queries and wrong-day inclusion; pending installation.

## Coverage/membership correction installed — 18:32 UTC

Installed fingerprint f0fab9622237c559e12d43dab8924c82bb9f95b67399f25f116b9f3fce52c7a7,
backup dist.backup-KCPQH1. Backend build passed; no UI assets changed. Actual
build-info checked before live request. Zero active run leases before quit.

Three synthetic reviewer controls through installed objective-judge module,
using actual configured Sol, all behaved as expected, none failed open:
complete full-range boundary-only result accepted; noon-to-midnight-only query
rejected for missing the morning; wrong-day inclusion rejected. These are
reviewer controls, not actual calendar reads. Receipt
coverage-membership-review-controls.json. Their direct calls are not attributed
to a chat accepted source; do not mix them into calendar chat totals.

First live unchanged request probe-coverage-membership-1-1789842686400 passes
judge238925. Actual GET arguments span midnight Sept19 through midnightSept20
with -07:00 and America/Los_Angeles response timezone; top1000, selective fields,
next_page_token null. Two all-day Sept18-to-Sept19 midnight records excluded;
answer correctly reports none. Four calls,48215 input,16896 cached,482 output.
Further repeats running separately; this is not yet three passes.

Native desktop Space workflow link now independently verified end-to-end:
clicked Harness Orchard Acceptance 20260919, clicked its workflow, reached
/console/automate?workflow=harness-orchard-acceptance-20260919 with correct drawer
heading, disabled toggle, manual trigger, and exact existing write-proof step.
Screenshot confirms rendered drawer and footer. No Enable/Run action taken.
This closes the pending desktop deep-link/drawer check; physical mobile and
broader UX remain open. Earlier shell-only AX observation on Automate does not
prove a permanent missing-content bug: this drawer and Space expose full AX.

## Three calendar repeats passed — 18:34 UTC

All three identical full user requests on f0fab962 now pass actual Sol completion
review (no failed-open), with independent inspection of exact full-day query,
complete null-pagination result and excluded midnight-ending all-day records:
1. source238884 / judge238925: 4 calls,48215 input,16896 cached,482 output.
2. source238930 / judge238970: 4 calls,52656 input,16896 cached,504 output.
3. source238975 / judge239027: 5 calls,75934 input,22528 cached,579 output.
Receipt families coverage-membership-{1,2,3}-{request,response,evidence}.json.
All actual brains Terra, judges Sol. Verified read receipts target the same
Scorpion mailbox/tenant. Third run used another existing connection to that
same identity; no account configuration changed. Accounts evidence saved in
coverage-membership-accounts.json. No calendar writes or external sends.

This closes the specifically requested repeated calendar-read scenario, not all
calendar behavior. Third run's first discovery page had only local unrelated
candidates, requiring another exact tool search. All three used explicit local
response timezone and complete selected results; other temporal cases remain
unqualified. Negative reviewer controls ensure no automatic green on incomplete
coverage or wrong-day inclusion. Earlier rubric was too strict; this correction
removes unsupported uncertainty rather than weakening actual scope checks.

Efficiency remains materially open. Actual wire-prefix logs show 35726 bytes of
18 tool schemas, including plan_task10384,run_worker4575,work_call4232, plus6296
instruction bytes and a15651-byte system input in the third run. These are bytes,
not measured token allocations. Next inspect these measured components before
optimizing; do not cut capability access or memory blindly. Inbox repeats,
long-chat/memory/recovery/mobile/release and matched benchmark work remain open.

## Three live inbox repeats passed — 18:39 UTC

Installed f0fab962 unchanged. Identical read-only request: latest five Scorpion
Outlook Inbox messages, newest first, sender/subject/received time in Los Angeles,
explicitly no mark-read/move/change/send. All actual Terra, Sol judges accepted
without failed-open. Independently checked exact Inbox/top5/orderby descending,
Scorpion read-receipt identity, five distinct returned messages, subjects/sender
names and Intl-converted local times in replies. A next-page token is expected
and not a completeness gap for the requested latest five. No mutation calls.

- source239032 judge239083: 6 calls,99662 input,14848 cached,747 output.
- source239088 judge239129: 4 calls,54982 input,0 cached,426 output.
- source239134 judge239174: 4 calls,54606 input,7680 cached,484 output.
Receipts inbox-repeat-{1,2,3}-{request,response,evidence}.json and
inbox-independent-verification.json. Verification initially assumed scalar
orderby; LIST uses a one-element array. Corrected the verifier to normalize
both exact equivalent schema forms; actual requests were valid.

Efficiency diagnosis: run1 discovery_source_outcome shows Composio count0,
elapsed10022ms, timed_out/answered after deadline. First page contains unrelated
local tools; second local page loses the unavailable-source notice and leads to
generic Composio dispatch. Runs2/3 reach LIST_MESSAGES directly. Run2 source
returned one candidate in3233ms. No blanket comparative efficiency win.

Source has a10000ms search deadline and only100ms provider return margin before
merging/scoring indexed hints. Investigate deadline processing and retained-page
outage metadata before changing timeouts or introducing more model decisions.
Measured wire overhead also includes a large per-turn memory/system context at
the input tail. Moving it blindly to the front could reduce within-turn cost but
break long-chat prefix reuse across turns; no such change made. Tool schema
bulk is mainly typed plan_task/run_worker/work_call. Preserve capability access
and useful memory rather than pruning based on this simple-read case.

Calendar/inbox repeat requirements now have bounded live evidence. Broader
memory quality, long-chat compaction, mutation recovery, mobile, matched-model
benchmark, and release parity remain open. No new hotpatch in this interval.

## Discovery outage continuity — candidate and timing probe

Confirmed deferred_tool_search_page_v1 serialized candidates/query/account but
not unavailable-source metadata. Restored typed optional unavailable metadata
(including existing dependency subject) into retained pages, initializing each
continued page from it. Old cursors without this field remain compatible. No
new discovery, permission, timeout or authority path added.
Focused no-reset handler tests: two passed (namespace priority and three-page
outage continuity). Failure is simulated only in the in-process test adapter;
no live connection is broken or credentials changed.

Read-only provider-source timing probe of the exact slow inbox query now returns
OUTLOOK_LIST_MESSAGES in369ms,9631ms before deadline, using current learned
state. CPU profile/compact result: discovery-profile.cpuprofile and
discovery-profile-result.json. This does NOT reproduce or explain the earlier
10022ms timeout, and does not prove all cold queries fast. Kept existing timeout
and100ms return margin unchanged rather than tuning from one outlier.
Pending build/hotpatch and installed paging replay plus live inbox check.

## Discovery paging patch live — 18:44 UTC

Installed fingerprint c2abc4b709b80df4b7da6c8982d42b774305c9fa0caf372036d70fcf7cd59e95,
backup dist.backup-WGH7MC. Build passed, zero active leases before normal quit,
actual installed identity checked. Installed module replay passes three-page
outage retention with only one search per source (synthetic adapter; no live
provider disruption). Live unchanged inbox request source239179 judged239220
passes and independently verified five sender/subject/time/order/account results.
Four calls,52116 input,2560 cached,421 output. No edits/sends. Receipt family
inbox-paging-patch-* and inbox-paging-independent-verification.json. This live
read did not trigger a provider timeout, so do not claim a measured outage
recovery improvement from it. Timeout/return-margin unchanged.

Next long-chat work can reuse actual acceptance conversation
sess-desktop-08782ffaec6d7a3336e078a9. In-flight compaction238382 collapsed12
pairs from35475 to5779 estimated tokens, retained8 pairs; later corrected result
passed judge238388. This establishes prior compaction execution, not current
post-compaction recall fidelity. Verify original requested checklist/proof text
through a follow-up on the current build without reading saved artifacts or
recreating/running the workflow. Broad long-horizon behavior remains open.

## Post-compaction continuity and exact result recovery passed — 18:48 UTC

Current installed c2abc4b7 unchanged. Used original live acceptance conversation
sess-desktop-08782ffaec6d7a3336e078a9, whose compaction238382 is recorded above.
No synthetic history insertion, isolated home, fixture reset, or current artifact
read. Follow-up source239225 exactly recalled original checklist labels/statuses,
proof content/newline, ORIGINAL workflow-proof.txt destination (not later changed
workflow-evidence-proof.txt), manual/disabled/no-run and local/no-external limits.
Zero tools,2 actual model calls,31685 input; Sol review passed.
Receipts post-compaction-recall-{request,response,evidence}.json.

Harder source239248 requested exact original creation digests, values only
previous tool results had supplied. Clem called recall_tool_result for exactly
call_gU1QuhoLiPgtCPabyazFGsSB (space_save) and
call_S3K2WgaWs5yWbPmOxInnUoKP (workflow_create), then returned both exact64-hex
digests. Independently compared against original durable_result_handles and
verified no current-file/Space/workflow reads or mutations. Sol judge239280
accepted, no failed-open.4 calls,77510 input,7680 cached,228 output.
Receipts compacted-result-recovery-* and compacted-result-independent-verification.json.
This proves original requirements and exact retained-tool evidence survive this
actual compacted conversation across restarts. It does not qualify arbitrarily
long histories, all compaction layers, or general memory retrieval quality.

Mobile read-only status shows existing iPhone sessions, latest seen Sept18;
public mobile target configured. Secrets/PIN not printed. No available phone
mirroring app appeared in CUA app inventory. Asked asynchronously whether user
prefers a short physical-phone check or can make iPhone Mirroring available.
Do not treat no reply as completion or as a blocker for remaining harness work.

Inspected file workflow adapter: remains explicitly create-only. Underlying
local-file revision primitive supports append/overwrite, but simply widening
adapter modes would not prove crash-safe once-only append across a mutation /
receipt gap. No mode support claim or code change made. Broader recovery,
long-horizon performance, memory quality, physical mobile, matched comparison
and release parity still open.

## Durable file operation identity — candidate

File revision journal previously had content/previous bytes but no exact workflow
occurrence identity. Added optional host-only operationKey, derived in the file
workflow carrier from existing call-bound dispatch lease (session/source/root/
logical call). It is not exposed in model tool arguments. Journal stores the
request digest and prior descriptor digest before mutation. A matching replay
verifies immutable prepared metadata, current target bytes and descriptor lineage,
then repairs ONLY current receipt publication if necessary. It never rewrites or
appends target bytes on replay. Different payloads, intervening edits or newer
revisions refuse without changing file content. Ordinary calls without key retain
existing behavior. Workflow adapter is still create-only; kernel automatic
reconciliation integration is NOT implemented yet.

Actual live-home primitive checks, only newly named acceptance output files:
create replay preserves mtime, different payload rejected, append once, stale
create rejected, overwrite replay, stale append rejected. Six passed.
Child-process crash checks intercept receipt rename and exit86 AFTER target
mutation, BEFORE current.json publication. Create/append/overwrite recover their
receipt without changing mtime or duplicating append; an intervening editor
change is preserved and recovery refused. Four passed. No daemon killed and no
live-home reset/deletion; all journal/proof files retained. These tests currently
use source code, not installed bytes. Scripts/receipts file-operation-replay-check,
file-operation-crash-check, check-file-operation-crash.mjs under acceptance output.
Next build/hotpatch, repeat against installed module, then live workflow verify
call-bound operation metadata. Full interrupted-workflow recovery remains open.

## File operation journal hotpatched and verified — 18:56 UTC

Installed fingerprint d826aee7610437fc949731c5c49f167e120f792312df66a2704b52c147de69a9,
backup dist.backup-aPvCpL. Initial build caught optional-operation narrowing;
added explicit presence guard, rebuilt successfully. Zero active leases before
normal app quit; UI unchanged. Repeated four child-process crash checks against
INSTALLED local-file-revision.js in actual live home: all passed. Source-only
receipt preserved separately in file-operation-crash-source-check.json; installed
receipt is file-operation-crash-check.json. Tests create only uniquely named
acceptance files and preserve all revision journals, including crash remnants.

Live dedicated workflow run1789844130877-14ab40 wrote exact20-byte proof file,
completed/succeeded with both criteria true and judgeFailedOpen=false. Actual
current.json includes host occurrence key. Independently joined its session,
source239286, acceptedTaskId and logicalToolCallId to exactly one returned
physical_dispatches row. Proof: workflow-operation-{run,result}.json and
workflow-operation-identity-check.json. Original workflow steps restored and
workflow disabled after terminal result; no sends or schedules.

LIMIT: kernel still stops unknown prior crossings instead of using this new
journal. The journal makes exact recovery possible; it does not yet auto-resume
an interrupted workflow. Workflow adapter still admits only create, despite
primitive append/overwrite replay checks. Next integrate reconciliation without
redispatch and verify a full workflow interruption in the mutation/settlement
gap. Do not label whole recovery/append support complete. Recovery also refuses
when a prepared operation has not landed or a newer descriptor/editor change
supersedes it; no speculative rewrite or overwrite occurs.

## Recovery-only primitive — 19:01 UTC candidate

Rechecked shared main and installed d826aee fingerprint, live Claude configured
through vault. No other active Codex task shown; shared dirty edits preserved.
Added recoverLocalFileRevision as a distinct host entry point sharing the exact
operation verification logic. Unlike commitLocalFileRevision it refuses missing
operation evidence before any target mutation. This is required before a
workflow reconciler can inspect an uncertain crossing without retrying a write.
Backend build passed. Six SOURCE checks in real live home, only uniquely named
acceptance files: crash after target mutation for create/append/overwrite recovers
receipt with target mtime unchanged; intervening editor bytes preserved; missing
operation never creates target; wrong operation never overwrites existing target.
Receipt file-recovery-only-check.json; script check-file-recovery-only.mjs.
Not hotpatched yet: installed app remains d826aee. No full workflow recovery claim.

Integration constraint confirmed: workflow call leases deliberately have null
run_attempt_id and physical io_owner is activation identity, not a live process
owner. Therefore neither alone proves the original executor stopped. A recovery
path must handle concurrent reentry without racing original settlement; do not
interpret old claim age as death or simply invoke the normal file writer again.
Next integrate recovery-only evidence and exact deterministic result settlement
under workflow ownership, then installed/live mutation-gap acceptance.

## Workflow file recovery integration — candidate

The file adapter now returns a stable receipt payload for both original and
recovered calls. Recovery-only execution retains normal path restrictions and
skips deliverable side effects. Reviewed arguments are revalidated. V3 file calls
serialize execution AND settlement with the existing process-owned file lock,
keyed by activation. Existing lock liveness checks refuse to steal a living PID.
After an already-claimed physical crossing with no logical settlement, only
this locked file path may recover exact landed evidence and settle it without
calling the business port. Missing evidence stays unknown. Previously settled
uncertain_write records remain held; no broad reconciliation claim.

Backend build and subsequent typecheck passed. Source carrier check in live home
with synthetic dispatch context verifies original/recovered payload equality,
unchanged target mtime, and missing-operation refusal. This is a carrier check,
NOT workflow-authority acceptance. Receipt file-carrier-recovery-check.json.
Next hotpatch candidate and run real workflow, then controlled full interruption.

## Installed recovery candidate: live regression caught

Hotpatched 4290f086f035593b097fc09d6331f8254c48709cd2351e762d3c38c30eb63c4b,
backup dist.backup-yBro1G. Six installed recovery-only primitive checks passed.
Real workflow1789844749091-35db83 wrote correct bytes, but final judge blocked:
stable receipt-only payload had removed the requested target path, so path
criterion lacked visible evidence. This is NOT acceptance success. Workflow
restored and disabled. Correcting canonical payload to include path and length
identically for original/recovery, then rebuilding and retesting.

## Corrected recovery integration installed — 19:08 UTC

Installed fingerprint901d923221cb984ea8d70332ee0f628f9a4ed45752d12a0139f472ccf6316790,
backup dist.backup-txn3x1. Stable adapter payload now includes requested path and
character count plus verified receipt. Source carrier equality/mtime/refusal
check passed again. Six crash/recovery-only primitive checks passed against
installed module in live home; file-recovery-only-check.json records module path.
Installed kernel inspected and includes locked recovery branch.

Actual workflow1789844852207-b46f63 completed/succeeded. Both path and exact20-byte
content criteria pass, judgeFailedOpen=false. Dedicated workflow disabled and
original steps restored after terminal. Receipts workflow-recovery-path-{start,
result,before}.json. Earlier failed candidate retained in workflow-recovery-patch-*.
This proves normal installed workflow behavior after integration, NOT full
mutation-gap workflow recovery. Next verify exact interruption and concurrent
reentry end to end. Previously settled uncertain_write recovery and workflow
append/overwrite admission remain open. No global models, auth, sidecar changes.

## Real installed-app mutation/receipt gap recovered — 19:10 UTC

Full installed daemon test (not isolated home, not just imported primitive):
used temporary NODE_OPTIONS preload through desktop supervisor's normal live
.env baseline. Preload limited to primary installed daemon and ONE unique proof
file's current.json publication. It verified exact proof bytes, retained marker
and mtime, then SIGKILLed daemon52201 before receipt rename. Temporary startup
setting was removed as soon as preload loaded, BEFORE triggering workflow.
No existing NODE_OPTIONS was replaced. No fixture resets or installed-byte edits.

Supervisor automatically restarted daemon53329, same installed901d923 fingerprint.
SAME run1789844999692-c0778f resumed and completed/succeeded. Final judge passed
both criteria, judgeFailedOpen=false. Independent verification proves target
bytes AND mtime unchanged, current receipt recovered, exactly ONE physical
crossing returned, new daemon PID, temporary startup setting absent. Dedicated
workflow disabled and original steps restored after terminal.

Evidence: workflow-live-gap-independent-verification.json, workflow-live-gap-
{start,result,before}.json, live-gap-test-config.json, one-shot hook/marker/ready
files and scripts prepare-live-gap-test.mjs/run-workflow-live-gap.mjs under
acceptance output. Hook is inert on disk; restarted process did not inherit it.
This proves create-file workflow recovery at the target-write / receipt-publish
gap in the real installed app. Does not prove uncertain_write settlement repair,
concurrent calls, multi-step recovery, or workflow append/overwrite support.
Next extend supported revision modes and exercise their exact recovery boundaries,
then return to measured overhead/memory/UI requirements still open.

## Explicit workflow file revision modes — candidate

Registry's file execution adapter is now local_file_revision_v1, with reversible
planning semantics for create/append/overwrite and both destination postures.
Exact mode and append-flag precedence remain in the frozen registered schema;
missing/null mode defaults to create. No arbitrary string modes or extra keys.
Existing append/overwrite planning variants remain. Underlying journal retains
prior bytes and exact operation identity; recovery-only path never reapplies.
This changes the reviewed manifest identity intentionally; no in-flight workflow
from the prior acceptance test remained when preparing this candidate.

Two pure contract checks passed in live-home opt-in (no writes/reset fixtures).
First invocation used wrong opt-in spelling and config refused before execution;
corrected invocation passed. Backend build passed. Awaiting carrier mode checks,
then patch and real append/overwrite workflows with controlled interruptions.

## Append/overwrite installed acceptance — 19:15 UTC

Installed fingerprint79c9335fc1010b99e867d5de123cf0236b319572b282cb4ad25680e82dd6b0ad,
backup dist.backup-gkpmxO. Repeated both pure contract checks against installed
modules: passed. Source carrier append/overwrite replay payload equality,
unchanged mtime and missing-operation refusal passed. Real installed workflows:
append1789845293287-f323e1 and overwrite1789845316660-05872e both completed /
succeeded, goal pass=true and judgeFailedOpen=false. Started each with BEFORE\n;
append preserves prefix and appends proof once, overwrite yields proof only.
Independent current-journal inspection verifies exact entire content, retained
BEFORE\n bytes for BOTH revisions, and bound host operation keys. Dedicated
workflow restored (steps AND goal) and disabled after terminal tests.
Evidence workflow-{append,overwrite}-{start,result}.json,
workflow-file-modes-independent-verification.json, installed-file-revision-
contract.log. Manifest supersession worked on installed startup/new runs.
Full daemon crash-gap acceptance for append/overwrite remains next; create's
full crash test was on prior901d923 build. No blanket recovery completion claim.

## Installed append/overwrite crash recovery verified — 19:19 UTC

Installed79c9335 fingerprint, live home, real supervised daemon. One-shot scoped
preload per unique target killed daemon AFTER changed file bytes landed and
BEFORE current receipt publication. Original .env NODE_OPTIONS absent; temporary
setting removed after each preload loaded, before workflow trigger. No reset,
installed-byte edits or global model changes. Hook files retained inert.

Append run1789845455676-9966de: crashed67853, restarted69375; completed/succeeded,
review pass=true failedOpen=false. Entire content BEFORE\nORCHARD-WORKFLOW-OK\n.
Overwrite run1789845526086-b4e37d: likewise recovered and completed/succeeded,
review pass=true failedOpen=false, content ORCHARD-WORKFLOW-OK\n. Both independent
verifications prove same target mtime across crash/recovery, exact full contents,
BEFORE\n retained in prior-byte journal, current receipt published, exactly one
physical crossing returned, changed daemon PID, identical installed fingerprint,
and no remaining temporary startup setting. Workflow disabled/restored steps and
goal after both. First append starter attempted readiness GET before bind and
received ECONNREFUSED; no run was submitted, daemon was NOT restarted for it.

Evidence workflow-gap-{append,overwrite}-{start,result,verification}.json,
gap-{append,overwrite}-config.json and scoped markers/hooks; scripts
prepare-revision-gap.mjs, run-workflow-revision-gap.mjs, verify-revision-gap.mjs.
This closes bounded real-app mutation/receipt-gap recovery for explicit create,
append and overwrite. Other gaps (pre-write, settled uncertain outcomes,
concurrency, multi-step) and overall harness goals remain unqualified.
Next prioritize measured token/prompt overhead and memory/long-chat quality;
physical phone acceptance, matched benchmark and release parity remain open.

## Prompt efficiency investigation — candidate

Fresh installed79c9335 inbox baseline: efficiency-baseline-1 evidence records4calls,
56171input,13312cached,428output; actualTerra with Solreview passed. No efficiency
win inferred from this baseline. Authoritative source is in evidence events.

Wire logs showed repeated sliding compaction replacing early ledger bytes during
history recall calls while toolsSha stayed fixed. Registry supportsPromptCache
false on Codex means no EXPLICIT markers, although actual responses cache.
Existing inFlightCompactionThresholds used that flag to disable frozen ledgers.
Candidate selects existing stable-checkpoint compaction for retryClass=codex,
while preserving EVERY numeric threshold/retained budget and explicit overrides.
Claude and unknown model policy unchanged. Source versus installed comparison
confirms Terra/Luna/Sol only switch checkpointed false→true (32000 trigger,
20000 retained budget, min3/max8 unchanged). Codex checkpoint policy tests pass:
explicit overrides; repeated frames change only at new checkpoints; input history
unchanged. Pure synthetic shape test has no session or DB writes; initial version
with fake session refused to compact absent durable evidence, correctly. Fixed
fixture to test pure shape path. No destructive fixture suite run.
Backend build passed. NOT hotpatched yet. A before-patch history-recall probe is
running/recorded as compaction-efficiency-baseline. Need hotpatch and real
long-chat comparison with exact recall verification; no savings claim yet.

Before-patch history probe source239385 returned both exact original digests,
3modelcalls,56403input,7680cached, Sol pass. It emitted NO compaction events,
so this request does not exercise the changed policy and cannot establish a
before/after compaction saving. Preserve this as recall baseline only. Need a
controlled multi-read workload that actually crosses the32000 result threshold
before patching/comparing. Do not mislabel a small repeat as efficiency proof.

## Controlled compaction workload

Created twelve synthetic local audit text files (~29.5KB each) under acceptance
output/compaction-workload, with24 exact beginning/end codes and fixed prompt.
Prompt requires complete read_file reads(max_chars40000), one at a time in order,
then exact24codes. This is deliberate pressure testing, not a user-task benchmark
or evidence of ClaudeCode superiority. Original files/prompt reused unchanged.
Before-patch79c9335 request compaction-workload-before crossed compaction threshold
(condenser_applied observed), unlike earlier small recall. Await terminal and
independent verification. Verifier records source-attributed usage, exact codes,
compaction events, tool calls and judge outcomes. Full logs retained locally.

## Stable compaction installed and pressure-tested — 19:35 UTC

Hotpatched20d6793f4c247447ee5be60d9ab87fd929bd218a490800b2ecf4e74603f10e65,
backup dist.backup-n38cB8. Both focused policy/shape tests passed against installed
module in live home. No increased thresholds or explicit provider cache markers.

Before79c9335 source239420 read all12files, then repeated exact recall arguments
3–4times across12groups. Recalled payloads DID contain correct closing codes.
Stopped ONLY that exact test attempt via normal cancel endpoint; finished_at
confirmed. Reported58modelcalls,1276607input,414208cached,4257output;55toolcalls.
No final successful answer: this is a censored failure baseline, not equal completed
work. Receipt compaction-workload-before-cancelled-evidence.json. General read
harness postprocessing initially assumed all retained text was JSON and failed
AFTER response save; corrected helper to retain non-JSON text. Actual request
was not resubmitted; DB/usage audit independently preserved full evidence.

After20d6793 source239863 completed:27modelcalls,706829input,56320cached,2204output;
22toolcalls. Five stable checkpoints at unchanged32000 pressure threshold.
All24codes independently match original files. Exactly12read_file calls, correct
ordered paths/max_chars40000; each result precedes next read. Goal review fulfills
true (no failedOpen true). Evidence compaction-workload-after-{request,response,
evidence,independent,execution-check}.json. A scoped monitoring script would stop
three groups of duplicate recalls; it observed normal terminal, did not cancel.

This is one controlled synthetic pressure case, not a broad benchmark win or
ClaudeCode comparison. Completion improved versus observed repeating baseline;
reported uncached input650509 versus862399 before cancellation. Cache HIT SHARE
was LOWER after (~8% versus~32%); do not claim prefix cache improvement from this
run. Remaining prompt/tool churn and dynamic memory context still need work.
Full original memory/UI/mobile/release goals remain open.

## Efficiency attribution correction and preview defect

Further wire audit: before pressure run had17tools/36528bytes, including plan_task
and work_call; after had15tools/19960bytes with those controls absent after restart.
Thus pressure runs are NOT matched toolsets; lower cost cannot be attributed
entirely to compaction. Both kept stable tool hashes within the first5loggedframes.
No broad savings or causal percentage claim. Need control cold/warm discovery
materialization for future matched comparisons.

Also found read_file max_chars40000 returns a~29544char file, then generic outer
bracket re-renders at default20000, hiding its footer despite explicit preview.
Candidate preserves larger validated preview for read_file/convert_to_markdown
at outer bracket; unrelated tools cannot enlarge budget via same-named argument.
Small previews remain handler-owned; default remains20000. Two pure checks pass,
including exact full29KB-ish preview after both rendering layers. No DB fixtures.
Single-file before request explicit-preview-before runs on installed20d6793.
Next build/patch and compare exact opening/closing-code answer and actual wire
visibility. This addresses direct local reader wrappers; delegated envelope
budget propagation is not covered by this narrow change.

## Explicit local preview verified on installed app — 19:40 UTC

Installed881375f5b086f9a2259b120691587b31492a3e653090f7d317a0341133f7bd08,
backup dist.backup-9aq4YL. Both focused installed preview tests passed. Identical
single-file prompt/toolset before/after (toolsSha40d6b5138351), actualTerra + Sol.
Both answers correct and reviewed;3modelcalls each. Before32628input/0cached,
after34422input/0cached: this is NOT token savings. After requested40000 preview
actually includes all29544chars: reconstructed full raw wire item matches logged
29823byte length AND digest e93f4b. Before wire was20242bytes (digest preview).
Receipt explicit-preview-wire-verification.json plus before/after request,
response,evidence. Default preview size remains20000.

Correction to above speculative wording: the old digest preserved the footer;
single-file baseline needed NO recall and returned both codes. Thus double
clipping is proven preview-contract mismatch, NOT proven cause of pressure-test
recall loop. User was told this correction. The change honors an explicit larger
local-read request; doing so carries more tokens, as expected. Converter uses
same helper but only direct read_file received live model acceptance here.
Delegated envelope handling, broader cache efficiency, memory/UI/mobile and
release parity remain open. No active request left running after these checks.


## Saved Space wording — 2026-09-19 19:46 UTC

Console build passed; Impeccable detector returned no findings for WorkspaceView.
Changed the empty-conversation goal card from “Ready to build” / “Start building”
to “Your Space’s goal” / “Work on this goal”, because zero revisions does not
prove a saved view is unbuilt. Composer now invites a question or change without
sales-specific examples. Button behavior is unchanged.

Installed both built web asset trees with retained backups: console
dist.backup-HLv5jT, mobile dist.backup-YsLuL5. Receipt space-copy-install.json
contains exact tree digests. Backend remains 881375f5b086. Actual packaged
app relaunched in live home; native AX and screenshot verified new heading,
button, composer placeholder and existing saved checklist together. No new
model run was needed for copy acceptance. Physical phone remains unverified.

Live Spaces list also exposed current refresh errors on existing user Spaces:
The $40K Plan reports exact read operation provisioning refused for Outlook
calendar; several older local-runner Spaces report missing durable call authority.
These are unresolved product functionality, not fixed by wording. Investigate
read authority and supported refresh migration next without bypassing write
authority or triggering external actions.


## Space refresh diagnosis — 2026-09-19 19:49 UTC

Retried only forty-k-plan source meetings through the installed authenticated
refresh endpoint. HTTP 200 contains results[0].ok=false, not success. Receipt:
space-calendar-refresh-before.json. Current failure is ambiguous_current_manifest
for OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW. Readonly harness.db inspection confirms
two current manifests at version 20260917_00 with distinct account IDs (not
duplicate definitions for one account). The stored Space has no account selector.
The older displayed error was operation_version_rebind_requires_accepted_source.

Two missing pieces: Space source account binding must survive preparation AND
acquireWorkflowReadOnlyOperationAuthority, which currently selects by operation
only and refuses multiple capability IDs. Separately, Space catalog preparation
never supplies an accepted source, so missing/version-drift provisioning cannot
recover autonomously. Do not fix by picking the first account or inventing a
user_input_received event. Trace original accepted source/account lineage or
add explicit source binding, then test exact account on the live installed path.
The runner also prefixes preparation failures with a misleading not-provably-
read-only message. This diagnostic did not fix refresh, mutate manifests,
change source arguments, or execute the provider operation. Refresh recorded
a failed observation in the existing Space, preserving its previous data.

## Space account-binding candidate — 2026-09-19 19:53 UTC

Original source event 229088 in sess-desktop-96804f24f6fe16dfc0e80cb3 records
calendar operation account ca_uDzrJqqniJFk, identity nathan.reynolds@scorpion.co,
source 229017, host:read_default. This is evidence for the original account,
not a newly guessed choice. Candidate adds composioAccountId (tool spelling
composio_account_id) to saved read sources, carries it to exact catalog
preparation and filters shared kernel acquisition by that exact account.
Missing account retains the existing ambiguity refusal. Unknown account cannot
fall back to another account. Provider arguments remain unchanged.
Provider-version reprovisioning without accepted-source lineage remains open.

Account-binding candidate built and installed as 5554238a415f3cf1d7388cb5cfdffc830e9d3eaa2a246262d1a32c3bab0186ca; backup dist.backup-dmZJ8w. Saved original Space manifest in space-account-before-manifest.json, then bound only meetings to original account ca_uDzrJqqniJFk. Installed-store helper first committed manifest then failed indexing because shell Node ABI differed; same candidate repository store completed indexing and readback. No native module rebuild performed.

Installed authenticated refresh returned ok=true, observation e4d9c4ce-601b-42fe-b92b-b67b38e66f26. Durable source 240108 records a returned preparation probe and returned business read, terminal succeeded/nonmutating, result rh_7a271cb6c9d2c58dda6d1721a35dfcf6. Receipts space-account-live-result.json and space-account-binding-evidence.json. Account selection is enforced by installed exact filter and saved manifest; durable activation retains binding digest but no readable account field, so no separate provider-account telemetry claim. This validates this source refresh, not all Spaces or provider-version recovery. Prior data preserved; only meetings refreshed.

## Follow-up: warm account preparation and legacy Space migration

A warm read classification is operation-wide, not account-specific. Changed
Space classification to always prepare when an explicit account is supplied;
otherwise an already-warm different account could suppress exact preparation.
Built and installed 43f53764fd23326b2223900563d2e2fbc4e71151a15d29f073dd23bec884ddf3,
backup dist.backup-7hBLV5. Live negative/positive boundary check pending below.

Read-only inspection of legacy local scripts found real multi-query aggregation,
not merely wrappers: team-sales-weekly compares two periods across Salesforce
objects; darrin-sennott-deal-risk performs relationship rollups; market-leader-send-
contacts transforms/deduplicates campaign members. A raw single-query replacement
would break existing views. Migration must preserve query dependencies and output
contracts through supported durable reads plus local transformation. No legacy
script executed, no Space actions invoked, no query scope changed.

Live boundary checks passed on 43f53764fd233: a temporary nonexistent account
returned ok=false and physical_dispatches count for this Space did not increase.
Original account restored in finally; subsequent same-source refresh returned
ok=true, observation 33b04279-2ec3-49e2-aea0-dd13e0f4a0da. Final saved account
ca_uDzrJqqniJFk confirmed. Receipt space-account-boundaries.json. The remaining
misleading read-only error is visible in this negative receipt and still needs
correction. This check exercised cold explicit preparation and no fallback;
it does not independently prove the warm-other-account ordering scenario.

## Source account continuity at Space authoring — 2026-09-19 20:00 UTC

New pure selectedSpaceReadAccount helper takes only authoritative resolution
entries from the exact current task/session, proven active Composio reads for
the exact operation with routing checked for this source. Multiple accounts
remain unresolved. space_save preserves an existing account for the same source
and operation when omitted, or captures this exact current selection for new
sources. It does not use older-session capability supply as account authority.
Three pure boundary tests pass both in source and against installed JS.
Installed fingerprint 176d0888323acd94f223ebd3eaa4c4772faa297f20b335b6c8080f13848a6352,
backup dist.backup-fGv7z8. Live chat probe-space-account-authoring-1789848030202
in progress; asks discovery of the known Scorpion account, then one unscheduled
calendar source with the account field deliberately omitted. Saved Space and
actual tool arguments must both be checked before declaring host capture passed.

Live authoring completed: source 240120, two space_save attempts both
with composio_account_id null. Final saved calendar source has ca_uDzrJqqniJFk,
no schedule and no actions. Actual Terra response, goal review fulfills=true,
failedOpen not true. Account capture independently asserted in
space-account-authoring-independent.json. Eight model calls, 139450 input,
12288 cached, 1735 output; this is functional acceptance, not a token win.
First save required a view-source wiring repair; final creation smoke returned
two rows (provider/calendar membership correctness not part of this account
test). Test Space retained, unscheduled, with no external actions.

## Avoid false source-wiring repair — 2026-09-19 20:05 UTC

Source 240120's first save displayed all clem.data() using JSON.stringify(data),
but gap analysis blocked it solely because literal source ID calendar was absent.
Added a bounded recognizer: an entire script consisting of clem.data().then with
a function/arrow callback whose only statement assigns JSON.stringify of its
parameter to an existing DOM element's textContent. Other objects, wrong subkeys,
console-only output, missing display elements still fail the source-reference
check. No general relaxation of dynamic-data, syntax, or action checks.
25 pure checks pass in source and installed JS. Hotpatch 8dadb1b3682f44781d56ce0bebe9a141ba4bcf673dd75906fbf7bcc8f2f3f4ea,
backup dist.backup-CkSswM. Live exact-first-view replay in progress as
probe-space-json-render-1789848293040 on existing unscheduled acceptance Space.

Exact live replay completed source 240201: one space_save call, accepted with
no source-reference repair. Saved view bytes exactly equal the first rejected
view from source 240120. Existing Scorpion account, no schedule, no actions
preserved. Actual Terra response and goal review fulfills=true, not failed-open.
Seven model calls, 140161 input, 34304 cached, 938 output. This removes the
observed false rejection but is NOT a matched cost benchmark: this was an
update, prior run was creation, and total input did not decrease. Receipts
space-json-render-{request,response,evidence}.json.

## Bounded Space configuration reads — 2026-09-19 20:10 UTC

Token breakdown of source 240201: six Terra calls (117573 input), one Sol review
(22588 input). Tools were skill_read, two discovery calls, space_get, space_save.
space_get returned 9082 serialized bytes including provider event bodies for a
view-only edit. Prompt-composition estimates are not actual billed usage and
must not replace the ledger totals.
Added optional metadata_only to space_get: exact source/action declarations,
including account and schedule, without dataset records; incompatible with
source_id. Default/static full-document and source paging behavior unchanged.
Workspace-builder playbook now directs view-only edits to this option and still
requires actual records for data-interpretation changes. Build passed. Installed
3019dc55de08e4f5fe940c6b3660c54ae144601b89da6b40bd0213c68b06d7cd,
backup dist.backup-b9vyYC; updated built-in skills shipped and backed up too.
Live option validation pending; no total token-saving claim yet.

Live metadata read passed: actual Terra response and review fulfills=true, not
failed-open; exact returned source/action configuration matches saved manifest.
Serialized tool result 9086 bytes before (full data read in prior view-edit
run), 1228 bytes now (metadata-only), 86.5% smaller.
Three calls, 26328 input, zero cached, 108 output for this read-only task. This
is a measured tool-payload reduction, not a matched whole-task benchmark against
the earlier edit or any other harness. Receipt space-metadata-independent.json.

## Paired configuration-read comparison — 2026-09-19 20:12 UTC

Same installed 3019dc55 build, saved Space, Terra brain/Sol judge, task text
changed only metadata_only=false/true. Both fresh sessions used three calls and
returned identical correct four-field answers; both reviews fulfill, not
failed-open. Brain wire tools and instructions hashes match per call. Judge
tool names/sizes match (open_evidence 702 bytes, query_evidence 1306), but hashes
differ; judge descriptions embed per-run result refs (refHint), so do not claim
byte-identical judge schemas. Saved manifest/data/view hashes unchanged.
Full: 31458 input, 3584 cached, 119 output. Metadata: 25817 input, zero cached,
96 output. Observed total input reduced 17.9%; uncached input reduced 7.4%
(27874 to 25817). One pair only, different cache outcomes, no general benchmark
or Claude Code comparison claim. Receipt metadata-pair-comparison.json.

## Stable judge evidence tools — 2026-09-19 20:15 UTC

Prior paired runs showed equal-sized judge tools but different hashes because
both descriptions interpolated per-review result refs. Moved the refs into one
review-specific prompt appendix; tool descriptions and system guidance remain
stable across ref sets. Lookup resolution, unknown-ref refusal, record queries
and lookup budgets are unchanged. Complete-prompt admission now sees the actual
assembled guidance and reference appendix as well. Five pure checks pass in
source and installed JS. Built/installed c945a996a85b17b49fc5bc0f629be7d2dee4dddfaeb4fc0cc37e265cc9132c8a,
backup dist.backup-q6xzTW. Two live review prefix checks pending. Do not infer
cache hits from schema stability alone.

Both live review runs passed with actual Terra/Sol and non-failed-open verdicts.
Judge toolsSha identical fa430ce98ac2 and instructionsSha identical 53d9abfe6b2c
across distinct result refs. Tool bytes 2029 in both. Judge cache reads remain
zero in both, so this proves stable definitions, not realized caching savings.
Total input 25682 / 25811, total cached 7168 / 3584 (brain cache). Receipts
judge-stable-live-comparison.json and judge-stable-{1,2}-evidence.json.

## Truthful refresh refusal — 2026-09-19 20:20 UTC

Space refresh now returns the actual failed Composio preparation before the
secondary data-source gate, instead of mislabeling an account/catalog failure
as a non-read operation. Ambiguous account preparation explains that the source
could not be matched to one account and directs checking/saving its account.
No provider dispatch occurs on this path; CLI and runner handling unchanged.
Built/installed 527a04b17af7334471bcb244b5bd173ce48e68478400572b1c8bffa9245ff2c8,
backup dist.backup-ydVhtE. Live negative/restore/success check pending.

Live check passed on 527a04b17af7: temporary nonexistent account returned the
new account-specific explanation, without the false “not provably read-only”
claim; Space physical-dispatch count unchanged. Original account restored in
finally, then positive refresh succeeded (8a724b38-5c8c-4312-a973-4287e21acc4a).
Receipt space-read-error-boundaries.json. No model calls needed for this check.

## Cross-project memory correction acceptance — 2026-09-19 20:22 UTC

In progress: two clearly named synthetic project preferences, Harness Memory
Alpha 20260919 (MANGO-MOON) and Harness Memory Beta 20260919 (PLUM-SUN), each
introduced in its own fresh live conversation. Next correct Alpha only, then
recall both in a fresh conversation and inspect durable supersession. Existing
one-project correction checks do not prove isolation between similar projects.
Only these exact test facts are authorized for soft-forget cleanup afterward.
Alpha persisted as fact 3742 with correct project-only scope and no terminal
acknowledgment instruction. Beta request handle running; do not resubmit.

Cross-project memory test passed. Alpha fact 3742 was superseded by 3744
(CITRUS-STAR); Beta fact 3743 retained PLUM-SUN, active and unchanged. Fresh
conversation recalled corrected Alpha, original Beta, and no preference for
Gamma, with project-only scopes. No Gamma fact was created. All four runs
served Terra and had fulfilling, non-failed-open reviews. Cleanup used the
installed soft-forget endpoint for exact facts 3742/3743/3744 only; zero active
matching test facts remain. Audit/supersession history retained. Receipt
memory-scope-independent.json. This proves one cross-project correction and
non-inheritance scenario, not arbitrary long-horizon memory reliability.

## Mobile repair-prompt alignment — 2026-09-19 20:26 UTC

Mobile Workspace repair prompts explicitly requested a new data-source runner,
contradicting current source policy which refuses new opaque runners. Replaced
both refresh and phone-layout draft prompts with user-facing desired behavior:
supported read-only refresh, current desktop/phone data, preserved content/actions.
No auto-send or action behavior changed. Mobile build passed; both web trees
installed with retained backups (mobile dist.backup-PSeIC1, console
 dist.backup-tsHiHI). Mobile tree digest 90b53d15d6b1df9ff7fdf8432ffa13b8e6fad3e6a9b615dec30309318eee7d8d.
Backend remains 527a04b17af7. Served-asset verification pending. Physical phone
acceptance still pending; do not equate installed assets with phone cache state.

Served mobile index returned 200 and names /m/assets/main-BbAQ8U7g.js. Downloaded
asset through the live app is byte-identical to built JS, contains both updated
requests and no obsolete runner request. Receipt mobile-repair-served.json.
No test repair request was submitted and no physical-device cache claim made.

## Legacy Space migration: deterministic row selection — 2026-09-19 20:36 UTC

Rechecked shared checkout main/e5a75f5a; Claude PID80577 still uses this checkout.
Installed baseline was 527a04b17af7, schema81, vault Claude configured=true.
Market Leader Send Contacts refresh is a one-query script, but its output also
requires nested fallback fields, primary-contact preference, per-account
selection, date ordering, phone/website formatting, and campaign counts. Raw
query replacement or desktop-only shaping would lose its existing behavior.
Current transform AST lacked priority sorting and uniqueness; added closed
`sort(value,by:[{column,direction}])` and `unique(value,keys)` operations.
Sort is stable, non-mutating, homogeneous scalar per column, null-last, UTF-16
lexical for strings. Unique keeps first typed composite key; missing/object
keys refuse instead of silently collapsing records. Both consume existing
resource budgets and retain final output bounds. Authoring guidance updated.
No arbitrary-code, process, network, or clock access was added.

Nine pure transform checks passed (including three new preference, typed-key,
and invalid-key checks). Build passed. Installed backend fingerprint
 eab3664ad6bab6ea56f424c9e63568b71606705545a12f911f58b4783c0f3284;
rollback dist.backup-VBuOsJ. Both web asset trees reinstalled and digest checked;
assets unchanged from mobile repair candidate. Installed JS includes new ops.
Live-home workflow harness-row-selection-20260919, run1789850155600-e9b638,
completed through normal single-step TRY endpoint with exact expected rows.
Independent comparison passed; workflow remains disabled, manual-only, no
external reads/actions. Receipts workflow-selection-{definition,start,result,
independent,assets}.json and workflow-selection-{build,hotpatch}.txt.
This is deterministic workflow selection acceptance, not provider/judge
validation, a full Space migration, or a comparative token benchmark.

Next migration work: nullable field defaults/coalescing, field comparisons,
phone/URL string formatting, final output shape (including campaign counts and
observation timestamp), and a legitimate workflow refresh trigger/publish path.
Existing legacy Space manifests/data/actions were not changed. Preserve query
scope and mobile contract; do not declare old refreshes repaired yet.

## Direct Space source transforms — 2026-09-19 20:44 UTC

The workflow-fed data guidance did not wire the Space Refresh button to a
workflow. For single-read reports, added a direct pure post-read pipeline using
the existing transform evaluator instead of creating a second execution lane.
SpaceDataSource.transforms (tool transforms_json) stores 1-16 named pure steps,
64 KiB combined definition and 64 MiB retained input/output. Only this source's
steps.read.output, earlier pipeline outputs, map item, and host input.observed_at
are available. Invalid definitions are rejected at authoring, manifest load and
execution; read failures skip shaping. Shaping failure records an error without
claiming zero dispatch or overwriting the prior dataset. Observation provenance
records transformsHash. Normal refresh, schedules and creation smoke share this
runSpaceDataSource wrapper. Final data remains the shared desktop/phone source.

12 focused pure checks passed, backend build passed, installed fingerprint
f7acead405d4a22e24d35f81d7e02d513f99103aba9b1ae213d3d038fbb1731a,
rollback dist.backup-5DHKzN. Both existing web asset candidates reinstalled and
digest checked. Skills shipped; no UI content changes in this patch.

Live authoring source240583, probe-source-transforms-author-1789850532020,
used normal space_save on ONLY harness-account-binding-20260919. Exact two-step
pipeline persisted and refreshed: unwrap provider result.data.value, then
publish {events,total,pulledAt}. Terra/Sol fulfillment passed; 10 model calls,
203042 input/34304 cached/1474 output. No efficiency win claimed. Actual source
operation/account/args/allowEmpty and unscheduled state preserved. Actions,
goal,status unchanged; originSessionId and operational timestamps changed under
normal save behavior. Do not call this immutable origin metadata preservation.

Installed Refresh negative/restore/positive test passed. Temporarily set a
valid expression with intentionally missing read field on the test Space;
refresh failed with transformation-specific error and prior calendar dataset
was deep-equal. Restored exact pipeline in finally; positive Refresh succeeded,
2 rows, correct count, newer host timestamp. Observation IDs negative
d04d85bf-b699-4362-a505-07ab1808d375, positive
dd571035-bfba-4c5a-843b-7d3532335632. Test Space retains the valid pipeline.
Receipts source-transforms-{author-evidence,refresh,before-manifest,pipeline,
assets}.json; build/hotpatch.txt. Administrative temporary source replacement
used same-built repository store because installed native DB ABI differs from
shell Node; actual reads/transformation/observation commits used installed API.
No business Space migrated yet, no phone visual acceptance claimed.

Next: complete Market Leader's pure field rules (nullable nested fields,
phone fallback, primary-contact comparison, phone/URL normalization, final
ordering/campaign summary). The direct pipeline now handles Refresh and host
timestamps, so a separate workflow trigger is not needed for this one-query
migration. Multi-query legacy Spaces still need their full durable read graph.

## USER SCOPE CORRECTION — 2026-09-19

User explicitly said: "Why are you fixing my Clem? We should only be doing
framework work". This supersedes the personal Space migration next steps above.
STOP personal Space repair/migration and personal configuration tuning. Work on
shared harness/framework code only. Validate through installed app/live home
using clearly named controlled acceptance fixtures; live-home acceptance is
still required, but is NOT permission to repair business Spaces.

Market Leader business Space was NOT switched: source contacts still uses
refresh.mjs and no transforms. The just-started synthetic baseline read finished
terminally with NoDefaultEnvError (no default Salesforce environment), with no
records returned. Do not investigate/reconfigure that personal CLI connection.
Test Space harness-market-leader-migration-20260919 was archived afterward;
no schedule or actions. No related request remains running.

Generic nullable/text/merge/equality/locale transform additions from the latest
turn are source-only, not built or hotpatched. Six-step report recipe and four
pure equivalence cases are local output artifacts only. Do not use them to
resume a personal migration. Reassess these draft additions against a generic
framework requirement before shipping. Installed backend remains f7acead405d4a.
Earlier framework refresh integration/row selection are installed. Personal
$40K Plan account binding was changed earlier and is not silently reverted by
this scope correction. Preserve other agents' work and the user's token meter.

## Framework-only cleanup and cache attribution — 2026-09-19 21:00 UTC

Removed ONLY our unshipped nullable/text/merge/equality/locale additions and their
four tests; previously installed row-selection and source-transform framework
changes remain. Exact source snapshots retained as local scope-draft-*.txt;
do not reapply for a personal migration. Remaining 12 focused checks pass.
Shared branch still e5a75f5a, other Claude cwd still same checkout. Sidecar edits
untouched. Read-only current audit: 557 usage rows, all certified, 140 without
exact accepted-source identity (not automatically bugs; background work exists).
No new personal Space read/configuration repair was attempted this turn.

Framework diagnostic gap: codex request prefix shape logs lacked exact session/
accepted-turn identity, and their five-sample counter could be exhausted in the
first turn of a long chat. Added sessionId, acceptedSource, sourceUserSeq and
runAttemptId from existing ALS context. Sampling is now keyed by exact accepted
source + model + shape, with existing bounded map. Unknown attribution stays
unknown; no timestamp inference, prompt content, credentials, model behavior,
review policy, or cache key changes. This is observability, not an efficiency win.

Build passed, installed fingerprint
092205ad7714f2d03790738d2399ebb7be349e310b7812a6c56d2aef56a36c9e,
rollback dist.backup-1n9VO2. Both unchanged web candidates reinstalled and hashed.
Live named synthetic chat probe-framework-prefix-attribution-1789851420496
completed two exact text responses, source240705/240725. Logs join exactly to
usage ledger for both, each frame1 despite identical instruction/tool hashes.
Actual model Terra; 9162/9434 input, zero cached. No savings claim. Receipts
framework-prefix-attribution-{start,responses,result,assets}.json and build/
hotpatch.txt. Check script initially wrongly required two judge calls; corrected
via a READ-ONLY evidence verifier, without resubmitting either request.

NEW FRAMEWORK FINDING TO TRACE NEXT: both simple chat runs have zero judge calls
but completionReview.disposition=enabled_unavailable. Do not call them reviewed
passes or claim an auth outage. shouldRunObjectiveJudge excludes non-action
chat with no work; delivery-committer.ts:1185 maps ANY missing publishedVerdict
to enabled_unavailable. This may conflate a deliberate skip with actual reviewer
unavailability. Need source-bound skip evidence and truthful disposition semantics
before changing this behavior; do not add mandatory review calls to trivial chats
or weaken checks for real work. Current completion metadata is preserved verbatim
in the receipt. My initial commentary called it an intentional skip prematurely;
I corrected that after reading the recorded disposition.

## Framework review disposition correction — 2026-09-19 21:06 UTC

Traced the ACTUAL host-turn-runner (not only the legacy loop). Its objective
judge gate deliberately skips conversational answers with no attempted work.
Delivery formerly mapped every absent verdict to enabled_unavailable, even for
that skip. Added completion_review_skipped event with exact source, objective
and answer digests and positive gate evidence. Only narrow no-action/no-work,
readable-evidence, no-approval/no-promise/no-completion-claim, initial candidates
can record it. Delivery labels not_required only with captured enabled policy,
no verdict/plan, exact matching skip and a fresh current-source work/effect check.
Missing/malformed/stale skip evidence, actual verdicts and unavailable review
keep existing semantics. No eligibility, verification gate or model call changed.
Older terminal rows were not rewritten. New metadata disposition is not a
verified completion verdict and must never be counted as a reviewed pass.

Two pure checks cover 13 exclusion variants, malformed evidence and stale
source/objective/reply. Build initially caught an undefined logging helper and
turn variable; fixed before installation, rebuilt successfully. Installed
fingerprint 88bed902af4c3fae4a9e7d1d705f2c85adc431849902ff593dcc921057665a04;
rollback dist.backup-Q8apcp. Both unchanged web candidates reinstalled/digest
checked. Live probe-review-disposition-1789851884434: sources240745 and240766
have matching skip records, zero judge calls, not_required. Source240787 read a
fresh local nonce fixture and reported exact values; Sol verdict240810 stands
with verified=true/disposition=reviewed. Five total calls, actual Terra/Sol.
No provider-unavailability simulation, broad recovery proof or savings claim.
Receipts review-skip-live-{start,responses,result}.json, review-skip-{build,
hotpatch}.txt and review-skip-assets.json. No personal config/Space changes.

Next framework efficiency evidence: prompt composition for the synthetic chat
shows 11074 bytes in memoryContext (~2745 estimated tokens), and actual wire
logs show 18742 bytes of initial tool schemas plus 6296 bytes instructions.
Composition token estimates are NOT provider token counts (toolSchemas estimate
9719 differs from actual wire bytes). Captured both under exact turn identity;
framework-prompt-composition.json. Investigate shared memory/context selection
and actual wire overhead, without deleting/tuning the user's personal memories
or claiming savings from estimates. Scope remains framework-only.

## Framework-only memory presentation audit

Following the explicit scope correction, inspected existing synthetic-run model
memory evidence read-only; no personal memory, Space, integration, or runtime
setting was changed. Rechecked the other Claude process (80577) in the same
main checkout and live build fingerprint 88bed902af4c3fae4a9e7d1d705f2c85adc431849902ff593dcc921057665a04.

Receipt: output/weekend-harness-2026-09-19/memory-section-audit.json, derived
from model_memory_context events for probe-review-disposition-1789851884434.
Source 240745 carried 11,074 UTF-8 bytes: Persistent Facts 4,377; Recently
Learned 1,020; Data Landscape 1,358; Remembered Tool Choices 1,473. These are
bytes, not provider tokens. Source 240766 was 11,531 bytes and 240787 was
12,556. The audit splits Markdown headings, so working-memory subheadings
appear separately; they must not be interpreted as independent injections.

Code findings: source-map.ts ranks objective overlap but retains zero-overlap
pointers; tool-choice-store.ts promotes matched intents but appends unmatched
choices; the recent-learning bridge is recency/importance based, not objective
filtered. This establishes potential irrelevant prompt overhead, not a safe
license to discard all nonlexical matches. Facts already preserve compiled
dispatch constraints and budget other groups; vault loading already excludes
generated profile projections. No duplicate-memory bug or savings is proven.
Next: evaluate relevance selection and retrieval fallback on controlled
cross-topic/resume tasks before changing these presentation defaults. Preserve
standing constraints and all stored memories. No new hotpatch in this audit.

## Matched tool-memory presentation hotpatch

Shared framework change: tool-choice context now advertises only the matched
procedures when the existing matcher finds any, instead of backfilling unrelated
ones. No-match/unavailable-match cases retain the previous recency fallback.
Durable stores, recall, matching, effect compatibility, standing constraints,
and invocation/account details are unchanged. Pure selection checks passed (2);
backend build passed. Existing store tests create/reset an isolated home and
were not run as live acceptance.

Installed fingerprint: 0558817ff579c2a2e52036897e77bf654d82d607bd4d73403ebf177a0ebad775.
Both web trees reinstalled and digest-verified, rollback retained. Live session
probe-tool-context-live-1789852432817 source 240815 read the controlled local
nonce fixture exactly; Sol verdict 240838 fulfills=true and completion 240842
verified=true. Actual models Terra and Sol, 3 calls, 24,399 input, 2,560 cached,
108 output. A follow-up answered checksum 947 from the same conversation.
Detailed source attribution and prompt block counts are in
output/weekend-harness-2026-09-19/tool-context-selection-result.json.

The first read carried eight matching tool lines, no unrelated backfill. This
proves the installed path is functional, not a measured reduction against the
old build: a matched baseline was not collected and the block remains near its
budget. No overall token-efficiency or Claude Code comparison win is claimed.
No personal Space, integration, or stored-memory cleanup was performed.

## Distinct learned-word relevance correction

Found and reproduced a shared matcher error: concatenating intent/context token
sets let one word present in both fields satisfy the advertised requirement for
two distinct learned words. Fixed by unioning the sets before counting matches.
Regression failed before the fix (one word incorrectly matched WEATHER_GET),
then all four focused relevance/selection checks passed. Two distinct learned
words still retrieve without naming the provider. Fixture records are supplied
in memory, with no stored-choice writes or home resets.

Build and hotpatch passed. Installed fingerprint:
2e86b0857e5279a9bb7b0279261391e59f76d38752af320db5217d21d158d1c9.
Packaged Electron runtime loading installed modules against live home separately
confirmed 0 one-word matches and 1 two-word match. Both web asset trees were
reinstalled/digest-verified, rollback retained.

Full live chat probe-distinct-relevance-live-1789852690911 returned the controlled
fixture exactly, with actual Terra/Sol and a verified successful review. Three
calls: 24,394 input, 5,120 cached, 108 output. The preceding identical prompt used
24,399 input and 2,560 cached. This is not a meaningful total-input improvement,
and differing cache state is not proof of a cache gain caused by the fix.
Receipts: output/weekend-harness-2026-09-19/distinct-relevance-{before,after}.txt,
distinct-relevance-installed.json, distinct-relevance-result.json, and live
request/response/evidence. The bug is proven independently; it is not established
as the explanation for every irrelevant match in the earlier audit.

## Relevance diagnosis after distinct-word fix

Read-only installed-runtime replay of the exact controlled local-read objective
against the same supplied procedure list returned 13 advertised matches. Replacing
only the absolute local path with <local-path> reduced this to 2. Path components
such as Users contributed user/users, and harness/project directory names also
matched historical alias prose. The two remaining Outlook matches were driven
by read/return/its. The conversation-only checksum follow-up matched 12 procedures
through generic terms such as you/just/what/not and conversation.

Evidence: output/weekend-harness-2026-09-19/tool-relevance-overlap.json and
 tool-relevance-counterfactuals.json. Reports retain identifiers, overlap terms,
and scores, not invocation arguments or private stored descriptions. These are
matcher replays, not model calls or latency/token benchmarks. No new hotpatch or
stored-memory edits in this audit.

Next implementation should address grammatical/noisy overlap and distinguish
local resource identifiers from requested tool identity, while preserving exact
accepted-phrase retrieval, explicit provider/command requests, learned multiword
requests, and task-resumption context. Simply removing path text could also hide
legitimate resource-specific memory, so it is not yet an accepted blanket fix.
No-match rendering still falls back to recency; improving matcher precision alone
will not necessarily reduce prompt size. Measure selection and recall together.

## Scoped procedure context and grammatical relevance hotpatch

Advertising now excludes grammatical words and generic user/conversation nouns
as sole relevance anchors. Distinct learned signals also collapse trivial plural
variants. Binding thresholds and explicit-command / exact accepted-phrase paths
are preserved. After a completed explicit-objective search, no matches now means
no procedure block; no-objective overview and thrown-search fallback retain
recency. Stored procedures and recall APIs are unchanged.

Seven focused checks passed, including common-word/Users-directory negatives,
named Slack positive, learned two-word retrieval, singular/plural negatives,
explicit identifier retrieval, and no unrelated backfill. Backend build passed.
Installed fingerprint e73fe5eb5adec3ad9f55c758a0613017a4828eccedff1d5aac2709f106c94075;
both web trees reinstalled and verified, backups retained. Packaged runtime/live
home rendering confirmed no tool block for the conversation-only ask and six
procedures for named Outlook calendar retrieval. No personal data cleanup.

Live session probe-scoped-tool-context-live-1789853002162 source 240891 returned
the exact controlled local file, successful Sol review 240914 and verified
completion. Actual Terra/Sol; 3 calls, 23,442 input, 3,584 cached, 108 output.
Compared with preceding identical prompt: 24,394 input / 5,120 cached / 108 output.
Total input fell 3.9% in this pair, but uncached input rose from 19,274 to 19,858
because cache hits differed. This is not a demonstrated cost win or matched
Claude Code benchmark. Model-visible tool block shrank 1,455 to 695 bytes
(8 to 2 lines); total memory 10,988 to 10,228 bytes. Remaining path/project-word
matches have not all been eliminated. Follow-up correctly recalled checksum 947.

Receipts: output/weekend-harness-2026-09-19/scoped-tool-context-{tests.txt,
installed.json,result.json,followup.json,followup-evidence.json}, plus live
request/response/evidence, build, hotpatch, and web-asset receipts.

## Cross-task continuity on scoped-context build

Installed e73fe5eb5adec3ad9f55c758a0613017a4828eccedff1d5aac2709f106c94075
passed a three-turn controlled local scenario, session
probe-scoped-context-continuity-1789853149839. Source 240939 read fixture A and
held its approved-EAST calculation. Source 240967 switched to B, read its file,
and returned approved-WEST total 4786. Source 240995 resumed A without repeating
its path/filter and returned A's identifier with total 910. Both totals were
independently recomputed from the actual fixture rows. No personal files or
integrations were involved; no durable preference was requested.

A/read and B/calculation had verified successful Sol reviews. Resumed A had
one Terra call, no verdict and completionReview=enabled_unavailable (241014).
No completion_review_skipped event was emitted. Do not describe all three turns
as reviewed or infer an unavailable provider from that label alone. Trace this
metadata/eligibility case before changing it. No evidence of a wrong answer or
cross-task contamination in this scenario.

Actual attributed usage by accepted source: 240939 3 calls/24508 input/7168 cached;
240967 3 calls/25720 input/7168 cached; 240995 1 call/9855 input/3584 cached.
This is bounded short-chat continuity, not restart, compaction, durable
cross-session, or long-horizon qualification. Receipts and reproducible driver:
output/weekend-harness-2026-09-19/check-scoped-context-continuity.mjs and
scoped-context-continuity-{start,events,result}.json plus each stage response.

## Retained-context review skip accurately reported

Traced resumed source 240995: classified action=true, prior history contains
business calls, no current-source work/effects, no completion/promise claim,
single-result objective. Existing shouldRunObjectiveJudge skips this combination;
no provider request was attempted. The earlier metadata recognizer only handled
non-action conversational skips, causing misleading enabled_unavailable.

Extended the metadata-only skip recognizer to the exact retained-context branch,
reason retained_context_without_new_work. It requires positive no-new-work,
readable evidence, zero effects, no claims/promises/approval, zero continuations,
and explicit single-result/no-accepted-execution flags. Delivery still checks
exact source/objective/reply and fresh work/effect state. Neither judge eligibility
nor verification/dispatch rules changed. Skipped does not mean verified.
Three focused tests passed, including stale identity and exclusion cases; build
passed. Installed fingerprint:
75fe9c5c4a3f2601252d253f07c775baba96520522310a85c34fd5922f4f6d10.
Both web asset trees reinstalled/digest-verified, backups retained.

Live after restart: repeated resume on the controlled continuity session, source
241015, answered 910 and recorded retained_context_without_new_work with
completionReview=not_required and no judge verdict. A fresh controlled local
read, source 241037, had verified=true reviewed completion and no skip record.
This validates truthful status for the retained-context case while fresh work
still receives review. Historical records were not rewritten.
Receipts/driver: output/weekend-harness-2026-09-19/check-retained-review-skip.mjs,
retained-review-skip-result.json, retained-review-skip-tests.txt, build/hotpatch/
assets, and individual retained/fresh-read response files.

## Reused canonical accounting; response route discrepancy found

Located existing scripts/session-comparison.ts and scripts/compare-turns.ts;
reuse measureAcceptedTurn / npm run measure:turns rather than adding duplicate
usage math. Existing broad proof scenarios provision homes and manipulate
synthetic provider/identity state; do not run them directly against live home.
Read-only canonical measurements for seven recent sources are saved in
output/weekend-harness-2026-09-19/canonical-framework-measurements.json. All seven
had certified exact attribution, no certification issues. This pass made no
model calls or configuration changes.

Important correction to any model inference from API route metadata: source
241015 actually executed claude-opus-5 (18126 input, 0 cached, one call), not
Terra. Ledger event 241030 records harness_fallover, model.http_5xx, from Terra /
Codex to Opus 5 / Claude. The API still returned effectiveModel=gpt-5.6-terra,
provider=codex. Earlier source 240995 actually used Terra (9855 input). These are
NOT same-model comparison legs. Review-skip functional acceptance still stands;
it does not certify the requested primary provider executed.

Likely presentation path: respond-bridge.ts withRouteDiagnostics calls
routeForHarness from configured route after execution, while fallback-model.ts
already emits exact-source turn_model_routed fallover records. Next trace and
fix response diagnostics to preserve configured/requested route separately from
actual executed route, without borrowing other sources' or workers' routes.
Do not alter model defaults or force provider errors in live configuration.

## Accepted-source response route correction hotpatched

Added a pure acceptedResponseRoute projection and wired harness bridge response
paths to exact-source primary routing records. Only system turn_model_routed
records for the same session/source and harness/harness_fallover lane qualify;
latest event sequence wins. Requested model is preserved, effective model and
provider follow the final primary route, and falloverFrom retains the original
selection. Worker/judge/unscoped/adjacent-source rows cannot substitute. The
initial route marker still records the configured selection; routing, providers,
credentials, and execution decisions are unchanged.

Three pure regression checks passed and backend build passed. Installed build:
6f4f1b9bb9598b676b1155b33c8a52e7c6319eb3d686623717e679b2ebb4e76e.
Both web trees reinstalled/digest-verified; backups retained. Installed helper
replaying real source 241015 correctly yielded claude-opus-5 / claude /
falloverFrom=gpt-5.6-terra. Historical API response was not rewritten.
Fresh live source 241065 returned ROUTE-CHECK-731, effective Terra matching its
actual primary usage; Sol review also ran and did not overwrite the primary
route. Completion verified=true. No live provider failure was deliberately
induced, so fresh end-to-end fallback remains unexercised; recorded real-fallback
projection plus fresh normal bridge acceptance cover separate parts.

Receipts: output/weekend-harness-2026-09-19/accepted-response-route-tests.txt,
accepted-response-route-installed-replay.json, accepted-response-route-live-*
and build/hotpatch/assets files. Continue checking actual usage for benchmarks;
a selected route event alone is not proof a provider returned a successful call.

## Built-in instruction assets missing from desktop release configuration

Release-path audit found a concrete hotpatch/package discrepancy. Root npm
package files and hotpatch-daemon.mjs include builtin-skills, but desktop
extraResources omitted that directory. Setup reads required instruction assets
from PKG_DIR/builtin-skills. The existing old 3.18.6-rc.1 package lacks the tree;
that old artifact is supporting context, not proof of current-release execution.
The current release configuration itself omitted the resource mapping.

Added the shared desktop resource mapping daemon/builtin-skills (Mac/Windows/
Linux) and an afterPack byte comparison for both required SKILL.md files before
platform-specific native preparation. Missing files and differing source/package
bytes now fail packaging. No user skill files or live-home state are changed.
24 focused packaging/release-workflow tests passed, including actual post-pack
hook checks on disposable package asset staging (not an isolated runtime home).
Readonly comparison confirms both current source instruction files already match
the live installed daemon. Receipts: builtin-skills-packaging-tests.txt and
builtin-skills-installed-parity.json in the acceptance output directory.

This is a packaging-source fix, not a newly built/signed installer or published
release. No daemon restart/hotpatch is needed for the already-matching instruction
assets; live backend remains 6f4f1b9bb9598b676b1155b33c8a52e7c6319eb3d686623717e679b2ebb4e76e.
The source tree now includes this additional packaging-only change. Signed
installer and another-user acceptance remain open. Do not run the full release
script casually: it clears prior release output and stages native dependencies.

## Tool-description audit — no additional pruning

Inspected production orchestrator run_worker description, WorkerToolCallSchema,
and session_search definition. The orchestrator description already has a
purposefully compact three-paragraph contract; worker field descriptions specify
separate packet/lease/manifest obligations. Static inventory found 20 description
strings / 1321 characters across base+extension schemas, zero exact duplicates
(extension definitions replace base fields, so this is not a wire-byte total).
Observed full run_worker definition was 4575 bytes including schema structure and
tool-level prose. session_search carries exact snapshot/pagination/backfill rules;
removing those would change its usable recall contract.

No code changed and no model calls were spent on this audit. Do not claim token
savings, or repeat blind description trimming as the next efficiency step.
Receipt: output/weekend-harness-2026-09-19/tool-description-audit.json. Remaining
benchmark work needs matched completed tasks/tool surfaces/provider/cache state,
not another small prose change without evidence of waste.

## Concurrent duplicate delivery and durable replay acceptance

Current installed 6f4f1b9bb9598b676b1155b33c8a52e7c6319eb3d686623717e679b2ebb4e76e,
live home. Created one controlled nonce file and sent two simultaneous identical
/api/message requests with the same Idempotency-Key and dedicated session
probe-idempotency-1789854360573. Both returned exact fixture content and the same
run_id. There is exactly one accepted source (241086), one terminal, one canonical
read_file call, two actual Terra calls and one Sol review; review verified=true.
Certified exact-source totals: 24845 input, 7168 cached, 19213 ms accepted-turn
wall time. This measures one logical request, not two successful independent jobs.

A completed-request retry returned the exact answer with no additional session
events, model calls or tool work. Reusing its key for different text returned
409 with no new accepted source. After checking zero active leases, cleanly
restarted the same installed app (new daemon 59670) and retried the original key.
Exact answer, source/terminal counts and usage/tool totals remained unchanged;
zero additional model calls after restart. No code change was needed.

This proves duplicate HTTP delivery, completed replay, and completed replay
after clean restart for one read-only request. It does not prove an in-flight
crash/recovery race, concurrent mutating workflows, or multi-step recovery.
Receipts/driver: output/weekend-harness-2026-09-19/check-live-idempotency.mjs,
live-idempotency-{start,pair,result,events,measurement,restart-response,
restart-result}.json. Fixture retained in the same output directory. No personal
configuration, business Space, integration, or stored memory was edited.

## Direct append acceptance exposed registry inconsistency

Source 241114, session `probe-append-idempotency-1789854564865`, on installed
fingerprint `6f4f1b9bb9598b676b1155b33c8a52e7c6319eb3d686623717e679b2ebb4e76e`
finished blocked. Two concurrent identical requests shared one accepted source,
one run, and one terminal response. The controlled file remained `BEFORE\n`;
there was no physical write dispatch. This is not a passing mutation-idempotency
test and does not establish a duplicate-write bug.

Exact `tool_search("write_file")` returned `unsupported_unmaterialized` with
`planningRefusalReason: safe_mode_not_structural`. Source inspection identifies
a registry inconsistency introduced by the workflow file support: the primary
`write_file.localPlanning` semantics are now unrestricted reversible writes
without safeMode, while the older append/overwrite localPlanningVariants remain.
`explicitVariantSemanticsAreClosed` requires a distinct safeMode identity for
EVERY entry when variants exist, so discovery rejects the entire declaration.
The reviewed workflow transport separately reads only primary localPlanning,
which explains why its earlier append/overwrite acceptance did not catch this.

Next repair must make chat discovery and reviewed workflow execution agree,
with regression coverage of actual configured declarations and all three modes.
Do not merely loosen the generic structural validator or restore create-only
workflow behavior. No production source changed in this diagnostic turn.
Initial natural-language discovery also ranked unrelated cloud tools; that
ranking problem is distinct and is not fixed by proving exact-name publication.

Receipt: `output/weekend-harness-2026-09-19/live-append-idempotency-failure.json`.
The pair and full terminal events are retained in `live-append-idempotency-pair.json`
and `live-append-idempotency-inflight.json` (the latter filename is historical;
the saved data includes the terminal). Do not restart/poll finished process31477.
Current runtime recheck confirmed daemon59670, same fingerprint, zero active
leases. Other Claude process80577 remains in the shared main checkout. No
personal configuration, integration, or business Space was changed.

## File discovery contract repaired with planning modes preserved

Final installed candidate fingerprint:
`1224fe61b1fa91f0abfc4a0b3701950058f18ecdd22801e09521ebc392120ac5`.
Shared main remains e5a75f5a, other Claude process80577 still present. Backend
build, daemon/skills hotpatch, and both web-asset digest checks passed.

The final repair restores the original separate create/append/overwrite planning
declarations. `ReviewedLocalExecutionContractV1.semantics` explicitly describes
the workflow adapter's recoverable full-argument execution contract; reviewed
transport uses it when declared, otherwise preserves its existing localPlanning
fallback. It also retains plural destination postures when reconstructing the
contract. This avoids using workflow execution semantics to erase chat planning
mode restrictions. Path/argument checks and the generic structural validator
were not loosened. Existing mode-specific integration assertions were preserved.

A temporary intermediate candidate (5c536f47) removed the variants and passed
basic live checks, but broader review identified that it weakened the existing
planned-mode invariant. It was superseded; its passing receipts are not evidence
for the final design. The final source restores those invariants and uses the
explicit execution semantics above.

Three focused pure tests passed without an isolated runtime home or writes to
fixtures: actual registry definitions publish all three mode refs, append flag
precedence selects exactly the intended mode, invalid modes reject, reviewed
workflow modes remain admitted, and malformed recovery identities cannot claim
a commit. Build passed. `local-planning-capability.test.ts` is unchanged from
HEAD; its reset-home suite was not run against the live home.

Final live source241274, session `probe-append-idempotency-1789855375507`, passed:
- Two concurrent identical requests share one accepted source and terminal.
- Discovery publishes create/append/overwrite refs; one append physically executes.
- Exact content preserves BEFORE and adds the marker once; readback agrees.
- Sol completion review fulfills=true; actual primary usage is four Terra calls.
- Same-key completed replay causes no new events, writes, or file mtime change.

Canonical accounting: five model calls, 57,005 input, 23,040 cached, 31,879ms.
The failed prior run had17 calls/208,202 input/35,840 cached/55,723ms. These are a
single failure-to-success pair, not a general efficiency or Claude Code claim.

On the final installed candidate, the controlled
`harness-orchard-acceptance-20260919` workflow independently passed all three
modes with exact file contents, terminalOutcome=succeeded, goalValidation.pass,
and judgeFailedOpen=false:
- create: 1789855384078-01b818
- append: 1789855413379-dbb67d
- overwrite: 1789855450198-f4e1c5
The synthetic workflow's prior steps/goal were restored and it is disabled.
No personal Spaces, integrations, settings, or usage-sidecar files were changed.

Receipts under output/weekend-harness-2026-09-19:
`file-mode-contract-{tests,build,hotpatch}.txt`,
`file-mode-contract-assets.json`, `file-mode-contract-measurement.json`,
`live-append-idempotency-modes-{start,pair,result,events}.json`,
`workflow-modes-final-{create,append,overwrite}-{start,result}.json`.
Natural-language discovery ranking without an exact tool name is still not
qualified by these exact-name successful calls. Other crash boundaries, long
horizon memory, matched benchmarking, phone UI, and release parity remain open.

Final clean restart replay also passed on daemon94035 and the same fingerprint.
The same accepted request returned the retained answer/run; file bytes/mtime,
event count, one physical write, and canonical model-call/token totals remained
unchanged. Receipts: `append-restart-{before,response,result,measurement}.json`.
This proves completed mutation replay across a clean restart, not an in-flight
crash boundary. No additional patch is needed for this bounded regression.

## Plain-language discovery: unrelated replacements and plural mismatch fixed

Final installed fingerprint
`ae71fabaf22e6d6dd50edf3e1069b66f6e3f40e4f8f3d17b728f75e79a398a8a`,
daemon14257, app3.18.17, schema81/81, shared main e5a75f5a. Both web trees
were reinstalled and digest-verified with backups. No personal settings changed.

The saved original append query returned write_file sixth, behind unrelated
provider tools. Live provider-only inspection confirmed four unrelated rows
carried providerRecommendedSuccessor=true despite negative provider relevance
scores. tool_search's merged ordering promoted those lifecycle replacements
unconditionally. The broker now retains special lifecycle priority only inside
an explicitly named provider namespace. Otherwise replacement rows compete on
relevance and remain discoverable. Exact lookups and capability authority are
unchanged. The regression first failed with GOOGLEDRIVE_DELETE_REPLY first;
post-change it passed. Named-provider successor priority and page-outage tests
also passed.

An intermediate live candidate d16538b5 ranked the local file tool second behind
spreadsheet append, so it was NOT accepted as the completed fix. Full metadata
inspection showed naive token matching missed content/contents and file/files.
The lexical ranker now folds ordinary plural forms for relevance only, retaining
original operation identities and raw provider namespace matching. No new model
call or external dependency was added. Five focused checks and seven existing
pure ranking checks passed. The latter were extracted unchanged into an output
harness to avoid the original suite's home-changing/hot-set fixtures. The saved
196-row full-metadata counterfactual ranks write_file first; it is a broader
catalog sample, not an exact replay of the 57-tool live scoped catalog.

Final live source241382, session `probe-discovery-ranking-1789856154510`, called
tool_search once with EXACT original query:
“append exactly one line to a local file and verify resulting file contents”.
The returned order begins write_file, GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND,
space_save. write_file publishes all three planning modes. No discovered tool
was invoked. This is direct ranking acceptance against the live catalog, not a
general semantic-discovery benchmark or new file-mutation acceptance. The file
execution/replay acceptance from the preceding final build remains documented.

Receipts in output/weekend-harness-2026-09-19:
- discovery-provider-candidates-live.json (metadata-only live provider capture)
- discovery-lifecycle-before-tests.txt (reproduced failure)
- discovery-lifecycle-tests.txt; discovery-plurals-tests.txt
- discovery-existing-ranking-tests.txt; catalog-lexical-existing.test.ts
- discovery-full-metadata-counterfactual.json; discovery-plurals-corpus-result.json
- discovery-ranking-lifecycle-only-{events,result}.json (intermediate miss)
- discovery-ranking-plurals-{start,response,search,events,result,measurement}.json
- discovery-plurals-{build,hotpatch}.txt; discovery-plurals-assets.json

No global token-efficiency advantage follows from this one discovery check.
No workflow, personal integration, Space, token-meter, or release publication was
changed in this turn. Broader semantic memory, matched benchmarks, long-horizon
recovery, physical phone UI, and signed-release parity remain open.

## Corrected preference applied in a fresh conversation with paraphrased wording

On installed ae71fabaf, four fresh sessions exercised scoped policy application
using only synthetic projects Harness Cedar Observatory 1789856359613 and
Harness Quartz Observatory 1789856359613. Cedar initially requested uncertainty
bounds before the central estimate (fact3745), then corrected that order
(fact3746). Quartz retained bounds-first (fact3747). Independent readonly DB
checks confirmed3745 inactive/superseded_by3746, and3746/3747 active with exact
respective source sessions. The application request supplied only new numbers
and used “midpoint”/“range” rather than restating either stored order.

Fresh source241518 returned exactly:
Cedar: 18 (14–23)
Quartz: 40–51 (44)
Both conventions are correctly applied; the neighbor did not inherit Cedar's
correction. No product change was necessary for this bounded behavior.
Sources241417/241446/241489 were the original/correction/neighbor capture turns.
Canonical measurement records are saved for all four sources; application used
two calls/17,041 input tokens/10,162ms. No matched-model cost advantage claimed.

Important attribution limit: automatic primer recall mr-2dfe1572-374d-4307-87e4-
6fceac822b62 injected944bytes, six hits, after1,327ms, with103 candidates. Its
candidate_refs_json contains SIX ENTITY summaries, not facts3746/3747, and has
no recorded uses. This does not prove semantic retrieval provided the rules;
standing memory context is a separate input. Do not present the successful
answer as evidence that the semantic primer independently recalled the facts.
Next inspect that distinction before changing recall/ranking/utility accounting.
Do not add credit to facts solely because the final answer happened to agree.

Only exact synthetic facts3745/3746/3747 were soft-forgotten through the installed
endpoint after saving source/fact evidence. All are now inactive. No personal
facts or entity records were edited, and no broad cleanup ran.
Receipts in output/weekend-harness-2026-09-19:
`memory-semantic-application-{start,progress,result,events}.json`,
`memory-semantic-{original,correction,neighbor,application}-{request,response}.json`,
`memory-semantic-independent.json`, `memory-semantic-cleanup.json`.
The script check-memory-semantic-application.mjs finished successfully; do not
poll or resubmit process47535. No hotpatch was needed in this acceptance turn.

## Memory attribution resolved; unified cross-store ordering is the next issue

Current runtime rechecked: ae71fabaf, daemon14257. Shared main e5a75f5a;
Claude80577 still present. No product source or personal memory changed in this
read-only diagnostic turn.

Exact exposure trace for source241518 shows facts3747 and3746 included by
facts_for_instructions, reason=scored-stanford-objective, pinned=false. Obsolete
3745 was not included. Thus the main task-ranked fact block explains how both
current conventions reached the model. This is not merely a claim that a fact
was present somewhere in storage.

Using installed recallMemory with an explicit historical asOf before test
cleanup (no reactivation or database writes) exposes a ranking problem. Both
preferences are retrieved, including semantic similarity0.82/0.80 and stored
graph traversal, but rank19/20 at scores0.6358/0.6343. The first six hits are
entity type/mention-count stubs at the same fixed0.72. Other stores also use
independent score floors. The original six-slot automatic primer therefore
showed none of the preferences despite finding them. Historical diagnostics
had110 candidates rather than original103, and current graph/utility state can
differ; this is NOT an exact replay of the original turn.

Next: correct cross-store relevance/selection with evidence-driven coverage,
including explicit entity-scoped facts, entity/roster lookup, unrelated-neighbor
scope, and superseded-fact exclusion. Do not simply increase the prompt limit,
invent memory utility credit, delete personal entity records, globally boost all
facts, or tune a literal test-project-name shortcut. The independently working
main task-ranked fact block must remain intact. Existing synthetic facts3745–
3747 remain soft-forgotten; any new live fixture needs its own scoped identity.

Receipts: memory-semantic-injection-trace.json,
memory-semantic-historical-ranking.json, and
memory-semantic-attribution-diagnosis.json under the weekend output directory.

## Memory duplicate coverage and partial correction — 2026-09-19 22:54 UTC

Scope reconfirmed: shared framework only; live home is the acceptance environment.
Claude process80577 remained in the shared main checkout at e5a75f5a. No token
meter edits, personal integration repair, commits, or release publication.

The prior named-entity ranking candidate b706f11 failed source241642: two
paraphrases of the initial Cedar convention survived; correction retired one,
and Sol used the obsolete other copy to change a correct answer into a wrong
one. Exact test facts3748–3751 were soft-forgotten after evidence capture. The
rollback to ae71fabaf was confirmed running on daemon49950. Original receipts:
`memory-semantic-fixed-failure.json`, `memory-semantic-fixed-cleanup.json`,
`named-entity-recall-rollback.json`.

Framework changes in reflection.ts plus two pure helper modules:
- Supplement semantic candidates with same-kind active lexical hits absent
  from the pre-query embedding snapshot. Unscored candidates prevent novelty
  bypass. This covers a populated-but-lagging embedding index without assuming
  paraphrases are identical or retiring distinct facts.
- After a partial explicit correction, surface remaining related active facts
  through the existing unresolved-conflict result and durable queue. Retire
  nothing merely because it is related. The foreground caller must compare
  exact records against the user's instruction.
- Preserve explicit correction intent in “replaces the previous” / “supersedes
  the prior” phrasing, not only a literal “Correction:” marker.

Nine pure checks passed; backend builds passed. Installed framework and both web
asset trees hotpatched with rollback backups. Latest running fingerprint:
26b05a86b310dbe5b3bfa138593e59b74b3ebaa961e91455e8c601e23615d758,
app3.18.17, schema81/81, daemon81094. Both web digests unchanged and verified.
No destructive fixture resets or isolated-home acceptance was used.

Bounded live evidence:
- dbf5800b: four-stage fresh capture/correction/neighbor/application test passed
  sources241666,241695,241737,241767. One initial canonical fact3752, corrected
  successor3753, separate neighbor3754. Correct answer “Cedar: 18 (14–23) /
  Quartz: 40–51 (44).” Each stage had a successful Sol review.
- 41278543: same conventions applied correctly after restart, source241788.
  Actual one Terra and one Sol call. A direct installed-module check with a
  controlled injected resolver reported the remaining old duplicate while
  preserving a complementary timestamp fact; this is not provider validation.
- 41278543: pre-existing duplicate scenario source241809 FAILED independently
  despite successful review; second old fact3760 remained active. Model tool
  content used replacement wording without “Correction,” exposing the intent
  recognition gap. Do not call this a pass.
- 26b05a86: fresh duplicate scenario source241853 PASSED independently. Old
  facts3763 and3764 inactive, complementary timestamp fact3765 active,
  corrected fact3766 active. The brain used the unresolved-conflict result and
  soft-forgot only3764. Sol fulfills=true. Measured through the canonical
  measureAcceptedTurn: 7 Terra + 4 Sol calls,106415 input,38016 cached,50215ms.
  No broad efficiency win follows from this correctness test.

All controlled facts3752–3766 were soft-forgotten after evidence capture. See
memory-coverage-cleanup.json (3752–3754 and3759–3762),
memory-partial-correction-cleanup.json (3755–3758), and
memory-duplicate-wording-cleanup.json (3763–3766). No personal rows were cleaned.

Remaining: unified recall still provided only one of two project rules in the
four-stage application's automatic primer. The main fact block can supply the
other; correct output is not proof of complete unified recall. Related-candidate
notices also include broadly similar projects, so source/scope precision remains
open. More natural paraphrases can omit every lexical correction marker; current
wording coverage is bounded, not a complete intent representation. Keep working
on those framework issues and matched efficiency rather than retesting these
same successful cases without a new reason. Full artifacts use prefixes
memory-coverage-*, memory-partial-correction-*, memory-duplicate-*, and
memory-correction-wording-* under output/weekend-harness-2026-09-19/.

## Native tools: rejected promotion and real desktop run — 2026-09-19 23:07 UTC

The user prioritized first-class native Space and workflow authoring/execution.
Installed audit native-tool-surface-before.json shows none of the relevant native
schemas for fresh ordinary create/run/status requests. Creating every schema on
every turn would carry large authoring definitions; bytes are recorded in the
receipt, not falsely labeled as measured tokens.

Candidate c1805deba76a4f85ec795e93fd1ddce2b52cf7de6b786852bde6f6898c17b40c
added bounded lexical family promotion. Five pure checks passed, but the real
request's “no schedule” selected workflow_schedule and displaced workflow_run.
The action-mode visibleFirstClassNames filter also strips plan-bound local
mutations after hot-set selection. Candidate rejected, source changes removed,
and app restored to26b05a86 with native-tool-promotion-rollback.json. Prior tool
plural ranking changes remain. Local dist remains the rejected candidate until
the next build; do not hotpatch it blindly.

Source241939 via /api/message created synthetic workflow
harness-native-firstclass-1789858855239, repaired a project binding, then refused
workflow_run before queueing because webhook had no bindable report-back target.
No file existed and no child run was queued. This is a route-specific limitation,
not a desktop failure. Its raw request/response and trace evidence are under
native-workflow-chat-*.

Retried execution through the actual desktop route /api/harness/chat with a new
source and explicit normal-mode version1. An initial missing taskMode.version
was rejected400 before acceptance. The corrected request returned202; a test
assertion incorrectly expected200, but the request WAS accepted and was NOT
resubmitted. Followed its exact session/run handles.

Desktop source242076 in sess-desktop-c9223b1535971f7f546b7fb3 called workflow_get
and workflow_run directly on restored26b05a86. Single child run
1789859134707-730a15 completed, exact file content NATIVE_FRAMEWORK_OK plus newline
was independently read, goalValidation.pass=true/judgeFailedOpen=false, and a
workflow_report_back terminal was delivered to the source. Saved fixture workflow
was disabled afterward. The raw report-back includes internal receipt blobs,
an observed shared UX issue rather than a polished-output success.

Next investigate real native authoring surface/carrier integration, not another
prompt-keyword selector. No benchmark advantage or full native-tool acceptance
is claimed. Receipts: native-workflow-desktop-result.json,
native-workflow-disabled.json, native-tool-surface-{before,after}.json,
native-tool-promotion-rollback.json. Existing code comments and pure success did
not establish actual callable model exposure; the live test changed the next step.


## Direct native authoring candidate — latest live finding

Framework-only scope reaffirmed. Shared main remains e5a75f5a; Claude process
80577 is alive. User-owned usage-sidecar work is preserved. No benchmark win
or broad acceptance is claimed.

Installed fb8583b8 adds stable native product tools to the first-class catalog.
Normal-mode carrier visibility exposes space_save, workflow_create and
workflow_update. Host-bound current tool definitions prepare exact calls and
retain execution/consent receipts; missing authority fails closed. Plan and
reviewed Execute retain their existing path. No prompt-keyword promotion.
New native-product-surface.ts and direct-native-preparation.test.ts accompany
changes to tool-catalog, orchestrator, host-local-call-preparation and
host-turn-runner. Three pure preparation checks and the backend build passed;
installed daemon and both web asset trees were hotpatched with rollback retained.

Desktop source242121, session sess-desktop-06e46a7e2a9e55774abd8518, directly
called workflow_list, workflow_create, workflow_get and workflow_run (no generic
discovery/dispatch wrapper). Exactly one child1789859807131-49021a ran the saved
literal transform and returned NATIVE_DIRECT_OK. However final workflow outcome
was BLOCKED/needsAttention: inferred legacy goal review objected to the framework's
Markdown step heading around the exact result. The desktop received the result
plus this warning. This proves direct native creation and dispatch, NOT clean
end-to-end acceptance. Investigate goal evidence/presentation mismatch without
weakening review. There was no explicit authored goal in this fixture.

Synthetic workflow harness-direct-native-1789859774727 is now disabled and kept
for review. Evidence: native-direct-chat-final-events.json,
native-direct-chat-progress.json, native-direct-current-build.json,
native-direct-disabled.json under output/weekend-harness-2026-09-19/.

Next: resolve shared result/review formatting mismatch, live-test direct Space
creation and workflow update/status, and verify Plan/Execute parity. Native schema
size and broad workflow_list before unique creation are efficiency concerns.
Memory correction has bounded live proof; recall ranking and scope precision
remain incomplete. User's later Claude Code comparison should measure correct
completion, total/cached tokens, latency and repeat explanation across fresh,
warm and memory-assisted sessions; no unsolicited comparison is running.


## Native product tools and delivered-result review — live continuation

Latest installed fingerprint 0291d8a020072f9e425d65bab8deba160273542d5809e3c48507768f9b81f234
supersedes fb8583b8. Both webtrees installed/digest-verified; backups retained.
Shared main remains e5a75f5a; other Claude process80577 alive. No commits/push.

Fixed workflow target review input: JudgeWorkflowTargetInput.deliveredBody carries
the actual host-rendered baseSuccessBody, while authenticated execution evidence
remains separate. Internal step headings no longer masquerade as delivered text.
28 pure objective-judge checks passed, including exact literal output and a wrong
delivered output despite a correct internal rollup. Build passed. On installed
c1d15e29, source242179/session sess-desktop-c3dcd7fa3050d3145293562f directly
created and ran workflow harness-direct-native-1789860224322. Exactly one child
1789860260424-44bf15 succeeded, returned NATIVE_DIRECT_OK and delivered that exact
text without the prior warning; completed verdict reviewed/verified. The fixture
was disabled afterward. Measurement: 145212 input,33792 cached,52318ms,5Terra+3Sol.
This is bounded correctness proof, not efficient performance or broad qualification.

Initial Space source242194 on c1d15e29 saved correct static desktop/mobile data
but took4 discovery calls and used work_call for space_save. The first-class
schema was present; native-authoring-catalog still instructed discovery for it.
Removed already-visible tool names from that deferred-authoring catalog, built
and hotpatched 0291d8a0. Fresh source242345/session
sess-desktop-ddd71444f69f29c8caf7a076 used skill_read, direct space_save, then
one tool_search and space_preview for verification. Saved Space
harness-direct-space-1789860419557 contains both pending checklist items in HTML
and _mobile, dataSources/actions empty, no automation. Sol completion review
passed. This verifies stored mobile content, not physical phone rendering.
Earlier saved fixture harness-direct-space-1789860237996 remains for review.
Measured initial vs fresh:391946→152456 input,63104→64512 cached,
101574→50898ms;7→4 canonical calls. Different fresh sessions/model behavior;
this observed improvement is not a controlled benchmark or general cost win.

Source242360/session sess-desktop-27670c7d4471166904b4fad5 directly used
workflow_get, workflow_update, workflow_run_status. Independently read saved
workflow: only requested description changed, enabled=false, manual trigger and
literal step retained. Existing child status/result correct; no rerun requested.
Sol review passed.96367input/44544cached/41823ms;4Terra+1Sol.

Receipts: native-deliverable-review-{tests,build,hotpatch},
native-deliverable-retest-{events,run,measurement,disabled},
native-catalog-consistency-{build,hotpatch,assets},
native-space-{chat,retest}-{events,measurement}, native-space-retest-stored.json,
native-workflow-update-{events,measurement,saved.md} in weekend output.

NEXT: Native schemas currently contribute ~28137 estimated prompt tokens even
for simple tasks. Reduce schema/description overhead while preserving first-class
usable native capabilities, no keyword routing or hidden execution policy bypass.
Preview still needs discovery; consider an intentional compact native product
surface. workflow_step_result in the always-loaded list is a worker output channel,
not a run-result reader (not exposed in these orchestrator policies); remove the
misleading catalog entry during next surface cleanup. Workflow run status already
returns step results. Revalidate Plan/Execute parity for the changed surface,
then continue memory relevance/scope work. User's Claude comparison remains later.
Framework-only, live-home acceptance, no isolated/reset fixtures remain binding.


## Compact native guidance — installed/live verified

Installed fingerprint c4138b0d4414480d9c9e24901668da88f3d4cbbdd09fc659f305656c650fd9d0.
Build and3 pure native-preparation checks passed. Both web assets recopied with
digest verification and rollback retained. Shared main e5a75f5a/Claude80577 unchanged.

space_save root guidance condensed7354→2798bytes; retained mobile shape,
static atomic commit/revision rules, sandbox/approval constraints and preservation.
workflow_create no longer demands workflow_list before every creation; duplicates
already reject without changing existing definitions. Removed workflow_step_result
from always-loaded list: it is the worker result submission channel, not a reader.
Installed-before vs built-after parameter schemas are deeply equal for all3 native
authoring tools (native-guidance-schema-comparison.json). Prompt composition's
estimated tool schemas fell28137→26879tokens,1258 fewer per model call. This is
still large and parameter schemas remain the main overhead.

Live desktop workflow source242448/session sess-desktop-2725f44d5c13acd19226c58a:
direct workflow_create,get,run; no list or discovery. Exactly one child
1789860796382-2a8e51 succeeded and delivered NATIVE_DIRECT_OK; fixture
harness-direct-native-1789860762017 disabled afterward. Canonical measurement:
96255input/15872cached/44335ms,4Terra+2Sol; prior comparable request145212input,
33792cached,52318ms,5Terra+3Sol. Observed reduction; not controlled benchmark.

Live Space source242452/session sess-desktop-ce1e2a5c32a83c4e3e960faa:
skill_read then direct space_save only. Completion reviewSol passed; independently
verified savedHTML and_mobile contain both requested pending items, no sources or
actions. Fixture harness-direct-space-1789860762017 retained.86977input/14464cached,
44273ms,3Terra+1Sol. No space_preview call this time; stored content was independently
read, physical phone/rendering still unverified. Do not claim all speed improvement
is from description shortening: call choice and provider behavior differ.

Receipts native-guidance-{compact-build,compact-tests,compact-hotpatch,
compact-assets,schema-comparison}, native-compact-{workflow,space}-{events,
measurement}, native-compact-workflow-{run,disabled}, native-compact-space-stored.
Next: Plan/Execute surface parity and memory relevance/scope; further schema
reduction must preserve supported authoring contracts, not replace inputs with
opaque strings or keyword selection. No broad efficiency/Claude comparison claim.


## Native workflow Plan → Execute acceptance on c4138b0d

Live desktop session sess-desktop-a5684ea2c56d1d88b3f43cf9:
Plan source242537 published ready plan-00571b20-53b0-4161-9b65-696f3c61222f,
revision1,digest51367a3eaad4d201d893d5e133799d737c1ecb7713dd1cabf5d9666b00d759b6.
Reviewed exact static arguments: single literal PLAN_NATIVE_OK step, no external
calls/resources, manual-only, no execution. Independently confirmed definition
absent before Execute. Planning tool calls were discovery and publish_plan only.

Execute source242577 applied reviewed operation create_manual_test_workflow via
work_call. Saved definition harness-plan-native-1789860936276 matches the plan;
workflow_get readback and Sol completion review passed. No workflow run records
exist for this fixture. Replayed the same desktop execution request/id: returned
replayed=true and original runId, one distinct creation call after replay.
Fixture disabled after acceptance, retained for review. No source changes or
hotpatch in this continuation; installed c4138b0d remains current.

Receipts native-plan-workflow-{start,response,events}, native-plan-execute-
{request,response,events,replay}, native-plan-independent-verification,
native-plan-disabled, native-plan-measurement-{242537,242577} in weekend output.
This is workflow authoring parity, not all Space/graph/recovery coverage.
Execute still did a tool_search for already-exposed workflow_get before direct
readback; record redundant lookup as efficiency issue, not correctness failure.

Memory follow-up source inspection: explicitCorrectionSubjectKeys captures only
one token after project/account/etc, so names sharing a prefix (e.g. Harness)
can look compatible. Do not make project isolation depend on this lexical shortcut
or retire facts from a guessed name. Next inspect stored entity links and scoped
candidate evidence before choosing a correction/retrieval fix. Existing primer
ranking still incomplete and no general memory-quality claim is justified.


## Neighbor-first memory acceptance; grounded identity defect narrowed

No source changes/hotpatch; installed c4138b0d remains current. Live four-stage
fixture1789861204041 saved Cedar bounds-first3769, then Quartz bounds-first3770,
then corrected only Cedar.3769 superseded by3771;3770 remained active unchanged.
Fresh application returned exactly Cedar:18(14–23), Quartz:40–51(44). All4 Sol
completion reviews fulfilled. This ordering is stronger than prior correction-
before-neighbor case. No wrong cross-project correction was reproduced.
Exact synthetic facts3770/3771 soft-forgotten after evidence;3769 alreadyinactive;
all3inactive confirmed. No personal-memory cleanup.

However direct fact-entity capture conclusively overclaims identity:3769 links
as extracted to3 Cedar identities and an older Harness Cedar Observatory timestamp,
plus its actual current canonical project4565.3770 similarly links to older
Quartz test-project identities plus actual4566. Shared short aliases explain this.
1069 project fact edges have extracted/source evidence overall (an initial query
for literal link_type='stored' was invalid: stored is a presentation truth label;
actual table uses extracted/inferred_text). Do not treat all graph links as
unambiguous project authority or prune correction targets using them blindly.

Relevant source: facts.ts captureDirectFactEntityLinksBestEffort uses
resolveEntityIdsForText(fact.content,8), then marks every returned alias/name
match extracted at full fact confidence. relations.ts resolver matches aliases
without ambiguity filtering. Next implement grounded direct-link selection:
full canonical-name evidence must outrank overlapping shorter aliases; ambiguous
aliases must not create multiple stored identity assertions. Preserve potential
recall matches as inferred, do not delete existing owner links or infer subject
identity from a project-name first token. Add pure matching checks and validate
new synthetic facts in installed/live home. Then revisit correction notices and
ranking using trustworthy scoped candidates.

Receipts memory-neighbor-first-{application-result,entity-evidence,events,
cleanup}.json and live.txt. Script first attempted Electron with repo-native
SQLite and failed ABI loading before requests; reran under Node22 successfully.
Terminal process10792 completed0; no running test or unfinished stage.


## Grounded direct-memory entity mentions — implemented and live accepted

Latest installed fingerprint64a29b52d3f755c705621e7f56ed672222f7468356862209d23f69753dab79a3.
Backend build and7 pure matching tests passed; daemon and both webtrees patched
with rollback. Shared main e5a75f5a and Claude80577 preserved, no commit/push.

New grounded-entity-mentions.ts selects nonoverlapping maximal name mentions,
rejects same-span shared names/aliases across identities, and keeps independent
short mentions elsewhere. relations.ts matcher cache retains names and new
resolveGroundedEntityIdsForText requires a unique mention in BOTH fact content
and surviving evidence excerpt; result limit is applied after disambiguation.
facts.ts direct capture now uses this resolver. Broad recall alias/identifier
matching remains intact; this change governs new stored name-backed assertions.
Identifier-only direct claims no longer get a stored link from name matching;
identifier recall remains available. No bulk repair of existing links performed.

Installed read-only resolver against live identities: exact Harness Cedar
Observatory1789861204041 matched broad ids3873,3955,3958,4557,4565 but grounded
only4565; ambiguous Cedar alone matched no grounded identity. New real chat
probe-grounded-entity-1789861553649 created fact3772 for the requested archive
prefix CedarTrial. Independently read DB: exactly one extracted source-backed
edge, entity4565; no older project/short Cedar identities. Sol review242809passed.
Fresh session probe-grounded-recall-1789861613279 returned exactly CedarTrial,
Sol review242830passed. Exact synthetic fact3772 soft-forgotten afterward and
active=0 confirmed. This is bounded new-write/link/recall proof, not blanket
historical graph repair or general correction-scope completion.

Receipts grounded-entity-mentions-{tests,build,hotpatch,assets},
grounded-entity-installed-result,grounded-entity-chat-{start,result,evidence,events},
grounded-entity-recall-{start,result,events},grounded-entity-cleanup in weekend output.

Remaining memory work: correction-related candidate notices still use lexical
project-prefix relation, old links can remain ambiguous, broader reflection and
backfill link admission need review, named-entity primer ranking still incomplete.
Do not now trust every historical extracted edge as an unambiguous scope anchor.
Continue precision/ranking with actual source evidence and bounded context.


## Automatic primer coverage for two named projects — live improvement

Latest installed86402bb62b6699fdc44f26edfc5d37a0eedce0b637a371ba65146cf3a1e1a844.
recall-memory.ts now puts unambiguous grounded mention IDs before broad alias
IDs within the SAME perStore limit, and reduces incidental alias-only entity
scores when unambiguous mentions exist. No hit/context budgets increased; broad
recall candidates remain available. Eleven focused matching/ranking checks and
build passed; daemon and both webtrees hotpatched/digest-verified with backups.

Read-only pre-fix exactquery with two fully named projects returned8 broad IDs
but omitted Quartz4566. Grounded lookup included4565 and4566. Earlier automatic
primer had only Cedar current fact plus short/older entities. Receipts:
recall-entity-crowding-before.json, recall-entity-priority-{tests,build,hotpatch,assets}.

Live four-stage fixture1789861904594 saved Cedar3773 and Quartz3774, then corrected
Cedar3775 (3773retired,3774preserved). Fresh final response Cedar18(14–23),
Quartz40–51(44); all4 Sol reviews passed. Crucially automatic_primer
mr-501bda9a-eeb7-4a84-8123-53462463fa32 includes BOTH current fact refs3774/3775
among6returned hits. This closes the previously observed two-rule primer gap for
this bounded case. No extra recall tool was needed. Same unchanged context cap.
All synthetic3773–3775inactive after exact-ID cleanup.

Remaining defect found during new-identity admission:3773 initially linked old
entity4557 via its unique alias 'Harness Cedar Observatory' BEFORE new canonical
entity4567 was registered; later new full identity link appeared too. The prior
64a29 fix passed for an already-known canonical identity but does not solve this
new-identity timing case. Preserve this limitation, do not claim historical graph
repair or complete identity isolation. Evidence memory-primer-both-links.json.
Next examine direct alias grounding when no complete canonical identity exists:
ambiguous/new names should remain candidate evidence, not confident stored links
to an old project. Revisit reflection/backfill admission and correction scope.
Primer also still admits weak unrelated entity/deliverable hits; relevance remains
an efficiency target without simply growing context.

Receipts memory-primer-both-{application-result,recall-evidence,links,events,
cleanup}.json and live.txt. Script97990terminal0; no active test. Shared main
and other-agent edits preserved. No commits/push, no model comparison claim.


## New-project alias timing — installed/live fix

Latest installed eae80719f0a19c4b77fcf28ca42f1bac9554581563c737779db2c1867404c726.
Added canonicalOnly selection to grounded-entity-mentions/relations; matcher cache
retains canonical name. Direct fact capture requests canonical-only proof in both
claim and surviving source excerpt. Aliases still participate in longest-span
ambiguity resolution BEFORE admission, preventing an old longer alias from
exposing a nested unrelated short canonical name. Broad recall and grounded
recall prioritization keep alias candidates; no additional model call introduced.
Alias-only direct claims await normal entity extraction for stored identity links.
13purematching/ranking checks andbuild passed. Daemon andbothwebtrees installed,
digestverified, rollbackretained. Sharedmain/otheragentedits preserved.

Live new project Harness Cedar Observatory1789862279505, source session
probe-new-project-identity-1789862279505: new fact3776 for archive prefixCedarTrial
has exactlyone extracted link to new entity4569, both early and final DB snapshots.
No priorproject/shortalias link. Entity extraction established correctfullidentity.
Fresh session probe-new-project-recall-1789862314953 returned exactlyCedarTrial.
Sol review243000 and243021fulfilled. Exacttestfact3776softforgotten;active0verified.
This accepts the reproduced unknown-new-project timing case. It does not certify
all reflection/backfill identity paths or repair historical wrong links.

Receipts new-project-identity-{tests,build,hotpatch,assets,chat-start,chat-result,
early-links,final-evidence,recall-start,recall-result,events,cleanup} in weekend output.
No active test handles:51408 and88498terminal0. No commits/push.

Next: inspect correction-related notices for cross-project noise using canonical
source evidence, not historical links indiscriminately; review broader reflection/
backfill link grounding before claiminggraphidentitysoundness. Primer relevance
still contains weak unrelated entities/deliverables and tool schemasremainlarge.
Preserve full framework backlog, liveacceptance requirement, later userbenchmark.


## Deliverable primer relevance — live candidate with review limitation

Latest installed73d3eb3b9424a5adf25f18f0df46c2367860e6a0dbe08ea90ceb0cb4e594a528.
New deliverable-recall-score.ts preserves raw index relevance instead of adding
0.55+0.4*score; ambient deliverables below0.45 omitted, targeted recall remains
broad. Relevant missing files retain capped0.4 negative evidence (admit before
missing-file confidence cap). deliverable-index.ts gives exact target/filename
matches score1 regardless of surrounding prose; boundary checks reject prefixes.
Sixpurechecks/buildpassed, daemon+bothwebtrees installedwithrollback.

Initial d7962166 candidate removed irrelevant hits but FAILED natural-length
exact-filename primer recall: correct answer came from other context, no direct
file ref in automatic primer. Fixed exact-target scoring before accepting that
behavior; do not reuse initial correct answer as passing primer evidence.

Installed-module live-home comparison: unrelated two-project query deliverable
hits6→0; final natural-language exact filename query returns1 correct artifact;
targeted broad query retains6candidates. Final fresh public chat session
probe-deliverable-primer-1789862864825 returned correct existing local path with
zero tool calls. Crucially automatic_primer contains exact file ref now; filesystem
existence independently checked. However completionReview=enabled_unavailable,
no completionVerdictRef on both initial/final chats: NOT a successful provider
review. Treat this as bounded independent recall/content proof, not reviewed
completion or broad acceptance. Investigate framework review-disposition reason
if relevant; do not alter personal auth/config to make the test green.

No fixturefacts created/modified in this test; saved artifacts unchanged. Runtime
schema/tool/memory budgets unchanged. No global token/speed/Claude comparison claim.
Receipts deliverable-primer-{before,after,final}, deliverable-primer-score-
{tests,build,hotpatch,assets}, deliverable-exact-target-{hotpatch,assets},
deliverable-{primer,exact}-chat-{start,result,events,recall} in weekend output.
Final process64156terminal0; no unfinished test. Sharedmain/Claude80577preserved.

Remaining: primer unrelated entity relevance, semantic deliverable matches across
long task prose (threshold tradeoff requires broader coverage), correction scope,
reflection/backfill graph admission, reviewed UI/mobile/release backlog. Exact
artifact matching was added to prevent the known false negative; do not simply
lower all scores further or claim comprehensive relevance solved.


## Lookup review disposition corrected; real read remains reviewed

Latest installed f2ba7a89294d99b4750cb9456491467541335538ef783b5e5ca2ddaf1a04ac7d.
The prior lookup's enabled_unavailable was NOT a provider outage: classifyMessageIntent
returnedlookup/actionIntentfalse; path reply triggered claimedCompletedWork=true.
Existing shouldRunObjectiveJudge correctly skipped this non-action/no-work turn,
but completion-review-skip metadata refused to describe it. Added narrowly bound
non_action_without_new_work reason when other conversational skip conditions hold.
No review eligibility or execution gate changed. Skip remains source/objective/
reply-digest bound and never certifies content.4purechecks/buildpassed;daemon and
bothwebtreeshotpatchedwithrollback.

Live source243066/session probe-lookup-review-1789863145572: correct existing path,
0tools, exact completion_review_skipped243082record, terminalcompletionReview
not_required/captured (not reviewed or unavailable). Gate recorded allsourceeffects0,
noattemptedwork, actionIntentfalse, claimedCompletedWorktrue. Actual currentgate
metadata verifies diagnosis, not only reconstruction.

Countercheck session probe-lookup-action-1789863191347 explicitly read current
file once: read_filecalled, NATIVE_FRAMEWORK_OK returned, Sol review243110fulfilled.
Independentdiskcontentmatched. Thus realreadworkstillreviewed;0toollookupskip
metadata does not waive it. No userfiles/memorychanged.

Receipts lookup-review-disposition-{tests,build,hotpatch,assets},
lookup-review-{chat,action}-{start,result,events} inweekendoutput.
Bothprocess44722/4555terminal0. Prior73d3 recallproof remains independentlyvalid;
its review-unavailable label was a metadata mismatch, not successfulproviderreview.

Next return to framework acceptance backlog: correction-scopeprecision and broader
memorygrounding, nativeSpacePlan/Execute parity, longhorizon/multisteprecovery,
physicalmobile/releaseparity, and meaningful efficiencymeasurement. No broad
completion claim or unsolicited Claude comparison; user's benchmark remainslater.


## Space Plan → Execute live acceptance; preview transport follow-up

Installed f2ba7a89294d99b4750cb9456491467541335538ef783b5e5ca2ddaf1a04ac7d.
Session sess-desktop-f67759c8e0ba5e8fd483f0ff: Plan source243115 left fixture absent;
Execute source243173 completed243287, actual Sol review243273 fulfilled.
Space harness-plan-space-1789863281227 saved once via reviewed work_call/space_save;
transport mirror shares same call ID. Independent disk comparison: exact reviewed
HTML and initial data including _mobile, version1, empty sources/actions. Fixture
retained. Same clientRequestId replay returned original run desktop:d0d2043f38ae227c9b50d1cd7a824afb626f9a9d, replayed=true.
Receipts native-space-execute-{request,response,events,replay}.json and
native-space-independent-verification.json under weekend output.

LIMITATION / NEXT FRAMEWORK ISSUE: space_preview produced image-bearing results,
but work_call returned a JSON text digest omitting the image; model used two extra
tool_output_query calls which returned base64 inside text. Rendering success does
not prove visual inspection. Narrow desktop preview does not prove physical mobile.
Inspect multimodal image transport across reviewed work_call and result formatting;
fix generic first-class image result handling rather than prompt-specific workaround.
No speed/token superiority claimed. Memory reflection/backfill identity and correction
scope, long-horizon recovery, UI/mobile/release coverage remain open. No source edits
or hotpatch this turn; current installed build tested. User usage-sidecar preserved.


## Media carrier patch installed; read-only Execute does not qualify it

Changed src/tools/work-call.ts to preserve successful isToolMediaContent arrays
before JSON.stringify, guarded by !frame.refusalKind; refusal semantics unchanged.
Changed work-call-mcp.ts to return media content blocks. Existing call_tool and
host-turn-runner already support images. Two pure media-recognizer/projection tests
passed; build passed; installed fingerprint
0b298e10dc02c62b42de5450fa9662ac7ec3597c4a5d92c58d611e84a50f1ba3.
Daemon+bothwebtrees backed up and patched; readiness fingerprint verified. No live
leases at quit. Other Claude80577 alive/sharedmain; usage-sidecar preserved.

Live read-only preview Plan session sess-desktop-71d2e986d52b36907f302c6c,
source243288, plan-ab68cefe-a842-4d28-baef-68081f310750 rev1 digest
041281dbe6a8fffdae7f6963aa91db1fde8fe27b3211417755b25c0023b678d3.
Execute source243335/run desktop:0a2c424ded202e88c7bb83bb7f64584f563cc330
completed243397; Sol243393fulfilled. Report described readable labels, Pending
badges/right-aligned status. NO tool_output_query/base64 rereads, but preview ran
through call_tool after work_call refused plan activation. THIS DOES NOT validate
changed work_call media path or Claude adapter. Do not claim that patch accepted.

Next: qualify actual work_call media path with normal action Plan/Execute fixture
(as prior Space creation + previews), inspect accepted provider image history.
Also investigate read-only Execute surface inconsistency: orchestrator deliberately
withholds plan_task/plan_step_result when reviewedReadOnlyExecution, while work_call
still refuses without plan_task; prompts/model attempted both missing controls and
wasted searches. Preserve read-only semantics, fix coherent surface/steering rather
than gratuitously activating business graphs. Current run terminal, do not restart.
Receipts work-call-media-{tests,build,hotpatch,assets}, media-preview-{plan-start,
plan-response,plan-events,execute-request,execute-response,execute-events}.
Broader original framework/memory/efficiency/recovery/UI scope remains active.


## Media action qualification uncovered plan-repair friction; continuation active

Current INSTALLED remains0b298e10dc02c62b42de5450fa9662ac7ec3597c4a5d92c58d611e84a50f1ba3.
SOURCE/DIST now also contain uninstalled orchestrator guidance branch for
reviewedReadOnlyExecution: explicit direct read/call_tool path, no plan_task or
plan_step_result, no reviewed-step work_call requirement IDs; compute findings
synthesized directly. Existing action-plan instruction unchanged. Build passed
(process35268terminal0), receipt readonly-execute-guidance-build.txt. Not hotpatched.

Media action Plan session sess-desktop-82c6f967223ccb3c70d47805 source243398
fixture harness-media-space-1789863972809. Plan repaired static/dynamic slug conflict
and mobile record format; Sol243476 rejected max-width760px centered layout per
workspace-builder. Model repaired width:100%, but plan_review_budget_spent rounds2
at243484 cut off re-review. Terminal243493 blocked, not a passing plan. Saved
plan-b2c442fd-cae4-46bc-9857-5478e040c4e7 rev1 digest
db69daf8551e2b0cb0877e094c67017ce7d7ad7c06e3fb22e9e1f41992e54f90.
Do not execute stale unverified plan blindly or count this as media acceptance.

ACTIVE followup same session, run desktop:66d1b037f3b35c21ffeba5abd5c7e28f0a120620,
HTTP202 accepted; asks review current repaired revision, publishready, no creation.
Poll this exact run; don't resubmit. Receipts media-action-plan-{start,response,events,
followup-request,followup-response}.json. Next inspect fresh reviewed plan, execute
matching localfixture, verify actual work_call image history/no base64 rereads.
Then hotpatch built read-only guidance when idle and qualify that independently.
Two-round repair cutoff is additional framework recovery/efficiency issue, not
proof that user action is required. Original broad goal remains incomplete.


## Reviewed work_call images LIVE PASS (Codex); pending read-only guidance patch

Installed0b298e10dc02c62b42de5450fa9662ac7ec3597c4a5d92c58d611e84a50f1ba3.
Followup source243494 passed Sol243525; currentplan plan-b2c442fd-cae4-46bc-9857-5478e040c4e7
rev2 digest2ed0e9a5f9ac9a31b1a03ffdf61cbeec812e480b4493d7f5146d61d044619c6d.
Execute source243535/run desktop:6f7f699f779c1de46e801a302693c743cd5dfd5a completed,
Sol243633fulfilled. Same session sess-desktop-82c6f967223ccb3c70d47805.
Space harness-media-space-1789863972809 created version1, empty sources/actions,
mobile records Native tools/Memory scope verified. Retained fixture.
CRITICAL evidence: sessions.metadata_json.__conversation.items has two work_call
function_call_result outputs with input_text + input_image, calls
call_HvIq44CB13QlvIVNPuyLwhVY and call_qL2yYxPPWd0hpRcpYGhuz9Ib.
No tool_output_query/recall_tool_result in Execute. Text event records name image
instead of base64. Saved actual image bytes from accepted history, inspected narrow
preview independently: readable labels and Pending badges, unclipped. These are
actual model images, not inference from a successful renderer or reply.
Receipts media-action-{followup-events,execute-request,execute-response,execute-events,
image-history}.json, media-accepted-call_*.png. Claude adapter remains unqualified;
physical mobile app not qualified by narrow desktop image. No broad speed/tokenwin.

Source and dist also contain built uninstalled read-only Execute guidance change
in orchestrator; next idle hotpatch and fresh read-only Plan/Execute validation.
No live run remains from media acceptance. Do not redo completed image test.

Correction to prior interpretation of review cutoff: publish-plan.ts intentionally
publishes third structurally sound candidate with last review advisory; delivery
still used prior negative digest and marked blocked. This is publication/delivery
review-disposition inconsistency, not simply a hard stop in publish_plan. Fix stale
negative handling without inventing successfulreview for unreviewed revisedbytes.
Original memory/reflection/backfill, recovery, UI/release, laterbenchmark scope stays.


## Read-only Execute guidance hotpatched and LIVE PASS

Latest installed66fe5e9392f6a241e6d7ea18fc5806db9cf1da3c385952ce85d765f513bdb067.
Rebuilt beforepatch: docs/checkpoints participate in sourcefingerprint, so checkpoint
updates invalidated earlier buildidentity. Build/rebuildpassed; daemon and bothweb
trees installedwithrollback. No activeleases at quit; sharedmain/Claude80577 intact.

Initial attempt reusecompletedread-onlyplan withchangedinput correctly409
PLAN_EXECUTE_CONFLICT; no execution began. Fresh Plan session
sess-desktop-e1601daa17718e94d3fec58d completed243697 withpositiveSolreview.
Plan339d9447-cde5-44c3-9335-df7e96388bd7 rev1 digest
81823131c875113d0abc85f62bfca7a00a1588dac4e20324b06448abb4aa284a.
Execute run desktop:6230f9e19fce03a78d9e57d0a4f97a241a8b9f09 completed243732
positiveSolreview. ExactlyONE top-level call: call_tool/space_preview. No
plan_task/work_call refusal, no plan_step_result/tool_search/image-reread inExecute.
Actualinput_image presentin acceptedhistory. Independentdiskcheck matches original
reviewedHTML/data andversion1, no contentchanged. Correctreportedvisible labels
andPendingstates. Thisqualifiesnarrowread-onlyguidancefix, notglobalperformance.
Receipts readonly-execute-{rebuild,hotpatch,assets}, readonly-fresh-{plan-start,
plan-response,plan-events,execute-request,execute-response,all-events,verification}.
Runterminal; nothingpending. Nextbroaderbacklog: publication/delivery stale-negative
reviewdisposition, memoryreflection/backfillidentity/correctionscope, longhorizon
recovery, Claudeimageadaptervalidation,physicalmobile/release; lateruserbenchmark.


## Final plan candidate review freshness patched; normal live publication passes

Installed8aef439b6934afea9473f6830c261dc068f47e551c98c42b4a809382d5c0d62c.
Changed publish-plan.ts: every structurally prepared candidate receives its own
review, including candidateafter2sendbacks. Repairbudgetstillboundsadditional
sendbacks; finalnegative remainscurrentnegative, never synthesizedsuccess.
New pure plan-review-repair-policy.ts drives this decision;3puretests pass
(finalrepairedreviewcalled, finalnegative noextra-loop, reviewerrorpropagates).
Buildpassed; daemon+bothwebtrees hotpatchedwithrollback; noactiveleasesatquit.

Live normalpublication session sess-desktop-7252e3805ed66b6cb56bc770,
source243733/run desktop:7252e3805ed66b6cb56bc770fb381ef557415885,
terminal243791 positiveSol243783, planMatches/replyMatchestrue.
Plan plan-de947000-2007-4c8f-b437-b36d03346c7d rev1 digest
ff4a69eafe7b7b74177bc8c7b412dd4edbeedf4aa3cc5a6e1c4815027cb607d0.
NoExecute requestedforthisregression; runterminal, noactiveworkfromit.
Thisprovesnormalpublication, notliveexhaustedbudgetbranch; thatbranchcurrently
haspurepolicycoverageonly. Do not claim end-to-end exhaustedrepairacceptance.
Receipts plan-review-freshness-{tests,build,hotpatch,assets},
review-freshness-plan-{start,response,events}.json.

Remaining UXfinding: hostplanreply derivedfromfirstparagraph truncatesmidword
when noheading (visible replyends 'and v'); notaddressedhere. Keep main priorities:
firstclassnative tools, usefulmemory correction/groundedreflection/backfill,
long-horizon recovery, actualClaudeadapter andphysicalmobile/release qualification,
lateruser-controlledtoken/speedbenchmark. NextfocusmemoryratherthanendlessSpace
fixturepolish. Sharedmain/otheragent/tokenmeter preserved. No globalwinclaimed.


## Background memory grounding patched; fresh live identity/recall passed

Latest installed e39e9ead49c77723ae0fa5ea14ec0c5ba44a97f1fcfe44001eadd4246702d9a5.
reflection.ts now uses whole-registry resolveGroundedEntityIdsForText canonicalOnly
for claim+sourceexcerpt, then intersects extractionIDs. Replaces per-extraction
any-alias regex that could promote incidental nestedshortnames. relations.ts
backfillGroundedFactEntityLinksInDatabase nameadmission likewise uses global
canonical maximalmention intersection; retains existing specific/unique checks
and strongidentifier route. buildEntityGroundingIndex includes aliases_json as
well as entity_aliases for ambiguity; cachesclaim/evidencementionsonceperfact.
No broad historicalrewrite/backfilljobrun. Existingpersonalgraph untouched.
9puregroundedmentiontests/buildpassed; daemon+bothwebtrees installedwithrollback.

Live newproject Harness Cedar Observatory1789865200708, fact3782, onlyentity4571
extractedlink. Session probe-background-grounding-1789865200708 saved; fresh
probe-background-grounding-recall-1789865255845 returnedCedarGrounded. ActualSol
243816/243837fulfilled. Exactsynthetic3782softforgotten, active0verified.
Receipts background-grounding-{tests,build,hotpatch,assets,chat-start,chat-result,
recall-start,recall-result,evidence,events,cleanup}. Noactiveprocess;20209/76212exit0.

LIMIT: liveuser-facingnewidentity/recallpassed; thisdoesnotprovehistoricalbackfill
branchran or everyreflectionpath. Backgroundadmissioncoverage stillneedsfocused
proof; no broadmemoryperfection/efficiencyclaim. Identifier-grounding boundary
and partialcorrection scope remainreviewtargets. Originalnative/workflow/recovery/
UI/mobile/release/Claudecoverage and laterbenchmark scope retained.


## Identifier boundary grounding patched; installed matcher/live-data check passed

Latest installed8bcdbb51afb3279bb5539bd6f5865703b2452e720bf7422e064f6b1275d51542,
schema81/readinessverified. New grounded-identifier-match.ts wholeemail/domain
boundary matching replaces includes() in relations.ts exactIdentifierMatch.
Reject mailboxprefix/domainextension/subdomainlookalikes; allow sentenceperiod,
casefolding, exactdomainasemail/URLhost. Legacy missingevidencereconciliation now
uses sameglobalcanonicalmaximalname matching asbackfill (no legacyjobrun).
12purechecks/buildpassed; daemon+bothwebtrees installedwithrollback.

Read-only liveaudit:2384activestored/extractedlinks;896 lackcanonicalname inclaim
or excerpt, NOT896provenerrors (aliases/identifiers mayexplain);0legacyextracted
linksmissingevidence. Saved background-grounding-readonly-audit.json; no rewriting.
Installedmatcher imported directly and checkedALL259distinctliveidentifiers
(169email,90domain):259exactaccepted;518prefix/suffixlookalikesrejected.
No valuesprinted, no databasewrites. Receipt identifier-grounding-live-readonly.json;
check-installed-identifiers.mjs usesSQLite readonlytrue, noisolatedhome.
Thisqualifiesinstalledidentifierpredicateagainstliveinputs, notwholebackfilljob.
Fullbackfillintegration andglobalhistoricalrepair remainunproven/notperformed.

Receipts identifier-grounding-{tests,build,hotpatch,assets}, buildproc94654exit0.
Noactiveforegroundtests. Next return to broader long-task/multi-step recovery;
do not spend everyturnonadditionalnarrowSpace/memoryfixtures. Preservealloriginal
frameworkscope, usertokenmeter andlatermatchedbenchmark, Claude/mobile/release gaps.


## Three-step workflow input-change test found non-reusable goal; repair active

Latest installed cbb68e5dd1872c5c6aac21c758bc83b6de5e21c86e1fc47037140fc52d598673,
readinessverified. Build91830exit0;daemon+bothassets patchedwithrollback, idleleases0.
Changed orchestration-tools.ts create/update project descriptions distinguish
verifiedconfiguredproject fromoutputfolder; savedgoalcriteria describecurrentinput
invariants, samplespecificvalues belonginacceptance unlessconstantrequiredforallruns.
No schemas/authoritychecks relaxed. Receipts reusable-workflow-guidance-{build,
hotpatch,assets}. Thisguidancechangehasnotyetpassedfreshcreationregression.

Workflow harness-multistep-1789865560731, session
sess-desktop-41e5bf90b8d41e2070b3aa8d, initialsource243842. Nativecreate/run:
firstrefusalunregisteredproject=outputfolder; modelrepairedviaworkflow_update and
queued1789865622228-11215b. 3steps readJSON→calculate→write; completed/succeeded,
3/19newlinecorrect, goalreviewpass/nonfailedopen. Storeddefinitionsnapshotchecked.
ChangedONLYsyntheticinputfile (ready4+7,hold500), APIqueued1789865718845-a0d9fb.
3stepscomputed2/11correctbutterminalOutcome blocked: savedgoalhardcoded3/19.
Thisisreusableauthoringfailure, notarithmetic/stepdatapropagationfailure.
Bothrunrecordsretained. Fixtureinput/outputfilesunderweekendoutput. Workflow still
enabled/manual-onlyforactivevalidation; disablewhenfinished. No schedules/apps/sends.
Receipts multistep-workflow-{start,response,events}, multistep-first-result,
multistep-second-{start,snapshot}.json. Sourcegraphpromptsteps(usemodels), not
fullydeterministictransformgraph. Notlonghorizon/crashcoverage.

ACTIVE repair request afterhotpatch, same session,
run desktop:3e15576d2d9a861d91d30e551e724bc1545aa1ac HTTP202.
Asks goal-only reusablecurrentinputcriteria, preservessteps/paths/manualbehavior,
runonceverify. Receipts multistep-repair-{request,response}.json.
Pollthisexactsession/childrun; do notresubmit. Verifyupdatedsavedgoalnohardcoded
sampleanswer, stepsunchanged, newchildterminalsuccess+file2/11, then disablefixture.
Later freshcreation regression neededforguidance; recovery/crashboundary stillopen.
Originalframeworkmemory/token/UI/mobile/release/Claudequalificationscope unchanged.


## Reusable workflow repair PASS; fresh authoring guidance FAILED

Installed remainscbb68e5dd1872c5c6aac21c758bc83b6de5e21c86e1fc47037140fc52d598673.
Repair child1789865946243-ef1d3e completed/succeeded, all3steps; goalreviewpass,
failedOpenfalse; summaryexact2/11newline. Definitionstepsbyte-structureequal first
run; goalonlychangedto currentinputinvariants. Evidence multistep-repair-child.json,
multistep-repair-verification.json. Oldfixture harness-multistep-1789865560731
DISABLED viaAPI200, receipt multistep-disabled.json. Manual-only retainedforreview.

Freshsamepromptafterguidance FAILED authoring regression. Session
sess-desktop-4905efeba13b73e2fa45f72b, run
desktop:4905efeba13b73e2fa45f72b3a31fe9d87a63a3e, fixture
harness-multistep-1789866053091. At244271 workflow_create againusedoutputdirectory
asprojectandgoalhardcoded3/19. At244282runrefusedmissingconfiguredproject;
modelworkflow_updateremovedbinding andqueuedchild1789866113164-f3144f at244300.
All3stepsmodel-driven despite available deterministic call/transform descriptors.
Do notclaimguidancefixedfreshcreation or token efficiency. Installedregistry
schemas inspected withElectron/liveenv: workflow_create HAS bothnewproject and
sample-specificgoaldescriptions; thisisnotstaleinstalledschema. workflow_update
hasnewgoaldescription; project textdifferentwording. Saved workflow_{create,update}
-live-guidance-schema.json. Needinspectactualorchestratorschema/recallranking if
relevant, avoidjustaddingmorepromptbulkuncritically.

Freshchild stillneeds authoritativeterminalcheck anddisablefixturewhenfinished;
latest snapshot multistep-fresh-child.json. Do notstartduplicate. Receipts
multistep-fresh-workflow-{start,response}, multistep-fresh-events.json.
Task remainsbroadframework; recoverycrash/longhorizon notyettested bythis3stepcase.

Fresh child1789866113164-f3144f nowverifiedcompleted/succeeded3steps; fixture harness-multistep-1789866053091 disabledAPI200. Noactivechildremains. Successonoriginalsampledoesnotreversefreshauthoringfailureabove.


## Prompt-only workflow authoring retry failed again — change approach

Installed7f25be9edf2569aa07fe7c42c9bc571a72dfb99acccce680c5a7e38a7ebebaf4.
workflow_create rootdescription shortened/reordered: reusablegoals/currentinputs,
nooutputfolderproject, exactcall/puretransformbeforemodel, retainedconsent/dependency/
outputcontract/graphsemantics. Schemaunchanged. Build98907exit0, idlehotpatchwith
rollback/bothassets/readinessverified. Receipts workflow-authoring-surface-{build,
hotpatch,assets}. NOT a demonstratedbehaviorfix.

UNCHANGEDrequestfreshsession sess-desktop-090f522c5dcf6110d3800a8f,
run desktop:090f522c5dcf6110d3800a8fb98e35b8617bf81a,
fixture harness-multistep-1789866361222. Firstworkflow_create244416 again
outputfolderproject, sample3/19savedgoal,3modelsteps(no call/transform).
Child1789866421104-1514a0 ran3steps; latestauthoritativestatusin
multistep-surface-child.json. FixtureDISABLEDAPI200 whilefinalizing; disabling
preventsnewrunsanddoesnotcancelcurrentrun. Receipts multistep-surface-{start,response,
events,child,disabled}.json. Checkterminalbeforeanyrestart; noresubmit.

STOP adding/retrying near-identical prompt instructions. Needstructuralrootcause
investigation: native schema/executorchoice/authoringvalidation and actualprovider
surface. getCoreTools liveinstalledschemas DO contain previousguidance; host
serializedTools uses tool.description pluscompactAdvertisedJsonSchema. Noevidence
ofstaleschema. Researchactualproviderprojectionorhost-nativeboundarybeforeclaiming.
Memoryautomaticprimers for priorworkflowsteps included unrelatedSalesforcefacts
3690/2471 andentity4238; relevanceproblemconfirmed, notcausalproofauthoringerror.
No personalmemorychanged. Bothpriorfixturesdisabled. Repairedfirstworkflowworks
acrossinputs; freshauthoringstillfails. Noefficiencywin/longhorizonqualification.


### Native direct workflow authoring and final delivery — live PASS
Installed1c60f594...: session sess-desktop-eb1db2681fad43831ee3c227/source245666;
creationtest1789871094745-5970ba plus explicitrun1789871105288-74b384. Correct typed
args authored firstcall; native read returned actualfilecontent without modelworker.
Goal nonfailedopen pass and final245727 done/verified/artifactsMatch. Automatic enable
successor receipt exactsource/call-bound. Independent cleanup disable invalidates that
successor afterward. Framework receipt checks remain strict. See current-framework-state
and workflow-activation receipts. Narrow textread/lifecycle proof only, no efficiency win.
