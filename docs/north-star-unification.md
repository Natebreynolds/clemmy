# Clementine — North-Star Unification

*One Clem who lives in the harness: lightweight prompt, code does the heavy lifting, learns forever, handles any task, and always reports back — identically across desktop, Discord, and mobile.*

## The problem in one sentence

Clem is **forked across two cores** — the chat core (`assistant/core.ts` → `instructions.ts`) and the harness core (`runtime/harness/loop.ts` → `agents/harness-context.ts`) — with **duplicated self-assembly**, **per-path report-back**, **two Discord handlers** (`discord.ts` vs `discord-harness.ts`, gated by `DISCORD_HARNESS_ENABLED`), a **dashboard that mixes both cores**, and a habit of **dragging one-off actions through heavyweight machinery** (the live example: a "send a test email" desktop chat self-escalated into tracked execution `T-166`, run by the harness controller, still `active` and queued for re-review — ~56K tokens for one test email).

The result is drift, wasted tokens, inconsistent behavior per surface, and a learning loop that writes everywhere but only surfaces on one path.

What's **already right** (don't touch): the multi-agent / fan-out execution topology, the shared learning *store* (tool-choices remember + recall work on every path), the tool-agnostic substrate (search / recall / skill_read / $PATH / MCP), and the Phase-0 reliability just shipped (wall-clock recovery, honest report-back, between-turn checkpoint).

## Target shape — layers, not forks

```
Transports (thin I/O):   Desktop    Discord    Mobile    CLI    Cron/Webhook
                              \         |         |        |        /
                               ▼        ▼         ▼        ▼       ▼
                     ┌──────────────  ONE INGRESS / GATEWAY  ──────────────┐
                     │   auth · session · transport adapter · streaming     │
                     └───────────────────────┬──────────────────────────────┘
                                             ▼
                     ┌────────────────  ONE AGENT CORE  ────────────────┐
                     │  renderClemContext()   one self-assembler         │  ← constitution (small) + memory (heavy)
                     │  altitude router       ad-hoc · tracked · fan-out │  ← stops over-escalation
                     │  execution loop        parameterized + reliable   │  ← wall-clock recovery, checkpoint
                     │  learning loop         recall→act→remember→reflect │  ← never forgets
                     └───────────────────────┬──────────────────────────┘
                                             ▼ every run produces an
                     ┌────────────────  ONE Outcome  ───────────────────┐
                     │  {status, summary, artifacts, needs, nextStep}    │
                     │  deliverOutcome() → append to ORIGIN session      │  ← always fires; backstopped
                     └───────────────────────┬──────────────────────────┘
                                             ▼ transports render session turns
                              Desktop card · Discord msg · Mobile push  (same structure)
```

The unification is the **self, the entry, and the report-back** layers — **not** the execution topology. Single-loop chat and multi-agent fan-out remain two *modes* of the one core. Fan-out stays.

Session identity is the composition root around that core. Chat, a live workspace (`space-<slug>`), and a saved workflow (`workflow:…`) mount different tools and primers. They do not fork dispatch, invent a job type, or let memory grant reachability. Persistent memory accelerates; workspaces are live profiles; workflows are saved bundles. See [Blank-state universal execution §6.1](blank-state-universal-execution.md).

---

## Complexity budget — rigorous boundary, simple product

Clem should become simpler to use as execution becomes safer. Complexity is
allowed in one small host-owned kernel:

`accepted durable source → admitted graph → exact call authority → fenced physical reservation → receipt/read-back → one Outcome`

Each authoritative fact has one canonical production owner: accepted source,
semantics and graph, lease, logical call, physical crossing, evidence, and
terminal Outcome. Projections, indexes, caches, and UI views may be many, but
they are read-only and cannot authorize. Recovery resumes the same state
machine; it is not a second execution path. At the provider boundary, only a
current fenced reservation derived from the canonical graph lease and sealed
call authority permits I/O. A catalog match, role, name, replayed row, result
handle, or model/checker verdict is never separate permission.

