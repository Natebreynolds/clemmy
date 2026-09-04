# Pre-tag last-25-hour harness audit

Date: 2026-09-03, 22:44 PDT

Purpose: give the next agent enough evidence, architecture direction, and
executable acceptance criteria to make the final global fixes, start the exact
candidate, let Nathan test it, and decide whether it is safe to tag.

This is a read-only audit of the current repository, the last 25 hours of
harness data, daemon logs, workflow records, and the memory database. The only
file created by this audit is this document.

---

## 1. Executive decision

**Do not tag the current tree yet.**

This is not another Slack bug, Sheets bug, Salesforce bug, or one-off workflow
bug. The graph/control framework has become a second driver. It repeatedly
requires Clem to reproduce private graph grammar before she may do useful work,
then stops her on representation, admission, settlement, checkpoint, or
completion seams that she cannot repair.

The Northstar is simpler:

> Clem owns the objective and chooses the next useful action. The host records
> every accepted action and result, protects effects, and makes the work
> resumable. A graph is an amendable host projection of work that actually
> happened or must survive a boundary. It is not an up-front exam Clem must pass.

The durable call/result/effect ledger is valuable and should remain. The
mandatory model-authored graph contract is the wrong entrance to ordinary work.

The release candidate has two immediate mechanical blockers:

1. The current dirty result-classification change is red: 26 focused tests pass
   and one fails. A root object containing successful:true and status:"500" is
   now incorrectly classified as success.
2. The running daemon, PID 70401, started at 19:12 PDT. At that moment the tree
   was based on 4eb519bb plus dirty changes. Current HEAD is 38fa83ad plus two
   dirty files. Eight later commits and the current dirty changes have not been
   exercised by the live daemon.

The audited database has no currently hung provider work: zero unfinished
attempts, zero open logical calls, and zero started physical dispatches at the
cutoff. The problem is failed or false-terminal control state, not a provider
call that is still running.

---

## 2. Exact state at audit time

| Item | State |
|---|---|
| Branch | wave/one-gate-and-hardcode-subtraction |
| HEAD | 38fa83ad22e3e024d7debc5d0536f61df4d3e7cf |
| Latest tag | v3.15.0 |
| Commits ahead of latest tag | 523 |
| Dirty files | src/runtime/harness/provider-read-evidence.ts; src/runtime/harness/result-facts.ts |
| Typecheck | Passed during this audit |
| Focused recent-fix tests | 79 passed |
| Result normalization tests | **26 passed, 1 failed** |
| Isolation sentinel | **Not performed because live daemon PID 70401 owns the home** |
| Live daemon | Started 2026-09-03 19:12:45 PDT; not candidate-parity |
| Tag decision | **NO-GO** |

