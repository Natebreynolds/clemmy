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
