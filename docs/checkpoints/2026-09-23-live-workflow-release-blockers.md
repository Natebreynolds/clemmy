# Real workflow acceptance: release blocked

Owner redirected work from continued optimization to the Friday dashboard failure
and an actual Platform 49 run. Stop optional latency tuning. Installed clean
327a7a14a/fingerprint9222e05a4fe93d17a4d12656eb4ad29d6d2646632db7d4afa80e0fc41a744c05.
Main/UI remains e77215d0. No further runtime change or hotpatch in this incident.
The pending-question inventory optimization has NOT shipped: its regression patch
is saved at /tmp/clem-question-scan-unshipped.patch and the worktree test restored.

## Friday dashboard: exact failure established, auth not repaired

friday-dashboard-daily-refresh occurrence trigger-45b20a4bf64699eae1ce593262885700,
Sept23 14:00:17–14:00:26UTC: six Salesforce CLI reads failed NamedOrgNotFoundError.
No dashboard update completed. Sept22 and21 succeeded; Sept20 has the same error.
Do not claim the latest patch caused this, or claim historical release attribution
without unchanged-HEAD/last-tag reproductions.

Independent /usr/local/bin/sf org display reproduces it outside Clem. sf org list
auth returns no usable orgs and identifies both existing auth files as invalid:
security SecKeychainItemCreateFromContent: user name or passphrase incorrect.
security show-keychain-info on the default login.keychain-db independently fails
with the same error. Daemon HOME is the real user home; no SF_STATE_FOLDER or
SFDX_STATE_FOLDER override. Auth files exist. Credentials were not reset, copied,
printed, migrated or reauthorized. Asked owner whether Mac is currently unlocked;
answer pending. No inference that a Salesforce re-login alone fixes the Keychain.
Evidence /tmp/clem-friday-failure/{workflow,runs,friday-run}.json.

## Platform49: terminal success contradicted by execution

Owner requested real-workflow validation. Asked Clem to run existing
platform-49-slack-channel-review once with existing rules, no definition change.
Parent source289927/session sess-desktop-10bc0c0a5968a1f69f04bc7b.
Child1790172298675-ced878, session workflow:1790172298675-ced878:main.
Started14:05:03.820, terminal succeeded14:07:12.494UTC; parent290187 done.
Slack reads, thread/user lookups, Sheets reads/writes and space_refresh executed.
No Slack post/reply/reaction/DM call observed. This is NOT an acceptance pass.

Defect 1: first Sheets read retained BOTH Log and Daily Digest headers. Digest
original row1 was [Date (PT), Items Logged, Requests, Feedback, Open / Unanswered,
Sections Touched, Headline Insight, Run At (PT)]. Call290066 wrote today's digest
values over A1:H1. Call290082 then wrote literal A,B,C,D,E,F,G,H over those headers.
Call290103 wrote a digest at A100:H100. All three writes returned success.
The saved workflow explicitly requires preserving team headers/non-owned cells.
No personal workflow definition was edited as a workaround.

Operator mitigation: exact pre-run header bytes recovered with installed
getToolOutput for call toolu_01F8Xg6cTV7L6wbwUoHQGjPf. Fresh Composio read confirmed
A-H still present; restored ONLY A1:H1 using exact original eight strings and RAW.
Write log_xqS4FSInY5pN, then fresh readback matched all eight. This is operator
repair, NOT Clem recovery/acceptance. /tmp/clem-friday-failure/{current-headers,
repair-headers-args,repair-headers-receipt,repaired-headers-readback}.json.
No other rows/formatting changed by operator. Asked owner whether to pause its
8/12/16PT schedule pending framework fix; answer pending, enabled not changed.

Defect 2: space_refresh290128 says sheet_log ok1row, slack_feed ok15rows.
Parent final says no new rows, assumes Workspace and Digest unchanged, admits it
has not confirmed, yet declares success/no failures. This contradicts receipts.
Child output schema is only {url,leads}; actual result {url,leads:[]} is too weak
to support claims about performed updates. Runtime/parent needs bounded actual
execution evidence, not solely child prose or a URL-shaped output check.

Context lead, not yet proven cause: tool_output_query289997 renders two nested
range records with large first values array. Its result is20000chars, event clips
at~8k; the visible preview never reaches the second header. Original retained
read is complete. Investigate shape-aware bounded presentation and whether the
model actually retrieved required destination headers before mutating. Do NOT
silently authorize a write based on clipped previews, infer restored headers,
or add provider/tool-name special rules to the kernel.

Full incident events, excluding memory fragments:
output/harness-acceptance/2026-09-23-platform49-incident/events.json.

## Next implementation / release evidence

1. Preserve exact user constraints across workflow execution and verify writes
   against retained destination evidence, including header/non-owned-cell
   preservation. Pin the failure at framework boundary; no prompt-only patch.
2. Parent workflow completion/readback must contain settled effect evidence and
   surface contradicted/uncertain outcomes. A terminal succeeded row alone cannot
   justify claims that no writes happened or an unverified Workspace was unchanged.
3. Verify in named controlled fixtures, then agreed real workflow under live home.
   Do not repeat Platform49 unchanged as another test. Keep operator recovery
   separate from autonomous success. Never claim tag readiness from arithmetic.
4. Salesforce requires restored Keychain access before another live read can
   validate that integration. Continue framework work while owner supplies state.

## Unshipped candidate: pinned goal review coverage

Confirmed the actual saved goal has only two criteria: main output contains
url/leads and url is HTTP(S). Both passed. A declared goal skips the full target
review, while pinned-goal evidence previously excluded write receipts. Thus those
two schema checks were treated as completion of the broader objective.

Candidate in workflow-goal-review.ts plus workflow-runner.ts adds the complete
objective to the existing batched goal review and exposes saved workflow rules
and the existing authenticated target evidence (reads AND writes) through lazy
refs. Tool/outcome counts are bounded in the prompt; retained content remains
available. Human review decisions remain inline. Persisted validation criteria
now match the actual evaluated criteria. No personal workflow definition changes.

Red pin: existing validation returned pass=true despite output containing only a
URL/empty list and an unmet preservation objective. /tmp/clem-workflow-goal-review-red.log.
Candidate's initial 21 goal tests and 10 adjacent evidence tests passed; typecheck
passed. Final added outage regression and goal suite recorded separately in
/tmp/clem-workflow-goal-final.log. No generative provider calls in these tests.
The isolated runner did NOT perform its live-home sentinel while daemon13973 was
running; unit tests explicitly create their own temporary home where needed.
These are regression checks, NOT installed-app acceptance.

Still owed: generic pre-dispatch constraint preservation, parent effect reporting,
proper terminal treatment of unmet whole-objective review (existing judge-only
misses can remain advisories), final checks/build/commit/hotpatch and controlled
live acceptance. The candidate is NOT installed and does not prevent the original
bad write yet. Do not rerun Platform49 as if this were fixed. Optional latency
work remains deferred; no tag readiness claim.

## Unshipped candidate: parent receives child settlement facts

The authored workflow write-authority path reopens the frozen definition and
checks exact operation/schema/account/risk/occurrence. It does NOT check the
proposed argument values against preservation instructions. This remains the
pre-dispatch defect; no new semantic gate or provider-specific rule was added.

Implemented workflow-settlement-evidence.ts: read canonical joined logical-call
settlements for the exact run session namespace, grouped by tool/execution kind/
outcome/mutation flag, with a digest of every matching identity and argument/
result-handle reference. Groups are bounded at40; omitted groups and unreadable
or namespace-incomplete evidence never assert zero writes or unchanged state.
No payloads or model calls are added. Shared partition/legacy sessions are
explicitly outside this namespace; this is positive effect evidence, not a
proof of all-workflow coverage.

The authenticated all-member report-back snapshot now includes these facts,
so the completion review's evidence digest changes if the child ledger changes.
The original parent's continuation receives the same bounded facts immediately;
it need not discover the writes by making another tool call. Historical report
and settlement bytes are not rewritten.

Read-only evaluation against the actual Platform49 incident found22 settled
calls: three succeeded provider Sheets writes and one succeeded local Space
refresh. This corroborates the incident, not live acceptance of the candidate.
Ledger digest97aee795accc805dd266080c242a14ce4ad9f590e450951af62dbfe52240b7d8.

Regression: all9 parent-review variants failed the new joined-evidence assertion
on the old path, then passed after wiring (10 tests counting parent container).
Two initial direct test invocations failed before assertions because they lacked
the isolated runner's authority seal setup; those are NOT the red pin.
Authoritative red/green: /tmp/clem-parent-settlements-{red,green}-isolated.log.
Final resumed-parent check: /tmp/clem-parent-settlements-final.log (10pass).
Report-back + settlement query checks: /tmp/clem-parent-settlements-adjacent.log
(38pass). Final typecheck log /tmp/clem-parent-settlements-final-typecheck.log.
The active daemon prevented the runner's live-home sentinel proof; WAL/SHM and
contract state changed while it ran. Do not claim that sentinel passed.

Still uncommitted/unbuilt/uninstalled. Required next: pre-dispatch preservation
and whole-objective terminal semantics, then full targeted checks and a clean
built hotpatch with controlled live acceptance. Platform49 must not be treated
as fixed by improved evidence visibility alone.

## Unshipped candidate: whole-objective terminal meaning

Two additional red pins reproduced: whole-objective rejection became a judge-only
advisory, and an objective mentioning a local filename passed via existence alone.
Goal validation now accepts a host-typed objective criterion, always routes that
criterion through semantic review, and preserves its scope on the verdict.
The advisory reducer cannot downgrade a failed objective to successful work.
A completed write still takes the existing unsafe-to-repursue escalation path;
the regression proves no blind rerun decision. Ordinary criterion-only advisory
behavior remains unchanged.

Compatibility correction: the earlier candidate's changed successCriteria list
would invalidate exact approved pilot receipts. workflowGoalValidationReceipt now
preserves the original approved criteria and their perCriterion rows, records
objectiveReview separately, and includes it in overall pass. This supersedes the
prior checkpoint statement that persisted successCriteria contains every evaluated
criterion. Failure text asks to inspect/reconcile existing results, not blindly
rerun an external write.

25 goal/review checks and21 workflow-goal/recurrence checks passed; final typecheck
passed. Logs /tmp/clem-whole-objective-{terminal-red,final}.log,
/tmp/clem-objective-goal-recurrence.log, /tmp/clem-objective-final-typecheck.log.
Still unshipped; pre-dispatch preservation remains open.

## Desktop notification click: installed shell base-path defect

Owner reported Facebook Trends toast clicked but opened nowhere. Exact notice
1790174047802-tool-notify, Scorpion Facebook Trends — Morning Report,
created14:34:07.802UTC, runtrigger-0e87a8054f946564663ac6aca0a77244. Durable row
is read=true and delivered to derived-desktop; no business workflow was rerun.

