# Northstar Harness Stabilization and Release Handoff

Date: 2026-08-31

Branch observed: `wave/one-gate-and-hardcode-subtraction`

Observed HEAD: `81b7e2f7c832c3bd64dc7852171daaca6469103e`

Target: a clean, tested, packaged release candidate suitable for tagging after user acceptance

Audience: the next engineering agent taking ownership of the harness, workflow runtime, recovery graph, and release closure

## Read this first

This document is the handoff for the failures observed in real chats and workflows on 2026-08-31, the changes attempted in response, the remaining root causes, and the shortest responsible path to a release candidate.

The blunt conclusion is:

> **Do not tag the current tree.** Many important framework defects were fixed and the broad local suites are substantially greener, but the latest real Platform 49 workflow still stopped before its first write, the focused hard-cut async recovery journey is red, authored sends are not proven through the unified host-consent lane, the newly typed Friday dashboard migration has never passed its creation/live test, and the worktree is far too dirty to identify a trustworthy release artifact.

This is not primarily a Slack, Google Sheets, Salesforce, or Friday-dashboard problem. The repeated failures came from translation and ownership seams between independently evolved runtime layers:

```text
accepted source
  -> semantic interpretation
  -> planning card / graph
  -> capability discovery and catalog
  -> schema projection
  -> workflow/user authority and consent
  -> accepted model batch
  -> logical and physical dispatch
  -> settlement truth
  -> bounded recovery / no-progress
  -> workflow output contract
  -> terminal, report-back, mobile replay, notification
```

The correct direction is provider-neutral and workflow-neutral. Do not add production exceptions for Platform 49, Slack, Sheets, Salesforce, a particular account, or a particular schema field.

## Morning release path: first 90 minutes

This is the shortest responsible starting sequence. It is not a promise that every item can be completed in 90 minutes; it prevents the receiving agent from spending the morning on post-tag architecture before reproducing the two red release paths.

### Minutes 0–15: freeze and prove current safety

1. Read this document’s executive state, canonical blocker table, latest Platform run, and hard-cut section.
2. Record the current branch, HEAD, dirty counts, daemon PID/fingerprint, and active run IDs.
3. Run the read-only harness safety queries in the operational runbook below.
4. Do not stop/restart if there is an unfinished attempt, a `started` physical dispatch, an active dispatch lease, or a current business mutation requiring reconciliation.
5. Assign ownership for the nested-schema, hard-cut, and release-inventory slices. Do not overlap their production files.

### Minutes 15–60: close the exact latest live seam

1. Add one provider-neutral production-lane nested-schema red test.
2. Implement bounded recursive repair material and make the recovery surface derive from the same typed edge.
3. Prove bad args have zero crossing, corrected args cross once, and settled replay crosses zero more times.
4. Run the focused host/schema/authority suites and typecheck.
5. Do not restart for a live canary until this causal slice is green.

### Minutes 60–90: establish the remaining release path

1. Rerun the exact PID A→B→C hard-cut test.
2. If still red, instrument component digests and assign the cross-PID identity drift as the next P0. Do not loosen equality.
3. Inventory enabled authored-send and raw-runner workflows so the release scope decision below is factual.
4. Decide which conditional features are proven in the beta and which are explicitly quarantined/disabled.
5. Only then schedule the stopped-daemon full matrix and next live canary.

### Canonical blocker and scope decision table

Every later priority list in this document refers back to this table.

| Capability / blocker | Default beta decision | May be quarantined? | Evidence required to include it |
|---|---|---|---|
| Nested schema repair and ordinary workflow write | **Mandatory** | No, if workflows can write | Generic bad-nested-args → repair → one crossing test and full Platform 49 live pass |
| Cross-PID hard-cut recovery | **Mandatory for Northstar restart/resume claim** | Only by disabling/excluding durable auto-resume | PID A→B→C exact journey through settled PID C |
| Workflow-internal recursive named dispatch | **Mandatory while scheduled/model steps are enabled** | Only by disabling affected workflows | Internal accepted source cannot lexically self-dispatch; explicit typed workflow call still works |
| Structured invalid-input settlement on every tool lane | **Mandatory** | No | BYO/local/MCP/SDK invalid args all refuse or settle failure structurally at zero body; never `succeeded` |
| Authored workflow send | Conditional on enabled workflows/release claim | Yes, only if affected workflows are enumerated and disabled/quarantined | First-run, scheduled, approval, restart, destination drift, and exactly-once `host_v1` tests |
| Friday typed migration | Not currently proven | Yes | Resolve contradictory readiness, then one successful creation/manual test; otherwise disable/quarantine it explicitly |
| Salesforce → Sheet compound work | Default **mandatory** because it was a user acceptance path | Only with an explicit beta limitation | Exact Salesforce query + Sheet create/populate/readback + one report-back |
| Native mobile push | Optional; transcript replay is separate | Yes | Registered device and real background push receipt; otherwise do not claim push |
| Renewable capability leases | Conditional for this tag; architectural P1 if current JIT path survives long canaries | Yes, only with a tracked limitation and >60s live canary | Fake-time renewal tests and/or exact long-running pre-crossing revalidation evidence |
| Reaper historical residue | Conditional if active-effect safety is proven | Yes as tracked P1, not silently | Zero active attempts/started dispatches/leases plus classification of stale rows and no replay owner |

Platform 49’s current `notify_user` control is not, by itself, proof of the external authored-send lane. Determine the actual effect/destination class from the immutable workflow definition before deciding whether authored-send closure is required for that canary.

## Handoff objective

The next agent should:

1. Preserve the exact evidence from today before changing code or restarting anything.
2. Close the remaining framework-level recovery and authority seams described below.
3. Add causal, provider-neutral production-lane tests for each seam.
4. Run the exact live canaries from a freshly built candidate.
5. Inventory and commit only intended files and emitted artifacts.
6. Perform the clean packaged install, two-boot upgrade rehearsal, and release closure.
7. Start the dev daemon for user testing only after the code and active-run state are safe.
8. Tag only the exact clean commit that passed the packaged and live canaries.

## Navigation

