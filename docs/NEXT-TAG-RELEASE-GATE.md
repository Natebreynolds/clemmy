# Clementine v3.16 safety gate and North-star conformance roadmap

Target: release candidate by Monday, August 24, 2026. This is a quality gate,
not a promise to publish on a date. A tag is created only when the candidate
below is reproducible from one clean commit.

Status: the Product claim through the provider-neutral matrix is a North-star
conformance roadmap, not a v3.16 blocker. The upgrade gate and candidate/tag
procedure remain binding v3.16 safety gates. The P1/P3 end-to-end mutating canary
becomes a v3.17 gate; this demotion changes claims, never safety or CI coverage.

## Product claim

A new user with an empty memory can ask Clementine to complete an unfamiliar
task with any currently connected MCP, CLI, Composio capability, built-in, or
recording source. Clementine discovers the live capability, validates its
current schema/account/effect, executes through one shared call kernel, and
reports only receipt-supported results. Prior use may make discovery faster,
but memory never grants authority and blank memory never makes a supported task
impossible.

Ordinary foreground work uses one host-owned loop:

```text
accepted turn
  -> context + live catalog
  -> canonical model step
  -> authorized call batch
  -> settled receipts
  -> canonical model step
  -> one terminal outcome
```

A durable graph is promoted only when explicit state is operationally useful:
the work outlives the activation, has independently retryable branches,
requires a durable approval/input/dependency boundary, is scheduled/reusable,
or needs item-level recovery and merge. Tool count alone does not create a
graph. Workflow nodes call the same call kernel as foreground chat.

The competitive harness bar is explicit: foreground chat must remain as
legible and direct as the Hermes and DeepSeek loops, with independent calls
using bounded fan-out and deterministic result order. Clem must exceed both at
live external-effect authority, uncertain-write reconciliation, durable
workflow resume, canonical entity truth, honest coverage, consent lineage, and
upgrade safety. See `HERMES-HARNESS-RESEARCH-2026-08-22.md` and
`DEEPSEEK-HARNESS-RESEARCH-2026-08-22.md`.

### Executable competitive conformance roadmap

Architecture prose is not release evidence. Every row below is a required
journey or generated cohort, and a component test may not substitute for it.

