/**
 * Staged tool surface: schemas the heartbeat has parked in memory so Jev can
 * plate this turn instead of grok chewing the whole catalog.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export interface StagedTool {
  name: string;
  schemaReady: boolean;
  source: 'strategy' | 'cache';
}

export interface ActiveToolSurface {
  version: 1;
  updatedAt: string;
  tools: StagedTool[];
}

const STORE_FILE = path.join(BASE_DIR, 'state', 'active-tool-surface.json');
export const MAX_STAGED_TOOLS = 24;

export function readActiveToolSurface(): ActiveToolSurface {
  if (!existsSync(STORE_FILE)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), tools: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as ActiveToolSurface;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tools)) {
      return { version: 1, updatedAt: new Date(0).toISOString(), tools: [] };
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      tools: parsed.tools
        .filter((row) => row && typeof row.name === 'string' && row.name.trim())
        .slice(0, MAX_STAGED_TOOLS)
        .map((row) => ({
          name: row.name.trim(),
          schemaReady: row.schemaReady === true,
          source: row.source === 'cache' ? 'cache' : 'strategy',
        })),
    };
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), tools: [] };
  }
}

export function writeActiveToolSurface(tools: readonly StagedTool[]): ActiveToolSurface {
  const surface: ActiveToolSurface = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tools: [...tools].slice(0, MAX_STAGED_TOOLS),
  };
  const dir = path.dirname(STORE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(surface, null, 2), 'utf8');
  renameSync(tmp, STORE_FILE);
  return surface;
}
