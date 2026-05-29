/**
 * Mobile-access state store — persists the user's Cloudflare Tunnel
 * configuration for the PWA companion. Read by the daemon at boot
 * (to know whether to start cloudflared) and by the dashboard UI to
 * surface tunnel + device status.
 *
 * Layout (~/.clementine-next/state/mobile-access.json):
 *   {
 *     version: 1,
 *     tunnel: {
 *       id: "<tunnel uuid>",
 *       name: "clem-nathan",
 *       hostname: "clem.nathan.dev",
 *       credentialsFile: "/Users/.../.cloudflared/<id>.json"
 *     } | null,
 *     binary: { path, version } | null,
 *     autoStart: boolean,        // run cloudflared at daemon boot
 *     status: 'inactive' | 'installing' | 'awaiting-login' | 'configuring'
 *           | 'running' | 'error',
 *     lastError?: string,
 *     updatedAt: ISO,
 *   }
 *
 * No secrets in this file. The tunnel credentials file lives in
 * ~/.cloudflared/<id>.json — owned by cloudflared, not by us.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';

export type MobileAccessStatus =
  | 'inactive'
  | 'installing'
  | 'awaiting-login'
  | 'configuring'
  | 'running'
  | 'error';

export interface MobileAccessTunnel {
  id: string;
  name: string;
  hostname: string;
  mode?: 'named' | 'quick';
  credentialsFile?: string;
}

export interface MobileAccessBinary {
  path: string;
  version: string;
}

/**
 * Cloudflare Access acknowledgement for custom-domain tunnels. The
 * wizard surfaces a security card recommending CF Access; once the
 * user confirms they've enabled it (or explicitly opts out), we
 * stop nagging. Stored per-tunnel-hostname so a hostname change
 * re-triggers the prompt.
 */
export interface MobileAccessAccessAck {
  hostname: string;
  acknowledged: boolean;
  acknowledgedAt: string;
  /** true = "I've enabled Access", false = "I opted out". */
  enabled: boolean;
}

export interface MobileAccessRecord {
  version: 1;
  tunnel: MobileAccessTunnel | null;
  binary: MobileAccessBinary | null;
  autoStart: boolean;
  status: MobileAccessStatus;
  lastError?: string;
  cloudflareAccess?: MobileAccessAccessAck;
  updatedAt: string;
}

export interface MobileAccessStoreOptions {
  stateDir?: string;
}

function stateFile(opts?: MobileAccessStoreOptions): string {
  const dir = opts?.stateDir ?? path.join(BASE_DIR, 'state');
  return path.join(dir, 'mobile-access.json');
}

function ensureParentDir(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
}

function emptyRecord(): MobileAccessRecord {
  return {
    version: 1,
    tunnel: null,
    binary: null,
    autoStart: false,
    status: 'inactive',
    updatedAt: new Date().toISOString(),
  };
}

export function readMobileAccess(opts?: MobileAccessStoreOptions): MobileAccessRecord {
  const file = stateFile(opts);
  if (!existsSync(file)) return emptyRecord();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<MobileAccessRecord>;
    if (parsed?.version !== 1) return emptyRecord();
    return {
      version: 1,
      tunnel: parsed.tunnel ?? null,
      binary: parsed.binary ?? null,
      autoStart: parsed.autoStart ?? false,
      status: parsed.status ?? 'inactive',
      lastError: parsed.lastError,
      cloudflareAccess: parsed.cloudflareAccess,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return emptyRecord();
  }
}

export async function updateMobileAccess(
  mutator: (current: MobileAccessRecord) => MobileAccessRecord,
  opts?: MobileAccessStoreOptions,
): Promise<MobileAccessRecord> {
  const file = stateFile(opts);
  ensureParentDir(file);
  let next = emptyRecord();
  await atomicJsonMutate<MobileAccessRecord>(
    file,
    (current) => {
      const merged = mutator(current);
      next = { ...merged, version: 1, updatedAt: new Date().toISOString() };
      return next;
    },
    emptyRecord(),
  );
  return next;
}

export async function setMobileAccessStatus(
  status: MobileAccessStatus,
  lastError?: string,
  opts?: MobileAccessStoreOptions,
): Promise<MobileAccessRecord> {
  return updateMobileAccess((current) => ({ ...current, status, lastError }), opts);
}

export async function setMobileAccessBinary(
  binary: MobileAccessBinary | null,
  opts?: MobileAccessStoreOptions,
): Promise<MobileAccessRecord> {
  return updateMobileAccess((current) => ({ ...current, binary }), opts);
}

export async function setMobileAccessTunnel(
  tunnel: MobileAccessTunnel | null,
  opts?: MobileAccessStoreOptions,
): Promise<MobileAccessRecord> {
  return updateMobileAccess((current) => ({ ...current, tunnel }), opts);
}

export async function setMobileAccessAutoStart(
  autoStart: boolean,
  opts?: MobileAccessStoreOptions,
): Promise<MobileAccessRecord> {
  return updateMobileAccess((current) => ({ ...current, autoStart }), opts);
}

/**
 * Record the user's Cloudflare Access decision for the current
 * custom-domain tunnel. `enabled: true` means "I turned Access on";
 * `enabled: false` means "I explicitly opted out (less secure, my
 * choice)". Either way, we stop showing the recommendation card.
 */
export async function setMobileAccessAccessAck(
  input: { enabled: boolean },
  opts?: MobileAccessStoreOptions,
): Promise<MobileAccessRecord> {
  return updateMobileAccess((current) => {
    const hostname = current.tunnel?.hostname;
    if (!hostname || current.tunnel?.mode === 'quick') {
      // Acks only make sense for a named custom-domain tunnel.
      return current;
    }
    return {
      ...current,
      cloudflareAccess: {
        hostname,
        acknowledged: true,
        acknowledgedAt: new Date().toISOString(),
        enabled: input.enabled,
      },
    };
  }, opts);
}
