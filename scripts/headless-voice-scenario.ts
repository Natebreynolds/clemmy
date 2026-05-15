/**
 * Headless re-run of the voice scenario that previously failed with
 * "I don't have a callable DataForSEO MCP tool exposed in this session
 * right now". Now that the namespace shim is in front of every server,
 * the Agent should actually see `dataforseo__*` tools and call one.
 *
 * Scope:
 *   - Doesn't touch the running daemon, the Electron app, or the
 *     dashboard's auth/session/memory state.
 *   - Builds a minimal Agent with `mcpServers: [shim]` and a thin
 *     instruction so the result reflects the runtime, not prompt
 *     coaching.
 *   - Logs every tool the model called so we can see DataForSEO
 *     actually firing.
 *
 * Run: npx tsx scripts/headless-voice-scenario.ts
 */
import { Agent, Runner, setDefaultOpenAIKey } from '@openai/agents';
import { getOpenAiApiKey } from '../src/config.js';
import { createConfiguredMcpServers } from '../src/runtime/mcp-servers.js';

const VOICE_QUERY =
  // The same shape of question that previously made the agent claim
  // DataForSEO wasn't available.
  "Pull the top 10 organic SERP results from Google for the keyword 'pinecone vector database' in the United States. Return the URLs and titles.";

async function main() {
  const key = getOpenAiApiKey();
  if (!key) {
    console.error('No OPENAI_API_KEY configured.');
    process.exit(2);
  }
  setDefaultOpenAIKey(key);

  console.log('▸ building shim');
  const shim = createConfiguredMcpServers();

  console.log('▸ building agent');
  const agent = new Agent({
    name: 'shim-smoke',
    // Deliberately minimal — no "you don't have access to X" guard rails,
    // no Discord/dashboard plumbing. Whatever happens here is purely a
    // function of (model + tool surface).
    instructions:
      'You are a helpful research assistant. You have access to MCP tools — call them directly when the user asks for data. If a relevant tool exists, use it; do not claim it is unavailable.',
    model: 'gpt-4.1-mini',
    mcpServers: [shim],
  });

  console.log('▸ running query:');
  console.log(`  ${VOICE_QUERY}\n`);

  const runner = new Runner({ workflowName: 'shim-smoke' });
  const t0 = Date.now();
  const result = await runner.run(agent, VOICE_QUERY, { maxTurns: 8 });
  const dt = Date.now() - t0;

  console.log(`\n▸ run finished in ${dt}ms`);

  // Walk the history to see which tools fired.
  const calledTools: string[] = [];
  for (const item of result.history ?? []) {
    const anyItem = item as any;
    if (anyItem.type === 'function_call' || anyItem.type === 'tool_call') {
      const name = anyItem.name ?? anyItem.tool_name ?? '(unknown)';
      calledTools.push(name);
    }
    // Newer SDK message shapes use a `content` array with tool_use blocks.
    if (anyItem.role === 'assistant' && Array.isArray(anyItem.content)) {
      for (const block of anyItem.content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          calledTools.push(block.name);
        }
      }
    }
  }

  console.log(`▸ tools called this run (${calledTools.length}):`);
  for (const t of calledTools) console.log(`  • ${t}`);

  const dataforseoCalls = calledTools.filter((n) => n.startsWith('dataforseo__'));
  if (dataforseoCalls.length === 0) {
    console.log('\n⚠ no dataforseo__* tool was called.');
  } else {
    console.log(`\n✓ DataForSEO actually fired (${dataforseoCalls.length} call${dataforseoCalls.length === 1 ? '' : 's'}).`);
  }

  console.log('\n▸ final assistant output:');
  console.log(result.finalOutput ?? '(no finalOutput)');

  if (typeof shim.close === 'function') {
    await shim.close();
  }
  process.exit(dataforseoCalls.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('uncaught:', e);
  process.exit(1);
});
