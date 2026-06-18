#!/usr/bin/env tsx
/**
 * Live smoke: route a normal Clementine chat surface through the opt-in Claude
 * Agent SDK brain lane and prove it can call read-only Clementine memory.
 */
const expected = 'CLAUDE_AGENT_SDK_BRAIN_READONLY_OK';
const query = 'claude-agent-sdk-brain-readonly-smoke-48ad9e';

process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';

const { respondPreferHarness } = await import('../src/runtime/harness/respond-bridge.js');

const sessionId = `claude-sdk-brain-smoke-${Date.now()}`;
const response = await respondPreferHarness(
  'home',
  {
    sessionId,
    channel: 'smoke',
    message: [
      `Call the local Clementine memory_search tool with query ${JSON.stringify(query)}.`,
      `After the tool returns, reply exactly ${expected} and nothing else.`,
    ].join(' '),
  },
  async () => {
    throw new Error('legacy responder should not be called when Claude SDK brain is enabled');
  },
);

if (response.text.trim() !== expected) {
  console.error(`unexpected Claude SDK brain response: ${JSON.stringify(response.text.trim())}`);
  process.exit(1);
}

const raw = response.raw as { transport?: unknown; toolUses?: unknown; model?: unknown; sessionId?: unknown } | undefined;
if (raw?.transport !== 'claude_agent_sdk_brain') {
  console.error(`unexpected transport: ${JSON.stringify(raw)}`);
  process.exit(1);
}
const toolUses = Array.isArray(raw.toolUses) ? raw.toolUses : [];
if (!toolUses.some((tool) => typeof tool === 'string' && tool.endsWith('__memory_search'))) {
  console.error(`Claude SDK brain did not call local MCP memory_search. raw=${JSON.stringify(raw)}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  sentinel: expected,
  sessionId,
  model: raw.model,
  sdkSessionId: raw.sessionId,
  toolUses,
}, null, 2));