Rigor scales with consequence; orchestration scales with breadth and duration:

- **Conversation:** durable turn → natural response. No capability search,
  task graph, verifier, or background run unless the user asks Clem to act.
- **Read-only work:** bounded discovery and sourced results, with checkpoints
  only when breadth or duration requires them. It does not inherit write
  reservation, reconciliation, or read-back ceremony.
- **Consequential writes:** exact capability and account binding, fenced
  dispatch, idempotency or reconciliation, a durable receipt, and the
  capability's declared verification contract—even for a one-line email.
- **Long-horizon work:** manifests, checkpoints, and fan-out wrap that same
  kernel. They do not introduce another safety boundary.

**Interactive user gates are exceptional.** Clem may interrupt and wait for the
user only when the next safe edge requires one of:

- a genuine discretionary choice among materially different acceptable
  outcomes;
- authority, a credential connection, or essential task input that only the
  user can provide;
- approval for an irreversible or destructive action not already covered by
  exact accepted or standing authority; or
- user verification or direction for an external effect that may already have
  committed and remains uncertain after exact reconciliation.

Conversation, authorized reads, and authorized reversible work proceed
autonomously. Ordinary model uncertainty, task size, tool use, generic risk
labels, and harness ceremony do not justify an interactive gate.

Deterministic host admission, capability/account/schema validation, fencing,
retry policy, evidence reduction, and reconciliation are execution controls,
not user-approval gates. They run without interrupting the user. When durable
facts select one safe edge, the harness proceeds or resumes automatically.
Otherwise it halts only the affected crossing, preserves progress and
uncertainty, and publishes a typed `blocked` Outcome. It publishes
`needs_input` only when one of the user-only conditions above is actually
required. A model or checker verdict cannot manufacture an approval
requirement.

**Nothing rests.** `blocked` is a transient state, never a destination. A run
that stops has not finished, so every non-terminal Outcome names the owner that
will move it and the condition that moves them: a dependency the host is
watching, a retry it has scheduled, or a specific person. A `blocked` Outcome
nobody owns is a stall, and a stall is a failure even when the copy is honest
and the ledger is intact — the work simply stops happening. Publishing an
accurate Outcome is the floor, not the goal.

Ceilings are the ordinary case, not an exception. Step, turn, token and
wall-clock limits are the harness reaching a checkpoint, not the work reaching
an end: the activation parks, the durable owner re-enters, and the task
continues. Asking a person to approve continuation spends their attention on the
harness's own bookkeeping. A long task should be able to run for hours across
many activations without anyone watching it, and the only thing that should ever
stop it for good is a real terminal Outcome or one of the user-owned conditions
above.

The lanes may share primitives, but they must not inherit identical ceremony.
The user should experience a faster, simpler Clem; machinery is visible only
when it produces a useful approval, progress update, artifact, or actionable
stop. Every `blocked` or `needs_input` Outcome says in ordinary language what
completed, what remains, why Clem stopped, whether an external effect may
already exist, the exact action or answer that unblocks it, and whether Clem
will resume automatically. Internal codes may supplement that explanation,
never replace it.

Every new validator, ledger, model pass, state machine, hop, or rollout flag
must enforce a named invariant that the existing kernel cannot. It must replace
overlapping authority or carry an explicit removal point. Dual registries,
untyped or mega-loop fallbacks, compatibility action paths, and permanent flags
cannot survive phase closure. Legacy data may remain readable through explicit
non-authoritative decoders; it may never mint new execution. The complete
consequential-write path must remain explainable on one page.

The shipping artifact is the truth. Acceptance boots a clean built or packed
candidate with source files and test registries absent, reconstructs durable
capabilities after restart, and crosses the same attested adapter, transport,
fencing, reconciliation, and evidence path production will use. A fake may
replace the remote service behind that boundary, never the boundary itself.

