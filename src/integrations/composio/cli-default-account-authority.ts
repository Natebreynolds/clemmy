/**
 * Durable, operator-owned authority for Composio CLI default-account routing.
 *
 * The published CLI can execute against its provider-side default account, but
 * it cannot target or prove a Composio `connected_account_id`. This store never
 * invents one. Instead, an authenticated local operator may name the default
 * they have verified for one exact toolkit. Every grant has an opaque
 * generation (`grantId`); changing or revoking it invalidates pending-action
 * snapshots created under an older generation.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { atomicJsonMutate } from '../../runtime/atomic-json.js';

export interface ComposioCliDefaultAccountAuthority {
  kind: 'composio_cli_default_account';
  toolkit: string;
  /** Human-owned description shown on approval surfaces. Never a provider id. */
  label: string;
  /** Opaque authority generation. Rotates on every explicit grant/change. */
  grantId: string;
  grantedAt: string;
  grantedBy: string;
}

interface AuthorityState {
  version: 1;
  grants: Record<string, ComposioCliDefaultAccountAuthority>;
}

const EMPTY_STATE: AuthorityState = { version: 1, grants: {} };
const STORE_FILE = path.join(BASE_DIR, 'state', 'composio-cli-default-accounts.json');
const TOOLKIT_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function normalizeToolkit(value: string): string {
  const toolkit = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!TOOLKIT_RE.test(toolkit) || toolkit === '*') {
    throw new Error('A single concrete Composio toolkit slug is required.');
  }
  return toolkit;
}

function normalizeLabel(value: string): string {
  const label = value.replace(/\s+/g, ' ').trim();
  if (!label) throw new Error('A human-readable label for the verified CLI default account is required.');
  return label.slice(0, 240);
}

function normalizeActor(value: string): string {
  const actor = value.replace(/\s+/g, ' ').trim();
  return (actor || 'operator').slice(0, 120);
}

function validAuthority(value: unknown, toolkit?: string): value is ComposioCliDefaultAccountAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ComposioCliDefaultAccountAuthority>;
  return row.kind === 'composio_cli_default_account'
    && typeof row.toolkit === 'string'
    && TOOLKIT_RE.test(row.toolkit)
    && (!toolkit || row.toolkit === toolkit)
    && typeof row.label === 'string'
    && Boolean(row.label.trim())
    && typeof row.grantId === 'string'
    && Boolean(row.grantId.trim())
    && typeof row.grantedAt === 'string'
    && Boolean(row.grantedAt.trim())
    && typeof row.grantedBy === 'string'
    && Boolean(row.grantedBy.trim());
}

function readState(): AuthorityState {
  if (!existsSync(STORE_FILE)) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as Partial<AuthorityState>;
    if (parsed.version !== 1 || !parsed.grants || typeof parsed.grants !== 'object') return EMPTY_STATE;
    const grants: Record<string, ComposioCliDefaultAccountAuthority> = {};
    for (const [key, value] of Object.entries(parsed.grants)) {
      let toolkit: string;
      try {
        toolkit = normalizeToolkit(key);
      } catch {
        continue;
      }
      if (validAuthority(value, toolkit)) grants[toolkit] = value;
    }
    return { version: 1, grants };
  } catch {
    // Authority is fail-closed. A malformed local file can remove permission,
    // never create it.
    return EMPTY_STATE;
  }
}

export function getComposioCliDefaultAccountAuthority(
  toolkitInput: string,
): ComposioCliDefaultAccountAuthority | null {
  let toolkit: string;
  try {
    toolkit = normalizeToolkit(toolkitInput);
  } catch {
    return null;
  }
  return readState().grants[toolkit] ?? null;
}

export function listComposioCliDefaultAccountAuthorities(): ComposioCliDefaultAccountAuthority[] {
  return Object.values(readState().grants)
    .sort((a, b) => a.toolkit.localeCompare(b.toolkit));
}

export async function grantComposioCliDefaultAccountAuthority(input: {
  toolkit: string;
  label: string;
  grantedBy: string;
}): Promise<ComposioCliDefaultAccountAuthority> {
  const toolkit = normalizeToolkit(input.toolkit);
  const label = normalizeLabel(input.label);
  const grantedBy = normalizeActor(input.grantedBy);
  const authority: ComposioCliDefaultAccountAuthority = {
    kind: 'composio_cli_default_account',
    toolkit,
    label,
    grantId: `cli-default-${randomUUID()}`,
    grantedAt: new Date().toISOString(),
    grantedBy,
  };
  mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  await atomicJsonMutate<AuthorityState>(
    STORE_FILE,
    (current) => ({
      version: 1,
      grants: {
        ...(current?.version === 1 && current.grants && typeof current.grants === 'object'
          ? current.grants
          : {}),
        [toolkit]: authority,
      },
    }),
    EMPTY_STATE,
  );
  return authority;
}

export async function revokeComposioCliDefaultAccountAuthority(
  toolkitInput: string,
): Promise<boolean> {
  const toolkit = normalizeToolkit(toolkitInput);
  let revoked = false;
  mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  await atomicJsonMutate<AuthorityState>(
    STORE_FILE,
    (current) => {
      const grants = current?.version === 1 && current.grants && typeof current.grants === 'object'
        ? { ...current.grants }
        : {};
      if (!Object.hasOwn(grants, toolkit)) return undefined;
      delete grants[toolkit];
      revoked = true;
      return { version: 1, grants };
    },
    EMPTY_STATE,
  );
  return revoked;
}

export function verifyComposioCliDefaultAccountAuthority(
  snapshot: ComposioCliDefaultAccountAuthority,
): { ok: true; current: ComposioCliDefaultAccountAuthority } | { ok: false; reason: string } {
  if (!validAuthority(snapshot)) {
    return { ok: false, reason: 'The queued CLI-default authority snapshot is malformed.' };
  }
  const current = getComposioCliDefaultAccountAuthority(snapshot.toolkit);
  if (!current) {
    return {
      ok: false,
      reason: `The operator authority for the ${snapshot.toolkit} CLI default account was revoked or is unavailable.`,
    };
  }
  if (current.grantId !== snapshot.grantId) {
    return {
      ok: false,
      reason: `The operator changed the ${snapshot.toolkit} CLI default account authority after this action was queued.`,
    };
  }
  if (current.label !== snapshot.label) {
    return {
      ok: false,
      reason: `The ${snapshot.toolkit} CLI default account label no longer matches the approved snapshot.`,
    };
  }
  return { ok: true, current };
}
