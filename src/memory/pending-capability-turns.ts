/**
 * Durable pending-slot state (E3.6/F30).
 *
 * A cold acquisition that stops on missing slots must not evaporate into the
 * transcript: the NEXT accepted answer ("tomorrow") has to join the exact
 * pending operation — its provider/operation, dispatchable identifier,
 * proven schema, template, and authority digest — without rerunning
 * discovery or losing the account/timezone binding.
 *
 * One JSON document per logical key under CLEMENTINE_HOME; written
 * atomically (tmp+rename); consumed exactly once by the joining answer.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import { logicalKeyDigest } from './procedure-receipts.js';
import type { ProcedureScope } from './procedure-artifact.js';
import type { ProcedureKind } from './procedure-validity.js';

export interface PendingCapabilityTurn {
  version: 1;
  /** The accepted source that asked the question. */
  acceptedSource: string;
  scope: ProcedureScope;
  provider: string;
  operation: string;
  identifier: string;
  schemaFingerprint: string;
  kind: ProcedureKind;
  templateArgs: Record<string, unknown>;
  missingSlots: string[];
  /** Slot values already resolved before the question. */
  knownSlotValues: Record<string, string>;
  /** The lane authority the acquisition ran under. */
  authorityDigest: string;
  createdAt: string;
}

function pendingDir(): string {
  return path.join(BASE_DIR, 'memory', 'pending-capability-turns', getMachineId());
}

function pendingPath(keyDigest: string): string {
  return path.join(pendingDir(), `${keyDigest}.json`);
}

export function persistPendingCapabilityTurn(turn: PendingCapabilityTurn): void {
  const dir = pendingDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const key = logicalKeyDigest({
    scope: turn.scope, provider: turn.provider, operation: turn.operation, effectClass: 'read',
  });
  const temporary = path.join(dir, `.${key}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(turn, null, 2)}\n`, 'utf-8');
  renameSync(temporary, pendingPath(key));
}

/** Load (and validate) the pending turn for a logical key, if any. */
export function loadPendingCapabilityTurn(input: {
  scope: ProcedureScope;
  provider: string;
  operation: string;
}): PendingCapabilityTurn | undefined {
  try {
    const key = logicalKeyDigest({ ...input, effectClass: 'read' });
    const file = pendingPath(key);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as PendingCapabilityTurn;
    if (parsed?.version !== 1 || !parsed.identifier || !parsed.schemaFingerprint) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Consume the pending turn after its answer dispatched (exactly once). */
export function consumePendingCapabilityTurn(input: {
  scope: ProcedureScope;
  provider: string;
  operation: string;
}): void {
  try {
    unlinkSync(pendingPath(logicalKeyDigest({ ...input, effectClass: 'read' })));
  } catch { /* already consumed */ }
}

/** Diagnostics/tests: every pending turn on this machine. */
export function listPendingCapabilityTurns(): PendingCapabilityTurn[] {
  try {
    const dir = pendingDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try { return JSON.parse(readFileSync(path.join(dir, name), 'utf-8')) as PendingCapabilityTurn; }
        catch { return null; }
      })
      .filter((turn): turn is PendingCapabilityTurn => turn !== null);
  } catch {
    return [];
  }
}
