/**
 * A scheduled data source that keeps failing tells the owner once, then backs
 * off.
 *
 * Every input is a structural fact: how many scheduled refreshes in a row
 * failed, the failure code the refusing layer assigned (never a reading of the
 * error text), timestamps, and digests of the source's declaration and of its
 * app connection. Nothing here judges whether a failure is transient or what
 * the data means.
 *
 * - After TELL_AFTER_FAILURES scheduled failures in a row with the same code,
 *   the owner is told once: which Space and source, why, and what would fix
 *   it. A different code may tell once more; a code already told stays quiet
 *   until a success ends the streak.
 * - From that point the source passes over a growing number of its own
 *   scheduled occurrences between tries (1, 3, 7, ... up to
 *   MAX_SKIPPED_OCCURRENCES) and never waits longer than MAX_HOLD_MS.
 * - A change to the source's declaration or to its app connection ends the
 *   wait and tries again at once.
 * - A successful refresh from any path ends the streak.
 */
import { createHash } from 'node:crypto';
import type { ConnectedToolkit } from '../integrations/composio/client.js';
import { connectionsForOperation } from '../integrations/composio/client.js';
import { redactSensitiveText } from '../runtime/security.js';
import type { SpaceSourceFailureCode } from './runner.js';
import type { SpaceDataSource } from './store.js';

/** A failure the refusing layer did not name (a thrown refresh, a legacy path). */
export type SourceStreakCode = SpaceSourceFailureCode | 'unclassified';

const STREAK_CODES: ReadonlySet<string> = new Set<SourceStreakCode>([
  'local_runner',
  'script_held',
  'local_command',
  'not_approved',
  'definition',
  'read_preparation',
  'provider_error',
  'shaping',
  'not_saved',
  'unclassified',
]);

export const TELL_AFTER_FAILURES = 3;
export const MAX_SKIPPED_OCCURRENCES = 63;
export const MAX_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ERROR_CHARS = 400;

export interface SourceRefreshStreak {
  /** Scheduled refreshes in a row that failed, whatever the code. */
  failures: number;
  /** Code of the latest failure, and how many failures in a row carried it. */
  code: SourceStreakCode;
  codeFailures: number;
  /** Latest failure text, bounded. Shown as detail; never compared. */
  error: string;
  firstFailedAt: string;
  lastFailedAt: string;
  /** Scheduled occurrences still to pass over before the next try. */
  skipsRemaining: number;
  /** Codes the owner has been told about during this streak. */
  told: SourceStreakCode[];
  declarationDigest: string;
  connectionDigest: string | null;
  /** The source's current successful observation when the streak last
   * failed. A different one later means a refresh succeeded since. */
  okObservationId: string | null;
}

export interface SourceIdentity {
  declarationDigest: string;
  /** Null when the connection registry is unknown or the source uses none. */
  connectionDigest: string | null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonical(child);
    }
    return out;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** The source exactly as declared: any edit to it is a configuration change. */
export function sourceDeclarationDigest(source: SpaceDataSource): string {
  return digest(source);
}

/**
 * The app connection a provider source reads through, as the registry lists
 * it (connection id and status). An empty registry is unknown, not
 * "disconnected", so it yields null and never reads as a change.
 */
export function sourceConnectionDigest(
  source: SpaceDataSource,
  snapshot: readonly ConnectedToolkit[],
): string | null {
  const operation = source.composioSlug?.trim();
  if (!operation || source.runner?.trim() || source.cliArgv?.length) return null;
  if (snapshot.length === 0) return null;
  const serving = connectionsForOperation(operation, snapshot);
  const account = source.composioAccountId?.trim();
  const relevant = account ? serving.filter((connection) => connection.connectionId === account) : serving;
  return digest(relevant.map((connection) => `${connection.connectionId}:${connection.status}`).sort());
}

