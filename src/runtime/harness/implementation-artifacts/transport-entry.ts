/**
 * Production attested transport. Lazy-loads the provider SDK from the
 * installed package root — never from a path relative to this artifact.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED_TRANSPORT_SUPPORT_MARK } from './transport-support.js';
import type {
  AttestedTransport,
  AttestedTransportCall,
  AttestedTransportObservation,
  AttestedTransportReconcile,
  AttestedTransportReconcileResult,
} from './attested-transport.js';

void SHIPPED_TRANSPORT_SUPPORT_MARK;

/** Identity of the provider surface this transport speaks, not a build number. */
const PROVIDER_VERSION = 'composio-tool-router-v1';

type ComposioToolSchema = {
  slug: string;
  inputParameters?: unknown;
};

type ComposioClientSurface = {
  isComposioEnabled: () => boolean;
  peekConnectedToolkits: () => unknown[];
  executeComposioTool: (
    operationId: string,
    args: Record<string, unknown>,
    accountId: string,
  ) => Promise<unknown>;
  getComposioToolBySlug: (slug: string) => Promise<ComposioToolSchema | null>;
  composioToolSchemaObservedAt: (tool: ComposioToolSchema) => number | undefined;
};

function here(): string {
  return typeof import_meta_url === 'string'
    ? fileURLToPath(import_meta_url)
    : fileURLToPath(import.meta.url);
}

declare const import_meta_url: string | undefined;

function findPackageRoot(startFile: string): string {
  let dir = path.dirname(startFile);
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (pkg.name === 'clemmy') return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('attested transport could not resolve the clemmy package root');
}

function loadComposioClient(): ComposioClientSurface {
  const root = findPackageRoot(here());
  const req = createRequire(path.join(root, 'package.json'));
  const distClient = path.join(root, 'dist', 'integrations', 'composio', 'client.js');
  if (existsSync(distClient)) {
    return req(distClient) as ComposioClientSurface;
  }
  throw new Error('attested transport could not resolve the packaged provider client');
}

function loopbackOutboundDenied(): boolean {
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
    const value = process.env[key] ?? '';
    if (/^https?:\/\/127\.0\.0\.1:9(?:\/|$)/.test(value)) return true;
  }
  return false;
}

export async function executeAttestedTransport(call: AttestedTransportCall): Promise<unknown> {
  if (loopbackOutboundDenied()) {
    throw new Error(`${call.operationId} transport unavailable`);
  }
  if (call.accountId.startsWith('host:')) {
    throw new Error('consequential call requires a sealed provider account');
  }
  const client = loadComposioClient();
  if (!client.isComposioEnabled()) {
    throw new Error(`${call.operationId} transport unavailable`);
  }
  return client.executeComposioTool(call.operationId, call.args, call.accountId);
}

/** Observations this transport actually made, keyed by operation and account. */
const observed = new Map<string, AttestedTransportObservation>();

function observationKey(operationId: string, accountId: string): string {
  return `${operationId}\0${accountId}`;
}

/**
 * The exact connected account for this operation, or null.
 *
 * Ambiguity is not agreement: if the toolkit does not resolve to exactly one
 * connection, or that connection is not the sealed account, there is nothing
 * honest to observe.
 */
function resolveConnectedAccount(client: ComposioClientSurface, input: {
  operationId: string;
  accountId: string;
}): string | null {
  const toolkit = input.operationId.split('_')[0]?.toLowerCase() ?? '';
  if (!toolkit) return null;
  const matched = client.peekConnectedToolkits().filter((row) => {
    const slug = String((row as { slug?: unknown }).slug ?? '').toLowerCase();
    return slug.includes(toolkit);
  });
  if (matched.length !== 1) return null;
  const accountId = String(
    (matched[0] as { connectionId?: unknown }).connectionId
    ?? (matched[0] as { accountEmail?: unknown }).accountEmail
    ?? '',
  ).trim();
  if (!accountId || accountId !== input.accountId) return null;
  return accountId;
}

export function observeAttestedTransport(input: {
  operationId: string;
  accountId: string;
}): AttestedTransportObservation | null {
  return observed.get(observationKey(input.operationId, input.accountId)) ?? null;
}

/**
 * Contact the provider and record what it reports.
 *
 * The schema fingerprint is derived from the provider's own declared input
 * parameters, never from the local capability manifest — a manifest echo would
 * prove only that we can read our own bytes.
 */
export async function refreshAttestedTransportObservation(input: {
  operationId: string;
  accountId: string;
}): Promise<AttestedTransportObservation | null> {
  observed.delete(observationKey(input.operationId, input.accountId));
  if (loopbackOutboundDenied()) return null;
  try {
    const client = loadComposioClient();
    if (!client.isComposioEnabled()) return null;
    const accountId = resolveConnectedAccount(client, input);
    if (!accountId) return null;
    const tool = await client.getComposioToolBySlug(input.operationId);
    if (!tool || tool.slug !== input.operationId || tool.inputParameters === undefined) return null;
    const observedAt = client.composioToolSchemaObservedAt(tool);
    if (typeof observedAt !== 'number' || !Number.isFinite(observedAt) || observedAt <= 0) return null;
    const definitionFingerprint = createHash('sha256')
      .update(JSON.stringify({ slug: tool.slug, inputParameters: tool.inputParameters }), 'utf8')
      .digest('hex');
    const observation: AttestedTransportObservation = {
      operationId: input.operationId,
      accountId,
      definitionFingerprint,
      providerVersion: PROVIDER_VERSION,
      operationVersion: definitionFingerprint.slice(0, 16),
      observedAt,
    };
    observed.set(observationKey(input.operationId, accountId), observation);
    return observation;
  } catch {
    return null;
  }
}

export async function reconcileAttestedTransport(
  input: AttestedTransportReconcile,
): Promise<AttestedTransportReconcileResult> {
  const id = input.artifactId.trim();
  if (!id) return { exists: false };
  try {
    const result = await executeAttestedTransport({
      operationId: input.operationId,
      args: { spreadsheet_id: id },
      accountId: input.accountId,
    });
    const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const returned = String(record.spreadsheet_id ?? record.spreadsheetId ?? record.id ?? '').trim();
    if (!returned || returned !== id) return { exists: false };
    return {
      exists: true,
      artifactId: id,
      handle: typeof record.spreadsheet_url === 'string' ? record.spreadsheet_url : undefined,
      receipt: typeof record.receipt === 'string' ? record.receipt : undefined,
    };
  } catch {
    return { exists: false };
  }
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