## Evidence-owned control plane — no completion judge

### Clementine is the hero; the harness is the guide

Clementine owns the reasoning, tool strategy, persistence, and human-facing
account of her work. The harness maintains the durable graph around her:
available tools, completed effects, receipts, checkpoints, approvals, budgets,
and unresolved dependencies. It may prevent an unsafe replay or point to the
next valid edge; it must not replace Clementine's useful result with its own
generic verdict.

Evidence is observed from runtime events, not demanded from the model as another
rigid response schema. A dependency pause must preserve the complete
model-authored progress report, name the exact remaining dependency, and resume
the same task from its checkpoint. Authentication, approval, missing input, and
temporary service availability are graph edges, not proof that all preceding
work failed. A user-facing fallback generated by the harness is an emergency
path only, and even that fallback must preserve progress, evidence, dependency,
and resume instructions.

The runtime should not need a second model to decide whether the first model
finished. A judge can be useful in an offline evaluation suite, but it is a poor
source of production authority: it adds latency and cost, can disagree with
valid work, and encourages another continuation after side effects may already
have committed.

This does **not** mean the host should interpret open-ended human language with
an expanding collection of regexes, keywords, and task nouns. Meaning belongs
to the model; authority belongs to the host:

- A configured brain may propose a typed relation to the conversation, goal,
  open question, and available capabilities.
- A bounded, tool-less semantic checker may identify conflict or uncertainty in
  that proposal. It cannot grant authority, choose a provider, execute work, or
  declare completion.
- The host loads the exact accepted source, active goal revision, visible
  question ids, standing policy, and capability catalog. It validates and
  freezes those identities without reinterpreting the user's prose.
- One bounded semantic repair is allowed when the typed proposal is malformed
  or conflicts with the accepted source. A participating semantic path that
  still cannot be admitted stops as `blocked`; it becomes `needs_input` only
  when the unresolved fact falls under the interactive-gate policy above. It
  never falls through to an untyped action path.
- Effect, destination, account, schema, and evidence authority come only from
  the accepted source plus host policy and frozen capability manifests. A model
  may request them but cannot mint or widen them.

The resulting split is deliberate: **the model authors semantics and the work
graph; the host admits exact identities, crossings, and evidence.** Host
classifiers may normalize literals, retrieve candidates, or conservatively
widen risk, but they must not use vocabulary to choose route, topology, slot
meaning, provider, effect, or completion.

### Model-visible means durably reconstructable

The session/event log is the source of truth for both conversation and model
execution. Anything that reaches a model must be reconstructable from durable
facts, byte-for-byte or through one canonical projection:

- accepted source text, identity, audience, account scope, and goal revision;
- bounded recent-turn and referenced-session context;
- open question/slot ids and the exact visible option ids;
- prompt/runtime-policy snapshots and capability descriptors;
- proposer/checker inputs, model identities, output records, usage, and
  latency;
- the final admitted proposal, catalog snapshot, graph, and their canonical
  digests.

No mutable registry, caller-provided text, presentation surface, ambient
process state, or unlinked later event may silently change the meaning of a
replayed turn. Replay loads the claim-linked record and verifies all source,
policy, catalog, proposal, and graph bindings. If the exact request cannot be
reconstructed, execution fails closed before a provider crossing.

Prompt and runtime-context changes should append sourced snapshots rather than
rewrite invisible state. This preserves auditability and prompt-cache stability:
the model sees the same durable prefix that the host can later prove it saw.

The shared delivery contract already exists in `src/runtime/outcome.ts`; what is
missing is a shared evidence reducer and richer evidence-bearing fields. The
production control plane should reduce durable facts into that `Outcome`:

- A tool call is work only after its typed result succeeds.
- An external mutation is complete only after its durable receipt commits.
- A created artifact is complete only after an exact-id read-back verifies it.
- A batch is complete only when every declared item has a terminal ledger row.
- A task is blocked when a typed tool result, exhausted budget, deterministic
  admission or reconciliation fact, or unresolved dependency says it is
  blocked. Blocking records who resumes it and when; an exhausted budget or
  ceiling resumes autonomously. `needs_input` is reserved for the
  interactive-gate policy above.
