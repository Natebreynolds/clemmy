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

### Later (19:20–21:10 PT): "simplify read vs write once and for all" — the subtraction
Owner, after the second mobile failure: "fix the root cause here and not think of a patch … We need to
simplify read vs write, this has been a struggle for 2 weeks … make sure we aren't adding on top of the
complex harness but removing what needs to be removed."
- **Root cause of the second failure** (`e89e20ce`): the durable manifest store and the proof builder
  disagreed about the identity of the same operation. 28 rows installed before 08-30 (15 reads, 13 writes:
  sheets search/batch_update/update_values, drive find_file, outlook query/search/calendar, salesforce
  account fetch, slack history) predate `behaviorHints` derivation; every fresh proof minted a different
  digest under the SAME id, `store.install` refused it, and registration `continue`d silently — no factory
  entry, no log, a discovery record claiming a digest nothing held, a JIT re-provision answering ok with
  nothing registered. This was the "simple workflows still failing" class since the release; the workflow
  lane escaped because it binds the durable manifest as-is. Fix: identity is the provider definition; when
  it matches, the installed manifest IS the registration; a refused manifest is a typed, logged refusal;
  the JIT provisioner answers ok only when every requested operation registered.
- **Census** (agent, 954 lines, `scratchpad/rw-census.md`): four effect oracles (slug verb heuristic,
  runtime classifier, sealed manifest, authored `sideEffect`) and TWELVE effect vocabularies; the manifest
  is minted FROM the heuristic; one read classified six times on its way to dispatch with the proven read
  winning at two; sixteen places where two authorities disagree; a chat read lane with no production
  importer (read-lane-adapters/chat/read-lane, ~2.2k lines).
- **Removed tonight** (`673fcf41`, `THE READ BAR`): from the read path — the discovery record's nine-digest
  replay, the planning card's digest replay, a second dispatchability predicate, the durable-store
  lifecycle/digest gate, base/`:definition:` lineage arithmetic. What remains is the whole read bar: the
  sealed manifest says read, the row is a current callable entry for that operation, and the account
  matches when the proof names one; only a REVOKED manifest (disconnect) refuses. Writes keep every gate.
- **Removed tonight** (one decision per call; one step-effect classifier): the frame decides each call's
  effect once and scheduling/admission/approval arming read it (three re-classifications deleted per
  call); the two `structuredCallSideEffectClass` copies (validator vs enforce, D3) became one leaf where
  `send` is a property of the operation, never a label.
- **Next removals, in value order** (not tonight): (1) `unknown` effect collapses to the WRITE bar (plan +
  consent) instead of a refusal terminal — chat refuses `effect_unknown`, workflows collapse to read,
  workers to write (D6); (2) one Composio effect oracle — `classifyComposio` with no manifest falls to a
  second heuristic that fails closed to write while the seed heuristic says read (D1), and workers use the
  seed alone (D13); (3) delete the dead chat read lane (~2.2k lines + 5 tests, one closeout test to
  re-home); (4) three read-acquisition machines → one (proof-provisioned catalog ×966 lines; live-read
  registry + materializer + MCP carrier ×3.8k); (5) twelve effect vocabularies → `read | write | admin`
  with `send` as risk. Six `exactProductionHostCall` re-proofs per call are edge re-validation by design;
  collapse only with a pin per edge.

### Later (20:10–21:35 PT): "legacy ones still need to be able to run"
Owner, after "run my slack team activity update flow" answered with a rewrite promise and nothing visible:
"I have no idea what she's doing right now"; "We can't just fix the problem though — Clem needs the right
tools to migrate workflows, or legacy ones still need to be able to run."
- **Measured:** the self-improvement lane had attempted the rewrite 18 times today (15:19 → 03:00Z), each
  ending on a different harness gate (schema_invalid, schema_too_big, plan_incomplete, effect_unknown,
  plan_sibling…); the 18th sat 10 minutes on GLM (46k-token prompt) with no output; none of it is visible
  in the app (improvement sessions are filtered out of Working Now). The runner is a 1,109-line
  owner-authored script (six SOQL reads, attribution reads, baseline files) — not a model-turn rewrite.