| Claim | Exact release evidence | Numeric boundary |
|---|---|---|
| Plain conversation and text-only creation are simpler than an agent harness | A generated cold-home cohort of greetings, conversation, explanations, arithmetic, writing, rewriting, brainstorming, and other answer-in-text requests through the ordinary foreground bridge | exactly one primary-model request; zero semantic/planner, catalog, discovery, memory-embedding, or tool calls; zero advertised tool-schema bytes; p95 host overhead no more than 50 ms above the recording model |
| Model-visible context is reconstructable durable truth | A recording adapter snapshots every request, the process restarts, and an independent projector rebuilds the same accepted input, preamble, verified memory hints, disclosed capability refs, settled results, and tool schemas from durable rows | byte-identical normalized request digest at every model step; every injected block names durable provenance; no unlogged prompt mutation, hidden planner output, ambient memory, or provider result |
| Cold unfamiliar work is one foreground reasoning loop | `src/journeys/restaurant-sheet-natural-request.integration.test.ts` using the exact Discord request, a blank capability memory, live connected definitions, and recording providers | zero hidden model calls; at most one bounded discovery call per unresolved role; no mandatory plan or DAG for bounded foreground work; zero user stops; exactly one aggregate read and one create-new Sheet effect; one terminal |
| Verified memory buys efficiency but never authority | `src/journeys/harness-memory-efficiency.acceptance.test.ts`, followed by the same natural journey warm | warm discovery calls and routing bytes are strictly lower; no schema refresh when the live fingerprint matches; memory lookup/render changes zero authority or ledger rows; physical crossings remain identical |
| Prompt caching reduces spend without freezing stale truth | A recording transport compares normalized request layers across cold/warm turns, policy revisions, memory changes, and catalog drift | identity/rubric prefix digest stays stable until its explicit revision changes; volatile memory/catalog/task blocks cannot invalidate the stable prefix or survive a live revision mismatch; cached and uncached usage are recorded; the verified warm natural journey uses at most 70% of the cold journey's uncached input tokens |
| Multi-call work beats sequential-only loops without racing effects | `src/journeys/long-task-competitive-acceptance.red.test.ts` plus a timed generated cohort | four independent 100 ms reads finish within 180 ms p95 and reinsert in call order; declared dependency waves remain ordered; two same-resource 100 ms mutations have peak concurrency one and take at least 190 ms |
| Long trajectories stay compact and lossless | The same long-task journey plus result-handle/compaction suites | 84 steps remain at most 24K estimated model-visible tokens and 96 KiB; every collapsed call ID is addressable; identical results have one visible canonical copy; authoritative payloads larger than 8 MiB spill and redeem byte-exactly after restart |
| Complex fan-out spends tokens deliberately | A generated 100-item `run_worker` cohort with repeated shared context, distinct item facts, restart, partial failure, and budget exhaustion | each worker receives only the shared packet plus its item/dependencies; the parent sees bounded result envelopes rather than 100 raw transcripts; cached and uncached usage are accounted separately; aggregate uncached use never exceeds the durable run window; unstarted items are reported as not attempted, never silently dropped or claimed complete |
| Restart never repeats settled work | `src/journeys/harness-restart-kernel-parity.red.test.ts` and real-process crash points before reservation, after claim, after return, and after settlement | returned reads and committed writes cross the provider once; claimed/unknown writes hold for reconciliation; settled results are adopted with zero new model, lease, body, physical row, or result handle |
| Chat and workflows use one effect kernel | The parity journey plus every workflow execution adapter, including structured calls, pagination, and learned-memory hints | identical logical-call, call-lease, physical-claim, settlement, evidence-handle, and terminal vocabulary; memory performs zero provider I/O; no workflow-specific direct-dispatch lane |
| Discovery remains bounded at provider scale | A generated permutation cohort with 10,000 live distractors and two relevant operations | initial planning surface at most 16 KiB; one search returns at most eight exact refs; correct refs selected for 100/100 order/name permutations; combined discovery/schema context at most 32 KiB; zero business I/O before exact call admission |
| User stops correspond to real missing authority | A balanced generated corpus of conversation, reads, reversible creates, irreversible effects, missing credentials, and genuine choices | zero stops for conversation, admitted reads, and one exact reversible create; exactly one typed stop for a genuinely user-only choice, uncovered irreversible effect, or uncertain write; p95 questions per request at most one |

The product may not claim North-star conformance for a row that is unimplemented,
skipped, marked TODO, or green only because the fixture preselected a source,
seeded historical authority, removed realistic provider arguments, injected a
plan, or bypassed the ordinary channel/bridge/model/call path.

## North-star acceptance workload roadmap

The representative workload is a large recurring entity dataset. A user can
describe:

- a population to cover;
- partition dimensions and ordering;
- fields to collect and optional enrichment sources;
- canonical identity and duplicate handling expectations;
- a recurring cadence;
- a visual workspace for progress, records, provenance, and review.

Clementine must turn that into this provider-neutral lifecycle:

```text
reviewable opportunity
  -> material questions
  -> representative disabled pilot
  -> user review
  -> approved workflow + bound Space
  -> partition enumeration
  -> observations with provenance
  -> normalization
  -> deterministic entity resolution / quarantine
  -> idempotent canonical upsert
  -> honest coverage reduction
  -> trusted visual projection
  -> scheduled next occurrence
```

The workload is an acceptance example only. No business entity, data source,
provider, destination, city, application, or tool slug may appear in harness
routing, authority, scheduling, deduplication, or completion logic.

## Non-negotiable invariants

### One execution authority

- One accepted source and attempt own the turn.
- Foreground and workflow calls share one call-authority algebra, logical-call
  ledger, physical-dispatch ledger, settlement protocol, and terminal
  committer. A foreground root is bound to its exact accepted user source and
  attempt. A workflow root is bound to its exact workflow revision, occurrence,
  node plan, and attempt. Neither impersonates the other or invents identity.
- A foreground call never needs a fake graph. A graph call never loses its
  graph expected-work contract.
- There is no effect-capable fallback into an SDK-owned or legacy loop.
- OpenAI, Claude, and BYO adapters return canonical model steps; they do not
  own tool execution, retries, approval, or completion.

### Live capability truth

- The current catalog, schema fingerprint, account binding, and effect class
  are checked at use time.
- Memory, recipes, aliases, and specialty profiles are ranking hints only.
- Empty memory can discover and bind a current capability.
- A renamed or removed capability self-heals through live discovery or stops
  with an actionable typed dependency; it never silently substitutes an
  unrelated operation.
