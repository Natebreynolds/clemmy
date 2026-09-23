# Workflow parent continuation — incomplete candidate

**Latest status, September 23:** production report-back now invokes the parent
driver. The focused recording-model fixture passes the real post-run disable,
one original-source terminal and durable acknowledgment after reopen. This is
not installed acceptance. Earlier “still unwired” notes below are historical;
see the final section for current proof and remaining checks.

Working branch: `harness/3.19`, based on `e77215d00`. These changes are not
committed, installed, or accepted. Do not tag or hotpatch this partial candidate.

## Defect and required outcome

Installed live source 286425 (`sess-desktop-b7acdc90575983e997bff750`) created
and ran `harness-jit-native-0923-0616`, obtaining 323, but never performed the
requested post-run disable. The joined workflow review correctly found the
original request incomplete. Report-back then published a blocked terminal
instead of resuming the parent's remaining authorized work. The named fixture
was disabled separately; that cleanup is not autonomous lifecycle acceptance.

The fix must preserve the original accepted source and attempt, consume settled
child evidence without replaying its effects, finish the remaining actions,
and publish exactly one reviewed final outcome. Restart, duplicate wake-ups,
cancellation, and later independent conversation must preserve those properties.

## Implemented prerequisites

- Before the host closes/releases a prepared workflow group, it persists an
  immutable private parent checkpoint: history, response/model identity,
  admitted capability envelope, selected binding revision, and bound MCP scope.
- Checkpoint reads require the exact accepted human source and current sealed
  group digest. Duplicate identical capture is idempotent; conflicting capture
  fails. A later mutable session snapshot cannot replace the checkpoint.
- `workflow_parent_checkpoint` is excluded from public event presentation.
- Recovery preflight in `workflow-origin-completion-review.ts` reads only a
  current negative verdict for the exact joined evidence and reply. It requires
  captured enabled review, the original active unfinished attempt and its
  checkpoint. Failed/cancelled work, unavailable or awaiting-user reviews,
  missing context and terminal winners are not continuation candidates.
- The selected binding revision is historical context, not restored authority.
  Current schema/account/tool policy must be revalidated before execution.
- `workflow-parent-continuation.ts` can claim, inspect, renew and release an
  exclusive lease on the original attempt. It does not use fresh-request lease
  recovery, which creates another attempt and supersedes session owners. Claims
  are serialized in an immediate SQLite transaction and use a unique activation
  token; stale callbacks cannot release the successor. Cancellation fences claims
  and owned-context reads. Expired ownership cannot renew itself.
- The owned-context reader validates the immutable negative-review trigger,
  child execution digest, source-group digest, objective and report bytes.
  Parent follow-up evidence need not remain frozen at its pre-recovery contents.
  The driver must carry this ownership fence into actual host execution; these
  helpers are not yet connected to report-back or a model activation.

## Verification and limits

The focused host contract test passes its six existing variants. The added
`remaining-local-work` variant fails at the intended assertion: the report-back
still publishes a terminal. Assertions preceding that failure verify checkpoint
capture, duplicate/conflict behavior, selected tool surface, private projection,
SQLite reopen after replacement of mutable conversation history, exact-evidence
recovery preflight and negative controls. Logs:
`/tmp/clem-parent-preflight.log`. This is not a passing lifecycle test.

Final typecheck passed, including continuation ownership
(`/tmp/clem-parent-trigger-types.log`). The focused run
`/tmp/clem-parent-trigger.log` again passes six existing cases and fails only
the new incomplete-parent assertion (plus its enclosing test). Before that
failure it verifies competing claims, reopen, lease expiry, renewal, obsolete
owner release, changed-child rejection, original attempt identity and pending
cancellation. This does not prove actual concurrent model/effect execution is
fenced; that remains a driver requirement. No generative calls,
live-home writes, hotpatch, tag or push were performed for this increment.

## Work still owed

Implement durable wake-up ownership and the production continuation driver;
wire both host and outer-loop dispatch branches so they do not transfer the
already-settled group again; preserve original tool restrictions and avoid
overwriting a later conversation. Report-back acknowledgment must recognize the
parent's exact continuation provenance and final result, not demand the old
child report text. Prove the actual follow-up action, one final terminal,
duplicate/restart/cancel behavior and no repeated effects. Only then build and
hotpatch the full candidate and repeat the installed-app/live-home fixture.

JIT follow-up remains separate: disclose the selected tool's real argument
schema before the first call, preserving discovery across native/MCP/CLI/
Composio. Smaller initial context is not an efficiency win when additional
model/discovery/result-recovery calls increase total latency and tokens.

## September 23 — actual follow-up host step and restart trigger

A recording-model activation using the saved checkpoint initially failed before
tool execution: the accepted-model-batch chain requires both the exact balanced
pre-history and its previous response ID. The transfer checkpoint had included
the later queue acknowledgment, which is not a committed call-bearing batch.
It now retains the history and response ID from the last committed tool frame;
the test forwards that response ID through `hostPreviousResponseId`.

The test now executes a real `workflow_get` through `productionHostRunRunner`
and verifies its `succeeded` logical settlement. This changes the parent's
evidence inventory, so a new first-time recovery preflight properly rejects the
old full-evidence review. An already-owned recovery can still validate its
immutable child/objective/report trigger while the parent makes progress.

Recovery intent is now persisted as the private
`workflow_parent_continuation_requested` event in the claim transaction. An
expired activation reopens that trigger instead of requiring the parent's
evidence to regress to its old contents or spending another review. Duplicate
claims and expiry/reopen retain exactly one request and the original attempt.
The event is excluded from public presentation.

Verification: `/tmp/clem-parent-followup-settlement.log` passes six existing
variants and all new checkpoint/real-read/recovery assertions, then fails at
the still-unfixed premature terminal in `remaining-local-work` (and its enclosing
test). `/tmp/clem-parent-progress-types.log` passed typecheck. No model provider
was called. The one-step test deliberately stops at `maxTurns: 1` after the read;
that unpublished test stop is not lifecycle acceptance or a production limit.

This exposes and fixes replay prerequisites, not the entire driver. Production
report-back still must claim and activate the parent, persist its subsequent
balanced history, bypass repeated transfer of the settled group using verified
continuation provenance, and recognize its final terminal. The requested
disable, restart without repeated effects and installed acceptance remain owed.