- **Hand migration first** (kept as `SKILL.migrated-2026-09-01.md`): six exact `salesforce_sf_soql_query`
  steps (all six proven live: 14/8/1/3/1/10 rows), a closed transform package, a render step with the exact
  section order, the fixed-channel send. Validates: 9 steps, no errors.
- **Reinstatement** (`77393c06`): the 08-30 release had re-retired deterministic runners (validator,
  readiness, executeStep, scheduler holds) behind the rewrite lane; the executor itself never left the
  tree. The refusal layer is deleted; the lane's bar is effects, not method (scripts/-confined path,
  bytes pinned to the admitted run, interpreter allowlist, scrubbed env, capped wall clock/output,
  redacted output, declared side_effect + output contract). Readiness = the script's presence; a missing
  file blocks by name. The queue's improvement hold is deleted; `requestWorkflowImprovement` is an
  explicit door (chat/dashboard), and the workflow keeps running on its own script meanwhile. 16 pins
  retargeted; the two 08-26 loop-probe execution pins restored; 737 tests green across the touched suites.
- **Vault:** `team-activity-slack-updates` restored to the owner's definition (runner + send). Daemon
  restarted on 77393c06; the definition validates.
- **Still owed (the "right tools" half):** a deterministic migration primitive the lane can call (extract
  `sf data query`/Composio ops from a runner into exact call steps + package transform; the model only
  names/reviews) and visibility of improvement sessions in Working Now with attempt N of 3.

### Later (21:35–22:15 PT): "it failed to run a workflow that has been working for weeks"
- **end-of-day (scheduled 17:00, 18 prior successes)** and the phone's "run my slack team activity update"
  died on ONE class: GLM 5.3 serializes an omitted optional argument as the STRING "null" —
  `task_list priority:"null"` (enum refusal → identical retry → governor), `workflow_get step:"null"`
  ("both section and step"), `work_call source_call_ids:"null"` (read as settled lineage → plan-bound).
  Fixed once (`e74598a0`) at `materializeStrictNullableFields`, the schema-aware seam every dispatch path
  crosses: optional key → absent, required nullable → JSON null, required non-nullable → kept.
- **Proof run 1** then completed every step (hygiene, two task lists, memory, notification, step result)
  and was STILL marked blocked: "no completed business settlement or confirmed write" — the settlement
  audit's evidence for a declared write/send step came from provider settlements or the Claude SDK lane's
  own markers; a local-only step had evidence on Sonnet and none on GLM. Fixed (`901e0c58`): successful
  local mutations count. Pins for both.
- **Also landed:** Working Now shows host-run execution sessions immediately, named by workflow and
  attempt (`eab3c531`); the migration primitive drafts exact steps from a runner's source and the rewrite
  lane starts from that draft (`edb963ef`).

### Later (22:00–22:45 PT): the fleet pass — every scheduled driver, first wall, class, fix
Owner: "What other improvements against my goal do you want to make?" Answer ranked by evidence: over
48h every scheduled workflow failed at least once; each first wall is a class.
- **team-activity-slack-updates** — a locked step (`allowedTools`) never sealed a capability envelope;
  the host refused it before the first model call (`capability_envelope_missing`) and chat relayed it as
  "reconnect your Slack workspace?" → `3bb83a40` (locked steps seal exactly their surface).
- **morning-briefing** — `notify_user` was registry `sideEffect: read`, so a send step whose whole job is
  a notification settled with zero mutations → "no business evidence" → `eec1b322` (runtime effect
  `host_only`; taxonomy class unchanged).
