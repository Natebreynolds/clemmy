import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, getRuntimeEnv } from '../config.js';

/**
 * Per-user agent persona/preferences.
 *
 * Distinct from:
 *   - OWNER_NAME (config) — just a display name from env
 *   - TeamAgentRecord.personality — the agent's own voice
 *   - consolidated_facts of kind 'user' — durable facts about the
 *     person, learned over time
 *
 * UserProfile is what the user EXPLICITLY tells the agent about how
 * they want to be treated. Settable from chat ("call me Alex, not
 * by my last name"), from the dashboard, or from the setup wizard.
 * The agent reads it on every cycle and adapts tone, urgency
 * tolerance, channel preferences, etc.
 *
 * Storage: single JSON file at ~/.clementine-next/state/user-profile.json
 * Atomic writes via tmp+rename, same pattern as proactivity-policy.
 */

export type CommunicationTone = 'terse' | 'balanced' | 'verbose';
export type FormalityLevel = 'casual' | 'professional' | 'formal';
export type UrgencyTolerance = 'low' | 'normal' | 'high';

export interface UserProfile {
  displayName: string;
  preferredName?: string;
  role?: string;
  timezone?: string;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  workingDays?: string[];
  communicationTone: CommunicationTone;
  formality: FormalityLevel;
  urgencyTolerance: UrgencyTolerance;
  preferredChannels?: string[];
  notes?: string;
  updatedAt: string;
}

type RawProfile = Partial<Record<keyof UserProfile, unknown>>;

const PROFILE_FILE = path.join(BASE_DIR, 'state', 'user-profile.json');

export const DEFAULT_USER_PROFILE: UserProfile = {
  displayName: 'the user',
  communicationTone: 'balanced',
  formality: 'professional',
  urgencyTolerance: 'normal',
  workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  updatedAt: new Date(0).toISOString(),
};

function ensureProfileDir(): void {
  mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
}

function normalizeTone(value: unknown): CommunicationTone {
  return value === 'terse' || value === 'verbose' ? value : 'balanced';
}

function normalizeFormality(value: unknown): FormalityLevel {
  return value === 'casual' || value === 'formal' ? value : 'professional';
}

function normalizeUrgency(value: unknown): UrgencyTolerance {
  return value === 'low' || value === 'high' ? value : 'normal';
}

