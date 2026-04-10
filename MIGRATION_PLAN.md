# Migration Plan

## Objective

Rebuild Clementine on a new agent runtime without mutating `clementine-dev`.

## What carries over

- Vault structure and markdown conventions
- SQLite memory/indexing model
- MCP server concept
- Gateway and channel patterns
- Approval queue and dashboard concepts
- Agent/team profile model

## What changes

- Anthropic `query()` loop becomes a modern `Agent` + `run()` execution model
- Claude-specific permission model becomes OpenAI guardrails + human-in-the-loop
- Claude subagent APIs become OpenAI handoffs / agents-as-tools
- Session storage is reworked around OpenAI sessions or a custom adapter

## Execution phases

### Phase 1

Scaffold the new repo and define runtime abstractions.

### Phase 2

Port the core assistant runtime:

- system prompt assembly
- OpenAI agent construction
- run lifecycle
- streaming adapter
- tool activity events

### Phase 3

Port MCP and approval flows:

- local MCP server wiring
- tool approval interrupts
- resumable runs
- policy enforcement

### Phase 4

Port memory:

- vault sync
- retrieval/context assembly
- background extraction
- session summarization

### Phase 5

Port orchestration:

- planner
- worker execution
- handoffs
- resumable plan state

### Phase 6

Reconnect surfaces:

- CLI
- dashboard
- Discord
- Slack
- Telegram
- WhatsApp
- webhook

## Immediate next file targets

- `src/runtime/openai.ts`
- `src/runtime/provider.ts`
- `src/assistant/core.ts`
- `src/memory/session-store.ts`
- `src/tools/registry.ts`

## Product improvements

- Sharper conversation style with less robotic language
- Native approval/resume instead of ad hoc permission loops
- Lightweight installer with a future `npx create-clementine`
- Lean local-first tools before reconnecting every external channel
