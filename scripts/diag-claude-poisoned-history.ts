/**
 * Targeted repro: does a continuation from a DEGENERATE turn-3 decision hang
 * the Claude brain on turn 4? (sess-mqg45an3)
 *
 * Reconstructs the failing history:
 *   user:      "pull 25 market-leader accounts not contacted in 15 days (sf CLI)"
 *   assistant: { reply: ",", nextAction: "awaiting_handoff_result", ... }  ← degenerate
 *   user:      "Continue with the next step of your plan."                  ← harness auto-loop
 * then streams the next model call (same orchestrator shape: outputType + tool)
 * with a 90s watchdog, logging every event. If it reproduces, we see a stall.
 *
 * Read-only. Run: npx tsx scripts/diag-claude-poisoned-history.ts
 */
import { Agent, tool, run } from '@openai/agents';
import { z } from 'zod';
import { configureHarnessRuntime } from '../src/runtime/harness/codex-client.js';
import { normalizeZodForCodexStrict } from '../src/runtime/schema-normalizer.js';
import { getActiveAuthMode, getClaudeBrainModel } from '../src/config.js';

const DecisionSchema = z.object({
  reply: z.string().nullable(),
  summary: z.string(),
  done: z.boolean(),
  nextAction: z.enum(['completed', 'awaiting_user_input', 'awaiting_handoff_result', 'abandoned']),
  reason: z.string().nullable(),
});

const sfQuery = tool({
  name: 'sf_data_query',
  description: 'Run a SOQL query against Salesforce via the sf CLI. Returns account records.',
  parameters: z.object({ soql: z.string() }),
  async execute({ soql }) {
    console.log(`  [tool] sf_data_query soql=${JSON.stringify(soql).slice(0, 80)}`);
    return JSON.stringify({ records: [{ Name: 'Acme Law' }, { Name: 'Globex Legal' }] });
  },
});

// The degenerate turn-3 assistant decision, verbatim shape from the DB.
const DEGENERATE_DECISION = JSON.stringify({
  summary: 'Querying Salesforce; for market-leader accounts not contacted in 15+ days',
  reply: ',',
  done: false,
  nextAction: 'awaiting_handoff_result',
  reason: 'Querying Salesforce now that Nate confirmed the criteria.',
});

async function main() {
  console.log(`AUTH_MODE=${getActiveAuthMode()}  model=${getClaudeBrainModel()}`);
  const cfg = await configureHarnessRuntime();
  if (!cfg.ok) { console.error('config failed:', cfg.reason); process.exit(1); }

  const agent = new Agent({
    name: 'DiagOrchestrator',
    instructions:
      'You are a sales assistant. Use the sf_data_query tool to pull Salesforce accounts. ' +
      'Continue the plan: actually call the tool and report the account names.',
    modelSettings: { reasoning: { effort: 'low' as const }, text: { verbosity: 'low' as const } } as never,
    tools: [sfQuery],
    outputType: normalizeZodForCodexStrict(DecisionSchema) as typeof DecisionSchema,
  });

  // Reconstruct the poisoned history as AgentInputItem[].
  const history = [
    { role: 'user', content: 'Pull 25 of my market-leader accounts not contacted in 15 days. Use the sf CLI.' },
    { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: DEGENERATE_DECISION }] },
    { role: 'user', content: 'Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.' },
  ];

  console.log('\n--- streaming continuation from poisoned history ---');
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;
  const result = await run(agent, history as never, { stream: true });

  let eventCount = 0;
  const drain = (async () => {
    for await (const event of result as unknown as AsyncIterable<unknown>) {
      eventCount += 1;
      const ev = event as { type?: string; data?: { type?: string; delta?: string } };
      const d = ev.data?.type ? `/${ev.data.type}` : '';
      const delta = typeof ev.data?.delta === 'string' ? ` delta=${JSON.stringify(ev.data.delta.slice(0, 40))}` : '';
      if (ev.type !== 'raw_model_stream_event' || ev.data?.type !== 'model') {
        console.log(`  [${el()}] #${eventCount} ${ev.type}${d}${delta}`);
      }
    }
    await result.completed;
  })();
  const watchdog = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`WATCHDOG: no completion after 90s (events: ${eventCount})`)), 90_000));

  try {
    await Promise.race([drain, watchdog]);
    console.log(`\n--- completed in ${el()} (events: ${eventCount}) ---`);
    console.log('finalOutput:', JSON.stringify((result as unknown as { finalOutput?: unknown }).finalOutput));
  } catch (err) {
    console.error(`\n--- ${err instanceof Error ? err.message : err} (FAILED in ${el()}) ---`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