export function sourceIdentity(source: SpaceDataSource, snapshot: readonly ConnectedToolkit[]): SourceIdentity {
  return {
    declarationDigest: sourceDeclarationDigest(source),
    connectionDigest: sourceConnectionDigest(source, snapshot),
  };
}

/** Occurrences to pass over after this many failures in a row. */
export function skipsAfterFailures(failures: number): number {
  if (failures < TELL_AFTER_FAILURES) return 0;
  const exponent = Math.min(failures - TELL_AFTER_FAILURES + 1, 16);
  return Math.min(2 ** exponent - 1, MAX_SKIPPED_OCCURRENCES);
}

function boundedError(error: string): string {
  const flat = redactSensitiveText(error).replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_ERROR_CHARS ? flat : `${flat.slice(0, MAX_ERROR_CHARS - 1).trimEnd()}…`;
}

/** Fold one failed scheduled refresh into the streak. */
export function recordSourceRefreshFailure(
  previous: SourceRefreshStreak | undefined,
  failure: {
    code: SourceStreakCode;
    error: string;
    at: Date;
    identity: SourceIdentity;
    okObservationId: string | null;
  },
): { streak: SourceRefreshStreak; tell: boolean } {
  const failures = (previous?.failures ?? 0) + 1;
  const codeFailures = previous && previous.code === failure.code ? previous.codeFailures + 1 : 1;
  const told = previous?.told ?? [];
  const tell = codeFailures >= TELL_AFTER_FAILURES && !told.includes(failure.code);
  const at = failure.at.toISOString();
  return {
    tell,
    streak: {
      failures,
      code: failure.code,
      codeFailures,
      error: boundedError(failure.error),
      firstFailedAt: previous?.firstFailedAt ?? at,
      lastFailedAt: at,
      skipsRemaining: skipsAfterFailures(failures),
      told: tell ? [...told, failure.code] : told,
      declarationDigest: failure.identity.declarationDigest,
      connectionDigest: failure.identity.connectionDigest ?? previous?.connectionDigest ?? null,
      okObservationId: failure.okObservationId,
    },
  };
}

/** The declaration changed, or a known connection became a different one. */
export function sourceIdentityChanged(streak: SourceRefreshStreak, identity: SourceIdentity): boolean {
  if (streak.declarationDigest !== identity.declarationDigest) return true;
  return streak.connectionDigest !== null
    && identity.connectionDigest !== null
    && streak.connectionDigest !== identity.connectionDigest;
}

/**
 * A changed source gets a fresh run of tries at its normal cadence. What the
 * owner was already told stays told until a success ends the streak.
 */
export function restartAfterChange(streak: SourceRefreshStreak, identity: SourceIdentity): SourceRefreshStreak {
  return {
    ...streak,
    failures: 0,
    codeFailures: 0,
    skipsRemaining: 0,
    declarationDigest: identity.declarationDigest,
    connectionDigest: identity.connectionDigest ?? streak.connectionDigest,
  };
}

/**
 * Decide whether a due occurrence is passed over. `occurrences` is how many
 * scheduled occurrences this due evaluation stands for (a catch-up window can
 * cover several).
 */
export function passOverDueOccurrence(
  streak: SourceRefreshStreak,
  input: { now: Date; occurrences: number },
): { hold: boolean; streak: SourceRefreshStreak } {
  if (streak.skipsRemaining <= 0) return { hold: false, streak };
  const lastFailedMs = Date.parse(streak.lastFailedAt);
  if (Number.isFinite(lastFailedMs) && input.now.getTime() - lastFailedMs >= MAX_HOLD_MS) {
    return { hold: false, streak: { ...streak, skipsRemaining: 0 } };
  }
  const consumed = Math.max(1, Math.trunc(input.occurrences));
  return { hold: true, streak: { ...streak, skipsRemaining: Math.max(0, streak.skipsRemaining - consumed) } };
}

