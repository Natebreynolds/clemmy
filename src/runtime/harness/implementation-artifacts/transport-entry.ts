/**
 * Production attested transport. Lazy-loads the provider SDK from the
 * installed package root — never from a path relative to this artifact.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED_TRANSPORT_SUPPORT_MARK } from './transport-support.js';
import {
  COMPOSIO_PROVIDER_SURFACE_VERSION,
  fingerprintComposioProviderDefinition,
} from '../../../integrations/composio/provider-definition-identity.js';
import type {
  AttestedTransport,
  AttestedTransportCall,
  AttestedTransportObservation,
  AttestedTransportReconcile,
  AttestedTransportReconcileResult,
} from './attested-transport.js';

void SHIPPED_TRANSPORT_SUPPORT_MARK;

type ComposioToolSchema = {
  slug: string;
  inputParameters?: unknown;
  outputParameters?: unknown;
  version?: string;
};

type ComposioClientSurface = {
  isComposioEnabled: () => boolean;
  peekConnectedToolkits: () => unknown[];
  prepareComposioOneShotDispatch: (input: {
    toolSlug: string;
    args: Record<string, unknown>;
    connectedAccountId: string;
    providerOperationVersion: string;
  }) => unknown;
  executePreparedComposioTool: (prepared: unknown) => Promise<unknown>;
  getExactComposioToolBySlug: (slug: string) => Promise<ComposioToolSchema | null>;
  composioToolSchemaObservedAt: (tool: ComposioToolSchema) => number | undefined;
  composioToolOperationVersion: (tool: ComposioToolSchema) => string | undefined;
};

type NativeMcpCarrierSurface = {
  executeProductionMcpRead: (call: AttestedTransportCall) => Promise<unknown>;
  refreshProductionMcpReadObservation: (input: {
    operationId: string;
    accountId: string;
  }) => Promise<AttestedTransportObservation | null>;
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

function loadNativeMcpCarrier(): NativeMcpCarrierSurface {
  const root = findPackageRoot(here());
  const req = createRequire(path.join(root, 'package.json'));
  const distCarrier = path.join(root, 'dist', 'runtime', 'harness', 'production-mcp-read-carrier.js');
  if (existsSync(distCarrier)) {
    return req(distCarrier) as NativeMcpCarrierSurface;
  }
  throw new Error('attested transport could not resolve the packaged native MCP carrier');
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
  if (call.expected?.providerKind === 'native_mcp') {
    return loadNativeMcpCarrier().executeProductionMcpRead(call);
  }
  const client = loadComposioClient();
  if (!client.isComposioEnabled()) {
    throw new Error(`${call.operationId} transport unavailable`);
  }
  const providerOperationVersion = call.expected?.operationVersion;
  if (!providerOperationVersion) {
    throw new Error(`${call.operationId} transport lacks an exact provider operation version`);
  }
  const prepared = client.prepareComposioOneShotDispatch({
    toolSlug: call.operationId,
    args: call.args,
    connectedAccountId: call.accountId,
    providerOperationVersion,
  });
  return client.executePreparedComposioTool(prepared);
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
 * Deposit an observation this process already established through a
 * trusted, non-transport channel — a proof-provisioned admission that just
 * revalidated a Composio schema, or a host-only capability with no provider
 * to contact at all — so the synchronous observe() above can confirm it
 * without a second live round trip.
 *
 * `independentlyObserveCapability` calls this unconditionally, for every
 * provider kind, before every readiness check; the isolated test transport
 * has always implemented it, and only this production transport did not,
 * which made the call a silent no-op here (shipped-implementation-identity.ts
 * reaches it through an optional `transportModule.registerIsolatedObservation
 * ?.()`). That gap meant `observe()` could never find what registration had
 * just proven and independentlyObserveCapability fell through to null every
 * time — live 2026-08-26: every proof-provisioned Composio capability and the
 * host-only transform manifest refused plan admission with
 * "observation_unavailable" although nothing had thrown, nothing had been
 * skipped, and registration itself always reported ok:true. This mirrors
 * transport-isolated-entry.ts's registerIsolatedObservation exactly, so the
 * one seeding hook independentlyObserveCapability already assumes exists
 * behaves identically whichever transport artifact is loaded.
 */
export function registerIsolatedObservation(observation: AttestedTransportObservation): void {
  observed.set(observationKey(observation.operationId, observation.accountId), observation);
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
    if (input.accountId.startsWith('native_mcp:')) {
      const observation = await loadNativeMcpCarrier().refreshProductionMcpReadObservation(input);
      if (!observation) return null;
      observed.set(observationKey(input.operationId, input.accountId), observation);
      return observation;
    }
    const client = loadComposioClient();
    if (!client.isComposioEnabled()) return null;
    const accountId = resolveConnectedAccount(client, input);
    if (!accountId) return null;
    const tool = await client.getExactComposioToolBySlug(input.operationId);
    if (!tool || tool.slug !== input.operationId || tool.inputParameters === undefined) return null;
    const observedAt = client.composioToolSchemaObservedAt(tool);
    const providerOperationVersion = client.composioToolOperationVersion(tool);
    if (typeof observedAt !== 'number' || !Number.isFinite(observedAt) || observedAt <= 0) return null;
    if (!providerOperationVersion) return null;
    if (!Object.prototype.hasOwnProperty.call(tool, 'outputParameters')
      || tool.outputParameters === undefined) return null;
    const outputSchema = tool.outputParameters === null
      ? null
      : tool.outputParameters && typeof tool.outputParameters === 'object'
          && !Array.isArray(tool.outputParameters)
        ? tool.outputParameters as Record<string, unknown>
        : undefined;
    if (outputSchema === undefined) return null;
    const definitionFingerprint = fingerprintComposioProviderDefinition({
      operationId: input.operationId,
      operationVersion: providerOperationVersion,
      accountId,
      invokePortId: `port:cap:resolved:${input.operationId.toLowerCase()}:${input.operationId}`,
      inputSchema: tool.inputParameters as Record<string, unknown>,
      outputSchema,
    });
    if (!definitionFingerprint) return null;
    const observation: AttestedTransportObservation = {
      operationId: input.operationId,
      accountId,
      definitionFingerprint,
      providerVersion: COMPOSIO_PROVIDER_SURFACE_VERSION,
      operationVersion: providerOperationVersion,
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
