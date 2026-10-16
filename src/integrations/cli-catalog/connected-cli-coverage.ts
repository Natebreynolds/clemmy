import { findCatalogEntry, readConnectedClis, type ConnectedCliRecord } from './catalog.js';
import { cliHealthExecutableIdentity, readPersistedHealth } from './auth-health.js';
import { cliHealthMatchesConnection } from './cli-connection-revision.js';

/** One nominal 30-minute health sweep. This is observation freshness, not the
 * 45-second request memo and never a grant to use an operation or account. */
export const CLI_AUTH_OBSERVATION_MAX_AGE_MS = 30 * 60_000;

export interface UsableConnectedCli {
  id: string;
  command: string;
  name: string;
  vendor: string;
  description: string;
  tags: readonly string[];
  signedInAs?: string;
}

export type CliAuthenticationObservationReason =
  | 'fresh_authentication' | 'signed_out' | 'not_installed' | 'not_checked'
  | 'health_identity_mismatch' | 'invalid_timestamp' | 'future_timestamp'
  | 'connection_revision_mismatch'
  | 'observation_expired' | 'probe_incomplete' | 'missing_executable_identity'
  | 'authentication_unknown' | 'authentication_error' | 'malformed_health';

export interface ConnectedCliCandidate extends UsableConnectedCli {
  authentication: {
    state: 'confirmed' | 'signed_out' | 'unavailable' | 'unverified';
    reason: CliAuthenticationObservationReason;
    checkedAt: string | null;
  };
  /** A label observed in this fresh probe is not the intended-account check. */
  account: { state: 'observed'; label: string } | { state: 'unverified' };
  intendedAccount: 'unverified';
  operationReadiness: 'unverified';
}

export interface ConnectedCliAppCandidate extends ConnectedCliCandidate {
  matchAmbiguous: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactIdentity(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function displayLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
  return label || undefined;
}

function authenticationObservation(record: ConnectedCliRecord, row: unknown, now: number): ConnectedCliCandidate['authentication'] {
  const unverified = (reason: CliAuthenticationObservationReason, checkedAt: string | null = null): ConnectedCliCandidate['authentication'] =>
    ({ state: 'unverified', reason, checkedAt });
  if (row === undefined) return unverified('not_checked');
  if (!object(row)) return unverified('malformed_health');
  if (row.id !== record.id || row.command !== record.command) return unverified('health_identity_mismatch');
  if ((Object.hasOwn(record, 'connectionRevision') || Object.hasOwn(row, 'connectionRevision'))
    && !cliHealthMatchesConnection(record, row)) return unverified('connection_revision_mismatch');
  const checked = typeof row.checkedAt === 'string' ? Date.parse(row.checkedAt) : NaN;
  if (!Number.isFinite(checked) || !Number.isFinite(now)
    || new Date(checked).toISOString() !== row.checkedAt) return unverified('invalid_timestamp');
  const checkedAt = new Date(checked).toISOString();
  if (checked > now) return unverified('future_timestamp', checkedAt);
  if (now - checked > CLI_AUTH_OBSERVATION_MAX_AGE_MS) return unverified('observation_expired', checkedAt);
  // Presence matters: a malformed marker is not a fresh completed check.
  if (row.staleSince !== undefined || row.lastProbeError !== undefined) return unverified('probe_incomplete', checkedAt);
  if (row.issue !== undefined) return unverified('authentication_error', checkedAt);
  if (row.installed === false) return { state: 'unavailable', reason: 'not_installed', checkedAt };
  if (row.installed !== true) return unverified('malformed_health', checkedAt);
  if (typeof row.binaryPath !== 'string' || cliHealthExecutableIdentity(row.binaryPath) === null) {
    return unverified('missing_executable_identity', checkedAt);
  }
  if (row.authStatus === 'ok') return { state: 'confirmed', reason: 'fresh_authentication', checkedAt };
  if (row.authStatus === 'signed_out') return { state: 'signed_out', reason: 'signed_out', checkedAt };
  if (row.authStatus === 'unknown') return unverified('authentication_unknown', checkedAt);
  if (row.authStatus === 'error') return unverified('authentication_error', checkedAt);
  return unverified('malformed_health', checkedAt);
}

/** Inventory only: every connected roster row remains discoverable. This
 * reads persisted metadata; it never launches a probe, checks a filesystem
 * executable, or establishes exact operation/provider/account readiness. */
export function connectedCliCandidates(now = Date.now()): ConnectedCliCandidate[] {
  let connected: ReturnType<typeof readConnectedClis>;
  let health: ReturnType<typeof readPersistedHealth>;
  try {
    connected = readConnectedClis();
  } catch { return []; }
  if (!object(connected)) return [];
  try { health = readPersistedHealth(); } catch { health = {}; }
  return Object.values(connected).flatMap((record) => {
    // The persisted roster is JSON, not a validated ConnectedCliRecord. Keep
    // exact identity bytes: trimming a malformed command must not earn a match
    // to a health row for a different accepted command.
    if (!object(record) || !exactIdentity(record.id, 160) || !exactIdentity(record.command, 1_024)) return [];
    const row: unknown = health?.[record.id];
    const authentication = authenticationObservation(record, row, now);
    const catalog = findCatalogEntry(record.id);
    const label = authentication.state === 'confirmed' && object(row) && typeof row.username === 'string'
      ? row.username.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) : '';
    return [{
      id: record.id,
      command: record.command,
      name: displayLabel(record.name) ?? displayLabel(catalog?.name) ?? record.command,
      vendor: displayLabel(record.vendor) ?? displayLabel(catalog?.vendor) ?? record.id,
      description: catalog?.description ?? '',
      tags: catalog?.tags ?? [],
      authentication,
      account: label ? { state: 'observed' as const, label } : { state: 'unverified' as const },
      ...(label ? { signedInAs: label } : {}),
      intendedAccount: 'unverified' as const,
      operationReadiness: 'unverified' as const,
    }];
  });
}

