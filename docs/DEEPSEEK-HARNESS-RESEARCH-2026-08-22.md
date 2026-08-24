# DeepSeek Harness Research and the Clem “Beat the Harness” Boundary

Date: 2026-08-22

This note examines DeepSeek Harness at tag `dsh-v0.1.1-rc.2`, commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, and translates the useful design
ideas into a concrete release boundary for Clementine. DeepSeek Harness is in
developer preview; this is a point-in-time comparison, not a compatibility
contract or a request to copy its package layout.

Primary sources:

- Official developer-preview overview: <https://deepseek.com/harness/en/>
- Official repository: <https://github.com/deepseek-ai/deepseek-harness>
- Current tag: <https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.1-rc.2>
- Current architecture contract: <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- Current core subsystem contract: <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md>
- Current tool pipeline contract: <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md>
- Agent-loop package: <https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop>
- Session-persistence package: <https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-persistence>
- Workflow package: <https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/workflow/workflow>

The master documentation above was rechecked on 2026-08-23. The release gate
uses those current service, event, and tool-pipeline contracts as the moving
competitive bar while keeping the tagged revision as the reproducible audit
anchor.

## Executive conclusion

The North Star is still correct, but “simple loop” is not enough by itself.
DeepSeek’s useful insight is a **small concrete loop surrounded by replaceable,
observable services**. Hermes demonstrates the same foreground simplicity from
a more conventional registry-driven implementation. Clem should combine that
clarity with stronger durable effect authority and project execution.

The target is therefore:

```text
one host-owned conversational loop
  + one canonical model-step vocabulary
  + one live capability catalog
  + one call/settlement kernel
  + append-only observable lifecycle
  + explicit durable workflow promotion when state complexity earns it
  + read-only Space projections of durable truth
```

This is not a mandate to turn every Clem subsystem into a dynamically mounted
plugin before the next tag. It is a mandate to make the boundaries narrow,
provider-neutral, replaceable, and independently testable—and to keep business
nouns outside them.

## What DeepSeek Harness actually implements

### One concrete loop

The concrete loop lives in one package, `packages/core/agent-loop`. Model,
tools, system prompt, sessions, and persistence are injected services. The loop
owns turn/step sequencing, cancellation convergence, model requests, and tool
result reinsertion. Policy and product features attach at typed lifecycle
events rather than becoming alternate executors.

The recognizable core remains:

```text
claim input
  -> assemble request
  -> stream one model step
  -> record one assistant completion anchor
  -> classify the emitted calls
  -> run exclusive barriers or a bounded parallel pool
  -> commit results in original model order
  -> repeat or close the turn
```

There is no graph compiler in front of every chat message.

### Tool concurrency is a scheduling property

The model may emit several calls in one step. The loop asks the tool service
whether each call is parallel-safe or exclusive. Parallel-safe calls use a
bounded rolling pool; an exclusive call creates a barrier. Dispatch bodies may
overlap, while policy, durable call/result events, additional context, and
model-visible result order remain deterministic.

This supports Clem’s rule: **tool count never earns a graph**. Independent work
can fan out inside the foreground loop. A graph is justified by durable state,
not by the number of calls in a model frame.

### The session log is the observable spine

DeepSeek records model-visible input, assistant messages, tool calls/results,
context injections, and lifecycle boundaries into an append-only session log.
Persistence stores the same event vocabulary instead of inventing a second
message model. Resume, replay, search, projection, and the Trajectory UI consume
that log.

Its persistence coordinator also centralizes batching, flush, recovery, and
backend differences. Cold crash repair preserves committed events and appends
synthetic closers rather than silently erasing the interrupted tail.

This supports Clem’s direction: the desktop UI should render canonical engine
events and projections. It must not infer truth from chat copy or maintain a
parallel workflow state machine.

### Features live outside the loop

Permissions, sandboxing, retries, compaction, subagents, persistence,
telemetry, UI, scheduling, and tools are separate services/plugins. The loop
publishes typed checkpoints for them. A feature can be replaced without
forking the model→tool→model owner.

The lesson is not “hundreds of packages.” The lesson is **one writer and one
contract per fact**.