- Provider and tool names remain outside kernel decisions.

### Consequence safety

- Model call identity and exact argument bytes are admitted before execution.
- Approval occurs before a consequential physical crossing.
- Each call has a bounded cancellation/deadline owner and a dispatch lease.
- Timeout after a possible write becomes uncertain/reconcile-only and is never
  blindly replayed.
- Crash after provider acknowledgement reconciles exactly once.
- Rejected, partial, malformed, filtered, or provider-failed model output is
  absent from durable replay history.

### Durable-project consent

- Clementine may suggest that work would benefit from a background workflow
  and Space.
- Detection creates a reviewable proposal, not a workflow and not a schedule.
- Missing material inputs produce one typed question.
- A representative pilot is disabled by default and runs only with the
  required read/write authority.
- Proposal approval authorizes review of a disabled pilot; it does not schedule
  work. A pilot needs its own exact authorization, and recurrence is enabled
  only after receipt-backed pilot success plus separate user consent bound to
  the same proposal revision and digest.
- Elapsed interval recurrence is represented directly. It carries an exact
  activation anchor, duration, overlap policy, catch-up policy, and stable
  occurrence identity; it is never translated into a guessed cron expression.
- Changing the schedule, effects, sources, identity policy, or deliverables
  invalidates prior approval.

### Canonical records and coverage

- Provider results enter the canonical store only through a closed, versioned,
  human-reviewed projection contract that binds the record collection path,
  field paths and types, source-record identity, entity identity rules,
  provenance, resolution policy, partition identity, and hard record/page/byte
  ceilings. Tool names, model prose, and UI bindings are never ingestion
  authority.
- Every ingested page redeems an exact settled result handle from the workflow
  call ledger. Its observation batch, coverage page, and workflow-lineage
  receipt remain digest-bound to the same workflow revision, occurrence, node,
  attempt, capability binding, result handle, and approved projection contract.
- Source observations are immutable and carry field-level provenance,
  confidence, and observation time.
- Exact identifiers and normalized compound signals are distinct evidence
  classes. Fuzzy evidence alone cannot silently merge ambiguous entities.
- Conflicts retain every source value; deterministic policy either selects a
  canonical value or sends the candidate to a review queue.
- Batch/upsert replay is idempotent and canonical keys are not evicted by an
  arbitrary bounded cache.
- Coverage declares its denominator or exhaustion evidence. `all`, `every`,
  `none`, and equivalent universal claims are forbidden for partial or unknown
  coverage.

### Workflow and Space ownership

- Workflow owns execution, scheduling, checkpoints, retries, and recovery.
- Space is a bound, rebuildable visual projection and review surface; it is not
  a second scheduler or executor.
- Workflow-to-Space binding is explicit, never inferred from prompt text.
- Large records live in a paginated/queryable store or bound external sink,
  not one rewritten JSON document.
- Events reference artifact/observation IDs rather than embedding unbounded
  records or PII.

### Desktop and surface ownership

- Chat, approval cards, workflow status, Space progress, provenance, review,
  and recurrence state are projections of canonical engine events and stores.
- The desktop does not infer lifecycle from assistant prose and does not own a
  second scheduler, retry loop, approval state machine, or completion reducer.
- UI work follows the green chat/workflow vertical. It may improve visibility
  and control, but it cannot be used to hide or compensate for engine defects.
- Every surface projects the same typed `done`, `needs_input`, `blocked`,
  `held`, `cancelled`, `failed`, `uncertain`, and `transferred` truth.

## Required provider-neutral conformance matrix

All framework fixtures use generated capability and field names. The same
test is rerun with permuted names, catalog order, carrier kind, and memory
temperature.

1. **Foreground cold read** — empty home, one live capability, exact account,
   two pages, one terminal, complete receipt, no graph.
2. **Foreground fan-out** — several independent reads execute concurrently;
   results enter history in deterministic call order and share one authority
   root.
3. **Foreground dependent calls** — model uses a settled result to form a
   later call without premature graph promotion.
4. **Approval/resume write** — exact pause state survives restart; one approved
   write and readback occur once.
5. **Unknown write outcome** — crash/timeout after dispatch produces an
   uncertain settlement, reconciles, and never duplicates the effect.
6. **Cold/renamed/removed capability** — blank, warm, stale, and unavailable
   variants converge or stop actionably without unrelated substitution.
