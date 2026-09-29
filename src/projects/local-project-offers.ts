/**
 * What a linked local project offers to whoever works in it.
 *
 * A folder that people work in with an agent usually says how: instructions
 * written for the agent, commands it names for work it does often, and the
 * tool servers that work expects. They are read from the folder's own files,
 * by the file conventions declared below, so a turn in the project starts
 * knowing they exist instead of finding them by listing directories.
 *
 * Names only. A command's text is read when the work needs it, with the
 * reader every file is read with. A declared tool server's command, arguments
 * and environment are never read out of its file, and declaring a server does
 * not connect it: whether Clem can reach one is what her own connections say.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Files at the top of a folder that hold instructions for an agent. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
/** Folders whose Markdown files are each one named command. */
const COMMAND_FOLDERS = ['.claude/commands'] as const;
/** The file a folder declares its tool servers in, and the key they sit under. */
const TOOL_SERVER_FILE = { file: '.mcp.json', key: 'mcpServers' } as const;

const MOST_COMMANDS = 40;
const MOST_TOOL_SERVERS = 40;
const LARGEST_DECLARATION_BYTES = 256_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface LocalProjectCommand {
  name: string;
  /** Where its text is, relative to the folder. */
  file: string;
}

export interface LocalProjectOffers {
  instructions: string[];
  commands: LocalProjectCommand[];
  /** Declared by the folder. Not a statement that any of them is connected. */
  toolServers: string[];
}

const NOTHING: LocalProjectOffers = Object.freeze({ instructions: [], commands: [], toolServers: [] }) as LocalProjectOffers;

function isFile(target: string): boolean {
  try { return statSync(target).isFile(); } catch { return false; }
}

function commandsIn(folder: string): LocalProjectCommand[] {
  const found: LocalProjectCommand[] = [];
  for (const relative of COMMAND_FOLDERS) {
    let names: string[];
    try { names = readdirSync(path.join(folder, relative)); } catch { continue; }
    for (const entry of names.sort()) {
      if (path.extname(entry).toLowerCase() !== '.md') continue;
      const name = entry.slice(0, -3);
      if (!NAME.test(name) || found.some((row) => row.name === name)) continue;
      if (!isFile(path.join(folder, relative, entry))) continue;
      found.push({ name, file: `${relative}/${entry}` });
      if (found.length >= MOST_COMMANDS) return found;
    }
  }
  return found;
}

function toolServersIn(folder: string): string[] {
  const file = path.join(folder, TOOL_SERVER_FILE.file);
  try {
    if (!isFile(file) || statSync(file).size > LARGEST_DECLARATION_BYTES) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const declared = (parsed as Record<string, unknown>)[TOOL_SERVER_FILE.key];
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return [];
    return Object.keys(declared).filter((name) => NAME.test(name)).sort().slice(0, MOST_TOOL_SERVERS);
  } catch {
    return [];
  }
}

/** Read from the folder each time: what it offers changes when its files do. */
export function localProjectOffers(folder: string | null | undefined): LocalProjectOffers {
  const at = String(folder ?? '').trim();
  if (!at || !path.isAbsolute(at) || !existsSync(at)) return NOTHING;
  return {
    instructions: INSTRUCTION_FILES.filter((name) => isFile(path.join(at, name))),
    commands: commandsIn(at),
    toolServers: toolServersIn(at),
  };
}

/** The lines a project's context carries for one linked local project. */
export function describeLocalProjectOffers(offers: LocalProjectOffers): string[] {
  const lines: string[] = [];
  if (offers.instructions.length > 0) {
    lines.push(`  its own instructions, to read before working in it: ${offers.instructions.join(', ')}`);
  }
  if (offers.commands.length > 0) {
    lines.push(`  commands it names, each a procedure to read and follow when the owner asks for it: ${offers.commands.map((row) => `${row.name} (${row.file})`).join(', ')}`);
  }
  if (offers.toolServers.length > 0) {
    lines.push(`  tool servers it declares: ${offers.toolServers.join(', ')}. Declared is not connected: use your own connection to the same service, and say which one is missing when there is none`);
  }
  return lines;
}