console-routes desktop-pending emits router-relative
/inbox?tab=notifications&select=<notification-id>. Installed app.asar dist/main.js
contains focusDesktopNotificationRoute: it history.pushState's that href directly.
Installed daemon/apps/console-web/dist/assets/index-BFe9bm3t.js confirms
BrowserRouter basename:"/console". Thus the OS click navigates outside the app's
router mount while marking the notice read. Both inspected artifacts are from the
installed app, not just source assumptions. Shell reports3.18.19.

Fix belongs in apps/desktop: translate validated router-relative Inbox href into
/console/inbox?... at the browser-navigation boundary, with a routing regression
that also preserves the exact selection and rejects foreign URLs. Backend router-
relative links remain valid for React navigation; do not globally rewrite them.
A daemon-only hotpatch cannot replace packaged desktop main.js. Need rebuilt
shell/live native-click acceptance, not merely compiled web assets.

UI ownership rule requires asking before crossing apps/desktop. Asked owner via
async question; no approval received yet. No desktop/UI files changed. The other
agent's main remains e77215d00. Continue independent framework work while pending.

## Unshipped candidate: exact write arguments and bounded review evidence

Workflow target evidence now reopens the sealed physical request paired with each
redeemed result, with the existing authenticated physical-request fallback. The
review can inspect actual destination and values rather than infer scope from an
acknowledgement. Missing sealed arguments make evidence unavailable; transcript
arguments never substitute. Large argument payloads use the existing on-demand
evidence lookup instead of being copied into every review prompt.

The original write-scope pin failed without this change. Combined target-evidence
and host-completion checks passed52, skipped1, failed0; typecheck passed. Additional
scope-integrity tests passed2: large arguments survive SQLite reopen and are
retrievable by exact reference, forged transcript scope is excluded, and removing
the sealed request in the isolated fixture produces explicit unavailable evidence.
Logs: /tmp/clem-workflow-write-args-{red,green}.log,
/tmp/clem-write-args-typecheck.log, /tmp/clem-write-scope-integrity.log.
The live-daemon sentinel was NOT performed; these are isolated regression checks,
not installed-app acceptance. No personal data was modified by these checks.

A read-only Jev replay of the three recorded Platform49 write proposals used the
saved step instructions and original header evidence. Actual jev-1.13.0 reviewed
all three in398ms,4357 input/140 output tokens. The two header-overwriting calls
were classified conflict (probability0.92/confidence0.88); the third was compatible
with confidence0.28, insufficient to authorize a live write. This is a diagnostic
replay, not a benchmark, guard implementation, or workflow acceptance. Receipt:
/tmp/clem-friday-failure/write-review-replay-result.json. No proposals executed.

Pre-dispatch review remains open. It must use exact reopened step constraints,
canonical proposed arguments and authenticated destination evidence. A refusal
must take the existing repair-arguments path, not return null and fall through
to another consent reducer. An uncertain semantic result needs reconciliation;
it cannot be promoted into authorization. Do not ship a provider-specific header
rule or claim post-execution review prevents damage.

Installed build-info was rechecked: clean327a7a14a, daemon13973, fingerprint
9222e05a4fe93d17a4d12656eb4ad29d6d2646632db7d4afa80e0fc41a744c05.
Main remains e77215d00; this candidate remains uncommitted, unbuilt and uninstalled.
Desktop ownership question remains pending; no UI files changed.

## Pre-dispatch constraint reviewer component — not wired yet

Added workflow-mutation-review.ts with a separate proposed-write contract: exact
saved instructions, tool schema, canonical arguments and authenticated prior
observations. It does not reuse completion semantics or require an intermediate
write to finish the whole workflow. Canonical proposal content is snapshotted and
hashed; fallback verdicts must match that digest. Large proposals and retained
observations remain accessible through evidence tools, not prefix truncation.

A fully supplied high-confidence compatible Jev verdict avoids a second review.
Conflict, low confidence, missing key, incomplete or retained observations use the
configured reviewer for a specific repair reason. An unavailable reviewer returns
uncertain, never compatible. A compatible result is explicitly not consent.
Review spend has a separate mutation_constraints metric lane. The initial seven
recording-model tests and typecheck passed; the final seven tests after schema/
metric-lane/snapshot refinements also passed. Final typecheck still required.
Logs /tmp/clem-mutation-review-tests.log, /tmp/clem-mutation-review-typecheck.log,
/tmp/clem-mutation-review-tests-final.log. No provider calls in these tests.

This component is NOT connected to dispatch and does not yet prevent a live write.
Next: bind it to the reopened authored-step authority and exact current callable
schema, feed authenticated run evidence, and pin refusal through the existing
repair_arguments path without consent fallback or write-slot consumption. Cover
local/catalog/send paths and outage recovery before installed controlled testing.
Do not hotpatch this as a completed preservation fix.

## Authored-write constraint review connected — unshipped

Supersedes the prior 'not wired yet' status. Both authored catalog writes/sends
and native local writes now review exact canonical arguments and current schema
against the reopened immutable step prompt and authenticated run evidence before
returning dispatch consent. Settled replay does not review or execute again.
After asynchronous review, active authored authority and arguments are rechecked.
Conflict returns a non-null repair; unavailable/uncertain review returns a non-null
hold. Neither can fall through to another consent reducer. Authored sends reserve
their one occurrence only after the review passes, leaving corrections possible.

The host preserves a constraint refusal even through nested work_call preparation
and projects repair results onto the existing repair_arguments edge. No approval
card is introduced. This is additional constraint validation of an already covered
write, never replacement consent or model-granted authority.

Red pin: old host never called constraint review and accepted the first incorrect
send proposal. /tmp/clem-write-constraint-host-red.log. Intermediate candidate
failures caught use of a raw argument hash instead of the existing logical-contract
digest; fixed by using durableLogicalCallContract. One test also incorrectly
expected uppercase rather than the canonical lowercase tool identity; corrected
without changing runtime identity. Disposition's outer retry remains replan; the
typed nextEdge is repair_arguments, as required by the existing protocol.

Final recording-model checks:30 passed,0 failed across authored external write,
native local write, send host acceptance, and reviewer component suites. The
conflicting send and native goal update dispatch zero bodies for the bad proposal
and exactly one for its corrected successor; no approval cards. Uncertain review
and thrown reviewer both dispatch zero sends. Existing once-per-send and settled
replay fixtures still pass. Logs /tmp/clem-authored-constraint-final.log and
/tmp/clem-write-constraint-host-final.log. Earlier failed candidate logs are not
acceptance. Final typecheck passed: /tmp/clem-authored-constraint-final-typecheck.log.

No paid models or business provider calls in these regression tests. Live-home
sentinel remains NOT PERFORMED because daemon13973 is active. Installed bytes
remain327a7a14a. Changes remain uncommitted/unbuilt/uninstalled. Still owed:
review freshness/coverage and nested-carrier regression, measured real reviewer
behavior (including uncertainty recovery), clean candidate build, installed
controlled write-preservation acceptance and original release gates. Do not claim
Platform49 safe or fixed from recording-model tests alone.

## Candidate qualification before build

The stopped-during-review host pin passed: a positive reviewer result cannot
revive the cancelled authored run and no provider body executes. The real nested
work_call carrier pin also passed: the conflict review is invoked, its refusal
survives preparation, and no provider body executes. Logs:
/tmp/clem-constraint-authority-freshness.log, /tmp/clem-constraint-nested.log.

Combined scoped regression run:169 tests,168passed,1skipped,0failed;
/tmp/clem-workflow-candidate-combined.log. Typecheck passed;
/tmp/clem-workflow-candidate-typecheck.log. This is not the full suite or live
acceptance. Main rechecked unchanged at e77215d00 with the owner's existing edits
preserved. No UI files modified. The packaged notification navigation defect
still requires the pending ownership handoff and shell rebuild.

Next candidate step is commit and build on harness/3.19, then controlled installed
acceptance after checking live activity. Do not rerun Platform49 to discover
whether preservation works; use a named controlled fixture first. Measure actual
Jev/reviewer fallback, write calls and tokens and verify preserved destination
content independently. Original release gates, physical mobile and full suite
remain owed; no tag or push authorized here.

Exact named-workflow parent continuation regression also passed10 checks on this
candidate: /tmp/clem-workflow-candidate-parent.log. Child settled-write facts reach
the resumed parent's review without another discovery turn.

## Installed52ca6d67a acceptance — partial function, not clean acceptance

Committed52ca6d67ae347ed6b08e9d085173db2f101627b3 and built clean. Installed via
Terminal .command recipe after proving no open physical dispatch and no active
chat. Command-center runningWorkflows=3 was misleading: all were awaiting input
or parked, not executing. Old daemon13973 exited. New daemon18172 reports exact
fingerprinta736c95edab62d4702d43414fc6cf977d64ca392fe7f740e17ccd24210dd52d8.
Prior dist retained at dist.backup-Fh3cJN. Shell notification fix is NOT included.

Controlled accepted source290510/session sess-desktop-b08eeea1aea5646d7adf98d2
created manual harness-preservation-0923-52ca6d67a and ran child1790176371660-1b5dd0
once, then disabled it. Child source290582/session
workflow:1790176371660-1b5dd0:update_alpha. Independent exact-byte check passed:
Name,Value newline Alpha,2 newline Beta,9 newline. Original header and neighbor
were preserved. Native write_file executed once with readback. No business
workflow or external send was invoked by this acceptance request.

The live mutation reviewer DID run: Jev1.13.0 took1729ms/2666input/44output, followed
by Grok4.3 fallback3979ms/2658input/74output on judge:mutation_constraints. This is
~5.7s added review latency for this proposal, not a demonstrated efficiency win.
Usage records use source, not sessionId; channel identifies the review lane.

NOT ACCEPTED: child terminalOutcome blocked/needsAttention. Legacy contract
inference promoted words file/row/write into invented required output keys path
and items, although no output schema was authored. The file was correct and the
model returned file plus verification. Source is appendContractCriteria in
workflow-objective-judge.ts using inferOutputContractFromPrompt; the same guessed
list shape also adds an inferredOutputContractAdvisory in workflow-runner.ts.
Fix class: actual authored output schemas remain binding; guessed output-key
conventions must not become acceptance requirements. Semantic review must still
check actual intent, constraints and receipts. Do not patch the fixture definition
or remove real completion validation to disguise this failure.

Latency debt: initial worker hallucinated write_file {path,data}, refused as
coverage_missing290605; then tried shell and incurred another refusal290621,
workspace_roots, discovery, finally the correct native write through call_tool.
The advertised/learned schema and repair path need inspection; do not attribute
this to the new constraint checker (which ran on the later valid proposal).
Parent also used3 discovery operations. Canonical measureAcceptedTurn:
parent142603ms,11 top-level calls,416407prompt/239435cached/3548output;
child64219ms,6 top-level calls,199141prompt/110360cached/1912output.
Both exact attribution certified. Parent actualOpus5.5; workerHaiku4.5; reviewers
Grok4.3/Jev1.13.0. Child wall is nested inside parent wall; do not add walls.
No matched baseline or broad token-efficiency claim.

