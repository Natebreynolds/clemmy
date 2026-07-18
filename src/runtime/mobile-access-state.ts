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
 *       credentialsFile: "/Users/.../.cloudflared/<id>.json",
 *       mode: "named"
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
import { BASE_DIR, WEBHOOK_PORT } from '../config.js';
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

  // ---- detached quick-tunnel adoption ----
  /**
   * OS pid of a detached cloudflared. A quick tunnel is spawned detached so its
   * hostname survives daemon restarts; this is how a restarted daemon finds it.
   */
  pid?: number;
  /**
   * Random value this daemon echoes from /m/health.
   *
   * Cloudflare can recycle a trycloudflare hostname, so "the hostname answers"
   * does not prove the tunnel still points at us. Only an echo of this nonce
   * does.
   */
  probeNonce?: string;
  startedAt?: string;
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
  /**
   * What an actual unauthenticated probe of the hostname observed.
   *
   * `enabled` above is only the user's claim. This is the measurement, and it
   * is what any security decision should read.
   */
  verified?: {
    enforcing: boolean;
    checkedAt: string;
    evidence: string;
  };
}

/**
 * The private loopback port cloudflared should be pointed at.
 *
 * Requests arriving on this port are provably tunnel-borne, which is what makes
 * CF-Connecting-IP trustworthy for rate limiting (see mobile-ingress.ts). It is
 * ephemeral, so it changes every daemon start — `pid` lets a reader tell a live
 * publication from one left behind by a dead process.
 */
export interface MobileAccessIngress {
  port: number;
  pid: number;
  updatedAt: string;
}

export interface MobileAccessRecord {
  version: 1;
  tunnel: MobileAccessTunnel | null;
  binary: MobileAccessBinary | null;
  autoStart: boolean;
  status: MobileAccessStatus;
  lastError?: string;
  cloudflareAccess?: MobileAccessAccessAck;
  ingress?: MobileAccessIngress;
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

function normalizeTunnel(tunnel: MobileAccessTunnel | null | undefined): MobileAccessTunnel | null {
  if (!tunnel) return null;
  return {
    ...tunnel,
    mode: tunnel.mode === 'quick' ? 'quick' : 'named',
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
      tunnel: normalizeTunnel(parsed.tunnel),
      binary: parsed.binary ?? null,
      autoStart: parsed.autoStart ?? false,
      status: parsed.status ?? 'inactive',
      lastError: parsed.lastError,
      cloudflareAccess: parsed.cloudflareAccess,
      ingress: parsed.ingress,
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

export async function setMobileAccessIngress(
  ingress: { port: number; pid: number } | null,
  opts?: MobileAccessStoreOptions,
): Promise<MobileAccessRecord> {
  return updateMobileAccess((current) => ({
    ...current,
    ingress: ingress ? { ...ingress, updatedAt: new Date().toISOString() } : undefined,
  }), opts);
}

/**
 * The origin cloudflared should forward to.
 *
 * Prefers the private ingress port published by the running daemon so tunnel
 * traffic arrives on the door that proves its own origin. Falls back to the
 * shared webhook port when the publication is missing or stale (an older
 * daemon, a CLI running against a daemon that hasn't published yet, or the
 * CLEMENTINE_MOBILE_INGRESS=shared kill switch) — that fallback is exactly the
 * pre-split behavior and still works, it just classifies as tunnel-legacy.
 */
export function tunnelOriginUrl(opts?: MobileAccessStoreOptions): string {
  const ingress = readMobileAccess(opts).ingress;
  const port = ingress && isPidAlive(ingress.pid) ? ingress.port : WEBHOOK_PORT;
  return `http://127.0.0.1:${port}`;
}

/** The nonce this daemon echoes from /m/health, for tunnel-adoption probes. */
export function currentTunnelProbeNonce(opts?: MobileAccessStoreOptions): string | null {
  return readMobileAccess(opts).tunnel?.probeNonce ?? null;
}

/**
 * Liveness check for a published ingress pid.
 *
 * Signal 0 performs permission and existence checks without delivering
 * anything. This matters because the port is ephemeral: a publication left
 * behind by a crashed daemon names a port nothing is listening on, and pointing
 * cloudflared at it would produce a tunnel to nowhere.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
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
