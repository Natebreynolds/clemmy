/**
 * Diagnostic repro for the Claude-brain tool-turn hang.
 *
 * Mirrors the production orchestrator shape from the tool-turn hang regression:
 *   - Claude OAuth brain (AUTH_MODE=claude_oauth)
 *   - outputType = a Codex-strict-normalized zod object (structured output)
 *   - modelSettings { reasoning.effort, text.verbosity }  (the OpenAI-isms the
 *     orchestrator seeds at construction)
 *   - one tool available, and an input that FORCES a tool call
 *   - streamed run, draining events exactly like loop.ts
 *
 * It prints every stream event as it arrives, with elapsed ms, and a 70s
 * watchdog. If it reproduces, we'll see a fragment then silence (the hang);
 * if Anthropic rejects the request, we'll see the actual error instead of the
 * silent 300s stall the production watchdog masked.
 *
 * Read-only: the tool returns canned data; no external writes.
 *
 * Run: npx tsx scripts/diag-claude-toolturn.ts
 */
import { Agent, tool, run } from '@openai/agents';
import { z } from 'zod';
import { configureHarnessRuntime } from '../src/runtime/harness/codex-client.js';
import { normalizeZodForCodexStrict } from '../src/runtime/schema-normalizer.js';
import { getActiveAuthMode, getClaudeBrainModel } from '../src/config.js';
import { getOrCreateExternalMcpServers } from '../src/runtime/mcp-servers.js';

const ATTACH_MCP = process.env.DIAG_ATTACH_MCP === '1';

const DecisionSchema = z.object({
  reply: z.string().nullable().describe('Natural-language message to show the user this turn.'),
  summary: z.string().describe('One-line internal summary of what happened.'),
  done: z.boolean().describe('Whether the user request is fully handled.'),
  nextAction: z.enum(['completed', 'awaiting_user_input', 'abandoned']),
  reason: z.string().nullable(),
});

const searchSalesforce = tool({
  name: 'search_salesforce',
  description: 'Query Salesforce for accounts. Returns matching account records.',
  parameters: z.object({
    soql: z.string().describe('SOQL query to run'),
  }),
  async execute({ soql }) {
    console.log(`  [tool] search_salesforce called with soql=${JSON.stringify(soql)}`);
    return JSON.stringify({
      records: [
        { Name: 'Acme Law', Id: '001A' },
        { Name: 'Globex Legal', Id: '001B' },
      ],
    });
  },
});

async function main() {
  console.log(`AUTH_MODE=${getActiveAuthMode()}  model=${getClaudeBrainModel()}`);
  const cfg = await configureHarnessRuntime();
  if (!cfg.ok) {
    console.error('configureHarnessRuntime failed:', cfg.reason);
    process.exit(1);
  }

  const agent = new Agent({
    name: 'DiagOrchestrator',
    model: getClaudeBrainModel(),
    instructions:
      'You are a sales assistant with NO prior knowledge of any Salesforce data. You do not know ' +
      'any account names, ids, or records. The ONLY way to obtain them is to call search_salesforce. ' +
      'You MUST call search_salesforce and then put the EXACT account Names it returns into your ' +
      'reply. Never set done=true or nextAction=awaiting_user_input until you have called the tool ' +
      'and have the real names. Do not ask the user anything — just call the tool and report results.',
    // Seed modelSettings at construction exactly like the orchestrator does.
    modelSettings: { reasoning: { effort: 'low' as const }, text: { verbosity: 'low' as const } } as never,
    tools: [searchSalesforce],
    // Mirror production: attach the real external MCP servers (incl. the cold-npx
    // dataforseo stdio server flagged "connecting" in the failed turn).
    ...(ATTACH_MCP ? { mcpServers: [getOrCreateExternalMcpServers()] } : {}),
    outputType: normalizeZodForCodexStrict(DecisionSchema) as typeof DecisionSchema,
  });
  console.log(`ATTACH_MCP=${ATTACH_MCP}`);

  const input = 'List the exact Names of my priority-account accounts with no open opportunities. Call the tool, then report the names you get back.';
  console.log(`\n--- streaming run (forces a tool call) ---`);
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;

  const result = await run(agent, input, { stream: true });

  let eventCount = 0;
  const drain = (async () => {
    for await (const event of result as unknown as AsyncIterable<unknown>) {
      eventCount += 1;
      const ev = event as { type?: string; data?: { type?: string; delta?: string } };
      const detail = ev.data?.type ? `/${ev.data.type}` : '';
      const delta = typeof ev.data?.delta === 'string' ? ` delta=${JSON.stringify(ev.data.delta.slice(0, 40))}` : '';
      console.log(`  [${el()}] #${eventCount} ${ev.type}${detail}${delta}`);
    }
    await result.completed;
  })();

  const watchdog = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`WATCHDOG: no completion after 70s (events seen: ${eventCount})`)), 70_000),
  );

  try {
    await Promise.race([drain, watchdog]);
    console.log(`\n--- completed in ${el()} ---`);
    console.log('finalOutput:', JSON.stringify((result as unknown as { finalOutput?: unknown }).finalOutput, null, 2));
  } catch (err) {
    console.error(`\n--- FAILED in ${el()} ---`);
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