Evidence copied to output/harness-acceptance/2026-09-23-52ca6d67a/ including
accepted source, exact run record, definition, filtered events, canonical
measurements and independent-verification.json. Parent final290746 honestly
reported the status issue; fixture is disabled. Original release gates remain.

## Follow-up candidate: authored contracts, not guessed runtime schemas

The live preservation case failed a new regression on52ca6d67a: legacy goal
inference invented path/items plus non-empty/minimum-item requirements from words
in the step prompt. Removed that promotion in appendContractCriteria. Actual
explicit output contracts remain exact; full saved step instructions and actual
execution evidence still reach semantic target review. The new test accepts
verified preserved data and rejects a changed protected header without invented
keys. Existing explicit url/path/items contract tests remain.

Removed the duplicate inferred-output advisory producer and its unused shape-
scanning helpers from workflow-runner. Five tests of that deleted heuristic were
removed; its real executeStep regression now asserts that a reported empty result
is not automatically converted into an unauthored non-empty output requirement.
Semantic correctness is still reviewed; declared contracts, missing required keys,
empty required data and wrong shapes retain their tests and enforcement. This is
an intentional removal of guessed requirements, not weakening an authored one.
Authoring suggestions remain suggestions in workflow-deliverable-hints.

Also fixed observability for the new mutation_constraints lane: the lane was in
the type union but absent from the snapshot's enumeration, hiding its metrics.
Red pin reproduced total0 after recording one call. The lane is now visible and
Jev fast-compatible decisions record their latency as well. No usage history is
rewritten. Source/call attribution already preserved the live fallback usage.

Checks:57 objective/reviewer/metric tests passed;19 scoped runner contract and
finalization checks passed; typecheck passed. Logs:
/tmp/clem-legacy-output-keys-red.log, /tmp/clem-mutation-metrics-red.log,
/tmp/clem-legacy-criteria-metrics-green.log,
/tmp/clem-legacy-authored-contract-checks.log,
/tmp/clem-legacy-criteria-typecheck.log. Still uncommitted and uninstalled.

The first invalid write had NO write_file schema on the worker's initial model
surface (prompt_composition290594); it invented the call and data field. Framework
repair/disclosure must provide the exact current schema, not require a wasteful
shell attempt and broad search. Do not implement a write_file/data keyword alias.
This remains a separate measured latency defect, not yet fixed by this candidate.

## Follow-up candidate: structural native repair before consent

Pinned the live missing-content defect in the authored native boundary: a call
with {path,data} returned no authored decision and fell into coverage_missing.
Now a currently bound authored local call with a valid accepted occurrence opens
the current native input schema and performs existing schema validation before
argument-dependent planning/consent. Missing required fields return a non-null
repair containing the exact current schema. No field alias, tool-name rule or
provider-specific policy was introduced; semantic review is skipped for invalid
arguments. Approval-required steps retain their existing gate.

Red /tmp/clem-local-schema-repair-red.log. Adjacent native/catalog/send authority
checks26passed: /tmp/clem-local-schema-repair-green.log. A production
buildWorkflowStepAgent with a recording model reproduced the off-surface guessed
write and then repaired it through call_tool: one physical write, one semantic
review on the valid proposal, zero approval cards, no search or shell frame.
/tmp/clem-local-schema-repair-host.log. Both direct and call_tool variants passed: /tmp/clem-local-schema-repair-host-final.log (2passed).
Typecheck passed: /tmp/clem-local-schema-repair-typecheck.log. No live generative
acceptance of this follow-up yet; installed52ca6d67a remains unchanged.

Follow-up final combined checks85passed,0failed:
/tmp/clem-followup-final-tests.log. Final typecheck passed:
/tmp/clem-followup-final-typecheck.log. Scoped runner contract checks19passed were
also completed on the same runtime changes. Current main stille77215d00; installed
still52ca6d67a. Next build combines removal of invented runtime shape requirements,
mutation metric visibility, and precise native argument repair before consent.


## Installed c2f9c45a8 — live preservation acceptance, remaining defects

Hotpatched through the Terminal recipe after idle preflight and quitting the
exact installed app. Build-info confirmed clean c2f9c45a88e4f7a1f8d9e571b8f0d2e0c1559503,
fingerprint b8308e43f3a8f43366adc67fcc4c8ea2000d9d86d3bd6dd719692c712ce1b435.

One accepted request source290761, session sess-desktop-6c454351ee3bdac42ac199ad;
child1790177794627-5a42ec, source290824, step update_alpha. Canonical parent
terminal290934 done; child290889 done; workflow terminalOutcome succeeded,
needsAttention false. Independently read exact bytes Name,Value\nAlpha,2\nBeta,9\n.
Exactly one child run, fixture workflow disabled, manual trigger, allowSends false.
Evidence: output/harness-acceptance/2026-09-23-c2f9c45a8/ (accepted, build,
workflow, child-run, runs, events, measurement, independent-verification).
No business workflow or external send was exercised.

Canonical certified source attribution:
- Parent wall126588ms,7 top-level calls,0 discovery,330064 prompt,128800 cached,
  3656 output. Opus5.5 x7; Grok4.3 x6; Jev1.13.0 x4; jev-latest x1.
- Child wall38202ms,5 top-level calls,0 discovery,122739 prompt,60272 cached,
  981 output. Haiku4.5 x7; Jev1.13.0 x2; Grok4.3 x2.
Prior52 candidate: parent142603ms/11calls/3discovery/416407prompt;
child64219ms/6calls/1discovery/199141prompt. Same prompt shape, fresh fixture,
different trajectories and cache: descriptive single pair, not causal benchmark.
Child wall nests inside parent; do not add walls. Worker did not test GPT6Sol.

Remaining framework defects, do not claim clean release:
1. Authoring first refused allowSends:false (290793), misreading the negative
   instruction "do not use external tools or send messages" as a sending step.
   Retry omitted that field; saved definition still resolves allowSends:false.
   Advisory also incorrectly labels this local write as SEND and asks for output
   details already in the saved instructions. UI proof reports needs_info despite
   the independently verified successful execution. Pin at class boundary; do
   not rewrite the user's fixture instructions to work around it.
2. Native structural repair fired (290845) with current schema, but subsequent
   valid write was refused as sibling_frame_replanned_before_dispatch (290848),
   surfaced as coverage_missing (290850), then worker called workspace_roots.
   No broad search or shell call, eventual one correct write and verified readback.
   Single-call recording tests did not prove this actual frame-recovery path.
3. Desktop Facebook toast route remains unresolved in UI-owned files. Current
   focusDesktopNotificationRoute pushes /inbox while BrowserRouter uses /console;
   rebuild packaged shell and test real native click after ownership clearance.
   Daemon hotpatch cannot repair app.asar. No desktop source was modified.

This receipt is a docs-only working-tree update after the built commit. Installed
runtime remains exact c2f9c45a8. Build again after any future commit before patching.
Full-suite, physical mobile, notification-click and broader release gates remain
owed; no tag, main merge, or provider-wide acceptance claimed.


## Follow-up: typed send gate and explicit omitted native defaults

Three red tests reproduced send-gate defects: a declared local write was refused
for prohibition prose; an unrelated step's approval exempted an actual send;
and a structured send with quiet prose escaped this authoring gate. The check
now uses the shared step effect classifier and the sending step's own gate.
Exact operation effect remains stronger than stale read metadata. Legacy
unspecified-step inference remains; no new keyword or provider rule was added.
59 enforcement tests passed. This does NOT remove the separate prose coherence
advisory or fix the workflow proof card's inferred-output demands.

Corrected diagnosis of the live write retry: sibling_frame_replanned_before_dispatch
is a generic release label, not evidence of multiple sibling writes. Reproducing
the live omitted mode/append shape with a recording production host failed:
the local mode matcher recognized explicit create/null but not omitted mode.
The existing nullable materializer did not solve it (mode is optional in the
current native schema); that attempted change was removed. The registry now
explicitly declares omittedEquivalentToRequired for the actual create default.
Generic validation requires the field to be optional in the current schema,
normalization/fingerprints retain the declaration, and matching never infers
omission equivalence from null. No argument bytes or accepted digests are changed.
A future-tool matrix rejects missing required fields, undeclared defaults, null
and overwrite; production host default recovery writes exactly once without
search or shell, alongside the original direct and call_tool repair cases.
Live updating an existing file still requires the correct overwrite mode; this
fix must not silently convert the safe create default into overwrite.

Logs: /tmp/clem-typed-send-gate-red.log (3fail),
/tmp/clem-native-defaults-red.log (1fail),
/tmp/clem-send-native-declared-default-green.log (86pass).
Installed app remains c2f9c45a8; these changes still require build and live acceptance.
No paid generative provider was used for these recording-model tests. Live-home
isolation sentinel was NOT PERFORMED because the running daemon owns that home;
unit checks are not installed-app acceptance. Main and desktop/UI files untouched.

Final adjacent checks29passed (catalog/send authority and future-default matrix),
/tmp/clem-send-native-adjacent.log. Typecheck passed:
/tmp/clem-send-native-final-typecheck.log. No full-suite claim.


## Installed 3b5232604 — explicit no-sends preservation acceptance

Build completed exit0, clean3b52326045d57fbbb36893a771ad86cf1b12d77d,
fingerprint2df8af390d54b78075a272d486601c83aa024f7c8a182094ab97f4944b129ae1.
Idle preflight: active0/runningRuns0/backgroundActive0; same three blocked/parked
workflows, no started physical dispatch; no other build process. Quit exact app,
confirmed daemon50688 exited, then Terminal hotpatch recipe and exact app relaunch.
The acceptance script verified build-info SHA before submitting once.

Source290943, session sess-desktop-dc37adb6008d9981ed183c8f;
child1790178516933-8b2e15, source291001, step edit_preservation.
Parent terminal291106 done; child291047 done. Workflow succeeded, needsAttention
false. Independent read confirmed exact Name,Value\nAlpha,2\nBeta,9\n;
one run, disabled fixture, allowSends false, manual trigger/no schedule.
Creation succeeded first attempt retaining explicit no-sends and sideEffect write.
One write (291023), mode overwrite/append false, successful readback; no refused
write, no discovery. The authored saved step additionally supplied allowedTools
read_file/write_file and output final_contents/verified. Those are valid authored
contracts, not invented runtime constraints. Thus this live run does NOT exercise
the omitted-default repair/off-surface path: that remains recording-host tested.
Evidence output/harness-acceptance/2026-09-23-3b5232604/.

