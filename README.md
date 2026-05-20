# Clementine

A persistent, single-user AI assistant for your Mac. Runs as a local daemon,
talks through a clean dashboard, voice, Discord, and webhooks, and can act on
your behalf in any app you grant her access to.

```
chat ─┐
voice ─┤
discord─┤  →  Clementine ─→  tools ─→  your apps, your files, the web
api ──┘                       (MCP + Composio + computer-use, all gated by one trust policy)
```

## What she is

Clementine is built around three primitives:

- **One memory spine.** Vault notes, structured facts, working memory, embeddings,
  session briefs. Persistent across sessions; cleaned and re-summarised in the
  background. She remembers your projects, preferences, and the rhythms of your
  work — not because the prompt repeats them, but because the runtime knows
  where to find them.

- **One compact tool surface.** Local SDK tools, MCP-discovered tools
  (DataForSEO, Hostinger, Supabase, etc.), Composio-bridged apps (Gmail,
  Google Sheets, Slack, Notion, …), computer-use, the planner, and installed
  skills are available without dumping every possible schema into every model
  call. Composio uses a search/execute broker; skills are loaded on demand.

- **One trust gradient.** Every tool flows through a single classifier
  (`read | write | execute | send | admin`) and one approval decision driven
  by the scope policy you set:

  | Scope        | read | write/execute (inside workspace) | write/execute (outside) | send (network) | admin |
  | ------------ | ---- | -------------------------------- | ----------------------- | -------------- | ----- |
  | `strict`     | auto | ask                              | ask                     | ask            | ask   |
  | `workspace`  | auto | **auto**                         | ask                     | ask            | ask   |
  | `yolo`       | auto | **auto**                         | **auto**                | **auto**       | ask   |

  A hard denylist (`rm -rf /`, `sudo`, fork bombs, disk wipes) is **always
  enforced** regardless of scope. `admin` tools always ask.

She is single-user and local-first. The daemon writes only to
`~/.clementine-next/`. Nothing goes to a hosted backend except the LLM
provider you configure and the third-party APIs you connect.

## Install

The signed macOS app is the supported install path:

1. Download the latest `Clementine-<version>-arm64.dmg` from
   [Releases](https://github.com/Natebreynolds/clemmy/releases).
2. Drag **Clementine** to your Applications folder.
3. Launch it. On first run, the setup wizard collects:
   - Your LLM auth (Codex OAuth via ChatGPT, OpenAI API key, or both).
   - Optional Composio API key for connected apps.
   - Optional Discord bot token.
4. Grant any macOS permissions the wizard prompts for (Microphone for voice,
   Screen Recording for meeting capture, Accessibility + Apple Events so she
   can do work in other apps).

She runs in the background. The window is the dashboard; closing it leaves the
daemon running. Find her in the menu bar to quit.

### Run from source (development)

```bash
git clone https://github.com/Natebreynolds/clemmy
cd clemmy
npm install
npm run setup      # interactive wizard
npm run daemon     # background service
npm run chat       # CLI chat (separate terminal)
```

Or the Electron shell:

```bash
cd apps/desktop
npm install
npm start
```

## Architecture

```
                 ┌─────────────────────────────────────────┐
                 │              Clementine.app             │
                 │  (signed, hardened-runtime macOS bundle)│
                 │                                         │
                 │   ┌───────────────────────────────────┐ │
                 │   │   Daemon (one Node process)       │ │
                 │   │                                   │ │
                 │   │   ┌─────────┐    ┌─────────────┐  │ │
                 │   │   │ Runtime │ ←→ │ToolTaxonomy │  │ │
                 │   │   │ (Codex /│    │ + scope     │  │ │
                 │   │   │  OpenAI)│    │ policy      │  │ │
                 │   │   └────┬────┘    └─────────────┘  │ │
                 │   │        │                          │ │
                 │   │   ┌────▼─────────────────────────┐│ │
                 │   │   │  Tool surface (one list)     ││ │
                 │   │   │  • SDK: local + computer-use ││ │
                 │   │   │  • Composio search/execute   ││ │
                 │   │   │  • <server>__<tool>  (MCP)   ││ │
                 │   │   └──────────────────────────────┘│ │
                 │   │        │                          │ │
                 │   │   ┌────▼─────────────────────────┐│ │
                 │   │   │ Memory spine (vault, facts,  ││ │
                 │   │   │ working, embeddings, briefs) ││ │
                 │   │   └──────────────────────────────┘│ │
                 │   └───────────────────────────────────┘ │
                 │                                         │
                 │   Renderer ←→ /console (localhost:8520) │
                 └─────────────────────────────────────────┘
```

### Key files

- `src/agents/tool-taxonomy.ts` — the classifier + approval decision. Every
  tool's `needsApproval` hook routes through it.
- `src/runtime/mcp-namespace-shim.ts` — flattens N MCP servers into one
  collision-free surface (`<server>__<tool>`).
- `src/runtime/codex-native-runtime.ts` — the runtime that talks to ChatGPT's
  Codex backend; folds MCP + compact Composio broker + SDK tools into one tool list.
- `src/tools/composio-tools.ts` — broker tools for discovering and executing
  any connected Composio action by exact slug.
- `src/agents/proactivity-policy.ts` — the scope policy (`strict | workspace
  | yolo`) you set in the dashboard.
- `src/agents/tool-observability.ts` — append-only NDJSON log of every tool
  call. The substrate for the always-learning loop.

## Connected tools

### MCP servers

Drop a server into `~/.clementine-next/mcp/servers.json` or add one from the
dashboard. Live-reloads — no daemon restart needed. Set
`MCP_AUTO_IMPORT_ENABLED=true` to import servers from Claude Desktop and Claude
Code.

Currently smoke-tested integrations: DataForSEO, Hostinger, Supabase, Bright
Data, ElevenLabs, Apify, browsermcp, plus the local `clementine` MCP server.

### Composio

Paste a Composio API key in the dashboard under **Connected Apps**. Every
active toolkit is reachable through `composio_search_tools` and
`composio_execute_tool`, so the model can use all actions without loading
hundreds of per-action schemas into every turn. Approval gating still applies:
Gmail-send asks in strict, autos in YOLO; Sheets-read autos everywhere.

### Computer-use

`write_file` and `run_shell_command` are gated by the scope policy. The hard
denylist in `assertCommandAllowed` is absolute. Workspace dirs are configurable
in `~/.clementine-next/.env` (`WORKSPACE_DIRS=...`).

## Channels

- **Dashboard chat** — the home page of the Electron app. Voice toggle in the
  header.
- **Voice (OpenAI Realtime)** — push-to-talk in the dashboard. Routes spoken
  commands into the local agent via `send_to_clementine`.
- **Discord** — paste a bot token in the dashboard. DMs, bot-channel posts,
  approval buttons.
- **Webhook / API** — `POST /api/console/home/chat` on `localhost:8520` with
  the webhook secret in the query string. NDJSON streaming on
  `/api/console/home/chat/stream`.

## Data layout

Everything she remembers lives under `~/.clementine-next/`:

```
~/.clementine-next/
├── vault/              markdown notes, the memory floor
├── memory.db           SQLite index (FTS + embeddings)
├── state/
│   ├── proactivity-policy.json    (your scope: strict/workspace/yolo)
│   ├── plan-scopes.json           (active plan auto-approval windows)
│   ├── approvals.json             (pending + historical approvals)
│   ├── tool-events/               (per-day NDJSON of every tool call)
│   └── secrets-vault.json         (encrypted-at-rest credentials)
├── mcp/servers.json    your configured MCP servers
├── goals/              persistent goal records
├── workflows/          user-defined workflows
├── working-memory.md   live session scratch
└── logs/               daemon + supervisor logs
```

Apple Developer secrets (signing, notarization) live at
`~/.clementine-secrets/desktop.env` — **never** in the repo.

## Development

Test:

```bash
npx tsc --noEmit                              # type check
find src -name "*.test.ts" -exec npx tsx --test {} \;
```

Build the desktop app:

```bash
cd apps/desktop
./scripts/release-local.sh   # signed + notarized DMG → release/
```

The daemon and the Electron app share the `~/.clementine-next/` data dir, so
you can iterate on the daemon from source (`npm run daemon`) and your data
stays consistent with the installed Clementine.app.

## Status

Shipped and working:

- ✓ Single namespace-shimmed MCP surface across N servers (no collisions)
- ✓ Token-efficient Composio broker for all connected actions
- ✓ Unified tool taxonomy + scope policy (`strict | workspace | yolo`)
- ✓ Codex OAuth runtime with full tool surface (MCP + Composio + SDK + local)
- ✓ Append-only tool-event audit log
- ✓ Dashboard live-reload for MCP servers (no daemon restart)
- ✓ Voice via OpenAI Realtime
- ✓ Discord bot transport with approval buttons
- ✓ Plan-scope auto-approval (a user approves a plan, the tools inside auto for 15 min)

Known gaps:

- Confidence scoring driven by the tool-event audit log
- Windows / Linux desktop builds (macOS first)

## License

MIT. See `LICENSE`.
