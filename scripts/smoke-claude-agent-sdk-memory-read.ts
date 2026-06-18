#!/usr/bin/env tsx
/**
 * Live smoke: prove Claude Agent SDK can call Clementine's local memory MCP
 * surface through the user's Claude subscription auth. This intentionally uses
 * a read-only memory search, not a mutating tool, because the full Claude-brain
 * lane still needs approval/guardrail parity before mutation tools are exposed.
 */
import { runClaudeAgentSdk } from '../src/runtime/harness/claude-agent-sdk.js';

const expected = 'CLAUDE_AGENT_SDK_MEMORY_READ_OK';
const query = 'claude-agent-sdk-memory-read-smoke-7e87d0';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const result = await runClaudeAgentSdk({
  modelId: process.env.CLEMMY_LIVE_CLAUDE_MODEL || 'claude-sonnet-4-6',
  allowedLocalMcpTools: ['memory_search'],
  maxTurns: 4,
  systemAppend: [
    'You are verifying Clementine local MCP memory access.',
    'You must call the local Clementine MCP memory_search tool before answering.',
    `After the tool returns, reply exactly ${expected} and nothing else.`,
  ].join('\n'),
  prompt: `Call memory_search with query ${JSON.stringify(query)}, then reply exactly ${expected}.`,
});

if (!result.toolUses.some((tool) => tool.endsWith('__memory_search'))) {
  fail(`Claude Agent SDK did not call local MCP memory_search. toolUses=${JSON.stringify(result.toolUses)}`);
}

if (result.text.trim() !== expected) {
  fail(`unexpected Claude Agent SDK response: ${JSON.stringify(result.text.trim())}`);
}

console.log(JSON.stringify({
  ok: true,
  sentinel: expected,
  model: result.model,
  sessionId: result.sessionId,
  toolUses: result.toolUses,
}, null, 2));
