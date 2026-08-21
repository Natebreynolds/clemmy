/**
 * Independently observed capability identity. Account, schema, operation,
 * and provider version are persisted here — never copied from a manifest
 * or from ToolContract fields that store does not own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

export interface CapabilityLiveIdentityV1 {
  operationId: string;
  providerKind: string;
  definitionFingerprint: string;
  providerVersion: string;
  operationVersion: string;
  accountId: string;
  providerIdentity: string;
  observedAt: number;
}

const STORE = path.join(BASE_DIR, 'state', 'capability-live-identity.json');

function loadAll(): Record<string, CapabilityLiveIdentityV1> {
  try {
    if (!existsSync(STORE)) return {};
    const parsed = JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, CapabilityLiveIdentityV1>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistAll(records: Record<string, CapabilityLiveIdentityV1>): void {
  mkdirSync(path.dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(records));
}

function keyOf(operationId: string, providerKind: string): string {
  return `${providerKind}:${operationId}`;
}

export function persistCapabilityLiveIdentity(identity: CapabilityLiveIdentityV1): void {
  const records = loadAll();
  records[keyOf(identity.operationId, identity.providerKind)] = identity;
  persistAll(records);
}

export function loadCapabilityLiveIdentity(
  operationId: string,
  providerKind: string,
): CapabilityLiveIdentityV1 | null {
  return loadAll()[keyOf(operationId, providerKind)] ?? null;
}
