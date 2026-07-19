/**
 * VAPID keypair store for Web Push.
 *
 * Generated once per daemon install and persisted to
 * `~/.clementine-next/state/vapid.json` with mode 0600. The public key
 * is exposed to the PWA via `/m/auth/status`; the private key never
 * leaves the daemon process.
 *
 * `web-push` produces base64url-encoded keys — we store the raw strings
 * exactly as the library expects them on subsequent calls.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import webPush from 'web-push';
import { BASE_DIR } from '../config.js';

export interface VapidRecord {
  version: 1;
  subject: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

export interface VapidStoreOptions {
  stateDir?: string;
}

function vapidFile(opts?: VapidStoreOptions): string {
  const dir = opts?.stateDir ?? path.join(BASE_DIR, 'state');
  return path.join(dir, 'vapid.json');
}

function loadRecord(opts?: VapidStoreOptions): VapidRecord | null {
  const file = vapidFile(opts);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<VapidRecord>;
    if (parsed?.version !== 1 || !parsed.publicKey || !parsed.privateKey) return null;
    return {
      version: 1,
      subject: parsed.subject ?? 'mailto:notifications@clementine.example',
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function persistRecord(record: VapidRecord, opts?: VapidStoreOptions): void {
  const file = vapidFile(opts);
  mkdirSync(path.dirname(file), { recursive: true });
  // Tmp + rename for atomicity; chmod 0600 because privateKey is sensitive.
  const tmp = `${file}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function getVapidKeys(opts?: VapidStoreOptions): VapidRecord {
  const existing = loadRecord(opts);
  if (existing) return existing;
  const generated = webPush.generateVAPIDKeys();
  const record: VapidRecord = {
    version: 1,
    subject: 'mailto:notifications@clementine.example',
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    createdAt: new Date().toISOString(),
  };
  persistRecord(record, opts);
  return record;
}

export function getVapidPublicKey(opts?: VapidStoreOptions): string {
  return getVapidKeys(opts).publicKey;
}

/** Test helper: regenerate the keypair, invalidating every existing subscription. */
export function _regenerateVapidKeysForTests(opts?: VapidStoreOptions): VapidRecord {
  const generated = webPush.generateVAPIDKeys();
  const record: VapidRecord = {
    version: 1,
    subject: 'mailto:notifications@clementine.example',
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    createdAt: new Date().toISOString(),
  };
  persistRecord(record, opts);
  return record;
}
