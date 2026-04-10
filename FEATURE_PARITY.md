# Feature Parity Status

This document tracks where `clementine-next` stands relative to `clementine-dev`.

## Current state

`clementine-next` has a working core:

- OpenAI Agents SDK runtime
- local CLI chat
- approval persistence and resolution
- session persistence
- vault scaffold
- vault search and prompt context assembly
- working memory
- lightweight plan storage
- deep-task mode

It does **not** yet have full parity with `clementine-dev`.

## Feature map

### Core agent runtime

- `clementine-dev`: mature, broad, Anthropic-coupled runtime with safety hooks, orchestration, self-improve, and team routing
- `clementine-next`: OpenAI Agents SDK runtime plus Codex CLI-backed runtime for ChatGPT/Codex subscription auth, but still much lighter
- Status: partial

### Memory

- `clementine-dev`: SQLite FTS, embeddings, graph store, consolidation, richer ranking
- `clementine-next`: markdown vault search, working memory, session memory, prompt assembly
- Status: partial

### Tools

- `clementine-dev`: extensive MCP and external tools
- `clementine-next`: MCP-first local tool server with memory, notes, tasks, plans, session resume, goals, timers, workspace discovery, team/agent CRUD, local team messaging/delegation, dynamic user tools, and external MCP discovery; approvals still remain in-process
- Status: partial

### Planning / orchestration

- `clementine-dev`: dedicated orchestrator and workflow runner
- `clementine-next`: lightweight saved plans and deep-task mode, plus local-first cron/workflow definitions, triggers, and persisted progress state
- Status: partial

### Channels

- `clementine-dev`: Discord, Slack, Telegram, WhatsApp, webhook
- `clementine-next`: CLI, webhook API/control plane, Discord bot transport, outbound webhook delivery, outbound Discord webhook delivery, outbound Discord bot-channel delivery, outbound Discord user DM delivery, Discord-side approval handling
- Status: partial

### Gateway / daemon / automation

- `clementine-dev`: heartbeat, cron schedulers, router, delivery queue
- `clementine-next`: local daemon loop, cron scheduler, workflow queue runner, notification queue, outbound destination fanout, per-destination retry/backoff and requeue support
- Status: partial

### Dashboard / web control plane

- `clementine-dev`: implemented
- `clementine-next`: local dashboard with approvals, cron/workflow actions, notifications, delivery destinations, daemon state
- Status: partial

## What “done enough for first release” means

1. Strong CLI + local runtime
2. Memory good enough to preserve continuity
3. Deep-task mode good enough to plan and track work
4. Approval flow stable
5. One external channel or webhook path
6. Clean install and setup

## Recommended next build order

1. Inbound Slack or secondary channels
2. Deeper daemon hardening and retries, especially per-destination delivery behavior
3. Better memory ranking and persistence
4. Richer dashboard CRUD and live state
5. Team/orchestration depth beyond local file-backed flows
6. Packaging and clean install polish