/** Keep only well-formed streaks from persisted state. */
export function readSourceRefreshStreaks(raw: unknown): Record<string, SourceRefreshStreak> {
  const out: Record<string, SourceRefreshStreak> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const count = (field: string): number | null => {
      const n = row[field];
      return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
    };
    const text = (field: string): string | null => (typeof row[field] === 'string' ? row[field] as string : null);
    const failures = count('failures');
    const codeFailures = count('codeFailures');
    const skipsRemaining = count('skipsRemaining');
    const code = text('code');
    const firstFailedAt = text('firstFailedAt');
    const lastFailedAt = text('lastFailedAt');
    const declarationDigest = text('declarationDigest');
    if (
      failures === null || codeFailures === null || skipsRemaining === null
      || !code || !STREAK_CODES.has(code)
      || !firstFailedAt || !lastFailedAt || !declarationDigest
    ) continue;
    const told = Array.isArray(row.told)
      ? (row.told as unknown[]).filter((entry): entry is SourceStreakCode => typeof entry === 'string' && STREAK_CODES.has(entry))
      : [];
    out[key] = {
      failures,
      code: code as SourceStreakCode,
      codeFailures,
      error: text('error') ?? '',
      firstFailedAt,
      lastFailedAt,
      skipsRemaining,
      told,
      declarationDigest,
      connectionDigest: text('connectionDigest'),
      okObservationId: text('okObservationId'),
    };
  }
  return out;
}

/** What the source reads, as its own declaration names it. */
function declaredRead(source: SpaceDataSource): { read: string; through: 'app' | 'command' } {
  if (source.runner?.trim()) return { read: source.runner.trim(), through: 'command' };
  if (source.cliArgv?.length) return { read: source.cliArgv.join(' '), through: 'command' };
  return { read: source.composioSlug?.trim() ?? '', through: 'app' };
}

interface PlainReason {
  why: string;
  fix: string;
  /** Whether the failure text itself adds something the owner can act on. */
  detail: boolean;
}

function plainReason(code: SourceStreakCode, declared: { read: string; through: 'app' | 'command' }): PlainReason {
  const { read } = declared;
  switch (code) {
    case 'local_runner':
      return {
        why: `The old raw script path${read ? ` (${read})` : ''} has no saved execution authority.`,
        fix: 'Refresh the saved source through its Workspace to review the current script permission.',
        detail: false,
      };
    case 'script_held':
      return {
        why: `The saved script refresh${read ? ` (${read})` : ''} is held.`,
        fix: 'Review this source’s saved refresh and its execution evidence before retrying; later ticks will not start a replacement.',
        detail: true,
      };
    case 'local_command':
      return {
        why: `It runs a command${read ? ` (${read})` : ''} that is not one of the reviewed read-only commands, so it is never started.`,
        fix: 'Ask Clem to switch this source to a connected app or a reviewed read.',
        detail: true,
      };
    case 'not_approved':
      return {
        why: 'Running this source was declined, or its approval ended.',
        fix: 'Review the earlier decision with Clem and repair or change the source; refreshing it does not erase that decision.',
        detail: true,
      };
    case 'definition':
      return {
        why: 'The source cannot run the way it is saved.',
        fix: 'Ask Clem to fix this source in the Space.',
        detail: true,
      };
    case 'read_preparation':
      return {
        why: `The read${read ? ` (${read})` : ''} could not be set up, so the app was never called.`,
        fix: 'Check the app\'s connection, or ask Clem to save the Space again so the read is set up fresh.',
        detail: true,
      };
    case 'provider_error':
      return declared.through === 'command'
        ? {
          why: `The command${read ? ` (${read})` : ''} returned an error.`,
          fix: 'Check that its command-line tool is installed and signed in on this computer.',
          detail: true,
        }
        : {
          why: `The app returned an error${read ? ` for ${read}` : ''}.`,
          fix: 'Check that the app is connected and signed in.',
          detail: true,
        };
    case 'shaping':
      return {
        why: 'The data came back, but shaping it for the Space failed.',
        fix: 'Ask Clem to fix this source\'s shaping steps.',
        detail: true,
      };
    case 'not_saved':
      return {
        why: 'The new data could not be saved to the Space.',
        fix: 'Ask Clem to check the Space; this can also clear on its own.',
        detail: true,
      };
    default:
      return {
        why: 'The refresh failed.',
        fix: 'Ask Clem to look at this source.',
        detail: true,
      };
  }
}

