## Night addendum — 2026-08-31 → 09-01 (integration of the stabilization plan)

Plan: `~/.claude/plans/start-by-reading-the-bubbly-riddle.md` (approved 2026-08-31 ~21:40 PT).
Base: the dirty wave was committed as K1–K9 (`f593aeab`..`6d77e7fa`); nine rings worked in
isolated worktrees and were merged in order M → S → P → B → D → H → W → A → LC.

### What was wrong (measured, not inferred)
- Not the graph: `host-turn-runner.ts` imports nothing from `src/runtime/graph/`; 48 h live = 40/40
  turns on `host_v1`; workflow steps made 0 `plan_task` calls; `graph_journal_entries` = 0 all-time.
- The uncommitted wave had regressed 19 pins that were green at `81b7e2f7` (proved by running the
  same files against a `git archive HEAD` export). All 19 are closed at the tip.
- The named-workflow shortcut swallowed a workflow's own step for 5 of 8 enabled workflows because
  the contract renderer's line "a mismatch fails the run:" matched `\brun\b` (since `d3bc85ca`, 08-30).
  With a reply target present it actually queued a recursive run.
- Reversible registry local writes inside a prose step (`task_hygiene`, `goal_upsert`, `space_refresh`)
  hit `coverage_missing` under unified consent — end-of-day's 09-01 "bounded internal host error".
- The `sf` auth probe cached a transient as `authStatus:'error'`; the owner's CLI works.

### Gate inventory outcome (see the plan's table for evidence)
| # | Gate | Result |
|---|---|---|
| 1 | named-workflow shortcut on a workflow's own step | removed for workflow-internal sources (+ plan_task twin) |
| 2 | schema refusal recommending a control the surface removes | exact failing paths + bounded subtree; retry same op; new failing-path set is progress; `repairKey` threaded through both mint paths; carrier sweep on `composio-batch-validator` |
| 3 | prose-step reversible local writes → `coverage_missing` | authored-step receipt covers them (same seam as Sheets writes) |
| 4 | authored external sends | `requiresApproval:false` → the same exact standing grant as writes; `true` → one approval card bound to the immutable step → exact resume once; one send per step attempt; `allowAnySend` deleted (ring LC part 3, 67/67 pins incl. the host acceptance suite) |
| 5/6 | frozen card / "progressed" refusal | removed; prime extends the card with same-source disclosures |
| 7 | sole work_call refused (schema fields not mirrored) | mirrored + connection pin |
| 8 | plan_task throws / lexical read refusal + false done / substitute writes | typed refusals; compiler owns route; ask-only missing-write refusal (contract branch pinned) |
| 9 | hard-cut `catalog_snapshot_identity_mismatch` | prime guard (byte-match to installed manifest + fresh non-refused observation) + a ready `continue` checkpoint is taken in the same `runConversation` call instead of waiting for the next recovery tick; journey fixtures share one source for the async S→R→W pages (ring B; catalog + continuation pins 23/23; hard-cut journey in the journeys run below) |
| 10 | unprovisioned literal op → silent refusals | G0 refuses naming the op; G2 names it as a host fault |
| 11 | "bounded internal host error", `blockedReason='blocked'` | machine reason + bounded `blockedDetail` persisted |
| 12 | output-contract hard-fail on ordinary steps | ordinary contract-bearing steps get one evidence-fed repair beat through the existing loopUntil primitive (`maxAttempts: 2`); a second miss still fails `output_contract` |
| 13 | readiness inventory ≠ executor registries | inventory = registry `localExecution` ∪ reviewed-CLI descriptors |
| 14 | `sf` probe caches transients as auth errors | last-known-good kept + `staleSince`/`lastProbeError`, logged; surfaces say "checked Xh ago, last probe failed" |
| 15 | binding-seal "held" forever | age budget (15 min from the intent's `recorded_at`) → one factual, non-resumable terminal; sweeps skip expired |
| 16 | invalid local input laundered into `succeeded` | nominal carrier at the producer on every surface; metamorphic lane pin |
| 17 | v72/v73 partial index breaks on corrupt legacy `metadata_json` | migration **v74** + `json_valid` guards |
| W | shipped invoke artifact bundled a second `eventlog` | artifact is a leaf again (17 modules / ~70 KB, `node:*` only); workspace commit crosses a host-bound carrier |

### Schema
`HARNESS_SCHEMA_VERSION` 73 → **74** (additive: drop/recreate `idx_sessions_chat_run_in_flight_updated`
behind `json_valid`). The v3.14 → current two-boot rehearsal runs end to end again: its dependency
proof now checks that every v3.14.0 package is present at its identical lock entry (extras such as
`parse5` allowed) instead of demanding lock identity.

### Live findings after the merge (owner's 02:00 PT phone tests + the 02:50 GLM baseline)
Every one of these was read straight off the new `blockedReason`/`blockedDetail` fields — the first time
in two weeks a failed run named its own cause.
- **platform-49 (02:00):** the model needed `sheet_id` and selected a provider READ
  (`GOOGLESHEETS_GET_SPREADSHEET_INFO`) that the six-operation frozen snapshot never carried →
  `catalog_entry_or_manifest_missing`. Fix: a **JIT read edge** in `host-turn-runner.ts` — when the exact
  production miss is a catalog miss for a carried operation, the host provisions that one definition
  (bounded, once per operation per turn) and re-runs the same exact check; a READ binds through the
  proven-live-read path, a WRITE still stops at the frozen/authored bar. Hooked where the refusal is
  composed (`executeCall`), not only at the pre-approval site — the first attempt sat at the wrong site
  and the pin caught it. Pinned both ways (READ dispatched once, WRITE still refused).
- **friday-dashboard (02:00):** a structured `call:` step reported `not-connected` for
  `salesforce_sf_soql_query` although readiness counted it ready — the live catalog only learned
  reviewed-CLI operations through foreground `tool_search`. Fix: `ensureLiveReadCapabilityForOperation`
  (`workflow-live-call-compiler.ts`) acquires the saved READ through the attested live-read registry
  before compiling. Supply only; compile still re-proves candidate/account/effect. Pinned from an empty
  catalog with a real sealed reviewed-CLI descriptor. `sf` itself was never the problem.
- **platform-49 GLM baseline #1 (02:50, run `1788256203188-6dbf6b`):** two reads succeeded (Slack history,
  Sheets batch_get, both retained as result handles), then one model frame carried nine refused
  siblings; the no-progress projection mapped every refused call into `recoveryToolNames`, the governor
  constructor threw at its cap of 8, and the runner turned that *projection exception* into a blocked
  terminal (`control_progress_projection_unavailable`) after 3m40s. Fix: the recovery surface is the set of
  DISTINCT refused carriers bounded to one exported cap; pinned (nine same-carrier refusals →
  `['call_tool']`; ten distinct → the cap).
