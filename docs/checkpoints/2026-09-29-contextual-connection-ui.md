# Contextual connection setup, desktop and mobile — 2026-09-29

## Outcome and source ownership

This is the first implementation slice of the owner's request to make setup feel native and let Clem carry a task through missing capabilities. UI and harness work belong together: a connection form without durable continuation would merely move the manual setup problem into chat.

Base: `4e2efe15bc348549e195e6660a305c011bff8cf1`. Implementation branch: `codex/contextual-connection-ui`; worktree: `~/.codex/worktrees/connection-continuity/clementine-next`. The other agent's shell lane was last checked clean at `5fc52bf4b`, branch `claude/shell-anywhere`; it was not modified. Its navigation/settings/consent work remains owned by that lane. Main and the owner's uncommitted documents were not changed.

Source and UI builds are qualified separately from installation. This slice has **not been merged, hotpatched, tagged, or accepted in the installed app/live home**. The broader improvement goal remains open.

## What changes for the person

- A host-observed missing Composio connection offers setup directly in the conversation, on desktop and paired mobile. Arbitrary model prose cannot manufacture a connection form.
- The existing provider metadata drives OAuth, API credentials, account details, and custom OAuth application forms. Secrets stay in the form/request path, outside chat messages and continuity records.
- The original task remains visible. Returning from sign-in checks the exact provider-returned account. A successful check can send the original continuation once, using a stable host key across both surfaces.
- Reopening, a lost response, and retry retain that key. Cancel uses it too. Failures remain visible; a failed account-list fetch no longer presents an empty connections list as fact on mobile.
- The form follows the incumbent UI rather than introducing another dashboard: inline controls, clear primary action, optional developer fields collapsed, readable mobile width, accessible labels and status/error messages.

No model is called to render setup, interpret a connection button, or determine whether the provider reports the account ready. Existing task reasoning, tool discovery, Jev decisions, review, and approval rules still run in their existing lanes.

## Task and authority path

```mermaid
flowchart LR
  A[Original accepted request] --> B[Host observes missing connection]
  B --> C[Setup inside desktop or mobile chat]
  C --> D[Provider returns account identity]
  D --> E[Fresh exact-account verification]
  E --> F[Recheck task and setup binding]
  F --> G[One shared continuation receipt and executor]
  G --> H[Existing discovery and callable attestation]
  H --> I[Existing approval and effect receipts]
```

The setup record contains request/session/account identifiers and update time, not credentials or authorization URLs. Its verified snapshot is checked again at first admission, in the same SQLite transaction as the claim. A later real user request, Stop, or replaced account prevents a stale setup from starting work. The server-only verification snapshot is not accepted from browser input.

Receipt identity alone is insufficient: desktop and phone also share the existing run-attempt lease. Audience identity is copied from the original accepted source only after the exact durable receipt is checked. Ordinary chat audience checks remain unchanged. The continuation preserves original Plan mode and bypasses unrelated background-reply and approval-intent heuristics.

Connection readiness does **not** satisfy the missing-capability dependency. Canonical continuation plus fresh account-bound callable attestation still owns that transition. Nor does this slice force downstream execution onto the newly connected account: existing exact account/source routing remains responsible and can still request a choice.

## Intentional boundary that remains open

Normal and Plan continuations are implemented. An already-owned **reviewed Execute** is not restarted by this setup flow. It can connect the app and reports that execution remains paused. It is never silently converted to Normal, nor granted a second execution of the same immutable plan revision.

Before promising the entire setup journey works for Execute, implement and qualify resumption through its existing execution owner and completed-step/effect records. Do not bypass the one-execution-per-revision rule or create a new chat source pretending to own its previous claim. Existing generic chat behavior is unchanged by this new contextual guard.

### Reviewed execution follow-up: retained context, activation still owed — September 30

The terminal connection-pause seam now retains a private, immutable cursor to the original execution's accepted model-batch checkpoint. It binds the exact dependency subject, source, reviewed plan revision, execution claim and run. It stores a reference rather than another history/prompt dump. Ordinary Normal/Plan setup is unchanged. Both ordinary `ASK:` projection and an explicit awaiting-input terminal pass through this seam.

This is **not yet an Execute resumption implementation**. The contextual Execute blocker remains in place. No new source is allowed to impersonate the old execution, and no account-ready response grants consent or satisfies the capability dependency. Missing batch evidence or an uncertain write produces a deduplicated private diagnostic and leaves the task paused; it cannot fabricate a restart-ready checkpoint.

The important finding was that balanced `outcome.history` is not the canonical next-batch history. The host appends its final question after the accepted batch checkpoint. Reusing that mutable session snapshot violates the next batch's exact history digest. The new cursor is minted through `prepareAcceptedModelBatchRestart`, which reopens the call settlements and canonical history. Public question text remains on the dependency/event path.

The next execution slice must validate a distinct connection activation, build against the original source, and keep the new delivery/control source separate. Reuse the existing recovery activation pattern without fabricating an approval card. Freeze or reopen the original agent/MCP scope as well; a mutable latest-session scope is not a substitute. Preserve current reviewed account/schema identity, cancellation, one executor, completion-review evidence and completed-write receipts. A newly connected different account does not silently replace the account in the reviewed plan. Merely re-entering ordinary `runConversation` is insufficient because it replays the original `needs_input` terminal.

Desktop and mobile also distinguish connected from resumed visually, remove finished sign-in links, and show accurate preparation/checking progress. Desktop now awaits the no-auth connection verifier through the setup callback, keeping the action disabled while it runs. Reviewed Execute shows connected-but-paused; ordinary tasks issue one continuation.

Follow-up verification: **79/79** accepted-batch, connection service, dependency, recovery-activation, public-event coverage, HTTP-route and gateway continuation tests passed; runtime TypeScript passed. The new regression performs one injected write, encounters the missing connection, stores an ASK-bearing session snapshot, closes/reopens the database, overwrites chat history, and reopens the retained canonical batch. It proves one execution claim, one physical write, rejected noncanonical history and an accepted next batch. Further cases cover prose-only requests, absent batch evidence, changed dependency identity, wrong session, Normal/Plan isolation and uncertain-write reconciliation. This is checkpoint/ledger proof, **not a claim that the final resume entry has been exercised**.

The follow-up review identified three issues and all were fixed before saving: a strict checkpoint-reader exception could abort the ordinary pause, approval delivery uses a different source from execution, and production approval buttons emit synthetic controls that the ordinary latest-user lookup intentionally excludes. Capture failure is now contained at the pause seam and recorded privately while the existing question survives. Capture and current-setup lookup map an approval delivery source only through the existing validated durable resume marker. Setup lookup recognizes those validated synthetic controls separately from passive background report-backs. The regressions cover synthetic and ordinary approval delivery, Stop on either execution or delivery, and rejection of an unproven approval-shaped message. This mapping does not grant a connection continuation, clear a review, or start an Execute.

Initial fixture iterations omitted the control-topology marker and expected the wrong rejection status from a database chain constraint. Those test mistakes were corrected. The initial missing-event-type failure was fixed by declaring the diagnostic and making it explicitly private. The completed targeted run is green; none is attributed as pre-existing.

Controlled browser checks exercised ordinary and reviewed-Execute states on both surfaces. Ordinary setup produced exactly one continuation; Execute produced zero. Verification stayed disabled until the fixture released its response. Mobile layout measured 390px document width with no horizontal overflow and a 358px card. Fixtures mocked all fetches, pointed dev proxy fallback at a non-daemon port, and were removed with their tabs and servers afterward. No provider sign-in, model call or external write was performed. The live-home sentinel remained unproven with daemon 78672 active.

Final frontend builds passed after the UI adjustments (the existing console large-chunk warning remains); the mobile connection helper suite passed **8/8**. Evidence: `/tmp/clem-connection-checkpoint-final-tests.txt`, `/tmp/clem-connection-checkpoint-tsc.txt`, `/tmp/clem-connection-followup-console-build.txt`, `/tmp/clem-connection-followup-mobile-build.txt`, `/tmp/clem-connection-followup-mobile-tests.txt`. These `/tmp` logs are transient; the counts, limits and findings are retained in this committed checkpoint. The final test runner again reported its live-home sentinel **NOT PERFORMED** while daemon 78672 was active and memory database/WAL/SHM and secrets metadata changed; this is not a live-home isolation or acceptance claim. This follow-up is still isolated source; main, the installed app and the other agent's `claude/shell-anywhere` branch were not changed by this task. The final ownership recheck found that branch at `8da123b87` with the other agent now editing `src/runtime/harness/catalog-reviewed-cli-reconcile.test.ts`; preserve that ongoing work.

Generic provider-reconnect questions without an exact toolkit still retain their existing answer choices; this slice does not infer a toolkit from prose. Local CLI/MCP enrollment, purchases such as phone-number provisioning, callback delivery, and delegated coding setup are subsequent slices, not claimed capabilities here.

### Retained construction context and rebuild checks — September 30

The connection checkpoint now captures the paused agent's privately bound tool
envelope, binding revision, MCP scope, serializable construction options and
string model identity. The records are immutable and survive database reopen.
SDK/provider objects, instructions, closures and credentials are not serialized.
An opaque custom model remains unknown; it cannot manufacture a replayable
model ID. Missing private bindings leave the batch cursor intact without
inventing an unrestricted agent. Explicitly denied MCP access remains denied.

`connection-agent-rebuild.ts` is an **unwired prerequisite**, not a new resume
entry point. It loads the retained original source, primes current planning,
runs ordinary reviewed-plan account/capability/schema revalidation, and rebuilds
against current definitions. It checks fresh tool-envelope identity, original
MCP scope, model and construction options. It rechecks task ownership after
awaited work. Successful sign-in cannot replace the reviewed account. The
helper neither starts a run nor grants an approval, and its production path
adds no setup-model question.

Review caught and fixed two issues before this slice was saved:

- The fresh core can change agents after a transient model failure. Capturing
  `options.agent` would retain the abandoned agent. Pause hooks now use the
  current agent, and a private callback updates the outer terminal reducer.
- `acceptedRoute` affects tool behavior beyond the sealed schema. The existing
  construction-context binding now retains it, including its absence; the
  rebuild check compares the fresh construction context rather than treating
  a matching envelope as proof of identical behavior.

The new fallback pins exercise the real conversation core with injected
runners. Both prose ASK and structured awaiting-input capture the replacement
agent. Removing the fallback fix makes both pins fail on the stale original
model; restoring it makes them pass. The actual host-engine pause fixtures also
pass with recording models: one tool read, two model frames, one public pause,
zero approval cards. Rebuild pins reject changed reviewed accounts, schemas,
MCP scope, models, accepted routes, constructor restrictions and lost ownership.

The completed targeted run passed **65/65** across accepted model batches,
actual host connection pauses, existing terminal delivery and recovery
activation. Logs: `/tmp/clem-connection-context-qualified.txt`,
`/tmp/clem-connection-fallback-red.txt`. These are transient logs; this section
retains the outcome and its limits. The isolation sentinel was **NOT PERFORMED**
while the live daemon remained active; no live acceptance is claimed.
Existing workflow parent-review and dispatch-handoff checks passed **12/12**,
for **77 focused checks** in this slice; runtime TypeScript passed. These checks
do not constitute a full-suite or production qualification. Logs:
`/tmp/clem-connection-workflow-context-pins.txt` and
`/tmp/clem-connection-context-qualified-tsc.txt`. The final bounded read-only
review found no further concrete issue. At the ownership recheck the shell
agent's separate branch was clean at `c826d4b9c`; this task did not alter it.