export const SPACE_SOURCE_NOTICE_SOURCE = 'space_source_refresh';

/**
 * The one notice for a streak and code. Its id is stable for that pair, so a
 * repeated attempt to tell (a restart before state was saved) is the same
 * notice, never a second one.
 */
export interface SourceStreakNoticeInput {
  spaceId: string;
  spaceTitle: string;
  source: SpaceDataSource;
  streak: SourceRefreshStreak;
}

export interface SourceStreakNotice { id: string; title: string; body: string; metadata: Record<string, unknown> }

export function sourceStreakNotice(input: SourceStreakNoticeInput): SourceStreakNotice {
  const { spaceId, source, streak } = input;
  const spaceTitle = input.spaceTitle.trim() || spaceId;
  const reason = plainReason(streak.code, declaredRead(source));
  const firstMs = Date.parse(streak.firstFailedAt);
  const body = [
    `The "${source.id}" source in ${spaceTitle} failed its last ${streak.codeFailures} scheduled refreshes the same way.`,
    '',
    `Why: ${reason.why}`,
    `What would fix it: ${reason.fix}`,
    '',
    'It will be tried less often from now on, and right away if this source or its app connection changes. Its first successful refresh ends this.',
    ...(reason.detail && streak.error ? ['', `Details: ${streak.error}`] : []),
  ].join('\n');
  return {
    id: `space-source-${spaceId}-${source.id}-${streak.code}-${Number.isFinite(firstMs) ? firstMs : streak.firstFailedAt}`,
    title: `"${source.id}" in ${spaceTitle} isn't refreshing`,
    body,
    metadata: {
      source: SPACE_SOURCE_NOTICE_SOURCE,
      workspaceId: spaceId,
      spaceTitle,
      sourceId: source.id,
      // A report of work that stopped, told once: never a badge.
      status: 'failed',
      failureCode: streak.code,
      consecutiveFailures: streak.codeFailures,
      firstFailedAt: streak.firstFailedAt,
      lastFailedAt: streak.lastFailedAt,
    },
  };
}


/** One Space report for the sources reaching their notice threshold together.
 * Membership owns the identity, not source order, wording or delivery time.
 * Singleton ids stay compatible with notices emitted by older installations. */
export function sourceStreakGroupNotice(inputs: readonly SourceStreakNoticeInput[]): SourceStreakNotice {
  if (inputs.length === 0) throw new Error('a source failure notice needs at least one source');
  const first = inputs[0]!;
  if (inputs.some(input => input.spaceId !== first.spaceId)) throw new Error('source failure groups cannot cross Spaces');
  const notices = [...new Map(inputs.map(input => {
    const notice = sourceStreakNotice(input);
    return [notice.id, notice] as const;
  })).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (notices.length === 1) return notices[0]!;
  const title = first.spaceTitle.trim() || first.spaceId;
  return {
    id: `space-sources-${first.spaceId}-${digest(notices.map(notice => notice.id))}`,
    title: `${notices.length} sources in ${title} aren't refreshing`,
    body: notices.map(notice => notice.body).join('\n\n——\n\n'),
    metadata: {
      source: SPACE_SOURCE_NOTICE_SOURCE, workspaceId: first.spaceId, spaceTitle: title, status: 'failed',
      failedSourceCount: notices.length,
      sourceIds: notices.map(notice => notice.metadata.sourceId),
      failures: notices.map(notice => ({ noticeId: notice.id, ...notice.metadata })),
    },
  };
}
