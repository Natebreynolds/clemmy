# Contextual connection setup, desktop and mobile — 2026-09-29

## Outcome and source ownership

This is the first implementation slice of the owner's request to make setup feel native and let Clem carry a task through missing capabilities. UI and harness work belong together: a connection form without durable continuation would merely move the manual setup problem into chat.

Base: `4e2efe15bc348549e195e6660a305c011bff8cf1`. Implementation branch: `codex/contextual-connection-ui`; worktree: `/Users/nathan.reynolds/.codex/worktrees/connection-continuity/clementine-next`. The other agent's shell lane was last checked at `c76c4561a`, branch `claude/shell-anywhere`; it was not modified. Main and the owner's uncommitted documents were not changed.

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

| Harness work | Corresponding user experience | Acceptance evidence |
| --- | --- | --- |
| Event delivery, durable cursors, deduplication, retry, reconciliation | A compact connection detail showing last event, last successful sync, recovery action, and the task a result belongs to | Duplicate/out-of-order callback and reconnect do not duplicate work; stale/offline is visible |
| Provisioning with scoped cost/effect authority | A review card naming the requested resource, account, recurring cost, and exact action; one clear place to respond | No unexplained identifier-only approval or duplicate setup/send approval |
| Projects and agent delegation | Project view with objective, assigned agent, live work, waiting-on-you item, and direct return to the task conversation | User can open/steer/resume the exact child without creating a second owner |
| Proactive goals and memory maintenance | Purposeful check-ins that state why now, what changed, and the suggested next step | Suggestions cite durable evidence, respect dismissal, and do not pretend unperformed work is complete |
| Long tasks and learning | Concise progress and completion receipts with expandable evidence, account/model identity, and cost | Full task continuity and total-token accounting survive compaction and device handoff |

Keep each UI slice attached to a real state transition and its recovery path. Avoid another collection of status cards that cannot explain or control the underlying task.
