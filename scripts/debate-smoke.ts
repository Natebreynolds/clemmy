/**
 * Live end-to-end smoke for the FUSION debate layer (Seam A).
 *
 * Forces CLEMMY_DEBATE_MODE=all so EVERY turn is debated: Claude + Codex draft
 * the same turn in parallel, a judge reconciles, and the reconciled answer
 * streams back. Drives the real @openai/agents Runner exactly like loop.ts and
 * prints every stream event with elapsed ms, so we can SEE:
 *   - exactly one response_started (ours; the judge's is dropped),
 *   - keep-alive frames reaching the run-loop drain DURING the silent drafting
 *     window (proves the stall-watchdog is actually fed),
 *   - the judge's output_text_delta stream as the final answer,
 *   - a clean response_done + a parsed finalOutput,
 *   - no stall, no error.
 *
 * Runs TWO turns: a plain-text turn (isolates streaming mechanics) and a
 * structured-output turn (the orchestrator shape — proves the judge satisfies
 * agent.outputType). Real paired API calls — ~6 model calls total. Read-only.
 *
 * Run: npx tsx scripts/debate-smoke.ts
 */
process.env.CLEMMY_DEBATE_MODE = process.env.CLEMMY_DEBATE_MODE || 'all';
process.env.CLEMMY_DEBATE_HEARTBEAT_MS = process.env.CLEMMY_DEBATE_HEARTBEAT_MS || '1500';

import { Agent, run } from '@openai/agents';
import { z } from 'zod';
import { configureHarnessRuntime } from '../src/runtime/harness/codex-client.js';
import { normalizeZodForCodexStrict } from '../src/runtime/schema-normalizer.js';
import { getActiveAuthMode, getClaudeBrainModel } from '../src/config.js';
import { debateMode, judgeChoice, debateBrainsAvailable } from '../src/runtime/harness/debate-model.js';

const DecisionSchema = z.object({
  reply: z.string().nullable().describe('Natural-language message to show the user this turn.'),
  summary: z.string().describe('One-line internal summary of what happened.'),
  done: z.boolean().describe('Whether the user request is fully handled.'),
  nextAction: z.enum(['completed', 'awaiting_user_input', 'abandoned']),
  reason: z.string().nullable(),
});

async function driveTurn(label: string, agent: Agent, input: string) {
  console.log(`\n========== ${label} ==========`);
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;
  const result = await run(agent, input, { stream: true });

  let eventCount = 0;
  let keepalives = 0;
  let firstContentAt = -1;
  let lastEventAt = Date.now();
  const drain = (async () => {
    for await (const event of result as unknown as AsyncIterable<unknown>) {
      eventCount += 1;
      lastEventAt = Date.now();
      const ev = event as { type?: string; data?: { type?: string; delta?: string; event?: { type?: string } } };
      const inner = ev.data?.type ?? '';
      const innerEvt = ev.data?.event?.type ?? '';
      const isKeepalive = innerEvt === 'debate.keepalive' || inner === 'debate.keepalive';
      if (isKeepalive) keepalives += 1;
      const isContent = ev.type === 'raw_model_stream_event' && ev.data?.type === 'output_text_delta';
      if (isContent && firstContentAt < 0) firstContentAt = Date.now() - t0;
      const delta = typeof ev.data?.delta === 'string' ? ` delta=${JSON.stringify(ev.data.delta.slice(0, 32))}` : '';
      const tag = isKeepalive ? '  <<KEEPALIVE>>' : '';
      // Print keepalives + structural frames; sample text deltas to keep it readable.
      if (isKeepalive || ev.type !== 'raw_model_stream_event' || inner !== 'output_text_delta' || eventCount % 12 === 0) {
        console.log(`  [${el()}] #${eventCount} ${ev.type}${inner ? '/' + inner : ''}${innerEvt ? ':' + innerEvt : ''}${delta}${tag}`);
      }
    }
    await result.completed;
  })();

  // Mirror the real loop's pre-content watchdog window (75s) so a true stall surfaces.
  const watchdog = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`WATCHDOG: stalled ${Math.round((Date.now() - lastEventAt) / 1000)}s (events: ${eventCount})`)), 90_000),
  );

  try {
    await Promise.race([drain, watchdog]);
    const out = (result as unknown as { finalOutput?: unknown }).finalOutput;
    console.log(`  --- completed in ${el()} | events=${eventCount} keepalives=${keepalives} firstContent@${firstContentAt}ms ---`);
    console.log('  finalOutput:', typeof out === 'string' ? JSON.stringify(out.slice(0, 400)) : JSON.stringify(out, null, 2)?.slice(0, 600));
    return { ok: true, keepalives, firstContentAt, eventCount };
  } catch (err) {
    console.error(`  --- FAILED in ${el()} | events=${eventCount} keepalives=${keepalives} ---`);
    console.error('  ', err instanceof Error ? `${err.name}: ${err.message}` : err);
    if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
    return { ok: false, keepalives, firstContentAt, eventCount };
  }
}

async function main() {
  console.log(`AUTH_MODE=${getActiveAuthMode()}  claudeModel=${getClaudeBrainModel()}  debateMode=${debateMode()}  judge=${judgeChoice()}`);
  const brains = debateBrainsAvailable();
  console.log(`brains available: claude=${brains.claude} codex=${brains.codex}`);
  if (!brains.claude || !brains.codex) {
    console.error(`\nCannot test debate: it needs BOTH flagships logged in (claude=${brains.claude}, codex=${brains.codex}).`);
    console.error('Log in the missing brain, then re-run. (Codex: `clementine auth login-native`; Claude: the subscription OAuth flow.)');
    process.exit(2);
  }
  const cfg = await configureHarnessRuntime();
  if (!cfg.ok) {
    console.error('configureHarnessRuntime failed:', cfg.reason);
    process.exit(1);
  }

  // Turn 1 — plain text. Isolates the debate streaming mechanics.
  const plain = new Agent({
    name: 'DebateSmokePlain',
    instructions: 'You are a concise assistant. Answer in 2-3 sentences.',
  });
  const r1 = await driveTurn('TURN 1 — plain text (debate)', plain,
    'In one short paragraph, what is the single biggest risk of using two LLMs in a debate to answer one question, and how would you mitigate it?');

  // Turn 2 — structured output (the orchestrator shape). Proves the judge
  // satisfies agent.outputType end-to-end.
  const structured = new Agent({
    name: 'DebateSmokeStructured',
    instructions: 'You are a helpful assistant. Answer the user, then fill the decision fields honestly.',
    modelSettings: { reasoning: { effort: 'low' as const }, text: { verbosity: 'low' as const } } as never,
    outputType: normalizeZodForCodexStrict(DecisionSchema) as typeof DecisionSchema,
  });
  const r2 = await driveTurn('TURN 2 — structured output (debate)', structured,
    'What are the three primary colors? Set done=true and nextAction=completed.');

  console.log('\n================ SMOKE SUMMARY ================');
  console.log('Turn 1 (plain):     ', JSON.stringify(r1));
  console.log('Turn 2 (structured):', JSON.stringify(r2));
  const verdict =
    r1.ok && r2.ok && r1.keepalives >= 1
      ? 'PASS — debate streamed both turns; keep-alives reached the drain (watchdog is fed).'
      : r1.ok && r2.ok
      ? 'PARTIAL — both turns completed but NO keep-alive frames reached the drain; the heartbeat shape may be dropped by the Runner (needs a different keep-alive frame).'
      : 'FAIL — see errors above.';
  console.log(verdict);
  process.exit(r1.ok && r2.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