- Model prose can explain those facts, but cannot change them.

This leaves the model room to reason, choose tools, recover, and write naturally.
The harness intervenes only on facts it can know:

1. **No work happened:** one clean retry is safe.
2. **A consequential external effect may have committed:** never replay
   blindly. Reconcile through the canonical kernel. If durable evidence selects
   one safe edge, resume without asking; if the effect remains uncertain and a
   retry could duplicate it, preserve the state and request user verification
   or direction only when it cannot be obtained independently.
3. **The required evidence contract is satisfied:** publish `done`.
4. **The evidence contract is not satisfied:** publish `blocked` or
   `needs_input` (and add `progress` when a real lane consumes it); never
   manufacture a green completion.

Heuristic text detectors remain output hygiene, not completion authority. They
may suppress malformed protocol or recognize an explicit question, but they
must not erase evidence and convert a partial run into success. Runtime judges
can be retired as each lane adopts the same evidence-backed `Outcome` reducer.

### Durable long-horizon graph

Long-horizon work needs a persistent work map, not more prompt pressure. A
manifest declares the logical item universe once, gives each item a canonical
id, and records alternate labels (spreadsheet rows, account ids, worker names)
as aliases. Retrying `account-17` as `row-18` is another attempt at the same
item; it cannot inflate a 120-item task into 240 items. A genuinely larger scope
requires an explicit manifest extension.

The manifest also declares ordered phases such as research, merge, and
read-back. Each item/phase checkpoint carries typed evidence references to
artifacts, sources, external-write receipts, tool results, worker results, or
read-backs. Evidence-backed success is monotonic: a late failed duplicate cannot
erase it, and an undeclared worker label is reported as an anomaly rather than
silently becoming new scope.

Course correction versions the task contract on the same durable task and
session. The user chooses how old evidence crosses the version boundary:
preserve compatible evidence, revalidate questionable evidence (the default),
or invalidate evidence that must no longer count. A correction received during
a provider/tool call takes effect at the next model boundary so an in-flight
external write is never cancelled ambiguously. The stale-contract response is
kept as partial work, and late old-version checkpoints remain visible but cannot
clear the revised contract.

The UI and terminal report derive from this state:

- contract version and pending correction;
- current phase and logical completed/total counts;
- running, failed, revalidation, and invalidated work;
- evidence/artifact counts;
- stale and untracked attempts.

The model remains free to decide how to do the work and how to explain it. The
harness supplies durable identity, reconciliation, receipts, safe boundaries,
and visibility. Legacy runs may remain readable during migration, but
label-based coverage, prior workflow matches, and model verdicts cannot grant
new execution or completion authority when a typed semantic path participates.

### Progressive capability discovery and exact binding

Global capability does not mean putting every installed schema in every
prompt. Clementine discovers tools progressively:

1. Search a compact, host-issued catalog of stable capability summaries.
2. Return a bounded, relevance-ranked shortlist with exact capability ids.
3. Describe only the selected candidates with their typed schemas, effects,
   provider/account identity, input/output kinds, and evidence contracts.
4. Let the model propose graph operations referencing those exact ids.
5. Freeze the selected manifest set into the admitted run and revalidate it at
   every physical dispatch.

Names, roles, families, slugs, and task nouns may help rank candidates; none is
execution authority. Each executable node binds the exact provider operation,
schema/version/fingerprint, account, effect, destination posture, argument
compiler, invoke/reconcile implementation, and required evidence. A missing or
ambiguous binding blocks. Provider registration order and "the only available
writer" never select a consequential capability.