**Still owed at this earlier checkpoint before enabling reviewed Execute continuation:** durable original
agent/project/memory identity, a distinct connection activation and delivery
owner, cancellation and executor leases, retained token-budget semantics,
fresh capability satisfaction, and proof that settled writes are not replayed.
The UI/service Execute blocker remains. The UI truthfully says connected but
paused; building the context alone must never flip it to working or completed.
No change from this slice is installed, merged to main or tagged.

### Consumed host progress at a connection pause — September 30

This slice retains and inspects progress; it does **not** enable automatic
reviewed Execute continuation. The desktop/mobile connected-but-paused state
continues to describe the actual runtime behavior.

The actual host's completion/ASK and review-needs-input exits now bind one
private compact record to the agent and exact accepted source. It records the
next host step (including the consumed ASK frame), no-progress state/cursor,
completion-review count and feedback, effective activation model/tool limits,
tool calls spent, elapsed activation time, one-shot continuation allowances,
remaining model-stall retries, and watcher checks/injections/delivered-steers.
An unfinished watcher is recorded as unfinished, never as an on-track verdict.
The record is cleared on host entry and copied at binding/read so a reused
agent or later caller mutation cannot replenish a saved task's allowances.
Optional capture failure keeps the existing public pause intact.

The immutable source connection checkpoint now carries this compact record
beside the existing batch token. It stores no second full conversation. The
new read-only batch inspector validates exact finalized history and durable
result receipts. A later descendant cannot use an older connection's budget
snapshot, even though the ordinary restart token intentionally allows that
descendant. The recovery inspection uses the existing host parser: it rejects
an out-of-range no-progress cursor and a review from a different source instead
of clamping the cursor or dropping the review. Missing legacy progress is not
replaced with fresh default counters.

The actual host fixture revealed an additional activation requirement:
`eventlog.ts::hostTurnCallAuthorityTerminalTarget` closes an ordinary input
pause as `host_needs_input`. Both ASK and structured connection pauses retain
good progress but finish with a **closed** host root. The new inspector reports
that state; it does not reopen it. Existing admission/restart paths still
require open authority, and the regression pin proves that inspection does
not make a closed source executable. Do not solve continuation by weakening
that check, rewriting a terminal, making a second plan claim, or treating a
successful sign-in as consent for a new task. A distinct durable connection
pause/activation owner must govern the same original execution, cancellation,
account/schema revalidation, leases and delivery.

Budget boundary also confirmed: production fresh host execution bypasses the
legacy `runConversationCore`'s outer token-window/step/clock locals. The approval
continuation core, in contrast, self-baselines a new consented token window and
resets its outer clock/counters. This host record must not be presented as proof
of those missing outer counters, nor may a connection control inherit the
approval lane's budget renewal. Retain the actual outer state where it exists;
preserve durable accepted-source usage accounting. Check remaining allowance
before the first resumed model request. No new token-budget behavior is enabled
in this slice.

Validation uses recording/injected models and temporary homes, with no paid
model calls:

- **50/50** batch/checkpoint/schema/actual-host-pause checks passed; captures
  spent review/no-progress state, consumed ASK step, exact canonical prefix,
  database reopen, stale descendants and invalid/missing progress.
- **349/349** host runner, no-progress governor and recovery-activation checks
  passed. These include existing approval, Plan and host recovery behavior.
- Runtime `tsc --noEmit` passed. The bounded independent read-only review found
  no further concrete issue in retention/inspection or authority preservation.

Transient logs: `/tmp/clem-connection-progress-qualified.txt`,
`/tmp/clem-connection-progress-host-regressions.txt`,
`/tmp/clem-connection-progress-qualified-tsc.txt`. The first new fixture was red
because it incorrectly expected an open root after the real needs-input
terminal. Investigation established the root-lifecycle requirement above; the
test now explicitly requires read-only inspection and continued refusal by the
execution restart API. No execution boundary was relaxed to make it pass.
The runner's live-home sentinel was **NOT PERFORMED** with daemon 35630 active;
this is neither live acceptance nor an isolation proof. No benchmark win is
claimed.

Ownership recheck: the other shell agent advanced independently to
`e9d5b0294` (`claude/shell-anywhere`) and is editing consent policy, plan scope
and console settings/navigation. Its checkpoint reports an installed shell
slice; this task has not independently verified the served fingerprint.
The old localhost:8768 build-info address refused a read-only connection, so
it cannot establish current installed identity. No restart/hotpatch was
attempted. Preserve that agent's ongoing changes during integration, especially
the separate `console-routes.ts` modifications. Our series remains in its own
worktree, unmerged, uninstalled and untagged.

### Original task identity across setup and approval recovery — September 30

The source-context prerequisite is now implemented. Each newly accepted request
retains a compact immutable descriptor: original agent ID and incarnation,
project revision, workspace composition digest, memory scope and (for helper
workers) the exact parent-source reference. It does not copy prompt bodies,
transcripts, credentials, model objects or retrieved memories. Current facts
within the same retained scope can still be retrieved; this is not a frozen
snapshot of everything the user knew at acceptance.

Capture happens at real fresh admissions: desktop, mobile's gateway, the shared
Discord/Slack entry, direct bridge/loop turns and delegated workers. Reusing an
attempt or supplying a historical source only reopens saved identity. Older
sources and legacy agents without a creation identity are not given invented
recovery proof; ordinary legacy behavior remains available. Workers without a
validated parent record similarly cannot claim exact durable scope.

Within an accepted request, source-local composition serves agent/project
primers, reviewer context and memory read/learning scope. A later UI selection
applies to the next request without retargeting the running one. Fresh scope is
derived from the current resolved mount, never from a warmed process cache.
Reopen rejects changed/deleted/replaced agents, altered skills, changed or
archived projects and changed project assignments. The connection agent rebuild
helper checks the private source reference before retrieval and construction.
It remains unwired to automatic reviewed Execute continuation.

The approval restart pin found a separate bridge defect: the approval control
was being processed as a new source-selection answer, producing
`material_source_authority_invalid` before the existing recovery could run.
The bridge now recognizes only the already-validated approval checkpoint
mapping, restores its original composition and business text, and leaves the
loop to validate the canonical checkpoint, exact consent and settled results.
The approval source still owns delivery. Original-context priming happens
inside that scope. Capture/restoration failures run through the bridge's
terminal/attempt cleanup instead of leaving a spinner armed.

Evidence saved in this slice:

- **152/152** entry/context/gateway/worker/bridge checks passed in
  `/tmp/clem-source-context-entry-pins.txt` before the final transport additions.
- **78/78** accepted-model-batch, recovery-owner, session-composition,
  memory-scope, reviewed-plan admission and surface-parity checks passed in
  `/tmp/clem-source-context-remaining-regressions.txt`.
- **5/5** exact transport/restart pins passed in
  `/tmp/clem-source-context-real-entries3.txt`: desktop accepts/replays one
  source with its retained context; Discord and Slack capture it at admission;
  an approved write survives a checkpoint storage fault, real process exit and
  public-bridge recovery; the next process replays the terminal without a model
  call or a second provider crossing. Only injected recording models/providers
  run. The first bridge pin failed on the source-selection defect above before
  its fix. Later fixture corrections supplied the production approval attempt,
  separate display text and valid Slack channel identity; these were test setup
  corrections, not product defects.
- The final boundary regression run passed **154/154** across the bridge,
  source-context, desktop HTTP admission/idempotency and Discord/Slack terminal
  suites, in `/tmp/clem-source-context-final-boundaries.txt`. Runtime TypeScript
  passed in `/tmp/clem-source-context-final-qualified-tsc.txt`. These counts
  overlap and must not be added as unique tests.

All paths use temporary fixture homes. The runner's live-home isolation
sentinel remained **NOT PERFORMED** while the live daemon was active (last reported PIDs
18798 and 75509); no stronger isolation or production acceptance claim is made. No paid
model calls, account changes, install, hotpatch, merge or tag were performed by
this task. A read-only review found no further concrete issue after the fresh
transport admissions were included.

The shell agent independently reached `c76c4561a`, including a desktop
approve-button/resume race fix. Our four-line desktop admission change and that
agent's approval-route changes must both survive integration. Their lane was
not edited. Do not install an older combined build over their newer work.

**Still owed:** a distinct connection activation/delivery owner, one executor
lease and cancellation path, retained model/tool/token/elapsed budgets, current
capability satisfaction, and integrated no-replay evidence for connection
resumption itself. Then combine source revisions, build, coordinate hotpatch,
and run the controlled installed-app/live-home acceptance matrix. Setup adds no
model prompt or model call; no measured live speed/token improvement is claimed.
The UI continues to show reviewed Execute as connected but paused.

## Verification and evidence

Targeted service/dependency/HTTP-route regressions: **31/31 passed**. Actual gateway continuation regressions: **10/10 passed**. These cover exact account readiness, stale tasks, replaced accounts before admission, database reopen, cross-device identity, original Plan mode, unrelated background work, a held desktop lease, and synthetic report-back events. Providers are injected; no paid model or real account action was used.

Mobile admission/cancellation helper regressions: **6/6 passed**. Existing mobile route suite: **107/107 passed**, including ordinary chat, pairing, approvals, idempotency, and answer streaming. One premature invocation during helper assembly failed on the missing export before tests started; the completed-source rerun passed all 107. It was an implementation-order error, not a pre-existing failure.

Earlier unchanged frontend checks in this slice: desktop chat transport **56 passed**; mobile connection helpers **8 passed**; mobile settings-state checks **8 passed**; new chat-engine continuation checks **8 passed**; existing engine checks **27 passed**. Runtime TypeScript and desktop/mobile production builds passed. The console build retains its large-chunk warning; this is not a claim of reduced JavaScript bundle size.

Controlled browser fixtures exercised save → verify → continuation on desktop and a 390-pixel mobile viewport. The mobile document had no horizontal overflow. Temporary fixture pages, servers, and browser tabs were removed. Those were mocked visual checks, not live provider acceptance.

The isolation runner explicitly could not prove its live-home sentinel because existing daemons were active (PID 78672 initially; the mobile route run also reported 86709). It observed daemon-owned files changing. Fixture homes and injected network guards are useful regression evidence, **not installed-app acceptance**. No daemon was stopped to manufacture that proof.

## Integration and live acceptance still owed

1. Finish the reviewed Execute continuation boundary above, or obtain an explicit narrower release scope; do not silently call the whole setup flow complete.
2. Review this source together with the shell agent's candidate. Inspect overlapping routing/approval behavior before combining, then run affected regression suites on the exact combined revision.
3. Build after the final source/checkpoint commit, coordinate the established Terminal/signing hotpatch, and verify the running app's served SHA/fingerprint, not just its disk stamp.
4. In the installed app/live home, use named controlled tasks to test new connection, expired connection, failed sign-in, desktop-to-phone and phone-to-desktop return, cancel, retry after lost response, and a new user request while sign-in is outstanding.
5. Prove one logical continuation and one physical executor, unchanged Plan restrictions, exact downstream model/tool/account routing, and no replay of completed writes. Include an ordinary chat/approval regression beside these tests.
6. Record wall time and all model/token lanes on matched work. This slice removes manual navigation and adds no setup-model calls; it has no measured live latency/token improvement yet.

## Framework traps to preserve