## September 23 — driver wired and full controlled lifecycle green

`workflow-parent-driver.ts` now claims the original attempt, renews ownership,
reopens the existing accepted-model-batch checkpoint and enters the normal
`runConversation` host path. Production builds current tool definitions and
requires the original envelope to match; it never rebinds old fingerprints onto
new tools. Parent scope/brain context comes from the immutable transfer record.
Pending recovery prevents report-back from falling through into child-only
publication. The persisted trigger lets subsequent attempts skip another review
of the old report merely because the parent's evidence grew.

Private activation context retains the original attempt, isolates its replay
snapshot from the session's current conversation, fences host model/tool steps
and terminal publication, and prevents the settled workflow group from taking
ownership again. Canonical terminal publication preserves the executor identity.
Report-back and group settlement recognize that identity only through the exact
canonical terminal plus the earlier durable parent-continuation request.
Another run or group cannot gain acknowledgment by matching prose.

A further test demonstrated that late foreground-transfer cleanup could clear
the new parent's lease. The transaction now leaves a parent-continuation owner
and its coarse marker alone. The new assertion failed before the fix in
`/tmp/clem-parent-release-race-red.log` and passes afterward.

Current focused evidence: `/tmp/clem-parent-release-race-fixed.log`, **8/8 pass**.
The remaining-work case makes a real retained workflow read, resumes through
report-back's asynchronous entry, executes the real native disable with current
local planning preparation, reviews the stored disabled state, and emits one
successful terminal for the original source. Five recording-model calls total:
initial dispatch and acknowledgment, retained read, disable, final answer. One
child dispatch; no invented user input. The real report-back reducer acknowledges
the parent terminal; reopen retains the group settlement and produces no new
model call or terminal. The test's already-acknowledged retry returns false by
design because delivery is no longer due.

Typecheck passes (`/tmp/clem-parent-release-race-types.log`). The 65 existing
group/report-back/terminal tests passed before the later executor-identity and
cleanup-race follow-ups (`/tmp/clem-parent-report-regressions.log`). All 54
session/delivery/restart tests pass against the latest changes
(`/tmp/clem-parent-core-regressions.log`).
The isolated runner's live-home sentinel is not a valid isolation proof while
the installed daemon is writing its own memory; the tests themselves use named
temporary fixture homes. No provider quota was used.

Before hotpatch: qualify production agent rebuilding (the focused test injects
its recording agent at activation), scope/schema drift handling, cancellation
at the claim boundary, interrupted effect recovery, external approval resume,
and later accepted sources. A new accepted request can supersede an old attempt;
preserving its unrelated history is not proof of concurrent background ownership.
Then run appropriate wider checks, build exact bytes, hotpatch through the
Terminal recipe and repeat the live fixture. No tag, push, commit or hotpatch
has been performed for this candidate.


## September 23 — production rebuild and empty-catalog carrier fix

The stronger remaining-work fixture now calls the production agent factory at
both initial dispatch and recovery, substituting only its recording model.
It exposed missing rebuild inputs (allow/exclude lists and JIT configuration),
missing fresh source-bound planning authority, and a carrier visibility deadlock:
`work_call` was hidden when a valid planning context had zero catalog entries.
The first exact call could therefore never reach native definition preparation.
Both orchestrator construction paths now test planning-context validity rather
than a nonempty catalog. Tool-edge definition, consent and dispatch checks remain.
Recovery reconstructs live planning authority; it does not serialize or forge it.
The saved envelope still must match the newly constructed current definitions.

The fixture originally tried direct invocation of a deferred native tool; it now
uses the actual `work_call` contract with the current local capability reference.
This is an exact-known-call test, not a cold-discovery or provider reasoning test.
The rebuilt configured carrier's opaque mode is asserted, and the actual stored
workflow must be disabled before the completion judge accepts it.

Evidence: `/tmp/clem-parent-rebuild-carrier.log` fails before the visibility fix;
`/tmp/clem-parent-empty-catalog-fixed.log` passes all 8 focused cases afterward.
Five recording-model calls, one child dispatch, original source/attempt, one
terminal, durable report-back acknowledgement, and unchanged unrelated session
snapshot remain asserted. Typecheck passes in
`/tmp/clem-parent-empty-catalog-types.log`. All 76 neighbor regression tests pass in
`/tmp/clem-parent-rebuild-neighbors.log` (local-call preparation, model-frame
policy, workflow-origin terminal/group, and report-back).

Traps: a matching envelope alone does not prove an enabled callable carrier;
an empty fresh catalog is not evidence that no tools are available; a recording
model must invoke the production-exposed contract. The isolated runner sentinel
remains NOT PERFORMED with the live daemon active. Installed-app acceptance and
the other pre-hotpatch requirements above remain owed. Nothing was hotpatched,
committed, pushed or tagged during this follow-up.


## September 23 — parked parent cancellation

A new regression reproduced a pending continuation that could neither claim its
attempt (kill requested) nor publish a terminal. Report-back would keep retrying.
The origin terminal now settles cancellation transactionally when the exact
pending parent is stopped, no unexpired executor lease owns it, and accepted
model-batch recovery confirms no unsettled call frame. An active owner or an
unsettled batch remains with the existing host/reconciliation path.

`/tmp/clem-parent-cancel-red.log` fails before the fix. The enhanced test in
`/tmp/clem-parent-cancel-owner.log` passes all 8 focused cases: a live owner
prevents cancellation publication, releasing it permits one cancelled terminal,
no new model calls occur, the parent attempt finishes, real group report-back
acknowledges it, and reopen produces neither another terminal nor another delivery.
This proves cancellation of an already-requested parked continuation. Cancellation
before the first durable continuation request, during an effect, or after a newer
source supersedes the parent is still unqualified and must not be inferred from it.

The first typecheck caught an extra recovery argument and nullable run ID; those
were corrected. Final typecheck passes (`/tmp/clem-parent-cancel-types-fixed.log`); all 65
neighbor regressions pass (`/tmp/clem-parent-cancel-neighbors.log`). The isolated
runner sentinel is not performed while the installed daemon owns the live home.
No live patch, commit, tag, or provider test.


## September 23 — stop before first continuation claim