Capability implementation follows three explicit roles: a provider-neutral
service contract, one or more provider adapters, and a model-facing consumer.
Swapping a provider must not change what the model asks for, while the admitted
run still freezes the exact adapter that will cross the wire. Registrations are
scoped and lifecycle-owned, but scope affects visibility only; the frozen
manifest and call authority remain the security boundary.

### Conversation memory is a sourced capability

Clementine remembers broadly without silently stuffing prior chats into every
request. Previous-conversation access is model-driven and capability-mediated:

- search authorized session titles, summaries, and event indexes;
- follow a useful hit with an exact trace/read;
- copy selected context into the current session as a bounded, immutable
  snapshot carrying source session, capture sequence, freshness, omissions,
  and audience/account provenance;
- frame referenced conversation as untrusted data, never inherited
  instructions, permission, approval, or execution authority.

The current turn and its selected memory snapshot are logged separately. Later
source edits, compaction, or deletion cannot mutate replay of the target turn.
Facts promoted into long-term memory retain their source and freshness; recall
can suggest work but cannot authorize it.

### Compact prose; never compact authority

Long conversations need transactional compaction, not lossy state. A
compaction selects a stable, tool-pair-balanced historical range, logs a
start/summary/end bracket, cites every replaced source event, and replaces only
the model-visible surface. Raw events remain append-only and replayable. A
crash leaves a detectable incomplete bracket rather than a false success.

Only conversational prose and replaceable tool-result bulk may be summarized.
These remain lossless projections outside the summary:

- accepted goal, revisions, open slots, and continuation identity;
- admitted graph, node dependencies, item universes, and current cursor;
- capability/catalog bindings, policy, effect ceilings, and approvals;
- logical calls, physical dispatches, receipts, settlements, result handles,
  artifacts, and exact read-backs;
- unresolved dependencies, uncertain effects, blockers, budgets, and terminal
  Outcome state.

Compaction retries only after durable surface progress and must prove that it
reduced the request. It never invents completion, discards an open tool pair,
or turns an uncertain write into retryable work.

### Migration order

1. Extend the existing `Outcome` type with evidence/needs/next-step fields and
   add the shared reducer without changing transport copy.
2. Feed the reducer existing receipts: tool results, external-write records, artifact
   bindings, approval state, item ledgers, budgets, and cancellation.
3. Make chat, background, workflow, and cron publish through that reducer.
4. Run existing judges in shadow telemetry only and compare disagreements
   against the durable evidence; they cannot bounce or approve a run.
5. Remove runtime judge continuations and their prompt machinery after the
   evidence path passes the release gate.
6. Delete prompt rules made redundant by code, then simplify the system prompt.

Current migration status:

- Background-task terminal completion no longer calls `verifyDelivered`. Durable
  stop reasons, uncompensated external-write receipts, artifact bindings,
  successful deliverable returns, fan-out coverage, and deterministic readback
  now own that state transition.
- A call intention is not completion evidence. Ambiguous external mutations park
  with check-before-replay guidance; compensated writes do not count as done.
- Manifest-aware fan-out now reconciles canonical item aliases, phase
  checkpoints, typed evidence, and versioned contract corrections. Background
  completion and the cockpit read logical state directly; they do not invoke a
  fan-out judge or count worker attempt labels as new work.
- Optional cross-model Fusion is an advisory verifier node, never completion
  authority or a second executor. Clementine authors once; a distinct model sees
  a bounded request/evidence packet and may only accept the draft or return one
  evidence-backed correction. The runtime buffers and validates that verdict,
  preserves durable URLs/ids/coverage receipts, rejects runaway rewrites, and
  keeps Clementine's draft on timeout, invalid output, or checker failure.
- Remaining model-authority surfaces are explicit follow-up work: fan-out item
  demotion/inline-recovery for legacy non-manifest runs, foreground loop
  completion, gateway/cron delivery, and pre-write boundary judges.

### Release gate for the migration

No tag while any of these are red:

- focused characterization tests for every live failure fixture;
- root typecheck, build, isolated test suite, public-hygiene check, and proof
  self-tests;
