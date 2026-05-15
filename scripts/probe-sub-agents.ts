/**
 * Run: npx tsx scripts/probe-sub-agents.ts
 *
 * Prints each sub-agent's tool surface so we can confirm
 * composio_execute_tool is OUT and cx_* are IN where they should be.
 */
import {
  buildResearcherAgent,
  buildExecutorAgent,
  buildWriterAgent,
  buildReviewerAgent,
  buildDeployerAgent,
} from '../src/agents/sub-agents.js';

async function main() {
  const agents = await Promise.all([
    buildResearcherAgent(),
    buildExecutorAgent(),
    buildWriterAgent(),
    buildReviewerAgent(),
    buildDeployerAgent(),
  ]);
  for (const a of agents) {
    const tools = (a as unknown as { tools?: Array<{ name?: string }> }).tools ?? [];
    const names = tools.map((t) => t.name || '<unnamed>');
    const composio = names.filter((n) => n.startsWith('composio_'));
    const cx = names.filter((n) => n.startsWith('cx_'));
    console.log(`${a.name}: ${names.length} tools — composio: [${composio.join(', ')}], cx_*: ${cx.length}`);
    if (names.includes('composio_execute_tool')) {
      console.log(`  ⚠ ${a.name} STILL HAS composio_execute_tool`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