Canonical certified measurements:
parent111536ms,8 top-level calls,0discovery,384034prompt,158456cached,3314output;
Opus5.5 x8/Grok4.3 x7/Jev1.13.0 x6.
child38631ms,4 top-level calls,0discovery,32046prompt,0cached,552output;
Haiku4.5 x4/Jev1.13.0 x1.
Compared with c2 parent126588ms/330064prompt and child38202ms/122739prompt:
child tokens decreased greatly, wall was effectively flat, parent tokens rose.
Explicit tools/output and revised parent instruction make this non-matched
observational data, not a causal performance claim. Do not sum nested walls.
Initial measurement attempt correctly refused while parent had no terminal;
observed same accepted source until settlement, never resubmitted.

Remaining: false SEND coherence advisory still appeared on save and was reported
honestly. Legacy dashboard/workflow-proof.ts independently turns analyzeWorkflowGaps
questions into needs_info/canRun:false/canEnable:false, contradicting the canonical
workflow-certification.ts advisory policy. Needs a shared authority projection,
not a keyword negation patch or removing true missing-input/resource blocks.
Parent prompt/review overhead, notification shell click, broader journeys/mobile/
full suite and GPT6Sol comparison remain owed. No tag/main merge, no business writes.
This checkpoint update postdates the built commit; rebuild after the next commit.


## Follow-up: remove prose-only side-effect coherence warnings

Red test reproduced false SEND warning for live prohibition text and quoted
instructions. Removed the validator's independent prompt effect regex classifier
and configured-owner alias inference. Side-effect coherence warnings now compare
an authored declaration against the shared structured-call effect only. No regex
negation expansion, provider switch, new prompt or extra paid judge was added.
Generative steps still retain their authored effect and dispatch-time consent /
mutation review; legacy unspecified classification in enforce was not changed.
Old tests asserting prose-derived SEND warnings were replaced with structural
send evidence, snake-case metadata and positive/negative/quoted prose cases.
A checkWorkflowForWrite fixture intentionally has incomplete exact-call args;
its assertion now pins warning propagation rather than incorrectly claiming
that incomplete direct call should pass all independent structural validation.

156checks passed,0failed: /tmp/clem-coherence-final.log. Typecheck passed:
/tmp/clem-coherence-typecheck.log. Red /tmp/clem-coherence-red.log. Unit isolation
sentinel NOT PERFORMED because live daemon68401 was running. Not installed yet.
The dashboard proof/certification disagreement remains separate and unresolved.

Measured parent overhead, accepted source290943 (no new generative run):
first prompt_composition290960 total25352 estimated tokens; tool schemas16339,
memory2868, history1923, instructions1566, contextPacket1221, turnContext1203,
currentMessage232. Largest schemas workflow_create5272, plan_task2840,
run_worker1329, work_call1280. Eight parent compositions increased25352→29924,
not exponential growth in this short trace. Actual attributed provider input:
Opus305007 over8calls; Jev completion30432 over3; Grok completion23971 over3;
Grok watcher21496 over3; Jev trajectory2083 over3; other Grok1045 over1.
These components sum to canonical384034 prompt tokens. Watcher/review durations
can overlap other work; do not add them to derive wall latency. Tool schema size
is the next evidence-backed JIT optimization target, not indiscriminate memory
truncation. Preserve discovery reachability and the accepted plan/context when
retiring irrelevant schema exposure; no such optimization shipped in this edit.


## Installed 5707a3e89 — effect advisory acceptance

Build session16769 completed exit0; clean5707a3e89c443b19dc430966b9f5db78d301c724,
fingerprinta9f7ae281f40252ecf427432971a032eefb97c3cebdf04ea55d036fd3518212b.
Idle preflight and no started dispatches; same three blocked/parked workflows.
Quit exact app, confirmed daemon68401 exited; Terminal recipe hotpatch completed.
Start script confirmed installed SHA before submitting one accepted request.

Parent source291109/session sess-desktop-ed86bf88a3b54a145886d088;
child1790179010187-b6bb48/source291171/step update_alpha.
Parent terminal291274 done, child291218 done. Independent exact bytes verified
Name,Value\nAlpha,2\nBeta,9\n; exactly one child, terminalOutcome succeeded,
needsAttention false, fixture disabled, allowSends false, manual/no schedule.
Saved step retained prompt, allowedTools read_file/write_file, sideEffect write,
no output contract. Evidence output/harness-acceptance/2026-09-23-5707a3e89/.

False SEND advisory absent from workflow_create result291134. Other advisory
noise remains: optional remembered Google Sheets candidate despite the exact
local-only tool scope; missing-output question asks for a destination already
specified in prose and contradictorily says not to present readiness until
answered. bindStepsToToolChoices in src/tools/orchestration-tools.ts picks by
prose/effect without checking allowedTools. formatWorkflowGapQuestions in
workflow-gap-test.ts turns optional gap candidates into imperative clarification.
Next fix should respect authored scope/actual missing bindings, not add another
keyword exception or widen tools. Canonical discovery must remain available
when the authored scope permits it.

Author created disabled; initial workflow_run correctly refused without queuing
(291141), then enabled (291150) and dispatched once. Extra model turn, not duplicate
execution. This differs from preceding authoring trajectory; no causal speed claim.
Canonical certified parent109612ms/8calls/0discovery/411756prompt/183543cached/
3212output (Opus5.5 x9,Grok4.3 x6,Jev1.13.0 x6).
Child39773ms/4calls/0discovery/31038prompt/0cached/584output
(Haiku4.5 x4,Jev1.13.0 x1). Parent tokens rose despite removing one warning;
child roughly stable. Do not add nested wall times. Structural defaults path
not exercised by this explicitly surfaced overwrite, still only recording-host
validated. No new external service write; broader release gates still owed.
Checkpoint changed after build; rebuild after next commit before next patch.


## Follow-up: scoped memory suggestions and honest optional questions

Live5707 save suggested a remembered external operation for a step explicitly
limited to read_file/write_file. Red /tmp/clem-candidate-scope-red.log reproduces
that class with a remembered operation outside exact authored scope. Candidate
selection now filters by exact identifier or declared tool family before choosing
the first matching record. Exact names, prefix families and unrestricted scopes
remain supported; discovery-only carriers do not confer permission on unrelated
remembered operations. No tool scope or remembered record is changed.
Five scoped authoring tests passed: /tmp/clem-scope-candidates-green.log.

Removed the gap heuristic that inferred missing destinations/unverifiability from
an omitted output schema. Live instructions name the file and verification;
existing whole-objective review can judge that without invented output keys.
The initial short regression paraphrase did not trigger (correctly recorded pass
in /tmp/clem-gap-output-red.log); adding the live sentence about deciding what to
write reproduced the false gap: /tmp/clem-gap-output-exact-red.log (1fail).
Keep this trap: do not claim a shortened prompt reproduced the real wording.
Removed its regexes and output-presence helper; no special-case path/keyword fix.
Optional gap rendering no longer commands asking now or withholding readiness.
True missing-input, binding and explicit-output validators remain intact.
64 gap/certification/objective checks passed /tmp/clem-scope-gap-green.log,
including objective completion without guessed path/items keys.

These changes are not yet installed; installed app remains5707a3e89. Full suite
and live acceptance remain owed. No dashboard/desktop files touched; main remains
e77215d00. The legacy dashboard proof projection still independently treats any
remaining optional questions as capability blocks and needs separate ownership
coordination. This edit removes the observed false gap, not that entire mismatch.

Scope/gap follow-up typecheck completed exit0, /tmp/clem-scope-gap-typecheck.log.
The prolonged typecheck remained a live CPU-active process; observed its original
session14910 through completion rather than restarting it.


## dda40b821 installed; acceptance in progress

Clean build completed exit0 (session52634), sha dda40b821e4a41ef5bfc451bdb25cb69c9e6bfa8,
fingerprint594095535f2e184424b7c45053554e9c4f711bcae95950c9c2bb5a64fe79ea93.
Preflight active0/runningRuns0/backgroundActive0; three pending runs parked,
no started physical dispatches or other builds. Exact app quit, daemon80396 exited,
Terminal hotpatch completed, new daemon96681. Initial build-info connection was
refused during startup before fixture/receipt/request creation; waited for that
same app launch and then submitted once after exact SHA verification.

Acceptance receipt /tmp/clem-dda40b821-acceptance/accepted.json,
session sess-desktop-42a121925a7f50a47888da82,
request56842808-06e3-4c26-a253-0a66292b8aa6. Observe this accepted source/child;
do not resubmit. At this checkpoint test is in progress, not yet acceptance.
Fixture workflow harness-preservation-0923-dda40b821, fresh CSV under live
workspace/harness-acceptance-dda40b821. Standard explicit no-sends preservation
request; verify one child, exact bytes, disabled fixture, no false SEND/missing
output question or out-of-scope remembered suggestion, canonical source metrics.


## dda40b821 acceptance completed; broader-gate preflight

Parent source291277/session sess-desktop-42a121925a7f50a47888da82;
child1790179767735-6424e4/source291335/step update_alpha.
Parent terminal291437 done, child291380 done. Independent exact CSV bytes verified,
one child succeeded, fixture disabled, allowSends false. Evidence saved under
output/harness-acceptance/2026-09-23-dda40b821/. Creation291310 contains none of the
false SEND, missing-output/destination or out-of-scope remembered suggestions.
It does retain a deterministic-renderer advisory because this authored pass added
a local path output verification contract. Parent read the prior named fixture
as reference before creating the fresh one; prior fixture was not changed.

Canonical certified parent145367ms/8calls/0discovery/343907prompt/131343cached/
3069output (Opus5.5 x7,Grok4.3 x7,Jev1.13.0 x4,jev-latest x2).
Child38964ms/4calls/0discovery/33478prompt/128cached/668output
(Haiku4.5 x4,Jev1.13.0 x1,Grok4.3 x1). Parent tokens decreased versus5707,
wall increased. Different authored output contracts/routes/cache/host load:
no causal speed claim; child wall nested in parent. No GPT6Sol acceptance yet.

Broader full-suite preflight deferred for actual machine load, not a failed test:
09:12PT snapshot had Zoom39.7% CPU, system indexer75.8%, WindowServer32.8%,
other system services active. Clem daemon96681 showed77.3% while command-center
active0/runningRuns0/backgroundActive0. Do not launch full suite/journeys under
that load or interrupt the user's applications. No full-suite process started.
A 3s read-only sample completed: /tmp/clem-dda40b821-idle-cpu.sample.txt;
903.5MB physical footprint, samples include better-sqlite3 Statement::JS_all,
sqlite3_step and overflow-page reads, plus event-loop waits. This is a latency
lead, NOT proof of the owning JS query or causal wall contribution. Trace the
actual query owner before changing caching, removing checks or adding indexes.
Framework fixes and broader release gates remain active, no tag/main merge.