The new `cancel-before-claim` variant failed in
`/tmp/clem-parent-cancel-before-red.log`: a current negative completion verdict
existed, but no durable continuation request yet, so cancellation never settled.
The cancellation reducer now accepts that exact current reviewed candidate as
well as a previously requested continuation. Inside the same transaction, after
checking stop ownership, lease vacancy/expiry and balanced batch recovery, it
retains the negative-review/source-group lineage before publishing cancellation.
That durable lineage is context for report-back verification, not a tool grant.

All 9 focused cases pass in `/tmp/clem-parent-cancel-before-fixed.log`; typecheck
passes in `/tmp/clem-parent-cancel-before-types.log`. The new case asserts zero
continuation requests before stop, no additional model/judge calls, one finished
parent, actual report-back acknowledgement, and idempotent reopen. A final
ordering refinement checks the cheap stop/attempt state before reading recovery
evidence; focused rerun passes all 9 cases in `/tmp/clem-parent-cancel-before-final.log`.

This covers stop AFTER the negative review but BEFORE the first claim. Stop
before any review, during an effect, approval recovery, and superseding requests
remain unqualified. The candidate is still uncommitted and uninstalled. No claim
of live acceptance, latency improvement, or release readiness follows from these
recording-model fixture results.


## September 23 — newer foreground requests preserve workflow ownership

The production continuation fixture now accepts two actual newer user requests
before resuming the older parent. It failed at first admission in
`/tmp/clem-parent-new-source-red.log`: `beginRunAttempt` superseded all unfinished
attempts in a session, including the parent already handed to a workflow.
`claimRunAttemptLease` had the same blanket retirement and could also reclaim
the old run under a new attempt after its foreground lease expired.

Both admissions now retire only foreground attempts, preserving exact-source
system workflow dispatch records. A same-run lease retry joins the transferred
owner instead of reminting it. The eventlog retirement fence verifies the event's
shape, role, parent source, turn, source sequence and unique winner. This is NOT
cross-store execution authority: all group, checkpoint, schema, stop and effect
checks still occur before the parent can run. Preserving an attempt does not
permit a damaged workflow to execute or deliver.

The expanded real-agent fixture passes in `/tmp/clem-parent-new-source-fixed.log`
(9 cases). It proves both fresh and leased admission preserve the parent,
ordinary newer foreground work still supersedes ordinary older foreground work,
the parent disables the actual saved workflow once, and its final terminal does
not finish the newest request or overwrite its conversation snapshot. Three real
user sources exist; recovery must not invent a fourth.

Additional pins cover malformed, wrong-parent, wrong-turn, wrong-source,
non-system and ambiguous dispatch notices, plus same-run transferred replay.
Final filtered regressions: `/tmp/clem-parent-new-source-regressions.log`.
Final typecheck: `/tmp/clem-parent-new-source-final-types.log`. Inspect completion
before counting these final runs. No hotpatch, commit, push or tag performed.

Still owed: overlapping active model/tool executions (this test has an active
newer lease, not simultaneous provider calls), approval pause/resume without
session metadata clobbering, cancellation during effects, full recovery matrix,
and installed-app/live-home acceptance. The changed low-level retirement logic
also needs broad eventlog/restart/transport regression coverage before release.


The filtered regression run found one additional failure by name:
`one host invocation owns an exact dispatch lease and revokes it before returning`.
It also fails on committed runtime HEAD e77215d00 (`/tmp/clem-head-dispatch-lease.log`)
and clean last tag v3.18.19 / 8c11aa3c0 (`/tmp/clem-tag-dispatch-lease.log`). Its
fixture supplied neither a source identity nor a declared execution boundary for
its invented unwrapped `leased_read` tool. The fixture now records an accepted
source, passes matching ambient/projected identity, and instruments the declared
pure-local `workspace_roots` read. The original lease-current-in-body and
lease-revoked-before-return assertions remain unchanged; runtime guards were not
weakened. Final combined rerun: `/tmp/clem-parent-new-source-verified.log`.
Typecheck passed in `/tmp/clem-parent-new-source-checked-types.log` before the
final string-only fixture tool-name change.


The lease fixture needed the production host adapter as well: merely adding a
source left the legacy adapter asking for a retired turn graph. It now uses the
source-bound production runner, sealed test surface and instrumented wrapped
local read, retaining both exact-lease assertions. All 31 selected tests pass in
`/tmp/clem-parent-new-source-production.log`. This supersedes the earlier
`*-final.log` / `*-verified.log` attempts, which still failed that fixture.
Final typecheck passes (`/tmp/clem-parent-new-source-production-types.log`).
All 111 full eventlog/session/restart tests pass
(`/tmp/clem-parent-ownership-broad.log`). The installed-daemon sentinel remains
NOT PERFORMED; these fixture results do not establish live-home acceptance.


## September 23 — approval metadata and foreground marker races

Two new session regressions failed before the fix in
`/tmp/clem-approval-metadata-red.log`: saving an interrupt from a stale session
replaced newer conversation metadata, and clearing an older interrupt erased
its replacement. Save/clear now update only approval fields. Both compare the
previous serialized pause AND MCP scope in the SQL mutation; an old saver throws
on conflict and an old clearer leaves the replacement untouched. Scope cloning
and reopen semantics remain. Workflow-parent lease ownership is checked before
these mutations.

A third regression (`/tmp/clem-session-marker-red.log`) reproduced the same
whole-metadata overwrite in run-in-flight bookkeeping. Marker writes now change
only the marker; clearing compares the observed timestamp. Workflow-parent
activations use their source-specific lease and do not set or clear the shared
foreground marker. A revoked parent cannot save or clear an approval pause.

All 35 session/restart tests passed in `/tmp/clem-session-state-fixed.log` before
the final additional parent-marker pin. The expanded production continuation
fixture now checks the newer foreground marker survives and that successful
completion emits no spurious workflow_parent_retry_pending event. Those checks
and the additional marker/lease-loss pins pass in
`/tmp/clem-approval-state-integration.log`; that broader run is NOT green overall:
55 pass / 8 fail. Typecheck passes in `/tmp/clem-session-state-final-types.log`.

