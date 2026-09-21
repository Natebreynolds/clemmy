/**
 * Cheap schema heartbeat. Not a reply brain. It parks proven-tool schemas in
 * memory so turn-start Jev can plate the active brain without a grok catalog
 * chew. Fail-open: a miss leaves discovery unchanged.
 */
import { listVerifiedRunStrategies } from '../../memory/run-strategy-store.js';
import {
  MAX_STAGED_TOOLS,
  writeActiveToolSurface,
  type StagedTool,
} from '../../memory/active-tool-surface.js';
import { composioSlugLooksWellFormed } from '../../integrations/composio/toolkit-slug.js';
import { ensureToolSchema, getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { selectLearnedStrategyTools } from '../harness/host-run-strategy-learning.js';

const WARM_PER_TICK = 6;

function schemaReady(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  try {
    return Boolean(getCachedToolSchema(trimmed) ?? getCachedToolSchema(trimmed.toUpperCase()));
  } catch {
    return false;
  }
}

function collectStrategyToolNames(): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const strategy of listVerifiedRunStrategies()) {
    for (const raw of selectLearnedStrategyTools(strategy.toolsUsed)) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
      if (names.length >= MAX_STAGED_TOOLS) return names;
    }
  }
  return names;
}

export async function tickActiveToolSurfaceHeartbeat(): Promise<{ warmed: number; tools: number }> {
  const names = collectStrategyToolNames();
  let warmed = 0;
  for (const name of names) {
    if (warmed >= WARM_PER_TICK) break;
    if (schemaReady(name)) continue;
    const slug = name.toUpperCase();
    if (!composioSlugLooksWellFormed(slug)) continue;
    try {
      await ensureToolSchema(slug);
      if (schemaReady(name)) warmed += 1;
    } catch { /* heartbeat never throws into the daemon */ }
  }
  const tools: StagedTool[] = names.map((name) => ({
    name,
    schemaReady: schemaReady(name),
    source: 'strategy',
  }));
  writeActiveToolSurface(tools);
  return { warmed, tools: tools.length };
}