The current documentation sharpens that lesson: model-visible inputs are
required to be reconstructable from the append-only session log, tool policy
and around-dispatch behavior compose through one execution pipeline, and agent
creation/resume publishes a scoped service world transactionally. Clem should
match that observability and replaceability without copying the package count,
then exceed it by proving that every external crossing also has accepted-task,
call-lease, physical-claim, settlement, and evidence identities.

### DeepSeek’s current workflow seam is deliberately weaker than Clem’s goal

The current workflow engine runs a model-written orchestration script that can
fan out subagents. It has bounded children/items/concurrency and typed
cancellation/error results, but its own documentation lists material limits:

- foreground collection only;
- no journaling or restart resume;
- no saved or nested workflows;
- no token-budget vocabulary;
- run lifetime is owned by the caller’s live handle.

That is useful for dynamic subagent fan-out, but it is not the durable recurring
project engine required for a nationwide canonical dataset. Clem should beat
this with workflow revision identity, occurrence identity, node attempts,
durable checkpoints, exact call settlement, pagination/coverage state,
recurrence, and rebuildable Space projections.

## Where DeepSeek is currently ahead of Clem

1. **The foreground ownership story is legible.** There is one concrete loop
   and a clear event/service perimeter.
2. **Tool fan-out is native to the loop.** Parallel-safe calls do not require a
   synthetic graph or named recipe.
3. **The extension model is coherent.** Policy features attach to typed
   checkpoints instead of silently acquiring execution ownership.
4. **Traceability is a product surface.** The Trajectory view consumes the
   same append-only run history as resume and replay.
5. **Lifecycle teardown is designed explicitly.** Start, abort, drain,
   disposal, wake-up, and late-arriving input have named ownership semantics.
6. **The UI is compositional.** Conversation, tools, permissions, jobs,
   workflow runs, settings, plugins, and trajectory are modules over shared
   runtime state.

## Where Clem must be stronger

1. **External-effect authority.** A tool registry entry or plugin mount is not
   sufficient. Clem re-observes exact live schema/account/effect/invoke
   identity and binds it to one accepted call.
2. **Logical versus physical truth.** Every intended call and every external
   crossing have separate durable identities and settlements.
3. **Uncertain writes.** Timeout or crash after a possible mutation becomes
   reconcile-only and is never blindly replayed.
4. **Durable workflows.** A project can outlive chat, process partitions over
   time, restart at item/page boundaries, and preserve exact occurrence and
   node-attempt ownership.
5. **Completeness proof.** A first page or bounded sample cannot support
   universal claims. Coverage has explicit denominators, exhaustion, cursor
   history, gaps, and quarantine.
6. **Canonical entity truth.** Immutable observations, field provenance,
   deterministic resolution, ambiguity quarantine, and idempotent canonical
   records are framework services rather than prompt instructions.
7. **Consent lineage.** Suggestion, pilot authorization, pilot evidence,
   recurrence preview, and recurrence consent are distinct durable states.
8. **Upgrade safety.** Existing user state, open attempts, approvals, and
   schedules must survive an exact version migration and two idempotent boots.

## The combined Hermes + DeepSeek benchmark

| Concern | Hermes lesson | DeepSeek lesson | Clem release requirement |
|---|---|---|---|
| Foreground turn | Keep one obvious loop | Keep one concrete loop package | One host-owned loop; no pre-loop graph executor |
| Multi-tool work | Fan out independent calls | Bounded parallel pool + exclusive barriers | Concurrency from dependency/effect classification, not tool count |
| Extension | Registry + common runtime | Typed plugin/service checkpoints | Narrow carrier/model/policy adapters; no alternate executor |
| Trace | Structured runtime events | Append-only session is UI/replay source | One accepted source, calls, crossings, terminal, projections |
| Long work | Fresh scheduled agent | Separate workflow seam | Durable graph only when work outlives turn or needs explicit state |
| Recovery | Bounded retries/stall guards | Cancel/drain + cold session repair | Exact leases, settlement, replay, reconcile-only writes |
| Capabilities | Searchable tool registry | Tools are composable services | Live schema/account/effect/port materialization from blank state |
| UI | Operational status | Trajectory/plugin UI modules | Chat + Workflow + Space render canonical truth, never invent it |