- the Fusion-off live proof matrix for every configured brain, with exact-brain
  routing proven rather than silently passed by model fallover;
- mutation crash/retry tests showing zero duplicate external writes;
- a restart soak showing every accepted run reaches exactly one terminal
  `Outcome`;
- zero raw tool protocol in delivered or persisted replies, and zero `done`
  outcomes lacking their lane's required receipts;
- exact request-reconstruction tests proving every model-visible byte and
  capability descriptor comes from the durable, claim-linked source;
- capability-discovery tests with large distractor catalogs, exact-ref
  selection, provider/account/schema drift, and no role/name fallback;
- real-entry-path tests that boot the shipping composition and verify required
  capabilities are genuinely registered before claiming success, plus an
  extracted-package end-to-end test over the exact attested crossing path;
- world-state assertions (provider call/write count, exact artifact contents,
  unchanged controls), not acceptance of the model's or fixture's self-report;
- semantic-impossibility assertions independent of snapshots, so refreshing a
  deterministic transcript cannot bless `UNKNOWN_TOOL`, a missing provider, an
  empty collection, or a false completion;
- isolated test execution that proves the real home, credentials, contracts,
  event log, and external network were untouched unless a named live gate
  explicitly owns them;
- representative conversation, single-read, single-write, and long-run
  benchmarks reporting p50/p95 time to first useful response and terminal
  latency, input/output/cache tokens, model and provider calls, retries, and
  user-visible block rate against a frozen baseline, with an explicit
  regression budget for each lane;
- a risk × altitude fixture proving a one-off cannot enter tracked, fan-out,
  synthesis, or scheduled-review machinery unless admitted breadth, duration,
  or dependencies require it, while a light consequential write still uses the
  full write-safety kernel;
- an interactive-gate matrix proving zero approval prompts for conversation,
  authorized reads, authorized reversible work, deterministic admission, and
  determinate reconciliation; and exactly one typed `needs_input` for each
  genuine discretionary choice, user-only authority/credential/input,
  uncovered irreversible/destructive action, and unresolved
  possibly-committed external effect;
- a one-page authority trace from accepted source to terminal Outcome, with no
  alternate production invoker, writer, registry, fallback, or completion
  authority.

---

## The six moves (each maps to a goal)

### Move 1 — Prompt = Constitution (small, stable) + Context (learned, dynamic). Behavior lives in code.
*Goal: fast, lightweight, token-efficient; code does the heavy lifting.*

- **Constitution** = a tight system prompt: her voice + the non-negotiables
  (report back; proceed autonomously within accepted authority; ask only at an
  interactive user gate; never perform an uncovered irreversible or
  destructive action). Small and **stable → prompt-cached**
  (`prompt_cache_key` already keyed by session).
- **Behavioral RULE prose moves to code** (prompt rules rot — `[[feedback_code_level_over_prompt]]`):

  | Prose in `instructions.ts` today | Code home |
  |---|---|
  | "reached your budget… want me to continue?" | the Outcome / report-back layer (Move 4) |
  | "for large/risky work call surface_plan" | altitude router (Move 3) |
  | "tool behavior — just call them" | tool schemas already enforce this |
  | "sub-agent handoffs (researcher/writer/…)" | the execution loop already routes |
  | "background outcome report-back" (~650 chars) | the Outcome contract makes it structural |

- Net: the prompt drops from ~3.5k of rule-prose + duplicated context to a tight constitution + **one** scoped context block. The personality stays — it just stops being a checklist.

### Move 2 — One self-assembler. Personality & skills come from memory, not prose.
*Goal: she never forgets, always learns, gains personality + skills.*