function normalizeTime(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^\d{1,2}:\d{2}$/.test(trimmed) ? trimmed : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeString(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function normalizeUserProfile(input: RawProfile = {}): UserProfile {
  return {
    displayName: normalizeString(input.displayName, 120) ?? DEFAULT_USER_PROFILE.displayName,
    preferredName: normalizeString(input.preferredName, 80),
    role: normalizeString(input.role, 200),
    timezone: normalizeString(input.timezone, 80),
    workingHoursStart: normalizeTime(input.workingHoursStart),
    workingHoursEnd: normalizeTime(input.workingHoursEnd),
    workingDays: normalizeStringArray(input.workingDays, DEFAULT_USER_PROFILE.workingDays ?? []),
    communicationTone: normalizeTone(input.communicationTone),
    formality: normalizeFormality(input.formality),
    urgencyTolerance: normalizeUrgency(input.urgencyTolerance),
    preferredChannels: normalizeStringArray(input.preferredChannels),
    notes: normalizeString(input.notes, 1200),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
  };
}

export function loadUserProfile(): UserProfile {
  if (!existsSync(PROFILE_FILE)) {
    return normalizeUserProfile(DEFAULT_USER_PROFILE);
  }
  try {
    return normalizeUserProfile(JSON.parse(readFileSync(PROFILE_FILE, 'utf-8')) as RawProfile);
  } catch {
    return normalizeUserProfile(DEFAULT_USER_PROFILE);
  }
}

const GENERIC_USER_ALIASES = new Set([
  'the user',
  'user',
  'owner',
  'me',
  'myself',
  'you',
]);

function normalizeUserAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Names that may identify the configured user in natural-language prompts.
 *
 * This is intentionally live-read: Settings can update the saved profile or
 * OWNER_NAME without restarting the daemon. Full names and their first-name
 * forms are returned so "send Jordan the report" still works when the setup
 * value is "Jordan Kim". Generic labels are handled by call-site policy and
 * are excluded here to keep this list person-specific.
 */
export function configuredUserNameAliases(
  profile: UserProfile = loadUserProfile(),
  ownerName: string = getRuntimeEnv('OWNER_NAME', ''),
): string[] {
  const aliases = new Set<string>();
  for (const candidate of [profile.preferredName, profile.displayName, ownerName]) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeUserAlias(candidate);
    if (!normalized || GENERIC_USER_ALIASES.has(normalized)) continue;
    aliases.add(normalized);

    const [firstName, ...rest] = normalized.split(' ');
    if (rest.length > 0 && firstName.length >= 2 && !GENERIC_USER_ALIASES.has(firstName)) {
      aliases.add(firstName);
    }
  }
  return [...aliases];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether outbound wording names the configured user as its recipient. */
export function textTargetsConfiguredUserRecipient(
  text: string,
  aliases: readonly string[] = configuredUserNameAliases(),
): boolean {
  if (!text.trim() || aliases.length === 0) return false;
  const names = aliases
    .map(normalizeUserAlias)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((name) => name.split(' ').map(escapeRegex).join('\\s+'))
    .join('|');
  if (!names) return false;

  const directRecipient = new RegExp(
    `\\b(?:send(?:s|ing)?|e-?mail(?:s|ing)?|messag(?:e|es|ed|ing)|dm(?:s|ed|ing)?|notif(?:y|ies|ied|ying))\\s+(?:to\\s+)?(?:${names})(?=\\b|$)`,
    'i',
  );
  const recipientAfterObject = new RegExp(
    `\\b(?:send(?:s|ing)?|deliver(?:s|ed|ing)?|dispatch(?:es|ed|ing)?|e-?mail(?:s|ed|ing)?|messag(?:e|es|ed|ing)|dm(?:s|ed|ing)?|notif(?:y|ies|ied|ying))\\b[^\\n.!?]{0,80}\\bto\\s+(?:${names})(?=\\b|$)`,
    'i',
  );
  return directRecipient.test(text) || recipientAfterObject.test(text);
}

export function saveUserProfile(patch: RawProfile): UserProfile {
  const next = normalizeUserProfile({
    ...loadUserProfile(),
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  ensureProfileDir();
  const tmp = `${PROFILE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  renameSync(tmp, PROFILE_FILE);
  return next;
}

/**
 * Render the profile as a compact directive for assistant instructions.
 * Designed to slot in alongside Persistent Facts and the Operating
 * Policy block — not a replacement, an addition. Returns '' when the
 * profile has nothing user-specific yet (avoids polluting the prompt
 * with default placeholder lines).
 */
export function renderProfileForInstructions(profile: UserProfile = loadUserProfile()): string {
  const lines: string[] = [];
  const name = profile.preferredName ?? profile.displayName;
  if (name && name !== DEFAULT_USER_PROFILE.displayName) {
    lines.push(`- Address them as ${name}.`);
  }
  if (profile.role) lines.push(`- Role: ${profile.role}.`);
  if (profile.timezone) lines.push(`- Timezone: ${profile.timezone}.`);
  if (profile.workingHoursStart && profile.workingHoursEnd) {
    const days = profile.workingDays && profile.workingDays.length > 0 ? ` (${profile.workingDays.join(', ')})` : '';
    lines.push(`- Working hours: ${profile.workingHoursStart}–${profile.workingHoursEnd}${days}.`);
  }

  const toneGuidance: Record<CommunicationTone, string> = {
    terse: 'Default to terse. One or two sentences. No preamble, no recap.',
    balanced: 'Default to balanced length. Concise but complete.',
    verbose: 'Default to thorough. Walk through reasoning when relevant.',
  };
  lines.push(`- ${toneGuidance[profile.communicationTone]}`);

  const formalityGuidance: Record<FormalityLevel, string> = {
    casual: 'Casual tone. Contractions, plain words, no corporate-speak.',
    professional: 'Professional, direct. Avoid jargon and over-formality.',
    formal: 'Formal tone. Full sentences, no contractions, courteous.',
  };
  lines.push(`- ${formalityGuidance[profile.formality]}`);

  const urgencyGuidance: Record<UrgencyTolerance, string> = {
    low: 'Low urgency tolerance — notify sparingly, only for genuinely important signals.',
    normal: 'Normal urgency tolerance — surface meaningful updates and blockers.',
    high: 'High urgency tolerance — fine with frequent updates and proactive check-ins.',
  };
  lines.push(`- ${urgencyGuidance[profile.urgencyTolerance]}`);

  if (profile.preferredChannels && profile.preferredChannels.length > 0) {
    lines.push(`- Preferred channels: ${profile.preferredChannels.join(', ')}.`);
  }
  if (profile.notes) {
    lines.push(`- Notes: ${profile.notes}`);
  }

  return lines.length > 0 ? lines.join('\n') : '';
}