## Follow-up: page session identities before loading conversation payloads

Traced one concrete query reachable from command-center polling: listSessions
(with full state) selected all columns before ORDER BY updated_at DESC,id DESC
LIMIT/OFFSET. Read-only EXPLAIN on live DB showed a full sessions scan and temp
sort; no general updated_at index. The existing withoutConversationState path
already pages rowids first, but full-state callers did not. Kept API/state semantics
and generalized that narrow-page-first query to both paths, no index/migration.
Filters/params/limit/offset remain inner; deterministic order reapplied outer.

Read-only live DB transaction compared complete rows for the two SQL forms three
times at limit60: current218.70/46.85/54.50ms, page-first3.19/3.43/2.87ms;
all rows equal. /tmp/clem-session-query-baseline.json. This proves this query
cost, not total daemon CPU attribution or end-to-end app latency. Native sample
cannot resolve owning JS frames; other work remains possible. CPU later11%.

A transparent isolated SQLite view counts metadata materialization independent
of SQL spelling or wall timing. For 20 sessions/2-row page/offset3/tied timestamps,
old query materialized20 payloads; expected2. Red /tmp/clem-session-page-red.log.
This is not a fake production path: the view instruments the real listSessions
SQL and preserves row identities; normal execution still reads the real table.
Metadata predicates can legitimately inspect non-page rows; the pin covers
ordinary unfiltered listing. Installed app stilldda40b821, candidate uninstalled.

Session paging follow-up: full eventlog file80passed,0failed, exit0
(/tmp/clem-session-page-green.log), including exact page order/metadata and
dispatch/receipt contracts. Typecheck exit0 (/tmp/clem-session-page-typecheck.log).
Machine load extended duration; existing process handles observed to completion.
No full-suite or installed-app latency acceptance yet.


## Installed23a41e05e — session-page read-only live acceptance

Build session35401 completed exit0, clean23a41e05e6df4abddbc9f8b912400e5e8775a5d2,
fingerprint90620de42b4fd695e2a6a21bacfc4a12727474cd2a407f29bda4a24a6d63d9bf.
Before patch active0/runningRuns0/backgroundActive0; two pending parked workflows,
no started physical dispatch. Quit exact app; daemon96681 exited; Terminal recipe
applied and exact-path app relaunched. Build-info confirmed SHA/fingerprint,
schema81, daemon15094/start16:20:58.869UTC. Prior dist retained dist.backup-TQcyZ5.

Live GET /api/console/home/command-center samples (ms):
- before during build1398.66,1137.47,2451.79 — excluded from comparison;
- before with build completed1031.87,811.02,3406.80;
- after688.97,423.65,371.02.
All after counts and response keys match baseline (active0/waiting7/approvals1/
runningWorkflows2/backgroundActive0). This endpoint exercises full-state
listSessions(limit60). The separate read-only SQL transaction proved complete
row equality; the API check pins counts/shape, not every dynamic response value.
Three samples around a restart with variable host load are observational, not
proof of a general speedup or whole idle-CPU resolution. No generative call or
business write used. Evidence output/harness-acceptance/2026-09-23-session-page/.

Installed query correction now accepted on this bounded read surface. Full suite,
journeys, physical phone approval/restart, durable pilot, crash mutation matrix,
packaged-shell notification click, model comparison and other gates remain owed.
Machine is still running Zoom; do not run full suite under known user load.
No tag/main merge. This checkpoint update postdates build; next commit needs build.

### Pilot review fixture and approval gates — 2026-09-23 16:34 UTC

At runtime HEAD 23a41e05e, all 18 checks in approval-restart-race,
approval-resume-source, and chat-approval-resume passed (serialized isolated
runner; /tmp/clem-23a41e05e-approval-gates.log). These prove recording paths,
not the owed physical-phone approval/double-tap acceptance.

The production pilot convergence check failed at this HEAD: its recording
authoring adapter supplied no reviewer after whole-objective review became
mandatory. The deterministic output criterion passed, but the unavailable
objective review correctly left goalOutcome=advisory. Original failure retained
in /tmp/clem-23a41e05e-pilot-gate.log. Do not classify this as pre-existing.

Updated only the test to configure an isolated recording BYO reviewer and
intercept its HTTP wire. The real routing, SDK review runner, verdict parser,
goal receipt, and recurrence admission remain in use. Assertions require the
full objective, correct generated task identity, evidence lookup tools and
workflow execution reference, exactly one review request, and a persisted
objective-scoped judge verdict. Other network destinations are rejected.
No production behavior, live provider settings, or business workflow changed.
The fixture proves wiring, not reviewer intelligence or installed acceptance.

Trap: a single semantic criterion uses the DONE/INCOMPLETE completion parser,
not the numbered checklist parser. A numbered MET recording response correctly
failed parsing (/tmp/clem-pilot-review-fixture.log); correcting the fixture to
DONE passed (/tmp/clem-pilot-review-fixture-green.log).

Final serialized pilot + workflow-goal-review + goal-validate + recurrence-runtime
checks: 27/27 pass (/tmp/clem-pilot-review-adjacent.log); typecheck passes
(/tmp/clem-pilot-review-typecheck.log). The runner's live-home sentinel was NOT
PERFORMED because daemon 15094 owns and writes its WAL; no isolation-proof claim.
No paid model calls were used. Full suite/journeys remain unrun on this active
machine. The original failed test also emitted an asynchronous report-back FK
warning during cleanup; it did not recur in successful runs, but that observation
does not establish a separate production fix.

Rechecked installed build-info: 23a41e05e, fingerprint
90620de42b4fd695e2a6a21bacfc4a12727474cd2a407f29bda4a24a6d63d9bf,
daemon 15094. Active=0, runningRuns=0, backgroundActive=0; waiting=7,
approvals=1, runningWorkflows=2. No restart or new live acceptance was performed.
Desktop notification route defect remains open in UI-owned source; fix must
retain exact selected notification, honor /console mount, verify navigation
before read acknowledgement, and pass a rebuilt-shell native click test.

### Cold durable-pilot attempt exposed scope and authoring issues — September 23

Installed runtime still 23a41e05e/fingerprint90620de42b4fd695e2a6a21bacfc4a12727474cd2a407f29bda4a24a6d63d9bf,
daemon15094. Submitted exactly one cold request, source291446/session
sess-desktop-40c2639991b8f38354a4dc44, for an inert reviewed project-inventory
opportunity, metadata only, no pilot or recurrence before review. Actual brain
route was claude-opus-5-5. Saved request/acceptance/cancellation/events in
output/harness-acceptance/2026-09-23-durable-pilot/.

Event291450 incorrectly compiled zero external authority. The precise trigger
was the category description "This is a controlled framework acceptance test,
not a business integration repair", not the earlier restriction on external
writes. The access compiler attached the negative identity/category statement
to the connector noun. Candidate now distinguishes copular indefinite category
contrasts without an access predicate from negative access instructions. The
exact live request and generic contrasts are pinned, with genuine refusals as
negative controls. The initial pin failed before the fix
(/tmp/clem-pilot-scope-red.log).

A negative control also exposed an existing exception fallback losing a known
named exclusion: "Use whatever is available but not the Research MCP" returned
mode=none. Preserve the compiled deny set when an exception exists, before the
unknown-exception fallback. Ordinary blanket refusals still deny all; no provider
names or model decisions were added to the kernel.

The run separately learned Supabase is disabled. I initially inspected names and
health but omitted enabled from the inventory: configured is NOT connected or
enabled. Rechecked flags: DataForSEO enabled; Supabase and browsermcp disabled.
No integration setting was changed. Next real dataset fixture must use an enabled
provider. Scope fix alone cannot make that disabled provider available.

Before cancellation settled, automation_opportunity_propose returned
invalid_opportunity: partition.outcomeAuthority expected object, received null
(event291510). This separate authoring/schema mismatch is still owed; no valid
opportunity or pilot success is claimed. Exact cancellation was acknowledged and
conversation_completed is event291516. Do not resubmit the saved client ID as new
work or mislabel this cancellation as successful execution.

Eight explicit-plan-execute integration checks passed. Scope matrix expanded
with the exact live wording; 64 checks passed after repairing the negative-control
failure (/tmp/clem-pilot-scope-complete.log). Final source verification log:
/tmp/clem-pilot-scope-verified.log; typecheck:
/tmp/clem-pilot-scope-final-typecheck.log. Installed acceptance of this candidate,
the durable pilot lifecycle, and desktop notification routing remain open.
Final source verification completed: 64/64 scope checks pass and typecheck exit0.
Typecheck remained CPU-active for roughly two minutes under machine load; no
restart or duplicate typecheck was launched. No installed acceptance claimed.

### Native schema projection round-trip — September 23

Traced event291510 to the shared native-tool adapter: model/deferred schemas
represent optional fields as nullable; handler receives null although its original
domain schema permits omission, not null. The model's original call actually
OMITTED partition.outcomeAuthority. Transport materialization introduced it.

Candidate adds schema-aware decoding at local-tool capture, shared by first-class,
deferred, and validation-recovery handlers. Only an original optional field whose
inner schema rejects null becomes omitted. Explicit nullable values, required
invalid values, opaque payloads, and unknown keys are preserved. Nested object,
array, record and union fields use original schemas; ambiguous union interpretations
stay unchanged. Wire arguments are not mutated. No tool/provider-name exceptions,
no global null stripping, and no execution authority is granted by decoding.

Actual deferred opportunity invocation reproduced the exact null failure before
the fix (/tmp/clem-native-null-red.log). With decoding, two additional domain
errors in the recorded model proposal became visible: recurrence proposed with a
manual trigger, and a local-write phase requiring an external-effect approval.
The regression fixture isolates null projection by correcting those two authoring
errors; a separate assertion retains rejection of invalid recurrence. Do not
claim the original proposal would be accepted unchanged, or silently repair its
semantics in production. The model should receive the real validation feedback.

33 focused schema-normalizer/local-runtime/opportunity-tool checks pass
(/tmp/clem-native-null-verified.log), typecheck exit0
(/tmp/clem-native-null-typecheck.log). The fixture grants no execution authority
and ends at user_review. These recording checks use no paid providers. Final
schema-only check after defensive own-property lookup:
/tmp/clem-native-null-schema-final.log.

Confirmed scope candidate60e085062 build completed successfully. No hotpatch yet.
Live DataForSEO metadata listing reports enabled and connected, exposing four
tools: api_request, docs_index, docs_list_sections, docs_search. Next controlled
pilot can use the documentation-section inventory, without paid API data queries,
provider changes or business dataset mutation. Installed acceptance remains owed.

### Installed12e140d6f pilot attempt — failed, not accepted

