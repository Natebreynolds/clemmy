# Clementine Next

Fresh rebuild of Clementine on a modern agent runtime.

This project is intentionally separate from `clementine-dev`. The old project is the reference implementation. This new project is where the migration happens.

## Initial goals

- Preserve the vault-first memory architecture.
- Preserve multi-channel and daemon operation.
- Replace the Anthropic runtime with modern agent-runtime primitives.
- Improve orchestration, tracing, approvals, and model portability.

## Migration strategy

1. Build a clean runtime/provider seam first.
2. Port the core assistant loop on top of OpenAI Agents SDK.
3. Reattach memory, MCP tools, approvals, and orchestration.
4. Reconnect channels only after the core loop is stable.

## Current status

The rebuild now has:

- OpenAI Agents SDK runtime
- CLI chat loop with session persistence and approvals
- vault-backed context assembly and working memory
- MCP-first local tool server for memory, notes, plans, and session resume
- external MCP server discovery from Claude Desktop, Claude Code, and local config
- a local daemon runner for cron schedules, trigger files, and queued workflow runs
- a daemon-driven autonomous agent loop with durable inboxes, commitments, and proactive wake cycles
- a first-class Discord bot transport for inbound chat and outbound bot-channel delivery

## Install

Target public install:

```bash
npm install -g clemmy
clementine setup
clementine service
```

Current local repo path:

```bash
cd /Users/nathan.reynolds/clementine-next
bash install.sh
```

Or install/link it as a CLI during development:

```bash
cd /Users/nathan.reynolds/clementine-next
npm install
npm run build
npm link
clementine help
```

Or create a local installable package tarball:

```bash
cd /Users/nathan.reynolds/clementine-next
npm install
npm run pack:local
# then install the generated clemmy-0.1.0.tgz however you want
```

Manual repo path:

```bash
npm install
npm run setup
npm run service
```

For a realistic local test, use:

```bash
npm run setup
npm run service
```

## Auth Modes

`clementine-next` now has two auth tracks:

- `AUTH_MODE=api_key`
- `AUTH_MODE=codex_oauth`

Current reality:

- `api_key` is a live runtime path
- `codex_oauth` is now also a live runtime path through the official `codex exec` CLI bridge

Useful commands:

```bash
clementine auth status
clementine auth login
clementine auth login-native
clementine auth refresh
clementine auth import-codex
clementine auth logout
```

`clementine auth login-native` is now the preferred subscription login path. It will:

- open the ChatGPT/Codex sign-in flow in your browser
- save the resulting tokens locally inside Clementine
- write a Codex-compatible `auth.json` so the current runtime can use those credentials

`clementine auth login` remains the broader bootstrap path. It will:

- try native browser sign-in first
- install the official Codex CLI if it is missing
- launch ChatGPT/Codex sign-in if needed
- import reusable local Codex auth into Clementine

If you already signed into Codex with ChatGPT, `clementine auth import-codex` imports local credentials from `~/.codex/auth.json` into Clementine’s own state store.

For Codex-backed runtime usage:

```bash
AUTH_MODE=codex_oauth clementine doctor
AUTH_MODE=codex_oauth clementine service
```

Notes:

- native ChatGPT/Codex login is now available inside Clementine
- `codex_oauth` runtime execution still runs through the official Codex CLI bridge rather than the OpenAI Agents SDK
- Clementine-managed approval interruptions are only available on the OpenAI Agents SDK path today

## MCP tooling

`clementine-next` now treats MCP as the primary tool surface.

- Local MCP is enabled by default
- Local tools now cover:
  - memory and working memory
  - vault notes and task management
  - saved plans
  - session resume/history
  - persistent goals
  - timers
  - cron job definitions, trigger files, and run/progress history
  - workflow definitions and queued workflow runs
  - workspace/project discovery
  - team agents, local team messaging, and delegation state
  - custom user tool creation
- External MCP servers are auto-discovered from:
  - `~/Library/Application Support/Claude/claude_desktop_config.json`
  - `~/.claude/settings.json`
  - `~/.clementine-next/mcp/servers.json`
- User script tools can be dropped into `~/.clementine-next/tools/` as `.sh` or `.py`

In the CLI, run `/tools` to inspect the current MCP surface.

## Daemon

Run the local background worker with:

```bash
npm run daemon
```

Current daemon scope:

- executes due cron jobs from `CRON.md`
- consumes manual cron trigger files
- consumes queued workflow run files
- runs autonomous agent wake cycles for the primary assistant and installed team agents
- persists cron run logs and workflow run state locally
- persists agent inbox and agent state locally under the Clementine home

This is the rebuilt local-first execution layer. Full channel delivery and dashboard orchestration still need additional parity work.

## Control Plane

The webhook server now also exposes a minimal local dashboard.

- HTML dashboard: `/dashboard?token=YOUR_WEBHOOK_SECRET`
- JSON snapshot: `/api/dashboard`
- daemon detail: `/api/daemon/status`
- notifications feed: `/api/notifications`
- agent state and inbox visibility in the dashboard/API snapshot

Run it with:

```bash
npm run webhook
```

Notification delivery:

- daemon results are stored locally as notifications
- notifications can be pushed to configured outbound webhook destinations
- destinations can be managed from the dashboard
- delivery retries now happen per destination with backoff instead of blocking the whole queue on one failure
- failed deliveries can be requeued from the dashboard
- supported destination types:
  - `generic_webhook`
  - `discord_webhook`
  - `discord_channel`
  - `discord_user`
- destinations can be tested from the dashboard before enabling them for delivery

## Discord

Discord is now a real bot transport, not just a webhook sink.

Set:

```bash
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=...
DISCORD_REQUIRE_MENTION=true
```

Optional:

```bash
DISCORD_ALLOWED_CHANNELS=1234567890,0987654321
```

Run only the bot:

```bash
npm run discord
```

Run the local full stack:

```bash
npm run service
```

Current Discord behavior:

- DMs respond automatically
- guild messages respond when the bot is mentioned by default
- sessions persist locally per Discord user/channel
- daemon notifications can be delivered to Discord webhooks, direct Discord bot channels, or Discord user DMs
- approvals can be listed and resolved directly in Discord with `approvals`, `approve <id>`, and `reject <id>`
- approval notifications now auto-route back to the originating Discord user when possible
- Discord operator commands also support `status`, `notifications`, `read <notification_id>`, and `retry <notification_id>`
- approval and notification cards in Discord now include button actions for approve, reject, mark read, and retry delivery

## Lightweight onboarding

The target install path for end users is:

```bash
npx create-clementine@latest
```

That package is not published yet. For now, this repo keeps the install flow lightweight and local while the product shape stabilizes.
