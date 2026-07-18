import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DEFAULT_CLEMENTINE_LIVE_SHORTCUT } from './live-window-geometry.js';

export type ClementineNotchBehavior = 'manual' | 'working' | 'always';
export type ClementineNotchDisplay = 'pointer' | 'primary';

export interface ClementineNotchPreferences {
  enabled: boolean;
  behavior: ClementineNotchBehavior;
  autoHideAfterCompletion: boolean;
  promptForDetectedMeetings: boolean;
  shortcut: string;
  preferredDisplay: ClementineNotchDisplay;
}

export type ClementineNotchPreferencesPatch = Partial<ClementineNotchPreferences>;

export const DEFAULT_CLEMENTINE_NOTCH_PREFERENCES: Readonly<ClementineNotchPreferences> = Object.freeze({
  enabled: true,
  behavior: 'manual',
  autoHideAfterCompletion: true,
  promptForDetectedMeetings: true,
  shortcut: DEFAULT_CLEMENTINE_LIVE_SHORTCUT,
  preferredDisplay: 'pointer',
});

const PREFERENCES_SCHEMA_VERSION = 1;
const MAX_PREFERENCES_FILE_BYTES = 64 * 1024;
const MAX_SHORTCUT_LENGTH = 80;
const BEHAVIORS: readonly ClementineNotchBehavior[] = ['manual', 'working', 'always'];
const DISPLAYS: readonly ClementineNotchDisplay[] = ['pointer', 'primary'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedShortcut(value: unknown, fallback = DEFAULT_CLEMENTINE_LIVE_SHORTCUT): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed
    && trimmed.length <= MAX_SHORTCUT_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : fallback;
}

/** Normalize both persisted files and renderer patches at the trust boundary.
 * Unknown keys are deliberately ignored so preferences stay forward-compatible. */
export function normalizeClementineNotchPreferences(value: unknown): ClementineNotchPreferences {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: typeof raw.enabled === 'boolean'
      ? raw.enabled
      : DEFAULT_CLEMENTINE_NOTCH_PREFERENCES.enabled,
    behavior: typeof raw.behavior === 'string' && BEHAVIORS.includes(raw.behavior as ClementineNotchBehavior)
      ? raw.behavior as ClementineNotchBehavior
      : DEFAULT_CLEMENTINE_NOTCH_PREFERENCES.behavior,
    autoHideAfterCompletion: typeof raw.autoHideAfterCompletion === 'boolean'
      ? raw.autoHideAfterCompletion
      : DEFAULT_CLEMENTINE_NOTCH_PREFERENCES.autoHideAfterCompletion,
    promptForDetectedMeetings: typeof raw.promptForDetectedMeetings === 'boolean'
      ? raw.promptForDetectedMeetings
      : DEFAULT_CLEMENTINE_NOTCH_PREFERENCES.promptForDetectedMeetings,
    shortcut: normalizedShortcut(raw.shortcut),
    preferredDisplay: typeof raw.preferredDisplay === 'string' && DISPLAYS.includes(raw.preferredDisplay as ClementineNotchDisplay)
      ? raw.preferredDisplay as ClementineNotchDisplay
      : DEFAULT_CLEMENTINE_NOTCH_PREFERENCES.preferredDisplay,
  };
}

/** Apply only valid values from an untrusted partial patch. Invalid fields keep
 * their current value instead of unexpectedly resetting another preference. */
export function patchClementineNotchPreferences(
  current: ClementineNotchPreferences,
  patch: unknown,
): ClementineNotchPreferences {
  if (!isRecord(patch)) return { ...current };
  const next = { ...current };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (typeof patch.behavior === 'string' && BEHAVIORS.includes(patch.behavior as ClementineNotchBehavior)) {
    next.behavior = patch.behavior as ClementineNotchBehavior;
  }
  if (typeof patch.autoHideAfterCompletion === 'boolean') {
    next.autoHideAfterCompletion = patch.autoHideAfterCompletion;
  }
  if (typeof patch.promptForDetectedMeetings === 'boolean') {
    next.promptForDetectedMeetings = patch.promptForDetectedMeetings;
  }
  if (typeof patch.shortcut === 'string') {
    next.shortcut = normalizedShortcut(patch.shortcut, current.shortcut);
  }
  if (typeof patch.preferredDisplay === 'string' && DISPLAYS.includes(patch.preferredDisplay as ClementineNotchDisplay)) {
    next.preferredDisplay = patch.preferredDisplay as ClementineNotchDisplay;
  }
  return next;
}

export function clementineNotchPreferencesPath(userDataRoot: string): string {
  return path.join(userDataRoot, 'notch-preferences.json');
}

export function loadClementineNotchPreferences(filePath: string): ClementineNotchPreferences {
  try {
    if (statSync(filePath).size > MAX_PREFERENCES_FILE_BYTES) {
      return { ...DEFAULT_CLEMENTINE_NOTCH_PREFERENCES, enabled: false };
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (!isRecord(parsed)) return { ...DEFAULT_CLEMENTINE_NOTCH_PREFERENCES, enabled: false };
    if ('schemaVersion' in parsed && parsed.schemaVersion !== PREFERENCES_SCHEMA_VERSION) {
      return { ...DEFAULT_CLEMENTINE_NOTCH_PREFERENCES, enabled: false };
    }
    const candidate = parsed.preferences ?? parsed;
    // A readable JSON object is not necessarily a valid preference file. In
    // particular, never let an empty/truncated object restore the default-on
    // value after a user has opted out.
    if (!isRecord(candidate) || typeof candidate.enabled !== 'boolean') {
      return { ...DEFAULT_CLEMENTINE_NOTCH_PREFERENCES, enabled: false };
    }
    return normalizeClementineNotchPreferences(candidate);
  } catch {
    // A present but unreadable/corrupt preference file must never reverse an
    // explicit opt-out. The caller handles a genuinely missing file before
    // reaching this function, so recovery safely fails closed.
    return { ...DEFAULT_CLEMENTINE_NOTCH_PREFERENCES, enabled: false };
  }
}

export function saveClementineNotchPreferences(
  filePath: string,
  preferences: ClementineNotchPreferences,
): ClementineNotchPreferences {
  const normalized = normalizeClementineNotchPreferences(preferences);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    preferences: normalized,
  }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, filePath);
  return normalized;
}