Build completed. Idle preflight: active0/runningRuns0/backgroundActive0, no started
physical dispatches; waiting8/approvals0/runningWorkflows2. UI paths match main;
no competing packaging/hotpatch process. Quit exact installed app, confirmed old
PID15094 gone, ran Terminal apply-hotpatch.command once. Rollback dist.backup-pkZhoa.
Restart took about a minute under load; connection-refused observations were startup,
not a reason to relaunch/repatch. New daemon54082, instance
2b47d8db-ae87-4845-ab9d-16902ef05a35, started2026-09-23T16:51:09.479Z.
Verified build-info gitSha12e140d6f269f7856a4a0f71181f6fd58dab2554/fingerprint
5ee01d51fab88857470741322476b883ff26da0d52a43e805fef36c1c63be259/schema81.

One request source291524/session sess-desktop-bdb6ca59f648a3cd62d20d8a asked for a
reviewable documentation-section inventory opportunity using enabled DataForSEO.
No paid data query, external send, provider setting change, pilot or recurrence
authorized before review. Exact receipt files and exported events are under
output/harness-acceptance/2026-09-23-durable-pilot/ (docs-* and patched-build).

Scope fix observed live: event291528 retains dataforseo access despite the exact
"not a business integration repair" phrase, with remembered requested-server
routing. Native null decoding observed: creation reached domain validation and
returned only the two genuine authoring errors (recurrence trigger mismatch and
approval on local-only phase), not injected outcomeAuthority:null. This is bounded
acceptance of those fixes, NOT durable-pilot acceptance.

Two release-blocking failures now isolated:
1. automation_opportunity_propose/revise domain input validation returns ordinary
   isError, becoming HostLocalExecutionFailureResult. Recovery classifies it as
   execution:unknown_read and permits only retained-result readers. The model's
   attempted corrected proposal was refused pre-dispatch (291584). Existing
   shared invalidArgumentsTextResult/resultToText nominal carrier should preserve
   repairable validation truth before any proposal write, rather than broadening
   unknown-effect retry policy or recognizing tool prose by keywords.
2. Promotion of automation_opportunity_propose into first-class tools exposes an
   invalid provider schema. Terminal291589 failed with tools.4.custom.input_schema
   invalid against JSON Schema2020-12. Captured actual local runtime schema in
   /tmp/clem-opportunity-schema.json: acceptedTerminalStates tuples use draft07
   array-valued items inside anyOf. Ajv2020 validateSchema after removing draft07
   $schema rejects that exact path (items must be object/boolean). Need protocol
   dialect conversion retaining tuple positional/length semantics, plus real
   emitted-schema/provider-boundary pins. Do not delete the field or loosen tuples.

Canonical exact-source measure: wall184876ms, 3 top-level calls, 1 discovery,
115216 input tokens (68991 cached,46225 uncached),5023 output. Models:
Opus5.5×4,Jev-latest×5,Grok4.3×2. One terminal, statusfailed. The trajectory reviewer
also reported a connection error; no successful review or quota-exhaustion claim.
No comparative speed/token win is claimed from a failed turn. No proposal card,
pilot execution, bound Space or schedule was completed. All remain owed.

### Proposal repair and promoted-schema candidate — September 23

Both failures from source291524 have offline red/green pins. Original pins failed
in /tmp/clem-pilot-recovery-wire-red.log (2/2); corrected pins pass in
/tmp/clem-pilot-recovery-wire-green.log. Full focused schema-normalizer,
claude-model, local-runtime-tools, and opportunity-tools suite: 62/62 pass
(/tmp/clem-pilot-recovery-wire-suite.log). Typecheck exit0
(/tmp/clem-pilot-recovery-wire-typecheck.log). No provider calls or quota used.

Proposal create and revise now return the existing nominal
invalidArgumentsTextResult when domain input validation fails before persistence.
The local adapter preserves InvalidArgumentsPreDispatchResult so the governor
can allow argument repair. Authorization failures, durable conflicts, and actual
execution failures retain their prior semantics; no global retry policy changed.
Pins verify invalid proposals/revisions leave no durable row and that the actual
deferred tool emits the typed refusal for a recurrence mismatch.

Provider wire envelope now projects legacy tuple items[] to prefixItems and
additionalItems to items for the endpoint's 2020-12 dialect. This is protocol
serialization, not model-name policy in the kernel. Both standard and custom tool
containers are handled. Tuple ordering, minimum length, closed tails and typed
open tails are preserved; defaults/examples and property names are not treated
as schemas. Pins compare draft07/draft2020 accepted/rejected values, validate the
actual promoted native opportunity schema, and check projection idempotence.
No schema fields or authority contracts were removed to get past the API.

Installed app remains12e140d6f until this candidate is built and patched. Must
repeat the docs inventory request on the exact new fingerprint and prove repair
can produce a review card before claiming the durable pilot gate is accepted.

### Installedc90f4cd4c: proposal repaired; review staging refused

Build and Terminal hotpatch completed after idle preflight (active0/runningRuns0/
backgroundActive0, no started physical dispatches; main/UI unchanged). Prior dist
retained as dist.backup-q09131. Installed build-info:
c90f4cd4c52d9d3ad7f262feca0bc320cfeb9d9f,
fingerprint8e6b85a858ff1363ac3adc82ed8cd030fc5921b6e7b86c4e3a67b3e1b466badb,
daemon73522/instance17157dba-0695-4ef2-8024-7290e4c1f88b,
started2026-09-23T17:07:40.676Z/schema81. Exact same input as previous candidate,
new accepted source291590/session sess-desktop-05429d6d7b59bb354cf4a72c.

Live repair now works: first proposal rejected for local-only phase approval;
classified schema_invalid rather than execution:unknown_read. Clem corrected and
saved revision1 of automation_3da1c635b0a7dd98a928b7957369731f,
digest9574eff2192f943e63a3ae49e3f4d7122082f04d8ab8f716e623bf444ff8f207,
with no outcomeAuthority:null error and no provider schema rejection.

Review card staging then hit coverage_missing repeatedly. Terminal291681 is
blocked/resumable and correctly says the formal card was never presented. A
subsequent attempt-specific cancellation received409 because the turn had already
settled; no cancellation success claimed and no second cancel was sent. The saved
proposal is inert; no pilot, Space or recurrence was created. Do not author a
replacement fixture: resume this exact saved proposal after the staging fix.

Canonical accounting:128134ms,5 top-level calls,2 discovery operations,
370518 input tokens (252772cached),7122output. Models Opus5.5×9,Grok4.3×6,
Jev1.13.0×6,Jev-latest×1. Faster wall than the earlier failed turn does NOT establish
an efficiency win: the repeated refusals spent substantially more input. Evidence:
output/harness-acceptance/2026-09-23-pilot-c90/.

Class-level metadata defect: opportunity creation was runtimeEffect=host_only,
but its inert revision/review, read-pilot request, Workspace-create request, and
recurrence-request staging siblings lacked the declaration. They create local
previews/cards, not approval or external execution, but defaulted to ordinary
write authority. Candidate declares these five siblings host_only; sideEffect
remains write, mutating=true; exact revision checks, lane restrictions and formal
human decisions remain in the existing implementations. No keyword allowlist in
the kernel and no widening of real write/execute grants.

Pin failed before change (/tmp/clem-review-staging-red.log).65 tool-effect/registry/
opportunity/recurrence-tool checks pass (/tmp/clem-review-staging-green.log).
41 proposal-review/read-pilot/recurrence control-plane checks pass
(/tmp/clem-review-staging-authority.log), including idempotence and inertness without
owned approval. Typecheck exit0 (/tmp/clem-review-staging-typecheck.log). Live-home
sentinel NOT PERFORMED while daemon owned its stores; no isolation-proof claim.
Candidate still needs build/hotpatch and live exact review-card staging acceptance.

### 624d4c9f3 installed review staging — bounded success, review gap remains

Build session71330 completed exit0. Clean candidate hotpatched through the
Terminal .command recipe after active/runningRuns/backgroundActive=0 and no
started physical dispatch. Main remained e77215d00; UI source diff empty.
Installed GET build-info confirms 624d4c9f3261442f389a3cbd2222f567cb7f571d,
fingerprint e650112baa52449de45470b8835e68cb4126cc64a1df84e3c3d17a2b73d943c5,
daemon90472, schema81. Prior dist retained as dist.backup-fskUct.

Resumed saved proposal in the same session; did not reauthor it. Source291688
called automation_opportunity_review_request once through call_tool, classified
host_only. Exact proposal digest unchanged; formal approval apr-e9ap created at
291708 and independently returned by approvals/list. Review staging transitions
the proposal from proposed revision1 to reviewed revision2; this is not approval.
No pilot, recurrence or external write was requested or approved. Terminal291719
correctly reports the pending decision. No repeated discovery or coverage_missing.

Canonical measurement: 58,036ms, 1 top-level tool call, 0 discovery, 89,073 input,
43,743 cached, 45,330 uncached, 443 output; actual Opus5.5 x2, Grok4.3 x1,
Jev-latest x1. One usage call uncertified. This is a resumed review-stage case,
not a matched end-to-end efficiency improvement. Terminal completionReview is
**enabled_unavailable**; no completion-judge event was emitted. Therefore the
card mutation is verified, but reviewed completion is NOT accepted. Investigate
whether host-only control work deliberately skips review and is misprojected or
whether the review path is missing; do not infer provider outage from this field.
Evidence: output/harness-acceptance/2026-09-23-review-624/. Export excludes prompt
composition, memory-context fragments and requestEvidenceCipher.

Notification report reconfirmed against source: desktop main.ts
focusDesktopNotificationRoute pushes /inbox while BrowserRouter mounts /console;
click read acknowledgement is not coupled to successful navigation. Desktop
ownership remains with UI agent. Requires shell rebuild/native click, not daemon
hotpatch. No desktop files changed. Full release gates remain outstanding.

### Follow-up diagnosis of source291688 (no new model calls)

The absent judge is explained by existing policy: host-turn-runner's
judgeHostCompletion reads pending approvals for the session, and
shouldRunObjectiveJudge explicitly returns false when openApprovalCard=true.
The conversational skip recorder excludes this case, so no skip event exists;
delivery-committer maps missing verdict to enabled_unavailable. Thus this trace
is NOT evidence of a provider outage. Do not add a judge call just to make that
field green or call the answer reviewed. Missing typed deferral provenance is
an observability defect; pending human authority must remain intact.

Prompt-composition receipts saved as prompt-costs.json alongside prior evidence:
first estimated35,359 tokens, second35,911 (+552). First history15,916,
schemas13,123, memory3,016, instructions1,566, turnContext1,205,
contextPacket414,currentMessage119. Opportunity-propose schema3,235 and plan_task
2,840 remain first-class even though this exact continuation only stages review.
These estimates differ from provider token accounting. Two brain frames account
for88,150 input; side frames923. Do not blame a completion-judge loop or claim
exponential growth from this trace. Next optimization must preserve retrievable
history/plan evidence while selecting the relevant tool surface, not strip all
context or add a provider-specific budget.

