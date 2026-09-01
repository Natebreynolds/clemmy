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
| 4 | authored external sends | __LC_RESULT__ |
| 5/6 | frozen card / "progressed" refusal | removed; prime extends the card with same-source disclosures |
| 7 | sole work_call refused (schema fields not mirrored) | mirrored + connection pin |
| 8 | plan_task throws / lexical read refusal + false done / substitute writes | typed refusals; compiler owns route; ask-only missing-write refusal (contract branch pinned) |
| 9 | hard-cut `catalog_snapshot_identity_mismatch` | prime guard (byte-match to installed manifest + fresh non-refused observation); journey: __B_RESULT__ |
| 10 | unprovisioned literal op → silent refusals | G0 refuses naming the op; G2 names it as a host fault |
| 11 | "bounded internal host error", `blockedReason='blocked'` | machine reason + bounded `blockedDetail` persisted |
| 12 | output-contract hard-fail on ordinary steps | __LC_CONTRACT_RESULT__ |
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

### Declared state at the tip
- Full isolated suite: __SUITE__ (sentinel PERFORMED, no violations).
- Journeys: __JOURNEYS__.
- Packaged gates (`build`, `test:packed-candidate`, `test:packaged-upgrade`, `rehearse:upgrade:v314`): __PACKAGED__.
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
