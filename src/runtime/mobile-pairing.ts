/**
 * One-time mobile pairing codes.
 *
 * The dashboard can mint a short-lived random token and encode it in
 * the QR code. The PWA consumes it once to create a normal mobile
 * session. Only SHA-256(token) is persisted, matching mobile sessions:
 * leaking this state file does not grant access to a device.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';

export interface MobilePairingCodeRecord {
  id: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  targetUrl?: string;
}

interface MobilePairingCodesFile {
  version: 1;
  codes: MobilePairingCodeRecord[];
}

export interface MobilePairingStoreOptions {
  stateDir?: string;
  ttlMs?: number;
  now?: () => number;
}

export interface CreatedMobilePairingCode {
  id: string;
  token: string;
  expiresAt: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_CODES = 10;

function pairingFile(opts?: MobilePairingStoreOptions): string {
  const dir = opts?.stateDir ?? path.join(BASE_DIR, 'state');
  return path.join(dir, 'mobile-pairing-codes.json');
}

function ensureParentDir(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
}

function emptyFile(): MobilePairingCodesFile {
  return { version: 1, codes: [] };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function loadFile(opts?: MobilePairingStoreOptions): MobilePairingCodesFile {
  const file = pairingFile(opts);
  if (!existsSync(file)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<MobilePairingCodesFile>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.codes)) return emptyFile();
    return { version: 1, codes: parsed.codes };
  } catch {
    return emptyFile();
  }
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function pruneCodes(codes: MobilePairingCodeRecord[], now: number): MobilePairingCodeRecord[] {
  return codes
    .filter((row) => !row.usedAt && Date.parse(row.expiresAt) > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_CODES);
}

export async function createMobilePairingCode(
  input: { targetUrl?: string } = {},
  opts?: MobilePairingStoreOptions,
): Promise<CreatedMobilePairingCode> {
  const now = opts?.now?.() ?? Date.now();
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const token = randomBytes(32).toString('base64url');
  const record: MobilePairingCodeRecord = {
    id: `pair-${randomBytes(5).toString('base64url')}`,
    tokenHash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    targetUrl: input.targetUrl,
  };
  const file = pairingFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobilePairingCodesFile>(
    file,
    (current) => ({ version: 1, codes: [record, ...pruneCodes(current.codes, now)].slice(0, MAX_CODES) }),
    emptyFile(),
  );
  return { id: record.id, token, expiresAt: record.expiresAt };
}

export async function consumeMobilePairingCode(
  token: string,
  opts?: MobilePairingStoreOptions,
): Promise<MobilePairingCodeRecord | null> {
  if (!token) return null;
  const now = opts?.now?.() ?? Date.now();
  const tokenHash = hashToken(token);
  const file = pairingFile(opts);
  ensureParentDir(file);
  let consumed: MobilePairingCodeRecord | null = null;
  await atomicJsonMutate<MobilePairingCodesFile>(
    file,
    (current) => {
      const live = pruneCodes(current.codes, now);
      for (const row of live) {
        if (safeEqualHex(row.tokenHash, tokenHash)) {
          consumed = { ...row, usedAt: new Date(now).toISOString() };
          break;
        }
      }
      if (!consumed) return { version: 1, codes: live };
      return {
        version: 1,
        codes: live.filter((row) => row.tokenHash !== tokenHash),
      };
    },
    emptyFile(),
  );
  return consumed;
}

export function listMobilePairingCodes(opts?: MobilePairingStoreOptions): MobilePairingCodeRecord[] {
  const now = opts?.now?.() ?? Date.now();
  return pruneCodes(loadFile(opts).codes, now);
}
