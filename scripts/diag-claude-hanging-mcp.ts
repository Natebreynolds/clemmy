/**
 * Decisive causation test: does an attached MCP server whose connect() HANGS
 * stall the Claude model call BEFORE it produces any content?
 *
 * In the production tool-turn and MCP prewarm regressions, clementine-local + dataforseo were
 * degraded/connecting and every such turn stalled pre-content. Repros with
 * HEALTHY mcp never stalled. This isolates the variable: a hanging MCP server.
 *
 * Read-only. Run: npx tsx scripts/diag-claude-hanging-mcp.ts
 */
import { Agent, tool, run } from '@openai/agents';
import { z } from 'zod';
import { configureHarnessRuntime } from '../src/runtime/harness/codex-client.js';
import { normalizeZodForCodexStrict } from '../src/runtime/schema-normalizer.js';
import { getClaudeBrainModel } from '../src/config.js';

const DecisionSchema = z.object({
  reply: z.string().nullable(), summary: z.string(), done: z.boolean(),
  nextAction: z.enum(['completed', 'awaiting_user_input', 'abandoned']), reason: z.string().nullable(),
});

const sfQuery = tool({
  name: 'sf_data_query', description: 'Query Salesforce via sf CLI.',
  parameters: z.object({ soql: z.string() }),
  async execute() { return JSON.stringify({ records: [{ Name: 'Acme Law' }] }); },
});

// A minimal MCPServer whose connect() / listTools() never resolve — mimics a
// degraded clementine-local/dataforseo that timed out connecting.
const HANG = new Promise<never>(() => { /* never settles */ });
const hangingMcp = {
  name: 'hanging-local',
  cacheToolsList: false,
  async connect() { await HANG; },
  async close() {},
  async listTools() { await HANG; return []; },
  async callTool() { await HANG; return []; },
  invalidateToolsCache() {},
} as unknown;

async function main() {
  console.log(`model=${getClaudeBrainModel()}`);
  const cfg = await configureHarnessRuntime();
  if (!cfg.ok) { console.error(cfg.reason); process.exit(1); }

  const agent = new Agent({
    name: 'DiagOrchestrator',
    instructions: 'Use sf_data_query to pull accounts, then report names.',
    modelSettings: { reasoning: { effort: 'low' as const }, text: { verbosity: 'low' as const } } as never,
    tools: [sfQuery],
    mcpServers: [hangingMcp as never], // ← the hanging server
    outputType: normalizeZodForCodexStrict(DecisionSchema) as typeof DecisionSchema,
  });

  console.log('\n--- streaming with a HANGING mcp server attached ---');
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;
  let firstEvent = 0;
  const result = await run(agent, 'Pull my priority-account accounts.', { stream: true });
  const drain = (async () => {
    for await (const event of result as unknown as AsyncIterable<unknown>) {
      if (!firstEvent) { firstEvent = Date.now() - t0; console.log(`  first event at ${firstEvent}ms`); }
    }
    await result.completed;
  })();
  const watchdog = new Promise((_, rej) => setTimeout(() => rej(new Error('WATCHDOG 40s — no completion')), 40_000));
  try {
    await Promise.race([drain, watchdog]);
    console.log(`\n--- completed in ${el()}; first event ${firstEvent || 'NEVER'}ms ---`);
  } catch (e) {
    console.error(`\n--- ${e instanceof Error ? e.message : e}; first event ${firstEvent || 'NEVER'} (elapsed ${el()}) ---`);
    console.error('VERDICT: a hanging MCP server', firstEvent ? 'did NOT block first byte' : 'BLOCKED the model call pre-content (stall reproduced).');
  }
  process.exit(0);
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
