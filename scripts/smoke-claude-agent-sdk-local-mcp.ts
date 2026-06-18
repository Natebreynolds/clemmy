#!/usr/bin/env tsx
import { runClaudeAgentSdk } from '../src/runtime/harness/claude-agent-sdk.js';

const expected = 'CLAUDE_AGENT_SDK_LOCAL_MCP_OK';

const result = await runClaudeAgentSdk({
  modelId: process.env.CLEMMY_LIVE_CLAUDE_MODEL || 'claude-sonnet-4-6',
  allowedLocalMcpTools: ['ping'],
  maxTurns: 4,
  systemAppend: [
    'You are a Clementine integration smoke tester.',
    'You must call the local Clementine MCP ping tool before answering.',
    `After the tool returns pong, reply with exactly: ${expected}`,
  ].join('\n'),
  prompt: [
    'Call the local Clementine MCP ping tool now.',
    `Then reply with exactly: ${expected}`,
    'Do not mention anything else.',
  ].join('\n'),
});

if (!result.toolUses.some((name) => /(^|__)ping$/i.test(name))) {
  throw new Error(`Claude Agent SDK did not call the local MCP ping tool. toolUses=${JSON.stringify(result.toolUses)}`);
}

if (result.text.trim() !== expected) {
  throw new Error(`unexpected Claude Agent SDK response: ${JSON.stringify(result.text.trim())}`);
}

console.log(JSON.stringify({
  ok: true,
  sentinel: result.text.trim(),
  model: result.model,
  sessionId: result.sessionId,
  toolUses: result.toolUses,
}, null, 2));
