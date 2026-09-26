# Switching agents mid-conversation — checkpoint (2026-09-26)

Branch `claude/agent-switch`, three commits on top of the workflow-builder
line (`claude/wf-builder-slice1`). Owner direction (09-25, late): the main chat
gets the same agent dropdown as the agent pages, like the model chip, so the
owner can move a conversation to another agent at any time; think through
threading; later, Clem toggles agents herself using Jev.

Owner decisions taken (recommendations accepted):
1. Switch in place: one conversation, one history. No new thread on a switch.
2. Inside an agent's own page the chip stays locked to that agent.
3. The model chip stays the owner's; an agent's model applies to the helpers
   it runs, shown as a note in the dropdown.

## What was true before

A conversation bound to an agent once, at creation (`metadata.agentId`); the
desktop and phone chips became fixed labels after the first message. The
completion reviewer never saw the agent's standing instructions.

## What the branch does

- **One pointer, switchable** (`src/agents/session-agent.ts`):
  `setSessionAgent(sessionId, agentId | null, { by })` moves `agentId` /
  `agentName` atomically (`json_set` on the metadata column only), records
  every agent that took part in `agentIds`, and records `agentSetBy`
  (`owner` today; `clem` is reserved for the Jev routing below). A Space dock,
  a workflow step and a background execution refuse an agent. The pure reader
  `sessionAgentState` lives in `session-agent-state.ts` so low layers can import
  it without cycles.
- **Routes**: `POST /api/console/sessions/:id/agent` and
  `POST /m/api/chat/sessions/:id/agent`, body `{ agentId: string | null }`.
- **Takes effect on the next turn**: an agent's context is read when a turn
  starts. Clients apply the choice just before a new message; a message sent
  while a reply runs steers that reply and the choice waits; an answer to a
  waiting card resumes that reply unchanged.
- **Who answered**: each turn's `turn_model_routed` already names the agent;
  the reopened transcript (`reconstructHarnessTranscript`) now carries
  `agentName` on every turn of an exchange (null = Clem, absent = no marker).
  The shared chat engine (`packages/chat-engine/src/turn-agent.ts`) derives the
  speaker per reply and the "Switched to …" line, placed above the message that
  started the change; desktop and phone draw the same thread.
- **Agent pages** list every conversation the agent answered in, including
  ones since switched away (`agentIds`). A successor session carries the
  pointer and the history.
- **The turn after a switch** gets one per-turn line after the cache boundary
  (`agentHandoffNote`): earlier replies were written under other instructions,
  which no longer apply.
- **Reviewer**: `sessionAgentReviewContext` gives the completion reviewer the
  agent's name, what it handles, its standing instructions (capped) and its
  pinned skill names, framed as how the owner wants the work done and never
  as extra deliverables. An unbound turn is reviewed byte-for-byte as before.

## Live acceptance (installed app, live home)

Fixture agent `framework-test-haiku-desk` ("FRAMEWORK-TEST Haiku Desk": answer
as exactly one haiku). One conversation, four turns, brain served:
DeepSeek V4.1 Flash (the owner's BYO brain), Jev router, Claude Sonnet 5 as the
memory-durability reviewer.

| Turn | Who | Reply | Wall |
|---|---|---|---|
| season after summer | Clem | plain sentence | 9.9 s (cold) |
| describe that season | Haiku Desk | a haiku about autumn (history carried) | 1.9 s |
| winter, one plain sentence | Clem | plain sentence | 2.9 s |
| and spring? (no format hint) | Clem | plain sentence, no haiku carry-over | 1.5 s |

- Reopened transcript names Clem / Haiku Desk / Clem per exchange; the agent's
  work list shows the conversation after it switched back to Clem.
- Stable prompt tokens: 9,416 (Clem) → 9,502 (agent, +86) → 9,416 (Clem).
- Cache: the BYO brain cached 0 / 1,152 / 1,152 / 1,920 of ~13.6k input tokens
  per turn with or without a switch. The switch cost is lost in a lane that
  barely caches at all — a separate, pre-existing finding.
- Memory: all four test messages became candidates and were rejected as
  task-scoped; nothing was saved.
- Collision: another session's install replaced this build four minutes after
  it went in; the union is being installed by that session (see the git log).

## Owed

1. Live check of the union install: desktop chip + switch line on screen, a
   phone switch, and a completion review on an agent turn that did work.
2. Jev completion screening (`tryJevCompletionVerdict`) does not yet get the
   agent's instructions; the full reviewer does.
3. Pinned skill bodies stay with the answerer; the reviewer sees names only.
4. The BYO brain's low cache hit rate on plain chat turns (above).
5. `apps/mobile-web/src/lib/chat-chrome.test.ts` "confirmed change while live"
   fails on the base as well; not from this branch.

## Next: Clem brings in an agent (Jev), proposed

- **Where**: the turn-start Jev request (`decideTurnStartWithJev`) already runs
  before the agent is built (`loop.ts`: the proven pick precedes
  `resolveCapability`). Add one independent question to that same request —
  which saved agent's lane this request is in (choice over names + handles,
  plus a sure/unsure check per candidate) — so it costs no extra round trip.
  Plain conversation turns skip that request today; the router call that runs
  on every turn is the alternative carrier.
- **Rules**: the owner's pick always wins — Clem switches only while
  `agentSetBy` is not `owner` for this conversation; only on a sure, fitting
  answer; Clem may return a conversation to herself only when she brought the
  agent in. Fail-open: no answer, no switch.
- **Visible, one-tap undo**: `setSessionAgent(…, { by: 'clem' })`; the route
  marker carries who chose, and the line reads "Clem brought in Instagram
  Manager" with a switch-back control.
- **Measure before trusting**: the same asks with and without routing through
  `npm run measure:turns`, plus how often the owner undoes Clem's pick.
- The other path stays: when Clem needs an agent's craft for one part of the
  work without moving the conversation, she runs a worker as that agent
  (`run_worker` with `agent`).