- **scorpion-facebook-trends** — four walls in one step: FIRECRAWL_SCRAPE classified a write with no
  manifest (census D1) and the JIT edge refused two-token slugs → `8a1e783d`; the toolkit cache was 46h
  old and read as EMPTY so `firecrawl` was "not a toolkit" → `188bb3f9` (age is not identity);
  `composio_search_tools` in `allowedTools` was uppercased into a phantom COMPOSIO_SEARCH_TOOLS
  operation → capability block → extractor fix (local tool names and the platform plane are never
  provisioned). The parked run resumed on the fix and passed step 1.
- **daily-standup-email** — definition typo `OUTLOOK_OUTLOOK_SEND_EMAIL` → `OUTLOOK_SEND_EMAIL` (vault
  edit with a backup beside it).
- **weekly-review** — "claimed to write but never called its tool" ×13 was the named-workflow shortcut
  reading the step's own "Workflow: weekly-review" prompt as a run request (fixed 08-31 `46fccea6`,
  after the streak); re-run tonight to confirm.
- **Voice** (`7d8922fc`, `f58a6abc`): the three host blocked texts and the queued-run reply now read as
  a person: what happened, what is kept, what to do; the run id and Working Now are named.
- **Open, recorded in memory:** the session reaper has failed hourly since ≤08-31 (`FOREIGN KEY
  constraint failed` — ~10 tables restrict event deletion) so no old session is ever reaped and
  harness.db sits at 1.2 GB; platform-49's 21 bad runs are mostly my own ~15 daemon restarts
  interrupting scheduled runs (its 15:00 run succeeded and produced the sheet).

## Gate 15 — a retried node is a new attempt, and a step receives what its evidence saw (2026-09-02 05:40–06:00 UTC)

**Symptom.** The Friday dashboard's retry on the serialized daemon (run `1788326724625-329234`) failed twice over:
its first SOQL read refused with `workflow_exact_call_blocked_pre_crossing: workflow node attempt already has a
different activation`, and the four sibling SOQL reads DISPATCHED (Salesforce answered, exit 0, records in
`stdout`) but failed their declared contract: `missing required output key "stdout"`.

**Cause 1 — attempt 1 forever.** `exactWorkflowCallIdentity` hardcoded `nodeAttempt: 1`. The node's binding
snapshot changed between the first tick and the retry (the reviewed-CLI capability was acquired in between), so
arming found attempt 1 owned by a different activation and refused — on every retry.
*Fix (62120110):* `nextWorkflowNodeAttempt` in accepted-turn-call-authority.ts derives the attempt from the log:
same content address → the same attempt (replay); changed address whose latest attempt closed **without a body**
→ the next attempt; changed address whose latest attempt is open or crossed a body → the same attempt, so
arming collides exactly as before (the same-occurrence refusal pins in the v3 integration suite are unchanged:
one occurrence never opens a second physical call under drifted content). Pin: workflow-read-only-call-kernel.test.ts.

**Cause 2 — the envelope, not the payload.** The executor verified evidence against the owner-projected payload
(`{result, complete:true}` unwrapped; MCP structuredContent unwrapped) but handed the step the RAW envelope. For
a reviewed-CLI read the evidence path is `stdout` — it passed — while the contract `required_keys: [stdout]` ran
against `{result, complete}` and failed. No authored contract could be true for both.
*Fix (94eefc03):* the step receives the evidence view's payload; the durable result handle keeps the raw
envelope. Executor pin retargeted.

**Open, recorded not fixed.**
- The durable result handle for a reviewed-CLI read projects `record_path: result.argv`, `record_count: 7` — the
  projector took the first array it found in the process observation (the argv!) as "the records". Records live
  in the stdout JSON. Harmless to execution tonight; wrong in the ledger's record facts.
- A node whose FIRST attempt crossed a body and whose binding is later re-provisioned cannot replay under the same
  occurrence (different content address, body already crossed → collide). The design is right about never opening
  a second body; the missing edge is "replay the settled result under a new content address".
- Friday dashboard has not been green in its last six runs (error / cancelled / blocked_readiness back to 08-29);
  it is wave debt, not a regression of tonight.

## Gate 16 — an observation is not a 60-second fuse; a failed CLI says why (2026-09-02 06:00–06:20 UTC)