- `needs_input` attempts use `interrupted`; treating every interrupted attempt as cancelled hides legitimate setup cards.
- Background report-backs can emit `user_input_received` with `synthetic: true`. They must not replace the real user source when selecting a setup dependency.
- A source's audience is more than session ID. Both user ID and conversation key, including absence, matter to continuation consumption.
- Ordinary mobile request keys are device-scoped. This contextual continuation intentionally shares a host key; Stop must use the same derivation.
- Preserve original Plan mode; omitting a task mode means Normal, not inheritance.
- A last-good cached account list is not proof of present connection readiness.
- Recheck after awaits. Verification can finish before another setup changes the account or a newer user request wins the conversation.
- A receipt is not source acceptance. Mobile acknowledgement must not leave a stale rejected continuation waiting forever for an SSE source that was never created.

## UI woven into the next slices

### Verified account identity in the setup card — September 30

Both desktop and mobile now show which account the setup check verified. The
strict provider verifier can return a small display projection from the same
snapshot it already fetched. It returns only the selected connection's ID,
toolkit and label internally; the task setup response exposes only the label,
after rechecking the original task and account binding. Provider state, tokens
and dispatch entity are excluded. A missing name stays unknown; no account
name is guessed from another connection. The UI clears the previous label and
success message when checking again, and a failed recheck cannot keep showing
the account as verified. This adds no model call or extra provider request.

This is display context, not an account-routing grant. Existing non-setup
verifiers retain their previous result shape. Existing callable attestation,
approval requirements, task ownership and the reviewed-Execute pause remain
unchanged. A verified account does not imply a resumed or completed task.

Verification: **29/29** focused tests across strict provider account display,
connection setup/retirement/races, and mobile continuation passed. Runtime
TypeScript and both frontend production builds passed; the existing console
large-chunk warning remains. The design detector returned no findings.
Controlled browser fixtures rendered the actual components and styles: both
surfaces cleared the old confirmation after a failed recheck; ordinary setup
issued one continuation each; reviewed Execute issued zero. Missing account
names rendered explicitly. At a 390px mobile viewport, a long account address
wrapped inside a 358px card with document width 390px. Fixtures intercepted
all fetches, dev proxies pointed at a non-daemon port, and temporary files,
tabs and servers were removed afterward; the viewport override was reset.

Logs: `/tmp/clem-connection-account-{tests,tsc,console,mobile}.txt` and
`/tmp/clem-connection-account-detect.json`. These are transient; this section
retains their results. The runner's live-home sentinel was **NOT PERFORMED**
while daemon 35630 owned the changing live stores. No paid-model test,
provider connection, hotpatch or installed-app acceptance occurred. This
increment is not proof of reviewed Execute resumption, general latency or
token savings, or release readiness.

### Direction for the remaining UI work

The user explicitly wants UI refinement woven into this capability work.
Preserve the existing visual identity and put the next useful action beside
the task that needs it. Desktop and mobile should agree on the task, selected
account, permission, next step and result. The priorities below are planned
work, not claims that the whole experience has shipped.

- **Setup in the conversation:** explain the missing capability, connect with
  provider-native forms, verify the exact account, and return to the retained
  task. Complete safe reviewed-Execute activation before enabling its resume
  button; never ask the person to restate the task to conceal lost continuity.
- **One clear decision:** readable recipient/resource and account names,
  exact proposed effect, and costs where a purchase or recurring charge is
  involved. Progressive disclosure holds technical evidence. A provisioning
  action and permission to send messages/calls are distinct scoped decisions;
  do not turn connecting an app into blanket ongoing authority.
- **Purposeful progress:** show what is running, what needs the user, and what
  actually completed from durable task/receipt state. Put background detail
  in the work view and link back to its conversation, without covering Home
  in redundant cards or equating connection with successful work.
- **Projects and agents:** make the objective, assigned agent, current work
  and retained conversation easy to find. Open or steer the existing child
  execution instead of accidentally creating another.
- **Proactive follow-up:** a check-in explains why now, what changed, and what
  Clem proposes, with a dismiss/defer action and links to the supporting
  memory/task. Background memory maintenance should be visible without
  turning each internal bookkeeping step into a notification.
- **Mobile continuity:** the same task and decision survive sign-in, reload,
  desktop/phone handoff and a lost response. Connection health distinguishes
  outbound tool access from inbound event delivery; a green connection badge
  alone must not imply that future calls/messages can reach Clem.

### Paired harness and UI acceptance

| Harness work | Corresponding user experience | Acceptance evidence |
| --- | --- | --- |
| Event delivery, durable cursors, deduplication, retry, reconciliation | A compact connection detail showing last event, last successful sync, recovery action, and the task a result belongs to | Duplicate/out-of-order callback and reconnect do not duplicate work; stale/offline is visible |
| Provisioning with scoped cost/effect authority | A review card naming the requested resource, account, recurring cost, and exact action; one clear place to respond | No unexplained identifier-only approval or duplicate setup/send approval |
| Projects and agent delegation | Project view with objective, assigned agent, live work, waiting-on-you item, and direct return to the task conversation | User can open/steer/resume the exact child without creating a second owner |
| Proactive goals and memory maintenance | Purposeful check-ins that state why now, what changed, and the suggested next step | Suggestions cite durable evidence, respect dismissal, and do not pretend unperformed work is complete |
| Long tasks and learning | Concise progress and completion receipts with expandable evidence, account/model identity, and cost | Full task continuity and total-token accounting survive compaction and device handoff |

Keep each UI slice attached to a real state transition and its recovery path. Avoid another collection of status cards that cannot explain or control the underlying task.

### Setup state and interaction contract

Refine the existing chat/setup components on both surfaces. Preserve the warm
canvas, orange accent and current typography; this is an interaction refinement,
not a new visual identity. The task remains the anchor throughout the flow.

| Durable state | What the person sees and can do |
| --- | --- |
| Missing connection | The task's next step and why an app/account is needed; one Connect action beside the request |
| Sign-in cancelled or failed | The retained task stays available; retry setup or leave it paused, without resubmitting the business task |
| Account verified, execution not yet ready | Readable verified account plus the specific remaining requirement; never imply that sign-in completed the task |
| Ready to resume | Continue the same task using its retained plan, agent and account; do not prompt for the objective again |
| Running or receiving a duplicate request | One progress view linked to the same execution; an HTTP retry cannot create another task or approval |
| Account changed or task stopped | A concrete reason and the appropriate recovery action; no silent switch to another account or automatic restart after Stop |
| Effect confirmed or result delivered | Human-readable destination and result, with expandable receipt details; distinguish local setup from an actual sent message, created event or purchased resource |

Desktop can keep supporting detail beside the conversation; mobile presents the
same decision in a focused sheet or task view with its primary action visible.
Both use the same durable task/approval identity. Preserve focus after sign-in,
label controls for keyboard/screen readers, and show long account names and
destinations without hiding the information needed to decide. Technical IDs and
trace details belong in an expansion, never in place of the recipient's name.
These are acceptance requirements, not claims of completed visual testing.

## Retained execution progress now governs host re-entry — September 30

This slice connects the retained connection checkpoint to the ordinary host
runner's allowances. It does **not** enable automatic reviewed Execute after
connection setup, reopen a closed root, create an execution claim or satisfy
a missing capability from account verification. The UI still keeps that
continuation unavailable until the remaining ownership path is implemented.

When the runner consumes a retained checkpoint, it now restores the original
model-step ceiling, spent tool calls, retry/continuation allowances, watcher
spending and pending advice. Tool counts restore monotonically. A larger
caller limit cannot replenish the retained allowance, and an incompatible
tool-counter limit is rejected before dispatch. The source's captured
completion policy remains authoritative; a caller's later review switch does
not replace it. Recovery and approval states carry current progress through
subsequent pauses, including cumulative active elapsed time. Paused time is
not charged as active execution.

Pending watcher advice keeps the existing objective, plan, child-progress and
settled-work freshness checks. A process-local unfinished review cannot be
restored as a successful verdict; one replacement may start only if its
original check allowance permits it. No extra model call is needed to restore
this state, and this metadata is not appended to the brain's conversation.

Three recovery traps were found and pinned while implementing the restoration:

- Finalizing a saved model frame incremented its already-advanced step cursor
  again. An approval-result checkpoint failure did the same before any new
  model response. Both now preserve the existing next-step cursor, leaving a
  genuinely unused last model step available.
- An admission hold has no new accepted batch reference. A second failed
  admission must keep the prior accepted batch as the owner of spent progress,
  rather than silently dropping the record and resuming with fresh defaults.
- Duplicate metadata cannot disagree across the host state and its progress
  record: source, accepted batch, engine, cursor, completion-review count,
  no-progress checkpoint and review feedback must match. Unknown legacy
  progress is not fabricated.

Recording-host pins exercise real local reads, checkpoint write failures,
approval before execution, exact result recovery and unchanged body counts.
They also cover exhausted model/tool/stall allowances, subsequent checkpoint
spending, retained review settings, fresh versus stale watcher advice, an
interrupted watcher at/below its ceiling, and mixed-source rejection. The
final surrounding regression run passed **496/496 tests** across
`host-turn-runner.test.ts`, `brackets.test.ts`,
`accepted-model-batch-checkpoint.test.ts` and
`source-connection-checkpoints.integration.test.ts`. Runtime TypeScript passed
and `git diff --check` was clean. Read-only review found the approval cursor
issue above, and found no further concrete defect after correction. Logs are
`/tmp/clem-connection-resume-regression-final.txt` and
`/tmp/clem-connection-resume-progress-tsc.txt`.

These are deterministic regression checks, not live-home acceptance. The
runner's live-home sentinel was **NOT PERFORMED** while daemon 35630 owned the
changing stores (it observed changing secret metadata and capability identity).
The daemon was not stopped, and no isolation proof or installed-app pass is
claimed. No UI code changed in this runtime slice; the account-display browser
checks remain the separately recorded checks above.

Remaining work, in dependency order:

1. Retain open execution authority only when the terminal transaction has
   validated the exact connection checkpoint. Do not reopen historical closed
   roots. Make terminal replay validate the durable pause/activation chain and
   close the original execution root atomically at final delivery.
2. Extend the existing recovery-activation owner with a distinct connection
   variant, binding checkpoint, original execution claim, verified account and
   accepted control receipt. Carry that identity through cancellation,
   retirement, restart recovery and delivery-to-execution source mapping.
3. Rebuild the original agent/project/model/tool context and revalidate current
   capability/account authority. Recheck Stop, source, account and lease after
   asynchronous preparation and before installing canonical recovery under the
   new delivery owner. Avoid the fresh Execute admission and fresh approval
   budget paths.
4. Complete source-level token/outer-window accounting and the same-root
   capability-discovery path; the saved host elapsed scalar is not by itself
   full wall/token-budget enforcement. Fresh callable attestation, rather than
   connection verification, retires the capability dependency.
5. Enable the desktop/mobile continuation only after those paths pass their
   controlled integration checks, then combine with the other agent's current
   candidate and qualify in the installed app/live home. Verify Stop,
   repeated clicks, account changes, process/device handoff, approval and no
   replay of completed writes.

The other agent's `claude/shell-anywhere` worktree was rechecked clean at
`5fc52bf4b`. Its newer installation has not been replaced. This series remains
on `codex/contextual-connection-ui`; no merge, paid model test, provider write,
hotpatch or tag occurred in this slice. Full installed identity and live
acceptance remain owed, as do matched latency/token measurements.

