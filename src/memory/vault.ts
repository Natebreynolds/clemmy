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

function readCuratedVaultFileMaybe(filePath: string, maxChars: number, heading: string): string | undefined {
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
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const meaningful = curated.replace(new RegExp(`^#\\s+${escapedHeading}\\s*`, 'i'), '').trim();
    if (!meaningful) return undefined;
    if (curated.length <= maxChars) return curated;

    const clipNotice = `\n\n_[Curated ${heading.toUpperCase()}.md clipped; full text remains in the vault.]_`;
    const contentBudget = Math.max(0, maxChars - clipNotice.length);
    return `${curated.slice(0, contentBudget).trimEnd()}${clipNotice}`;
  } catch {
    return undefined;
  }
}

export function readVaultFile(filePath: string, maxChars = 12000): string | undefined {
  return readMaybe(filePath, maxChars);
}

export interface CuratedMemorySplit {
  /** User-curated content above the marker (marker stripped, trailing whitespace trimmed). */
  curated: string;
  /** Auto-generated section INCLUDING the marker line, verbatim, or '' if none present. */
  autoSection: string;
  hadMarker: boolean;
}

/** Split MEMORY.md into its user-curated prefix and the auto-generated fact
 *  projection below the marker. Mirrors the split logic in memory-md-builder.ts
 *  and readCuratedMemoryMaybe, but returns the full (unclipped) curated text and
 *  preserves the auto section verbatim so callers can round-trip it. Tolerates
 *  older/future marker wording that retains the AUTO-GENERATED prefix. */
export function splitCuratedMemory(raw: string): CuratedMemorySplit {
  const exactIdx = raw.indexOf(MEMORY_AUTO_SECTION_MARKER);
  const idx = exactIdx >= 0 ? exactIdx : raw.indexOf('<!-- AUTO-GENERATED');
  if (idx === -1) {
    return { curated: raw.replace(/\s+$/, ''), autoSection: '', hadMarker: false };
  }
  return {
    curated: raw.slice(0, idx).replace(/\s+$/, ''),
    autoSection: raw.slice(idx).replace(/\s+$/, ''),
    hadMarker: true,
  };
}

/** Recompose MEMORY.md from newly-edited curated content, preserving the
 *  existing auto-generated projection below the marker. The console editor only
 *  ever sends the curated portion (the read path returns curated-only), so a
 *  plain overwrite would drop the auto section until the next maintenance tick;
 *  preserving it verbatim keeps the file whole in the meantime. */
export function composeCuratedMemory(curated: string, existingRaw: string): string {
  const { autoSection } = splitCuratedMemory(existingRaw);
  // Guard against a marker embedded in the user-supplied curated text: if the
  // saved content itself contains the AUTO-GENERATED marker (e.g. the user
  // pasted it), the NEXT split would treat everything after their pasted marker
  // as the auto section and silently drop it on the next regeneration. Neutralize
  // any marker in the curated portion so exactly one canonical marker remains.
  const sanitizedCurated = sanitizeCuratedMemory(curated);
  const curatedTrimmed = sanitizedCurated.replace(/\s+$/, '');
  if (!autoSection) {
    return curatedTrimmed ? `${curatedTrimmed}\n` : '';
  }
  return `${curatedTrimmed}\n\n${autoSection}\n`;
}

/** Remove any AUTO-GENERATED marker comment from user-curated text so it can't
 *  be mistaken for the section separator. Strips the exact marker and any
 *  compatible `<!-- AUTO-GENERATED ... -->` comment line. */
export function sanitizeCuratedMemory(curated: string): string {
  // Remove the marker COMMENT wherever it appears while preserving surrounding
  // user text. Restrict the pattern to the AUTO-GENERATED comment itself; a
  // broad split at the token would silently discard everything after an inline
  // or multiline pasted marker.
  return curated.replace(/<!--\s*AUTO-GENERATED\b[\s\S]*?-->/gi, '');
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
    memory: readCuratedVaultFileMaybe(MEMORY_FILE, MEMORY_PROMPT_READ_CHARS, 'Memory'),
    // IDENTITY.md has the same two-part contract as MEMORY.md. The generated
    // "Working with" projection duplicates the canonical user-profile block;
    // inject only the user-curated identity so prompts do not carry two truths.
    identity: readCuratedVaultFileMaybe(IDENTITY_FILE, 4000, 'Identity'),
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