7. **Carrier substitution** — equivalent fake MCP, CLI, and gateway adapters
   yield the same canonical calls, receipts, and outcome.
8. **Durable proposal** — structural long-work evidence produces a reviewable
   AutomationOpportunity; ordinary chat and bounded work do not.
9. **Consent boundary** — proposed/reviewed/pilot states create no schedule;
   only the exact approved revision can enable recurrence.
   An every-N-hours variant starts one interval after its exact activation,
   survives restart without duplicate occurrences, and obeys its explicit
   overlap/catch-up policy.
10. **Large partition run** — more than 10,000 item keys survive restart,
    backpressure, retry, and occurrence deduplication without eviction.
11. **Typed result ingestion** — an approved result-projection contract redeems
    ordered durable page handles into canonical observations, batches, and
    coverage receipts. A crash between provider settlement, batch commit,
    coverage commit, lineage publication, terminal publication, and Space
    projection converges without provider redispatch or duplicate records.
12. **Entity resolution** — exact match, strong compound match, conflict,
    ambiguity, distinct entities, and replay preserve provenance and audit.
13. **Honest coverage** — missing page, repeated cursor, bounded budget, and
    unknown denominator prohibit universal claims.
14. **Space projection** — workflow progress, declared partitions, failures,
    records, provenance, and duplicate review rebuild from durable truth after
    restart; Space performs no execution.
15. **Cross-surface parity** — desktop, Discord, mobile, CLI, and cron project
    the same typed outcome and do not select another execution engine.
16. **Production blank-state carriers** — real adapter-shaped fake MCP, CLI,
    and gateway enumerators (with no seeded manifest, resolution, or invoke
    port) materialize through the same live definition boundary and then cross
    the shared workflow kernel. Index-only discovery is not a passing result.

## Upgrade gate from v3.14

The candidate is rehearsed against a disposable copy of a real or sanitized
v3.14 home before it is installed over any user home.

- Preserve credentials/configuration, conversations, memory, workflows,
  Spaces, schedules, approvals, and artifacts.
- Run memory, harness, workflow-trigger, and Workspace migrations to current
  versions with foreign-key and integrity checks.
- Retain a recoverable pre-migration snapshot and never mutate the source used
  for rehearsal.
- Reconcile or explicitly quarantine pre-upgrade active attempts, approvals,
  dispatches, and schedule occurrences; never infer that an old write is safe
  to replay.
- Boot the packaged candidate twice against the migrated copy. The second boot
  must be idempotent and must not repeat migrations, work, or notifications.
- Exercise one old conversation, one old workflow, one old Space, one new cold
  foreground turn, and one newly approved durable project.

## Candidate and tag procedure

The tag is withheld unless every item is true:

- the intended work is one reviewed clean commit (or a reviewed, documented
  commit series) with no untracked runtime source;
- typecheck, focused invariant suites, full isolated suite, build, fresh-install
  smoke, v3.14 upgrade rehearsal, packaged-app smoke, and release-asset tests
  pass from that exact commit;
- no required test was weakened, renamed into a different contract, silently
  routed through a test-only lane, or made vacuous;
- every claimed capability has a production entrypoint and at least one
  production caller; a green helper, adapter, compiler, projection, or test-only
  vertical with no reachable owner does not satisfy an end-to-end gate;
- a restarted development daemon reports the exact candidate fingerprint;
- fresh interactive chat selects the host-owned engine by default from the
  persisted accepted-turn boundary; `legacy_sdk` is rolling-upgrade resume
  compatibility only and cannot receive a new effect-capable turn;
- v3.16 live canaries progress in order: no-tool, bounded read, then paginated
  read. Approval/resume write, the durable pilot, and the P1/P3 end-to-end
  mutation canary are explicitly deferred to the v3.17 release gate;
- every canary has one accepted source, one owner, exact logical/physical
  settlements, one terminal, no legacy re-entry, and no open lease/attempt;
- the packaged build fingerprint, `origin/main`, release commit, and tag SHA
  match; package and desktop versions equal the tag;
- rollback/update artifacts are available and the release notes name any
  intentionally deferred capability honestly.

Hard stop: any unadmitted physical crossing, unsupported universal claim,
duplicate effect, unresolved active owner, test/build/source fingerprint
mismatch, provider-noun branch in the kernel, or migration data loss blocks the
tag regardless of the calendar.