## Keep reviewed execution alive at an exact connection pause — September 30

The two ordinary connection-question terminal paths now attach a small private
binding only after validating complete retained agent and host recovery. The
terminal transaction checks the immutable checkpoint, original reviewed claim,
dependency identity, exact latest settled batch and open host authority. It
retains both the host authority and any active accepted-task authority. The
physical foreground attempt still ends as interrupted and releases its
in-flight owner. A connection question is not a completed task or a new tool
grant. Generic questions, incomplete legacy checkpoints and opaque model
objects retain their previous behavior; no closed root is reopened.

Pause lookup uses the same typed projection and exact authority validation as
ordinary terminal replay. Replaying a historical pause does not depend on a
currently open dependency, newest chat or selected account. Its immutable
subject and reviewed execution still must match. The private record never
appears in the public setup card or brain prompt, and this path makes no model
or provider call.

Validation: **119/119 tests** passed across accepted-model-batch-checkpoint,
accepted-task-terminal-publication, accepted-turn-call-authority,
source-connection-checkpoints.integration and connection-setup. Runtime
TypeScript passed. Pins cover both retained owners, database reopen and replay,
ending the physical attempt, no extra dispatch, changed dependency/claim,
mismatched source/digest/status, unfinished batches, ordinary questions,
incomplete checkpoints and corrupted terminal projections/root identity.
The recording integration cases still exercise ASK and structured decisions.
Logs: `/tmp/clem-connection-pause-regression.txt` and
`/tmp/clem-connection-pause-tsc.txt`.

Traps found and fixed in this slice:

- Importing the high-level checkpoint validator into eventlog initialized tool
  adapters before the database path existed. The eventlog validator now has
  only SQL, crypto and type dependencies; agent reconstruction stays outside.
- Casting a saved public presentation alone bypassed normal terminal replay
  checks. Private proof lookup now goes through that shared validator.
- Checking only the dependency status missed a changed subject between
  preparation and commit. Capture and publication now share the dependency
  identity projection, with its digest rechecked in the terminal transaction.
  The original reviewed claim/event/source relationship is rechecked there too.

These are regression checks, not installed-app acceptance. The live-home
sentinel was **NOT PERFORMED** while daemon 35630 was changing live stores.
No model/provider call, configuration change, app restart, build, hotpatch,
merge or tag was performed. The other agent's clean `5fc52bf4b` checkout and
installation remain untouched.

**Activation is still disabled for reviewed Execute.** This finishes the
initial same-source pause part of item 1 above, not its final closure chain.
Next implement the distinct connection activation owner/control receipt,
current account/Stop/lease rechecks, preserved outer-window accounting, and
atomic final closure of the original execution under the new delivery source.
The essential remaining test is pause → activate → finish → reopen → replay
both terminals, including intervening approval/cancellation and no repeated
writes. Only then enable Continue and qualify desktop/mobile setup and device
handoff on one combined installed candidate.

## Durable connection activation and current ownership — September 30

This slice adds the server-side activation primitive; it does **not** enable
reviewed Execute continuation in the UI or route live requests into it yet.

The original reviewed task now has one durable connection-control identity
bound to its pause, checkpoint, original execution source, shared chat receipt,
accepted delivery control, and verified account selection. One managed event
transaction installs canonical recovery, records the new delivery owner, and
publishes the control. A failed install rolls back all of them, including live
subscriber publications. It creates no new plan claim and performs no model or
business tool call.

The distinct connection recovery owner carries the original execution identity
through recovery adoption and database reopen. Composition and completion
evidence map to that original source while delivery belongs to the connection
control. Repeating the click, including from another device, returns the
existing receipt without reinstalling an old checkpoint or resetting spent
host progress. These are database-backed simulated device controls, not actual
phone acceptance. The private activation proof is excluded from public chat
payloads.

`assertConnectionExecutionOwned` is the separate, current ownership check for
asynchronous preparation and subsequent executor integration. It checks the
exact active attempt/lease, recovery and continuation owners, original and
delivery Stop, shared request cancellation, latest ordinary source and account
binding. It remains valid after recovery adoption and dependency satisfaction;
an open setup card is not the authority to continue. Malformed lease dates are
rejected. Returning a historical receipt does not grant fresh execution. The
recording rebuild pin proves Stop during an awaited preparation prevents later
validation and construction.

Validation: **178/178 tests passed** across accepted-model-batch-checkpoint,
recovery-activation, connection-setup, source-session-context,
accepted-task-terminal-publication, accepted-turn-call-authority and
source-connection-checkpoints.integration. Runtime TypeScript passed. The
earlier focused run passed 129/129. Logs are
`/tmp/clem-connection-activation-regression.txt`,
`/tmp/clem-connection-activation-tests.txt` and
`/tmp/clem-connection-activation-tsc.txt`.

Traps retained for integration:

- Use `withEventPublicationTransaction` as the outer activation transaction.
  The existing raw connection-admission transaction cannot contain it; a raw
  outer transaction would also break the publication/rollback contract.
- A persisted owner or repeated-click receipt proves identity, not a live
  lease. Recheck current ownership after each awaited preparation operation.
- Recovery adoption removes the blob but retains its owner. Losing that blob
  must neither lose original task composition nor authorize checkpoint reset.
- Account verification and owner checks do not satisfy callable discovery or
  grant permission to write. Keep the fresh capability/account attestation and
  existing per-effect authority checks in the execution path.

Still owed before enabling Continue: route admission before fresh Execute
claims; executor/timer/retirement and restart integration; original-source
outer-window/token accounting; same-root fresh callable attestation; and atomic
final closure with a historical pause → activation → terminal proof chain.
The current activation reader intentionally still requires the retained root
to be open. It is not yet the final historical replay reader for a completed
continuation. Pin intervening approval/cancellation, recovery after adoption,
multiple connection pauses and no replay of completed writes at integration.

The live-home sentinel was **NOT PERFORMED** because daemon 35630 was changing
live stores during deterministic testing. No paid-model/provider test,
configuration change, app restart, build, hotpatch, merge or tag was performed.
The other agent's checkout was rechecked clean at `5fc52bf4b`; its installation
has not been replaced or independently qualified here. Installed desktop/mobile
acceptance and matched latency/token measurements remain owed. UI priorities
and paired acceptance remain as described above; this is their recovery
foundation, not a claim that the end-to-end setup experience has shipped.

## Original-task completion after connection recovery — September 30

The final delivery control can now close the original reviewed execution and
accepted-task authority in the same event transaction. Its public presentation
still names the actual delivery source and physical attempt. Completion proof,
the reviewed plan claim, graph, manifest and settled tool results remain bound
to the original execution. No fresh task owner or plan claim replaces them.

An immutable, private closure record binds those identities to the actual final
stored terminal, including its run/attempt fields and digest. Historical replay
can validate the original connection question after the root closes, then
validate the later terminal with the normal completion-proof checks. The
original task's terminal-publication reader returns that final winner; ordinary
source-level duplicate delivery continues to return its own earlier event.
Replaying a receipt does not reopen a root or grant a current execution lease.

An intervening approval retains the same original work until its resolved
control publishes a terminal. Approval lineage uses one shared SQL identity
reader rather than duplicated event scans. Approval and connection identity
remain separate from consent, callable freshness and current ownership.
Injected failure during terminal cleanup rolls back the event, closure, both
original authorities, physical-attempt completion and continuation-owner cleanup.
Corrupting the final terminal invalidates replay of the earlier pause too.

The new closure schema rejects mutation/deletion while its session exists, but
allows the owning session's eventual cascade. The storage pin exercises actual
production DDL in a minimal database; it is not qualification of retention for
the entire older plan/context proof chain. Code review found that
`reviewed_plan_*_v1` and `source_session_contexts_v1` still have unconditional
immutable-delete guards and restrictive event/session references. Their
interaction with `reapStaleSessions` needs a bounded fixture and resolution
before promoting this combined feature. Do not silently remove active proof
or skip the normal retention eligibility checks to make cleanup pass.

### Two plan protocol defects exposed by the integration pin

The real reviewed-read fixture initially stopped before the intended connection
pause. `plan_task` inferred requested effects from the host-expanded reviewed
plan text, so policy words such as “send” turned an ordinary reviewed read into
deferred-write work. Effect inference now uses the existing accepted-owner
source/steering projection. The full reviewed plan remains the planning context;
its frozen methods, arguments and per-call consent requirements are unchanged.

Separately, the producer already emitted `writeDeferred: true` for valid gather
stages, but the host's exact success union rejected that field. The host now
accepts precisely that variant with only read/compute requirements. False,
string, unknown-key and contradictory write/unverified-mutation variants still
fail. A valid shape still needs durable activation authority; it grants none.

The older gather-stage test could pass on a refusal because its success checks
were conditional. It now drives the actual wrapped tool through the host,
requires a successful graph/contract, and verifies that the settled result
reaches the next recording-model frame. Its deliberately unfinished work stops
at the fixture's two-frame limit and cannot claim completion. The ordinary
reviewed-read integration separately asserts there is no false write deferral.

### Evidence and remaining UI integration

Verified:

- The surrounding terminal/recovery group passed **223/223** before the plan
  repair. The focused closure/plan repair group passed **195/195**.
- The final surrounding regression group passed **397/397** across 15 files:
  accepted model batches, accepted task publication, host call authority,
  connection checkpoints/setup, recovery, source composition, approval evidence,
  delivery, closure integration, tool invocation, plan completeness, eventlog,
  explicit reviewed execution and recorded provider-plan execution. Afterward,
  the strengthened plan-completeness file passed **6/6**; it is included in the
  previous count, not six additional distinct tests.
- The new integration uses production reviewed `plan_task`, `work_call`, a real
  controlled local `space_get`, graph/manifest/settlement, pause, activation and
  terminal publication. The missing connection, verification response and model
  wire are controlled. It proves one original claim, one completed local read,
  three recording-model calls, two terminals, reopen and exact replay with no
  new read or model call. It does not prove a real provider connection or resumed
  external write.
- Pins also cover done/cancelled/blocked/failed/uncertain closure, approval then
  approve/reject, corruption, cleanup rollback and storage-lifetime behavior.
- Runtime TypeScript and `git diff --check` passed. Logs:
  `/tmp/clem-connection-closure-final.txt`,
  `/tmp/clem-connection-closure-repair.txt`,
  `/tmp/clem-connection-gather-protocol.txt`, and
  `/tmp/clem-connection-closure-tsc-final.txt`.

Not performed: paid-model/provider calls, live business work, UI changes or
browser acceptance in this slice, app restart, build, hotpatch, merge or tag.
The runner's live-home sentinel remained **NOT PERFORMED** because the running
daemon changed live stores during tests (35630 earlier, 72427 in the latest
focused run). This is not an isolation-sentinel pass or live-home acceptance.
The other agent's clean branch advanced to `76c53a1ea` with its own installation
checkpoint. Its installed identity was not independently qualified here.

Still owed: route admission before fresh Execute claims; executor/timer and boot
integration; original-source outer-window/token accounting; fresh same-root
callable/account attestation; multiple setup pauses; and full approval/resume,
Stop and no-replay-of-completed-writes paths. Qualify the retention interaction
above before enabling reviewed Execute Continue. Then combine the owned series
with the other agent's latest source and test the installed desktop/mobile flow,
including device handoff and matched full-task latency/token measurements.
The small `plan-tools.ts` and `host-tool-invocation.ts` repairs overlap that
agent's planning area and must be preserved explicitly during integration.

