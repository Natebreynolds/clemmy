/**
 * provider-credit — which model accounts are refusing work for lack of credit.
 *
 * A prepaid account (an API key billed per token) stops answering when its
 * balance runs out, and most providers expose no balance to the key itself.
 * The refusal is the one signal every provider sends, so each call site that
 * talks to a provider reports it here: a credit refusal latches the account as
 * out of credit, and the next successful answer from that account clears it.
 * Nothing else clears it — adding credit is something the owner does on the
 * provider's own billing page, and the next real call proves it worked.
 *
 * Keys are account ids: a BYO provider id, `openai` for the OpenAI key, `jev`
 * for the TypeSafe key. Kept in memory and written through to
 * state/provider-credit.json so the state survives a restart. Recording never
 * throws into a model path.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';
import { redactSensitiveText } from './security.js';

export interface CreditRefusal {
  /** First refusal of the current run of refusals (epoch ms). */
  since: number;
  /** Most recent refusal (epoch ms). */
  lastSeenAt: number;
  status?: number;
  /** The provider's own words, redacted and clipped, for a tooltip. */
  detail?: string;
}

type CreditSnapshot = Record<string, CreditRefusal>;

/** Accounts that are not BYO providers: the OpenAI key and the TypeSafe key. */
export const OPENAI_KEY_ACCOUNT_ID = 'openai';
export const JEV_ACCOUNT_ID = 'jev';

const STORE_PATH = path.join(BASE_DIR, 'state', 'provider-credit.json');
const DETAIL_MAX_CHARS = 160;

function isTest(): boolean {
  return process.env.NODE_ENV === 'test';
}

let snapshot: CreditSnapshot = {};
let loaded = false;

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  if (isTest()) return;
  try {
    if (existsSync(STORE_PATH)) {
      const parsed: unknown = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snapshot = parsed as CreditSnapshot;
    }
  } catch {
    /* unreadable → start empty; the next refusal re-latches */
  }
}

function persist(): void {
  if (isTest()) return;
  void atomicJsonMutate<CreditSnapshot>(STORE_PATH, () => ({ ...snapshot }), {}).catch(() => {});
}

function clip(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const flat = redactSensitiveText(detail).replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > DETAIL_MAX_CHARS ? `${flat.slice(0, DETAIL_MAX_CHARS - 1)}…` : flat;
}

/** The account refused a call because its credit is used up. */
export function noteCreditRefused(accountId: string, info: { status?: number; detail?: string } = {}): void {
  try {
    if (!accountId) return;
    loadOnce();
    const now = Date.now();
    const prior = snapshot[accountId];
    const detail = clip(info.detail) ?? prior?.detail;
    snapshot = {
      ...snapshot,
      [accountId]: {
        since: prior?.since ?? now,
        lastSeenAt: now,
        ...(info.status !== undefined ? { status: info.status } : prior?.status !== undefined ? { status: prior.status } : {}),
        ...(detail ? { detail } : {}),
      },
    };
    persist();
  } catch {
    /* never break the caller */
  }
}

/** The account answered: whatever refused it before has been fixed. Cheap
 *  when nothing is latched, so it can run on every successful call. */
export function noteCreditAnswered(accountId: string): void {
  try {
    if (!accountId) return;
    loadOnce();
    if (!snapshot[accountId]) return;
    const { [accountId]: _cleared, ...rest } = snapshot;
    snapshot = rest;
    persist();
  } catch {
    /* never break the caller */
  }
}

export function creditRefusal(accountId: string): CreditRefusal | undefined {
  loadOnce();
  return snapshot[accountId];
}

export function creditRefusals(): Readonly<CreditSnapshot> {
  loadOnce();
  return snapshot;
}

/** Test seam. */
export function __resetProviderCreditForTests(): void {
  snapshot = {};
  loaded = false;
}