Eight older host fixtures fail by name (see log), all reproduced at runtime HEAD
e77215d00 in `/tmp/clem-approval-head-attribution.log` (41 pass / 8 fail):
- host stepping materializes omitted strict-nullable fields before approval and invocation
- literal string controls are decoded before tool approval, without bypassing the SDK schema
- independent nonapproval calls execute concurrently while result history stays in call order
- malformed tool arguments become a correlated result without approval or execution
- user-edited approval arguments traverse the same parse gate on resume
- approval pauses BEFORE execution; resume executes the approved tool exactly once
- needsApproval exceptions fail closed as an explicit approval pause
- mixed approval batches preserve and settle every sibling exactly once across resume
All eight also reproduce at clean v3.18.19 / 8c11aa3c0 in
`/tmp/clem-approval-tag-attribution.log` (41 pass / 8 fail). These fixtures still need repair against
the real authority contract, never a relaxation of production execution checks.

This is metadata race protection, NOT completion of simultaneous source-scoped
approval routing. The shared pause slot still needs ownership/routing work for
multiple pending sources, plus the live restart/mobile double-tap canary. No
hotpatch, commit, tag, push, or live-provider test occurred in this follow-up.


## September 23 — migrate four obsolete host fixtures

Four of the eight attributed failures now use the production host with a real
accepted source, wrapped configured tools and sealed surface. Assertions remain:
nullable fields materialize before approval/body; raw string controls decode
without accepting wrong types/extra keys; independent reads overlap but history
stays ordered; malformed write arguments reach neither approval nor body.
`runProductionHost` now accepts optional execution settings while fixing the
source identity and host engine itself. The text decoder instruments a declared
local reader; malformed write uses the declared native write name but never
enters its body. No runtime guards were relaxed.

`/tmp/clem-approval-fixtures-partial.log` shows the approval selection improving
from 41/49 to 45/49. Still failing: edited approval arguments, approved write,
failed needsApproval predicate, mixed approval batch. They require a supported
write-approval fixture with actual authority, not raw invented tool names.

An attempted native write fixture was removed, not accepted: reversible disable
correctly follows host consent rather than a wrapper's injected needsApproval;
workflow_delete is excluded from this local planning observation path with reason
`destructive`. The diagnostic stopped at definition lookup, before priming/build
or model execution (`/tmp/clem-native-approval-definition.log`). Two earlier
attempts spent CPU and were explicitly stopped; the OS sample is
`/tmp/clem-native-approval-stack.txt`. This is not evidence of a Clem model loop.
Temporary stage logging was removed. The original remaining four failing tests
are retained while their real write-authority replacements are designed.

All four final selected checks pass (`/tmp/clem-four-production-fixtures-final.log`).
Final typecheck passes (`/tmp/clem-four-production-fixtures-types.log`).
No hotpatch, commit, tag, push, or provider test. Approval routing and live
restart/mobile acceptance remain open.

## September 23 — production approval fixtures completed

Migrated the remaining four obsolete approval fixtures without relaxing runtime
admission. The external-write fixture now uses an observed native MCP definition,
a durable capability store, the real call_tool carrier, accepted user source,
sealed model surface, host consent subject and approval-registry resolution.
Only the provider transport and model are recording fakes: no external message or
paid generative call is made.

Verified unchanged approved arguments dispatch once; replaying the original
approved pause does not dispatch again; malformed edited arguments produce one
correlated refused_pre_dispatch settlement with effect=none and repair_arguments;
a serialized approval without its exact durable grant cannot write; mixed read /
write siblings remain parked before approval, settle in model order once, and do
not repeat on replay. The predicate-exception pin deliberately uses a declared
local reader: it proves wrapper exceptions pause before the body, while the MCP
fixtures independently prove external-write consent. It is not represented as an
external-write policy test.

The first MCP fixture correctly refused a resume that lacked a durable approval
record; adding the real register/resolve/hostApprovalId path fixed the fixture,
not the runtime. Edited arguments use the typed repair disposition rather than
legacy free-text error wording. A mixed-batch fixture initially bound only the
carrier instead of its complete two-tool surface and was correctly refused;
the binding now includes both tools. An accidentally edited neighboring test
binding was restored before validation.

`/tmp/clem-production-approval-final.log`: 51/51 selected checks pass (approval,
nullable parsing, raw-string decoding, independent reads and malformed arguments).
`/tmp/clem-production-write-approval-variants.log`: 4/4 production MCP variants
pass. Typecheck result is recorded separately in
`/tmp/clem-production-approval-final-types.log`. These are isolated regression
pins, not installed-app acceptance. The isolation sentinel remains NOT PERFORMED
because live daemon57980 owns the live home.

Process inventory found an orphaned prior experimental test child26702 consuming
CPU (parent1, exact approval-test command). SIGTERM did not stop it; SIGKILL did.
This was a test child, not the installed daemon. No full suite was run while it
was present. No commit, hotpatch, tag, push or live-provider acceptance in this
follow-up. Exact-source approval routing, live restart/mobile double-tap and the
broader release matrix remain owed; a green selection does not close those gates.

## September 23 — approval cancellation must follow the parked source

Found and fixed an actual resume defect in loop.ts: resumePendingApproval checked
isKillBeforeStart against its caller's source/latest attempt BEFORE decoding the
host pause and restoring its original accepted source. A newer request's stop
could therefore cancel an older parked task and consume the newer stop. The
preflight now runs after exact parked-source restoration and before approval
registration/resolution or provider execution. Conflicting host pause identities
remain rejected rather than falling back to the newest task.

A production host fixture pauses an opaque external write, saves its state,
accepts another user input, binds a real run attempt and stop to the selected
source, closes/reopens SQLite, and calls the real resumePendingApproval. Two
variants prove the original task honors its own cancellation, while a newer task's
stop stays pending and the original approval card is recovered. Neither variant
makes another model call or provider write. This is source-specific cancellation
proof, not support for multiple simultaneous approval blobs in one session.

Red: `/tmp/clem-approval-source-preflight-red.log` returned killed instead of
awaiting_approval for the newer-only stop. Green:
`/tmp/clem-approval-source-preflight-final.log` passed both cancellation cases and
the existing production agent rebuild/approval/SQLite reopen journey (3/3).
Broader final `/tmp/clem-approval-source-neighbors-final.log`: 47/47 across approval
source, chat approval resume and direct-write integration files. The first broad
run had two observation-registration fixture conflicts because the new fixture
reused api_request; unique observed operation identities removed that test-state
collision, with no runtime relaxation. Typecheck log:
`/tmp/clem-approval-source-preflight-types.log`.