The failing assertion is in
[result-handle.test.ts](../src/runtime/harness/result-handle.test.ts#L843).
The dirty patch is trying to keep a nested Firecrawl page status of 404 from
overriding MCP isError:false. That intent is correct. The implementation loses
the location and authority of the status value, so a root carrier status of
"500" is also ignored. Fix the result boundary, not another recursive-key
exception.

Historical runs in this report executed across several code revisions. They
prove recurring failure classes and product outcomes. They do not prove that a
later commit failed, nor do later commits prove the incidents are fixed. Only a
fresh daemon built from the exact candidate and a clean live canary can do that.

---

## 3. Product rule

### Clem drives; the host protects and remembers

Clem should be able to:

- start with a natural user objective;
- use any connected MCP, CLI, gateway, built-in, or skill;
- take a safe read immediately;
- use that result to choose a different next action;
- preserve every settled result for the whole session;
- accept a correction, addition, or replacement objective at any moment;
- reuse completed work after a pivot;
- retry or select another capability when a recoverable operation fails;
- finish only when the requested deliverable really exists.

The host should:

- bind every call to the exact accepted user source;
- resolve the live capability, schema, account, and effect;
- append an immutable logical call, physical crossing, settlement, and result
  handle;
- serialize or approve effects when required;
- prevent blind replay of uncertain writes;
- infer dependencies when a later call consumes an earlier result;
- persist restart checkpoints and retry state;
- project the same typed state to desktop, mobile, Discord, and workflows;
- refuse only when a real safety or user-authority boundary exists.

The host should **not**:

- decide the business route;
- require Clem to guess internal topology or evidence vocabulary;
- turn a transport spelling into different authority;
- treat a successful page, cursor, result read, or corrected call as no progress;
- answer for Clem with generic harness prose;
- let old memory choose the current task;
- accept model prose as proof that work completed.

### The only legitimate user-facing walls

A user stop is legitimate when the next safe action requires something only the
user can supply:

- credentials or a disconnected account;
- a genuinely ambiguous identity or target for a consequential action;
- consent for an effect that policy requires the user to approve;
- a destructive or uncertain write decision;
- a material business choice not inferable from the current request or evidence.

Every internal operational wall must either repair itself or return an exact,
executable next action Clem can take. "Bounded" cannot mean "the host gives up
after making its own repair path unreachable."

---

## 4. What the last 25 hours actually show

Audit window: 2026-09-02 21:29 through 2026-09-03 22:29 PDT.

### Aggregate

| Measure | Observed |
|---|---:|
| Accepted source turns | 48 |
| Done terminals | 18 |
| Blocked terminals | 18 |
| Failed terminals | 3 |
| Needs-input terminals | 7 |
| Missing terminals | 2 |
| Model outcomes | 354 |
| Model outcomes reported successful | 335 |
| Model outcomes reported failed | 19 |
| Recorded aggregate tokens | 11,595,790 |
| Aggregate model latency | 7,846,753 ms |
| tool_called events | 340 |
| tool_returned events | 336 |
| Physical provider dispatches | 295 |
| Physical dispatch relation=primary | 295 |
| Physical dispatch relation=retry, poll, or probe | **0** |
| run_paused events | 87 |
| run_paused reason | prepared_workflow_dispatch_interrupted, all 87 |

All 295 physical crossings returned. The framework recorded no engine-owned
retry, poll, or probe crossing. Recovery was largely Clem spending another
model turn, often repeating discovery or plan repair, rather than the host
executing a typed recovery contract.

The 87 paused events came from only three old workflow sessions. Each emitted
the same paused condition 29 times across daemon starts:

- console:wf-morning-briefing-2
- console:wf-planner-1
- console:wf-weekly-review-2

That is restart churn, not 87 new pauses. Reconciliation and notification need
an idempotent terminal/superseded marker.

### Prospect-to-Outlook cohort

The repeatedly tested request was effectively:

> Find five suitable prospects in Salesforce, enrich them with DataForSEO,
> read the outbound skill, and create five Outlook drafts.

Observed across 27 source turns:

| Measure | Observed |
|---|---:|
| Model calls | 170 |
| Recorded tokens | 6,918,666 |
| Model latency | 2,196,766 ms |
| Tool searches | 118 |
| plan_task attempts | 16 |
| Successful plan_task attempts | 1 |
| Successful Salesforce reads | 2 |
| DataForSEO calls physically returned | 14 |
| Outlook draft writes | **0** |
| Blocked | 14 |
| Needs input | 7 |
| Labeled done | 6 |
| Actually completed end to end | **0** |

All six green-looking done terminals were false, partial, or unrelated:

- one asked a clarification;
- two only reported that the work failed;
- one asked for scope;
- one printed literal assistant tool-call text;
- one selected an unrelated disabled Salesforce-to-Airtable workflow after the
  user explicitly said the request was brand new.

This is the clearest proof that terminal state and model/tool activity are not
currently tied to the user's fulfilled obligation.

### Platform 49 cohort

The Platform 49 runs exposed the same generic seams:

- successful paginated reads were counted as no progress;
- result slices were reinjected repeatedly and grew context;
- a pre-dispatch binding refusal became done with a blocked JSON body;
- literal tool-call text became done;
- a confirmed Sheets mutation was followed by model-auth failure, with no
  matching write receipt;
- a restart lost exact checkpoint inputs and exhausted admission recovery;
- a wrong output contract requiring url and leads was attached to the
  Slack-to-Sheets workflow.

This is not evidence that Slack or Sheets need special-case nodes. It is
evidence that result progress, contract identity, settlement, checkpointing,
and terminal truth must be generic.

### Scheduled workflows

The Friday dashboard did succeed during this audit window:

- run: trigger-c7c44082419b0441f0f9d6b33fabe4c1
- six Salesforce reads completed;
- data was packaged;
- space_set_data completed at 07:00:14 PDT;
- observation: cdd06415-c7ee-49e5-8007-4c44fa025156
- stored payload: 69,030 bytes.

That does not erase the earlier "could not start" incident, and run-completed
telemetry was incomplete, but it shows the dashboard itself is not the current
root failure.

Other workflows show the generic lifecycle problem:

- scorpion-facebook-trends reached Apify with one malformed input, received an
  exact 400, then got four pre-dispatch refusals and a repair path truncated
  midway through /input/sta;
- daily-standup-email completed reads, then guessed three Outlook send
  schemas/slugs even though an authored workflow should already carry its
  exact bound operation;
- team Slack retry created new source turns, leaving earlier sources without
  conversation terminals;
- one Platform 49 run inserted a Sheets dimension successfully, then lost brain
  authentication and failed without a durable matching write receipt/readback.

---

## 5. Representative failure timeline

| Source | What happened | Root seam |
|---|---|---|
| 122597 | Sheets and nine Slack pages succeeded. New cursors and result chunks received zero progress credit. Final chunk completed, then control_no_progress_exhausted. | Progress accounting and repeated output injection |
| 122983 | Salesforce found the prospects. Fourteen DataForSEO calls physically returned, but each failed durable result authority with ToolAttemptSettlementAuthorityError. No drafts were made. | Carrier result to durable settlement |
| 123386 | Thirty-two reads/local operations and a Sheets insert succeeded. Brain auth then expired. Retry failed immediately; no matching host write receipt existed. | Partial effect resume and receipt authority |
| 124080 | Judge said the work was incomplete. Continuation changed primers and exhausted exact checkpoint admission. | Checkpoint/replay identity |
| 124338 | A revoked Sheets binding was refused before dispatch. Harness returned done with a body saying blocked. | False-green terminal |
| 124401 | Forty-two-minute interrupted Platform 49 run resumed without the exact checkpoint/primer/response ownership and exhausted admission. | Durable recovery |
| 124743 | Clem asked a scope question but the turn was marked done. | Terminal reducer |
| 124960 | Reads and local transforms succeeded; final Slack call was refused. Literal tool-call text was accepted as done, then the wrong output contract rejected it. | Adapter normalization, terminal truth, contract identity |
| 125173 | Sixteen model calls, three failed plans, two incomplete judge verdicts, no business execution; literal work_call text still became done. | Mandatory plan grammar and false completion |
| 125408 | User said "Brand-new prospects from scratch." The host returned an unrelated disabled Salesforce-to-Airtable workflow in 415 ms. | Stale continuity owning current intent |
| 125577 | tool_search advertised plan_task through call_tool. Clem called it through that carrier twice. The host refused both because plan_task must be direct/first-class. No business call occurred. | Self-contradictory control surface |

---

## 6. Root causes

### 6.1 Model-authored graph grammar is the main architectural blocker

[plan-tools.ts](../src/tools/plan-tools.ts#L180) requires the model to emit:

- criteria;
- cardinality and fields;
- destination posture and family;
- canonical topology operations;
- dependencies and dataFrom edges;
- effect and coverage declarations;
- exact capabilityRef bindings;
- roles;
- a closed evidence vocabulary;
- deliverables and evidence requirements.

The same base schema contains the literal workspace_social_posts_v1 contract
and exact /posts, /calendar, and /_mobile/records/items pointers. Even though
the locator is optional, this is provider/domain output shape inside the common
planning entrance.

[turn-semantic-proposal.ts](../src/runtime/semantic-boundary/turn-semantic-proposal.ts#L888)
then makes the model satisfy internal produced/accepted-kind algebra before the
business job can proceed.

The result is predictable:

1. Clem understands the business task.
2. Clem discovers usable tools.
3. The framework asks her to invent host topology, evidence IDs, and coverage.
4. One private field is missing or formatted differently.
5. The host refuses the whole frame before useful work.
6. Clem searches or rewrites the plan.
7. No-progress governance stops the turn.

This is not intelligent planning. It is a fragile serialization ceremony.

### 6.2 The control surface contradicts itself

Several runs exposed plan_task through call_tool, then refused the equivalent
wrapped call because plan_task was direct-only. Other commits repaired pieces
of this surface, but the deeper issue remains: direct, wrapped, and
double-wrapped representations can produce different authority and recovery.

There must be one canonical logical invocation before safety, scheduling, or
settlement. If a representation is advertised, the host must normalize it or
not advertise it.

### 6.3 Result authority is inferred from recursive payload keys

The dirty patch demonstrates the design limit. A nested Firecrawl
metadata.statusCode=404 may describe the fetched page while MCP isError=false
correctly says the tool call succeeded. A root HTTP or provider status=500 may
describe a failed call. The current recursive inspection collapses both into a
bare status value without path or authority.

The canonical adapter boundary must produce a typed result:

~~~text
callOutcome
carrierKind
carrierStatus
payload
completeness
resultHandle
receipts
retryAdvice
~~~

Rules belong to the carrier adapter:

- MCP owns CallToolResult.isError;
- HTTP owns the transport HTTP status;
- Composio owns its root execution envelope;
- CLI owns process exit and parsed stdout/stderr contract;
- nested status, success, error, or statusCode values remain business/domain
  data unless the adapter explicitly promotes them.

Core code must never recursively guess the meaning of common field names.

### 6.4 Completion is based on shapes and prose instead of obligations

[host-turn-runner.ts](../src/runtime/harness/host-turn-runner.ts#L2518)
currently counts function_call history items as meaningful business evidence.
A call shape is not proof that the call was accepted, dispatched, settled, or
produced the requested artifact.

At
[host-turn-runner.ts](../src/runtime/harness/host-turn-runner.ts#L2549),
an objective-judge exception is converted to done:true. That is unsafe for
action work.

[tool-narration-shapes.ts](../src/runtime/harness/tool-narration-shapes.ts#L16)
catches several printed tool-call forms but misses the observed
[assistant tool call: ...] form because the bracket starts with assistant, not
tool.

The fix is not an endless regex list. Every model transport must normalize its
native response into only:

- text;
- tool_call;
- stop.

At terminal commit, host obligations and typed settlements own status. Model
text can propose completion and provide the user-facing explanation; it cannot
prove completion.

For an action request, done requires:

- every still-current obligation is discharged;
- every claimed read has a successful result handle;
- every required write has a successful effect receipt and, when required,
  readback/reconciliation;
- every deliverable exists;
- no failed or uncertain settlement invalidates the claim;
- the final presentation contains no unexecuted tool syntax;
- the current workflow contract, if any, validates against the correct
  workflow/revision/step identity.

Otherwise the result is typed needs_input, blocked, failed, or uncertain.

### 6.5 Memory and continuity can override the current request

The memory snapshot contains one global active focus:

~~~text
id: 144
session: sess-desktop-a080ec4db258447d8a4ae17b
title: Use DataForSEO ca_l2E9qngGijNQ and create the five drafts...
status: active
~~~

[memory/db.ts](../src/memory/db.ts#L465) enforces a global singleton active
focus. [memory/focus.ts](../src/memory/focus.ts#L161) returns that focus title
and summary without a session or task-branch identity.
[agents/harness-context.ts](../src/agents/harness-context.ts#L257) uses it in
recall, fact ranking, and source-map assembly.

That explains why fresh sessions repeatedly asked whether the user meant the
old Tyler batch and why "brand-new prospects from scratch" could be routed to
an old disabled workflow.

Required authority order:

~~~text
current explicit user input
  > current session's accepted task revision
  > current session's settled results and open obligations
  > explicitly resumed older task
  > long-term verified memory hints
~~~

Long-term memory may suggest a tool or verified fact. It may not select the
current objective, fill a current open slot, trigger an old workflow, satisfy
completion, or force a clarification.

Active focus must be keyed by session and task branch, not globally singleton.
"Fresh", "brand-new", "from scratch", "new", and "different" must create a new
branch and suppress old task authority. "Continue", "resume", "that batch", or
an exact old task reference may reactivate a prior branch.

### 6.6 Steering is context, not an authoritative pivot

[steer-notes.ts](../src/runtime/harness/steer-notes.ts#L12) explicitly says
steering is context, not authority. It also marks notes delivered before model
injection at
[steer-notes.ts](../src/runtime/harness/steer-notes.ts#L51), so a crash between
the marker and injection can lose the instruction.

A live user message needs a typed revision:

- stop: cancel unstarted work and reconcile in-flight effects;
- correct: replace a constraint or argument for unstarted nodes;
- add: add an obligation;
- remove: supersede an unstarted obligation;
- replace objective: create a new active branch while preserving old receipts;
- context-only: add advisory information without changing authority.

Claim the note durably, inject it, then acknowledge delivery. Completed results
stay addressable. Unstarted nodes may be recompiled. A write already in flight
must settle or reconcile; it must not be blindly replayed or erased.

### 6.7 No-progress is measuring mechanism, not business progress

The Platform 49 pagination run proves that a new cursor, new page, new result
slice, and EOF movement can all be successful while the governor sees no
progress.

Progress should be any monotonic change in business state or executable
authority:

- new successful result handle;
- new page/cursor/offset/EOF;
- repaired schema or arguments;
- new valid capability or account binding;
- changed target;
- consumed result in a dependent call;
- successful receipt/readback;
- a user task revision;
- a genuinely new failure class with a different repair.

Repeated identical no-effect consequences should be bounded. Corrective work
that changes schema, arguments, binding, result, or authority must not spend the
same loop budget.

The explicit recovery dead-end is documented in
[host-turn-runner.ts](../src/runtime/harness/host-turn-runner.ts#L6944).
The code admits that a cold multi-family task can end with generic harness
prose because the restricted recovery surface cannot persist through one
model-owned final step without reopening discovery. Fix the loop control flow:
persist a restricted or tool-free surface through the next request and
terminate on Clem's answer.

### 6.8 Retry and restart state are not truly engine-owned

All 295 audited physical dispatches are relation=primary. No physical retry,
poll, or probe was recorded.

Typed recovery should be owned by the host:

| Failure class | Host action |
|---|---|
| transient read/transport | bounded retry with backoff |
| schema invalid before effect | one repair from exact live schema |
| stale binding before effect | just-in-time reacquire and retry |
| auth for an unpinned brain | healthy configured model failover |
| unsupported operation | try one ranked sibling capability |
| result storage/handle failure | settle or rehydrate from retained returned bytes |
| uncertain write | reconcile only; never blind replay |
| confirmed partial write | resume after receipt; never restart whole step |
| checkpoint mismatch | restore exact durable frame or typed terminal; never changed replay storm |

[exact-checkpoint-reentry.ts](../src/runtime/harness/exact-checkpoint-reentry.ts#L20)
uses process-local state. A daemon restart renews the budget for a poisoned
checkpoint. Persist session, source, phase, frame/consequence digest, count,
nextEligibleAt, lastError, and terminal/superseded status.

Workflow retries must remain attempts under one canonical source identity, or
explicitly terminalize/supersede every older source. Creating orphan source
turns breaks reporting and replay.

### 6.9 Globally configured tools are not globally reachable

The ordinary orchestrator deliberately does not attach provider MCP servers at
[agents/orchestrator.ts](../src/agents/orchestrator.ts#L3842). Discovery layers
may rank and lazily reveal schemas to keep context bounded, but a configured
server must not become unreachable because an intent classifier failed to
expose it.

Build one bounded boot/turn capability index:

- stable opaque capability ID;
- short name and description;
- carrier/adapter traits;
- live schema fingerprint;
- effect class;
- account binding state;
- result/evidence kinds;
- recovery contract.

Advertise compact entries. Reveal an exact schema only when selected. Execute
through the same kernel regardless of whether the capability came from MCP,
CLI, Composio, a built-in, or a skill.

### 6.10 Provider behavior remains in core

Core still contains provider/domain pins, including Sheet operations in
[production-capability-adapters.ts](../src/runtime/harness/production-capability-adapters.ts#L32)
and DataForSEO/Airtable behavior in
[tool-guardrail.ts](../src/runtime/harness/tool-guardrail.ts#L295).

[no-hardcoded-provider-pins.test.ts](../src/no-hardcoded-provider-pins.test.ts#L27)
is a baseline ratchet, not proof of provider neutrality. Move batching,
pagination, async completion, readback, and reconciliation behavior into
adapter manifests. Drive the allowed core-provider literal baseline to zero.

---

## 7. Simplified Northstar architecture

The existing local Hermes research already reaches the same conclusion:
[HERMES-HARNESS-RESEARCH-2026-08-22.md](./HERMES-HARNESS-RESEARCH-2026-08-22.md).
Hermes is useful here because its default is a recognizable model/tool loop,
not because Clem should copy its weaker effect authority.

~~~text
accepted user turn or workflow occurrence
                    |
                    v
        session task/revision ledger
 current objective + constraints + obligations
                    |
                    v
              Clem's loop
       context -> model -> next action
                    |
                    v
         canonical invocation kernel
 live capability + exact schema + account + effect
 lease + dispatch + settlement + result/effect receipt
                    |
                    v
             append-only events
 action node -> result node -> dependent action node
                    |
          +---------+----------+
          |                    |
   continue foreground    promote checkpoint graph
                          only when durability needs it
~~~

### One loop

~~~text
understand
  -> select/bind exact capability
  -> act
  -> settle typed observation or effect
  -> revise objective/obligations from new evidence
  -> continue or verify
  -> one truthful terminal
~~~

### Graph promotion rules

Promote an explicit durable graph only when at least one is true:

- work must survive the foreground activation;
- independently retryable branches need durable fan-out/merge;
- a user input, approval, or dependency boundary pauses work;
- an effect needs reconcile-only recovery;
- the task is scheduled/reusable;
- a large collection needs item-level checkpoints;
- a human review/pilot boundary exists.

Multiple tools alone do not require an up-front graph.

### What the model supplies versus what the host derives

| Concern | Clem/model | Host |
|---|---|---|
| User objective | Interpret and revise | Persist exact accepted source |
| Next action | Choose | Validate and append |
| Business criteria | Reason and apply | Persist as task constraints |
| Capability | Choose from live compact index | Resolve exact descriptor/schema/account |
| Dependencies | State only when semantically important | Infer from consumed result handles and call lineage |
| Effect | Propose action | Derive from descriptor and enforce |
| Evidence kind | Use result | Derive from adapter settlement |
| Cardinality/completeness | Reason about user request | Track pages, cursors, EOF, counts, coverage |
| Retry | May choose a different business approach | Execute typed infrastructure recovery |
| Completion | Propose explanation | Verify current obligations and receipts |

### plan_task after the cut

plan_task should become one of:

- an internal host projection of the append-only task journal;
- an optional debugging/inspection tool;
- a durable-promotion operation invoked only when a real boundary is reached.

It must not be a model-visible prerequisite for safe reads or ordinary
multi-tool work.

For the smallest pre-tag implementation:

1. Let safe reads execute without a full plan.
2. Append action/result nodes automatically.
3. Let later calls reference result handles.
4. Infer dependency edges from those references.
5. Immediately before a mutation, compile and freeze only that mutation's
   exact target, arguments, account, input lineage, idempotency, and approval.
6. After settlement, return control to Clem.

This preserves the strongest safety properties while removing the private
graph exam.

### Session memory after the cut

Retain for the full active session:

- every accepted user turn and task revision;
- every model step identity;
- every logical call and physical crossing;
- typed settlement;
- compact result summary;
- opaque result handle and raw-byte location;
- cursor/page/EOF state;
- effect receipt and readback;
- verified facts and provenance;
- current obligations;
- last failure class and repair state.

Raw bytes may be compacted or moved, but nothing referenced by an open task
branch may expire. The model-visible context should contain compact handles and
only the slices needed now. The ledger, not the prompt window, is the memory.

---

## 8. What to keep

Do not respond to this audit by removing safety or durable evidence. Preserve:

- exact schema validation before provider crossing;
- live account selection for real write ambiguity;
- accepted-source and call identity;
- logical and physical dispatch ledgers;
- result handles with exact retained bytes;
- effect idempotency and write receipts;
- approval and destructive-action policy;
- uncertain-write reconciliation;
- checkpoint fencing;
- bounded identical-loop protection;
- workflow output contracts when bound to the exact workflow revision/step;
- deterministic result ordering;
- mobile/desktop/Discord projections from canonical events.

The goal is to remove dead-end operational gates, not authorization or effect
safety.

Recent commits contain useful repairs and should be preserved, then verified
on the exact candidate:

| Commit | Intended repair |
|---|---|
| 4ba3cf28 | Serialized provider envelope may settle success |
| 1294e769 | First-use capability should survive broker/mailbox ranking |
| 5aec2ca6 | Redundant discovery detection on the used lane |
| 0372e890 | No-progress decision journal |
| 8e790378 | Disabled/missing workflow must not end the turn |
| 78c77f4d, 4eb519bb | Structural control reachability |
| a87c3b68, d4e9e0e6 | Disclose plan vocabulary and capability references |
| 8f33c70b | Skill reads remain pure local execution |
| 15182312, 8145853f | HTTP status and row/domain-status distinctions |
| edfc3b9f | Distinguish BYO vendor families |
| 38fa83ad | Rebase admit-phase replay to committed checkpoint |

These repairs improve symptoms. Several also reveal why the mandatory schema
has become too expensive: the model had to be taught more private vocabulary
instead of the host deriving it.

---

## 9. P0 implementation sequence before the tag

This order minimizes retesting against known-bad foundations.

### P0.0 — Establish one real candidate

1. Stop the live daemon only when the current developer is ready to run the
   isolated/full suite.
2. Fix or discard the two dirty result files; do not tag a red worktree.
3. Run result normalization/property tests.
4. Run typecheck, implementation-artifact verification, and the complete suite
   with the isolation sentinel actually performed.
5. Start dev from that exact commit and clean/declared dirty state.
6. Make the daemon publish and the test UI display commit, dirty digest, schema
   version, and artifact fingerprint. Refuse a canary when they differ.

### P0.1 — Canonical typed result boundary

Implement adapter-owned carrier semantics and make returned bytes plus result
handle settlement atomic/recoverable.

Files likely involved:

- src/runtime/harness/provider-read-evidence.ts
- src/runtime/harness/result-facts.ts
- src/runtime/harness/attempt-outcome.ts
- src/runtime/harness/attempt-settlement.ts
- provider adapters/carriers

Acceptance:

- root carrier 500 fails;
- MCP isError:false with nested Firecrawl page 404 succeeds as a call and keeps
  page status as domain data;
- a returned business record with status=failed remains a successfully
  returned record;
- successful Composio/provider result always yields redeemable result
  authority;
- a storage failure retries internally or rehydrates from retained return
  bytes without calling the provider again.

### P0.2 — Remove full-plan admission from ordinary work

Implement the minimal emergent graph:

- safe reads first;
- automatic action/result nodes;
- result-handle lineage;
- just-in-time mutation freeze;
- optional durable promotion.

Update
[NEXT-TAG-RELEASE-GATE.md](./NEXT-TAG-RELEASE-GATE.md) at its current cold-loop
and discovery rows. It still requires one primary plan_task and zero business
I/O before plan admission. Those requirements contradict this Northstar and
will drive the next agent back into the same architecture.

Acceptance:

- a cold multi-tool request may make a useful read before any graph exists;
- no model-authored evidence vocabulary, topology IDs, or provider locator is
  required;
- provider/tool names can be permuted without changing engine behavior;
- a later result may change the next action;
- a mutation freezes exact authority only when ready to dispatch.

### P0.3 — One evidence-owned terminal reducer

Use one reducer for chat and workflows. A model done response is a proposal.

Acceptance:

- judge false cannot become done;
- judge exception cannot become done for action work;
- contract false cannot become done;
- failed or uncertain settlement cannot become done;
- missing required write receipt cannot become done;
- a question becomes needs_input;
- disabled workflow falls through to direct capability execution when
  possible;
- raw tool-call narration never becomes a public or durable answer;
- every accepted source has exactly one terminal.

### P0.4 — Session-scoped task memory and authoritative pivots

Remove the global active-focus singleton as task authority. Key active branches
by session and task/revision. Current explicit input always wins.

Acceptance:

- fresh session cannot inherit the Tyler batch;
- "brand-new/from scratch" never selects an old workflow;
- "continue that batch" can intentionally resume it;
- same-session correction revises only unstarted work;
- completed result handles remain usable after a pivot;
- crash between steer claim and injection cannot lose or double-apply it.

### P0.5 — Typed recovery, progress, and restart

Implement host-owned recovery contracts and persistent budgets.

Acceptance:

- the physical ledger records relation=retry for a transient read retry;
- schema repair uses the exact live schema once;
- stale pre-effect binding is reacquired just in time;
- new page/cursor/offset/EOF is progress;
- result slices are not repeatedly copied into prompt history;
- exact checkpoint retry count survives daemon restart;
- confirmed write resumes after its receipt and never replays;
- uncertain write reconciles and never blind-retries;
- one restricted model-owned final is possible without a third discovery or
  generic harness prose.

### P0.6 — Auth/fallback and authored workflow bindings

All 12 audited Codex fallback calls failed: GPT-5.4 failed 7 of 7 and
GPT-5.6-sol failed 5 of 5. A route with persistent zero success must be circuit
broken.

For a workflow not explicitly pinned to one brain, fail over to a configured
healthy model. An explicit model pin remains user authority and should produce
a typed dependency if unavailable.

Authored workflows should carry exact operation, account, schema fingerprint,
and output contract identity. Do not make the model rediscover a known Outlook
send operation inside a frozen workflow.

### P0.7 — Retention and boot reconciliation

The session reaper currently throws a foreign-key constraint around
[eventlog.ts](../src/runtime/harness/eventlog.ts#L6725). Correct child deletion
ordering/cascades, or safely disable session deletion for the beta window.

Make restart reconciliation idempotent so the same three old paused sessions
do not emit another run_paused event on every boot.

---

## 10. Exact pre-tag test matrix

Component tests are necessary but cannot substitute for these full-path
journeys.

### A. Result semantics property matrix

Permute status, statusCode, success, successful, error, and isError at:

- root carrier;
- root payload;
- one nested object;
- nested array item;
- identified business row;
- nested metadata.

Run across MCP, HTTP, Composio, CLI, and generated carriers. Expected result is
determined by the adapter contract and location, never field spelling alone.

### B. Cold emergent multi-tool journey

Create a blank-home acceptance test with randomized provider/tool names:

1. natural user objective;
2. compact live capability discovery;
3. progressive safe read;
4. second dependent read using result handle;
5. mid-run filter or destination pivot;
6. just-in-time write;
7. receipt/readback;
8. truthful terminal.

Do not inject private plan JSON or call the kernel directly from the fixture.
Exercise the same channel, model, bridge, and call path used in production.

### C. Exact prospect live canary

From a fresh session and clean candidate:

> Find five suitable prospects in Salesforce, enrich them with DataForSEO,
> read the outbound skill, and create five Outlook drafts.

Pass conditions:

- no stale Tyler or old-workflow question;
- no more than one bounded discovery per unresolved role;
- exactly five selected prospect records;
- enrichment outcomes retained, including honest per-item failure;
- outbound skill read through the local skill path;
- exactly five Outlook draft receipts;
- list/readback verifies the drafts;
- no raw tool syntax;
- one done terminal only after artifacts exist.

Run three times per supported model family intended for the beta. If time
forces a smaller support matrix, shrink the published beta matrix rather than
claiming an untested family.

### D. Live pivot canary

During the prospect run, after at least one useful read, send a correction such
as:

> Use three prospects instead, exclude this company, and save to the other
> mailbox.

Pass conditions:

- the new instruction is acknowledged as a task revision;
- completed reads remain addressable;
- unstarted work is revised;
- no duplicate provider reads merely to reconstruct lost context;
- any in-flight write settles/reconciles;
- only the revised deliverables are completed;
- one final terminal reflects the latest revision.

### E. Platform 49 canary

Pass conditions:

- exact authored bindings are available;
- pagination advances to EOF;
- each new cursor/page/result slice counts as progress;
- no full result is injected twice;
- the sheet write/update carries a receipt and readback;
- output contract belongs to Platform 49's exact definition and step;
- mobile/desktop/Discord show the same running, check-in, and terminal state;
- exit/reopen does not make the terminal or progress disappear.

### F. Restart matrix

Kill and restart at:

- after accepted model batch, before dispatch;
- mid-read;
- after provider return, before result handle commit;
- immediately after confirmed write;
- while waiting for user input;
- after a live pivot is claimed, before injection acknowledgment.

Pass conditions:

- exact same source and task revision resume;
- settled reads are not repeated;
- confirmed writes are not repeated;
- uncertain writes reconcile;
- retry budget does not reset;
- no checkpoint exhaustion caused by changed primer/response identity;
- no duplicate public terminal or boot notification.

### G. Terminal oracle

Generate cases for:

- successful function-call shape with failed settlement;
- blocker prose;
- question;
- disabled workflow;
- wrong workflow contract;
- judge false;
- judge exception;
- literal tool-call text in every provider dialect;
- partial write;
- uncertain write;
- all obligations truly complete.

Only the last case may be done.

### H. Global-tool permutation

Run the same journey with:

- MCP;
- CLI;
- Composio/gateway;
- built-in;
- skill;
- generated aliases and shuffled catalog order.

Direct, wrapped, and double-wrapped accepted invocations must normalize to the
same logical call/effect/settlement/retry, or only one representation should be
advertised.

### I. Workflow contract identity

Bind two unrelated workflows with different output schemas. Prove that a
learned or frozen contract from one can never validate or reject the other.
Identity must include workflow slug, definition hash, step ID, and revision.

### J. Mobile projection and stop control

The user's observed mobile failures need explicit release coverage:

- running state appears without leaving/reopening;
- check-ins appear and replay;
- terminal state appears without leaving/reopening;
- terminal remains after leaving/reopening;
- a stop control is reachable in the expanded running-step view;
- stop creates one canonical cancellation and reconciles in-flight effects;
- Discord and mobile receive the same typed terminal.

The stop control may remain compact, but it cannot depend on client-only state
or disappear when a run is active.

---

## 11. Tag gate

Do not tag until all of the following are true:

- worktree and generated artifacts match the exact candidate;
- daemon fingerprint matches that candidate;
- typecheck passes;
- full isolated suite passes with sentinel performed;
- result root-versus-nested authority matrix passes;
- no ordinary compound task requires a model-authored full graph before reads;
- no false done cases pass the terminal reducer;
- active task/focus is session and branch scoped;
- current explicit user input outranks all old continuity;
- one real transient retry appears as an engine-owned retry;
- checkpoint and retry state survive restart;
- the exact prospect canary completes with real draft receipts;
- the live pivot canary completes without discarding settled work;
- Platform 49 reaches EOF and completes with correct contract/receipt;
- mobile exit/reopen retains progress and terminal truth;
- no old paused session emits repeated boot events;
- the published beta model/tool matrix contains only live-proven families.

If the team cannot complete every structural P0 before the deadline, the safe
choice is to narrow the beta claim and supported model matrix. Do not tag a
universal "Clem can use any connected tool and finish" claim while the exact
representative job still makes zero writes or can be falsely marked done.

---

## 12. What not to spend another night doing

Do not:

- add Slack-specific recovery to fix Platform 49;
- add Sheets-specific progress exceptions;
- add Salesforce/DataForSEO/Outlook nodes to the core graph;
- add more prose to plan_task validation errors as the primary fix;
- add another regex at every presentation boundary;
- raise loop budgets without changing what counts as progress;
- retry uncertain writes;
- let a model judge override missing receipts;
- treat a green conversation terminal as artifact proof;
- seed exact plan JSON in a test and call it a cold-start pass;
- restart dev and test without proving daemon/candidate parity;
- erase the durable ledger or safety kernel.

The repeated pattern is already clear. More local exceptions will make the
framework larger while keeping the same dead ends.

---

## 13. Recommended ownership split for the next agent

If work is parallelized, use these non-overlapping tracks:

1. **Result and settlement boundary**
   - adapter-owned carrier semantics;
   - atomic/recoverable result handles;
   - root/nested property matrix.

2. **Turn loop and emergent graph**
   - remove full-plan read gate;
   - append action/result nodes;
   - infer lineage;
   - just-in-time mutation freeze;
   - persistent restricted final step.

3. **Terminal, memory, and pivot**
   - one obligation reducer;
   - session/branch focus;
   - task revisions;
   - provider response normalization.

4. **Recovery and release proof**
   - typed retry contracts;
   - durable checkpoint budget;
   - workflow source identity;
   - reaper/boot idempotence;
   - exact live canaries and daemon fingerprint.

Integrate in that order. Do not start final live testing until the result
boundary and candidate parity are green, or the test evidence will be
ambiguous again.

---

## 14. Final diagnosis

The last two days did produce meaningful infrastructure: exact call identity,
settlements, retained result handles, checkpointing, safety, and richer
observability. The remaining problem is not that Clem needs more hardcoded
help. It is that the host asks her to operate the host.

The final simplification is:

> Let Clem reason and act through one canonical tool loop. Record the graph
> behind her. Freeze only the consequence that is about to happen. Preserve
> every settled turn and result. Treat a live user message as a durable task
> revision. Let receipts, not prose, decide when the job is done.

That is the shortest path from today's failures to the trust target: give Clem
a task, let her keep working through recoverable failures, let the user pivot
at any time, and know that a green completion means the requested thing
actually exists.

---

## 15. `get-bb/bb` code review: what to borrow

Originally reviewed repository commit:
[`d80ce4f80a3f24bee43704758203be562fa2a3cc`](https://github.com/get-bb/bb/tree/d80ce4f80a3f24bee43704758203be562fa2a3cc).
The conclusions below were revalidated on 2026-09-04 against current commit
[`d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0`](https://github.com/get-bb/bb/tree/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0).
The intervening diff touched only 17 presentation-related files, so the linked
implementation findings remain structurally current. This was a source review
of a local checkout, not an assessment based only on the README.

`bb` is not a replacement for Clem's workflow engine. It hosts coding agents,
while Clem has to reason over arbitrary connected business systems and protect
external effects. Copying its entire graph would trade one oversized control
plane for another. Seven mechanisms are directly transferable, however.

### A. Bind provider and model as one execution identity

`bb` stores `providerId` on the thread, loads a provider's live model catalog,
and remembers model/reasoning preferences per effective provider. A model
override is validated against the thread's provider and changing providers
requires a new thread. See:

- [`useThreadCreationOptions.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/apps/app/src/hooks/useThreadCreationOptions.ts)
- [`schema.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/packages/db/src/schema.ts)
- [`thread-execution-override.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/apps/server/src/services/threads/thread-execution-override.ts)

The Clem equivalent should be a durable route bundle on every accepted turn
and workflow dispatch:

```text
providerId + modelId + account/auth identity + catalog revision/digest
```

The UI, child workflow, retry, telemetry, and completion message must all read
that same identity. A global routing mode may choose a default before dispatch;
it must not silently rewrite an explicit, connected Claude selection to GLM
after the UI has promised Claude. This is the exact class of mismatch observed
in today's supposedly-Sonnet Platform 49 run.

### B. Keep provider details at the adapter boundary and ratchet them out of core

`bb` providers translate native events into one bridge protocol. More
importantly, CI counts provider-ID literals outside provider plugins and rejects
any increase. See:

- [`provider-plugin-api.md`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/docs/provider-plugin-api.md)
- [`provider-registry.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/packages/agent-runtime/src/provider-registry.ts)
- [`debugging-and-qa.md`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/docs/debugging-and-qa.md)

Clem needs the same ratchet for provider and toolkit literals in graph,
recovery, terminal, and presentation code. Existing literals can be baselined;
the allowed count may only decrease. A Slack, Sheets, Salesforce, Claude,
Codex, or GLM branch added to provider-neutral core should fail CI.

### C. Make every internal gate return a typed unlock path

`bb` converts provider rejections into typed recovery hints such as
`sessionArchived`, `rateLimited`, `authRequired`, `restartRecommended`, and
`staleTurn`. The runtime automatically unarchives/retries where safe. Its retry
plugin uses a pure, total decision function: every refusal names why it will not
retry, rate-limit waits use reset time plus jitter, and the attempt number is
part of durable turn state so restarts cannot reset the budget. See:

- [`runtime.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/packages/agent-runtime/src/runtime.ts)
- [`retry-policy.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/plugins/provider-retry/src/retry-policy.ts)

Clem should standardize every internal refusal as:

```text
kind + retryable + effect certainty + durable attempt + unlock action
```

If a gate is safe for Clem to unlock, the host executes that action and loops.
If it cannot name an executable unlock action, it is either a real user/safety
boundary or a framework bug. This is stronger than increasing a timeout or
adding more repair prose.

### D. Normalize subagents into one small lifecycle

`bb` exposes one provider-neutral delegation item with `childRef`, `label`,
`background`, and optional `summary`. Provider adapters translate Codex,
Claude, Pi, or ACP-native child activity into that shape. A grammar verifies
that an item starts before progress and settles only once. See:

- [`thread-delta.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/packages/provider-bridge-protocol/src/thread-delta.ts)
- [`thread-event-grammar.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/packages/provider-bridge-protocol/src/thread-event-grammar.ts)

Clem should reason about a generic child lifecycle, not provider-specific agent
syntax. Child events should carry source turn, task revision, parent call,
effect scope, and terminal summary; the core graph should never need to know
which provider implemented the child.

### E. Treat the durable event log as UI truth

`bb` stores append-only thread events under a unique `(threadId, sequence)`
constraint. The client merges a newly loaded latest window by sequence and
rebuilds when windows are stale or non-contiguous. The server commits accepted
events transactionally before notifying listeners and applying follow-up
effects. See:

- [`schema.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/packages/db/src/schema.ts)
- [`events.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/apps/server/src/internal/events.ts)
- [`timeline-merge.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/packages/client-core/src/timeline/timeline-merge.ts)

This is the clearest answer to the mobile disappear/reappear bug. Websocket
state should invalidate or advance a projection; it must not be the only home
of a running/check-in/terminal message. Exit/reopen should always reconstruct
the same timeline from durable sequence rows.

`bb` also places Stop in the composer's primary action slot while a turn is
running, including compact/coarse-pointer layouts, instead of hiding it in an
expanded step. See
[`PromptBoxInternal.tsx`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/apps/app/src/components/promptbox/PromptBoxInternal.tsx).
That is the right mobile behavior for Clem: send becomes stop, the stop request
is appended durably, and every surface projects the same cancellation.

### F. Turn production failures into a provider conformance corpus

`bb` keeps recorded provider fixtures and exercises the same scenarios across
providers, including delegation, steering, authentication failures, and event
translation. Its QA guide also describes production-corpus replay and snapshot
comparison. See
[`debugging-and-qa.md`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/docs/debugging-and-qa.md).

The last 25 hours of Clem runs should become a scrubbed replay corpus rather
than remain evidence only in logs. Each supported model/provider combination
must replay the same malformed sibling, corrected write, stale observation,
restart, pivot, delegation, stop, and mobile-rehydration scenarios. This is how
to make "fix one workflow, fix them all" enforceable.

### G. Make a mid-run pivot a receipted input, not another chat message

`bb` negotiates whether a provider can inject a steer into the active turn or
must queue it. Its Pi adapter tracks the input until the provider's queue proves
that it was consumed. If the turn ends first, the steer is reported dropped by
that delivery barrier rather than guessed from a timer. The conformance tests
also pin event ordering: the accepted acknowledgement must precede output caused
by the steer. See:

- [`handshake.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/packages/provider-bridge-protocol/src/handshake.ts)
- [`requests.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/packages/provider-bridge-protocol/src/requests.ts)
- [`rpc-session.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/plugins/provider-pi/src/bridge/rpc-session.ts)
- [`bridge.round2.test.ts`](https://github.com/get-bb/bb/blob/d80ce4f80a3f24bee43704758203be562fa2a3cc/plugins/provider-pi/src/bridge/bridge.round2.test.ts)

That is the concrete implementation model for Clem's Northstar requirement
that the user can pivot at any moment. A live correction needs a durable
`clientRequestId`, target task revision, and one terminal delivery state:
`consumed`, `queued`, `superseded`, or `dropped`. The UI may then say what
actually happened; the graph can branch from the accepted revision; and no
provider adapter needs to pretend it injected a message that arrived too late.

### Recommended adoption order

1. **Before tag:** route bundle/provider truth; typed gate unlock; durable
   reversible-settlement proof; stale-observation self-refresh; isolated
   malformed read sibling; live Sonnet Platform 49 canary.
2. **Release UI requirement:** sequence-authoritative mobile rehydration and a
   composer-level Stop control.
3. **Immediately after the candidate:** provider/toolkit literal ratchet and a
   scrubbed multi-provider replay corpus.
4. **Northstar simplification:** collapse provider-native child structures into
   the generic delegation lifecycle, make pivots receipted inputs, and keep the
   graph as a durable projection of the model/tool loop.

The central lesson from `bb` is not "add another orchestrator." It is to make
identity, lifecycle, recovery, and replay small and typed so the model remains
the driver while the host guarantees truth and continuity.

---

## 16. 2026-09-04 Sonnet canary and current release boundary

### Live result

The natural-language request `Run my platform 49 flow please` was sent through
a fresh chat with Claude Sonnet 5 selected. Run
`1788505161012-c20e62` completed in approximately 3 minutes 49 seconds. The
operational route events—not the UI label—recorded requested model
`claude-sonnet-5`, resolved model `claude-sonnet-5`, provider `claude`, and
routing mode `off` for every main model call.

The workflow successfully:

- read the Google Sheet;
- paged Slack history;
- updated the digest time cell once;
- refreshed both workspace sources;
- emitted the user notification;
- returned the terminal artifact URL with an honestly empty `leads` array.

The accepted-source audit found 10 successful business settlements, zero open
or conflicting crossings, zero unrecovered business failures, and no uncertain
effect. A fresh post-completion session fetch returned the durable
`conversation_completed` event at sequence `126062`; backend reload truth is
therefore proven. The physical iPhone renderer was not directly observed, so
that final presentation check still belongs in the manual acceptance pass.

### Generic repairs now covered by focused tests

The current candidate includes provider-neutral fixes for:

- an explicit connected Claude selection being silently rewritten to BYO by
  `all_in` routing;
- one malformed typed read sibling poisoning an otherwise valid read/compute
  batch;
- a restart-adopted read observation refreshing once from current attested
  transport when—and only when—the frozen catalog is unchanged;
- local MCP and workspace aggregate failures being flattened into apparent
  success;
- a provider-rejected write followed by a corrected same-target success being
  recognized after restart from durable current-manifest recovery semantics.

That last repair is deliberately narrower than a retry heuristic. It is granted
only when one current manifest proves a non-destructive external write, required
idempotency, exact-artifact reconciliation, and a distinct live reconcile port.
Irreversible, ambiguous, unknown, or unreconciled mutations still fail closed.

Focused verification after integration: 374 tests passed, TypeScript typecheck
passed, and `git diff --check` passed. The rebuilt dev daemon is serving the
exact current source candidate on port 8520 with `host_v1`; Claude Sonnet 5 is
the active brain through the Claude Code Max subscription.

### P0 found by that canary snapshot: host-owned write receipts

The successful Sheet update exposed one structural gap that should not be
hidden by the green workflow terminal. The `host_owned_external` lane records
physical dispatch and logical settlement, but bypasses the provider-neutral
`external_write` reservation/terminal projection used by `resolveWriteEvidence`.
This production database consequently has no first-class host write receipt for
the successful update, and the terminal audit can currently be clean with
`attemptedMutations > 0` while `confirmedWrites === 0`.

This is not Sheets-specific. Any mutation using that host-owned carrier can
have the same gap. Do not fix it by inventing proof after execution or by
immediately requiring `confirmedWrites > 0` globally; the former fabricates
authority and the latter would strand every existing host-owned mutation.

The correct pre-tag repair is one shared write-event primitive used by both the
wrapped and host-owned lanes:

1. reserve one `external_write` before provider dispatch;
2. settle it `succeeded` only from returned dispatch plus structured success;
3. settle definite refusal/failure as `failed`;
4. settle cancellation, timeout, or throw after dispatch as `orphaned`;
5. make replay idempotent on exact logical-call and physical-dispatch identity;
6. only after that projection is universal, require paired write evidence for a
   successful authored workflow terminal.

Required regressions are success, semantic provider failure, post-dispatch
timeout/cancellation, pre-dispatch refusal, replay, read-only non-emission,
authored-workflow success with a pair, and terminal refusal when the pair is
missing. Until those pass, the current candidate is suitable for continued beta
acceptance testing, but not for the stronger promise that every green mutation
terminal is backed by a first-class durable write receipt.

### 2026-09-04 current-worktree update: the write-receipt gap is implemented

Section 16 records the candidate state at the time of that canary. The current
untagged worktree now contains the shared provider-neutral projection in
[`external-write-event-projection.ts`](../src/runtime/harness/external-write-event-projection.ts).
The host-owned external lane reserves before dispatch, projects exact success,
definite failure, or orphaned ambiguity, reuses settled calls without entering
the provider body, and repairs a committed-settlement/missing-terminal crash
window without redispatch. The accepted-source audit now requires an exact
projection for every successful direct-host mutation.

A focused run of `host-tool-invocation`, accepted-source settlement
reconciliation, and work-report effect-truth tests passed 93/93. That run also
covered success, event-idempotent replay, daemon-restart projection repair,
per-call audit pairing, semantic refusal, ambiguity, timeout, cancellation,
pre-dispatch refusal, read-only non-emission, and decisive reconciliation. The
isolated-runner sentinel was not performed because the live dev daemon owned
the test home, so the source fix is focused-test green but still needs the
ordinary isolated candidate suite and live canary before the tag.

---

## 17. Current `bb` deep review: the useful harness boundary

### Audit basis and verdict

This follow-up reviewed the actual source at current commit
[`d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0`](https://github.com/get-bb/bb/tree/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0),
including its server, host daemon, provider bridge protocol, Claude Code and
Codex adapters, workflow and retry plugins, persistence layer, tests, and
recorded provider fixtures. The repository is MIT licensed and under active
development.

There is a lot worth transferring, but the reason is narrower than it first
appears. `bb` does **not** implement a superior inner reasoning loop, semantic
model picker, cross-provider failover brain, or proactive token governor. It
lets Claude Code, Codex, Pi, or an ACP agent own the inner model/tool loop and
surrounds that loop with a small, typed, durable control plane. That separation
is its real strength.

The Clementine synthesis should be:

```text
durable logical task + revision + memory + effect receipts
                         |
task-aware route / checkpoint / recovery policy
                         |
one admission checkpoint + one durable wait queue + append-only events
                         |
versioned provider bridge (Claude, Codex, Grok, GLM, ...)
                         |
provider-native model/tool/subagent loop
```

That architecture makes the graph harder to derail without making it larger.
The model still drives; the host guarantees identity, continuity, delivery,
cancellation, and external-effect truth.

### 17.1 The highest-value transfer: one queue and one admission checkpoint

`bb` does not create a different scheduling lane for every reason work cannot
start. Its queued-message domain records the original input and execution tuple
and gives waiting a typed cause such as `time`, `thread-busy`, `turn-starting`,
`provisioning`, `host-offline`, `interaction`, or `plugin`. The last dispatch
failure is stored separately from the fact that the item is waiting. See:

- [`queued-message.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/domain/src/queued-message.ts)
- [`dispatch-attempt.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/server/src/services/threads/dispatch-attempt.ts)
- [`backend-contract.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/plugin-sdk/src/backend-contract.ts)

Every first turn, follow-up, steer, retry, and queue drain passes the same
dispatch checkpoint. A plugin may return only `proceed`, `wait`, or `reject`.
`wait` preserves the request durably; core capacity, host, interaction, and
timer changes wake the same queue, while plugins may explicitly request a
recheck when their condition changes. The final claim and turn append occur
atomically, which prevents two drainers from starting the same work.

This is the cleanest implementation of the user's gate rule:

```text
recoverable condition -> wait(unlockTrigger)
repairable condition  -> repair(action), then re-enter admission
real boundary         -> reject(user/safety/business reason)
missing unlock path   -> framework defect, never a business “blocked” result
```

For Clem, `typed_catalog_not_ready`, daemon unavailable, lease pressure,
provider restart, stale auth, and temporary tool readiness must not be terminal
workflow outcomes. They should be durable wait or repair states. This also
collapses several competing graph branches into one mechanism.

One `bb` edge must not be copied: dispatch-hook exceptions and timeouts fail
closed, and a stored drain failure can make an item ineligible for normal
redrain. A loaded but broken plugin may also retain an unscheduled wait
indefinitely if it never sends the promised recheck. Clementine's hook contract
needs a typed framework-recovery path so a recoverable hook fault cannot become
a sticky gate. Every operational wait must have a concrete event wake, a
scheduled probe, or a bounded fallback/circuit breaker.

### 17.2 Retry only after proving whether the provider accepted the input

`bb` persists a mandatory `turn/input/accepted` boundary. Its durable retry
logic then makes a subtle but important distinction:

- if the provider did **not** accept the input, replay the exact original input;
- if the provider accepted it, do not duplicate that input in the provider
  conversation—send an agent-only continuation instead;
- preserve the exact provider, model, reasoning, service-tier, and permission
  tuple from the failed attempt;
- store attempt and chain identity durably, with no duplicate live retry row.

See [`turn-retry.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/server/src/services/threads/turn-retry.ts)
and [`retry-policy.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/provider-retry/src/retry-policy.ts).

This is directly useful for Clem's continuation and duplicate-prompt failures.
It is still insufficient for business tools. Provider acceptance proves only
what happened to the conversation input; it does not prove whether Salesforce,
Sheets, Slack, or another system committed a mutation. Clem must combine this
boundary with the host-owned write receipt described in Section 16:

```text
not accepted -> safe prompt replay
accepted, no effect dispatched -> safe continuation/replan
effect definitely failed -> retry under idempotency policy
effect may have happened -> reconcile receipt before any retry
effect succeeded -> never replay; continue from settled observation
```

### 17.3 Model selection: copy route truth, not provider immutability

`bb` has strong execution-selection hygiene. Provider/model/reasoning are an
all-or-none explicit choice; otherwise a child or workflow inherits an exact
origin tuple. The tuple is checked against the live catalog immediately before
spawn, and retries keep the failed attempt's tuple rather than silently moving
to another model. It also distinguishes an explicit user choice from a default
merely displayed by the UI. See:

- [`thread-execution-plan.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/server/src/services/threads/thread-execution-plan.ts)
- [`thread-execution-override.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/server/src/services/threads/thread-execution-override.ts)
- [`execution-options.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/server/src/services/system/execution-options.ts)
- [`service.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/workflows/src/service.ts)

Every Clem attempt should persist:

```text
requested route
effective route
selection source
catalog revision and provider-process generation
substitution or fallback reason
prior attempt that caused any route change
```

`bb` does not semantically pick a model from task type, tool topology, cost,
latency, context pressure, or prior failures. Its main thread also treats the
provider as immutable. Those assumptions should not be copied. Clem's logical
task must live above any provider session, and a task-aware router should be
allowed to pivot carriers only from a verified checkpoint. The UI and audit log
must say when it did so.

The provider-process generation idea is particularly useful for today's daemon
failures. `bb` fingerprints a provider process from its artifact, capabilities,
and options and retires stale generations. Clem should bind catalog readiness,
session handles, and cached capabilities to the same kind of generation. A
restarted daemon must never inherit a prior process's false `ready` state.

### 17.4 Session lifetime should be an eligibility predicate, not 60 seconds

`bb`'s outer host reaps an idle provider session only after 30 minutes, and only
when it is marked restorable and has no active turn, pending start, in-flight
operation, or open background work. It retains the provider thread identity so
the bridge can wake the same logical session on the next turn. Claude's more
aggressive internal 30-second process release is explicit opt-in and disabled
by default. See:

- [`app.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/host-daemon/src/app.ts)
- [`runtime.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/agent-runtime/src/runtime.ts)
- [`provider-claude-code/server.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/provider-claude-code/server.ts)
- [`bridge.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/provider-claude-code/src/bridge/bridge.ts)

So the answer to Clem's 60-second lifetime problem is not merely a larger
number. A workflow, model call, background child, outstanding tool operation,
or unconfirmed effect must make the session ineligible for reaping. Reaping is
safe only after a restorable checkpoint has been proven. Slow, idle,
disconnected, waiting for capacity, and hung are different states and need
different wake or recovery actions.

### 17.5 Subagents: durable lifecycle, not a special manager brain

`bb` supports provider-native delegations and explicit child threads. It
normalizes native activity into a small provider-neutral shape containing a
child reference, label, status, background flag, parent tool call, and optional
summary. Explicit children are ordinary threads; parent notifications are
durably batched and queued if the parent is busy or awaiting an interaction.
Workflow children use a two-phase spawn/attach sequence so a cancellation race
cannot leave an orphan running. See:

- [`provider-event.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/domain/src/provider-event.ts)
- [`child-thread-notifications.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/server/src/services/threads/child-thread-notifications.ts)
- [`runtime-background-work-state.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/agent-runtime/src/runtime-background-work-state.ts)
- [`workflows/src/data.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/workflows/src/data.ts)

The transferable state machine is:

```text
planned -> admitted -> spawning -> attached -> running
        -> waiting/repairing -> settled | cancelled | orphaned
```

Each transition should carry the parent call, task revision, execution
envelope, effect scope, and one idempotent result. Cancellation must cascade to
all descendants and produce a durable terminal boundary even when a provider
does not acknowledge stop.

`bb` does not solve shared cognitive memory. Some workflow workers are hidden
threads related only through a workflow call row; task delegation passes a
curated prompt; transcript copying is a separate fork feature. Clem still
needs one session event ledger shared by parent and children: decisions, tool
observations, failed hypotheses, external effects, open commitments, user
pivots, and child outcomes. Each child should receive a task-scoped projection
and append typed findings back. Full transcript cloning should not be the
memory mechanism.

### 17.6 Authored workflows: borrow deterministic replay, keep effect receipts

The workflows plugin runs provider-independent JavaScript orchestration in a
restricted QuickJS environment. Agent calls become ordinary hidden threads
with a persisted exact execution envelope. A shared FIFO scheduler bounds total
calls and concurrency, AbortSignals cancel queued and running work, structured
results are schema-validated, and invalid output receives at most two bounded
repair turns. See:

- [`workflows README`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/workflows/README.md)
- [`workflows runtime.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/workflows/src/runtime.ts)
- [`workflows cache.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/plugins/workflows/src/cache.ts)

Its most useful replay idea is an ordered causal prefix. A call key includes the
previous call key, prompt, exact execution tuple, output schema, worker prompt
version, result protocol version, and repair budget. After a crash, the longest
unchanged successful prefix can be replayed deterministically and execution
continues from the first divergence.

For Clem, add effect identity and receipt state to that key. `bb` may reuse a
successful writer call because the workspace is the same; that is unsafe for
arbitrary SaaS mutations. A prior Salesforce update or Sheet append is reusable
only when a durable receipt proves the exact effect and current policy says the
observation remains valid. Otherwise reconcile before continuing.

Other workflow limitations that should not be copied are:

- `parallel()` and `pipeline()` can turn child exceptions into `null`, which
  risks presenting systemic failure as partial success;
- some retry classification falls back to matching error text;
- total token use is not actually governed;
- there is a total-run timeout but no general per-worker lease/stall watchdog;
- a final text result is sufficient for an unstructured coding worker, but is
  not proof that a connected-business-system effect exists;
- completion notification delivery is at least once and may duplicate.

### 17.7 Context telemetry is good; autonomous context recovery is missing

`bb` normalizes exact or estimated context-window usage across providers and
projects it into one canonical event shape. That is a strong adapter boundary.
It mostly uses the result for display and delegates compaction to the provider,
however. It has no central allocator that reserves completion/recovery
headroom, checkpoints before exhaustion, verifies compaction, and reroutes when
a carrier cannot recover. See:

- [`provider-event.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/domain/src/provider-event.ts)
- [`delta-assembler.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/provider-bridge-protocol/src/assembler/delta-assembler.ts)
- [`thread-context-window-usage.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/thread-view/src/thread-context-window-usage.ts)

Clem should consume normalized telemetry through a real governor:

1. reserve completion, reconciliation, and recovery headroom;
2. checkpoint the current task revision and effects before the threshold;
3. compact or summarize;
4. verify the new carrier state;
5. resume the same logical task;
6. switch carriers from the checkpoint if recovery is unavailable.

### 17.8 What `bb` still does not provide: an outcome governor

The shared `bb` runtime considers a canonical provider turn `completed`,
`failed`, or `interrupted`; it does not independently decide whether the user's
business objective was achieved. Its tool layer correlates provider requests
cleanly, but has no universal tool timeout, effect ledger, idempotency contract,
post-timeout consequence probe, alternate-tool router, or business-outcome
validator. The stable provider call ID is not carried all the way into generic
plugin execution for automatic deduplication.

There are two other walls Clem should not inherit. The shared turn-start
watchdog reports that a turn appears stuck but does not repair it. A daemon
replacement may interrupt active threads rather than checkpointing and
resuming them. See:

- [`runtime-provider-requests.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/agent-runtime/src/runtime-provider-requests.ts)
- [`tool-calls.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/server/src/internal/tool-calls.ts)
- [`plugin-runtime.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/server/src/services/plugins/plugin-runtime.ts)
- [`session-owner-side-effects.ts`](https://github.com/get-bb/bb/blob/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/apps/server/src/internal/session-owner-side-effects.ts)

Clem needs a small provider-independent outcome loop above turns:

```text
while objective is not verified:
    if there is progress: continue
    if a gate is recoverable: unlock, wait, retry, or reroute
    if an external effect is uncertain: reconcile before retry
    if a safe alternative exists: pivot from the durable checkpoint
    if actual user authority is missing: ask for one precise action
    if bounded recovery is exhausted: retain state and explain the evidence
```

“Never stopped by a gate” should mean no repairable **internal** gate becomes a
terminal business failure. Authentication that cannot be refreshed, consent,
destructive authority, and missing business judgment remain real user
boundaries. Those should preserve all work and ask for exactly one action;
they must not be disguised as a framework failure.

### 17.9 The replay harness may be the fastest quality gain

`bb` records raw provider scenarios, runs them through the current bridge,
assembler, grammar, and timeline projection, and compares canonical events and
rows. At the reviewed commit the repository contains 52 committed scenario
directories across Claude Code, Codex, Pi, and ACP/Cursor, covering approval,
authentication failure, compaction, fork, resume, steer, stop, delegation,
tools, user questions, and web search. See
[`provider-parity`](https://github.com/get-bb/bb/tree/d39bca3ebfa8e00ffcb9810b7d333a03f12c2bb0/packages/provider-parity).

This should become Clem's provider conformance suite. Scrub and record the last
25 hours of real failures at the transport/event boundary, then replay every
fixture through each supported carrier adapter. The invariant is one canonical
task/effect timeline regardless of which model emitted the native wire shape.
That is how a repair for Platform 49 becomes a repair for every workflow.

### 17.10 Adopt, reject, and sequence

| Decision | Mechanism | Why |
|---|---|---|
| Adopt now | One `proceed / wait / reject` admission contract | Converts internal gates into durable, wakeable state |
| Adopt now | Input-acceptance boundary on retries | Prevents duplicate prompts while preserving safe replay |
| Adopt now | Exact requested/effective route provenance | Stops silent model substitution and stale catalog truth |
| Adopt now | Reap only quiescent, restorable sessions | Fixes the class of 60-second lifetime failures structurally |
| Implemented and live-verified | Shared host-owned and wrapped-tool effect receipts | Focused tests and the Sonnet V10 live mutation canary pass |
| Adopt now | Provider-independent outcome reducer | A provider's `completed` event is evidence, not business completion proof |
| Adopt next | Provider recording/replay parity corpus | Makes one generic fix enforceable across carriers |
| Adopt next | Generic child lifecycle and durable parent notice | Prevents orphaned work and disappearing mobile results |
| Adopt next | Provider-process generation identity | Makes daemon restart and catalog recovery deterministic |
| Build above `bb` | Semantic router and context governor | `bb` reports route/context truth but does not choose or govern adaptively |
| Do not copy | Provider-immutable logical threads | Clem must pivot providers from a verified checkpoint |
| Do not copy | Text/regex-based recovery classification | Recovery must be typed at the adapter boundary |
| Do not copy | Writer-result replay without effect receipts | Connected-system mutations require reconciliation |
| Do not copy | Final prose as business completion proof | Only settled receipts can prove the requested outcome |

### 17.11 Current Clementine gap map against these mechanisms

This is a source-level comparison against the current dirty worktree, not only
the older canary snapshot:

| Mechanism | Current state | Evidence and remaining delta |
|---|---|---|
| Universal host-owned write receipts | **Implemented and live-verified** | The shared [`external-write-event-projection.ts`](../src/runtime/harness/external-write-event-projection.ts), host invocation integration, exact audit pairing, and restart reconciliation passed the focused suites; the Sonnet V10 run then proved one physical update plus a distinct host-owned verifier settlement and typed `done` on the live connected account. |
| One `proceed / wait / reject` admission contract | **Partial** | Workflows persist capability-blocked/awaiting-input states and can reap blocked runs, but [`workflow-step-external-catalog.ts`](../src/execution/workflow-step-external-catalog.ts) still emits `refused`, consent uses a different decision vocabulary, and the no-progress governor uses another. There is no single queue/wake contract yet. |
| Provider-input acceptance-aware retry | **Missing as a global invariant** | [`model-request-provenance.ts`](../src/runtime/harness/model-request-provenance.ts) freezes request provenance, but no durable provider-accepted-input boundary chooses exact prompt replay versus agent-only continuation across lanes. |
| Quiescent/restorable session reaping | **Partial** | Leases and longer workflow/model limits exist, but [`session-reconcile.ts`](../src/runtime/harness/session-reconcile.ts) can still terminalize accepted input after a wall-clock bound and ask the user to resend. There is no common provider-session restore checkpoint plus open-background-work eligibility test. |
| Full route/catalog/process provenance | **Partial** | Requested, resolved, effective model, provider, source, and routing mode are persisted, and capability calls carry manifest/fingerprint identity. Catalog revision and provider-process generation are not yet bound to each route/session. |
| Raw provider trace replay corpus | **Missing in `bb`'s form** | Clem has many injected restart/parity tests and [`trace-lab.ts`](../src/runtime/harness/trace-lab.ts), but not a scrubbed native-wire fixture corpus replayed through every adapter into the same canonical event/timeline assertions. |

This comparison changes the immediate emphasis: do not rebuild the effect
receipt already present. Protect it with isolated/live proof, then focus new
implementation on the one admission/wake contract and the provider-input
acceptance boundary. Those are the two largest remaining structural gaps that
map directly to today's walls and duplicate/continuation risk.

### Release recommendation

Do not vendor or port the whole `bb` harness before the tag. The current Clem
candidate is already closer to the required external-effect semantics than
`bb`; a broad transplant would introduce more uncertainty than it removes.

The smallest pre-tag architectural slice is:

1. retain the universal host-owned write receipt now implemented after the
   Section 16 snapshot, then prove it in the isolated candidate suite and a
   live mutation canary;
2. make every internal gate implement `proceed`, durable `wait` with an unlock
   trigger, or a narrowly defined real `reject`;
3. prove input acceptance before deciding between replay and continuation;
4. make session expiry conditional on quiescence plus a verified restorable
   checkpoint, never wall-clock age alone;
5. persist requested and effective route plus catalog/process generation;
6. turn today's provider traces into the first cross-provider replay fixtures.

After those invariants pass, move the larger provider-bridge and child-lifecycle
cleanup behind the tag. The Northstar is not a more elaborate graph. It is a
small durable kernel around a model-native loop, with the logical task and
effect ledger above every replaceable provider session.

## 18. 2026-09-04 live mutation proof: V7 through V15

This sequence is the most useful compact reproduction of the remaining graph
failure and its generic fix. It used Claude Sonnet 5 against one connected
Google Sheets account, but the repaired boundaries are provider-neutral. The
only provider-specific declarations remain inside the Composio adapter.

### V7: the business write worked, terminal truth did not

V7 read a blank cell, performed exactly one `GOOGLESHEETS_VALUES_UPDATE`, and
read the exact marker back. The terminal nevertheless blocked because it tried
to prove an in-place update using a legacy create-result rule and demanded a
new created ID/handle/receipt.

The root cause was not model quality. Generic proof provisioning had replaced
current capability manifests with successors that lost their adapter-authored
`verification` metadata. Without the exact mutation/readback recipe, the
terminal could not distinguish a verified update of an existing resource from
creation of a new resource.

The repair in [`proof-provisioned-catalog.ts`](../src/runtime/harness/proof-provisioned-catalog.ts)
now preserves both the exact `verificationContract` and `operationSemantics`,
and fails closed on reviewed schema drift rather than silently publishing a
metadata-empty successor. The regression is
[`proof-provisioned-generic-verification.test.ts`](../src/runtime/harness/proof-provisioned-generic-verification.test.ts).

### V8: honest non-mutation, not an acceptance run

V8 targeted a cell that already contained a marker. Sonnet correctly read it,
did not overwrite it, and reported the retained value. Because no mutation
occurred, this run could not prove host-owned write verification and was not
counted as release acceptance.

### V9: newly visible gate-scope defect

V9 targeted a cell independently confirmed blank. Sonnet performed the
predicate read and observed `values: []`. The hidden one-action compiler then
sealed a dependency-free update. Before provider I/O, the last-edge target gate
refused it with:

```text
exact_verified_mutation_target_required:
no exact verified dependency target exists for this mutation
```

This gate exists to protect a different topology: `create resource -> mutate
that exact created resource`. In that graph, the mutation must match the
verified predecessor ID byte-for-byte. The implementation was incorrectly
applying the same predecessor requirement to a dependency-free mutation of an
explicitly named existing resource. That made the gate impossible to satisfy:
there was no predecessor operation by construction.

[`mutation-verification-proof.ts`](../src/runtime/harness/mutation-verification-proof.ts)
now scopes the predecessor-identity gate to provider-argument mutations that
actually declare one or more dependencies. A dependency-free existing-target
mutation still owes the exact frozen post-write content proof; it simply does
not invent a nonexistent create predecessor. The focused policy regression is
[`mutation-verification-target-policy.test.ts`](../src/runtime/harness/mutation-verification-target-policy.test.ts).

The paired journey run passed 9/9. Its wrong-target `create -> update` case
still refused before I/O, proving the patch did not weaken the byte-for-byte
predecessor safety invariant.

### Host-owned verifier discovery is no longer model luck

The adapter now exposes an exact reviewed inventory of compatible readback
contracts. Admission may select a current verifier, restamp a stale current
verifier from the adapter declaration, or stage a fresh adapter-nominated
verifier after revalidating its exact account, input/output schemas, provider
version, definition fingerprint, invocation port, and contract.

The verifier is supplementary host work. It does not need to appear in the
model's discovered catalog or business graph, and it cannot grant itself write
authority. The model authors the business mutation; the host deterministically
executes the frozen readback child call and records a separate non-business
settlement. This is implemented in:

- [`operation-semantics.ts`](../src/integrations/composio/operation-semantics.ts)
- [`admit-and-compile-accepted-source.ts`](../src/runtime/semantic-boundary/admit-and-compile-accepted-source.ts)
- [`gauntlet-sheet-derived-verification.red.test.ts`](../src/journeys/gauntlet-sheet-derived-verification.red.test.ts)

The derived-verification journey proves
`CREATE -> host BATCH_GET -> UPDATE -> host BATCH_GET` with zero model-authored
verifier calls. It also retains ambiguity refusal and the zero-candidate
verification obligation.

### V10: live acceptance passed

The exact source candidate was rebuilt and started as daemon PID `47152`
(source fingerprint `1b92cbc73155`, schema 77). V10 used task
`bg-pretag-sonnet-sheet-v10-20260904`, Claude Sonnet 5, account
`ca_GJ_hJWV2Hw7P`, cell `Sheet1!X999`, and marker
`CLEM-PRETAG-GRAPH-READBACK-V10`.

The durable ledger proves:

1. the initial `GOOGLESHEETS_VALUES_GET` returned an empty value list;
2. exactly one physical `GOOGLESHEETS_VALUES_UPDATE` crossed and succeeded;
3. the host issued a distinct logical verifier ID beginning `verify:`;
4. that verifier executed `GOOGLESHEETS_BATCH_GET` with
   `businessCall:false` and succeeded;
5. Sonnet's final visible read returned the exact marker;
6. every routed provider result named the same frozen account;
7. the obligation manifest settled both `commit_effect` and
   `verify_committed_readback`;
8. `resolution_finalized.expectationsSatisfied` was true;
9. the background task, user presentation, and `turnOutcome` all committed
   `done`;
10. no create-ID fallback or missing-receipt terminal block appeared.

This is the effect/terminal proof the earlier V7 business success did not
provide: provider result, effect ledger, independent verifier, resolution
reducer, and mobile-facing terminal now agree.

It is not yet the complete conditional-topology proof. The initial blank-cell
read remains a durable, model-visible settled result in the same accepted
source, but the one-action Auto compiler currently seals only the update node.
Because `source_call_ids` correctly means content lineage, the model leaves it
null for a read used only as a condition; Auto therefore does not promote that
read into `dependsOn`. V10 proves the model actually performed the read and
made the correct decision, but the accepted graph itself does not yet retain
the ordering edge.

The smallest generic follow-up is to let Auto select the latest exact
current-source, model-visible, settled read that matches the mutation's
provider, account, resource, and selector; seal it as `dependsOn` only with
`dataFrom: []`; adopt its durable operation; and allow target admission to
consume a typed successful read-target proof as well as a prior-mutation proof.
Wrong resource, selector, account, failed result, or unprojected read must cross
zero writes. The post-write verifier remains host-owned and is not added as a
model graph node.

### V11 and V12: one semantic write still had two carrier checkpoints

V11 targeted independently confirmed blank `Sheet1!Y999`. The predicate read
settled successfully with one physical crossing. Sonnet then selected
`GOOGLESHEETS_UPDATE_VALUES_BATCH`, but emitted it through `call_tool`. Only
the exact configured `work_call` entered the hidden one-action compiler, so
the same semantic write bypassed planning and reached the later frozen-catalog
bar with no graph. Two attempts refused
`catalog_entry_or_manifest_missing:candidates=0:proven=none`; zero writes
crossed and the cell remained blank.

This was a control-plane split, not a provider or Sheets failure. A fresh,
sole, exactly proven external mutation is now normalized before accepted-batch
admission onto the configured proposal-free `work_call` carrier. The host
preserves the model call ID, rewrites the matching accepted history bytes,
requires one authoritative exact-source proof plus one current provider,
account, schema, manifest and invoke identity, and then reuses the existing
hidden `plan_task`, consent, once-only lease, target proof, effect receipt and
terminal path. Recovered accepted frames are never rewritten. `call_tool`
remains unable to execute business writes and no write fast path was added.

V12 showed that the first fallback predicate contradicted its own downstream
provider policy. Current Composio manifests use `destructive:null`; the new
fallback required `destructive === false` for every provider, so it refused
before staging even though the established Composio path rejects exact delete
operations through `classifyComposioActionConsequence` and revalidates the
complete provider definition. The fallback now mirrors that existing split:
Composio must be non-delete; other providers still require explicit
`destructive:false`. V12 also crossed zero writes.

### V13: carrier normalization worked; an adjacent adapter contract was absent

V13 proved the normalized carrier path. Sonnet read blank `Sheet1!Y999`, the
host compiled the hidden one-action contract, and exactly one physical
`GOOGLESHEETS_UPDATE_VALUES_BATCH` crossed and succeeded. A final visible
`GOOGLESHEETS_VALUES_GET` returned the exact marker
`CLEM-PRETAG-CONDITIONAL-GRAPH-V13`; `resolution_finalized` recorded
`expectationsSatisfied:true`.

The background task nevertheless committed `blocked`. The selected batch
update manifest had `verificationContract:null`, so no frozen mutation recipe,
host-owned `BATCH_GET`, verification receipt, or normalized terminal receipt
could exist. This was the sole upstream cause found in the V13 ledger; the
model's later read cannot substitute for host-bound verification.

The Composio adapter now declares the exact batch operation only:
`GOOGLESHEETS_UPDATE_VALUES_BATCH` targets `/spreadsheet_id`, projects the
required `/data` entries through relative `/range` and `/values`, and supplies
the resulting exact range set at `/ranges` to the existing host-owned
`GOOGLESHEETS_BATCH_GET` verifier. No alias or graph-specific Sheets logic was
added. The exact lookalike `GOOGLESHEETS_BATCH_UPDATE_VALUES` remains inert.
Focused contract, generic proof, one-action acceptance and full
derived-verification tests pass.

### V14 and V15: the next remaining pre-tag gate is admission repair

The new batch verification contract has not yet completed a live end-to-end
terminal canary because two earlier admission failures prevented V14/V15 from
reaching the mutation:

- V14 compiled a model-authored plan, repeated the same `plan_task`, and then
  ended with “I'll read …” without making the read. The host correctly made no
  external change, but it did not keep the turn open or recover from the
  already-activated plan.
- V15 named the exact read and batch update operations to isolate verification.
  Sonnet emitted the initial read through `work_call`; it was refused twice
  because `GOOGLESHEETS_VALUES_GET` had no *same-turn connected-account
  observation*, even though the sole account was active and direct host probes
  succeeded. The model did not run the metadata acquisition that would have
  opened the gate. Zero writes crossed.

This is now the most important remaining tag blocker. Provider/tool selection,
connection observation, catalog readiness, provisioning, an already-active
plan and temporary host unavailability must enter one repairable admission
state with an explicit unlock action and then re-enter the same checkpoint.
They must not become model instructions that can be ignored, competing carrier
paths, or terminal business failures. This is the highest-value direct lesson
from `bb`'s single dispatch checkpoint and typed durable wait queue.

Current acceptance statement: the generic effect, carrier normalization,
condition-target proof, adapter contract and verifier machinery are focused
green; V13 proves one physical batch mutation and exact visible readback; but
the candidate is **not tag-ready** until a fresh live run proves the complete
condition edge, one write, host verifier, receipt, `done` terminal, and mobile
delivery without a connection/readiness gate.

### What the `bb` review changed in this repair

The direct transfer from `bb` was not code reuse. It was the control-plane
invariant that a provider's output is never the final authority over the
logical task. Exact route identity, durable input/effect settlement, a typed
checkpoint, and one terminal projection must agree. The V7 failure was a
concrete example of why: the provider and model had completed the business
action, but the host proof state disagreed. V10 closes that disagreement with a
host-owned receipt and verifier rather than trusting completion prose.

The remaining high-value `bb` transfers are still:

1. one durable `proceed / wait / reject` admission result across all internal
   gates;
2. retry decisions based on whether provider input was actually accepted;
3. raw provider record/replay fixtures normalized into one canonical event
   timeline;
4. reaping only quiescent sessions with a verified restore checkpoint;
5. durable child lifecycle and parent notification state.

Do not port the whole repository before the tag. Clem now has stronger
external-effect verification than `bb`; the next architectural work should
shrink and unify the control plane around that proof kernel, not replace it.