- [Morning release path](#morning-release-path-first-90-minutes)
- [Executive state](#executive-state)
- [Evidence sources and conventions](#evidence-sources-and-conventions)
- [Why the work kept moving from one wall to the next](#why-the-work-kept-moving-from-one-wall-to-the-next)
- [Current repository and release state](#current-repository-and-release-state)
- [User-visible incident summary](#user-visible-incident-summary)
- [Detailed incident record](#detailed-incident-record)
- [Platform 49 chronology](#platform-49-chronology-each-repaired-wall-exposed-the-next-framework-seam)
- [Hard-cut async recovery](#hard-cut-async-recovery-the-focused-acceptance-is-currently-red)
- [Harness failure map](#harness-failure-map)
- [Immediate code seams](#current-code-seams-for-the-two-immediate-blockers)
- [Northstar architecture recommendation](#northstar-architecture-recommendation)
- [External framework research](#external-framework-research-and-how-it-applies)
- [Prioritized implementation plan](#prioritized-implementation-plan)
- [Required tests](#required-tests-before-another-user-retest)
- [Live canary sequence](#live-canary-sequence-after-the-causal-fixes)
- [Release closure and tag checklist](#release-closure-and-tag-checklist)
- [Remaining backlog](#remaining-backlog-by-priority)
- [Explicit anti-patterns](#explicit-anti-patterns)
- [Suggested agent operating procedure](#suggested-agent-operating-procedure)
- [Copy/paste brief](#copypaste-brief-for-the-receiving-agent)
- [Appendices](#appendix-a--key-run-records)

## Executive state

### What is materially better

The current source contains generic fixes for all of the following:

- Workflow-name typo correction can preserve the original run imperative and dispatch the uniquely corrected workflow without replaying the old question.
- Mobile delegated workflow messages are source-bound and can survive leave/reopen and overlapping foreground turns.
- Mobile Stop targets exact delegated run IDs and is rendered only in the expanded work detail as a compact circular control.
- Exact external workflow capabilities can be hydrated on a cold process from immutable authored operation IDs, provider definition, account, schema, effect, and manifest identity.
- Successful provider reads inside the trusted `{ result, complete: true }` adapter carrier can settle as success instead of `unknown`.
- Provider-ready arguments can be validated before physical dispatch, with invalid calls refused at zero crossing.
- Ordinary non-destructive authored workflow writes can receive an exact `standing_workflow_scope` grant tied to the immutable workflow definition, source, step, account, schema, destination, arguments, accepted batch, and current run.
- A workflow model that stops in prose without calling `workflow_step_result` can be continued in the same source and same host activation, bounded and without repeating uncertain writes.
- Long compound workflow prompts no longer collapse their planning effect ceiling to `read` merely because they contain read instructions or negated write examples.
- Scheduled raw-runner incompatibility is recorded as one truthful `blocked_readiness` migration hold instead of retries followed by a false “daemon unavailable” catch-up prompt.
- Workflow origin report-back and mobile terminal projection have much stronger exactly-once/source-bound behavior.
- The isolated test transport now honestly implements exact operation/account preparation instead of bypassing the production invariant.

### What is still release-blocking

1. **Nested schema repair is internally contradictory.** The validator knows the recursive schema, but the repair exposes only top-level field names, recommends `tool_search`, and the no-progress lane then restricts the model to the failed provider operation. The latest live Platform 49 run ended here with zero writes.
2. **Hard-cut async recovery is red.** A new PID claims the orphaned continuation but cannot re-attest the frozen catalog snapshot, stopping on `catalog_snapshot_identity_mismatch` before the missing GET or Workspace write.
3. **Authored sends are not proven through `host_v1`.** The workflow runner sets legacy `allowAnySend`, while unified host consent owns mutations, the new authored evaluator intentionally returns `null` for send/delete/admin, and the legacy approval predicate is skipped once consent is marked owned.
4. **The Friday dashboard was migrated on disk but is not proven.** Its current saved definition has six typed Salesforce reads, one bounded transform, and one reviewed `space_set_data` write. It has never passed its creation/live test, and current readiness evidence is contradictory.
5. **The Salesforce-to-Sheet request has not passed an end-to-end retest.** The discovery/role fixes are locally green, but no evidence shows Salesforce query + Sheet creation/population + report-back succeeding together.
6. **The worktree is not a release candidate.** It contains 186 changed tracked files, 56 untracked entries including this handoff, more than 28,000 changed tracked lines, deleted old emitted artifacts, and untracked replacement production artifacts.
7. **Workflow-internal text can be mistaken for a new named-workflow run request.** The scheduled Scorpion workflow was recursively intercepted because its step mentioned a “prior run.”
8. **Structured invalid local-tool input can still settle as success on the BYO lane.** The scheduled end-of-day workflow passed literal string `"null"` values, received `InvalidToolInputError`, and the harness recorded `local_execution/succeeded` before terminalizing later.

### Safe claim boundary

The strongest responsible claim today is:

> Direct named workflow dispatch, provider reads, cold exact catalog preparation, and ordinary non-destructive authored workflow writes have broad targeted coverage. Full nested-schema recovery, hard-cut recovery across PIDs, authored sends, raw-runner migration, and clean packaged release closure remain open.

Do not tell the user “any workflow will run now.” That is not supported by the evidence.

## Evidence sources and conventions

Primary local evidence:

- Workflow run records: `~/.clementine-next/workflows/runs/<run-id>.json`
- Harness SQLite database: `~/.clementine-next/state/harness.db`
- Daemon log: `~/.clementine-next/logs/daemon.log`
- Workflow runtime: `src/execution/`
- Host runtime and settlement: `src/runtime/harness/`
- Semantic admission: `src/runtime/semantic-boundary/`
- Capability/read path: `src/runtime/read-path/`
- Mobile web client: `apps/mobile-web/`
- Shared chat engine: `packages/chat-engine/`
- Existing release gate: [`NEXT-TAG-RELEASE-GATE.md`](./NEXT-TAG-RELEASE-GATE.md)
- Existing upgrade rehearsal: [`V314-UPGRADE-REHEARSAL.md`](./V314-UPGRADE-REHEARSAL.md)
- Existing Hermes research: [`HERMES-HARNESS-RESEARCH-2026-08-22.md`](./HERMES-HARNESS-RESEARCH-2026-08-22.md)
- Current release notes: [`releases/v3.16.0.md`](./releases/v3.16.0.md)

Timestamps in the incident sections are UTC unless marked otherwise. On 2026-08-31, Pacific time was UTC−7.

“Zero crossing” means the durable logical/physical ledger proves the provider or mutation body did not start. “No uncertain effect” means there is no in-flight, storage-error, or uncertain-write settlement requiring reconciliation.

Unless explicitly stated otherwise, “zero mutations” or “zero external effects” in a workflow-cause paragraph means zero intended business/provider mutations from that workflow step. Canonical terminal/outbox notification delivery is a separate external effect and did occur for some failed runs.

## Why the work kept moving from one wall to the next

The failures felt circular because the development loop repeatedly removed the first visible gate without a single acceptance journey covering the entire real lifecycle:

```text
cold boot
  -> accepted mobile source
  -> exact workflow selection
  -> catalog hydration
  -> paginated reads
  -> nested schema repair
  -> authored write consent
  -> one physical write
  -> readback / refresh
  -> workflow_step_result
  -> source-bound terminal
  -> leave/reopen replay
  -> daemon restart
  -> settled replay with no duplicate effect
```

The broad local suites were useful, but several important gaps remained:

- Helper-level tests proved individual validators and grants but not their composition through the production `host_v1` lane.
- Tests often stopped at the first repaired seam, while the real workflow immediately exposed the next one.
- The runtime produced a repair message from one subsystem and a permitted recovery surface from another; nobody asserted that they agreed.
- The model was forced to infer nested provider shapes from lossy diagnostics even though the host already held the exact schema.
- Catalog, scope, consent, settlement, no-progress, and terminal layers each carried overlapping versions of the same fact.
- Test isolation sentinels could not certify the real home while the live daemon owned it. Test bodies ran in disposable homes, but the full live-home isolation guarantee was not obtained.
- The candidate remained a very large dirty worktree, so it was possible to run against source or artifacts that were not yet represented by a clean commit.
- Live workflow prompts grew very large. The latest run composed roughly 52,659 tokens before the final repair attempt, increasing latency and making model-side schema guessing worse.

The solution is not to remove safety gates. The solution is to make every safely recoverable refusal return a host-owned, typed, executable recovery edge inside the same durable task.

## Current repository and release state

Observed at 2026-08-31 17:29 PT / 2026-09-01 00:29 UTC. Counts, daemon PID, and active-run state are ephemeral and must be refreshed by the receiving agent.

| Item                  | State                                      |
| --------------------- | ------------------------------------------ |
| Branch                | `wave/one-gate-and-hardcode-subtraction`   |
| HEAD                  | `81b7e2f7c832c3bd64dc7852171daaca6469103e` |
| Package version       | `3.16.0`                                   |
| Local `v3.16.0` tag   | Absent                                     |
| Tracked files changed | 186                                        |
| Untracked entries     | 56, including this handoff                 |
| Tracked diff          | 20,745 insertions / 7,518 deletions        |
| Upstream              | None configured for this branch            |
| Tag readiness         | **No**                                     |

Critical untracked production files include:

- `src/execution/workflow-step-external-catalog.ts`
- `src/runtime/harness/authored-workflow-write-authority.ts`
- `src/runtime/harness/accepted-source-catalog-scope.ts`
- new continuation, schema, workspace, and execution modules
- replacement digest-addressed emitted `.cjs` artifacts

Critical untracked regression files include:

- `src/execution/workflow-step-external-catalog.test.ts`
- `src/runtime/harness/authored-workflow-write-authority.acceptance.red.test.ts`
- `src/execution/workflow-scheduler-readiness-block.test.ts`
- `packages/chat-engine/src/delegated-stream.test.ts`
- `apps/mobile-web/src/components/RunControl.test.ts`
- `src/runtime/semantic-boundary/workflow-name-correction-continuation.test.ts`

The implementation artifact transition is especially risky:

- Old tracked hash-named artifacts are deleted.
- New hash-named artifacts are untracked.
- `manifest.json` and `build-stamp.json` changed.
- A partial or careless commit could point the release manifest at files absent from the tag.

Do not use `git add -A` as the release inventory. Build an explicit ownership/staging list and review every production file, generated artifact, test, package change, and documentation change.

## User-visible incident summary

| Incident                      | User-visible symptom                                                                | First causal seam                                                                                                                                                 | Effect evidence                                          | Status                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| Mobile workflow report-back   | Result absent until leaving/reopening; running card could disappear                 | `async_work_dispatched` and late terminal were not reduced by exact source/delegated bubble identity                                                              | Presentation only                                        | Code-fixed; device acceptance open                               |
| Platform 59 → 49 correction   | Old clarification repeated after correction                                         | Client replay settled the new placeholder with the prior source terminal; clarification free text and A/Q/B continuation also disagreed                           | No workflow ran on correction                            | Code-fixed; focused tests green                                  |
| Salesforce → Sheet            | Local discovery ran, then generic failure before Salesforce query or Sheet creation | Destination clause was prematurely “resolved”; Sheets search became unscoped and collided with generic planning search; second model boundary error was not typed | Zero external business effects                           | Open / not retested                                              |
| Friday dashboard              | “Could not start,” then false catch-up/Resume language                              | Historical raw subprocess lacked represented authority; scheduler treated deterministic readiness as transient downtime                                           | Historical run had zero subprocess/provider calls        | Typed migration installed; creation/live test and readiness reconciliation open |
| Platform 49 catalog readiness | `typed_catalog_not_ready` / missing tool candidates                                 | Cold durable manifests were not reconstructed into exact current observations and account-bound callable rows                                                     | Zero provider effects                                    | Fixed locally; later runs passed                                 |
| Platform 49 read settlement   | “2 business call failures have no successful recovery”                              | Trusted adapter carrier hid nested provider success from settlement                                                                                               | Successful reads crossed; no writes                      | Fixed locally; later runs passed                                 |
| Platform 49 missing ops       | Repeated catalog-missing refusals after `tool_search`                               | Discovery returned remembered slugs but did not provision exact executable authority                                                                              | Reads only; missing calls zero crossing                  | Fixed locally; later run pre-provisioned all authored ops        |
| Platform 49 bad args          | Wrong profile args crossed as `{}` and provider returned `user_not_found`           | Proof compiler silently synthesized `{}` after an explicit object failed schema validation                                                                        | Read calls crossed unnecessarily                         | Fixed locally with zero-crossing validation and cold rehydration |
| Platform 49 write authority   | Reads completed; writes stopped on `coverage_missing`                               | Saved workflow did not create exact authority recognized by unified consent                                                                                       | No writes                                                | Ordinary non-destructive authority added; local tests green      |
| Platform 49 latest            | Reads completed; nested insert shape guessed and refused; generic bounded error     | Repair exposed only top-level schema and then removed the `tool_search` control it recommended                                                                    | 20 successful reads; zero writes; no uncertainty         | **Open P0**                                                      |
| Hard-cut async recovery       | New PID says recovery owns task but performs no remaining GET/write                 | Frozen catalog snapshot cannot be re-attested after process restart                                                                                               | PID A retained one search/start/GET; PID B did zero work | **Open P0 / focused test red**                                   |
| Mobile Stop                   | No obvious way to stop delegated workflow                                           | Exact background run IDs were not retained/projected into the card                                                                                                | UI only until confirmed cancel                           | Code-fixed; device acceptance open                               |
| Scorpion scheduled workflow   | Step returned a string saying the same workflow was not queued; output contract failed | Direct named-workflow dispatch ran inside a workflow session and treated incidental “prior run” prose as a new execution request                                | No intended business effect from the intercepted step    | **Open P0**                                                      |
| Daily standup email           | `typed_catalog_not_ready` before work                                                | Exact catalog readiness failed; the send path was never retested                                                                                                  | Zero intended provider/send effect                       | Open; output contract also contradicts valid “No meetings” case  |
| Team activity Slack updates   | Two scheduled readiness blocks                                                       | Enabled definition still uses a raw deterministic runner                                                                                                          | Zero script/provider body                                | Quarantine or migrate                                            |
| End-of-day scheduled workflow | Generic bounded error after invalid task-list call                                   | BYO first-class local `InvalidToolInputError` was laundered into `local_execution/succeeded`                                                                      | Invalid local body returned; no intended business write  | **Open P0 settlement/schema lane**                               |

## Detailed incident record

### 1. Mobile background report-back was invisible or disappeared

Symptoms observed:

- The phone showed “Started — I’ll post the result here when it’s ready.”
- Discord received the terminal result, while the mobile chat did not visibly update until the user left and reopened it.
- In another run, leaving and reopening caused the running assistant item to disappear.
- A late delegated terminal could be dropped while a newer foreground turn was active, or could render under the wrong user turn on replay.

First causal seams:

- `async_work_dispatched` was treated as terminal by the stream lifecycle even though it only ended foreground ownership, not delegated work.
- The client used one mutable active assistant ID instead of binding terminals to `sourceUserSeq` and delegated `runIds`.
- Full transcript folding and live event application had different behavior for overlapping turns.
- An unresolved delegated bubble was initially adopted only when it happened to be the last message.

Generic repairs attempted:

- Source-bound delegated assistant identity and run IDs in `packages/chat-engine/src/types.ts` and `packages/chat-engine/src/engine.ts`.
- Stream terminality now ignores prior-source catch-up terminals and keeps listening for the current delegated source in `packages/chat-engine/src/stream.ts`.
- Live and replay reducers settle the same delegated bubble, including older background terminals arriving during a newer foreground turn.
- Canonical terminal status now outranks legacy reason-text inference in `packages/chat-engine/src/terminal-presentation.ts`.
- Exact workflow origin report-back owns one source-bound terminal/outbox group with immutable per-destination delivery and receipt rows.

Reported verification:

- Chat engine and delegated-stream suites green.
- Mobile/chat/Stop matrix reported `121/121`.
- Delivery/report-back matrix reported `110/110`.
- Adversarial probes covered older terminal while a newer turn was active, reopen after the newer turn completed, and two simultaneous delegated bubbles finishing out of order.

Still required:

- Real phone acceptance while the app is backgrounded or killed.
- Leave/reopen with an intervening foreground message.
- Discord enabled at the same time.
- One stable delegated bubble, one canonical terminal, and no duplicate Activity row.
- Native push must be tested separately. The latest live environment had no registered web-push destination, so durable transcript delivery does not prove handset push.

### 2. Platform 59 typo correction replayed the old clarification

Session: `sess-mob-3cd5b791c813490fcd61c65095ff87a5`

Event sequence:

- Initial source `100903`: “Run my platform 59 flow please.”
- Prior clarification became public at `100930` and canonical completion at `100934`.
- Correction source `100935`: “Sorry platform 49.”
- Actual server terminal for the correction was `100940`, with different text.

The screenshot’s repeated old clarification was not a second model response. The client stopped at the awaiting event, reattached from that cursor, applied the prior source’s completion to the new placeholder, and stopped before the current source terminal.

A second semantic contradiction existed:

- The clarification tool told the user they could answer in their own words.
- The accepted-source snapshot set `allowFreeText:false` whenever visible options existed.
- The correction was therefore classified as ambiguous even though it supplied the missing workflow identity.

Generic repairs attempted:

- Source-correlated live/replay terminal reduction.
- Clarification-only free text while preserving option/meta authority boundaries.
- Exact A/Q/B continuity: the parent accepted request must independently contain the run imperative; the correction supplies only identity.
- Durable successor clarification reoffer when the correction remains ambiguous.
- Named workflow host dispatch queues exactly once without another model call.
- Forged low-level continuity consumption without a claim-linked admitted semantic event cannot mint run authority.

Reported verification:

- Focused semantic/continuation cohort `116/116`.
- Chat-engine regression uses the real sequence `100930 → 100934 → 100935 → 100940`.

### 3. Salesforce deals to Google Sheet failed before either business action

User request:

> Find the deals Tim still has to close this quarter in Salesforce and create a Google Sheet with the data.

Session: `sess-mob-830d091fd0f15144cd9f928a4932eaad`

Source event: `100835` at `12:52:45.236`

Model: GLM 5.3

Observed sequence:

1. The first request was about 39 KB / 16,158 composed tokens.
2. Salesforce discovery succeeded and found `salesforce_sf_soql_query`.
3. Local planning-control lookup and memory recall succeeded; memory resolved Tim as Tim.
4. The Google Sheets search was denied with `new_call_requires_retry_epoch` under `host:unscoped_role`.
5. A second model request grew to about 95 KB / 23,761 composed tokens.
6. The provider/model boundary failed in about 722 ms with only a generic `Error`; no accepted second batch followed.

First causal seam:

- A destination clause was marked resolved when any strong effect-compatible candidate existed, even when that candidate did not atomically cover both creating and populating the requested resource.
- The correctly scoped Google discovery was coerced into an unscoped role and collided with an unnecessary generic planning-control search.
- The generic planning search exposed dozens of irrelevant Airtable/Apify descriptors, amplifying the next request.

Generic repairs attempted:

- One coherent atomic descriptor must cover the destination create/populate requirement. Partial capabilities cannot be combined across provider family or account merely to call the clause resolved.
- Structural planning controls are resolved locally and do not consume provider candidate-source or unscoped discovery budget.
- Combined tests proved independent Salesforce and Sheets role claims, no unscoped claim, no Airtable/Apify tail, and a bounded visible payload.

Reported verification:

- Capability/structural/governor cohort `36/36`.

What remains open:

- No successful end-to-end rerun has proved Salesforce query, Sheet creation, row population, and durable report-back.
- The second failure’s exact provider cause is not durable. Payload bloat is an amplifier, not a proven root cause.
- Statusless provider-origin errors still become generic nonretryable `runtime.unknown`. The runtime needs a typed provider-boundary error wrapper, bounded redacted message/status/code persistence, and at most one pre-actionable fallback/fallover. Do not make every generic host `Error` retryable, and never fall over after actionable output or an effect.

Required acceptance:

```text
ambiguous person resolution
  -> exact Salesforce query
  -> exact Sheet create
  -> exact row population
  -> verification/readback
  -> one source-bound report-back
```

No provider-specific bypass is acceptable.

### 4. Friday dashboard “could not start”

Workflow: `friday-dashboard-daily-refresh`

Canonical held run: `trigger-3b546b3d9038a65ab2138dedf8b04e41`

The current daemon received the 07:00 PT cron cue. Readiness refused the step because it declared `deterministic.runner: refresh.mjs`, producing:

```text
workflow_raw_subprocess_authority_unrepresented
```

The wrapper script shells into a fixed dashboard refresh pipeline that queries Salesforce, writes `data.json`, and rebuilds the view. The definition and script had not changed; a framework release reintroduced unconditional raw-subprocess retirement. The dashboard last clearly completed on 2026-08-23.

The old scheduler behavior then made the incident worse:

- It retried the same deterministic refusal four times at 15-second intervals.
- After roughly a minute it reclassified the pending occurrence as catch-up.
- It told the user Clem had been unavailable and offered Resume/Skip, even though the daemon was live and Resume could not open the gate.
- It created two semantically duplicate notices: enqueue failed and catch-up held.

Crossing/effect evidence:

- No chat session.
- No workflow body or step execution.
- No provider call.
- No subprocess.
- No uncertain effect.

Containment repairs attempted:

- Typed `blocked_readiness` runs for deterministic migration-required refusals.
- One stable actionable notification, no repeated enqueue attempts, and no false daemon-unavailable catch-up.
- A bounded boot reconciler converts exact legacy catch-up holds into canonical readiness blocks without queueing or replaying work.
- Reviewed `space_set_data` / `workspace_dataset_v1` infrastructure provides a generic exact local dataset commit with deterministic identity and replay.

Reported verification:

- Scheduler/queue cohort `134/134`.
- Reviewed workspace adapter, replay, and route tests green.

Current saved-definition state, checked after the historical incident:

- `~/.clementine-next/vault/00-System/workflows/friday-dashboard-daily-refresh/SKILL.md` was modified on 2026-08-31 around 08:01 PT.
- It is enabled and contains no raw runner.
- It has eight typed steps: six exact read-only `salesforce_sf_soql_query` calls, one bounded in-process JSON transform, and one reviewed idempotent `space_set_data` write.
- Its prose explicitly says “No shell or raw workflow runner.”

What remains open:

- The migrated definition has never passed its required creation/manual test.
- Current certification is contradictory: a top-level view reports `READY TO RUN` / `canRun:true` / `needsCreationTest:true`, while contract tool-readiness reports both `salesforce_sf_soql_query` and `space_set_data` missing. Reconcile these views before invoking it.
- Validate that the bounded transform preserves the dashboard’s required semantics and that the existing view correctly derives presentation from the committed dataset.
- Clem’s earlier self-migration attempt reached a frozen planning/catalog boundary after discovering a needed local workflow-write capability too late. A later code/definition migration now exists, but that does not prove runtime success.

Correct direction for this workflow now:

- Never reintroduce arbitrary `deterministic.runner` or generic shell authority.
- Resolve the contradictory readiness projections against the exact saved typed definition.
- Validate the new definition and run its creation/manual test once before trusting the enabled schedule.
- Preserve the old definition for rollback.

This is not evidence that every workflow needs migration. It applies to legacy raw-runner definitions whose effects cannot be represented by the typed runtime. The current Friday definition is already typed; other enabled raw-runner workflows remain and require their own inventory/quarantine or migration.

### 5. Mobile Stop was missing or misplaced

User requirement:

> Show Stop only inside the expanded work/step view as a small stop circle.

Generic repairs attempted:

- Delegated cards retain exact, validated `sourceUserSeq` and `runIds` in live and replay state.
- `RunControl` renders only for an active delegated run and only when its work disclosure is expanded.
- The trigger is a compact circular button with an explicit accessible label and a 44×44 hit target.
- Confirmation uses an authenticated exact-run cancellation endpoint.
- Batch cancellation preflights all exact run IDs and does not cancel completed siblings or unrelated runs.
- Accepted cancellation becomes canonical `cancelled` / `stopped`, not a generic failed workflow.

Key files:

- `packages/chat-engine/src/types.ts`
- `packages/chat-engine/src/engine.ts`
- `apps/mobile-web/src/components/RunControl.tsx`
- `apps/mobile-web/src/screens/Chat.tsx`
- `apps/mobile-web/src/lib/api.ts`
- `src/channels/mobile-routes.ts`
- `src/execution/workflow-origin-terminal.ts`
- `src/execution/workflow-run-report-back.ts`

Reported verification:

- Exact run targeting, collapsed/expanded state, cancelling/stopped state, route authorization, idempotent repeated tap, mobile typecheck, and mobile production build all green.

Still required:

- User/device acceptance by stopping one real delegated run.
- Verify only that occurrence stops.
- Reopen and confirm one `Stopped` terminal and no remaining control.
- Correct any empty cancelled-terminal fallback that renders “current limit / say continue” instead of “Stopped.”

### 6. Additional scheduled workflow failures found during final fact-check

These failures were not part of the initial user-driven Platform triage, but they occurred on the same day and are release-relevant because the user asked whether Clem can run any workflow.

#### Scorpion Facebook trends recursively dispatched itself

Run: `trigger-328868bb00e5a38cb6bba2bb2d600c50`  
Workflow: `scorpion-facebook-trends`  
Interval: `14:30:07–14:30:35`

Observed failure:

- Internal step `find_official_page` produced a 122-character string beginning `Workflow "scorpion-facebook-trends" was not queued...` instead of its required object with `facebook_page_url` and `verification_evidence`.
- The conversation path looked successful/DONE, then the workflow output contract failed.

First causal seam:

- `src/runtime/harness/host-turn-runner.ts:5403-5442` runs the lexical named-workflow short circuit for production host sessions without excluding workflow-internal accepted sources.
- `requestsWorkflowExecution()` in `src/tools/named-workflow-match.ts:79-84` treats any affirmative token such as `run` as execution intent. The step’s incidental phrase “prior run” was enough to trigger recursive named-workflow dispatch.

Required generic fix:

- Workflow/internal model sources must never enter the foreground lexical named-workflow shortcut merely because their prompt mentions a run.
- An internal workflow may invoke another workflow only through an explicit typed workflow-call node/capability with exact authority.
- Add a production test where an internal prompt contains `prior run`, the current workflow’s name, and no explicit typed child-workflow call; assert zero queue activity and normal step execution.
- Preserve the user-chat named-workflow shortcut and exact typo-correction path.

#### Daily standup email failed catalog readiness

Run: `trigger-f81f92de35d86a82e9e1e0e010453f4f`  
Workflow: `daily-standup-email`  
Interval: `15:00:12–15:00:24`

Observed failure:

- Step `main` stopped at exact external catalog preparation with `typed_catalog_not_ready`.
- No intended provider or send effect occurred.
- It was not successfully retested after the catalog fixes.

Additional next-wall warning:

- The definition says “No meetings” is a valid result, while its output contract requires nonempty `meetings` with `min_items: 1`. Even after catalog readiness, a legitimate empty day can fail the contract.
- This is also an authored-send workflow, so it is a concrete production acceptance for the unified send-authority P0.

#### Team activity Slack updates remains an enabled raw-runner workflow

Runs:

- `trigger-423fe696be3e8ef0b868c59ccc11826b` at `16:00:13`
- `trigger-7d336259902740f0cfb088edac0ff97f` at `23:00:01`

Both are canonical `blocked_readiness` occurrences for enabled workflow `team-activity-slack-updates`. Step `pull_activity` still declares deterministic runner `scripts/pull-salesforce-activity.mjs`; no script/provider body started.

This proves the raw-runner migration inventory is broader than Friday. The current deterministic-runner inventory is:

- Enabled: `team-activity-slack-updates`.
- Enabled: `social-manager-rc-1785193205` (`define-competitors.mjs`; it also exposes `run_shell_command`).
- Disabled: `Monday Salesforce Opportunity Report`.
- Disabled: `salesforce-quarterly-to-sheets`.

Additional enabled definitions expose raw shell without `deterministic.runner` and need separate policy review:

- `end-of-week-team-sales-snapshot`
- `objective-execution-loop`
- stale `clem-smoke-flow-8177`

Do not automatically migrate the orchestration-oriented `objective-execution-loop`; inspect its intended policy/effects first. Before tag, every enabled workflow must be classified as ready, creation-test-required, account/input-required, migration-required, or disabled.

#### End-of-day invalid local input was recorded as success

Run: `trigger-e73410ab17ef1c21a8348be004fecb92`  
Workflow: `end-of-day`  
Created `2026-09-01T00:00:15Z` / 17:00 PT on Aug 31

Observed failure:

- The first three-call frame was refused.
- A retry called `task_list` with literal strings `priority:"null"` and `project:"null"` instead of omitted/null values.
- The first-class local tool returned structured `InvalidToolInputError`.
- Settlement recorded it as `local_execution/succeeded/host_execution`.
- The model then exhausted its turn budget and the workflow terminalized as a generic bounded host error.

First causal seam:

- `src/runtime/harness/attempt-settlement.ts:876-889` recognizes the SDK-laundered invalid-input string only for the Claude SDK lane or `plan_task`.
- BYO first-class local tools can therefore return the same structured validation failure and be mislabeled success.

Required generic fix:

- Carry typed local tool validation failure before/through the local body and settle it as `invalid_arguments` with repair guidance.
- Apply the typed contract to every execution lane: direct local, deferred `call_tool`, native MCP, provider carrier, SDK, and BYO.
- Do not broaden a regex over arbitrary result prose. The tool invocation boundary must supply structural error identity.
- Add a metamorphic test proving the same invalid input has identical zero-effect settlement truth on every lane.

## Platform 49 chronology: each repaired wall exposed the next framework seam

Workflow: `platform-49-slack-channel-review`

### Run ledger

| Run                                        | UTC interval      | User-visible result                | First causal seam                                                                                                                 | Physical/effect truth                                           |
| ------------------------------------------ | ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `1788180378863-52866a`                     | 12:46:18–12:47:44 | Blocked at `main`                  | Frozen accepted catalog had no callable candidates despite durable manifests                                                      | Zero provider calls, zero mutations                             |
| `trigger-9ede6599d040f36cf8e675e5c48521d9` | 15:00:12–15:00:24 | `typed_catalog_not_ready`          | New exact catalog gate could not reconstruct current observation                                                                  | Zero useful provider work                                       |
| `1788189316178-01ca4a`                     | 15:15:16–15:15:19 | `typed_catalog_not_ready`          | Independent observation used blank account; identity/fingerprint could not match account-bound manifest                           | Zero provider work                                              |
| `1788190642993-57eeea`                     | 15:37:22–15:38:29 | Blocked with uncertain wording     | Source BATCH_GET misrouted as readback; connection snapshot expired during a 63-second model phase                                | Read-only crossing; no write uncertainty                        |
| `1788195448925-379b44`                     | 16:57:28–16:58:27 | “2 business call failures…”        | Nested provider success hidden inside trusted adapter carrier                                                                     | Successful reads crossed; no writes                             |
| `1788201716184-f6311f`                     | 18:41:56–18:57:22 | Generic bounded host error         | Exact authored operations were absent; search returned names but did not provision executable authority                           | 11+ successful reads; missing ops zero crossing; no writes      |
| `trigger-6a68960bdfed5382822a2583b19a018a` | 19:00:10–19:13:42 | Scheduled bounded host error       | Same missing-operation/catalog-provision family persisted in the scheduled occurrence                                             | 11 successful reads, 3 local searches, no writes                |
| `1788205574604-7c352c`                     | 19:46:14–20:00:43 | Blocked after user lookup failures | Explicit bad object fell through to semantic `{}` synthesis; provider received unusable args                                      | Reads crossed unnecessarily; no writes                          |
| `1788208892944-a2129e`                     | 20:41:32–20:54:52 | Blocked                            | Cold-hydrated proof row lacked validator; nested local discovery control inside provider carrier was misrouted as a business call | Reads only; no writes                                           |
| `1788213168061-788b2e`                     | 21:52:48–22:08:20 | Blocked after read phase           | Saved workflow writes had no exact coverage/grant in unified consent                                                              | 24 successful reads; write refusals zero crossing               |
| `trigger-abb2a8f3f2ca7b0629cdd014d5a9da74` | 23:00:00–23:07:04 | Failed after daemon restart        | Restart policy used declared write capability rather than exact ledger proving only reads                                         | 10 successful read crossings, 9 zero-crossing repairs, no write |
| `1788218615780-a95653`                     | 23:23:35–23:37:38 | Generic bounded host error         | Nested schema repair exposed too little structure and contradicted recovery tool restrictions                                     | 20 successful reads, zero write crossing, no uncertainty        |

### Run `1788180378863-52866a`: no executable catalog

- Origin session: `sess-mob-fd0fcd5db45d6d0b3d3e794beae00e62`
- Source event `100787`; dispatch `100805`; terminal `100834`.
- External calls were refused as `catalog_entry_or_manifest_missing:candidates=0:proven=none`.
- Durable manifests existed, but selected process state and exact independent observations did not.

Attempted generic fix:

- Pre-source workflow external-catalog preparation.
- Exact immutable operation extraction from the authored prompt and effective allowlist.
- Exact provider definition/account/schema/fingerprint revalidation.
- Scoped accepted-source catalog narrowing so unrelated installed writes stay absent.

### Runs `trigger-9ede…` and `1788189316178-01ca4a`: the new gate failed itself

The first catalog fix introduced a stricter pre-model readiness gate. Its observer called the attested transport with `accountId:''` while the durable manifests required exact `ca_*` accounts. Account is part of the fingerprint, so readiness could never match.

Attempted generic fix:

- Consume and publish the exact definitions returned by provider revalidation before scoped readiness.
- Pass the manifest’s exact account to independent observation.
- Reject blank or mismatched account evidence.

Reported targeted result: 18/18 across workflow external-catalog and production adapter suites.

### Run `1788190642993-57eeea`: source/readback confusion and fixed-time evidence

Two independent failures appeared:

1. `GOOGLESHEETS_BATCH_GET` was routed by operation name into a legacy artifact-readback adapter, even though the call role was ordinary source/lookup. It demanded an exact artifact ID.
2. The prepared connection snapshot was valid for 60 seconds, while the model phase took about 63 seconds. Dispatch then refused a current connected-account observation.

Attempted generic fixes:

- Make legacy readback routing role-aware and require exact readback manifest facts. Source/lookup calls keep canonical provider arguments.
- Revalidate the sealed exact operation/account immediately before physical reservation. On mismatch, refuse before a business row/body begins.

Important lesson:

> Extending the 60-second constant is not the architectural fix. Exact evidence should renew just in time without changing the sealed operation/account/schema/manifest identity.

### Run `1788195448925-379b44`: successful reads classified as failures

Provider rows returned successfully and the actual tool output contained `successful:true`. The trusted production adapter wrapped each result as:

```json
{
  "result": {
    "successful": true,
    "error": null,
    "data": {}
  },
  "complete": true
}
```

Settlement sampled only top-level success fields, fell through to `unknown/text/stop_and_explain`, and later audit emitted “2 business call failures have no successful recovery.”

Attempted generic fix:

- Unwrap exactly one level only for the closed trusted two-key carrier.
- Never treat `complete:true` alone as success.
- Preserve top-level failure, nested `isError`, non-null error, contradictions, incomplete carrier, and extra-key denial.

Later live runs settled the same read family successfully, so this seam appears closed.

### Run `1788201716184-f6311f`: discovery did not create executable authority

The authored prompt named six exact provider operations. Four had current durable manifests; two did not:

- a Slack user-profile read
- a Sheets dimension insertion write

The model called legacy Composio discovery and got remembered slugs, but that path did not install current manifests, select an account, or register proof-provisioned capabilities. Retrying the exact operations hit the same catalog wall.

Attempted generic fix:

- Persist the accepted workflow source before preparation.
- Extract every positive exact operation from immutable prompt/effective allowlist using registered toolkit namespaces.
- Batch exact provider lookup, resolve one current account per toolkit, record source-bound capability resolution, and register proof-provisioned reads and writes.
- Re-read the store and refuse pre-model unless every authored operation has one exact current callable identity.
- Keep negated-only operation mentions out while preserving positive mentions in explanatory sentences.

Later Grok runs began with all six authored operations in the frozen card, which is strong live evidence that this seam improved.

### Run `1788205574604-7c352c`: explicit bad args silently became `{}`

The model tried user-profile reads with fields such as `user_id` and `id`, while the current provider schema expected `user`. Because the schema’s field was optional, the proof compiler rejected the explicit object and silently fell back to semantic synthesis of `{}`. The provider then returned `user_not_found`.

Attempted generic fix:

- Exact authority-bound provider objects are schema-validated before dispatch.
- An explicit object mismatch returns bounded repair guidance and zero physical crossing; it cannot fall back to `{}`.
- Corrected same-source retry crosses once.
- The validator is restored during cold durable manifest rehydration when the current schema digest matches the trusted manifest.

Later run `1788213168061-788b2e` proved this behavior live: wrong `userId` calls were refused at zero crossing, the model repaired to `user`, and the profile reads succeeded.

### Run `1788208892944-a2129e`: cold validator and nested local control

Two further composition seams appeared:

- Pre-existing durable proof rows did not receive the new foreground validator after restart.
- The model nested a local `composio_search_tools` control name inside a provider execution carrier; the host treated the inner name as an external business mutation and refused catalog admission.

Attempted generic fixes:

- Rehydrate optional foreground validators from the durable schema only when schema digest and manifest identity match.
- Recognize only exact registry-declared local read/control identities inside a trusted provider carrier and route them through the sealed local tool/call-tool path with zero provider crossing.
- Unknown names, business reads, and every write remain on the provider path.

### Run `1788213168061-788b2e`: authored workflow write authority was missing

The model completed 24 reads and repaired profile arguments. It then reached the write phase. The workflow had an immutable authored write step, but unified host consent saw no accepted task work contract or coverage and refused every mutation as `coverage_missing`.

Attempted generic fix:

- New durable authored-workflow write receipt tied to exact session, source, active attempt, running run, immutable definition/admission hash, step, prompt/allowlist, and sorted canonical catalog identities.
- Reopen against current accepted batch/call index, exact operation/account/effect/schema/port/destination/inner arguments, current risk, and physical crossing state.
- Mint an exact `standing_workflow_scope` grant only for reversible or ordinary non-destructive writes.
- Validate schema before consent.
- Use the dispatch ledger as the transactional one-crossing owner; settled replay cannot rerun the body.

Reported verification:

- Focused authority acceptance 3/3.
- Authority + risk cohort 20/20.
- Adversarial denial for forged chat, foreign operation, wrong source/account/effect/schema/port/batch/index, destination drift, definition/admission drift, and wildcard-only scope.

The latest live run never reached consent because nested argument validation failed first, so the full live write path remains unproven.

### Scheduled run `trigger-abb2…`: restart copy overstated write uncertainty

The daemon restarted while Grok was reasoning after three fully checkpointed read batches.

Durable ledger:

- 19 logical attempts settled.
- 10 physical provider crossings, all returned and read-only.
- 9 invalid profile calls refused pre-dispatch.
- Zero writes, zero uncertain effects, zero open calls, zero started dispatch leases.

The workflow wrapper nevertheless used the step’s declared write capability and said it “may have written.”

Required generic fix:

- Restart/recovery policy must consult exact durable logical/physical/effect evidence, not only the maximum declared step class.
- A write-capable step with only settled reads should be resumable through the existing exact checkpoint if the catalog can be re-attested.

### Latest run `1788218615780-a95653`: current P0

- Origin session: `sess-mob-3b67dc6f92b8bb984cd3aeb30b25b1cd`
- Worker session: `workflow:1788218615780-a95653:main`
- Origin source `102180`
- Created `23:23:35.715`; started `23:23:39.155`; blocked `23:37:38.830`
- Grok 4.6 / `host_v1`

Healthy work before failure:

- 20/20 provider reads succeeded.
- 1 combined Sheets baseline read.
- 3 paginated Slack history reads.
- 7 thread reads.
- 9 user-profile reads.
- Zero open dispatches or provider errors.

Write-phase failure:

1. The model probed `GOOGLESHEETS_INSERT_DIMENSION` and `GOOGLESHEETS_BATCH_UPDATE` with invalid shapes. The host correctly refused them before physical dispatch.
2. The diagnostic disclosed only the top-level fields `spreadsheet_id` and `insert_dimension` and told the model to call `tool_search` if the nested shape was unclear.
3. The no-progress projection classified the result as `schema_invalid` with recovery tools equal to the failed provider operation only.
4. The recovery surface filtered out `tool_search` despite the diagnostic instructing the model to use it.
5. Grok guessed camelCase children directly under `insert_dimension`.
6. The real schema required another `range` object with snake_case children.
7. The corrected-but-invalid zero-crossing call exhausted the bounded no-progress recovery and terminalized as a generic internal host error.

Correct nested shape present in the host schema:

```json
{
  "spreadsheet_id": "...",
  "insert_dimension": {
    "range": {
      "sheet_id": 123,
      "dimension": "ROWS",
      "start_index": 1,
      "end_index": 2
    },
    "inherit_from_before": false
  }
}
```

Effect truth:

- All write attempts were refused before dispatch.
- Zero external write crossings.
- Zero mutations.
- Zero uncertain effects.
- One exact origin terminal was durably committed and will replay on reopen.

This is the first release blocker to fix.

## Hard-cut async recovery: the focused acceptance is currently red

Focused test:

```bash
npx tsx --test \
  --test-name-pattern='a hard crash before HostRecoveryState' \
  src/journeys/northstar-local-llm-content-workspace.host-e2e.test.ts
```

Observed result: fail.

The intended S→R→W proof is:

```text
PID A
  Search once
  START async batch once
  GET first result once
  crash before HostRecoveryState and before Workspace write

PID B
  claim exact orphaned continuation
  perform only the missing GET(s)
  write Workspace once
  commit one terminal

PID C
  reopen settled state
  perform zero model/provider/write work
```

What actually happened:

- Boot chose exact checkpoint recovery.
- A `run_resumed` event was emitted.
- PID B claimed orphan ownership.
- Recovery surface reconstruction then failed with `catalog_snapshot_identity_mismatch`.
- PID B performed zero model calls, zero getter calls, and zero Workspace writes.
- The user-facing response said the recovery system still owned the task, but no remaining work progressed.

Retained work from PID A:

- Search ×1.
- Async batch START ×1.
- Getter ×1.
- No Workspace write.

First causal seam:

> The durable continuation and ownership claim survive the process boundary, but the frozen catalog identity reconstructed by PID B is not byte-equivalent to the identity persisted/admitted by PID A.

Relevant files:

- `src/runtime/harness/async-read-continuation-contract.ts`
- `src/runtime/harness/async-read-refinement-recovery.ts`
- `src/runtime/harness/restart-recovery.ts`
- `src/runtime/harness/host-durable-continuation.ts`
- `src/journeys/northstar-local-llm-content-workspace.host-e2e.test.ts`

Required next debugging step:

Instrument the mismatch as a closed component-by-component comparison. Persist or log bounded digests for:

- accepted source/event identity;
- accepted model batch and graph revision;
- catalog snapshot protocol/version;
- operation and capability ID;
- manifest ID/digest;
- account ID;
- input/output schema digest;
- operation version and provider fingerprint;
- effect and destination family/posture;
- invoke port and implementation artifact digest;
- canonical sorting/normalization bytes.

Do not loosen the equality check and do not authorize from a list of persisted IDs alone. Find and eliminate the construction/rehydration drift. A true mismatch must remain fail-closed.

Required acceptance:

- PID A→B→C passes exactly.
- Search and START never repeat.
- Already completed GET never repeats.
- Only missing GETs execute.
- Workspace writes once.
- Terminal commits once.
- Stop before and after claim remains exact and idempotent.
- Tampered catalog or continuation evidence refuses with zero body.

## Harness failure map

This section translates the incidents into the runtime contracts the next agent should own.

### Accepted-source and semantic continuity

Desired invariant:

> Every host action is rooted in one immutable accepted user source, and corrections/clarifications can refine identity without manufacturing the parent action’s authority.

Known repaired seams:

- Platform 59→49 A/Q/B continuity.
- Claim-linked semantic answer proof.
- Exact successor clarification reoffer.

Open risks:

- Any new continuation type must be bound to exact goal/revision/source and must not trust low-level store caller fields as authority.
- Replayed terminals must be source-correlated in both live and fold paths.

### Planning card and capability closure

Desired invariant:

> The immutable initial card is presentation; exact later disclosures may extend only the same-source staged planning ledger and may never mutate authority retroactively.

Known repaired seams:

- Create+populate destination clauses require one coherent capability family/account.
- Structural local controls do not pollute provider discovery.
- Compatible same-source durable disclosures can be restored to staged planning without rewriting the initial card.

Open risks:

- Late-discovered migration/write capabilities need a bounded durable replan epoch rather than permanent exclusion.
- Provider candidate tails still need affinity/relevance bounds under broad searches.

### Exact catalog and capability evidence

Desired invariant:

> An executable catalog entry is the conjunction of exact source, operation, provider/toolkit, account, schema, manifest, effect, destination, port, implementation, and current observation/lease identity.

Known repaired seams:

- Source-first workflow catalog preparation.
- Exact account-bound revalidation and observation publication.
- Proof-provisioned cold validator hydration.
- JIT exact operation/account preparation before physical reservation.

Open risks:

- Fixed 60-second independent-observation freshness is not a durable long-workflow protocol.
- Cross-PID catalog snapshot re-attestation is red in the hard-cut journey.
- Space refresh cold preparation is locally covered but has not been proven in the final live Platform tail.

### Schema and argument repair

Desired invariant:

> The host never sends invalid explicit provider objects, and every safely repairable schema refusal produces enough exact bounded structure for one deterministic repair without broad discovery.

Known repaired seams:

- Explicit invalid provider objects refuse at zero crossing.
- Corrected same-source calls can cross once.
- Cold durable rows can recover validators from exact schema digests.

Current P0:

- Diagnostics expose only top-level fields despite recursive validation.
- Diagnostic and allowed recovery tools contradict one another.
- A zero-crossing repair consumes no-progress budget before exact repair material is acquired.

### Consent and workflow authority

Desired invariant:

> Saving/running a workflow authorizes only the exact immutable step effects represented by a typed grant; all mutations share one consent reducer and one crossing owner.

Known repaired seam:

- Ordinary reversible/non-destructive authored writes can receive an exact standing grant.

Current P0:

- Authored sends still rely on legacy `PlanScope.allowAnySend`, but unified mutation consent marks the call owned before the legacy predicate can run.

Never generalize the ordinary-write grant to delete/admin/destructive/unknown effects.

### Physical dispatch and settlement

Desired invariant:

> One logical call may own at most one physical body, and settlement truth is structural, typed, and replayable.

Known repaired seams:

- Trusted one-level adapter carrier settlement.
- Exact prephysical Composio preparation.
- Invalid args and catalog refusal stay at zero crossing.
- Settled replay cannot dispatch again.

Open risks:

- Provider-origin generic errors are not durably typed.
- At-least-once provider operations still require readback/reconciliation where provider idempotency is absent.

### No-progress and recovery

Desired invariant:

> Progress is a new durable structural fact, not a changed string, model call ID, query wording, or repeated refusal.

Valid progress facts include:

- exact capability acquired;
- capability lease renewed;
- schema repair artifact acquired;
- user input/approval resolved;
- dependency completed;
- logical call settled;
- effect reconciled;
- output verified.

Current defect:

- `schema_invalid` allows only the failed operation even when the repair text requires an inspection control.
- The generic directive says “one corrective call” without distinguishing schema-material acquisition from the corrected business call.

### Workflow completion contract

Desired invariant:

> A workflow step with an active output contract cannot terminalize on prose; it must call the actual `workflow_step_result`, unless an unsafe/uncertain effect requires immediate stop.

Known repaired seam:

- The production host-owned loop now gives a bounded same-source continuation when a contract exists and no result was captured.
- It does not continue after in-flight, storage-error, or uncertain-write evidence.

Required live proof:

- Platform 49 must reach its actual structured result after writes/readback/refresh/notify.

### Terminal, report-back, and notification

Desired invariant:

> One source-bound canonical terminal owns transcript state; one origin-terminal outbox group owns immutable per-destination delivery/receipt rows; live and replay render identical text/status.

Known repaired seams:

- Origin report-back canonicalization occurs before commit and exact retry comparison.
- Grouped retained-work canonicalization preserves later members and projects origin-owned inventory once.
- Blocked/cancelled status no longer renders green.
- Workflow report-back avoids generic foreground duplication.

Open risks:

- Native push registration is a separate product state and was absent in the latest environment.
- Historical rows from earlier faulty runs remain; cleanup should not rewrite terminal truth without a dedicated migration.
- Run `1788205574604-7c352c` showed `status:"completed"` with `terminalOutcome:"blocked"`; canonical run-status convergence needs a regression.

### Scheduler and legacy migration

Desired invariant:

> Deterministic readiness failures are nonretryable typed states with one actionable migration path, not daemon-down/catch-up events.

Known repaired seam:

- Raw-runner refusal becomes `blocked_readiness` with proven no dispatch.

Open risk:

- There is no complete provider-neutral migration compiler for arbitrary legacy scripts.

### Reaper and daemon hygiene

Recurring daemon logs show session-reaper foreign-key constraint failures. This has not been proven as the cause of Platform 49, but it is release debt because stale session cleanup and async-owner rows can collide under restart/load.

Required action:

- Reproduce under a clean test home.
- Identify the exact FK and deletion order.
- Preserve active async/workflow owners.
- Make cleanup idempotent and add restart/load coverage.

## Current code seams for the two immediate blockers

### Nested schema contradiction

`src/runtime/harness/proof-provider-args.ts:113-208`:

- Recursively validates nested values.
- Deliberately returns only top-level field lists.
- Tells the model to call first-class `tool_search` if nested shape is unclear.

`src/runtime/harness/host-no-progress-projection.ts:800-805`:

- Maps `invalid_arguments` to `schema_invalid`.
- Sets `recoveryToolNames` to only the failed call name.

`src/runtime/harness/host-turn-runner.ts:5674-5692`:

- Filters the model surface to those exact recovery names.

`src/runtime/harness/host-turn-runner.ts:5948-5971`:

- Refuses calls outside that restricted recovery surface.

This creates the exact contradiction that ended the latest run.

### Authored send consent split

`src/execution/workflow-runner.ts:4681-4720`:

- Creates `authoredSendConsent` and `PlanScope.allowAnySend` for a saved send step without `requiresApproval`.

`src/runtime/harness/host-turn-runner.ts:6293-6353`:

- Marks local/external/admin mutations as consent-owned.
- Calls the authored workflow evaluator, then generic uncovered consent.

`src/runtime/harness/authored-workflow-write-authority.ts:676-683`:

- Correctly returns no ordinary-write grant for send/delete/admin/destructive/unknown risk.

`src/runtime/harness/host-turn-runner.ts:6381-6395`:

- Runs the legacy `tool.needsApproval`/PlanScope predicate only when consent is not already owned.

Result: the new owner can prevent the older authored-send authority from ever being consulted. This is fail-closed, but it means “any workflow” is false.

## Northstar architecture recommendation

The recurring problem is not insufficient model intelligence. It is that the runtime asks the model to bridge internal framework facts that the host already knows, while authority and recovery are split across too many representations.

### Northstar invariant

Use one durable execution contract:

```text
one accepted source / occurrence
  -> one immutable execution capsule revision
  -> one host turn owner
  -> typed model frame
  -> exact capability + schema + account + effect authority
  -> one logical-call identity
  -> at most one physical crossing
  -> one structural settlement
  -> typed recovery edge or terminal
  -> one source-bound terminal/outbox
```

Graph promotion should be triggered by durable state requirements, not by the number of tools. Promote when work has fanout/merge, independent retry, approval/input, recurrence, restart continuation, or effect reconciliation.

### 1. Immutable `ExecutionCapsuleV1`

Create one source/step/occurrence-bound capsule containing:

- accepted source event ID, sequence, digest, and accepted task ID;
- workflow run/step/item and immutable definition/admission hashes when applicable;
- admitted graph revision/hash and accepted model-batch identity;
- exact capability identities, provider/toolkit, account, schema/output schema, manifest, effect, destination, invoke port, and implementation digest;
- capability lease generation/expiry;
- exact workflow/user grants and approval state;
- logical-call, recovery, and wall-clock budgets;
- continuation/checkpoint identity;
- terminal origin and outbox destination identity.

Properties:

- Model output, memory text, rendered prompts, UI state, and provider prose cannot mutate the capsule.
- New evidence appends an event and derives a new typed revision.
- Every gate reads the same revision instead of reconstructing a partial version from unrelated stores.
- Recovery across PIDs reopens and canonicalizes the same bytes.

This does not require rewriting the whole harness before the tag. The immediate fixes can use a smaller shared envelope, but they should converge on this shape instead of introducing another special-purpose authority store.

### 2. Closed gate algebra

Every gate should return exactly one of:

```ts
type GateDecision<TRecovery, TQuestion, TWait, TTerminal> =
  | { kind: "pass" }
  | { kind: "recover"; edge: TRecovery }
  | { kind: "need_user"; request: TQuestion }
  | { kind: "wait"; wait: TWait }
  | { kind: "terminal"; terminal: TTerminal };
```

There should be no generic “blocked” result with no machine-executable owner.

`wait` is not a model retry. It is a durable host-owned suspension with an exact dependency/job ID, wake predicate or scheduled time, bounded backoff/deadline, and one resume owner. Async provider jobs and outages should use this state instead of consuming no-progress turns while polling.

Examples of first-class recovery edges:

- `AcquireCapability`
- `RenewCapabilityLease`
- `InspectSchema`
- `RepairArguments`
- `AskUser`
- `ApproveEffect`
- `WaitForDependency` with exact dependency identity, wake condition, backoff, and deadline
- `Invoke`
- `ReadBack`
- `Reconcile`
- `ResumeCheckpoint`
- `PublishTerminal`

“Clem can open every gate” should mean:

> Every safely recoverable internal refusal has a bounded host-owned next edge in the same durable task.

It must not mean bypassing missing credentials, ambiguous accounts, destructive consent, unsupported raw scripts, or unknown effects.

### 3. `SchemaRepairArtifactV1`

This is the immediate Platform 49 fix and should be generic.

Suggested identity:

```ts
interface SchemaRepairArtifactV1 {
  version: 1;
  sourceEventId: string;
  sourceEventDigest: string;
  acceptedTaskId: string;
  originatingBatchId: string;
  originatingBatchOrdinal: number;
  failedLogicalToolCallId: string;
  operationId: string;
  capabilityId: string;
  accountId: string;
  manifestDigest: string;
  schemaDigest: string;
  invalidArgumentDigest: string;
  repairEpochId: string;
  continuationId: string;
  successorPolicy: {
    kind: "next_admitted_model_batch";
    maximumCorrectedCalls: 1;
  };
  invalidPaths: SchemaRepairPathV1[];
  artifactDigest: string;
}

interface SchemaRepairConsumptionV1 {
  repairEpochId: string;
  continuationId: string;
  repairOfLogicalToolCallId: string;
  successorBatchId: string;
  successorBatchOrdinal: number;
  correctedLogicalToolCallId: string;
  correctedArgumentDigest: string;
  consumptionDigest: string;
}

interface SchemaRepairPathV1 {
  pointer: string; // e.g. /insert_dimension/range
  expectedType: string | string[];
  requiredChildren?: string[];
  allowedChildren?: string[];
  enumValues?: unknown[];
  arrayItem?: BoundedSchemaNodeV1;
  oneOf?: BoundedSchemaNodeV1[];
}
```

Constraints:

- Bind the artifact to the exact originating source, batch, failed call, operation, account, manifest, schema, and invalid argument digest.
- The corrected call necessarily has a new batch/call/argument identity. Append one consumption row proving it is the permitted immediate successor, references `repairOfLogicalToolCallId`, and spends the one-time repair epoch.
- Reject a nonadjacent, already-spent, wrong-operation, wrong-account, wrong-schema, or wrong-source successor.
- Expose only the minimal subtree required to repair failing paths.
- Bound depth, total nodes, enum values, string length, and serialized bytes.
- Do not include provider descriptions, examples, secrets, account data, prior user values, or unrelated schema branches.
- The artifact grants no operation/account/effect authority; it is repair material only.
- A corrected retry must still pass the exact current validator, workflow/user consent, and physical reservation.

Preferred recovery:

```text
invalid explicit object
  -> zero-crossing refusal + exact repair artifact
  -> one corrected retry of the same exact operation
  -> settle or terminal
```

This avoids a second discovery/model turn.

Fallback recovery:

- Expose one local `schema_inspect` control bound to the same artifact identity.
- Recovery surface contains only `schema_inspect` until it settles.
- The next surface contains only the original operation.
- Acquiring the schema artifact is structural progress and must not count as a failed business retry.

Do not expose broad `tool_search` merely to retrieve a schema the host already has.

### 4. Renewable exact capability leases

The fixed 60-second independent-observation window should not become a larger magic number.

Treat current provider capability evidence as a renewable lease:

```ts
interface CapabilityLeaseV1 {
  operationId: string;
  accountId: string;
  manifestDigest: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  operationVersion: string;
  providerFingerprint: string;
  invokePortId: string;
  implementationDigest: string;
  generation: number;
  observedAt: string;
  expiresAt: string;
  leaseDigest: string;
}
```

Protocol:

1. Admission seals exact immutable identity.
2. At phase boundaries and immediately before a physical crossing, asynchronously revalidate exact provider definition and connected account.
3. If every identity component is unchanged, issue a new lease generation.
4. If schema/account/port/implementation changed, return a typed replan or schema-repair edge before reservation.
5. The synchronous crossing consumes the exact fresh generation.

Tests must advance fake time beyond 60 seconds and beyond normal workflow wall time. Unchanged identity should renew; changed identity must refuse before a body starts. Restart before and after renewal must preserve exact identity.

### 5. One effect kernel and one consent owner

Every tool and carrier should enter the same kernel:

```text
exact call identity
  -> schema validation
  -> effect and destination classification
  -> workflow/user grant resolution
  -> risk/consent reducer
  -> physical reservation
  -> provider/local body
  -> structural settlement
  -> readback/reconciliation when required
```

Provider adapters translate only:

- provider schema to canonical schema IR;
- canonical invocation to provider call;
- provider result to canonical result envelope.

They must not own workflow policy, retry policy, user approval, no-progress, or terminal truth.

Effect-aware authored workflow policy:

- `read`: exact catalog/source authority, no mutation grant.
- `write` with reversible/ordinary non-destructive risk: current exact standing grant.
- `send` with immutable `sideEffect: send` and `requiresApproval:false`: exact send grant bound to destination/cardinality and saved workflow definition.
- `send` with `requiresApproval:true`: one durable approval, exact resume, one crossing.
- delete/admin/destructive/unknown: separate stronger policy; never inherit write/send grants.

### 6. Recovery is structural progress

The no-progress governor should consume a normalized consequence plus durable recovery state.

Examples:

- Same invalid paths + same artifact digest + same bad args: no progress; terminal after bounded repeat.
- New schema repair artifact acquired: progress.
- Corrected args with a new valid argument digest: progress toward one crossing.
- Same catalog-missing result with a different query string: no progress.
- Exact capability installed and source-bound: progress.
- Provider body settled: progress.
- Effect reconciled/read back: progress.

The host should never tell the model to use a control that the next surface removes.

### 7. Durable workflow phases

Make long workflows explicit:

```text
Read
  -> Normalize / Transform
  -> Decide
  -> Write
  -> Verify / ReadBack
  -> Refresh derived workspace
  -> Notify
  -> Capture workflow_step_result
  -> Publish terminal
```

Benefits:

- Phase-specific capability leases and prompt surfaces.
- Smaller model context.
- Clear restart checkpoints.
- Writes are isolated from exploratory reads.
- Verification can resume without repeating a landed write.
- Deterministic local transforms replace repeated model arithmetic/string processing.

### 8. One canonical terminal and outbox

Commit one source-bound terminal and one origin-terminal outbox group. Mobile transcript, Activity, Discord, Slack, desktop, web push, and APNs are projections with immutable per-destination delivery and receipt rows, so partial delivery and crash replay remain independently idempotent.

Required properties:

- One terminal per origin/source group.
- Live and replay render byte-equivalent status/text/order.
- Failure cannot become green.
- Cancellation cannot render as generic failure or resumable limit exhaustion.
- An old background terminal cannot settle newer foreground work.
- Crash after terminal commit but before delivery replays the outbox exactly once per destination receipt.

### 9. Typed legacy-workflow migration

Build a migration planner, not a shell bypass:

1. Parse the immutable legacy step.
2. Identify exact representable capabilities, inputs, outputs, dependencies, and effects.
3. Separate external calls from pure deterministic computation.
4. Produce a new immutable workflow version.
5. Validate typed readiness and dry-run read-only phases.
6. Ask only for genuinely new high-consequence consent.
7. Run manually once and verify outputs.
8. Activate its schedule only after the clean run.
9. Preserve the prior version for rollback.

Unsupported script behavior remains quarantined with an exact migration dependency. Clem may autonomously migrate only transformations she can prove semantically equivalent.

## External framework research and how it applies

The following are primary-source design references, accessed 2026-08-31. They are design references, not dependencies the code must adopt wholesale.

### Hermes Agent

Official references:

- [Hermes agent loop](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- [Hermes architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)

Useful ideas:

- One recognizable model/tool loop instead of provider-specific execution paths.
- Independent tool calls may run concurrently, but results return to the model in stable call order.
- Stable and volatile prompt layers are separated.
- Context pressure is handled with compression rather than blindly carrying every raw payload forever.
- Model fallback belongs at the model boundary, not inside effect execution.

Apply here:

- Preserve “one loop, many brains.”
- Keep the ToolKernel as the sole effect owner.
- Use bounded concurrent fanout only when calls are independent and cardinality is explicit.
- Replace the current huge raw-history carry-forward with compact result handles, deterministic summaries, and on-demand exact schema/result retrieval.

Do not copy:

- An in-memory registry or prompt text as effect authority.
- A simple agent loop as a substitute for durable checkpoints, exact consent, or physical dispatch settlement.

### LangGraph persistence and interrupts

Official references:

- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

Useful ideas:

- A thread/checkpointer owns graph state and enables durable resume/fault tolerance.
- Durable cross-thread knowledge is separate from per-thread graph checkpoints.
- An interrupted node restarts from the beginning when resumed.
- Side effects before an interrupt must be idempotent or isolated into separate nodes.

Apply here:

- Separate checkpoint state from memory/catalog knowledge.
- Never place an unguarded write before an approval/input interrupt in the same replayable node.
- Make write, readback, and terminal publication separate durable nodes/steps with exact IDs.

### Temporal

Official references:

- [Temporal workflow definition and deterministic replay](https://docs.temporal.io/workflow-definition)
- [Temporal retry policies](https://docs.temporal.io/encyclopedia/retry-policies)

Useful ideas:

- Workflow replay must be deterministic.
- External APIs, clocks, randomness, and LLM calls belong in activity-like boundaries whose results are recorded.
- Running workflows require explicit versioning compatibility.
- Bad input is a sensible nonretryable condition; retries should be bounded by explicit attempts/timeouts and error type.

Apply here:

- Treat model/provider calls as recorded activities outside deterministic graph reduction.
- Rebuild state by replaying accepted events, not by recontacting a provider to infer the past.
- Type provider-origin transient errors at the adapter boundary.
- Do not retry generic host errors or schema-invalid input as if they were transient provider failures.

### DBOS durable workflows

Official references:

- [DBOS TypeScript workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)
- [DBOS workflow recovery](https://docs.dbos.dev/production/workflow-recovery)

Useful ideas:

- Resume from the last completed durable step.
- Workflow IDs are idempotency keys.
- Step order and parallel start order must be deterministic.
- External/non-deterministic work belongs inside recorded steps.
- Recovery ownership is explicit; an interrupted workflow should not be recovered by multiple executors.

Apply here:

- Keep one occurrence ID and one owner lease.
- Resume only missing nodes, never replay the whole write-capable step because a terminal/result capture was missing.
- Make PID A→B→C recovery a primary acceptance journey.

Critical caveat for both Temporal-style Activities and DBOS-style steps:

> Durable orchestration does not magically make an external side effect exactly once across a crash boundary. An activity/step may be invoked at least once even when workflow state is durable. Clementine must retain exact logical/physical call IDs, provider idempotency keys where available, and readback/reconciliation when a provider cannot prove idempotency.

### OpenAI Agents SDK tracing

Official reference:

- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)

Useful ideas:

- One end-to-end trace can group LLM, tool, handoff, and guardrail spans.
- A group/conversation ID links related spans.
- Custom processors can export or redact trace data.

Apply here:

- Emit a single correlation tuple across source, accepted batch, workflow run/step, logical call, physical dispatch, recovery edge, and terminal.
- Preserve bounded typed error metadata while redacting provider/user secrets.
- Build a one-command incident bundle rather than reconstructing causality manually from SQLite, JSON run records, and daemon logs.

The architectural inference from all five references is consistent: keep orchestration deterministic and replayable; isolate external/model work behind recorded boundaries; make interruption and retry semantics explicit; and use one durable identity across the lifecycle.

## Prioritized implementation plan

This order is deliberate. Do not restart the live test loop after every helper patch. Close the causal slice, run its production-lane tests, then perform one controlled live canary.

### Phase 0 — freeze evidence and create an ownership inventory

Before editing:

- Confirm no workflow is actively mutating external state.
- Record daemon PID, source fingerprint, implementation manifest digest, current branch/HEAD, and active run IDs.
- Copy only bounded incident metadata, not secrets or full provider payloads, into the engineering note.
- Inventory every dirty tracked file and every untracked production/test/artifact file by feature owner.
- Identify generated files and the exact command that owns them.
- Do not reset or discard the shared dirty tree.
- Do not stage all files.

Minimum read-only commands:

```bash
git status --short
git diff --stat
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
rg -n 'status|terminalOutcome|readinessMessage' \
  ~/.clementine-next/workflows/runs/1788218615780-a95653.json
```

### Phase 1 — fix nested schema repair and recovery-surface agreement

Primary files likely involved:

- `src/runtime/harness/proof-provider-args.ts`
- `src/runtime/harness/host-no-progress-projection.ts`
- `src/runtime/harness/host-turn-runner.ts`
- a new small leaf module for `SchemaRepairArtifactV1`
- provider-neutral focused tests

Required behavior:

1. Recursive validator reports exact failing paths and a bounded minimal schema subtree.
2. Invalid explicit args settle `invalid_arguments/refused_pre_dispatch` with zero physical crossing.
3. The recovery decision and visible tool surface are derived from the same artifact/edge.
4. Preferred: repair artifact arrives in the refusal and the next turn allows only one corrected call of the same exact operation.
5. If inspection is a separate edge, the host exposes only the exact local inspection control first, then only the original operation.
6. A repaired valid call proceeds into authored workflow consent and may cross once.
7. Same bad args/artifact repeated do not create progress.
8. Wrong source/op/account/schema/manifest/batch cannot consume the repair artifact.
9. Restart after refusal and before repair reopens the artifact exactly.

Provider-neutral causal test shape:

```text
OPAQUE_TABLE_INSERT_V7
schema:
  destination_id: string
  insertion:
    required: [range]
    range:
      required: [axis, start_index, end_index]
      axis enum: [ROWS, COLUMNS]

turn 1: camelCase children / wrong nesting
  -> zero crossing
  -> exact bounded repair paths

turn 2: corrected snake_case nested object
  -> exact standing workflow grant
  -> one physical body
  -> succeeded settlement

replay:
  -> settled replay
  -> zero second body
```

Do not encode the Google Sheets field names in production logic. It is fine for the Platform live canary to use its real provider schema after the generic regression passes.

### Phase 2 — fix cross-PID catalog identity rehydration

Primary files likely involved:

- `src/runtime/harness/restart-recovery.ts`
- `src/runtime/harness/async-read-refinement-recovery.ts`
- catalog snapshot/reopen helpers
- `src/journeys/northstar-local-llm-content-workspace.host-e2e.test.ts`

Required behavior:

- Add a typed mismatch diagnostic containing only component names and bounded digests.
- Determine whether drift is key ordering, schema normalization, implementation artifact identity, port selection, provider fingerprint, operation version, or process-local data.
- Canonicalize at both write and read boundaries.
- Persist all authority-bearing bytes; rehydrate process-local ports/handlers only after exact identity proof.
- Keep true mismatches fail-closed.
- Pass the exact PID A→B→C journey and its tamper negatives.

### Phase 3 — unify authored send authority

Primary files likely involved:

- `src/runtime/harness/authored-workflow-write-authority.ts` or a renamed effect-aware authored-workflow authority module
- `src/runtime/harness/host-turn-runner.ts`
- `src/runtime/harness/host-interactive-consent.ts`
- `src/execution/workflow-runner.ts`
- provider-neutral `host_v1` tests

Required behavior:

- Ordinary write behavior remains unchanged.
- Immutable `sideEffect: send`, `requiresApproval:false` creates an exact destination/cardinality-bound standing send grant.
- `requiresApproval:true` creates one durable approval and exact resume.
- Scheduled and first-run sends follow authored policy without broad `allowAnySend` bypass.
- Delete/admin/destructive/unknown effects remain denied or separately approved.
- Destination drift and foreign operation fail before crossing.
- Crash before and after approval/crossing is exactly once.

Do not merely set `consentOwned=false` for all sends. That would reintroduce split ownership and could bypass the new exact evaluator.

### Phase 4 — renewable capability evidence

Primary files likely involved:

- `src/runtime/harness/independent-capability-observation.ts`
- `src/runtime/harness/accepted-turn-call-authority.ts`
- `src/runtime/harness/dispatch-ledger.ts`
- `src/runtime/harness/implementation-artifacts/transport-entry.ts`
- workflow external-catalog preparation

Required behavior:

- Replace age-only truth with an exact renewable lease generation.
- Revalidate definition + account + schema + port + implementation before crossing.
- Renew unchanged identity; refuse changed identity before reservation.
- Keep unrelated stale catalog entries outside the selected source scope.
- Use fake time and restart tests; do not make tests sleep 60 seconds.

### Phase 5 — effect-aware restart and recovery messaging

Required behavior:

- Derive uncertainty from durable crossing and settlement rows.
- A write-capable step with only proven settled reads is not labeled “may have written.”
- Unknown/in-flight write remains non-replayable until reconciliation.
- Missing `workflow_step_result` never triggers a whole-step retry after possible effects; use same-source in-loop continuation only.

Use `trigger-abb2a8f3f2ca7b0629cdd014d5a9da74` as the historical fixture shape, but keep production code opaque and generic.

### Phase 6 — finish Friday migration or formally quarantine it

Choose one honest outcome before tag:

- **Migrated:** typed exact reads + bounded transforms/reviewed local commit; manual run succeeds; schedule readiness passes.
- **Quarantined:** one clear migration-required state and notice; no Resume; no claim that it will run after restart.

Do not auto-enable an unproven migration overnight.

### Phase 7 — reduce prompt/context pressure

The latest Platform run spent roughly 14 minutes and reached a composed prompt near 52.7k tokens before the final schema guess.

Actions:

- Store full tool outputs behind durable result handles.
- Project bounded typed summaries into model history.
- Retrieve exact rows/subtrees only when needed.
- Keep selected schema available on demand rather than repeating all schemas every turn.
- Move deterministic filtering, timestamp arithmetic, joins, and formatting into reviewed transforms.
- Phase large workflows so the write turn does not carry every raw read payload.

This is a latency/cost/reliability improvement, not a substitute for fixing the recovery protocol.

### Phase 8 — fix provider-origin unknown errors

At provider/model adapter boundaries:

- Wrap errors with typed origin, phase, status/code when available, bounded redacted message, retryability, and whether actionable output/effect occurred.
- Allow at most one pre-actionable fallback for a typed provider-origin unknown.
- Never fall over after a tool frame, accepted actionable output, or physical effect.
- Generic host programming errors remain nonretryable.

### Phase 9 — session reaper and notification hygiene

- Reproduce the reaper FK failure.
- Fix deletion ordering/ownership without deleting active async/workflow rows.
- Verify one origin terminal, one Activity carrier, and one receipt per enabled external destination.
- Add an explicit product-state check for missing mobile push registration so “durable transcript” and “push delivered” are never conflated.

## Required tests before another user retest

### New causal tests

- Nested invalid args → exact repair artifact → one corrected crossing → settled replay.
- Repair artifact survives restart and rejects wrong identity.
- Recovery surface exactly matches repair instructions.
- Authored send through production `host_v1`, with and without approval.
- Hard-cut PID A→B→C exact continuation.
- Effect-ledger-aware restart after only reads in a write-capable step.
- Canonical `run.status` and `terminalOutcome` convergence.
- Explicit Stop with empty terminal text renders `Stopped`, never “say continue.”

### Metamorphic and adversarial tests

- Provider result direct versus trusted adapter carrier produces identical settlement truth.
- Same schema with different JSON property order produces identical canonical identity.
- Changed schema/account/port/implementation refuses before crossing.
- Bad nested type, unknown nested field, missing required child, array item mismatch, enum mismatch, and `oneOf` mismatch produce bounded exact repair.
- Repair payload cannot nominate operation/account/effect/destination.
- Duplicate accepted frame/logical call cannot rerun a physical body.
- Forged chat/workflow metadata cannot mint authored authority.
- Wildcard PlanScope alone cannot mint provider write/send authority.
- Old background terminal cannot settle a newer foreground source.

### Current reported local matrix

These results were reported on the dirty current bytes and must be rerun from the final candidate:

| Suite                            | Reported result |
| -------------------------------- | --------------: |
| Workflow runner                  |         225/225 |
| Host turn runner                 |         211/211 |
| Mobile/chat/Stop                 |         121/121 |
| Delivery/report-back             |         110/110 |
| Scheduler/queue                  |         134/134 |
| Restart/Stop                     |           21/21 |
| Migrations                       |             5/5 |
| Selected replay/revalidation     |           23/23 |
| Authored workflow authority/risk |           20/20 |
| Typechecks                       |           Green |
| Mobile production build          |           Green |
| Artifact verification            |           Green |

The initially observed broad-suite red fixtures were repaired:

- Isolated transport lacked the new JIT preparation export; it now validates explicitly registered exact operation/account observations. Full host-turn-runner later reported 211/211.
- Two selected-revalidation fixtures appended disclosure before the immutable initial planning card. Updating them exposed a real replay gap: compatible current same-source disclosure was not restored to staged planning. The generic staged replay fix and planning-card recovery suite later reported 23/23.

Important isolation caveat:

> The isolated runner’s post-run real-home sentinel repeatedly reported “NOT PERFORMED” because the live daemon owned the normal home. Test bodies used disposable homes and passed, but the final release matrix must run with the daemon stopped so the sentinel can certify isolation.

Useful focused rerun commands from today’s evidence:

```bash
node scripts/run-tests-isolated.mjs \
  src/runtime/harness/authored-workflow-write-authority.acceptance.red.test.ts \
  src/runtime/harness/external-capability-risk-loader.test.ts

node scripts/run-tests-isolated.mjs \
  src/execution/workflow-step-external-catalog.test.ts \
  src/runtime/harness/proof-provisioned-execution.test.ts \
  src/runtime/harness/proof-provisioned-cold-rehydration.test.ts

node scripts/run-tests-isolated.mjs \
  src/runtime/harness/host-turn-runner.test.ts

node scripts/run-tests-isolated.mjs \
  src/runtime/harness/implementation-artifacts/transport-leaf-closure.test.ts \
  src/runtime/harness/host-tool-invocation.test.ts

npx tsx --test packages/chat-engine/src/*.test.ts

node scripts/run-tests-isolated.mjs \
  src/execution/workflow-scheduler-readiness-block.test.ts \
  src/execution/workflow-run-report-back.test.ts
```

The receiving agent should add the new nested-schema and authored-send causal files to this focused baseline before another live run.

## Live canary sequence after the causal fixes

Do not start with Platform 49. Use a ladder so the first failed invariant is obvious.

### Canary 1 — no-tool and simple read

- One ordinary chat response.
- One exact provider read.
- Verify accepted source, one logical call, one physical call, success settlement, one terminal.

### Canary 2 — paginated read and compact history

- Multi-page read with opaque cursor copied exactly.
- Verify each page once and bounded model projection.
- Restart after one page and resume only missing pages.

### Canary 3 — generic ordinary write

- Opaque provider operation with nested schema.
- Force one invalid nested call.
- Verify zero crossing + exact repair + one corrected write.
- Read back and verify.
- Replay and restart must not duplicate.

### Canary 4 — Platform 49

Required success criteria:

- Exact named workflow dispatches once.
- All selected reads settle structurally.
- Invalid schema, if emitted, repairs without broad discovery.
- Intended insert/update calls each cross no more than once.
- Write readback/verification succeeds.
- Workspace refresh succeeds from exact selected read authority.
- Notification succeeds according to authored policy.
- Actual `workflow_step_result` is captured.
- One origin terminal appears live.
- Leave/reopen preserves the same bubble/status.
- Second idempotent run creates no duplicate rows/digest/update beyond the workflow contract.

### Canary 5 — Salesforce to Sheet

- Resolve Tim from bounded durable context.
- Execute exact Salesforce query.
- Create and populate one Sheet.
- Verify returned rows and Sheet handle.
- One report-back.

### Canary 6 — Friday dashboard

- Only if migrated.
- Manual run first.
- Verify Salesforce reads, deterministic transform, exact local artifact/data update, and view refresh.
- Then verify schedule readiness.

### Canary 7 — mobile lifecycle

- Start delegated run.
- Collapse/expand; Stop appears only expanded.
- Leave app, return, send an intervening foreground message.
- Let a delegated result arrive while foreground work exists.
- Verify exact bubble ownership.
- Run another occurrence and confirm Stop cancels only that run.
- Reopen and see one `Stopped` terminal.
- Test native push separately on a registered device if release notes claim it.

### Canary 8 — hard-cut recovery

- Kill at the same cut points as the PID A→B→C journey:
  - before any body;
  - after read;
  - after write crossing/before settlement;
  - after settlement/before result capture;
  - after terminal commit/before delivery.
- Verify no duplicate effects and one terminal/outbox.

## Release closure and tag checklist

The user wants a tag by tomorrow morning. The shortest honest path is to reduce scope and prove it, not to tag over a red live journey.

### Code and state closure

- [ ] No active run is in an unknown/in-flight write state.
- [ ] Nested schema repair P0 is fixed generically.
- [ ] Hard-cut catalog re-attestation P0 is green.
- [ ] Authored sends are either proven through unified consent or explicitly excluded from the release claim with affected workflows disabled/quarantined.
- [ ] Friday dashboard is migrated and proven, or truthfully quarantined.
- [ ] Salesforce→Sheet passes end to end.
- [ ] Effect-aware restart copy is truthful.
- [ ] Session reaper FK failure is fixed or conclusively shown harmless with a tracked follow-up and no release-critical residue.

### Repository closure

- [ ] Every dirty file has an owner and inclusion/exclusion decision.
- [ ] No user/unrelated changes are overwritten.
- [ ] All required new production modules and tests are tracked.
- [ ] Old emitted artifacts are replaced by the exact manifest-referenced new files.
- [ ] No stale digest-addressed artifact remains referenced.
- [ ] Package/release documentation matches actual scope.
- [ ] No fixture/test bypass exists in production.
- [ ] Worktree is clean at the candidate commit.

### Deterministic local closure

Run from a stopped daemon and clean disposable home:

```bash
npm run typecheck
npm --prefix apps/mobile-web run typecheck
npm run build
npm run build:mobile-web
npm test
npm run test:release-closure
npm run test:release-assets
npm run test:smoke
npm run test:packed-candidate
npm run test:packaged-upgrade
npm run rehearse:upgrade:v314
```

Also run the exact causal files for:

- nested schema repair;
- authored workflow authority/send;
- hard-cut async recovery;
- workflow external catalog;
- host turn/invocation/settlement;
- workflow runner/scheduler/report-back;
- delegated mobile replay/Stop.

### Packaged candidate closure

- [ ] Build a package from the clean commit.
- [ ] Install it into a clean temporary home.
- [ ] Start the packaged daemon, not `tsx` source.
- [ ] Confirm source/build/implementation fingerprints match the package.
- [ ] Run the no-tool/read/write/restart core canary.
- [ ] Restart and repeat settled replay.
- [ ] Run the v3.14 two-boot upgrade rehearsal.
- [ ] Confirm migration markers and no legacy fallback reads on boot two.
- [ ] Confirm generated artifacts are fresh, tracked, and present in the package.

### Live closure

- [ ] Platform 49 passes fully.
- [ ] Platform 49 second run is idempotent.
- [ ] Salesforce→Sheet passes.
- [ ] Friday is migrated/proven or explicitly quarantined.
- [ ] Mobile leave/reopen and overlapping-turn report-back pass.
- [ ] Mobile Stop passes on device.
- [ ] Native push passes only if claimed.

### Tag record

Record before tagging:

- commit SHA;
- package hash;
- implementation manifest/build-stamp hash;
- emitted artifact hashes;
- daemon/source fingerprint;
- test commands and totals;
- packaged install location/home;
- live canary run/session/source IDs;
- known quarantined workflows or excluded claims.

Tag only the exact tested clean commit. If either the hard-cut journey or the live ordinary-write journey remains red, do not tag regardless of the clock.

## Remaining backlog by priority

### P0 — must close or explicitly remove from release claim

- Nested schema repair artifact and recovery-surface agreement.
- Hard-cut cross-PID catalog snapshot re-attestation.
- Authored send authority through unified consent for any enabled send workflow in release scope.
- Clean candidate inventory and tracked emitted artifacts.
- Platform 49 full live write/readback/result/terminal.
- Salesforce→Sheet full live acceptance if the release claims arbitrary compound app work.
- Friday dashboard migration if the release claims enabled legacy schedules remain operational.

### P1 — high-priority release hardening

- Renewable exact capability lease beyond a fixed 60-second observation.
- Effect-ledger-aware restart/recovery copy.
- Typed provider-origin unknown errors and bounded pre-actionable fallback.
- Session-reaper FK cleanup failure.
- Canonical run status versus terminal outcome convergence.
- Empty explicit-cancel terminal copy.
- Native mobile push registration/acceptance if promised.
- Prompt/context compaction for long workflow phases.
- Space refresh cold-catalog path live proof.

### Async Northstar acceptance gaps still worth preserving

The async S→R→W work has useful local coverage, but do not declare it complete until these remain green together:

- Fresh-PID hard cut after Search + START + partial GET.
- Stop-specific kill provenance rather than generic `requestKill` ambiguity.
- Successful-but-malformed START receipt with missing job ID/URL must not park forever.
- Pre-START search result cardinality and usable-row gate.
- Hostile/unselected search snippets must not enter model history unbounded.
- Completed-insufficient positive terminal and exact continuity/idempotence.
- Receipt tamper, ownership race, and recovery failure adversarials.
- Schema migration normalization for older async rows.
- Fairness with more than three concurrent jobs.

## Explicit anti-patterns

- Do not hardcode Platform 49, Slack, Sheets, Salesforce, Friday, account IDs, channel IDs, spreadsheet IDs, or provider-specific nested fields in production policy.
- Do not remove a safety gate to make a canary green.
- Do not globally increase every 60-second lifetime.
- Do not ask the model to rediscover exact schema/catalog/account facts already held by the host.
- Do not emit a repair instruction for a control absent from the next model surface.
- Do not count wording changes, new model call IDs, or repeated bad arguments as progress.
- Do not retry a whole write-capable workflow step merely because `workflow_step_result` was omitted.
- Do not retry or fail over after an uncertain or landed external effect.
- Do not treat prompt text, memory, rendered input, or model-selected operation names as authority.
- Do not authorize a write/send from wildcard `PlanScope` alone.
- Do not re-enable arbitrary raw subprocess or generic shell execution.
- Do not auto-migrate an arbitrary script without proving semantic equivalence.
- Do not make every generic `Error` transient/retryable.
- Do not loosen cross-PID catalog identity equality to make recovery pass.
- Do not call the broad dirty-tree test matrix proof of a clean packaged release.
- Do not stage the mixed worktree with `git add -A` without an ownership inventory.
- Do not tag source while required production modules or digest-addressed artifacts are untracked.
- Do not claim push delivery from a durable transcript receipt when no device destination is registered.

## Suggested agent operating procedure

The receiving agent should use this sequence for every remaining defect:

1. Read the exact run/session/source and durable ledger before editing.
2. State the first causal seam and why it is framework-level.
3. Resolve production file ownership before modifying a dirty file.
4. Write a provider-neutral red test through the production lane.
5. Patch the smallest shared invariant.
6. Prove zero crossing for invalid/refused work.
7. Prove one crossing for corrected work.
8. Prove settled replay and restart do not cross again.
9. Run adjacent suites and full typecheck.
10. Stop the daemon before the final isolated matrix so the sentinel can certify the real home.
11. Restart only when no active run can be made uncertain.
12. Let the user run the live canary; monitor read-only and report the first causal anomaly.
13. Freeze evidence before the next edit.
14. Once all canaries pass, build the explicit release inventory and clean candidate.

## Copy/paste brief for the receiving agent

```text
Own the Northstar harness stabilization and release closure described in
docs/NORTHSTAR-HARNESS-HANDOFF-2026-08-31.md.

Start read-only. Preserve the dirty shared worktree and do not reset, stage all,
restart the daemon, or invoke a workflow until you have checked active effects.

First close the generic nested-schema recovery contradiction:
- exact bounded recursive repair material;
- recovery surface derived from the same typed edge;
- bad args zero crossing;
- corrected same-source ordinary workflow write crosses once;
- settled replay and restart cross zero additional times.

Then close the red PID A→B→C catalog_snapshot_identity_mismatch without
weakening exact identity. Next unify authored send authority through host_v1,
keeping delete/admin/destructive/unknown effects separate.

Use opaque/provider-neutral production tests. Do not add Slack/Sheets/Salesforce
or workflow-name branches. Run the full stopped-daemon isolated matrix, then the
packaged candidate and live canary ladder. Platform 49 must complete writes,
readback/refresh, workflow_step_result, and one mobile terminal; Salesforce to
Sheet must execute both systems. Migrate Friday safely or quarantine it
truthfully. Inventory and commit only intended files/artifacts. Tag only the
exact clean commit that passed the packaged and live canaries.
```

## Appendix A — key run records

All records are under `~/.clementine-next/workflows/runs/`.

```text
1788180378863-52866a     early Platform catalog-missing block
trigger-9ede6599...      scheduled typed_catalog_not_ready
1788189316178-01ca4a     manual typed_catalog_not_ready
1788190642993-57eeea     readback/connection-expiry block
1788195448925-379b44     false two-business-call failure
1788201716184-f6311f     missing exact operations / catalog provision
1788205574604-7c352c     bad args -> {} and status/outcome inconsistency
1788208892944-a2129e     cold validator / nested local discovery control
1788213168061-788b2e     authored workflow write coverage missing
trigger-abb2a8f3...      restart after reads, false may-have-written copy
1788218615780-a95653     latest nested schema recovery failure
trigger-3b546b3d...      Friday dashboard blocked readiness
```

## Appendix B — code map

| Concern                       | Primary files                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow catalog preparation  | `src/execution/workflow-step-external-catalog.ts`, `src/execution/workflow-runner.ts`                                                                         |
| Accepted-source catalog scope | `src/runtime/harness/accepted-source-catalog-scope.ts`                                                                                                        |
| Proof args/schema validation  | `src/runtime/harness/proof-provider-args.ts`, `src/runtime/harness/proof-provisioned-catalog.ts`                                                              |
| Authored workflow authority   | `src/runtime/harness/authored-workflow-write-authority.ts`, `src/agents/plan-scope.ts`                                                                        |
| Host consent and execution    | `src/runtime/harness/host-turn-runner.ts`, `src/runtime/harness/host-interactive-consent.ts`, `src/runtime/harness/host-tool-invocation.ts`                   |
| Capability risk               | `src/runtime/harness/external-capability-risk-loader.ts`                                                                                                      |
| Settlement truth              | `src/runtime/harness/attempt-settlement.ts`, `src/runtime/harness/accepted-source-settlement-audit.ts`                                                        |
| No-progress                   | `src/runtime/harness/host-no-progress-projection.ts`, `src/runtime/harness/no-progress-governor.ts`                                                           |
| Step result contract          | `src/tools/step-result-tool.ts`, `src/runtime/harness/workflow-step-result-continuation.ts`                                                                   |
| Async continuation/restart    | `src/runtime/harness/async-read-continuation-contract.ts`, `src/runtime/harness/async-read-refinement-recovery.ts`, `src/runtime/harness/restart-recovery.ts` |
| Workflow origin terminal      | `src/execution/workflow-origin-terminal.ts`, `src/execution/workflow-run-report-back.ts`, `src/execution/workflow-origin-group.ts`                            |
| Mobile/chat projection        | `packages/chat-engine/src/engine.ts`, `packages/chat-engine/src/stream.ts`, `packages/chat-engine/src/terminal-presentation.ts`                               |
| Mobile Stop/API               | `apps/mobile-web/src/components/RunControl.tsx`, `apps/mobile-web/src/screens/Chat.tsx`, `src/channels/mobile-routes.ts`                                      |
| Scheduler readiness           | `src/execution/workflow-scheduler.ts`, `src/tools/workflow-run-queue.ts`                                                                                      |
| Reviewed Workspace data       | `src/spaces/workspace-set-data-contract.ts`, `src/spaces/workspace-set-data-executor.ts`, `src/spaces/workspace-set-data-carrier.ts`                          |
| Implementation artifacts      | `src/runtime/harness/implementation-artifacts/`                                                                                                               |
| Release rehearsal             | `scripts/rehearse-v314-upgrade.mts`, `scripts/smoke-packed-candidate.mjs`, `docs/NEXT-TAG-RELEASE-GATE.md`                                                    |

## Appendix C — success criteria stated as invariants

1. A cold process can execute only exact capabilities derived from immutable accepted source/workflow declarations.
2. A model cannot select or widen operation, account, effect, destination, schema, or implementation authority through arguments or prose.
3. Invalid explicit provider args never cross the provider boundary.
4. A safe schema refusal carries enough bounded exact structure for deterministic recovery.
5. Repair instructions and the permitted next surface are the same protocol.
6. One logical call owns at most one physical body.
7. A landed or uncertain write is never blindly replayed.
8. Saved workflow grants are effect-aware and exact; sends do not inherit ordinary-write authority.
9. Recovery across PIDs reopens byte-equivalent accepted authority and executes only missing work.
10. Structural progress is durable evidence, not model variation.
11. A workflow output contract requires the actual structured result.
12. One source owns one canonical terminal and one outbox.
13. Live and replay produce the same mobile transcript and status.
14. Deterministic migration/readiness failures never masquerade as daemon downtime.
15. A tag identifies the exact clean packaged commit that passed the canaries.

## Final verdict

The team made real progress today, and several of the earlier walls are now demonstrably behind the latest run. But the current release candidate is still a source tree under active repair, not a taggable artifact.

The immediate path is narrow and achievable:

1. fix the generic nested-schema recovery contract;
2. fix exact catalog re-attestation across PID recovery;
3. close or explicitly scope out authored sends;
4. rerun the production-lane causal tests;
5. pass Platform 49 and Salesforce→Sheet live;
6. migrate or quarantine Friday honestly;
7. produce a clean, packaged, two-boot-tested commit;
8. tag that commit and nothing else.

If those gates are green, the release can be defended. If they are not, tagging by the clock would merely move today’s failures into a versioned build.