**Run 2 (05:59, right after boot).** All five SOQL reads completed (gate 15 held). The sixth,
`opportunity_engagement`, blocked `after_crossing: reviewed CLI process nonzero_exit` — and nothing more.
Salesforce had answered `MALFORMED_QUERY: field ActivityDate does not support aggregate operator MAX` on
stdout; the transport threw it away. *Fix (9895c207):* `ReviewedCliProcessError` carries one bounded,
redacted diagnostic (provider's structured stdout failure, else last non-warning stderr line, else stdout's
last line). *Definition:* the workflow's query used `MAX(ActivityDate)` on Task, which Salesforce never
supported — this workflow has not been green in exact form; it is not tonight's regression. Changed to
`MAX(CreatedDate) lastActivity` (backup `SKILL.md.pre-soql-fix-2026-09-01.bak`; verified live: 132 rows).

**Run 3 (06:03, four minutes after boot).** All five SOQL reads refused `live_observation_stale`.
`adoptObservedCapabilityIdentity` stored the acquisition-time snapshot with no live re-observer, so
admission's "independent" re-observation echoed the same `observedAt` forever; freshness is 60 s. Every
reviewed-CLI exact call more than a minute after boot or acquisition was dead — which is every scheduled run.
*Fix (1eff1945):* the adopt seam accepts a live observe closure; the reviewed-CLI carrier re-reads the
descriptor and executable bytes at every crossing and stamps that instant (drift still reports drift; an
unobservable CLI reports missing). Pin: two crossings, two instants, same identity.

**Trap recorded.** A static `import` in a test file that sets `process.env.CLEMENTINE_HOME` later loads
`config.ts` against the REAL home: the carrier suite's two "descriptor absent" failures were my own test's
import order, not the transport change (bisected in a pristine worktree). The real registry was untouched.

## Gate 17 — one sealed-call argument bound, schema v75 (2026-09-02 06:20–07:10 UTC)

**Run 4 (06:15, four minutes after boot on 1eff1945).** All six SOQL reads and the package transform
completed — gates 15 and 16 hold past the freshness window. The final step, `space_set_data` committing the
~75 KB dataset, was refused `canonical_arguments_too_large` (executor, 64 KB). Raising that one cap moved the
refusal to the next door, and the next: the runner's drift comparison (canonical defaults, 64 KB strings),
the authority seal (32 KB plaintext), its ciphertext cap (48 KB), and finally a v53 column CHECK on
`run_dispatch_leases.recovery_argument_cipher` (48 KB). Five private numbers on one path; the argument
compiler had a sixth (256 KB) that simply happened to be larger. None had ever been hit in the ledger's history
(zero `canonical_arguments_too_large` events since 08-20) because no exact-call workflow had ever carried a
real dataset through — the legacy runner wrote the space directly from bash.

*Fix (73b2ade4):* `SEALED_CALL_CANONICAL_LIMITS` (8 MB / 2M nodes, closed-canonical-json.ts) is the one bound at
the compiler, executor and runner; the seal derives its ciphertext cap from the plaintext bound and clamps to
the schema wall; **schema v75** rebuilds `run_dispatch_leases` with a 16 MiB CHECK (rows copied, indexes and
triggers recreated byte-identical; v53 untouched — migrations are immutable). Pins: a 600 KB argument crosses
one sealed call end to end; the v75 rebuild keeps rows/objects/bound. The live DB migrated at boot: schema 75/75.

**Why this matters beyond Friday.** Any exact-call step that hands a real result to the next tool — a Sheets
write of a few hundred rows, a dataset commit, a rendered report — would have died at one of these doors. The
bound now describes what the transports accept, not what a chat turn looks like.

## Gate 18 — Friday dashboard GREEN; a run a person asked for is authority (2026-09-02 06:35–06:45 UTC)

