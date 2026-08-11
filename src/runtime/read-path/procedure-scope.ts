/**
 * Canonical ownership for learned procedures.
 *
 * Learning and serving must derive this tuple in exactly one place. The
 * machine id identifies the install, BASE_DIR identifies the workspace, and
 * the logical account identity survives provider re-authentication. Rotating
 * Composio connection ids are deliberately rejected.
 */
import { BASE_DIR } from '../../config.js';
import type { ProcedureScope } from '../../memory/procedure-artifact.js';
import { getMachineId } from '../machine-id.js';

/** Normalize the stable account key used by both learning and serving. */
export function normalizeProcedureAccountIdentity(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/^smtp:/, '');
  if (/^ca_/i.test(normalized)) {
    throw new Error('procedure account identity must be stable, not a rotating connection id');
  }
  return normalized;
}

/** One canonical scope derivation for every procedure producer/consumer. */
export function canonicalProcedureScope(accountIdentity: unknown): ProcedureScope {
  return {
    tenant: getMachineId(),
    workspace: BASE_DIR,
    accountIdentity: normalizeProcedureAccountIdentity(accountIdentity),
  };
}

/** Compare a stored scope with the scope this install derives now. */
export function isCanonicalProcedureScope(scope: ProcedureScope): boolean {
  try {
    const canonical = canonicalProcedureScope(scope.accountIdentity);
    return scope.tenant === canonical.tenant
      && scope.workspace === canonical.workspace
      && scope.accountIdentity === canonical.accountIdentity;
  } catch {
    return false;
  }
}