No installed patch or tag. Live-home acceptance remains required. Source-specific
approval storage, control routing before agent construction, workflow-parent
approval continuation and mobile double-tap/restart still need end-to-end proof.

## September 23 — select the exact consent subject before resume work

Found a second boundary gap: explicit card selection was validated after agent
construction in runConversationFromResume and after crash-window registration in
resumePendingApproval. A different source in the same session with identical
tool arguments could trigger the wrong task's planning/build or emit a new card.
The tool execution authority still prevented an unauthorized external write; this
finding is unnecessary work and incorrect card routing, not a demonstrated send.

Both host-native entry paths now check an explicit card against the pause's exact
consent resume key AND tool payload before those operations. The consent key
binds source, logical call, account, schema and risk. A mismatch returns
awaiting_approval with an explicit explanation, preserves the saved pause and
leaves the other task's registry row pending. Legacy pauses without a consent
subject retain their existing downstream validation; this change does not claim
to give legacy rows modern exact-source authority.

Red `/tmp/clem-approval-card-source-red.log`: conversation path built one agent
(expected zero); pending path registered a second card (expected only the
original other-task card). Green `/tmp/clem-approval-card-source-green.log`:
49/49 approval-source, chat-resume and direct-write integration checks pass.
Typecheck passed (`/tmp/clem-approval-card-source-types.log`). The final focused
rerun additionally asserts an explicit awaiting_approval result and explanation
rather than accepting a generic exception; receipt is
`/tmp/clem-approval-card-source-final.log`.

No model/provider calls except recording fixtures, no installed hotpatch or tag.
The session still has one approval blob: this avoids acting on the wrong blob;
it does not yet store and select multiple concurrent task pauses. Full source-
specific storage and workflow-parent approval continuation remain open.

## September 23 — per-source approval checkpoint store (integration pending)

Added source-approval-checkpoints.ts as the durable store needed to replace the
single approval slot. Each accepted source has independent serialized host pause
bytes and MCP scope. Atomic revision compare-and-swap changes only that source's
metadata entry. Clearing leaves a revision tombstone so an old activation cannot
recreate its pause with an initial/null revision after restart. Checkpoint source
and all embedded consent identities must agree with an actual nonsynthetic user
event. Corrupt indexes fail without being silently replaced. These records are
context only, never grants to execute tools.

Four storage regression checks pass (`/tmp/clem-source-approval-store-final.log`):
two pauses/scopes survive reopen; clearing one preserves its sibling; stale save /
clear and stale resurrection are refused; mismatched source identities and corrupt
indexes cannot be written through. Typecheck receipt:
`/tmp/clem-source-approval-store-final-types.log`.

IMPORTANT: production writers/readers are NOT switched to this store yet. This
is a staged dependency, not a claim that multiple concurrent approvals now work.
Remaining wiring must cover HarnessSession revision snapshots, migration of the
existing single blob, selection by exact card/source before agent construction,
source-specific connector scope, clearing only the selected revision, boot/tick
recovery over every parked source, and existing session-level paused/reaper/
historical-reconciliation projections. All of those use the old key today;
switching only the writer would strand approvals or widen connector scope.
Finish those integrations and their end-to-end pins before including this store
in an installed candidate. No hotpatch, commit, tag or provider acceptance.

## September 23 — source store wired into session and card selection

Supersedes the prior unconnected-store status: HarnessSession now recognizes
modern host pause identities and stores them per source. Saving a second source
first migrates an old single-slot host pause, including its MCP scope. The old
metadata keys remain a compatibility/presence projection of a remaining pause;
clearing one selected source uses its observed revision and reprojects its
sibling instead of erasing every pause. Legacy SDK/early unbound host blobs still
use the existing single-slot path. Stale same-source saves/clears stay fenced.

Both approval resume entry points locate a stored source by the exact selected
consent card before deserializing/restoring it. Orchestrator approval rebuilds
request that source's connector scope. Boot/tick surface recovery iterates the
stored source pauses and avoids double-processing their old-slot projection.
Session list queries that intentionally omit large model state now omit the new
checkpoint index as well. Listing checkpoint entries reads one metadata snapshot
rather than rereading the full session for every entry.

`/tmp/clem-source-session-integrated.log`: 57/57 session, checkpoint storage and
production direct-write integration checks pass. Migration pin also checks
reopen, source-specific scope, stale replacement protection, sibling preservation
and unrelated metadata preservation. An initial new test omitted the mandatory
turn argument to recordUserInput and failed before exercising storage; fixed the
fixture. `/tmp/clem-source-session-integrated-types.log`: typecheck passed.
`/tmp/clem-source-approval-recovery-neighbors.log`: 2/2 existing approval persistence /
boot-recovery cases pass. Final small store reread optimization rerun is in
`/tmp/clem-source-approval-store-final.log`.

NOT HOTPATCH-READY: exact-workflow approval readers, historical reconciliation,
reaper/source-terminal cleanup and conversation-protocol pending-call extraction
still need a completed audit and regression coverage for the new map. The legacy
projection preserves presence consumers, but does not itself prove every reader
selects the right task. Two independent real host pauses in ONE session must be
resumed through public entry points with restart and repeated decisions before
claiming concurrent approval acceptance. Native/legacy approvals without a
modern consent subject also need explicit routing qualification. No installed
app patch, tag, commit or external provider test in this follow-up.

## September 23 — two independently parked tasks use public approval resume

Added a production host/agent-builder journey for two independent sources in one
session with identical business arguments. Both pause before a provider body;
normal parked-surface recovery creates their addressable cards. After SQLite
reopen, runConversationFromResume selects and rebuilds the older task, executes
only its write, and leaves the second source's card and saved pause intact. A
second reopen and second approval execute the other write. Each successful
mutating settlement retains its original source. Repeated decisions for both
cards make neither additional provider calls nor additional model calls.

The first version tried to start a second ordinary chat via runConversation and
hit the intentional persisted-conversation pending-approval hold. That is not a
regression: fresh chat ingress branches or holds rather than running over an
unresolved pause. The final setup uses independently owned production host turns
(the state that background continuations can produce), persists through the real
HarnessSession and publishes cards through real recovery, then uses the PUBLIC
resume entry point for both decisions. It does not remove the fresh-chat hold or
claim a full workflow-parent interleaving/real-provider concurrency acceptance.
Provider transport and model remain deterministic recording fakes.