## Clem’s mandatory engine boundary

```text
Accepted user source
        |
        v
Context + live capability hints
        |
        v
Canonical model step
        |
        +---- final text -----------------------------+
        |                                             |
        +---- independent call intents                |
                      |                               |
                      v                               |
              Call admission kernel                  |
        exact source/call/args/schema/account/effect  |
                      |                               |
          +-----------+-----------+                   |
          |                       |                   |
     bounded parallel       exclusive barrier         |
          |                       |                   |
          +-----------+-----------+                   |
                      v                               |
             ordered settled results                 |
                      |                               |
                      +----------> next model step    |
                                                      v
                                             one terminal writer
```

The foreground engine may propose a durable project, but proposal is not
execution. Promotion occurs only after explicit project state appears:

```text
inert opportunity
  -> exact disabled pilot preview
  -> formal pilot approval
  -> one receipt-backed pilot through the shared call kernel
  -> canonical records + honest coverage
  -> recurrence preview
  -> separate recurrence consent
  -> durable workflow occurrences
  -> read-only Space projection
```

## What not to do next

- Do not add another planner, executor, or business-shaped fast lane.
- Do not require a graph for ordinary independent tool fan-out.
- Do not use a fake graph to mint chat call IDs.
- Do not turn memory or a capability index into execution authority.
- Do not let every plugin/service write session, workflow, and UI state.
- Do not make the desktop infer “running,” “complete,” or “needs input” from
  assistant prose.
- Do not claim the new engine is general while it permits only test fixtures or
  manually registered capability ports.
- Do not expose recurrence before a pilot result and separate consent exist.
- Do not ship a one-page collection as a completed large dataset.

## Release work in strict order

1. Finish the one-loop foreground cut and delete every effect-capable fallback.
2. Make production connected MCP, CLI, and gateway definitions materialize
   through the same live capability boundary from a truly empty home.
3. Prove foreground independent fan-out and dependent follow-up without graph
   promotion.
4. Complete the exact one-read durable pilot vertical through the existing
   logical/physical settlement kernel.
5. Add page/continuation authority, cursor-cycle detection, aggregation, and
   honest completeness.
6. Connect workflow results to the normalized entity/provenance/quarantine
   store and then to a rebuildable Space projection.
7. Activate interval recurrence only from exact pilot evidence plus separate
   consent; prove overlap/catch-up/restart behavior.
8. Run generated carrier permutations, crash/restart, cancellation, partial
   evidence, and v3.14 upgrade tests from one frozen candidate.
9. Restart the daemon on that exact candidate and run live canaries in
   consequence order.
10. Only then refine the desktop UI around canonical events: engine activity,
    approval, workflow topology, partition progress, coverage, provenance,
    quarantine, and next recurrence.

## Release test: “better than both”

The candidate is not accepted merely because chat replies quickly. One
provider-neutral scenario must prove all of the following without a seeded
manifest, resolution, or invocation port:

1. a fresh chat understands an unfamiliar large-data objective;
2. ordinary discussion remains in one fast loop;
3. several independent discovery/read calls can fan out with ordered results;
4. Clem proposes, but does not silently create, a durable project;
5. the user reviews and authorizes one exact representative pilot;
6. the pilot crosses one live materialized capability exactly once;
7. process death after settlement reuses the durable result;
8. multiple pages exhaust or stop partial without an unsupported universal
   claim;
9. observations resolve or quarantine into canonical records with provenance;
10. a Space rebuilds progress and review facts without execution authority;
11. recurrence is still absent until separate consent;
12. an approved interval survives restart without duplicate or overlapping
    occurrences;
13. the same result and lifecycle appear on desktop, CLI, and chat surfaces;
14. there is one accepted source/activation, one owner, one call ledger, and
    one terminal truth throughout.

That is the practical “beat Hermes and DeepSeek Harness” path: simpler in the
foreground, stronger at external effects, and genuinely durable for real-world
projects.
