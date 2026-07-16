# Subtraction Report — 2026-07-16

Nathan's standing directive (2026-06-30): a deliberate SUBTRACTION pass before shipping more.
Measured this session: **409 real behavior/config env flags** (env reads + quoted literals in prod code, up from 153 measured 06-30) and **163 registry tools** (up from ~79). Full classification: 4 parallel agents over every read site; tool usage mined from the live eventlog (`state/harness.db`, 11,939 `tool_called` events, 2026-05-25 → 07-16).

## Flags — classification totals

| class | count | meaning |
|---|---|---|
| safety_keep | ~65 | judges, gates, send floor, guardrails, caps, watchdogs — kill-switches stay (binding rule) |
| config_keep | ~155 | operator tunables (timeouts, models, paths, thresholds) + env plumbing |
| graduate_candidate | ~140 | default-on kill-switches for validated NON-safety behavior, plus a handful of default-off rollout toggles |
| dead (prod) | ~16 | mostly test-script-only or doc placeholders; ~3 genuinely deletable |
| unknown | ~5 | CODEX_NATIVE_COMPACTION, TIERED_CONTEXT, SOURCE_TRUST, TOOL_CHOICE_DECAY — default-off experiments awaiting validation |

Honest finding: the flag population is healthier than the raw count suggests. Most are legit config or blessed kill-switches; the model never sees them (defaults = one path). The real doors-the-model-walks subtraction is the TOOL surface (below).

**Executed this session (zero behavior change on defaults):**
- Deleted the concluded tool-search A/B machinery (`CLEMMY_CODEX_TOOL_SEARCH_AB`, `_AB_RATIO`, arm assignment, experiment telemetry fields) — the default flip it guarded shipped in v1.3.0 and held. `resolveToolSearchDecision` is now just lane-gate × global flag.
- Kept the rubric A/B substrate (`CLEMMY_RUBRIC_VARIANT_AB*`) — it is PRE-BUILT for the planned Phase-5 lean-rubric experiment, not a concluded one. Kept the JIT A/B pending a decision on whether that measurement still matters post tool-surface unification.
- Fixed 4 stale-default comments that said "default OFF" for flags whose code defaults ON (orchestrator schema-on-demand block, tool-jit header, workflow-diagnosis header, facts decay).

**Proposed next batches (each needs your go — deleting a kill-switch removes YOUR operational lever):**
1. **Graduate batch 1 — prompt/UX directives** (~15 flags): FANOUT_DIRECTIVE, DISCOVERY_DIRECTIVE, CODE_MODE_MANDATE, LOUD_PROGRESS_CHECKINS, WORKFLOW_LOUD_UPDATES, STEP_PROGRESS_ELEVATE, etc. Default-on for many releases; off-branch is a worse product.
2. **Graduate batch 2 — reliability retries/salvage** (~20): STALL_* family, OVERLOAD_RETRY, EMBED_RETRY, TOOL_SURFACE_RETRY, NARRATION_RETRY, VOICE_RECONNECT… same argument.
3. **Rollout-flag decisions** (default-OFF built features — finish or delete): V2_PEER_COMMS, WITHIN_TASK_RECALL_NUDGE, BG_OFFER_NUDGE, BRAIN_FALLOVER, BRAIN_STABLE_SNAPSHOT, CLAUDE_OVERLOAD_FALLBACK, BOOT_WARMUP + the 4 unknowns. Each is a product call, not a mechanical graduation.
4. **JIT A/B retirement** (TOOL_JIT_AB, _RATIO, _LANE + measure script) if you agree the experiment concluded.

Full per-flag classification JSON: session scratchpad `flag-slice-{1..4}.json` + classified arrays (ask Clem to re-materialize if needed).

## Tools — usage evidence (163 registry tools)

- **110 tools have live use**; **53 (32.5%) have ZERO use on every path** (direct + via call_tool inner dispatch) across 52 days.
- Top direct users: composio_execute_tool 2771 · run_shell_command 1540 · composio_search_tools 620 · read_file 503 · focus_get 466 · run_tool_program 424 · tool_choice_recall 344 · run_worker 308 · recall_tool_result 264 · list_files 252.
- Reachability trap verified: call_tool inner dispatches don't emit their own `tool_called` — ping (194 via call_tool), harness_status, workflow_import_status were revived from the zero set this way.

**KILL candidates (~13, true supersessions with a live survivor):**
- Plan lifecycle: `create_plan`, `update_plan_step`, `list_plans` → survivors `draft_plan` (43×) + `execution_*` (124–150×).
- Cron surface: `add_cron_job`, `cron_list`, `cron_run_history`, `cron_progress_write`, `trigger_cron_job`, `schedule_list` → survivors `workflow_schedule`/`workflow_run` (204×) — the Schedule-unification residue.
- Singles: `note_take` (→ note_create), `workspace_config`, `list_capabilities` (→ check_capability/local_cli_list), `user_profile_update`, `clear_model_role` (→ set_model_role mode).

**MERGE proposal:** goals are READ via tools (goal_list 27×) but never mutated via tools — collapse `goal_get/goal_create/goal_update/draft_goal_from_notes` → `goal_list` + one `goal_upsert`.

**Product decision (11 tools):** the named-team-agents cluster (team_*, delegate_task, check_delegation, create_agent, update_agent, delete_agent, agent_propose) is entirely dormant — the live fan-out substrate is run_worker + dispatch_background_task. Killing it is the single biggest subtraction, but it's the named-agent side of THE DREAM. Your call: retire, or defer behind the tool_search catalog so it stops occupying surface.

**Bug smell (separate item):** `memory_mark_used` at ZERO invocations on every lane suggests the memory-credit loop it serves is not firing — wiring gap, not dead weight. Worth its own investigation.

## Doors count, before → after this session
- Flags: 409 → 407 (A/B pair deleted); classification now exists so the next ~35–40 can go in approved batches.
- Tools: 163 → 163 (kill list of 13 + merge of 4 + cluster of 11 awaiting your approval — removal is user-visible capability).