`/tmp/clem-two-source-approval.log`: targeted journey passed.
`/tmp/clem-two-source-types.log`: typecheck passed.
Final broader receipt (including replay model-count assertion):
`/tmp/clem-two-source-neighbors.log`.

Workflow exactWorkflowApprovalResume now asks HarnessSession for the step's
source-specific pause instead of its session's latest projection. Existing exact
step-attempt approval resume test passes (`/tmp/clem-source-workflow-readers.log`,
1/1); that legacy fixture does not prove multi-source workflow recovery by itself.
Source-terminal cleanup/historical reconciliation and protocol pending-call
inventory still need completion before hotpatch. No installed patch or tag.

## September 23 — cleanup and missing-projection recovery

Historical interrupt cleanup now proves terminal/call completion for EVERY active
stored source, not just the latest source in a terminal-looking session. Only
then does its metadata CAS remove legacy projection bytes and replace source
checkpoint bytes/scopes with fresh revision tombstones. A stale caller cannot
restore the retired pause. An older source with no terminal remains held even
when the newer source is proven complete. The inventory also finds active source
records when the compatibility projection is already absent; tombstones alone
do not keep reentering the cleanup scan.

Red `/tmp/clem-source-cleanup-red.log`: old cleanup left replay bytes in the new
store. Final `/tmp/clem-source-cleanup-final.log`: all 10 historical-reconciler
checks pass, including cleanup with no legacy projection, stale resurrection
refusal, and preservation of an older unproven source.

Provider-history preparation now sees active source checkpoints independently of
the old key. Red `/tmp/clem-source-protocol-red.log` returned ready with a pending
stored source after its compatibility key was removed. The corrected boundary
holds without rewriting any metadata. HarnessSession presence/scope readers
fall back to stored source context when the projection is missing; recovery's
inventory queries the source map too. The two-production-task journey deliberately
removes the projection after each pause before recovery: both cards recover and
public resumes/replays still pass (`/tmp/clem-source-recovery-no-projection.log`).

`/tmp/clem-source-cleanup-protocol-green.log`: 37/37 session, protocol and historical
cleanup checks pass. `/tmp/clem-source-cleanup-types.log`: typecheck passed.
No live patch/tag. This closes the tested missing-projection and historical
cleanup classes; it does not substitute for process-kill/mobile double-tap/live
workflow-parent approval acceptance, native/legacy card routing, or the remaining
release matrix. Isolated sentinel remains NOT PERFORMED with live daemon57980.

## September 23 — combined lifecycle check and native approval identity

Combined candidate checks passed before the native identity refinement:
`/tmp/clem-candidate-host-lifecycle.log` 60/60 (original workflow parent continuation,
approvals, exact dispatch lease); `/tmp/clem-candidate-state-lifecycle.log` 171/171
(eventlog/session/restart/direct writes/protocol/cleanup/source store). Live build
was re-read and is still SHA e77215d008623bf30bddf13448f00496483a5e2c, fingerprint
4fe1340326408159f62b287d9d15b4a106323cd8c2714bc6895a83546588d98d, daemon57980.
Shared main remains unchanged apart from the owner's documented uncommitted files.
No other build/hotpatch/test process was observed before the combined selection.

Review found selectedHostApprovalMatchesPause treated every no-consent-subject
state as a match, which made stored native/custom predicate approvals ambiguous
alongside external consent approvals. Modern host interruptions now derive a
stable host-approval:v1 key from exact accepted batch identity, logical call id,
tool name and admitted arguments when no consent subject exists. External consent
keys are unchanged. Registry publication already carries interruption resume
keys, so routing can compare the same durable key before rebuilding. Original
admitted arguments keep the key stable across user edits; edited arguments still
pass the normal resume parse/authority validation. Early host/SDK pauses without
an accepted batch stay on their historical compatibility path.

`/tmp/clem-native-approval-identity.log`: 59/59 selected host/approval/workflow
checks pass, including native key stability across serialization and distinct
keys for identical arguments in a different source. Typecheck passed
(`/tmp/clem-native-approval-identity-types.log`). Public external/two-task resume
regression receipt: `/tmp/clem-candidate-public-resume-final.log`.

Still owed before installing: native public-card routing/restart with the new
key and compatibility for already persisted modern native cards that predate
that key (do not silently treat their unscoped registry rows as grants). Full
workflow-parent approval continuation and source-specific terminal/snapshot
ownership also need final qualification. No commit/build/hotpatch/tag; the exact
installed build above is unchanged. These are regression pins, not live acceptance.

## September 23 — native public resume and backward-compatible card identity

Native cards now pass real resumePendingApproval after SQLite reopen, with one
body execution and no duplicate on a repeated click. The initial upgrade fixture
showed that indiscriminately keying pre-upgrade pauses would force an unnecessary
replacement card. That behavior was rejected before any installation.

Host interruption serialization is now V7 with an explicit nativeApprovalKeys
mode. Newly created states default to exact batch/source/call keys; V1–V6 decode
with their historical native-card mode, and reserialization preserves that mode.
Old native cards match their original unkeyed payload contract, rather than being
silently rebound to a new keyed identity. New native pauses never accept that
fallback, and external consent-subject keys remain unchanged. Exact matches must
still be unique across stored sources; ambiguous history is not guessed.

`/tmp/clem-native-upgrade-approval.log`: 61/61 selected approvals, native public
resume (new and pre-upgrade), workflow-parent lifecycle and related checks pass.
Upgrade fixture verifies one card, the same original approval ID, mode retained
across another serialization, one body, and repeat-click no-op.
`/tmp/clem-native-upgrade-types.log`: typecheck passed. `git diff --check` passed.
The old blocked/rekeyed-native experiment in the earlier note is superseded;
it was never installed. No paid model or external service was exercised.

Candidate is ready for a local source checkpoint/build and controlled installed
acceptance of the original parent-continuation failure. This is not a declaration
of tag readiness: the live acceptance matrix, full exact-commit suites/journeys,
packaging/upgrade gates, and measured latency/token comparison remain owed.

## 2026-09-23: installed parent canary exposed quality-blocked handoff

