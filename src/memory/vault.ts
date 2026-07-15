import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { MemoryContext } from '../types.js';

export const VAULT_DIR = path.join(BASE_DIR, 'vault');
export const SYSTEM_DIR = path.join(VAULT_DIR, '00-System');
export const DAILY_NOTES_DIR = path.join(VAULT_DIR, '01-Daily-Notes');
export const PEOPLE_DIR = path.join(VAULT_DIR, '02-People');
export const PROJECTS_DIR = path.join(VAULT_DIR, '03-Projects');
export const TOPICS_DIR = path.join(VAULT_DIR, '04-Topics');
export const TASKS_DIR = path.join(VAULT_DIR, '05-Tasks');
export const INBOX_DIR = path.join(VAULT_DIR, '07-Inbox');
export const SOUL_FILE = path.join(SYSTEM_DIR, 'SOUL.md');
export const MEMORY_FILE = path.join(SYSTEM_DIR, 'MEMORY.md');
export const IDENTITY_FILE = path.join(SYSTEM_DIR, 'IDENTITY.md');
export const CRON_FILE = path.join(SYSTEM_DIR, 'CRON.md');
export const WORKFLOWS_DIR = path.join(SYSTEM_DIR, 'workflows');
export const WORKING_MEMORY_FILE = path.join(BASE_DIR, 'working-memory.md');

/** Stable separator shared with memory-md-builder.ts. Content below this marker
 *  is a human-readable projection of consolidated_facts, not a second source of
 *  prompt truth. Keep the exact marker stable so existing vaults continue to
 *  split correctly after upgrades. */
export const MEMORY_AUTO_SECTION_MARKER = '<!-- AUTO-GENERATED · do not edit below this line — overwritten on next refresh -->';

/** Char budget for USER-CURATED MEMORY.md content injected every turn. The
 *  generated section is intentionally excluded: renderFactsForInstructions is
 *  the canonical, typed policy/fact carrier and query recall supplies archival
 *  detail on demand. */
export const MEMORY_PROMPT_READ_CHARS = 1600;

function readMaybe(filePath: string, maxChars = 4000): string | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return readFileSync(filePath, 'utf-8').trim().slice(0, maxChars);
  } catch {
    return undefined;
  }
}

function readCuratedMemoryMaybe(filePath: string, maxChars: number): string | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    // Match the stable marker exactly first, then tolerate older/future marker
    // wording that retains the AUTO-GENERATED prefix.
    const exactMarkerIndex = raw.indexOf(MEMORY_AUTO_SECTION_MARKER);
    const compatibleMarkerIndex = exactMarkerIndex >= 0
      ? exactMarkerIndex
      : raw.indexOf('<!-- AUTO-GENERATED');
    const curated = raw.slice(0, compatibleMarkerIndex >= 0 ? compatibleMarkerIndex : raw.length).trim();
    // A scaffold-only heading carries no memory and should not consume a prompt
    // section. Any content beneath it remains eligible for injection.
    const meaningful = curated.replace(/^#\s+Memory\s*/i, '').trim();
    if (!meaningful) return undefined;
    if (curated.length <= maxChars) return curated;

    const clipNotice = '\n\n_[Curated MEMORY.md clipped; full text remains in the vault.]_';
    const contentBudget = Math.max(0, maxChars - clipNotice.length);
    return `${curated.slice(0, contentBudget).trimEnd()}${clipNotice}`;
  } catch {
    return undefined;
  }
}

export function readVaultFile(filePath: string, maxChars = 12000): string | undefined {
  return readMaybe(filePath, maxChars);
}

export function ensureVaultScaffold(): void {
  if (!existsSync(SYSTEM_DIR)) {
    mkdirSync(SYSTEM_DIR, { recursive: true });
  }
  for (const dir of [DAILY_NOTES_DIR, PEOPLE_DIR, PROJECTS_DIR, TOPICS_DIR, TASKS_DIR, INBOX_DIR, WORKFLOWS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function loadMemoryContext(): MemoryContext {
  ensureVaultScaffold();
  return {
    soul: readMaybe(SOUL_FILE),
    memory: readCuratedMemoryMaybe(MEMORY_FILE, MEMORY_PROMPT_READ_CHARS),
    identity: readMaybe(IDENTITY_FILE),
    workingMemory: readMaybe(WORKING_MEMORY_FILE, 3000),
  };
}

export function todayNotePath(): string {
  ensureVaultScaffold();
  const date = new Date().toISOString().slice(0, 10);
  return path.join(DAILY_NOTES_DIR, `${date}.md`);
}

export function ensureTodayNote(): string {
  const notePath = todayNotePath();
  if (!existsSync(notePath)) {
    writeFileSync(notePath, `# ${path.basename(notePath, '.md')}\n\n## Notes\n\n`, 'utf-8');
  }
  return notePath;
}

export function folderForNoteType(noteType: 'person' | 'project' | 'topic' | 'task' | 'inbox'): string {
  switch (noteType) {
    case 'person': return PEOPLE_DIR;
    case 'project': return PROJECTS_DIR;
    case 'topic': return TOPICS_DIR;
    case 'task': return TASKS_DIR;
    case 'inbox': return INBOX_DIR;
  }
}
