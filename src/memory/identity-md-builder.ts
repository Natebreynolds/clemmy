/**
 * Auto-generated "Working with" + "Learned about you" sections for
 * IDENTITY.md.
 *
 * Background: IDENTITY.md ships with a seeded default explaining who
 * Clementine is (set by init-home.ts on first install). What's missing
 * is the OTHER half of the relationship — who Clementine is working
 * WITH, and what she has learned about them since. The user_profile
 * captures name, role, timezone, communication preferences; the facts
 * store accumulates durable kind:'user' preferences from every
 * conversation. Neither was visible in this file, so for users who
 * never opened Settings, IDENTITY.md stayed byte-identical to the
 * install seed forever.
 *
 * Two-section design mirrors memory-md-builder.ts:
 *
 *   # Identity
 *   <user-curated content — Clementine's self-concept>
 *
 *   <!-- AUTO-GENERATED · do not edit below this line — overwritten on next refresh -->
 *
 *   ## Working with
 *   - Name: Alex Chen (preferred: Alex)
 *   - ...
 *
 *   ## Learned about you
 *   - Prefers async updates over meetings
 *   - ...
 *
 * The learned section is a file/UI projection only: vault.ts injects
 * just the user-curated half into prompts, and these same facts already
 * reach the prompt through fact recall — rendering them here must not
 * create a second prompt channel.
 *
 * Same refresh tick as MEMORY.md (every ~30min). No-op when content
 * unchanged. Atomic write via tmp + rename.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';
import { IDENTITY_FILE } from './vault.js';
import { listActiveFacts, type ConsolidatedFact } from './facts.js';
import { loadUserProfile, type UserProfile } from '../runtime/user-profile.js';

const logger = pino({ name: 'clementine-next.memory.identity-builder' });

const AUTO_MARKER = '<!-- AUTO-GENERATED · do not edit below this line — overwritten on next refresh -->';

/** Trim a value to a single-line, cap at 200 chars so unusual notes
 *  fields don't blow up the auto section. */
function compact(value: string | undefined, max = 200): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function splitAtMarker(existing: string): { userPart: string; hadMarker: boolean } {
  const idx = existing.indexOf(AUTO_MARKER);
  if (idx === -1) return { userPart: existing.replace(/\s+$/, ''), hadMarker: false };
  return { userPart: existing.slice(0, idx).replace(/\s+$/, ''), hadMarker: true };
}

function formatWorkingDays(days?: string[]): string | undefined {
  if (!days || days.length === 0) return undefined;
  if (days.length === 7) return 'every day';
  // Common patterns we recognize so the rendered line is human-friendly
  // instead of just listing 5 abbreviations every render.
  const lower = new Set(days.map((d) => d.toLowerCase().slice(0, 3)));
  const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const weekendsToo = [...weekdays, 'sat', 'sun'];
  if (weekdays.every((d) => lower.has(d)) && lower.size === 5) return 'weekdays (Mon–Fri)';
  if (weekendsToo.every((d) => lower.has(d))) return 'every day';
  return days.join(', ');
}

function formatWorkingHours(start?: string, end?: string): string | undefined {
  if (!start && !end) return undefined;
  if (start && end) return `${start}–${end}`;
  return start ?? end;
}

/** Max learned bullets rendered — the section is a highlight reel, not
 *  a fact-store dump; the full store stays browsable in the Memory UI. */
const LEARNED_MAX_ROWS = 10;
/** A fresh unpinned, never-used fact must survive this long before it
 *  counts as durable — gives the hygiene/correction loops a window to
 *  kill mis-captures before they show up in IDENTITY.md. */
const LEARNED_MIN_AGE_MS = 72 * 60 * 60 * 1000;

/** True when a fact has earned a place in the identity file: the user
 *  pinned it, recall actually used it, or it survived the capture-
 *  hygiene window without being superseded or deactivated. Exported as
 *  the shared durability contract for identity-evolution's evidence
 *  selection. */
export function isDurableUserFact(fact: ConsolidatedFact, nowMs: number): boolean {
  if (fact.pinned) return true;
  if ((fact.utilityCount ?? 0) > 0) return true;
  const createdMs = Date.parse(fact.createdAt);
  return Number.isFinite(createdMs) && nowMs - createdMs >= LEARNED_MIN_AGE_MS;
}

/** Durable kind:'user' facts, Stanford-ranked so importance + recency
 *  pick the visible rows. DB errors degrade to an empty list — a facts
 *  hiccup must never block the profile half of the refresh. */
function selectDurableUserFacts(now: Date): ConsolidatedFact[] {
  try {
    return listActiveFacts({ kind: 'user', ranking: 'stanford', limit: 40 })
      .filter((fact) => isDurableUserFact(fact, now.getTime()))
      .slice(0, LEARNED_MAX_ROWS);
  } catch (err) {
    logger.warn({ err }, 'learned-section fact query failed; rendering without it');
    return [];
  }
}

function renderLearnedRows(facts: ConsolidatedFact[]): string[] {
  const rows: string[] = [];
  for (const fact of facts) {
    // auto-capture stamps a routing prefix on captured preferences;
    // it's noise in a human-readable identity file.
    const body = compact(fact.content.replace(/^User preference:\s*/i, ''));
    if (body) rows.push(`- ${body}`);
  }
  return rows;
}