Installed candidate `45254ff2b5ff8eff1605935972f5176e6b7e9400` was confirmed through build-info, fingerprint `878eda32bbb66ed8135c999468dd5e5092e0d56642ddbd63233e7b963afa5b2c`. Source 286553 in session `sess-desktop-940f8d9a4aeffae71b799832` requested enabling the controlled manual fixture `harness-jit-native-0923-0616`, running once, verifying product 323, then disabling it. Served Opus 5.5. Child `1790154327508-39b0b1` completed and returned product 323, but parent terminal 286614 was blocked and no disable occurred. NOT acceptance.

Canonical child status was `completed`; its report-back outcome was `blocked` because the legacy target quality review was negative. Parent completion Jev review was also negative. The continuation reader excluded any report outcome other than `done`, discarding an otherwise valid original-parent checkpoint. This is a framework ownership defect, not proof of exhausted quota or tool unavailability.

Correction: retain completed-child execution truth separately from report quality. A blocked report may resume the original parent only when every sealed child's canonical execution is completed with a finish timestamp. Exact source/group/review/checkpoint/lease checks remain. Failed, blocked, completed-with-errors and cancelled executions do not gain this path. The parent still receives the quality concern and must earn its final completion verdict.

Regression extended the production-builder parent test with a quality-blocked completed child and remaining disable work. It failed before the fix at the original-owner continuation assertion. After the fix, 10/10 tests pass, including exact-once child dispatch, original-parent continuation, disable/readback, foreground ownership isolation and replay settlement. Negative cases review fresh blocked/failed/completed-with-errors execution evidence and refuse continuation. Distinct test variant run IDs avoid cross-session fixture collisions.

Evidence: `/tmp/clem-quality-parent-red.log`, `/tmp/clem-quality-parent-green2.log`, `/tmp/clem-quality-parent-types.log`. Typecheck and diff check pass. Isolated runner live-home sentinel NOT PERFORMED because installed daemon owns home; do not call these live acceptance or isolation certification. Installed source remains the failed candidate until the next committed build/hotpatch.

Cleanup: disabled only the named manual fixture using its console set-enabled endpoint, and read back `enabled:false`. This was operator cleanup, NOT autonomous parent success. No personal workflows modified. Next owed: neighboring report-back tests, exact clean candidate rebuild/hotpatch and a fresh matched installed-app source that proves the whole enable/run/verify/disable task. Investigate the legacy target review's negative result separately; do not erase the warning to get a passing run. Broader release gates and JIT latency/token qualification remain owed.

Neighbor verification completed: 48/48 across workflow-origin-terminal, workflow-run-report-back, and workflow-run-report-back.human (`/tmp/clem-quality-parent-neighbors.log`). No generative-provider calls in these regression tests. Next step is the clean candidate build and installed acceptance, not more identical isolated runs.

## 2026-09-23: installed parent continuation accepted, stale watcher found

Hotpatched clean `34e68149946f120725b7324a6d4486fa36ee0613` using the Terminal recipe after confirming no unfinished attempts or active work; historic paused personal workflows and Slack approval left alone. Build fingerprint `bcd2738607394ec8d4b41bf3ea3ac18a507550e572c853296017e42f52ba5a5a`, dist digest `2729a5c0fb7366ad82eb42a8a866bf32168c2fe9c4acfc1b27016307a9bbcf7a`. Previous daemon backup `dist.backup-16gozL` retained.

Fresh matched Opus source 286621, session `sess-desktop-f337f01e4360c1b494813399`, one child `1790154941558-93bbfb`. Child product 323. Original attempt resumed through continuation request 286682, called run status, disabled the fixture, and read back disabled. Exactly one dispatch and one terminal (286730), original attempt completed. Console readback independently confirms fixture disabled. Final completion accepted by Grok4.3; Jev negative was not accepted as final because evidence coverage was complete. This proves the parent handoff repair for this controlled case, not broader release acceptance.

Canonical read-only comparison: failed baseline 32.929s versus completed candidate 56.112s; 4 versus 7 canonical tools; uncached input 81,914 versus 163,775; output 1,157 versus 2,429. Candidate usage rows: Opus9, Jev1.13.0 5, Grok4.3 4, jev-latest1. Exact source attribution certified; one uncertified cache-accounting sample in each turn. Different achieved outcomes make this a reliability comparison, NOT an efficiency win. Evidence `/tmp/clem-combined-acceptance/parent-34e681499-comparison.txt` and source-specific public/private event exports.

New defect exposed: watcher started at 286700 with four business settlements, completed 286703 asserting the workflow was still enabled. Disable settled 286710/286711. Yet the stale instruction was injected 286714 and delivered 286715, claiming at 286716 it had never been disabled. Existing freshness checks covered objective and worker progress, not foreground tool settlements. Correction binds advisory to settled business-call count and rechecks after judgment, at boundary selection and immediately before injection. Stale verdicts also cannot change unresolved-drift state. Discovery-only control calls do not invalidate still-relevant business advice.

Regression: existing two-read review followed by a third settled read reproduces the stale injection before the fix (`/tmp/clem-stale-watcher-red.log`: 1/4 fails). Additional recovery regression distinguishes a successful corrected read (discard old advice) from schema discovery without executing the corrected read (retain useful advice). Live acceptance of this watcher change, workflow child quality-review calibration, matched Sol coverage, JIT routing efficiency and full release gates remain owed.

Watcher validation completed: 14/14 production-host trajectory/advisory/Plan publication cases (`/tmp/clem-stale-watcher-green3.log`) and 14/14 watcher evidence, fan-out rearm and escalation neighbors (`/tmp/clem-stale-watcher-neighbors.log`). Typecheck passed (`/tmp/clem-stale-watcher-types.log`), diff check passed. No generative tests in these suites; installed acceptance of this subsequent change is still owed.

## 2026-09-23: watcher accepted live; workflow transform evidence gap repaired

Installed clean `a3dd9a750959576b10d649f0a6c0e17149a4ba81`, fingerprint `9e07385507956bb708c6115eb0c1d0a612891cc62b1289503ee82eb75a0ec096`, dist `9ad192ec62fcd2dfa578c869826e2ed082e30ead574ab59260ab614be4cc2820`. Terminal recipe, idle app, exact path and source checked. Initial build-info connection refusal happened before chat submission during startup; retried GET/submission only after startup, not an accepted run.

