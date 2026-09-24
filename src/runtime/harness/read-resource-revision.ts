/**
 * Resource revision for a declared reusable read.
 *
 * The same-source settled-read replay (settled-read-repeat.ts) proves that
 * nothing INSIDE the current request changed state between two identical
 * reads. It cannot see another session, a workflow run, an editor or a sync
 * that changed the underlying file, Space, workflow or memory meanwhile. Each
 * declared read therefore records a revision of the resource it read, taken
 * from the filesystem at settlement, and a replay is refused unless the same
 * probe returns the same revision now. The probe is deliberately conservative:
 * any change it can see, however unrelated, forces a fresh physical read;
 * anything it cannot resolve yields null, which also forces a fresh read.
 *
 * Revision sources are resource classes declared on the registry row
 * (`readRevision`), never tool names:
 *   local_path      one file or directory named by the identity argument
 *   workspace_files a Space directory plus the host canonical-entity store
 *   workflow_files  the saved workflow definitions
 *   memory_store    the memory database
 * SQLite stores run in WAL mode, so their revision covers the -wal file too:
 * the main file's mtime does not move until a checkpoint.
 */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { registeredToolReadRevision } from '../../tools/tool-registry.js';

export type ReadRevisionSource = 'local_path' | 'workspace_files' | 'workflow_files' | 'memory_store';

const MAX_DIRECTORY_ENTRIES = 2_000;

function statLine(filePath: string): string | null {
  try {
    const st = statSync(filePath);
    return `${filePath}|${st.isDirectory() ? 'd' : 'f'}|${st.size}|${st.mtimeMs}|${st.ino}`;
  } catch {
    return null;
  }
}

function directoryLines(directory: string, depth: number, lines: string[]): boolean {
  let entries: string[];
  try {
    entries = readdirSync(directory).sort();
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (lines.length >= MAX_DIRECTORY_ENTRIES) return false;
    const full = path.join(directory, entry);
    const line = statLine(full);
    if (!line) return false;
    lines.push(line);
    if (depth > 0 && line.includes('|d|') && !directoryLines(full, depth - 1, lines)) return false;
  }
  return true;
}

function digest(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
}

function expandHome(input: string): string {
  return input === '~' || input.startsWith('~/') ? path.join(os.homedir(), input.slice(1)) : input;
}

function sqliteLines(filePath: string): string[] | null {
  const main = statLine(filePath);
  if (!main) return null;
  const wal = statLine(`${filePath}-wal`);
  return wal ? [main, wal] : [main];
}

function argString(args: unknown, key: string): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function localPathRevision(args: unknown, identityArgument: string | undefined): string | null {
  const raw = identityArgument ? argString(args, identityArgument) : null;
  const target = path.resolve(expandHome(raw ?? process.cwd()));
  const line = statLine(target);
  if (!line) return null;
  const lines = [line];
  if (line.includes('|d|') && !directoryLines(target, 0, lines)) return null;
  return digest(lines);
}

function workspaceFilesRevision(args: unknown): string | null {
  const slug = argString(args, 'slug');
  if (!slug || slug.includes('/') || slug.includes('..')) return null;
  const lines: string[] = [];
  if (!directoryLines(path.join(BASE_DIR, 'spaces', slug), 1, lines) || lines.length === 0) return null;
  const canonical = sqliteLines(path.join(BASE_DIR, 'state', 'canonical-entities', 'canonical-entities.db'));
  if (canonical) lines.push(...canonical);
  return digest(lines);
}

function workflowFilesRevision(): string | null {
  const lines: string[] = [];
  if (!directoryLines(path.join(BASE_DIR, 'vault', '00-System', 'workflows'), 2, lines)) return null;
  return digest(lines);
}

function memoryStoreRevision(): string | null {
  const lines = sqliteLines(path.join(BASE_DIR, 'state', 'memory.db'));
  return lines ? digest(lines) : null;
}

/**
 * The current revision of what `toolName` would read with `args`, or null
 * when the tool declares no revision source or the resource cannot be seen.
 */
export function readResourceRevision(toolName: string, args: unknown): string | null {
  const declared = registeredToolReadRevision(toolName);
  if (!declared) return null;
  try {
    switch (declared.source) {
      case 'local_path': return localPathRevision(args, declared.identityArgument);
      case 'workspace_files': return workspaceFilesRevision(args);
      case 'workflow_files': return workflowFilesRevision();
      case 'memory_store': return memoryStoreRevision();
      default: return null;
    }
  } catch {
    return null;
  }
}