Independent approvals/list inspection found a second acceptance gap: apr-e9ap
contentPreview.body is only "proposed"; presentation lists controlVersion,
kind, projectionId, proposalDigest, proposalId and revisions, with no objective,
capabilities, schedule or effect preview. Registration in
src/execution/automation-opportunity-review-control-plane.ts passes exact CAS
args and generic subject, with no human-readable proposal summary. Do not treat
card existence as a usable human-in-the-loop approval experience. Fix the shared
approval projection with exact proposal-bound content; keep decision args/CAS
separate from presentation, preserve replay and stale rejection, and verify both
served API and desktop/mobile rendering. No approval was supplied, no business
workflow was run, no desktop file changed in this investigation.

### Exact proposal preview candidate (not installed yet)

Added shared runtime automation-review-preview projection and wired it into
approval-summary content preview and human presentation. It loads only the
exact reviewed revision/digest, recomputes the opportunity digest, and displays
objective, rationale, capability constraints, phases/effects, recurrence, pilot,
budgets, deliverables, missing inputs and success evidence. The preview states
that approval starts neither pilot nor Space/execution/schedule. No authority
args or stored proposal/approval data are changed. Missing, stale, corrupt or
resolved proposals produce an explicit fresh-review requirement; they cannot
fall back to a misleading status-string draft. Existing cards gain the preview
without reauthoring or rewriting their CAS. The full body is retained; existing
desktop/mobile expandable-draft components can expose it without UI file edits.

Red pin: /tmp/clem-review-preview-red.log, 13 pass/1 fail, exact objective absent.
First focused green: 27/27 approval-summary and opportunity-review-control-plane
checks (/tmp/clem-review-preview-green.log). Final strengthened cases add stale
revision, wrong identity/version, shared presentation and resolved-state checks;
final rerun passed 14/14 (/tmp/clem-review-preview-final.log); typecheck passed exit0
(/tmp/clem-review-preview-typecheck.log). Live-home sentinel is
NOT PERFORMED while daemon owns stores, not an isolation proof. No paid model
calls. Candidate still requires build and installed API/rendered acceptance.

### d2aad1c41 live preview acceptance

Build session93447 exit0 (roughly five minutes under load; compiler remained
CPU-active). Clean d2aad1c41c9c187d764799b96f543bd2d8d68031 patched through
Terminal recipe after active/runningRuns/backgroundActive=0 and started physical
dispatches=0. Running API verifies fingerprint
ff589a5c2b12685fbc0e5f0e158fa8415530fafa64b8a06128a4714cccdebccf,
daemon10852, schema81. Rollback dist.backup-rTYHlZ. Main e77215d00 unchanged.

Exact pending apr-e9ap survived restart: args and requestedAt match prepatch;
contentPreview expanded from "proposed" to a 6,057-character exact proposal
preview. API evidence saved under output/harness-acceptance/2026-09-23-preview-d2/.
Native desktop inspection independently confirmed objective visible under What
you are approving, Show the whole draft expands it, and screenshot showed the
scope statement and proposal-only boundary. No approval clicked; no model calls,
no pilot or recurrence started. Desktop rendering passes this bounded content
check; physical mobile still unverified. Existing detail pane remains technical
IDs, and expanded preview uses JSON for structured limits. Do not call this
premium UI completion. UI ownership was not crossed.

Operational trap: querying native AX after quitting may relaunch the app.
First quit ended old process but AX inspection relaunched it; quit again and
waited for zero exact-path app processes before patching. Do not repeat the AX
query during shutdown. After startup, Needs you additionally surfaced Platform49
"Paused after repeated restarts". Do not infer the preview patch caused it or
resume the personal workflow. Inspect durable restart counters/recovery records
before further hotpatch cycles; repeated acceptance restarts may expose a
framework recovery/circuit-breaker interaction. No business workflow state was
manually repaired or changed.

### Restart-pause audit and next durable-pilot failure

Platform49's sole boot-cap parked occurrence is
trigger-e90fa09ed6e577f118d26db2c76e4fab, started2026-09-15T23:00:17.062Z,
parkedAt2026-09-22T10:02:00.571Z, count350, mark2026-09-15T23:01:31.221Z.
Its notification was created September15 and is read. No evidence that d2's
hotpatch newly parked it. Existing parked-skip logic already protects it;
9/9 workflow-boot-resume-cap checks pass (/tmp/clem-preview-boot-cap.log).
No personal workflow mutation or resume performed.

Automated operator acceptance then approved only exact fixture apr-e9ap through
POST harness-approvals/apr-e9ap/approve. API reports resolved approved (legacy
route status resolved-stale); independent readonly opportunity DB confirms
approved revision3, unchanged digest9574eff2...f207. This is NOT physical-human
or phone acceptance. No pilot/schedule permission was supplied.

Follow-up source291720 asked Clem to prepare the separately reviewed disabled
pilot from that approved proposal. Terminal291777 needs_input;4 top-levelcalls,
1 discovery,27,960ms,153,041 input/95,451cached/57,590uncached/1,590output.
Actual Opus5.5 x3,Grok4.3 x2,Jevlatest x1,Jev1.13.0 x1;one uncertified usagecall.
Both acquisition_list and workspace_list refused pilot_requirement_unsupported.
No pilot, Space or schedule created. Evidence: output/harness-acceptance/
2026-09-23-pilot-d2/ (secrets/prompt and memory-context fragments excluded).

Root is not stale approval or provider auth. acquisitionScope in
src/tools/automation-read-pilot-tools.ts requires phases.length==1,
capabilityRequirements.length==1 and global effectCeiling read. Approved proposal
has a root inventory read and dependent local Space write, dataset/provenance
schema, local_write global AND pilot ceiling. Its success criteria require the
bounded snapshot to be written to the new Space. selectAutomaticReadPilotTarget,
read-pilot-control-plane proposalIssue, and workflow-bridge representationIssues
also reject that shape. Removing just the first guard is not a fix. Do not ask
Clem to rewrite this into an easier read-only task and call the lifecycle passed.

Next implementation must represent the original read + local dataset output
through the existing exact Workspace projection/consent contract, retain all
success criteria and provenance, and prove selected read dispatch plus exact
local projection without executing arbitrary downstream work. Generic unrelated
writes, ambiguous read roots, missing Workspace consent, stale CAS and non-read
provider calls must remain excluded. Current model's suggested rewrite was NOT
authorized or performed. No candidate loosening these guards has been written.

### Read + exact local output candidate — checked, not installed

Reproduced the unchanged approved live proposal in
src/execution/fixtures/read-local-dataset-opportunity.json. Selector pin failed
before change (/tmp/clem-local-pilot-target-red.log);7 target checks now pass.
Selector admits a root read plus dependent local dataset-output phase only when
both reviewed overall/pilot ceilings include local output. This does not execute
that phase as a tool: the typed contract must explicitly name
workspaceOutputPhaseId and supply exact resultProjection + separately approved
workspaceBindingSelection. Missing/wrong output binding refuses compilation.
The binding enters the control digest; model authoring cannot change it. Read
carrier effects remain read. Existing single-read and finite source shapes stay
on their prior path. Tool acquisition now uses the shared selector rather than
a contradictory phases.length==1 check. Workspace tools still take the selected
read phase/requirement; the refusal explains that output binds separately.

30 control-plane/workflow-bridge checks pass (/tmp/clem-local-pilot-control.log).
The strengthened dataset path executes three exact pages, projects canonical
truth into the approved Workspace, retains provenance and rejects missing/wrong
output-phase binding before dispatch. Replay does not redispatch reads. The
production convergence fixture now carries the explicit local output through
constrained authoring, full pilot approval, exact execution and recurrence;
16 production/shape/advancement checks pass (/tmp/clem-local-pilot-production.log).
Final typecheck exit0 (/tmp/clem-local-pilot-typecheck-final.log). These are
recording/injected fixtures, not live provider or installed acceptance. No paid
calls. Sentinel remains NOT PERFORMED while daemon owns live stores.

No hotpatch yet: proactively found another representation gap in the ORIGINAL
live proposal. Its dataset.merge uses field_policy_after_exact_identity with
prefer_newer for observed_at/run_ref/source_ref. workflow-bridge supportedMerge
accepts only review_required mode/default/per-field rules. The new integration
fixtures prove local-output representation with supported merge semantics, not
that original field-merge policy. Preserve the approved live contract; implement
and pin its exact merge semantics before another paid live attempt. Do not simply
relax supportedMerge, replace the proposal, or claim this candidate alone passes
the original lifecycle. Current installed build remains d2aad1c41.


## Reviewed prefer-newer merge policies — candidate follow-up

The original approved documentation-inventory proposal remains unchanged. Its
`field_policy_after_exact_identity` merge mode with explicit `prefer_newer`
fields was still rejected by the workflow compiler after the local-output
phase fix. The candidate now represents this policy through the authored tool
schema, projection contract, compiler, canonical resolver and persisted policy.
The compiler requires exact equality between approved and projected preferred
fields. Missing or substituted field rules are rejected before dispatch.

Only a non-conflicting exact identity match enables the override. Newer field
evidence wins even at lower confidence; all source assertions remain retained.
Equal-time disagreement remains conflicting and compound-only matches retain
the prior confidence-first behavior. Optional policy data participates in the
digest when present; old policy shapes and digests are unchanged. Durable-store
reopen, integrity audit and exact replay passed.

Validation: final typecheck exited 0 (session 49261;
`/tmp/clem-prefer-newer-typecheck-final.log`); 32 engine/store tests passed in
`/tmp/clem-prefer-newer-store-final.log`; 30 pilot-control/compiler tests passed
in `/tmp/clem-prefer-newer-pilot.log`; 13 downstream Workspace finalizer, store
projection and runner-recovery tests passed in
`/tmp/clem-prefer-newer-downstream.log`. `git diff --check` passed.
The original engine regression failed before implementation. An initial raw
store-test invocation was refused by the live-home config guard; it was rerun
through the disposable-home runner, never bypassing that guard. One initial
store fixture timestamp lacked canonical milliseconds and was corrected.
The runner's independent live-home sentinel was NOT PERFORMED because the
installed daemon owns that home. No paid model calls or business writes.

Not installed: the live app remains d2aad1c41. This is not live acceptance or
release readiness. Before another paid pilot, address the additional contract
gap: required run reference and observation time fields currently only accept
provider record paths. The projection producer has verified page settlement
time and redeemed workflow lineage available, but does not expose explicit
field mappings from that host evidence. Do not fabricate provider fields, infer
a mapping from field names, or weaken the approved proposal to pass. Preserve
the full original schema and success criteria in offline and installed checks.


## Explicit host provenance field mappings — candidate follow-up