/**
 * Render the auto section body (without the marker — caller adds it).
 * Returns null when neither the profile nor the facts store has
 * anything worth emitting so we don't write a meaningless block.
 * "Worth emitting" means at least one profile field BEYOND the seeded
 * defaults — displayName=='the user' alone doesn't count, and the
 * default communication tone/formality/urgency settings shouldn't
 * trigger an emit either (those are present on every fresh install) —
 * or at least one durable learned fact about the user.
 */
function renderAutoSection(profile: UserProfile, now: Date): string | null {
  // Gate: several profile fields have non-empty DEFAULTS on every
  // fresh install (tone='balanced', formality='professional',
  // urgencyTolerance='normal', workingDays=Mon..Fri), so they DON'T
  // count toward the gate — otherwise we'd auto-write the section
  // for users who haven't filled in any actual identity info.
  const hasIdentityField = Boolean(
    formatName(profile)
    || compact(profile.role)
    || compact(profile.timezone)
    || compact(profile.notes)
    || profile.workingHoursStart
    || profile.workingHoursEnd
    || (profile.preferredChannels && profile.preferredChannels.length > 0)
  );
  const learnedRows = renderLearnedRows(selectDurableUserFacts(now));
  if (!hasIdentityField && learnedRows.length === 0) return null;

  const lines: string[] = [
    '',
    `_Auto-regenerated ${now.toISOString()} from your profile and confirmed memory · edit your profile in Settings or curate facts in Memory._`,
    '_The user-curated section above is preserved verbatim._',
  ];

  if (hasIdentityField) {
    lines.push('', '## Working with');
    // Order: identity → timing → style. Each row is "- **Label:** value"
    // and we omit rows whose value is undefined/empty rather than printing
    // a noisy "- Field: (not set)" line.
    const rows: Array<[string, string | undefined]> = [
      ['Name', formatName(profile)],
      ['Role', compact(profile.role)],
      ['Timezone', compact(profile.timezone)],
      ['Working days', formatWorkingDays(profile.workingDays)],
      ['Working hours', formatWorkingHours(profile.workingHoursStart, profile.workingHoursEnd)],
      ['Communication tone', compact(profile.communicationTone)],
      ['Formality', compact(profile.formality)],
      ['Urgency tolerance', compact(profile.urgencyTolerance)],
      ['Preferred channels', profile.preferredChannels && profile.preferredChannels.length > 0
        ? profile.preferredChannels.join(', ')
        : undefined],
      ['Notes', compact(profile.notes, 400)],
    ];
    for (const [label, value] of rows) {
      if (value && value !== 'the user') lines.push(`- **${label}:** ${value}`);
    }
  }

  if (learnedRows.length > 0) {
    lines.push('', '## Learned about you', ...learnedRows);
  }
  lines.push('');

  return lines.join('\n');
}

function formatName(profile: UserProfile): string | undefined {
  const display = compact(profile.displayName);
  const preferred = compact(profile.preferredName);
  const realDisplay = display && display !== 'the user' ? display : undefined;
  // No usable name at all.
  if (!realDisplay && !preferred) return undefined;
  // Both set + distinct — show both for completeness.
  if (realDisplay && preferred && realDisplay !== preferred) {
    return `${realDisplay} (preferred: ${preferred})`;
  }
  // Otherwise show whichever real value we have. Preferred wins so
  // "Alex" beats a longer formal display name when both are real.
  return preferred ?? realDisplay;
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

export interface RegenerateIdentityMdResult {
  written: boolean;
  reason?: 'unchanged' | 'no-profile' | 'first-write' | 'updated';
  hadMarker: boolean;
  autoSectionChars: number;
}

export function regenerateIdentityMd(): RegenerateIdentityMdResult {
  const profile = loadUserProfile();
  const existing = existsSync(IDENTITY_FILE) ? readFileSync(IDENTITY_FILE, 'utf-8') : '# Identity\n\n';
  const { userPart, hadMarker } = splitAtMarker(existing);

  const autoBody = renderAutoSection(profile, new Date());
  // Neither the profile nor the facts store has anything useful — keep
  // whatever's on disk (likely just the seeded default). Don't write a
  // marker + empty body. Reason keeps its historical name.
  if (autoBody === null) {
    return { written: false, reason: 'no-profile', hadMarker, autoSectionChars: 0 };
  }

  const userTrimmed = userPart.trim();
  const userBlock = userTrimmed.length > 0 ? userTrimmed + '\n\n' : '# Identity\n\n';
  const next = `${userBlock}${AUTO_MARKER}\n${autoBody}`;

  // The auto-section header includes a regen timestamp so users can see
  // when it was last refreshed. That timestamp would otherwise turn
  // every call into a "write" since it differs per call. Strip the
  // timestamp line from BOTH sides before comparing so semantic-no-op
  // calls really no-op.
  const normalizeForDiff = (s: string) => s.replace(/_Auto-regenerated [^_]+_/g, '_Auto-regenerated <ts>_');
  if (normalizeForDiff(next) === normalizeForDiff(existing)) {
    return { written: false, reason: 'unchanged', hadMarker, autoSectionChars: autoBody.length };
  }
  atomicWrite(IDENTITY_FILE, next);
  return {
    written: true,
    reason: hadMarker ? 'updated' : 'first-write',
    hadMarker,
    autoSectionChars: autoBody.length,
  };
}

/** Maintenance-tick entry point. Logs only on actual writes. */
export function tickIdentityMdRefresh(): void {
  try {
    const result = regenerateIdentityMd();
    if (result.written) {
      logger.info({ result }, 'IDENTITY.md refreshed');
    }
  } catch (err) {
    logger.warn({ err }, 'IDENTITY.md refresh failed');
  }
}