Fresh matched source 286731 in `sess-desktop-305ec548869f0b83cae9edbe`, child `1790155424184-bbc1c0`. One dispatch and one original-parent terminal 286837; product323 and fixture independently read back disabled. Watcher started286811/completed286814 with "still enabled"; after disable it was discarded286829 with `settled_work_changed`, never injected. This is live evidence for stale-advice suppression. Quality-blocked child advisory remains.

Matched successful turns: 56.112s → 57.412s; uncached input163775 →153370 (-6.4%); output2429 →2489. One pair does NOT prove latency improvement. Canonical comparison and public/private exports under `/tmp/clem-combined-acceptance/parent-a3dd9a750-*`. No tag or broad efficiency acceptance.

Child quality diagnosis: workflow target evidence collected logical tool settlements only. Native transform completed with a content-addressed output artifact and step_completed event, but reviewer received no structured outcome coverage and no transform artifact content. Jev consequently reported missing work. Correction adds verified transform output evidence from the exact run's admitted definition, current uninvalidated completion and exact artifact digest; never from arbitrary stepOutputs prose. This certifies compute output, not external effects. Failed/in-flight/invalidated work cannot supply that receipt. Actual logical-tool settlements now also supply structured coverage to the same reviewer; large evidence remains accessible by reference.

Pins: six transform variants (verified, missing artifact, altered bytes, invalidated step, model-only output, mismatched run identity). Without implementation, the verified case fails (`/tmp/clem-transform-evidence-red.log`); with implementation target evidence/judge tests pass. Expanded host-completion contract run exposed two existing outdated fixture assertions. Both failed unchanged at current HEAD and v3.18.19 (`/tmp/clem-completion-neighbors-head.log`, `...-tag.log`), by exact test names "workflow target review uses exact run receipts, current file bytes and carrier identity, surviving SQLite reopen" and "a blocked finding replaces the rejected draft; a plain negative keeps the generic note". Corrected fixtures to resolve complete large evidence through its authenticated reference and bind the trusted negative review to exact objective/reply hashes. No terminal guard loosened.

Final affected suite:79 passed,0 failed,1 existing skipped (`/tmp/clem-transform-evidence-final2.log`). Typecheck and diff check pass; no generative testing in these suites. Live-home sentinel NOT PERFORMED while live daemon owns home. Installed acceptance of transform evidence still owed; compiled graph/nested compute coverage is not newly claimed. Next: build exact commit, hotpatch and verify child quality plus complete parent task before Sol and broader release gates. JIT routing optimization remains open.

## 2026-09-23: transform evidence accepted on Opus and Sol; Jev clipping defect

Installed clean `d9450161225b9c7eeba1d4dc9a153a3aebdef295` via Terminal recipe, confirmed fingerprint `0cadc6a27d1ab9ba831e8f43e4dd59ee1deeb8ac3407e4c4c2cb2a1dcf840712`, dist digest `c398b79a49f0b670f405c37f14e180f213b204a1d01c286a2a00274320303181`. Exact app idle before patch; no other build/test observed. Existing paused personal work/approval untouched.

Opus accepted source286838/session `sess-desktop-1f066365e5202275867a0fe5`, child `1790156000233-e2da77`: completed/succeeded, no needsAttention. Workflow target reviewer Grok4.3 accepted exact product323 contract with no failed-open. Parent resumed original attempt, disabled/read back, final286945; exactly one dispatch/terminal, finished attempt with lease_expires_at null. Owner string is retained provenance, not an active lease.

Switched through the existing active-brain endpoint to the live catalog's gpt-6-sol, same installed candidate and same prompt. Source286946/session `sess-desktop-4b21c82652121644adc11cf3`, child `1790156127981-d3f835`: completed/succeeded, no needsAttention. One dispatch/terminal287055, original attempt completed with lease_expires_at null, fixture independently read back disabled. Restored claude_oauth/claude-opus-5-5 through the endpoint and verified settings afterward. Existing OpenAI primary was already gpt-6-sol; worker/judge bindings remained unchanged.

Measurements: Opus58.849s,169518 uncached input,2358 output; Sol69.816s,150217 uncached input,1146 output. Both7 canonical tool calls. Exact accepted-source usage; see `parent-d94501612-comparison.txt`, `parent-d94501612-sol-comparison.txt` and public/private event exports in `/tmp/clem-combined-acceptance/`. No superiority or latency-win claim from these pairs. Parent final completion accepted by configured Grok4.3 on both; Jev classified incomplete despite full evidence coverage, correctly rejected by the existing completion coverage guard.

Wire-composition evidence (not the older registry-only schema audit): first Opus request estimated17804 tokens, tool schemas10485, memory2774, instructions1566, turn context1261, history1052, packet513, current message153. Largest individual schemas plan_task2840/run_worker1329/work_call1280; installed first-class native authoring schemas were already absent on this task. Initial context assembly7.683s. Saved scoped cost-only trace `d94501612-context-costs.json`. Do not optimize from the stale 72KB registry audit as if it were today's wire.

Found a correctness/cost defect in tryJevCompletionVerdict: it silently prefix-clipped objective1200, response6000, verifiedReads4000, tool summary2500 characters and only12 outcome rows, while continuing to advertise complete coverage. Later disable/readback receipts could disappear. Correction preserves the exact supplied source-scoped objective, reply and evidence, including every coverage row. No confidence threshold lowered, no completion forced. Transport/context failure continues to abstain to the configured reviewer. This is not wholesale chat/catalog injection: inputs remain the accepted source's completion evidence. Larger Jev input cost must be measured against avoided fallback/rework in the next live run.

Pin captures the real request body with late requirements/receipts and16 outcome rows. It fails without the fix (`/tmp/clem-jev-complete-evidence-red.log`), and asserts byte preservation plus existing503 fallback. Live acceptance of this adapter change is still owed, as are JIT selection, broader native/CLI/MCP/Composio/memory/proactivity/mobile restart canaries and exact release gates. Previous installed two-provider acceptance is scoped to d94501612, not an unbuilt newer source.

Adapter verification:75/75 control-plane and objective-judge tests passed (`/tmp/clem-jev-complete-evidence-green.log`); typecheck and diff check passed. No live model calls in this test suite. Sentinel not performed while live daemon owns the home. Build/hotpatch acceptance of the new adapter remains next.