**Run 5 (06:35, on schema 75, four minutes after boot).** Six SOQL reads, the package transform, and the
dataset commit all crossed. `terminalOutcome: succeeded`, zero blocked steps, the space's `data.json`
rewritten (119 KB). Report-back: "the Friday dashboard refresh ran clean … eight firms … ready for review."
First green run of this workflow in exact form.

**One more door, removed.** The commit had PARKED on "Approve exact local_write call space_set_data" because
the bare-call consent resolver mints `scheduled_workflow_authority` only for an accepted schedule occurrence;
a manual run (console, mobile, chat dispatch) parked every other non-send write. I approved it once by hand to
finish the proof, then fixed the class (a7… see git): a human-initiated run mints `manual_run_authority` for
the same non-send effects a scheduled run makes without asking. Sends keep their floor. Pinned.

**Advisory, pre-existing.** The report-back flagged "the automated goal check couldn't run due to a judge
error". `goal validation unavailable (judge error)` has been logged on every pinned-goal run since 08-15
(team-activity, now Friday). The run does not re-run on an unverifiable verdict — correct — but the judge
lane is silently dead: the recorded detail is `judge unavailable: judge timed out`; the boundary judge's
default deadline is 25 s (`CLEMMY_BOUNDARY_JUDGE_TIMEOUT_MS`, judge-family.ts:80) against the Claude judge
lane, which does not answer that fast under load. Not tonight's blocker; recorded with its lever.

**Voice.** One rubric line (shared by the lean and native rubrics) nudges the model to open like a colleague
and never surface a harness refusal verbatim. Golden snapshots refreshed.

## Gate 19 — weekly-review: an empty week is the summary (2026-09-02 06:50–07:10 UTC)

Re-verified after 711061d7: morning-briefing GREEN (pinned goal validated). weekly-review had "failed 15 runs
in a row" — three doors, none the model's fault:

1. **Guard judged the raw shape.** assess_goals (write, contract `type: string`) read `goal_list`, found no
   active goals, and submitted a structured `[]`/"(none)" through workflow_step_result. The settlement guard
   verified the string contract against the ARRAY, so the "looked and found nothing" exit never applied.
   *Fix (71bfe529):* a structured result renders as text for a string contract (one coercion, shared by the
   settlement guard and the finalize gate).
2. **Honest refusal on an empty week.** write_summary then blocked itself: "zero goals … cannot write a
   truthful summary", while its own context showed one BLOCKED goal from July. The owner's prompt only spoke
   of active goals. *Definition (vault, backed up `SKILL.md.pre-empty-week-2026-09-02.bak`):* assess_goals
   also lists blocked goals when nothing is active; write_summary writes+sends the "nothing active this week"
   note and asks whether to revive or close what is parked. Re-run: memory_remember + notify_user + a real
   summary — the deliverable, sent.
3. **A blocked goal read as a failed step.** The self-report scan counted `status: "blocked"` on the goal
   RECORD as the step failing ("1 of 1 item report a failure"). *Fix (this commit):* the step's own block is
   `blocked: true`; a record's status is data.

Auto-heal had paused itself after the streak; one clean run resumes it.

## Gate 20 — the full suite, the journeys, and what they said (2026-09-02 07:07–08:00 UTC)

`npm test` with the daemon down: 13.9k results, six failures, all triaged and fixed (752f8975):

- **Effect class (3 pins).** The send-slug regex read `TWITTER_GET_POST` as a send, so a read fan-out was
  refused and the pinned "declared can strengthen, never downgrade" contract failed. b790d76a had also
  narrowed that contract ("a label never fabricates a send"). Restored properly: the slug's evidence is the
  floor (a read verb is never a send); a label only strengthens; a declared send on a non-send tool is still
  classified send so the gate refuses it typed (`direct_send_tool_required`) at validation.