- Collapse `buildAssistantInstructions` (`instructions.ts`) **and** `renderHarnessMemoryContext` (`harness-context.ts`) into **one** `renderClemContext(params)`. Every entry point and execution mode calls it → identical facts, recently-learned, remembered tool-choices, and voice everywhere. Kills the fork and the drift (today my P1-E ★-ranking only landed on the harness side).
- **Personality** grows from: `SOUL.md` seed + learned user-profile + reflection-captured voice — not a bigger prompt.
- **Skills** grow from the tool-choice store (procedural memory): learn what works for an intent, remember it, recall it.
- **Prior conversations** enter through sourced search/read/reference
  capabilities, not ambient prompt stuffing. The assembler renders only the
  bounded snapshots explicitly selected for this turn.

### Move 3 — One altitude router: ad-hoc · tracked · fan-out.
*Goal: handle any task, however long/hard — without over-escalating the trivial.*

- A one-off "send a test email" must **not** spawn a tracked execution + controller + synthesis + scheduled review (what `T-166` did). The configured brain proposes altitude and topology from the accepted turn; the host validates that proposal against observed effect, item, duration, policy, and capability facts without parsing task vocabulary. It routes:
  - **Light lane** (default): recall → act autonomously (interactive gate only
    under the policy above) → **log** → report. One turn. One-offs stay
    one-offs (`[[feedback_user_owns_workflow_designation]]`,
    `[[feedback_no_unrequested_workflow_runs]]`).
  - **Execution lane** (harness): genuinely long / multi-step work; inherits Phase-0 reliability + fan-out for breadth. Any task, however long/hard.
- The "audit record of a mutating send" instinct is **good** — keep it as a **lightweight log line**, not a managed execution.
- Altitude chooses orchestration, never safety. A light one-line write still
  crosses the same exact capability and write-safety kernel; it simply does not
  create a tracked workflow.

### Move 4 — One Outcome contract + one `deliverOutcome`.
*Goal: ALWAYS reports back, or asks for clarity — and all three transports share the same structure.*

- Define one type: `Outcome = { status: 'done'|'blocked'|'needs_input'|'failed'|'progress', summary, artifacts[], needs?, nextStep?, evidence }`.
- **Every** lane (chat turn, background task, workflow, cron) produces an `Outcome`.
- **Delivery = append a structured Outcome turn to the ORIGIN session.** The seed already exists: `enqueueWorkflowOutcomeTurn` (`workflow-runner.ts:2241`) + `originSessionId` threading. Transports already *render session turns*, so one structure → desktop card, Discord message, mobile push, with transport-specific formatting only.
- **The guarantees ("ALWAYS"):**
  - *No silent end* — if a run produces no Outcome, the watchdog emits a
    `failed`/`blocked` one.
  - *Gets user-only input without guessing* — a valid `needs_input` Outcome
    routes back to the origin conversation. All other ambiguity remains
    model/host recovery work rather than becoming an approval prompt.
- This is literally "all 3 paths share the same report-back structure."

### Move 5 — Close the learning loop reliably.
*Goal: never forgets, always learning.*

- **recall-BEFORE-discover** at the decision point, keyed on **toolkit + operation** (not the brittle query string that missed on 06-04: recalled `salesforce.query.email.audit`, memo was `salesforce.accounts.query_…`).
- remember-on-success / invalidate-on-failure (exist) + reflection → facts (exists), default-on, surfaced in the one assembler (Move 2).
- between-turn + cross-run checkpoint (Phase 0 started this) so long / interrupted work resumes from progress.
- promoted memories retain source event/session, audience/account provenance,
  observation time, and freshness policy. Learned procedure can rank a
  capability candidate but never bypass current schema/effect/account binding.

### Move 6 — Thin transports, one ingress, mobile nearly free.
*Goal: trim code; keep desktop + Discord, add mobile later; all sharing one report-back.*

- Transport adapters become **pure I/O**: receive → call the one core → `deliverOutcome`. No self-assembly, no business logic, no per-path report-back.
- **Retire the dual Discord handler** (`DISCORD_HARNESS_ENABLED`, `discord.ts` vs `discord-harness.ts`) → one Discord adapter on the one core.
- **Collapse the dashboard's mixed cores** → one desktop adapter.
- The **gateway/router** (`gateway/router.ts`) becomes the single ingress; **mobile is just another client of it** → mobile support is mostly free once the core is unified.

