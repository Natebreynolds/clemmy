/**
 * Isolated attested transport. Same load/bind mechanism as production.
 * Records every call. Exact-artifact reconcile reads recorded creates.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHIPPED_ISOLATED_TRANSPORT_SUPPORT_MARK } from './transport-isolated-support.js';
import type {
  AttestedTransport,
  AttestedTransportCall,
  AttestedTransportObservation,
  AttestedTransportReconcile,
  AttestedTransportReconcileResult,
} from './attested-transport.js';
import {
  executeReviewedCliRead,
  observeReviewedCliReadTransport,
} from '../reviewed-cli-read-transport.js';

void SHIPPED_ISOLATED_TRANSPORT_SUPPORT_MARK;

export type IsolatedTransportHandler = (call: AttestedTransportCall) => Promise<unknown>;

interface IsolatedTransportState {
  calls: AttestedTransportCall[];
  creates: Array<{
    artifactId: string;
    handle: string;
    accountId: string;
    operationId: string;
    contentDigest: string;
    receipt: string;
  }>;
  /** What the fake remote reports about itself, so a restart can re-observe. */
  observations?: Record<string, AttestedTransportObservation>;
}

let isolatedHandler: IsolatedTransportHandler | null = null;
const observations = new Map<string, AttestedTransportObservation>();

function homeDir(): string {
  return process.env.CLEMENTINE_HOME?.trim() || path.join(os.tmpdir(), 'clem-isolated-transport');
}

function statePath(): string {
  return path.join(homeDir(), 'state', 'attested-isolated-transport.json');
}

function loadState(): IsolatedTransportState {
  const file = statePath();
  if (!existsSync(file)) return { calls: [], creates: [], observations: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as IsolatedTransportState;
    return {
      observations: parsed.observations && typeof parsed.observations === 'object' ? parsed.observations : {},
      calls: Array.isArray(parsed.calls) ? parsed.calls : [],
      creates: Array.isArray(parsed.creates) ? parsed.creates : [],
    };
  } catch {
    return { calls: [], creates: [] };
  }
}

function saveState(state: IsolatedTransportState): void {
  mkdirSync(path.dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), `${JSON.stringify(state)}\n`);
}

export function bindIsolatedTransportHandler(handler: IsolatedTransportHandler | null): void {
  isolatedHandler = handler;
}

export function registerIsolatedObservation(observation: AttestedTransportObservation): void {
  const key = `${observation.operationId}\0${observation.accountId}`;
  observations.set(key, observation);
  // Durable so a restarted process can observe the same remote state without
  // being handed any provisioning input.
  const state = loadState();
  state.observations = { ...(state.observations ?? {}), [key]: observation };
  saveState(state);
}

export function isolatedTransportCalls(): AttestedTransportCall[] {
  return [...loadState().calls];
}

export async function executeAttestedTransport(call: AttestedTransportCall): Promise<unknown> {
  const state = loadState();
  state.calls.push(call);
  if (call.expected?.providerKind === 'reviewed_cli') {
    saveState(state);
    return executeReviewedCliRead(call);
  }
  if (!isolatedHandler) {
    saveState(state);
    throw new Error(`${call.operationId} isolated transport has no handler`);
  }
  const result = await isolatedHandler(call);
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const createdId = String(record.spreadsheet_id ?? record.spreadsheetId ?? record.id ?? '').trim();
  if (createdId && (call.operationId.includes('SHEET_FROM_JSON') || call.operationId === 'host_create')) {
    const handle = String(record.spreadsheet_url ?? record.handle ?? `https://docs.google.com/spreadsheets/d/${createdId}`);
    const receipt = String(record.receipt ?? `receipt:${createdId}`);
    state.creates.push({
      artifactId: createdId,
      handle,
      accountId: call.accountId,
      operationId: call.operationId,
      contentDigest: createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex'),
      receipt,
    });
  }
  saveState(state);
  return result;
}

export function observeAttestedTransport(input: {
  operationId: string;
  accountId: string;
}): AttestedTransportObservation | null {
  const key = `${input.operationId}\0${input.accountId}`;
  // Fall back to durable remote state so a restarted process can observe the
  // same fake provider without being handed provisioning input.
  const prior = observations.get(key) ?? loadState().observations?.[key];
  if (!prior) return null;
  // Report the instant the capability state was actually observed. Re-stamping
  // would launder a stale registration into a fresh observation and defeat the
  // host's freshness check.
  return { ...prior };
}

/** Re-read what the fake remote reports, as a real refresh would. */
export async function refreshAttestedTransportObservation(input: {
  operationId: string;
  accountId: string;
}): Promise<AttestedTransportObservation | null> {
  if (input.accountId === 'reviewed_cli:host') {
    const observation = observeReviewedCliReadTransport(input.operationId, input.accountId);
    if (!observation) return null;
    registerIsolatedObservation(observation);
    return observation;
  }
  return observeAttestedTransport(input);
}

export async function reconcileAttestedTransport(
  input: AttestedTransportReconcile,
): Promise<AttestedTransportReconcileResult> {
  const id = input.artifactId.trim();
  if (!id) return { exists: false };
  const created = loadState().creates.find((row) => (
    row.artifactId === id && row.accountId === input.accountId
  ));
  if (!created) return { exists: false };
  return {
    exists: true,
    artifactId: created.artifactId,
    handle: created.handle,
    contentDigest: created.contentDigest,
    receipt: created.receipt,
  };
}

export function createAttestedTransport(digest: string): AttestedTransport {
  return {
    digest,
    execute: executeAttestedTransport,
    observe: observeAttestedTransport,
    refreshObservation: refreshAttestedTransportObservation,
    reconcile: reconcileAttestedTransport,
  };
}