The UI direction above remains part of the implementation, not a later cosmetic
pass: show the verified account beside the task, one understandable decision,
the actual waiting/running/completed state, and a direct return to the retained
conversation. **Reviewed Execute Continue is still disabled.** These host-side
checks are its completion foundation, not a claim that the complete resume
experience has shipped. This slice adds no model call or prompt text; matched
performance savings remain unmeasured.

## Retained proof lifetime and session cleanup — September 30

The UI continuation depends on keeping the original plan, context and completed
work available. Older immutable-delete guards prevented eligible sessions from
being cleaned up at all. Removing those guards alone would let a surviving
worker or later plan revision lose the evidence it still needs.

Reviewed plans, execution claims/observers, captured source contexts and
connection checkpoints now share SQL-only storage definitions. Their records
remain immutable while their owning session exists and cascade only with that
session. Generated references expose the existing JSON parent identities without
changing their payloads or digests. Restrictive references protect parent
contexts and prior plan revisions; claims and observers retain their existing
proof references. The reaper's existing fixed-point selection now retains every
ancestor needed by a surviving consumer. An open connection execution is retained
even if an old physical-session display status says completed. Existing age,
pin, archive and replay-receipt rules remain in force.

The full host integration exposed an additional deletion-order problem:
session-owned execution evidence has mutually dependent RESTRICT references.
Even when every referenced row belonged to the same expired session, SQLite
could reject an intermediate cascade. A synchronous helper now defers checks
inside the deletion transaction, validates the resulting entire foreign-key
graph, and restores the previous constraint mode before returning. Foreign keys
and immutable triggers stay enabled. A surviving reference or injected failure
rolls back all cleanup. The helper is also used by the session API's hard-delete
path. A session still needed by another task is archived through the existing
retained-replay response rather than producing a foreign-key error. A no-op
retention sweep does not run the full integrity scan.

Migration **83** rebuilds only proof tables already present, copying all original
stored columns exactly. A missing referenced parent or failed integrity check
rolls back the migration, leaving the old data and schema version intact. New
installs create the same definitions lazily. This is a schema integration point:
the other agent's current clean `claude/shell-anywhere` head `76c53a1ea` still
declares schema 82. Reconcile migration numbering and rehearse the combined
candidate on a safe snapshot before installation; do not run a downgrade or
fixture reset against the live home.

Verified:

- **318/318** checks across 13 files passed: retained-proof lifetime, actual
  host connection completion, eventlog, session API, plans, source context,
  connection checkpoint/setup, accepted batches, local execution evidence,
  physical returns, pointer-schema migration and schema readiness.
- The actual host integration was then strengthened to migrate a host-produced
  checkpoint through its historical table shape. That updated test passed
  **1/1**, already represented in the 318 count. Its exact checkpoint survives
  migration, the open task survives attempted expiry, final closure and both
  replays preserve one completed read, and the closed eligible session then
  expires atomically. It still uses three recording-model calls, no paid model.
- Lifetime pins cover transitive consumers, pinned/archived children, reviewed
  revisions, execution observers, real session API deletion, rollback, immutable
  proof guards and restoring an already-deferred caller. Migration pins compare
  every original stored column, reopen, re-entry and corrupt-parent rollback.
- Runtime TypeScript and `git diff --check` passed. Logs:
  `/tmp/clem-retained-proof-regression.txt`,
  `/tmp/clem-retained-proof-migration.txt`,
  `/tmp/clem-retained-proof-tsc-final.txt`.

Not performed: model/provider calls, live-home mutation or acceptance, UI edits,
build, hotpatch, merge or tag. The isolated runner's live-home sentinel remained
**NOT PERFORMED** because daemon 72427 owns the live stores. These are controlled
regression and migration checks, not installed-app acceptance. The other agent's
checkout and installation were left untouched. No latency or token savings are
claimed; this slice adds no prompt content or model call.

Still owed: the route/executor, outer-budget, boot-recovery and fresh-callable
attestation work listed above before reviewed Execute Continue can be enabled.
Dependency-request history and setup-account rows retain their older separate
storage lifetime; this migration does not claim to clean up every historical
metadata table. With no surviving accepted source they do not form a valid
connection control. Include that metadata lifetime in the remaining integration
review. Then qualify the combined installed desktop/mobile experience and
matched full-task measurements.

Trap: accepted-source binding timestamps are immutable authority. Historical
retention fixtures must create them under a controlled historical clock through
the real writer, not update their timestamps or weaken guards to age a test.

The paired UI direction remains section “Direction for the remaining UI work”:
setup beside the request, the verified account, one understandable decision,
purposeful progress, projects/agents and proactive check-ins with direct task
links. **Reviewed Execute Continue remains disabled and no new UI is installed.**

## Retained host executor and dispatch ownership — September 30

Verified: a durable connection control now has an internal `runConversation`
path that rebuilds the retained agent and resumes the current host checkpoint.
It uses the original execution source for work, memory context and model-usage
attribution, and the connection control for delivery. It does not claim the
reviewed plan again, construct a new caller-selected agent, replace the retained
model/completion policy or restore an older setup cursor. Concurrent controls
join one executor; exact completed replay needs no new model or tool work.
The turn retains the ordinary per-task query-vector scope.

The recovery reader now recognizes connection controls alongside approval
controls. The original setup question is already a public terminal, but is not
completion of its newly resumed work. Boot selection and stale-checkpoint
retirement therefore follow the delivery owner while retaining the original
execution source. The recording integration verifies boot selection even with
generic chat auto-resume disabled. It does not qualify fresh boot lease
acquisition or post-adoption checkpoint promotion.

A process-local guard rereads durable ownership, Stop and the exact verified
account before the next model dispatch, host invocation and physical crossing.
It is not serialized as authority. The invocation-entry check alone was too
early: asynchronous account/schema preparation could outlive the owner. Two
new tests failed without the final check and now prove zero-crossing,
pre-dispatch refusal for local and external calls. Nested provider business
calls and metadata probes also recheck after their awaits. Existing dispatch
leases, effect reservations, consent and settlement rules remain authoritative.

Evidence:

- `clem-connection-executor-regression.txt`: **255/255** across ten focused
  files: actual host closure, invocation, recovery activation/restart, accepted
  batches, source checkpoints, connection setup, nested logical identity and
  physical-dispatch grounding/lease behavior.
- `clem-connection-executor-continuations.txt`: **27/27** covering approval
  continuation, checkpoint hopping, continuation ownership, superseded recovery
  and the strengthened connection integration. Four connection cases overlap
  the previous count; these are not 282 distinct tests.
- The connection integration uses a recording model with the network disabled.
  The resumed task takes exactly one additional frame, keeps the completed
  board read at one physical host crossing, preserves one plan claim and
  publishes one final control terminal. Reopen, concurrent continuation and
  completed replay preserve those counts. Changing the account or stopping the
  original task during model resolution prevents that additional model frame.
- The final focused executor passed **4/4** after the query-vector scope change;
  runtime TypeScript and `git diff --check` also passed. Results are recorded in
  `/tmp/clem-connection-executor-final.txt` and
  `/tmp/clem-connection-executor-tsc-final.txt`. Other logs above are in `/tmp/`.
  The initial red ownership pins are `/tmp/clem-connection-dispatch-red.txt`.

Not performed: paid model/provider calls, live business actions, desktop/mobile
visual acceptance, build, hotpatch, merge or tag. No end-to-end latency or token
saving is claimed. The runner's live-home sentinel remained **NOT PERFORMED**
because daemon 72427 owns the live stores. Other-agent source and installed
bytes were left alone; its checkout is now named `claude/two-modes`, still at
`76c53a1ea` when rechecked. This source slice is not installed-app acceptance.

Still owed before enabling reviewed Execute Continue: server-only lease-owner
wiring through desktop/mobile bridge admission before any fresh Execute claim;
fresh same-root account-bound callable attestation; lease renewal and boot
ownership after adoption; total source budget/accounting across all resumes;
workflow handoff finalization; subsequent setup pauses and approval continuation;
completed-write replay protection and installed desktop/mobile handoff tests.
The executor deliberately holds if the current recovery blob is absent rather
than reinstalling the original pause. Its held wake/recovery path still needs
the boot/admission work above. Do not enable the UI on this checkpoint alone.

UI implementation remains paired with these transitions: connect next to the
request, show the verified account, resume the same task, and show a concrete
stopped/changed-account reason when it cannot continue. No opaque channel IDs,
duplicate approvals or endless “Thinking” state should substitute for that
state. Projects, agents, useful background progress and proactive check-ins
remain the next paired slices from the roadmap above.

Fixture traps: Space `initialData` is create-only, so parameterized cases need
distinct slugs; keep those slugs inside the existing 63-character limit. Do
not weaken the production creation or slug rules to accommodate test reuse.

## Desktop bridge and mobile gateway admission — September 30

Verified: desktop admission and the mobile gateway now recognize the retained
reviewed execution before fresh Execute claim handling. They activate its
server-owned control and pass the acquired lease owner through the bridge to
the retained executor. The owner is internal transport state, never browser
input. Ordinary chat and Plan setup retain their existing admission paths.
The bridge uses the original task mode, model and host engine even when a caller
supplies a different current model. It retains the one original plan claim and
attributes work to that source while delivering through the new control.

An unfinished accepted connection control is not reclaimed by an HTTP retry.
Mobile acknowledges the existing source as in progress; exact completed replay
returns its terminal without runtime configuration or another model call. The
bridge checks ownership before preparation and again after asynchronous runtime
configuration. Checkpoint recovery remains responsible for ownership adoption.

Evidence:

- **179/179** checks across six ingress/bridge files passed, including ordinary
  gateway behavior, surface parity, connection routes and desktop idempotency:
  `/tmp/clem-connection-ingress-regression.txt`.
- **9/9** recording integration cases passed in
  `/tmp/clem-connection-route-final.txt`. Cases cover direct desktop/mobile
  bridges, the outer configured bridges, actual mobile gateway activation and
  completion, exact replay after reopening, and Stop/account change before
  dispatch. The gateway case also retries while its model frame is pending:
  the retry retains the same source and attempt, publishes no terminal and
  dispatches no second model. Each completed case preserves one plan claim and
  one physical completed board read. These nine include prior executor cases;
  they are not nine wholly new behaviors.
- Final runtime TypeScript and `git diff --check` passed. TypeScript output:
  `/tmp/clem-connection-route-final-tsc.txt`.

Not performed: fresh paid model/provider calls, live business actions, browser
Execute admission, desktop/mobile visual acceptance, build, installation,
hotpatch, merge or tag. The preceding runner's live-home sentinel was
**NOT PERFORMED** because daemon 72427 owns those stores; isolated checks are not
installed-app acceptance. No speed or token savings are claimed. The other
agent's clean `claude/two-modes` checkout remains at `76c53a1ea` when rechecked.

Still owed: fresh same-root callable/account attestation, held-lease renewal and
boot adoption, total outer-budget accounting, workflow finalization, subsequent
setup/approval pauses and completed-write/device-handoff acceptance. The
`EXECUTION_CONTINUATION_BLOCKER` remains active, so the actual HTTP/UI path does
not yet advertise reviewed Execute Continue as ready. Enabling that path and
qualifying it in the installed app is a separate remaining step.