---

## More conversational, more personality

With **safety in code** (the gates) and **behavior in the Outcome layer**, the constitution can be **warm and characterful** instead of rule-laden — she reads as an assistant who *gets it*, not one reciting a checklist. **Conversational routing** (`[[project_conversational_routing]]`) — converse → autonomous work → ask only at an allowed interactive gate → report back — falls out of Moves 3 + 4. Personality **deepens over time from memory** (Moves 2 + 5), not from a longer prompt.

## Sequencing — additive migration, subtractive closure; fan-out untouched

| Phase | Move | Why this order |
|---|---|---|
| **0 (done)** | Reliability: wall-clock recovery, honest report-back, checkpoint, discovery advisory | Foundation; ship + soak |
| **1** | Move 4 — Outcome contract + `deliverOutcome` | Highest leverage; makes "always reports back" structural; unifies the 3 paths first |
| **2** | Move 2 — one self-assembler | Collapse the two; prove byte-identical characterization during cutover, then delete the old assembler |
| **3** | Move 3 — altitude router | Stop the over-escalation; one-offs stay light |
| **4** | Move 6 — thin transports; retire dual Discord + mixed dashboard; mobile adapter | Once core + report-back are unified |
| **5** | Move 1 — slim the prompt | **Last** — only delete rule-prose once its code home exists |

Each phase: bounded parallel operation → validated with characterization tests →
default-on → old writer/router/registry/fallback and rollout flag deleted. No
phase is closed while two paths can mint the same authority (no permanent
sprawl, `[[feedback_no_rollout_flags]]`). The multi-agent / fan-out topology is
untouched throughout (`[[feedback_no_architecture_churn]]`).

## North-star check (the five non-negotiables)

- **Ever-learning** ✓ Move 5
- **Long-running without failing** ✓ Phase 0 + Move 3 — and never-resting: a
  ceiling parks an activation, it does not end the task
- **Token-efficient** ✓ Moves 1 + 2
- **Global / no task-vocabulary routing lists** ✓ progressive, manifest-backed capability discovery
- **Reports back without fail** ✓ Move 4

Cross-cutting invariants beneath all five:

- **Reconstructable** — every model-visible input and every accepted semantic
  decision is recoverable from durable, claim-linked facts.
- **Provider-true** — every external crossing uses the exact frozen capability,
  provider operation, schema, account, effect, and evidence contract that was
  admitted.
- **Vocabulary-free host** — open-ended meaning and topology come from the
  model; deterministic code validates identity, policy, dataflow, durability,
  and evidence.
- **Lossless authority** — compaction and memory may summarize conversation,
  never goals, graphs, bindings, receipts, handles, blockers, or terminal
  state.
- **Single-owned** — each authoritative fact has one canonical production
  writer; recovery, compatibility, UI, and tests cannot create parallel truth.
- **Proportional** — safety scales with effect risk, while orchestration scales
  with breadth and duration; ordinary conversation never pays execution-lane
  ceremony.
- **Gate-minimal** — interactive user gates exist only for user-owned
  discretion or dependencies, uncovered irreversible/destructive action, or an
  unresolved possibly-committed external effect; deterministic host controls
  and authorized reversible work never prompt.
- **Never-resting** — no run stalls. Every non-terminal Outcome carries an owner
  and a resume condition; ceilings park an activation and re-enter rather than
  ending the task; only a terminal Outcome or a user-owned dependency stops work
  for good. A setting that promises continuation must be read by the code that
  continues.

> The over-engineering was never her prompts. It was the **machinery she drags a one-liner through**, and the **fork** that makes her two slightly-different people. Unify the self, route by altitude, report back through one structure — and trim the prose only after the code can carry the weight.
