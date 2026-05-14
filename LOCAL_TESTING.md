# Local testing

Three tiers, from zero-setup to full end-to-end.

## Tier 1 — no setup, no API key

These exercise the code we shipped without needing OpenAI access.

### Run the unit test suite

```bash
npx tsx --test src/**/*.test.ts
```

Expect **155 tests pass, ~1.5s**. Covers memory, recall, embeddings,
facts, autonomy guardrails, run-tracking, autonomy-v2 helpers,
check-ins, sub-agents, user profile, channel directives,
local-runtime tools.

### Typecheck the whole project

```bash
npx tsc --noEmit
```

Expect **clean output** (no errors). Tells you the entire codebase
including both my work and the other agent's still composes.

### Health checks

```bash
npm run doctor
```

Prints a system snapshot: auth status, memory index stats (chunks /
facts / embeddings coverage), policy snapshot, configured channels,
detected CLIs (git, node, gh, codex, etc.). Catches "ah, I never
ran setup" before you go further.

```bash
npm run dev memory status
```

Memory layer specifically — total chunks, indexed files, embedding
coverage, last index time. Useful after touching any memory work.

```bash
npm run dev memory reindex
```

Force-rebuild the vault index. Useful if you suspect drift or want
to see how long an index pass takes (it's incremental, so usually
fast).

---

## Tier 2 — with `OPENAI_API_KEY`

Set the key. Many of the autonomy features unlock here.

```bash
export OPENAI_API_KEY=sk-...
# or put it in your .env
echo 'OPENAI_API_KEY=sk-...' >> .env
```

### Initialize the home directory

```bash
npm run init-home
```

Creates `~/.clementine-next/` with the vault scaffold, default
agent files, and state directories. Idempotent — safe to rerun.

### Interactive chat

```bash
npm run chat
```

Full chat UI. Hit a few things to verify:

- **Channel-aware tone**: chat in CLI is conversational + markdown OK
- **Memory recall**: ask the agent something, then start a new session and ask if it remembers
- **Persistent facts**: tell it "call me Nate" → `user_profile_update` should fire → next session addresses you that way
- **Check-ins**: ask something it shouldn't have to guess, like "deploy the v0.2 release notes" with no context — it should call `ask_user_question` and pause
- **Slash-like commands**: `/tools` lists the MCP tool surface

### One-shot autonomy v2 cycle (the killer demo)

```bash
# Make sure clementine is opted into v2:
echo 'AUTONOMY_V2_AGENTS=clementine' >> .env

# Then trigger a single cycle manually:
npx tsx src/cli/autonomy-run.ts clementine
```

What you'll see: the full run timeline printed inline — wake reasons,
policy snapshot, model start, tool calls with input/output, decision,
outcomes. This is the exact view that lands in the dashboard runs panel.

If there's no work to do (no inbox items, cadence not due), it'll
say "No wake reasons" and exit. Pre-load some work first:

```bash
# Add a goal so the agent has something to drive:
mkdir -p ~/.clementine-next/goals
cat > ~/.clementine-next/goals/test-goal.json <<'EOF'
{
  "id": "g-test",
  "title": "Test the autonomy loop end-to-end",
  "status": "active",
  "priority": "high",
  "owner": "clementine",
  "nextActions": ["Verify v2 cycle runs", "Confirm tools fire"],
  "progressNotes": [],
  "blockers": [],
  "description": "Smoke test for the SDK-native autonomy loop.",
  "updatedAt": "2026-05-13T00:00:00.000Z"
}
EOF
npx tsx src/cli/autonomy-run.ts clementine
```

---

## Tier 3 — full service mode

This runs everything: daemon, webhook server with dashboard,
optional Discord. Useful for soak-testing.

### Foreground (everything in one terminal)

```bash
npm run service
```

That starts:
- The autonomy daemon (15s tick — v2 cycles, memory maintenance, proactive briefs, executions)
- Webhook server on `http://localhost:8420`
- Discord bot if `DISCORD_ENABLED=true`

Tail the logs in another terminal:

```bash
npm run daemon:logs
```

### Background daemon

```bash
npm run daemon:start
npm run daemon:status
npm run daemon:logs
npm run daemon:stop
```

### Dashboard

With the webhook server running, open:

```
http://localhost:8420/dashboard?token=YOUR_WEBHOOK_SECRET
```

(Set `WEBHOOK_SECRET` in `.env`. Without it, dashboard auth is disabled
in dev mode but you'll get a warning.)

You'll see:
- **Memory index** panel — chunks, facts, embedding coverage, rebuild button
- **Run Control Center** — every autonomy cycle, every tool call, every approval, every notification
- **Autonomy Policy** form — flip mode (watch/balanced/hands_on), set quiet hours, toggle Composio/computer/Discord categories
- **Workflows** — list, run, approve
- **Tasks / Goals / Executions** — read + edit

---

## Manual exercise checklist (against the goal vision)

Once you have the service running with an API key, walk through:

### Memory: never forgets
1. Chat: "Remember that I prefer Pacific timezone and 'Nate' as my preferred name."
2. Verify `user_profile_update` fired (check the runs panel).
3. Close the chat. Start a new chat session.
4. The first turn should already address you as Nate.

### Check-ins: pauses when stuck
1. Tell the agent something ambiguous: "Ship the staging update."
2. It should call `ask_user_question` with something specific
   (which staging? what update?). Discord/notification shows the question.
3. Reply via the dashboard or `answer_check_in` tool.
4. Next cycle picks up the answer in its inbox and resumes.

### Executions: never stops until done
1. Chat: "Help me finish the quarterly report. Success criteria:
   `docs/q1-report.md` exists with a section per goal."
2. An execution should be created. View in dashboard.
3. Subsequent autonomy cycles drive `execution_update_step` repeatedly,
   eventually `execution_complete` when criteria are met.

### Orchestrator + sub-agents
1. Chat: "Research how often we deployed last month and write a
   one-page summary to `docs/deploy-cadence.md`."
2. In the runs panel timeline, you should see handoff events:
   `Clementine → Researcher` (gathers data), `Clementine → Writer`
   (drafts), and possibly `Executor` (writes file).

### Channel-aware style
1. With Discord configured, DM the bot the same question you asked in CLI.
2. CLI reply: markdown-rich, full length.
3. Discord reply: tight, under ~500 chars, no `#` headers, code blocks still fine.

### Workflow approval gate
1. Chat: "Create a workflow that runs a weekly cleanup."
2. `workflow_create` lands with `enabled: false` (or your agent might
   set it true depending on instructions).
3. Run `workflow_get` to inspect.
4. Run `workflow_set_enabled` to approve (or do it from the dashboard).
5. Only after approval will the Executor sub-agent fire it.

---

## Troubleshooting

### "OPENAI_API_KEY not set" on autonomy-run

Set it in `.env` or the shell:
```bash
export OPENAI_API_KEY=sk-...
```
The runtime-resolvable getter re-reads on every call, so a fresh
shell or restart isn't required after `.env` edits.

### "No wake reasons" on autonomy-run

The agent isn't due yet AND has no inbox items. Either wait for
cadence to elapse (default 30 min) or add a goal/task/inbox item
(see Tier 2 example).

### Daemon doesn't start

Check:
```bash
npm run daemon:status
```
If it says "running" but you don't see logs, check `~/.clementine-next/logs/`.
If it says "not running" but you started it, check
`~/.clementine-next/daemon.pid` and `clementine daemon stop` to clear stale state.

### Tests fail with "cannot find module"

Likely a stale `dist/` or `node_modules/`:
```bash
rm -rf dist node_modules
npm install
npx tsx --test src/**/*.test.ts
```

### MCP server discovery isn't picking up Playwright / Firecrawl

clemmy auto-detects MCP servers from:
- `~/Library/Application Support/Claude/claude_desktop_config.json`
- `~/.claude/settings.json`
- `~/.clementine-next/mcp/servers.json`

Add the server to one of those and restart the daemon.
