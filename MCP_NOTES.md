# MCP Notes

`clementine-next` now has an MCP-first tool path.

## Current shape

- `src/tools/mcp-server.ts` is the local stdio MCP server entry
- tool families are split into focused modules:
  - `src/tools/memory-tools.ts`
  - `src/tools/vault-tools.ts`
  - `src/tools/plan-tools.ts`
  - `src/tools/session-tools.ts`
  - `src/tools/dynamic-tools.ts`
- `src/runtime/mcp-servers.ts` attaches the local MCP server plus discovered external MCP servers
- `src/runtime/mcp-config.ts` discovers and persists external MCP server config

## Enable it

Set this in `.env`:

```bash
LOCAL_MCP_ENABLED=true
```

This now defaults to `true`.

## Current tools

- `ping`
- `memory_search`
- `memory_read`
- `working_memory`
- `note_create`
- `note_take`
- `task_list`
- `task_add`
- `task_update`
- `create_plan`
- `list_plans`
- `update_plan_step`
- `session_history`
- `session_resume`
- `goal_create`
- `goal_update`
- `goal_list`
- `goal_get`
- `set_timer`
- `cron_run_history`
- `cron_list`
- `add_cron_job`
- `trigger_cron_job`
- `workflow_list`
- `workflow_create`
- `workflow_run`
- `cron_progress_read`
- `cron_progress_write`
- `workspace_config`
- `workspace_list`
- `workspace_info`
- `create_tool`
- `team_list`
- `team_message`
- `team_request`
- `team_pending_requests`
- `team_reply`
- `create_agent`
- `update_agent`
- `delete_agent`
- `delegate_task`
- `check_delegation`

## External MCP discovery

External MCP servers are discovered from:

- Claude Desktop config
- Claude Code settings
- `~/.clementine-next/mcp/servers.json`

Use `/tools` in the CLI to inspect what is currently attached.

## Why this matters

This removes the old split-brain setup where some core tools lived in-process and some lived behind MCP.

The next migration slices should build on this shape:

- richer external tool families
- deeper orchestration and workflow tooling
- channels, daemon workflows, and dashboard parity

Current orchestration note:

- cron and workflow definitions are now persisted locally
- manual triggers and queued workflow runs are supported
- the local daemon now executes cron schedules, cron triggers, and queued workflow runs
- a minimal control plane now exists on the webhook server
- daemon notifications can now fan out to configured outbound webhook destinations
- delivery destinations support generic webhooks, Discord webhooks, direct Discord bot channels, and direct Discord user DMs
- a first-class Discord bot channel now exists for inbound chat and outbound bot delivery
- approval notifications can now be routed back to the originating Discord user
- notification delivery now retries per destination with backoff and can be requeued from the dashboard
- runtime auth now supports both API-key and Codex CLI-backed `codex_oauth` modes
- channel delivery and richer control-plane parity still need secondary channel adapters and more polish