The UI state contract above is paired with this work. Broader projects/agents,
inbound event health and purposeful proactive check-ins remain planned slices;
this routing change does not claim to ship them.

## Fresh callable preparation and original-task delivery evidence — September 30

Verified: production retained-agent preparation now verifies the exact missing
Composio operation against the reviewed binding and the account selected by the
server's setup receipt. It uses the existing forced account snapshot and exact
definition refresh. A cached callable registration or successful sign-in alone
does not satisfy the dependency. It checks the current callable identity again
after those awaits and rechecks execution ownership throughout preparation.
Only then does one atomic dependency update record a connection-satisfied event.
The event is evidence of preparation, not an approval or business-effect receipt.

The operation must belong to the retained reviewed plan. A different connected
account, changed input/output contract, changed definition/version, unavailable
account, lost owner or revoked callable cannot silently replace it. Revalidation
adds no model discovery frame and executes no business operation. Subsequent
calls still pass the ordinary dispatch, account, effect and consent boundaries.

The stronger integration test uncovered a second framework defect. Completion
assessment used the new delivery control's empty work history, while terminal
closure correctly required the original task's completed contract. A local-only
completion fixture had masked that by preparing all original evidence before
the pause. Delivery assessment now uses the same validated original source as
closure and review. Partial-effect copy, retained results, evidence references,
pending-read checks and external-uncertainty reporting follow that source too;
the new control still owns the public terminal. A resumed approval with an
unresolved original write retains its reconciliation warning.

Evidence:

- **17/17** connection integration cases passed:
  `/tmp/clem-connection-callable-accepted.txt`. The successful cases now have a
  genuinely pending provider read in the immutable reviewed plan. They execute
  the native board read once, pause, prepare the exact account/tool, execute the
  pending CRM read once through the actual attested carrier with a recording
  provider, and publish/reopen/replay without repeating either read. Exactly
  five recording frames are used: three before setup and two after (the pending
  read and final answer). There is no added discovery frame. This is a stronger
  workload than the previous four-frame local-only fixture, not a latency A/B.
- The cases also cover inactive account, changed schema, selected-account
  mismatch, account/Stop/callable changes during refresh, operation outside the
  reviewed plan, provider version relabel, and final account/Stop invalidation
  before model dispatch. Preparation refusals leave the dependency open, with
  no resumed model frame, no provider business call and no satisfied receipt.
- **207/207** across eight regression files passed in
  `/tmp/clem-connection-callable-regression.txt`: delivery, effect truth, partial
  work, terminal states, retained-work projection, accepted batches/checkpoints,
  connection setup and selected provider-definition revalidation.
- `/tmp/clem-connection-callable-final.txt` passed **21/21** before adding the
  final two account/version cases: 15 connection cases plus six effect-truth
  cases, including the new resumed-approval pin. Five effect-truth cases overlap
  the 207 count; do not add these logs as independent coverage totals.
- Red evidence: `/tmp/clem-connection-callable-integration-2.txt` captures the
  unprepared original-task closure failure. Temporarily removing only the new
  callable check made the inactive-account and schema-change pins fail with
  “Missing expected rejection” in `/tmp/clem-connection-callable-red.txt`.
  Candidate source was restored immediately afterward.
- Final runtime TypeScript and `git diff --check` passed. TypeScript output:
  `/tmp/clem-connection-callable-final-tsc.txt`.

Not performed: live provider/model requests, live-home acceptance, browser or
physical-phone interaction, build, hotpatch, merge or tag. The isolated runner's
live-home sentinel remains **NOT PERFORMED** while daemon 72427 owns those
stores. Test homes and provider/model recordings are isolated; no business
account or real credential is used. No measured speed or token saving is
claimed. Other-agent `claude/two-modes` remains clean at `76c53a1ea` when checked.

Still owed before exposing reviewed Execute Continue: typed transient-connection
refusal/retry and changed-plan guidance at the public route (the internal
preparation currently refuses by throwing); held-lease renewal and boot
adoption; full-source outer budgets; workflow finalization; subsequent setup
and approval pauses; completed-write/no-replay and cross-device acceptance.
In particular, a temporary metadata failure must not be turned into a generic
failed terminal that closes the original task and prevents its safe retry.
Keep `EXECUTION_CONTINUATION_BLOCKER` active until those lifecycle paths are
implemented and the combined installed app/live-home candidate is qualified.

The UI must show which requirement remains, keep the task and completed work
visible, and offer the correct connection retry or reviewed-plan change. It
must not promise completion just because this new metadata check succeeded.

### Connection verification waits retain execution — 2026-09-30

Verified in this increment: a recognized provider metadata refusal no longer
escapes retained-agent preparation as a generic failed terminal. The executor
returns a typed, nonterminal connection wait while retaining the same source,
plan claim, run attempt, recovery cursor and completed work. The bridge keeps
that attempt active and returns the appropriate explanation. Unexpected
exceptions still follow the existing failure path; exception prose is never
used to infer that a retry is safe.

The new state is `hold.wake = connection`, `reason = connection_preparation`,
with the exact connection request, refusal code and `nextAction`. Provider
refusal codes explicitly map to `retry`, `reconnect` or `review_plan`.
Definition/schema/account changes cannot silently widen the reviewed task.
Ownership is rechecked before recording a wait, so Stop, account receipt drift,
lease loss or a newer request cannot be disguised as this recoverable state.

Preparation state is recorded under the existing recovery-decision event and
bound to the validated activation. Identical failures create one state receipt;
a later successful preparation clears it. These records are diagnostic/UI
state, never execution authority, new plan claims or completed-effect receipts.
An explicit retry still needs the current execution lease and performs fresh
provider checks. It never reinstalls the original pause over a newer cursor.

Recovery timers stop polling on this typed wait. Boot and periodic scans retain
the exact checkpoint without provider/model calls or repeated interruption
notices. Stop on the original execution also outranks the connection wait.
Queue ordering keeps waiting connections behind runnable recovery work, and
keeps Stop reachable. Ordering is only a hint: the scanner still proves the
actual ownership and Stop target before acting. Without that ordering fix,
more than one page of waiting connections could starve previously attempted
work. The new queue pin reproduced that failure when only the ranking change
was temporarily removed; the candidate was restored afterward.

Verification:

- The new desktop/home and mobile/webhook bridge fixtures first fail provider
  schema refresh, reopen the database, retry the same failure, restore the
  provider and finish the same task. There remains one plan claim, one prior
  local read and one subsequently executed provider read; five recording model
  frames total, with zero frames or business calls spent on failed preparation.
  These enter the internal bridge, **not the disabled public Execute button**.
- The Stop fixture proves that a restored connection cannot restart an
  explicitly stopped original task, including during boot recovery. Existing
  account, definition, schema, callable-revocation and pre-model invalidation
  cases remain covered. A drift refusal requests plan review, not blind retry.
- **136/136** bridge/setup/connection checks passed before the recovery-scan
  refinement: `/tmp/clem-connection-retry-regression.txt`.
- **38/38** final connection and restart checks passed, including all twenty
  connection cases and the queue test with 65 waiting tasks:
  `/tmp/clem-connection-retry-recovery-final.txt`. Coverage overlaps the prior
  run; these are not additive independent test totals.
- Red evidence: `/tmp/clem-connection-retry-red.txt` shows the bridge returning
  `error` instead of retaining the task after metadata failure.
  `/tmp/clem-connection-retry-queue-red.txt` shows the bounded queue selecting a
  waiting task ahead of runnable work without the ranking fix.
- **31/31** neighboring recovery checks passed after restoring the queue
  fix: `/tmp/clem-connection-retry-queue-final.txt` (restart, stale-marker and
  host checkpoint wake files). Eighteen restart checks overlap the prior run.
- Runtime TypeScript passed in `/tmp/clem-connection-retry-tsc-final.txt`;
  `git diff --check` passed.

Not performed: public browser/phone interaction, paid-model or live-provider
requests, installed-app/live-home acceptance, build, hotpatch, merge or tag.
The test runner's live-home sentinel was NOT PERFORMED while daemon 72427 owned
the changing live stores. No token/latency improvement is claimed from these
recording fixtures. The other agent's clean `claude/two-modes` worktree was
rechecked at `76c53a1ea` and left untouched.

UI work to pair with this state:

| State | Presentation and action |
| --- | --- |
| Temporary metadata failure | Keep one task card with saved progress and the readable account; offer Retry when the owned retry endpoint exists |
| Inactive, missing or suppressed reviewed connection | Explain which account needs attention and link to its connection controls; never silently enable or replace it |
| Reviewed operation changed | Show what changed and offer plan review; do not relabel it as a sign-in problem |
| Verification passed after a wait | Replace the pause state with genuine execution progress in the same task view |
| Stop | Preserve completed-effect receipts and show Stopped; reconnecting cannot restart the work |

The response remains nonterminal for transport compatibility; the UI must use
the typed wait to show a pause instead of an endless Thinking spinner. Reload
must reconstruct that state from the same validated activation and state
receipt. Do not infer readiness from the mere presence of a connection badge.
Neither the public retry endpoint nor that visual projection is enabled by
this increment.

Still owed: held-lease renewal and exact boot adoption; explicit public retry
admission after a lease expires; cold-rebuild refusals outside the classified
provider-check path; full-source outer budgets; workflow finalization;
subsequent setup/approval pauses; completed-write/no-replay and actual
desktop/mobile acceptance. Keep `EXECUTION_CONTINUATION_BLOCKER` active. Merge
with the other agent's settings/Auto/Ask/UI work and reconcile migration 83
before building a combined candidate for installed-app qualification.

### Recover retained execution under fenced leases — 2026-09-30

Verified in this increment: the trusted daemon restart dispatcher can acquire
an expired or boot-interrupted reviewed connection execution, retain its exact
current checkpoint and original model, and finish through the existing bridge.
Acquisition creates a new physical run attempt, not a new user request, plan
claim or copy of the work. The attempt, checkpoint and continuation owner move
atomically. A storage refusal rolls back the entire acquisition.

A live lease cannot be stolen. A missing current checkpoint, Stop, changed
account binding, newer user input or terminal task cannot become permission to
restart the original setup pause. Renewal first re-proves a live owner; it
cannot revive an expired, interrupted or finished attempt. While execution is
awaiting the model, the owning driver renews its lease every 30 seconds, with a
90-second lease horizon. Renewal stops when that driver returns. Dispatch and
result acceptance still check ownership separately from the timer.

Two additional defects surfaced under stronger scenarios:

- The previous SQL queue-ordering fix was insufficient by itself. The
  in-memory dispatcher sorted deliberate connection waits back into its scarce
  execution slots. It now keeps those waits visible in the recovery report
  while selecting runnable work for dispatch. Original-task Stop still wins.
- A lease could expire while a model answer was pending. The existing tool
  boundary prevented the provider action, but the stale answer had already
  become an accepted call and left a stuck finalize checkpoint. Ownership is
  now checked immediately after the model returns, before accepting or
  journaling that frame. The old executor returns a nonterminal ownership-loss
  result; it cannot fail the successor's task or dispatch the late tool call.

The restart dispatcher uses an internal server-owned lease identity. Browser
or model request bodies cannot supply it. Connection preparation waits are not
automatically retried by recovery; explicit retry still requires its separate
admission path. Ordinary chat continues through its existing dispatcher.

Verification:

- **497/497** checks passed across the connection execution integration,
  response bridge, restart recovery, stale-marker recovery, host checkpoint
  wake and host turn runner files. Output:
  `/tmp/clem-connection-lease-final.txt`. This is 497 tests including nested
  cases, not 497 end-to-end user journeys. There are now **31** connection
  execution scenarios.
- The successful boot-dispatch scenario enters the actual recovery scanner
  and `respondPreferHarness`, acquires a new physical attempt, uses the
  retained model and completes the original plan with five recording frames,
  one original local read and one pending provider read. No discovery frame,
  extra plan claim or repeated read is added.
- Refusal cases cover live-owner contention, expired-owner renewal, Stop,
  account drift, newer user input, missing current checkpoint and transactional
  owner-storage failure. A second contender cannot take the newly acquired
  lease. A successor can finish after the previous executor loses ownership
  during asynchronous provider verification.
- Timer tests advance 120 seconds while a model is pending and prove the same
  live attempt is renewed. Another 120 seconds after completion cannot revive
  the terminal attempt.
- The late-model test returns an already-requested fourth recording frame
  after lease expiry. There is no provider business call, additional model
  request, new terminal or accepted-call checkpoint. Prior completed local
  work remains unchanged. It does **not** prove subsequent recovery when the
  current full checkpoint is absent.
- Queue red/green evidence:
  `/tmp/clem-connection-selection-red.txt` and
  `/tmp/clem-connection-selection-green.txt`. Late-model red/green evidence:
  `/tmp/clem-connection-lease-late-model.txt` and
  `/tmp/clem-connection-lease-late-model-fixed.txt`.
- Earlier focused and 159-check runs overlap the final 497-check run; do not
  sum them as independent coverage. Final runtime TypeScript produced no
  diagnostics in `/tmp/clem-connection-lease-tsc-final.txt`; `git diff --check`
  passed.

Not performed: paid model or live provider requests, installed-app/live-home
acceptance, public desktop/mobile interaction, build, hotpatch, merge or tag.
The isolated test runner reports its live-home sentinel **NOT PERFORMED**:
daemon 72427 was active and changed `secretsMeta` during the final run. The
recording fixtures use their own homes; the sentinel does not establish
live-home isolation or acceptance. No measured latency or token reduction is
claimed. The other agent's `claude/two-modes` worktree remains clean at
`76c53a1ea`; its files and installed app were left untouched.

Still owed before removing `EXECUTION_CONTINUATION_BLOCKER`:

- Recover a current full checkpoint from canonical progress after the prior
  checkpoint has been consumed. Until then the scanner preserves that task
  instead of replaying the setup control or restoring an older pause. Retain
  spent counters, history and effect receipts during that promotion.
- Enforce full-source outer time, token and step budgets through reacquisition;
  handle cold preparation refusals outside the classified provider-check path.
- Wire explicit public Retry admission and reloadable desktop/mobile pause
  projection; prove later connection/approval pauses, workflow finalization,
  Stop, device handoff and completed-write no-replay at those routes.
- Integrate the other agent's Auto/Ask/settings/UI changes, reconcile migration
  83, and qualify one fresh combined build on the installed app/live home.

The UI should keep one retained task visible throughout these ownership
changes. It should show Running only when execution is owned, Waiting for a
connection with the exact readable account and appropriate action, or
Recovering when a new executor is being acquired. An ownership-loss response
must not produce a second task card or an endless Thinking spinner. The missing
checkpoint case must remain an honest recoverable interruption, not promise an
automatic resume that has not been implemented. These are UI requirements;
this increment does not claim they are rendered yet.

### Current progress survives checkpoint adoption — 2026-09-30

The missing-blob recovery path now has an implementation. A running reviewed
connection continuation retains a private progress record at checkpoint
adoption, model-request boundaries, accepted batch admission, tool charging and
result commit. It contains consumed host allowances, continuation/review state
and a six-field batch reference. It contains neither conversation history nor
tool-result bodies, and it is not added to any model prompt. The accepted batch
journal remains the only history/result authority. The record occupies one
replaceable session metadata field, not a growing list of prompt copies.

Checkpoint adoption and its initial progress record commit together. New batch
admission and the corresponding progress reference also commit together for
these retained executions. Tool charging is retained before invocation. A
requested model step is retained before awaiting its answer, so losing that
answer does not grant a free replacement step after recovery. Ordinary fresh
chat does not acquire these extra progress transactions.

After interruption, the scanner and trusted lease-acquisition path can reopen
the latest ready canonical batch and reconstruct a normal host checkpoint from
that progress. They require the same activation, delivery/execution sources,
attempt, current account binding and exact batch identity. They refuse a live
executor, Stop, a newer owner, a terminal task, corrupt progress, a stale batch
reference, missing evidence or a batch requiring reconciliation. Promotion is
bookkeeping; the separate atomic lease acquisition still owns execution.

The new recording scenarios enter the real recovery scanner and ordinary
bridge. They interrupt execution immediately after adoption, while a model
response is pending, just after the provider returns, and on the final-answer
request after the provider read is committed. Recovery finishes the same plan
without repeating the original local read or the completed provider read. A
lost response adds one actual recording model request, correctly charged to
the retained step allowance. At an exhausted allowance, recovery stops without
making another model request. Separate corrupt, stale and stopped scenarios
refuse acquisition without publishing another attempt or terminal.

Evidence and limits:

- The initial unchanged 31 connection scenarios passed with the new runtime:
  `/tmp/clem-connection-progress-initial.txt`.
- Six new progress scenarios passed in
  `/tmp/clem-connection-progress-focused-2.txt`; the two additional adoption and
  provider-return boundaries passed in
  `/tmp/clem-connection-progress-boundaries.txt`. An earlier focused run found
  two old fixture assertions still expecting five calls after a deliberately
  lost response; the shared replay/reap assertions now expect the actual six.
- Removing only canonical promotion reproduced both the model-pending and
  provider-return recovery failures in `/tmp/clem-connection-progress-red.txt`.
  The candidate implementation was restored immediately afterward.
- Runtime TypeScript passed in `/tmp/clem-connection-progress-tsc-final.txt`.
  The combined targeted regression passed **505/505** checks across six files,
  including **39** connection execution scenarios:
  `/tmp/clem-connection-progress-regression.txt`. This includes nested tests,
  not 505 end-to-end journeys. Earlier logs overlap that run and must not be
  added together. `git diff --check` passed.
- **10/10** source-connection checkpoint and recovery-activation compatibility
  checks passed in `/tmp/clem-connection-progress-checkpoint-compat.txt`,
  including ordinary ASK/decision capture and recovery guard isolation.

Still not done: installed-app/live-home acceptance, public desktop/mobile
Retry and state projection, full-source outer elapsed-time/token budgets,
workflow finalization, later connection/approval cycles and physical-write
no-replay/device-handoff qualification. The new fixtures exercise real
framework/provider-carrier code with recorded **reads**, not external writes
or a physical process kill. Elapsed time is preserved as of each durable
boundary; a lost in-flight interval and the outer task budget still need their
own accounting. Partial or uncertain batches remain held; this implementation
does not convert uncertainty into permission to replay a tool.

No paid model or provider, credential/configuration change, build, hotpatch,
merge or tag was performed. `EXECUTION_CONTINUATION_BLOCKER` remains active.
The final isolated runner's live-home sentinel was **NOT PERFORMED** while
daemon 72427 changed the memory stores and `secretsMeta`; this is not installed
acceptance or proof of live-home isolation. The other agent's clean
`claude/two-modes` worktree was rechecked and left untouched.
The paired UI still needs to project this as one Recovering task and then the
same task's real progress, retaining visible completed-effect receipts. It
must not show a fresh chat request or require the user to repeat the objective.

### Exact request spend and real worker lineage — 2026-09-30

Verified in source: the normal model-usage writer now also accumulates reported
usage by the exact accepted session/source tuple and role. Migration **84** adds
`accepted_source_usage_v1`; a row is admitted only when that tuple names a real
user-input event. A physical retry, reopened database or different chat turn
does not reset or borrow its total. A child with its own accepted source keeps
that source; rowless learning can use its explicit accounting parent. This
does not transfer execution permission to a child or learning job.

The projection holds counts and numeric usage only, one row per source/role.
It does not add prompt text or scan daily files on every turn. Cached tokens,
conservative uncached work, provider-reported totals, failed calls and
uncertified usage remain distinct. A failed zero-usage placeholder is counted
as unknown cost, not certified free work. A failed call that actually reports
cached work is not mislabeled as missing usage. The sum of provider durations
is named `modelMs`; it is **not** task wall time, especially under fan-out.

This is a reported-usage projection, not a billing guarantee or a complete
budget implementation. Its failure cannot turn a model response or completed
tool effect into an execution failure. Zero stored calls do not prove zero
spend. Earlier accepted sources are labeled as predating this meter; old usage
was not backfilled. Provider billing and the existing NDJSON records remain
independent evidence. Capturing the original budget policy, reserving uncertain
in-flight spend and enforcing a full-source budget still need implementation.

The read-only whole-task report had three concrete gaps:

1. The actual worker runner writes `parentSourceUserSeq`; the report recognized
   only `sourceUserSeq`. It now accepts the real lineage and the compatible
   legacy shape, rejecting contradictory parent tuples.
2. Only direct helpers were counted. The report now follows nested helper
   links, including helpers beneath a delegated task, with exact child sources
   and a visited set. Duplicate links/cycles do not duplicate usage. A missing
   child source is reported as unknown instead of claiming a whole reused chat
   session. An exact usage trace wins over a conflicting legacy source string.
3. A waiting reply could end date scanning, and the scan silently stopped after
   40 days. It now scans through the stated `usageObservedThrough` time, with
   exact source/lineage joins excluding other turns. The fixture reconnects the
   original request 60 days later and counts both calls. This offline report
   can read more daily files for old tasks; it is not used as a per-frame
   budget query. Arbitrarily nested background-task delegation is not newly
   qualified by these helper tests.

Evidence:

- Before the report fix, all five new lineage/late-usage regressions failed,
  while the three existing report checks passed:
  `/tmp/clem-whole-task-lineage-red.txt`.
- The initial usage-meter run found one incorrect fixture expectation: both an
  undeclared cache dialect **and** a failed zero placeholder are uncertified.
  The assertion was corrected to match the existing canonical accounting; the
  accounting policy was not weakened. `/tmp/clem-source-usage-initial.txt`.
- The final targeted run passed **93/93** checks in six files, including all
  **39** connection execution recording scenarios, usage writer/observer
  compatibility, source/role attribution, migration replay and schema readiness:
  `/tmp/clem-source-usage-regression.txt`. The earlier 49-check green run overlaps
  this result and is not an additional acceptance suite.
- Runtime TypeScript passed: `/tmp/clem-source-usage-tsc-final.txt`.
  `git diff --check` passed.
- The isolated runner's live-home sentinel was **NOT PERFORMED** while daemon
  72427 wrote memory WAL/SHM and `secretsMeta`. These are recording-test results,
  not installed-app/live-home acceptance or proof of live-home isolation.

Not performed: paid generations, real provider calls, credentials/settings
changes, live-home resets, build, install/hotpatch, merge or tag. No latency or
token-savings claim follows from correcting accounting. The other agent's clean
`claude/two-modes` worktree remains at `76c53a1ea` and was not changed. Reconcile
migrations **83 and 84** against the eventual combined candidate, then rebuild.

Paired desktop/mobile UI requirements, still owed for reviewed execution:

| Runtime evidence | What the user should see |
| --- | --- |
| Exact app dependency | One task-local connection card explaining the needed capability, with a readable account when supplied by the provider |
| Sign-in opened | The same saved task, a return/check action, and no second chat request |
| Account verified, execution still held | “Connected” and an honest paused reason; no implication that work already resumed |
| Current execution lease being reacquired | One Recovering state, retained completed receipts and a usable Stop action |
| Recovery ownership acquired | The original task's progress and plan, without repeating completed work |
| Explicit budget reached | Recorded spend and the actual limit; an explicit owner action where supported, never a fresh automatic allowance |
| Missing/uncertified usage | “Usage incomplete” detail rather than a fabricated savings percentage or zero-cost claim |

The existing React and Preact connection components were inspected; they
already have inline sign-in and readable verified-account handling. This
increment does **not** claim to have rendered the recovery/budget states above.
Use a compact summary with expandable details, retain it across reload/device
handoff, and derive it from durable server state. Do not add another permanent
dashboard or make users understand receipts/leases to finish setup.

Next implementation remains: freeze the original outer time/token policy and
account active work across retries without charging time waiting for sign-in;
then expose an owned Retry/Continue route and its reloadable UI projection.
`EXECUTION_CONTINUATION_BLOCKER` remains active. Subsequent approval/connection
cycles, workflow finalization, physical-write no-replay, device handoff and
controlled installed-app/live-home acceptance are still owed before release.

### Original outer policy and preparation time — 2026-09-30

The next slice records the original host request's outer policy before
capability preparation: configured active-time ceiling, configured uncached
token ceiling, and the existing token-enforcement setting. It uses one
`accepted_source_budget` event bound to the exact accepted user event. It does
not change defaults, add a cap, or create a rollout flag. Explicit zero remains
unlimited. Re-entering the same source reopens its existing policy even when
the caller or environment now supplies different values. A new user source
gets its own policy.

Connection progress carries only the policy event id and digest. The ordinary
host parser checks that reference's shape; execution reopens and validates the
original source, parent event, system role, policy values and digest before
agent reconstruction or host work. Reconnect controls do not create a new
policy event. Duplicate/conflicting records are refused, not resolved by
choosing the latest setting. A historical source that already has turn-start
evidence but no retained policy stays unknown. Its original settings are not
inferred from today's defaults. No new database migration is needed for this
event; migration 84 from the preceding increment remains the latest here.

Active-time snapshots now receive the activation origin from before host
preparation. This includes fresh conversation preparation and successful
connection re-attestation, instead of starting the clock only after those
awaits have finished. A second checkpoint-only hop starts its next interval
after the first call returns; it must not double-charge the first interval.
The existing retained elapsed total remains the base. This is still boundary
accounting, **not** an exact clock across a process death: an in-flight gap or
preparation that throws before a snapshot is retained is not yet accounted.

Verified:

- The ordinary `runConversation` connection-pause fixture asserts that its
  explicit policy exists **before** agent construction and is retained in the
  actual ASK/decision checkpoint.
- All 39 execution-closure scenarios capture the original policy, including
  desktop/mobile bridges and lease/checkpoint recovery. Successful replay and
  database reopen retain the same event, and contradictory continuation
  options do not overwrite it. Progress recovery carries the same reference.
  The fixture also proves pre-host preparation time enters the snapshot.
- Six policy checks cover reopen, changed options, unlimited, the existing
  enforcement setting, independent new sources, tuple/reference mismatch,
  historical uncertainty, invalid time values and ambiguous policy records.
- `/tmp/clem-source-budget-regression.txt`: **65/65** checks across five files,
  including all 39 execution scenarios, source/approval checkpoint
  compatibility and original agent/project context.
- `/tmp/clem-source-budget-host-compat.txt`: **345/345** checks across three
  files, including nested host-runner checks and the strengthened ordinary
  entry-point assertions. This overlaps the 65-check run; do not add the
  totals together. Runtime TypeScript passed in
  `/tmp/clem-source-budget-policy-tsc-final-2.txt`.
- Removing only the retained budget reference from the host snapshot made the
  actual publication scenario fail with “the connection pause must retain its
  original outer policy”: `/tmp/clem-source-budget-reference-red.txt`. The
  original candidate bytes were restored in `finally`; the mutation was not
  retained. `git diff --check` passed on the restored candidate.

One implementation error was caught and corrected locally: the new timing
value was initially referenced inside `runTurnWithSessionContext` without
being passed through the outer `runTurn` wrapper. TypeScript and the first
recording run both exposed it. That obsolete run was terminated; its partial
results are in `/tmp/clem-source-budget-initial.txt`. The timing value now
travels through the internal options object, and the later checks above ran
the correction.

Still owed, in order: enforce the frozen outer policy at safe host boundaries;
include exact descendant/auxiliary spend and represent unreported in-flight
usage honestly; retain active-time intervals across interruption/preparation
failure; then wire the owned Retry/Continue action and durable desktop/mobile
state projection. Policy capture alone is not budget enforcement or a new
allowance. The recorded fixture ceilings in this slice test **continuity**,
not limit-stop behavior. The public `EXECUTION_CONTINUATION_BLOCKER` remains.

The UI should show the original task's limit only when configured and disclose
incomplete usage/time evidence in expanded details. A setup card must not
claim “resumed,” a reset budget or a fresh task while only the connection was
verified. This slice does not edit or claim to render that UI.

No paid model/provider, credentials/settings mutation, build, hotpatch, merge
or tag. The isolated live-home sentinel was **NOT PERFORMED** while daemon
72427 wrote its normal stores; these pins do not replace installed acceptance.
The other agent remains clean at `76c53a1ea` on `claude/two-modes`.

### Observed budget checks at the host model boundary — 2026-09-30

This increment applies the retained policy from `203c9f887` before the host
dispatches another brain/writer request. It does **not** finish full-task
budget enforcement or qualify public Execute Continue. The
`EXECUTION_CONTINUATION_BLOCKER` remains active; no installed app changed.

Implemented:

- The host checks the original source's active-time limit using retained
  elapsed time plus the current activation, including captured preparation.
  Waiting for sign-in does not create a new allowance or consume active time.
- Recorded uncached work is summed for the original exact accepted source and
  nested host workers. Worker links require both the parent's exact tuple and
  the child's matching accepted parent event/delegation. Duplicate worker
  announcements count once. Another source in the same chat or worker session
  cannot spend this request's allowance. All recorded roles count.
- A reached configured limit stops the next host model request before
  dispatch/provenance publication. A returned tool result still gets its
  settlement. The stop preserves retained work and does not buy a model call
  to explain the stop. A writer cannot hide the typed stop in its fallback.
- Finite token policies hold when the available record explicitly reports an
  unknown failed-call cost, a pre-meter baseline, an invalid child link or an
  unavailable meter. Unlimited/disabled token settings do not read this meter.
  Current caller settings still cannot replace the captured policy.
- `usageEfficiencyForTurn` no longer accepts a turn number from a different
  session. Exact accepted-source trace identity wins over legacy source text;
  a legacy turn-only marker also needs the matching session. The new recording
  fixtures exposed this separate reporting bug: their reused database sequence
  numbers polluted diagnostic frame counts across sessions. This fix changes
  attribution, not historical usage rows, provider billing or model behavior.

Verification, with recording models and provider fixtures only:

- `/tmp/clem-source-budget-boundary-final-2.txt`: **70/70** across policy,
  indexed usage, boundary, ordinary source checkpoint and connection execution
  tests. The execution file now has **46** scenarios, including seven new
  budget cases: spent before resume, spent after a landed read, active time
  spent after a read, unknown failed-call cost, child spend before resume,
  seven days waiting for connection, and unrelated-turn spend.
- `/tmp/clem-source-budget-boundary-host-compat.txt`: **337/337** existing host
  checks, including approval/recovery/writer behavior. This ran the budget
  boundary before the separate reporting-only predicate correction.
- `/tmp/clem-source-budget-boundary-usage-final.txt`: **45/45** reporting,
  writer/observer and whole-task report checks, including both new exact-source
  efficiency cases.
- `/tmp/clem-source-budget-boundary-replay-final.txt`: **7/7** budget scenarios
  after strengthening the replay assertion: reopening a stopped control still
  reports `blocked`, with no model/tool replay or false completion. These
  overlap the 70-check run and must not be added as independent coverage.
- Runtime TypeScript passed in
  `/tmp/clem-source-budget-boundary-tsc-final-2.txt`.
- Removing only the new host budget assertion made all five stop scenarios
  fail: each incorrectly completed instead of stopping. Evidence:
  `/tmp/clem-source-budget-boundary-red.txt`. Restoring the former efficiency
  predicate made both new reporting checks fail (two frames instead of one,
  and six instead of three): `/tmp/clem-source-budget-efficiency-red.txt`.
  Both mutations restored the exact original bytes in `finally`.

Fixture traps caught and corrected: replaying migration 83 had also reset
the already-installed meter's timestamp, incorrectly classifying the source
as pre-meter. The rehearsal now preserves the real original timestamp; the
production unknown-baseline check was not weakened. The week-long wait fixture
also collided with an existing temporary historical clock for receipt expiry;
it now restores the intended clock around that receipt. The renewal scenario
uses an explicit 180-second policy for its simulated 120-second active request,
instead of testing successful execution against a contradictory 42-second cap.
An obsolete combined check was terminated after discovering an incorrect
usage-directory import in a new test; the test now uses `BASE_DIR/state/token-usage`.
The final evidence above supersedes those partial/failed runs.

Limits of this increment (do not describe it as a strict total-spend ceiling):

1. Only recorded costs and observed elapsed time are known. A zero-row meter
   does not certify zero spend. There is no durable reservation/settlement
   ledger for every in-flight provider request; a lost request may still cost
   money without a usage row. Aggregated unknown-cost counts cannot yet be
   reconciled against a later report of that same physical call.
2. The check gates the host's next brain/writer dispatch. It does not stop all
   parallel worker/auxiliary dispatches against a shared root allowance, cap
   the current request's unknown output cost, or aggregate the separate
   background-task delegation lifecycle. A running batch can overshoot before
   the next checked boundary. Known host-worker descendants are included when
   their parent checks again.
3. Crash gaps, preparation failures before a snapshot, and historical sources
   with no captured policy still need their own durable evidence. No defaults
   were invented for those sources. A late writer/reviewer or memory job is
   not made fully accounted merely by having a role in the recorded meter.
4. A configured-budget stop still needs a qualified owner action for changing
   the original allowance or resolving uncertain usage. Repeated connection
   controls must not silently start a new task or offer a futile automatic
   retry. UI work must use the typed cause and saved task state, rather than
   turning a budget hold back into a misleading connection card.

Next: durable in-flight usage and interrupted active intervals; shared root
budget admission for descendant/auxiliary requests; then owned Retry/Continue
and reloadable desktop/mobile state. Show one saved task, verified account,
retained results, and a precise next action. Keep incomplete usage in details,
and distinguish waiting for sign-in, resuming, running, and a configured-limit
stop. Actual physical-write recovery, device handoff, subsequent approvals,
workflow completion and installed-app/live-home acceptance remain owed.

No paid model/provider call, credentials/settings mutation, build, hotpatch,
merge or tag. The isolated sentinel was **NOT PERFORMED** because live daemon
72427 owned the home and wrote normal stores. No performance or live acceptance
claim follows from these fixture times. The other agent was rechecked clean
at `76c53a1ea`; their files were not changed.