Added mutually exclusive field mappings: existing `recordPath` or explicit
`hostSource` (`workflow_run_id`, `page_settled_at`, `page_receipt_id`). Tool
authoring exposes the snake-case equivalents. No field-name inference or
provider-specific rule is involved. Each mapping remains digest-bound and
reviewed. The parser rejects dual sources, unknown sources and incompatible
types. Old record-path contracts keep their existing serialized bytes.

The producer obtains run identity only after exact workflow lineage redemption;
page time and receipt identity come from verified retained page settlements.
Host fields are excluded from provider record-shape matching, while provider
fields still require exact paths/types and the closed record shape. Output
schema attestation validates the projection before excluding host fields from
provider schema requirements. Finite partition keys continue to require source
record scalar fields; a host receipt cannot masquerade as a discovered key.

The controlled three-page pilot now projects run/time/receipt fields through
chat tool schema, approval, compilation, execution, canonical storage and
Workspace publication. Assertions compare stored references and times with
actual retained page rows and the exact queued run; replay preserves the head
and makes no extra dispatch. Existing provider fields remain checked.

Validation: 28 focused checks passed across pilot control plane, output-shape
contract, partition authority and authoring dispatcher
(`/tmp/clem-host-provenance-final.log`, session 66197 exit 0). Final typecheck
passed (`/tmp/clem-host-provenance-typecheck-complete.log`, session 10075 exit 0).
`git diff --check` passed. A direct regression against the previous committed
parser failed with `fields[1] must be closed` for the same valid host mapping
(`/tmp/clem-host-provenance-red.log`); temporary comparison module was removed.
Two intermediate typechecks found a widened partition-key type; its validated
record-only type now flows through key preparation. No model calls, business
writes, live-home resets, UI edits, install or tag performed. The independent
live-home sentinel remained NOT PERFORMED while the daemon owned that home.

Still owed: test the full original documentation-inventory proposal against
the provider's actual declared output shape and bounded-selection semantics,
build the clean candidate, hotpatch via the Terminal recipe, and qualify the
original proposal on the installed app. These controlled fixtures do not prove
that provider-specific acceptance or the broader release gates. Installed app
remains the earlier d2 candidate until reverified through build-info.


## Actual installed documentation source: text, no declared schema

Read-only inspection of installed `dataforseo-mcp-server` 3.1.1 found
`docs_list_sections` has an empty input schema, no outputSchema in server
registration, and returns `textResult(listSections())`. `listSections` is a pure
local function over bundled section names, producing 13 hyphen-prefixed lines.
No network, MCP dispatch, credential access, provider mutation or paid call was
performed. Captured the exact locally produced payload and digest under
`output/harness-acceptance/2026-09-23-doc-inventory-shape/provider-result.json`.
This is source-level output evidence, not a live workflow receipt.

On current HEAD 6baa93767, running the actual pure result projector against
those bytes returns `{kind: "no_evidence", owner: "mcp", reason:
"mcp_payload_missing"}`; receipt in `current-projection.json` beside the sample.
The raw payload SHA256 is
2af2930dc0c8fa979121c47c581bb01d0cd296dedfdb5c7f63e22bcb0b2e48d2.

The next live attempt would still fail at multiple independent boundaries:
1. Automatic authoring refuses absent declared/reviewed output schema.
2. Result facts currently accept MCP structuredContent or JSON-text payloads,
   not a text-list interpretation.
3. Canonical production requires an array of object records, equality with
   retained itemCount and all-record coverage. The approved original asks for
   up to five of thirteen sections, not exhaustive provider inventory.

Do not bypass these by inventing a provider schema, changing the original
proposal, silently slicing while claiming full-source coverage, or rerunning
the model to rediscover the same mismatch. The next implementation needs an
explicit reviewed deterministic text interpretation and bounded selection,
bound to the retained raw receipt. Keep source count, selected count and
selection scope distinct. Preserve old structured contracts and their digests.
Use generic source-format operations, never a provider/tool-name exception.
The authoring path must expose and validate this supported interpretation
without an unauthorized business sample; execution must validate actual bytes
and retain honest uncertainty on shape mismatch. Contract, count/coverage,
lineage, Workspace publication and replay need one integrated fixture using
this actual format before the paid original-pilot retry. These are framework
representation defects; the free CLI/MCP tool itself is not broken.

No hotpatch or tag performed. This new evidence changes the next action from
build-and-retry to implementing the missing generic text/selection contract.


## Explicit text interpretation primitive — not yet live-enabled

Implemented a pure closed text-lines interpretation contract and optional
result-evidence projection. Rules explicitly specify target field, literal
prefix, whitespace/blank-line handling, source byte/record bounds and first-N
selection. No arbitrary expressions, inferred provider schemas or tool-name
exceptions. The whole source is validated before publishing selected records;
a bad suffix cannot hide after the selected prefix. Original bytes are never
mutated. Source/selected/omitted counts and `reviewed_selection` scope are
explicit in the interpreted payload.

The actual locally observed 13-entry MCP inventory is a regression fixture.
With explicit rules it returns five selected records and eight omitted; with
no interpretation it keeps the prior no-evidence result. Error envelopes,
structuredContent ownership, multiple text blocks, foreign envelope fields and
malformed sealed wrappers cannot be overridden by text parsing. Plain strings
can also be interpreted without any provider-specific path.

Validation: 38 focused checks passed across the new primitive, existing result
handles and workflow invocation executor
(`/tmp/clem-text-interpretation-regressions.log`, session 78728 exit 0).
Typecheck passed (`/tmp/clem-text-interpretation-typecheck.log`, session 68758
exit 0); diff check passed. The same actual fixture failed against HEAD's prior
projector (`/tmp/clem-text-interpretation-red.log`, expected provider_payload,
actual no_evidence). Temporary comparison module removed. No paid calls.
Live-home sentinel NOT PERFORMED while daemon owns home; no isolated acceptance
claim.

This is the parsing layer only, deliberately not enabled by callers yet. Owed
before installation: digest-bound projection/tool authoring fields; honest
conditional interpretation when declared output schema is absent; invocation
evidence wiring; retained source/selection lineage and Workspace scope; original
13-to-5 pilot integration and replay tests. Do not merely skip old recordCount
equality or mark a selected dataset as full provider inventory. Structured
contracts must keep their old digests and behavior. Then build, hotpatch and
qualify the unchanged approved original proposal through the installed app.


## Reviewed text projection and native approval wiring

Added optional digest-bound `textInterpretation` to the canonical result
projection and `text_interpretation` to the native pilot authoring schema.
Existing projections omit it and retain their bytes. Parsing requires exact
selected-record bounds, a single result, the declared text field as the source
record identity, and verified page settlement time. Unknown record paths,
pagination, larger source-byte limits and changed selection limits are rejected.
The actual original four-field documentation schema is covered by a contract
test including its reviewed prefer-newer rules and host provenance fields.

The chat-tool acceptance test now creates a controlled Workspace, requests the
separate pilot review, verifies the full exact interpretation in approval args
and proves zero source bodies ran. It does not approve/run the pilot. Its
negative case exposed an uncaught internal-contract validation exception in
`automation_read_pilot_request`. Conversion now returns branded repairable
invalid arguments, with an explicit nominal-brand assertion, instead of an
unknown failure that could force another reasoning/discovery loop. The original
red test and stack are `/tmp/clem-text-contract-approval.log`.

Checks: earlier combined contract/parser/pilot/compiler suite passed 37 tests
(`/tmp/clem-text-contract-regressions.log`). Final approval/contract pins passed
18 tests (`/tmp/clem-text-contract-approval-pinned.log`); these overlap, do not
sum them. Isolated runner sentinel not performed while the live daemon owns
its home. No provider/model calls, business changes, hotpatch or tag.

Runtime enablement remains intentionally incomplete: execution evidence,
selection lineage/Workspace scope, and conditional authoring for absent
provider schemas still need integration. A reviewable parser contract is not
proof that the original live pilot can execute. Do not hotpatch this staged
series until the full source-to-selected-output path and replay are qualified.

Final typecheck exited 0 (`/tmp/clem-text-contract-typecheck-pinned.log`, session
62560); approval suite session34526 exited 0. Diff check passed.


## Original text pilot execution and retained selection coverage

Wired the reviewed interpretation into single-read invocation evidence and the
canonical lineage producer. Structured results retain their original itemCount
equality check. Text is interpreted again from verified raw settlement bytes;
its selected count is validated independently, with the original raw result
untouched. Selection receipts bind source/selected/omitted counts and scope to
the raw-result digest, exact page receipt and reviewed projection digest.

Selection receipts persist through durable lineage and finalizer recovery into
the Workspace head. Both input and stored-head validators reject malformed
counts or a selected count inconsistent with canonical coverage. Finalization
returns selection scope alongside dataset coverage. Old heads/requests omit
this optional field and keep their prior serialized shape.

The integration fixture uses the exact original approved proposal
(digest9574eff2192f943e63a3ae49e3f4d7122082f04d8ab8f716e623bf444ff8f207),
not an easier replacement, with the actual 13-entry provider text format. A
controlled injected read carrier returns the retained public fixture: this is
not a real provider dispatch. After separate Workspace and pilot approval, the
runner publishes five records with all four required fields, exact run/source
references, and source13/selected5/omitted8 scope. Stored selection SHA matches
the durable result handle, and reinterpreting its retained raw bytes yields13.
Recovery/replay keeps the same head and one physical fixture read.

Checks: 35 combined pilot/parser/finalizer/Workspace-store tests passed
(`/tmp/clem-text-execution-final.log`). Strengthened exact-receipt pilot suite
then passed17 (`/tmp/clem-text-execution-receipt-pin.log`, session67138 exit0).
Final typecheck passed (`/tmp/clem-text-execution-typecheck-final.log`,
session16193 exit0). The first integration failure counted an earlier fixture
in its global recovery count; fixed to assert the exact +1 delta and unchanged
head/dispatch count, not a hard-coded total.

A negative run temporarily removed only executor interpretation wiring. The
original contract stopped with workflow_evidence_incomplete and missing records
(`/tmp/clem-text-execution-red.log`, child exit1). The Node test error output
included malformed TAP serialization after that expected block; do not count
that output as a normal passing test. Source was restored byte-for-byte in a
finally block; no test or typecheck was running during the temporary edit.
Diff check passed. Tests remain isolated diagnostics; the sentinel was NOT
PERFORMED while the live daemon owned the home and observed memory-file changes
during one run. No live reset, paid call, business workflow, hotpatch or tag.

Still owed before installed acceptance: automatic authoring must handle absent
provider outputSchema honestly as a conditional reviewed interpretation. Its
current prompt also still assumes only declared record-item fields and needs
to expose the supported host provenance/text schema; behavior must remain
validated by code. Then build clean HEAD, hotpatch with the Terminal recipe,
and continue the unchanged real proposal through installed acceptance.