/** Only explicit id/vendor/command identities, case-insensitive and trimmed.
 * Descriptions, search tags and similar-looking names are not identities. All
 * matches remain visible rather than silently choosing the first CLI. */
export function connectedCliCandidatesForApp(app: string, now = Date.now()): ConnectedCliAppCandidate[] {
  const needle = app.trim().toLowerCase();
  if (!needle) return [];
  const matches = connectedCliCandidates(now).filter(cli => [cli.id, cli.vendor, cli.command]
    .some(name => typeof name === 'string' && name.trim().toLowerCase() === needle));
  return matches.map(candidate => ({ ...candidate, matchAmbiguous: matches.length > 1 }));
}

/** Compatibility: fresh matching authentication only, never operation proof. */
export function usableConnectedClis(now = Date.now()): UsableConnectedCli[] {
  return connectedCliCandidates(now).filter(cli => cli.authentication.state === 'confirmed');
}

/** Compatibility: one unambiguous, freshly authenticated candidate. A vendor
 * match does not prove that a requested operation/account can run through it. */
export function connectedCliCoveringApp(app: string, now = Date.now()): UsableConnectedCli | null {
  const candidates = connectedCliCandidatesForApp(app, now);
  return candidates.length === 1 && candidates[0]!.authentication.state === 'confirmed' ? candidates[0]! : null;
}

function observationLabel(candidate: ConnectedCliCandidate): string {
  switch (candidate.authentication.reason) {
    case 'fresh_authentication': return 'sign-in checked recently';
    case 'signed_out': return 'signed out at the last check';
    case 'not_installed': return 'not found at the last check';
    case 'not_checked': return 'not checked yet';
    case 'observation_expired': return 'last check is old';
    case 'probe_incomplete': return 'last check did not finish';
    case 'missing_executable_identity': return 'the checked program is not identified';
    case 'authentication_unknown': return 'sign-in has not been confirmed';
    case 'authentication_error': return 'last check could not confirm sign-in';
    default: return 'current sign-in is unverified';
  }
}

/** Discovery text retains vendor metadata for every connected candidate while
 * keeping observation, intended account and exact operation separate. */
export function connectedCliRunnerText(): string {
  const clis = connectedCliCandidates();
  if (clis.length === 0) return '';
  const listed = clis.map((cli) => (
    `\`${cli.command}\` (${cli.name}, ${cli.vendor}) — ${observationLabel(cli)}; ${cli.account.state === 'observed' ? `observed account ${cli.account.label}` : 'account unverified'}`
  ));
  const retrieval = clis.map((cli) => [cli.description, ...cli.tags].filter(Boolean).join(' ')).filter(Boolean);
  return [
    `Connected command-line candidates the owner set up: ${listed.join('; ')}.`,
    'A sign-in observation does not verify the intended account or requested operation; those remain unverified until checked for this task.',
    ...retrieval,
  ].join('\n');
}