- **platform-49 GLM baseline #2 (03:00, run `1788256808207-d4945e`):** 23 successful reads over 25
  minutes — including `GOOGLESHEETS_GET_SPREADSHEET_INFO`, which the JIT read edge provisioned live —
  then every write was refused until the governor exhausted (`blockedDetail:
  host_disposition:refused_pre_dispatch`). The step's plan scope had been opened with
  `WORKFLOW_STEP_WALL_CLOCK_MS + 60s` (16 min) while the host legitimately ran the step past its wall
  clock; every write after minute 16 hit `plan_scope_missing_or_changed`. Fix: `openPlanScope` gains
  `attemptBound` — a workflow step's scope lives until the runner closes it on `workflow-step-finished`,
  with no TTL and no 1h ceiling (consent semantics unchanged; cron keeps its TTL because it preserves held
  scopes). Pinned.
- **platform-49 GLM baseline #3 (03:31, run `1788258688680-d341f5`):** 23 reads again, then the model called
  `composio_search_tools` *through* `composio_execute_tool`. That carrier is `nested_owned` (the host
  adopts the inner call's own durable settlement); the local search ran and returned but wrote none, so
  invocation authority failed closed mid-invocation (`nested-owned logical settlement is missing`), the
  projection receipt conflicted (`tool differs from its logical identity`), the accepted batch lost its
  host root, recovery re-entered ~40 times in 18 s, and the runner parked the run as "interrupted mid-run
  — not re-run" (a dead end for a `sideEffect: write` step). Fix: when the redeemed settlement is
  missing, the inner returned normally, no physical dispatch exists for the logical call (durable rows,
  not just the wrapper's marker), and the frozen contract is non-mutating, the host settles the observed
  result itself; any crossing, mutation, or contract upgrade still fails closed (the row-less provider
  adapter and crossed-inner pins stay green). Note: refusing broker-carried local names pre-dispatch was
  tried and rejected — the host deliberately reroutes `tool_slug: tool_search` through the sealed
  acquisition surface (pinned).
- **platform-49 GLM baseline #4 (04:01, run `1788260460200-4efef7`):** 27 settled reads in 17 minutes,
  then **brain availability**: GLM hit the first-byte transport timeout twice on a ~58k-token prompt
  (history 41k) and went into silent cooldown; the Codex Pro rescue's *weekly* quota is exhausted
  (`usage_limit_reached`, resets 2026-09-06 — `state/model-rate-limits.json`); the Claude OAuth
  subscription rescue had carried several earlier turns of this very run but had gone silent once, so the
  live chain shrank to `[codex]` and one 429 ended the step. Fix: brains silenced earlier in the run are
  demoted to the chain tail instead of dropped (pinned). Not fixed tonight: the prompt size itself —
  compaction is the real latency/timeout lever for a 27-read step.
- **platform-49 GLM baseline #5 (04:24, run `1788261863184-23695e`) — reached the write.** 19 reads in
  10 minutes, then the model dispatched `GOOGLESHEETS_INSERT_DIMENSION` through `composio_execute_tool`
  — the first mutating crossing in five runs; consent, frozen catalog, plan scope and JIT all held. The
  physical dispatch **threw in 3 ms inside the shipped invoke artifact**: `generic external write
  requires current call authority` (`production-capability-adapters.ts:721`). Because the throw came
  after dispatch-start, the host had to settle it `uncertain_write / unacknowledged_mutation` and block
  the run `tool_effect_uncertain` ("must be reconciled") — for a call that provably never left the
  process. **This is the remaining platform-49 blocker, and it is a design fork, not a bug:** the
  adapter's `authority` is a `ResolvedCallAuthority` that only the admitted-construct lane mints
  (`admitted-construct-run.ts:1342` — graph id/hash, node lease, claim event, semantic provenance, write
  judge), i.e. writes are meant to go `plan_task` → `work_call`; rings L/C's authored-step consent lane
  grants the same write through the direct broker path, and its acceptance pins pass only because they
  stub the port (the shipped adapter is never exercised). Two candidate fixes, owner's call: (a) the
  host passes the adapter the narrow invoke authority it actually reads (manifest identity + the sealed
  canonical args from `compileSealedProviderArgs`) *only* when the authored-consent evaluator granted
  the call — the receipt is the authority the owner defined; or (b) refuse a direct broker external
  write pre-dispatch with a diagnostic that names the repair (`plan_task` naming the op, then
  `work_call`), so the model takes the construct lane instead of hitting a dead end. Either way the
  pre-body authority throw in the adapter should become a typed *not-started* refusal so it can never
  read as an uncertain mutation.
- **06:59 — the fork is resolved as option (a) (`41371175`), per the owner's rule that saving and
  enabling a workflow is the consent for its authored writes.** When the authored-consent evaluator
  decides `proceed`, the host records the grant by logical call id and the port invoke mints
  `AuthoredCallAuthorityV1` (`authored-call-authority.ts`): exactly the manifest-identity fields the
  shipped adapter verifies plus the arguments this turn schema-validated as `canonicalArgs` — nothing
  from model text. Reads and ungranted calls pass no authority; the construct lane is untouched. The
  adapter's pre-body refusals are now `ProviderPreDispatchRefusalError`, which settlement reads by class
  name as not-started — a mutation refused there can never settle `uncertain_write`. Invoke artifact
  re-emitted. Pinned at the adapter and the settlement; pin debt: a `runProductionHost` pin observing
  the authority on the port. Baseline #6 (`1788271157248-5b1e0b`) is the live connection proof. The
  suite/packaged declarations below were taken at `a6248874`/`1c3e1177`; this commit was verified with
  focused suites (host 218, adapters, settlement lanes, artifact leaf closure) only.
- **platform-49 GLM baseline #6 (06:59, run `1788271157248-5b1e0b`) — the business work completed.**
  `GOOGLESHEETS_INSERT_DIMENSION` ✔, `GOOGLESHEETS_BATCH_UPDATE` ×2 ✔ (three real mutating crossings on
  the authored call authority), `space_refresh` ✔, `notify_user` ✔, one invalid-arguments write repaired
  in flight. It then blocked on the very last hoop: the step's own hand-back, `workflow_step_result`,
  was refused twice as `effect_unknown` (the runner attaches it per step; it had never been in the tool
  registry) and the no-progress governor reported a finished step as a "bounded internal host error".
  Fix (`fe4f628e`): registry row as a read-effect control + `ALWAYS_READ` in the name taxonomy; pinned.
  Baseline #7 (`1788272392212-08d201`) is the end-to-end proof. Note: #6 already appended today's digest
  row to the real sheet; the workflow's own reconcile-against-log logic is what should keep #7 from
  duplicating it.
- **platform-49 GLM baseline #7 (07:20, run `1788272392212-08d201`, 5½ minutes — the fastest run of the
  night):** reads, JIT, `insert_dimension` ✔, `batch_update` ×2 ✔ again. Blocked `tool_effect_uncertain`
  on `space_refresh`, which this time the model invoked *through* `call_tool` (in #6 it called it
  directly and it succeeded). Two seams, both recorded for the next wave: (1) `space_refresh`'s own
  kernel reads were refused "workflow call independent live observation differs from its plan"
  (`accepted-turn-call-authority.ts:3888`) — the
  Space's saved call plan pins an observation identity that the turn's fresh JIT observations no longer
  match; a static pre-proof on a read, which should re-observe and re-plan, never fail. (2) The outer
  carrier's `adoptedNestedSettlement` threw "conflicts with the frozen invocation contract" because the
  inner settled `mutating:false` (`unknown / execution_failed`, zero crossings) against a `local_write`
  contract — so a failed, no-effect refresh was reported as an uncertain mutation. Fix order: (2) adopt
  a zero-crossing failed inner as `execution_failed` (repairable), then (1) drift → re-observe.
- **Crash-resume poison (hard-cut journey, ring B's same-run diagnostic):** PID A armed the immutable host
  root while `plan_task`'s description carried the initial planning card; PID B's re-prime rebuilt
  `plan_task` with the disclosures the card had gained; `toolSchemaFingerprint` hashed the description, so
  envelope/catalog/binding digests changed and the resumed source was refused as a changed surface
  (`authority_conflict` → poison). On main this meant any crash-resume of a source whose card grew poisoned
  that source. Fix: the `plan_task` builder declares `descriptionCarriesTurnState`; such a tool is
  fingerprinted on name + parameters (the card is turn state the model reads, not the callable
  contract); ordinary tools keep the full contract. `authority_conflict` no longer occurs in the journey.
  **Still open in that journey (pre-existing at ring B's tip, not a regression):** subtests 3/5/10 — the
  resumed boot PID's GET is refused `host_invocation_authority_missing` (no ambient dispatch lease on the
  boot-recovery invocation path), and two fixture projection receipts are unavailable
  (`fixture cold prewrite projection unavailable`, `host_result_receipt_commit_failed`). Evidence and
  file:line map in the scratchpad ring reports (`rings/B.md`).

### Morning (08:00–09:00): authoring audit + workflow self-improvement
- **Authoring is aligned with the new model.** No authoring file changed tonight; the validator refuses a
  `deterministic.runner` step at create time (since the 08-30 release cut), so Clem cannot author a
  workflow she can't run. Its stale "point it at a scripts/ helper" hint now says what to do instead.
  Your vault: 34 workflows — 22 `prompt:` steps, 9 `call:`, 1 `transform:`, and **4 workflows** with 7
  raw runner steps (`team-activity-slack-updates`, `monday-salesforce-opportunity-report`,
  `salesforce-quarterly-to-sheets`, `social-manager-rc-…`). Everything else already runs.
- **Self-improvement on run (`edc16fdd`).** A workflow whose readiness refuses a legacy script step is
  no longer parked "migration required": the queue records a durable improvement request and answers
  `held`; the daemon consumes it like a cron occurrence (system session, `allowedTools ['*']` scope —
  the run request is the consent — one host turn with `workflow_get`/`read_file`/`tool_search`/
  `workflow_update`); then **code** proves the rewrite kept the user's intent (name, goal, trigger,
  resources, inputs, enabled, every `requiresApproval`, every send-destination literal), carries no
  runner, validates and is ready — applying it with a byte backup and re-queuing the run, or reverting
  byte-for-byte and saying exactly why. Six-hour cooldown on a failed attempt. Pinned end to end.
- Two seams found while wiring it: registering `workflow_step_result` as a registry row broke the closed
  project manifest (fixed: the classifier names the channel explicitly, `1bc74d53`), and the
  named-workflow shortcut swallowed the first improvement turn because its prompt said the workflow
  "was asked to run" (fixed: improvement sessions are host-internal, `cc71b172`).
- Brain switched to `claude_oauth` / `claude-sonnet-5` via the console door for the owner's test.
- **Live attempts on `team-activity-slack-updates` (09:00–09:55), each one a real gate, each fixed +
  pinned the same hour:** (1) the named-workflow shortcut swallowed the turn — improvement sessions are
  host-internal; (2) four *different* `plan_task` complaints terminalized at the third — keyed
  `schema_invalid:<key>` stages + transition budget 2→6; (3–4) the single "clean retry" for zero-gain
  lookups killed `read_file`+`recall` paging and `workflow_get` summary→full — deferred as the next
  governor change (ten pins), worked around by inlining the definition and the script into the prompt;
  (5) `schema_too_big:goal.objective` refused three times with no limit named — the admission reason now
  keeps the validator message, and the prompt states the step shapes + field bounds; (6) the consumer
  passed `MODELS.primary` (a Codex id) and overrode the brain switch — no explicit model, the bridge
  resolves the brain role (the cron path still does this); (7) the pinned Sonnet was preselected away
  by a silent cooldown — a pin is a pin for Claude/Codex too and a cooldown never skips it; (8) Sonnet
  crossed the 60 s first-content budget composing on a 45k-token prompt, was silenced, and the turn ended
  on `ask_user_question` (a genuine fork: local baseline file, runtime-built queries, org-URL read) —
  budget 60→150 s with watchdog 75→180 s, the prompt decides max-preserving and never asks, and the
  model's note rides with a failed attempt; (9) on all of that, Sonnet's `plan_task` was refused
  `plan_incomplete_missing_write` (the card never carried `workflow_update`), it ran the prescribed
  `tool_search`, the search disclosed the exact write — and the host terminalized right after that
  success: every write disclosure collapsed to ONE effect token, already spent by the first broad
  search's three unrelated writes. Each distinct exact write ref is now its own bounded effect gain
  (`host-no-progress-projection.ts`, pin added); (10) with the write disclosed, every `plan_task` was
  refused `schema_too_big:goal.objective (<=8000)` — the objective is host-composed from the accepted
  source (a 51 KB brief), nothing the model drafts can shrink it, and a pasted document in chat hits the
  same wall. `boundedSemanticObjective()` projects the source into the budget (whitespace cut + a marker
  naming the omitted count; the source event stays the authority); (11) past both, the model modeled
  the WORKFLOW's six SOQL reads as its own plan (universes, invented `host:*` refs) and was refused
  `coverage and cardinality describe different read sets` twice → loop floor. The brief's own gate-5
  hint ("keep every plan_task field short") had nudged it toward `plan_task` at all; a reversible local
  write is a direct call. The brief now asks for one direct `workflow_update` and forbids planning or
  running the workflow's own operations in that session; the topology refusal names its valid pairs;
  (12) the model then drafted the right one-op `local_write` plan on the exact ref, the host ADMITTED it
  and refused its own persist as `internal_error` (a blanket catch in `turn-graph-shadow.ts`, nothing
  naming the cause), told the model `recoveryTool: retry_host`, and the model called
  `call_tool({name:'retry_host'})`. The cause now goes to the log (the reason vocabulary stays closed);
  the repair text and the directive spell the only walkable edge: `plan_task` again, identical;
  (13) before reaching the persist again, four zero-gain `tool_search` calls for `sf org display` (no
  reviewed read exists; the catalog answered `salesforce_sf_soql_query` every time) spent the ONE clean
  retry — the same floor that killed attempts 3 and 4. `NO_PROGRESS_RETRY_BUDGET` is now a counter of
  three (17 pins re-paced; checkpoint parse restores older checkpoints as fresh; the loop floor and the
  typed-stage budget are unchanged), and the brief says that the same nearest operation twice means no
  closer match exists; (14) Sonnet then crossed the 150 s first-content budget on a frame that was one
  large `workflow_update` call: the raw Messages adapter streams a tool call as `tool-input-start/delta`
  parts, which matched neither the actionable nor the private-activity classifier — 150 s of "silence"
  while the model wrote arguments — and the turn fell to a rate-limited Codex, then GLM, whose frame was
  refused (`host_control_requires_direct_first_class_call`). Tool-input parts now classify as actionable
  output (`fallback-model.ts`; classifier + chain pins); (15) NO host gate fired — Sonnet ran the whole
  turn, then wrote `CONTINUE: … ready to submit … via one workflow_update call next turn` and the run
  completed as a successful answer with nothing written. The host lane runs one turn per source and
  reduces it to a terminal, so the rubric's "more tool calls next turn" had no next turn. The runner now
  keeps the same turn open for a bare CONTINUE marker (bounded, 3), the rubric says so, and the two
  pins cover it; (16) the gate-12 logging fix named the real persist cause: `plan_task binding-seal
  intent could not prepare exact work: non-conversational graph has no expected-work binding writer` —
  the predicate recognized only chat under the host engine (plus background/cron-labeled execution
  graphs), while `selectTurnEngine` ignores session kind: the same host engine owns an execution
  session's turn. An ADMITTED one-op local-write plan was therefore refused at persist, three times per
  run. Chat OR execution under the host engine now counts as the binding writer (`resolution-ledger.ts`;
  the binderless workflow fail-closed pin untouched; the execution-owners pin covers `direct`). Sonnet
  also hit the 150 s first-content wall twice more at exactly the budget (silence measured event-to-
  event), handing the frames to GLM — which would have completed the write both times but for this
  persist gate. Attempt 17 runs on all of it.

### Declared state at the tip
- Full isolated suite (`npm test` at `a6248874`, daemon stopped, zero owners of `harness.db` during the
  run): **14,125 tests — 14,124 pass, 0 fail, 1 skipped**. An earlier pass at `ebae46b3` had three reds,
  all test-side and fixed since: two `plan-task-result-contract` pins whose miniature settlement table
  lacked the `outcome_detail` column the projection now reads, and one randomized `slug-effect` pin
  whose base36 nonce could tokenize to a real verb (`X5POST` → `POST`).
- Journeys (`npm run journeys` at `ebae46b3`, daemon stopped): **156/171**. The 15 reds split cleanly:
  3 are the hard-cut journey seams recorded above (`host_invocation_authority_missing` + two fixture
  projection receipts), and 12 are **pre-existing wave debt, not regressions** — the same five files
  (`plan-task-live-surface.regression`, `progressive-discovery-large-catalog.competitive.red`,
  `provider-neutral-no-random-gate.acceptance`, `restaurant-sheet-model-surface.competitive.red`,
  `restaurant-sheet-natural-request.integration`) had **15** reds at the wave base K9 `6d77e7fa` (the
  tree exactly as handed over, before any ring) and have 12 at the tip; bisected by running the files
  at K9, at ring B's tip `0cd63045`, and at HEAD in throwaway worktrees. Their content: outbound-draft
  approval flow (3 subtests), "verified capability memory never grants authority", the cold
  Discord read+create loop, the 16 KiB model-visible-surface and 70 % warm-cache competitive ceilings
  (surface measured 21.7 KiB), the 10K-catalog permutation gate, and a `work_call` continuation after
  an accepted read plan. These are the next wave's list, in that order.
- Packaged gates: `build` PASS, `test:packed-candidate` PASS, `test:packaged-upgrade` **21/21 PASS** (at
  `1c3e1177`; it was red at `ebae46b3` because the shipped builtin skill seeded on first boot,
  `skills/technical-content-marketing/SKILL.md`, was unknown to the closed first-boot categorizer — now a
  `deterministic_boot_seed` whose list is pinned equal to the package's `builtin-skills/` directory),
  `rehearse:upgrade:v314` PASS, `test:release-assets` PASS, `test:release-closure` PASS, `test:measurement`
  PASS, `proof:selftest` PASS, `tsc --noEmit` PASS. Billed evals (`bench:gates`, `eval:*`) not run.
- Known follow-ups (not defects hidden): per-row `WHERE id=? AND json_type(metadata_json…)` arm/clear
  statements in `eventlog.ts` (same class as gate 17, fails only its own row); `workspace_social_posts_v1`
  literals in the semantic kernel; `space_refresh` sheet range `Log!A1:N500` vs the 9-column trim;
  `dev-down.sh:96` relaunches the 3.14.0 app against a newer schema; prompt/context compaction
  (52.7k-token workflow prompts); recall-conversion measurement for the judge gate; transport leaf still
  imports zod (as at HEAD).

### Owner items (vault data; code never edits these)
- `end-of-day`: `required_keys/min_items rows` → keys the prose emits (gate 12 makes it survivable either way).
- `platform-49`: drop `leads min_items:1` (quiet runs are valid) and the `run_worker` line (blocked for steps).
- `daily-standup-email`: drop `meetings min_items:1`; it also needs the Outlook send slug provisioned.
- `team-activity-slack-updates`, `social-manager-rc-…`: raw-runner; only produce `migration_required` occurrences — disable until migrated.
- `friday-dashboard-daily-refresh`: runs daily incl. weekends; queue its creation test once before trusting the schedule.

### Morning runbook (phone)
`DEV_DISCORD=false ./scripts/dev-up.sh` (or with Discord on, your call) → watch `daemon.log` for
`Webhook server listening` (8420), `Direct-app mobile door open (pinned TLS)` (8421), `Mobile relay tunnel
starting`, `Daemon loop started` → QR from the console Mobile panel or
`GET /api/console/mobile-access/qr` (paired phones need no re-scan). Canaries in order, stop at the first
surprise: `daily-summary` → `morning-briefing` → `weekly-review` → `end-of-day` → `friday-dashboard`
(creation test first) → `platform-49` (run it twice: the second run should show the learned pin for the
repaired write) → `daily-standup-email`. Stop with `npx tsx src/index.ts daemon stop`, not `dev-down.sh`.

### Evening (16:30–18:00 PT): the owner's live tests after the takeover
Read straight off the daemon log, the run records and `pmset -g log` — no DB opened, no run replayed.
- **What actually ran on the dev daemon (pid 66531, up since 12:57 PT, tip 548741b5):** nothing. No chat
  turn and no workflow step left a log line in five hours. The three things the owner saw as "simple
  workflows still failing" were all holds, none a model failure:
  1. `platform-49` 16:00 slot: the laptop slept 15:44→16:28 (DarkWakes through it); the 16:03 tick called
     the occurrence a catch-up and parked it `awaiting_catchup_decision` for a Resume/Skip tap. **Fixed
     (`ada734c6`)**: a missed occurrence now RUNS, queued with `catchupDisposition: 'resumed'` by the
     scheduler, paced one-at-a-time by the runner's existing catch-up admission (that pacing was always
     the real v3.0.1 anti-stampede; the human gate on top was a hoop); the step prompt carries the
     lateness so a time-sensitive step judges in its own words. The one record already held today stays
     held until tapped or reaped (records from older builds keep the old contract).
  2. `platform-49` 12:00 run (`trigger-8c1a2b91`): killed 80 s in by the 12:01 PT daemon restart, then
     parked by `shouldHaltResumeForSideEffect` as "interrupted mid-run — NOT re-run" because a prose
     `sideEffect: write` step carries no durable-dispatch proof. **OPEN — the owner's agreed item 2**: the
     host settlement ledger for session `workflow:<runId>:<stepId>` (`logical_call_settlements`,
     `physical_dispatches`) can prove zero mutating/uncertain crossings → resume; an uncertain row →
     park as the one allowed terminal, readback edge named. Next change.
  3. "run my slack team update" in chat → the raw readiness text. The self-improvement lane had failed
     at 12:14 PT and its **six-hour cooldown** refused every new request, so the queue fell through to
     `readiness.message`. **Fixed (`86e3020d`)**: budget of 3 attempts per unchanged
     definition+script digest; each rejected attempt recorded with its reasons and the draft kept as
     `.improvement-candidate-<stamp>.md`; the next prompt quotes prior attempts and the two missing step
     shapes (reviewed transform, read-only forEach call); an exhausted budget answers in plain words with
     the draft path and the next edge. Also found and fixed: **no rewrite could ever have landed** —
     `workflow_update` on an enabled workflow saves it DISABLED + queues a creation test, which the
     intent guard reads as "enabled flag changed" and reverts (all sixteen backups today were
     byte-identical to SKILL.md: the failures were "nothing was saved", reported as drift). An
     improvement session now keeps the workflow enabled; the re-queued run is the verification.
- **Doors that lied**: the console run route answered a `held` rewrite with `{queued:true}` and no id
  ("Started"), the dashboard action redirected green regardless of the queue's answer. Both now carry the
  queue's message (`86e3020d`); `console-board.test.ts` had been red at HEAD since the lane landed.
- **Brain availability during the tests**: the boot logged `AUTH_MODE=claude_oauth … no credentials —
  booting degraded` (the vault token died 07-09; the Claude Code keychain is read asynchronously after
  boot), Codex Pro weekly is exhausted until 09-06, and the Claude subscription that Clem's pinned Sonnet
  runs on is the SAME quota Claude Code sessions spend — the 12:15–13:00 PT subagent fan-out in the
  takeover session helped push it into the 13:00→15:50 PT limit. Rule for this branch: no large fan-outs
  while the owner is live-testing on the Sonnet pin.
- **Still spinning until the 12:57 restart**: the attempt-16 improvement session re-entered checkpoint
  recovery every ~5 s for 90 minutes (1,006 `host retained exact checkpoint recovery ownership` lines,
  `host_model_batch_admission_unavailable`) — the cause is gate 16's binding writer, fixed; the loop
  itself still has no bound and belongs in the dead-end census.
- Also seen, not fixed: `memory.maintenance` "sessions reaper tick failed: FOREIGN KEY constraint
  failed" every hour (audit defect 5's reaper never succeeds); the codex CLI probe fails on a broken
  `mcp_servers.openaiDeveloperDocs` entry in `~/.codex/config.toml` (harmless: the Codex brain uses
  OAuth, not the CLI).

### Night (18:00–21:30 PT): "premium working state, no added latency, efficiency on every brain"
Owner goal for the evening; daemon deliberately NOT restarted (tsx does not hot-reload) — everything
below is on the branch, pinned, typecheck clean, and waits for the next `dev-up` to go live.
- `ada734c6` scheduler: a missed occurrence RUNS late (queued `resumed`, paced by the runner) — no
  Resume/Skip tap; lateness lead-in on the step prompt.
- `86e3020d` self-improvement: 3-attempt budget per definition digest replaces the 6 h cooldown; drafts
  kept as `.improvement-candidate-*`; prior attempts quoted to the next turn; `workflow_update` in an
  improvement session stays enabled (the re-queued run is the smoke); console/dashboard doors answer a
  hold honestly.
- `cbd2bb20` **Claude cache + compaction (the two measured efficiency defects):** the transcript
  breakpoint was placed BEFORE the harness's `role:'system'` packets were hoisted out of `messages`, so it
  sat on a packet that was then removed — cachedInputTokens frozen at 12,924 on every frame while input
  climbed to 97k (12% hit over 85 Sonnet requests). Hoist first; the breakpoint lands on the newest real
  message. And in-flight compaction thresholds were multiplied by the model window (Sonnet 5's 1M →
  160k trigger; GLM 82k), so the 27-read steps never compacted; thresholds are absolute now
  (`inFlightCompactionThresholds`). Neither adds latency; both remove tokens per frame.
- `2a607d7a` memory + brains: the nightly tool-choice audit no longer erases structural pins
  (`workflow:<slug>:<step>` — "slack" in the slug had invalidated platform-49's proven GOOGLESHEETS_* pin on
  07-31, 08-13, 08-21); daemon approval/restart/cron resumes no longer pin `MODELS.primary` over the
  active brain (unleashed cron keeps the deep model).
- `02763782` interrupted-mid-run (owner's item 2): a prose step's own dispatch ledger
  (`readSessionDispatchEvidence` over logical calls / physical dispatches / settlements under
  `workflow:<run>:<step>` incl. items) proves zero mutating/uncertain/open → the step re-runs; otherwise the
  halt is typed `mutation_uncertain_awaiting_readback:` with the counts.
- `081d2bbd` host + brains: exact-checkpoint re-entry budget (5) with one notice — the 1,006-re-entry loop
  is bounded, HRS kept for restart/continue; CONTINUE exhaustion → typed resumable
  `continue_marker_exhausted` (was a silent success); a plan-less refusal names its door
  (tool_search → plan_task → work_call for a write); first-byte fallover/watchdog budgets scale +10 s per
  10k input tokens above 20k, fallover kept strictly below the watchdog.
- `7778f365` measure + GLM + JIT: native GLM/xAI streams record usage
  (`stream_options.include_usage`, z.ai probed live); every workflow step lands `step_efficiency`
  (frames, cache-hit share, tokens, largest prompt) on its run log and daemon log; the JIT read edge routes
  reviewed-CLI identities (`salesforce_sf_soql_query`) through the live-read registry instead of the
  Composio materializer.
- **Journeys, measured not assumed:** the six previously red files run at `548741b5` (the other agent's
  tip) and at tonight's tip show the SAME reds — nothing tonight regressed them. Note for the tag: the
  hard-cut journey now carries 8 reds at `548741b5` (subtests 2,3,5,6,8,9,10,11; "Created workspace"
  expected, a host refusal returned), not the 3 the morning declared — it moved during the afternoon's
  gates 12–16, before the takeover.
- **Not done tonight:** full `npm test` + journeys matrix with the daemon stopped (owner's call when
  testing resumes); the Family Law sheet canary (needs the restart); a `runProductionHost` pin for the
  live-read JIT route; the dead-end census as a weekly metric; hard-cut seam 4 (boot-recovery dispatch
  lease); the 12 pre-existing journey reds.

### Late (21:30–18:15 PT next tick): the owner's "is the last two weeks real value" check
Owner: "we have done things no other harness has done — measure and run parallel judges against an active
goal … truly self-improve. I don't think it's fully wired in yet."
- **Measured answer:** the objective judge (cross-family, hedged, bounded continuation) existed only in the
  legacy core (`runConversationCore`), which the host engine never enters — every live turn is host_v1, so
  every live reply shipped UNJUDGED. `494d3b66`: the same gate and judge now run on the host lane at
  the final reply; NOT DONE rides the one-shot directive, bounded to 2, every verdict a durable
  `goal_alignment_judged` (lane host_v1). Self-improvement IS wired for workflows (legacy script rewrite,
  budgeted, drafts kept); "learns from corrections" is still the M14 gap (no metric).
- **Two scheduled workflows failed on doors, fixed:** friday-dashboard's six SOQL reads refused
  `completeness_evidence_missing:data` (reviewed-CLI evidence lives at `stdout`); daily-standup-email's
  `OUTLOOK_OUTLOOK_SEND_EMAIL` threw a run error before its first model edge (now a typed, proven-pre-dispatch
  capability block that parks and retries).
- Dev daemon restarted 17:54 PT on 88c5a4b5 for the owner's mobile testing; the phone re-paired after one
  post-restart 401 and served 50 requests clean. The judge and the two workflow fixes need one more restart.

### Later (18:30–19:10 PT): the first mobile turn, and the owner's simplicity bar
Owner (after "Host error on the 1st run"): "the harness shouldn't be so overcomplicated that it would trip
up a pseudo flagship source model" — GLM 5.3 must run the owner's tasks and existing/migrated workflows.
- **What the first turn actually did** (read off a COPY of the eventlog): `tool_search` proved
  `SLACK_FETCH_CONVERSATION_HISTORY` as a read; GLM then emitted a `work_call` whose inner
  `composio_execute_tool` carried the ACTION arguments (`channel`, `limit`) where `tool_slug` belongs.
  The host refused with `host_planned_work_call_requires_plan_sibling` — a wrong diagnosis (the plan
  sibling was present) — and the turn ended as a host error on the phone.
- `5ffed29b` typed the refusal (`host_work_call_inner_operation_unidentified`) so the directive names the
  exact missing field instead of a sibling that exists.
- `3971ef78` subtracts the hoop: when EXACTLY ONE Composio READ is proven this turn, the host binds the
  missing `tool_slug`, wraps top-level action arguments into `arguments`, and serializes an
  `arguments` object once — completed where the frame is built, so classification, dispatch, settlement
  and the learned pin all see the working bytes (run N+1 starts from the shape that worked). Zero or
  several proven reads, any proven write, a non-gateway inner name: no completion, the typed refusal
  stands. Every disclosed business result now carries `example` — a literal call with only the action
  arguments left to fill — and the carrier hint says args_json is ONE JSON string of
  `{tool_slug, arguments: {…}}`.
- Dev daemon restarted 19:08 PT on `3971ef78` (pid 22222). Pins: `composio-carrier-completion.test.ts`,
  `tool-search-carrier-example.test.ts`; host-turn-runner (224), frame-policy and tool-search suites green.