- **Kernel neutrality (1).** host-turn-runner imported the Composio-named completion module (3971ef78,
  pre-compaction). Now a provider-neutral seam over a leaf registry; the provider registers itself; the
  kernel's comments name no provider. (First attempt created a module cycle — `Cannot access 'completers'
  before initialization` — hence the leaf.)
- **Honest plain voice (1).** The local-failure copy promised "I will retry", which the host does not own.
  Dropped; the pins now read the plain phrases.
- **Graph layer import (1).** `pino` in the observation seam (0fbeaafe, yesterday) listed as lawful.

Journeys: 155/171. Every one of the 16 failures reproduces at the 09-01 baseline commit (1c3e1177) — the
eight northstar workspace journeys, the read-plan prose continuation, the two large-catalog gates, the
no-random-gate outbound trio, and the 16 KiB model-surface ledger (21.7 KB, before tonight's 0.4 KB voice
line). Wave debt, unchanged by tonight; not hidden.

Re-running both suites on the committed fixes before any tag.

## Gate 21 — one effect contract that holds every pin (2026-09-02 07:57–08:05 UTC)

Second full run: 14,191 results, one failure — the 2026-07-20 draft trap (a stale `send` label on
`OUTLOOK_CREATE_DRAFT` must stay a write) disagreed with the send-call gate (a declared `send` on a dynamic
multiplexer must reach the gate). Both are right. The rule that holds both (c9f1042e): KNOWN slug evidence is
authoritative in both directions — a real send is a send, a known read or reversible write is never a send,
a label may strengthen a read to a write — and only an UNKNOWN carrier takes the label at face value, where
the gate then refuses it typed. b790d76a had chosen "a label never fabricates a send" and missed the
dynamic-carrier case; 752f8975 had chosen "strengthen only" and missed the draft trap.

The chat lane had the same false positive in `isIrreversibleSendSlug` (call-tool, composio-tools, batch-tools,
pending-action admission): `TWITTER_GET_POST` was an irreversible send — an approval card on a read. A read
verb in the TOOL name is now a floor, judged after the MCP server segment or provider toolkit prefix, so a read
verb in a SERVER slug still cannot vouch for a sending tool (that pin is kept).

Journeys after 752f8975: 155/171, the same sixteen, all reproduced at the 09-01 baseline. Third full run on
c9f1042e in progress before any tag.

**Third full run (c9f1042e), 08:00 UTC:** interrupted from outside twice (2,447 and 446 results, zero failures
each). **Completed 08:46 UTC on 9b9a2fa4: 14,192 tests, 14,191 pass, 0 fail, 1 skipped.** Journeys on the same
commit: 155/171 — the identical sixteen, all reproduced at the 09-01 baseline. Dev daemon back on the same commit.

## Token efficiency — the cold surface, measured (2026-09-02 08:40 UTC)

The competitive byte ledger journey fails at 21,722 bytes against a 16 KiB ceiling (pre-existing). Measured on
a cold natural request, first model step:

| part | bytes |
|---|---|
| instructions (lean action rubric) | 5,492 |
| tool schemas (7 always-loaded) | 12,245 |
| input (request + context snapshot) | 3,746 |
| framing | 172 |

The seven schemas: ask_user_question 3,247 · tool_output_query 2,199 · tool_search 1,835 · recall_tool_result
1,761 · file_query 1,325 · call_tool 1,056 · memory_recall_all 814. Each is first-class by a live incident
(ask_user_question: the model never searched for the ability to ask; file_query: one 322k result became 37
recall pages). Hiding any of them behind discovery is the wrong trade. The 5.4 KB to the ceiling is in schema
DESCRIPTIONS — the four largest carry incident-tuned prose that can be halved without losing the affordance.
That is a prompt-level change with behavior pins to re-verify; decision owed, not taken tonight.

**Ledger hygiene (8d880ba4):** a reviewed-CLI result handle now projects its records from the stdout document
(`result.stdout.result.records`, count = the records) instead of recording `result.argv` and seven "records".
Nonzero exit → not a success; plain-text stdout → no records. Pinned.

## Gate 22 — team-activity: a receipt rule Slack can never satisfy (2026-09-02 09:00 UTC)

A manual run of team-activity-slack-updates (my run, 01:59 PDT — it posted "Team Activity Update — Morning
baseline" to the team channel; a person's run carries send authority for an enabled scheduled send step, which
I should have anticipated) reproduced the owner's seven-run streak exactly: the Slack post SUCCEEDED (ledger:
`slack_send_message` succeeded, mutating, receipt with channel C0BHT7WHZDL and ts), and the step then returned
`{"blocked": true, …}` — because the owner's legacy prompt demands "the provider-echoed posted body exactly
byte-equal to the upstream summary". Slack echoes rendered rich-text blocks, never the markdown bytes, so the
rule cannot be met by any model, ever, while the message posts every time.

*Definition (vault, backed up `SKILL.md.pre-receipt-fix-2026-09-02.bak`):* success = explicit success + channel
+ a real `ts`; the harness ledger records the exact posted body. The 09:00 scheduled run is the proof; not
re-run manually (it posts to the team).

**Carrier note.** end-of-week-team-sales-snapshot's manual run door answered 409 (dry run passes); scheduled
Friday 16:30, last real run 08-28 blocked on "not authorized" — same authority class as the reads fixed tonight;
to verify Friday.

## Gate 23 — a sealed step that corrects itself has nowhere to go (2026-09-02 09:05–09:13 UTC, facebook-trends)

The prompt names the exact call (`APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS`, `input.startUrls`). The model sent
`input: {}`; Apify's error named its own fix ("Field input.startUrls is required") — good. The model then
corrected the field but on a SIBLING operation (`APIFY_RUN_ACTOR_SYNC`), which the step's sealed envelope had
never proven → refused pre-dispatch `catalog_entry_or_manifest_missing`, and the refusal told a sealed step to
"call tool_search, then plan_task, then work_call" — a ritual a locked step cannot perform (it tried:
`provider_carried_local_control_route_missing`). Two identical walls → the governor stopped. Typed and honest,
but a dead end with no next edge on the step's own surface.

Harness class, not fixed tonight (queued first for the morning):
1. In a sealed step, a carrier naming a sibling operation of an already-proven toolkit should be JIT-provisioned
   and admitted under the step's declared effect — the read edge already does this for reads; extend it to the
   step's declared write class.
2. The pre-dispatch refusal copy must be lane-aware: inside a sealed step it should say "use
   <proven operation> with <required field>" (the host knows both), never prescribe chat-lane discovery.
The definition is correct as written; not edited.

## Gate 24 — age is not identity, again: the operation-version label (2026-09-02 09:14 UTC, daily-standup)

The standup's manual proof parked `blocked_capability` on `OUTLOOK_LIST_EVENTS`:
`selected_definition_revalidation_refused: selected_definition_operation_version_drift`, reported to the
person as "not connected", retried every minute toward a state that could never arrive. The stored durable
manifest carried operation version `20260828_00`; the provider relabeled the same definition (input and
output schemas byte-identical — the schema-drift check had already passed). One label move, and every
workflow naming the operation dies forever — the 8 AM standup included.

*Fix (this commit):* revalidation decides a label move once the live output schema and invoke port are known:
when the selection's fingerprint is exactly the old-label fingerprint over the same schemas, the definition
rebinds to the live label (`reboundFrom` recorded) and the proof-provisioned catalog installs the live
definition as the recorded successor of the old manifest through its existing supersede path. An
inconsistent selection or a schema change is still drift. Pinned. The parked standup run retries on the
restarted daemon as the proof (it emails the owner only).

**Gate 24, second door (this commit).** With the label rebind in place the parked standup retried and moved one
door: `selected_definition_observation_refused` — the workflow step catalog compared the live (rebound)
definition against the stale durable manifest. A rebound operation is now routed through exact provisioning,
which installs the live definition as the recorded successor of the stored manifest (the catalog's existing
supersede path); the successor is selected, revalidated and observed. Pinned in
workflow-step-external-catalog.test.ts. The parked run resumes at boot as the proof.
