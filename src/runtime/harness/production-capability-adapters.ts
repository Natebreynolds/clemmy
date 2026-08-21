/**
 * Adapter-edge implementations for the host-owned production catalog.
 * Provider slugs and connection identity stay here. Graph code never
 * imports them. Isolated/network-denied bootstrap must not cross the
 * provider boundary.
 *
 * Dispatch is sealed per manifest. Node role is advisory dataflow metadata
 * only and never selects another provider operation.
 */
import { liveComposioSchemaFingerprint } from '../../tools/composio-schema-cache.js';
import { loadToolContract } from '../../tools/tool-contract-store.js';
import { persistCapabilityLiveIdentity } from './capability-live-identity.js';
import type { LiveCapabilityObservation } from './production-capability-adapter.js';
import type {
  GraphNodeCapabilityInvoke,
  GraphNodeCapabilityReconcile,
} from './graph-node-capability.js';
import type { GraphNodeInvocationEnvelopeV1 } from './graph-node-envelope.js';
import { attachSemanticContract, type CapabilityManifestV1 } from './capability-manifest.js';
import { isolatedTestContractActive } from './isolated-test-contract.js';
import { requireAttestedTransport } from './implementation-artifacts/attested-transport.js';

export const SHEET_CREATE = 'GOOGLESHEETS_SHEET_FROM_JSON';
export const SHEET_READBACK = 'GOOGLESHEETS_BATCH_GET';
export const SHEET_RECONCILE = 'GOOGLESHEETS_GET_SPREADSHEET_INFO';

export const BETA_PROVIDER_OPERATIONS = {
  locator: 'TAVILY_TAVILY_SEARCH',
  collection: 'TAVILY_TAVILY_EXTRACT',
  transform: 'host_transform',
  create: SHEET_CREATE,
  readback: SHEET_READBACK,
  calendar: 'GOOGLECALENDAR_CREATE_EVENT',
} as const;

export interface ProductionTransportCall {
  operationId: string;
  args: Record<string, unknown>;
  accountId: string;
}

export type ProductionTransport = (call: ProductionTransportCall) => Promise<unknown>;

let installedTransport: ProductionTransport | null = null;

export function installProductionTransport(transport: ProductionTransport | null): void {
  if (!isolatedTestContractActive()) {
    throw new Error('installProductionTransport is not production authority');
  }
  installedTransport = transport;
}

function loopbackOutboundDenied(): boolean {
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
    const value = process.env[key] ?? '';
    if (/^https?:\/\/127\.0\.0\.1:9(?:\/|$)/.test(value)) return true;
  }
  return false;
}

export function productionProviderCrossingAllowed(): boolean {
  if (loopbackOutboundDenied()) return false;
  try {
    requireAttestedTransport();
    return true;
  } catch {
    return isolatedTestContractActive() && installedTransport !== null;
  }
}

function asRecords(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (payload && typeof payload === 'object') {
    const record = payload as { records?: unknown; content?: unknown };
    if (Array.isArray(record.records)) return record.records as Array<Record<string, unknown>>;
    if (Array.isArray(record.content)) return record.content as Array<Record<string, unknown>>;
  }
  return [];
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const nested = (value as { data?: unknown; response?: unknown }).data
    ?? (value as { response?: unknown }).response;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { ...(value as Record<string, unknown>), ...(nested as Record<string, unknown>) };
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function looksLikeContentDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function gridFromSheetPayload(result: unknown): unknown[] {
  const record = asRecord(result);
  if (Array.isArray(record.valueRanges)) {
    const first = record.valueRanges.find((entry) => entry && typeof entry === 'object') as
      | { values?: unknown }
      | undefined;
    if (Array.isArray(first?.values)) return first.values;
  }
  if (Array.isArray(record.values)) return record.values;
  if (Array.isArray(record.content)) return record.content;
  if (Array.isArray(result)) return result;
  return [];
}

export type SheetScalar = string | number | boolean | null;

export function canonicalizeSheetScalar(value: unknown): SheetScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  return String(value);
}

export function canonicalizeSheetGrid(
  records: Array<Record<string, unknown>>,
  fields?: readonly string[],
): { header: string[]; rows: SheetScalar[][]; range: string } {
  const header = fields && fields.length > 0
    ? [...fields]
    : [...new Set(records.flatMap((record) => Object.keys(record)))];
  const rows = records.map((record) => header.map((key) => canonicalizeSheetScalar(record[key])));
  const lastRow = rows.length + 1;
  const lastCol = String.fromCharCode(64 + Math.max(header.length, 1));
  return {
    header,
    rows,
    range: `Sheet1!A1:${lastCol}${lastRow}`,
  };
}

export function gridEquals(
  left: { header: string[]; rows: SheetScalar[][] },
  right: { header: string[]; rows: SheetScalar[][] },
): boolean {
  if (left.header.length !== right.header.length) return false;
  if (left.rows.length !== right.rows.length) return false;
  if (left.header.some((key, index) => key !== right.header[index])) return false;
  return left.rows.every((row, rowIndex) => (
    row.length === right.rows[rowIndex]!.length
    && row.every((cell, column) => cell === right.rows[rowIndex]![column])
  ));
}

export function normalizeSheetGrid(result: unknown): { header: string[]; rows: SheetScalar[][] } {
  const grid = gridFromSheetPayload(result);
  if (grid.length === 0) {
    const records = asRecords(result);
    return canonicalizeSheetGrid(records);
  }
  if (grid.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    return canonicalizeSheetGrid(grid as Array<Record<string, unknown>>);
  }
  const header = Array.isArray(grid[0])
    ? grid[0].map((cell) => String(cell ?? '').trim())
    : [];
  const rows = grid.slice(1).flatMap((row) => {
    if (!Array.isArray(row)) return [];
    return [header.map((_, index) => canonicalizeSheetScalar(row[index]))];
  });
  return { header, rows };
}

export function normalizeSheetRows(result: unknown): Array<Record<string, unknown>> {
  const { header, rows } = normalizeSheetGrid(result);
  return rows.map((row) => {
    const next: Record<string, unknown> = {};
    header.forEach((key, index) => {
      if (key) next[key] = row[index] ?? '';
    });
    return next;
  });
}

function requiredFieldsFromCachedSchema(operationId: string): string[] {
  const live = liveComposioSchemaFingerprint(operationId);
  const contract = loadToolContract(operationId);
  const schema = (contract?.schema && typeof contract.schema === 'object')
    ? contract.schema as { required?: unknown }
    : null;
  if (!live && !schema) return [];
  return Array.isArray(schema?.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function sealedAccount(bindingAccount: string | undefined, manifestAccount: string): string {
  const account = (bindingAccount ?? manifestAccount).trim();
  if (!account) throw new Error('capability is missing a sealed account');
  return account;
}

function sheetArtifactFromProvider(result: unknown): { id: string; handle: string; receipt: string; raw: unknown } {
  const record = asRecord(result);
  const id = firstString(record, ['spreadsheet_id', 'spreadsheetId', 'id']);
  if (!id) throw new Error('sheet adapter returned no exact created id');
  const handle = firstString(record, ['spreadsheet_url', 'spreadsheetUrl', 'url', 'handle'])
    || `https://docs.google.com/spreadsheets/d/${id}`;
  return { id, handle, receipt: canonicalJson(result), raw: result };
}

function locatorFromEnvelope(envelope?: GraphNodeInvocationEnvelopeV1): {
  locator: string;
  query: string;
  fields: readonly string[];
  count: number;
} {
  const fields = envelope?.cardinality?.fields ?? [];
  const count = envelope?.cardinality?.count ?? 0;
  const query = [envelope?.goal.objective ?? '', ...fields].filter(Boolean).join(' ').trim();
  if (!query) throw new Error('source envelope is missing an objective or required fields');
  return {
    locator: `locator:${envelope?.identity.sessionId ?? 'unscoped'}:${envelope?.identity.sourceUserSeq ?? 0}`,
    query,
    fields,
    count,
  };
}

function recordsFromEnvelope(envelope: GraphNodeInvocationEnvelopeV1 | undefined, payload: unknown): Array<Record<string, unknown>> {
  const fromPayload = asRecords(payload);
  if (fromPayload.length > 0) return fromPayload;
  const merged: Array<Record<string, unknown>> = [];
  for (const prior of envelope?.predecessors ?? []) merged.push(...asRecords(prior.value));
  return merged;
}

export function createArgsFromEnvelope(
  envelope: GraphNodeInvocationEnvelopeV1 | undefined,
  payload: unknown,
): {
  title: string;
  sheet_name: string;
  sheet_json: Array<Record<string, unknown>>;
  grid: ReturnType<typeof canonicalizeSheetGrid>;
} {
  const records = recordsFromEnvelope(envelope, payload);
  const title = (envelope?.goal.objective ?? 'Workbook').trim().slice(0, 80) || 'Workbook';
  const grid = canonicalizeSheetGrid(records, envelope?.cardinality?.fields);
  return {
    title,
    sheet_name: 'Sheet1',
    sheet_json: records,
    grid,
  };
}

export function assertDistinctReadyRecords(
  records: Array<Record<string, unknown>>,
  cardinality: { count: number; fields: readonly string[] } | null | undefined,
): void {
  if (!cardinality) {
    if (records.length === 0) throw new Error('collection returned no records');
    return;
  }
  if (records.length !== cardinality.count) {
    throw new Error(`collection cardinality mismatch: expected ${cardinality.count} got ${records.length}`);
  }
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    for (const field of cardinality.fields) {
      const value = record[field];
      if (value == null || String(value).trim() === '') {
        throw new Error(`collection record ${index} is missing required field ${field}`);
      }
    }
    const key = cardinality.fields.map((field) => String(record[field] ?? '')).join('\0');
    if (seen.has(key)) throw new Error('collection records are not distinct');
    seen.add(key);
  }
}

export async function executeSealed(
  operationId: string,
  args: Record<string, unknown>,
  accountId: string,
): Promise<unknown> {
  const attested = (() => {
    try {
      return requireAttestedTransport();
    } catch {
      return null;
    }
  })();
  if (attested) {
    return attested.execute({ operationId, args, accountId });
  }
  if (isolatedTestContractActive() && installedTransport) {
    return installedTransport({ operationId, args, accountId });
  }
  throw new Error(`${operationId} transport unavailable`);
}

export function observeComposioIndependently(operationId: string): LiveCapabilityObservation | 'missing' {
  const definitionFingerprint = liveComposioSchemaFingerprint(operationId);
  if (!definitionFingerprint) return 'missing';
  try {
    const live = requireAttestedTransport().observe({ operationId, accountId: '' });
    if (!live) return 'missing';
    persistCapabilityLiveIdentity({
      operationId,
      providerKind: 'composio',
      definitionFingerprint: live.definitionFingerprint,
      providerVersion: live.providerVersion,
      operationVersion: live.operationVersion,
      accountId: live.accountId,
      providerIdentity: 'composio',
      observedAt: live.observedAt,
    });
    return {
      definitionFingerprint: live.definitionFingerprint,
      providerVersion: live.providerVersion,
      operationVersion: live.operationVersion,
      accountId: live.accountId,
      observedAt: live.observedAt,
    };
  } catch {
    return 'missing';
  }
}

function refuseRoleSwitch(role: string, sealedPurpose: string): void {
  if (role === 'readback' && sealedPurpose === 'locate_source') {
    throw new Error('source capability refuses readback role before transport');
  }
}

export function compileSealedProviderArgs(
  manifest: CapabilityManifestV1,
  envelope: GraphNodeInvocationEnvelopeV1 | undefined,
  payload: unknown,
): Record<string, unknown> {
  if (manifest.effect === 'host_only') {
    return Object.freeze({ compiler: manifest.argumentCompiler.id });
  }
  if (manifest.operationId === BETA_PROVIDER_OPERATIONS.locator) {
    const query = locatorFromEnvelope(envelope);
    return Object.freeze({
      query: query.query,
      fields: [...query.fields],
      count: query.count,
    });
  }
  if (manifest.operationId === BETA_PROVIDER_OPERATIONS.collection) {
    const locator = envelope?.predecessors
      .map((prior) => prior.value)
      .find((value) => value && typeof value === 'object' && 'locator' in (value as object))
      ?? payload;
    if (!locator || typeof locator !== 'object' || !('locator' in (locator as object))) {
      throw new Error('collection requires a locator predecessor');
    }
    return Object.freeze({
      locator: (locator as { locator: unknown }).locator,
      query: (locator as { query?: unknown }).query ?? '',
    });
  }
  if (manifest.operationId === BETA_PROVIDER_OPERATIONS.create) {
    const args = createArgsFromEnvelope(envelope, payload);
    return Object.freeze({
      title: args.title,
      sheet_name: args.sheet_name,
      sheet_json: args.sheet_json,
    });
  }
  if (manifest.operationId === BETA_PROVIDER_OPERATIONS.readback) {
    const predecessor = envelope?.predecessors.find((prior) => (
      prior.value && typeof prior.value === 'object' && 'id' in (prior.value as object)
    ))?.value as { id?: unknown; range?: unknown } | undefined;
    const id = typeof payload === 'string'
      ? payload
      : String((payload as { id?: unknown })?.id ?? predecessor?.id ?? '');
    const range = typeof (payload as { range?: unknown })?.range === 'string'
      ? String((payload as { range: string }).range)
      : typeof predecessor?.range === 'string'
        ? String(predecessor.range)
        : envelope?.cardinality
          ? canonicalizeSheetGrid([], envelope.cardinality.fields).range
          : 'Sheet1!A1:Z1000';
    return Object.freeze({
      spreadsheet_id: id,
      ranges: [range],
    });
  }
  return Object.freeze({ digest: JSON.stringify(payload ?? null) });
}

export function invokeForSealedManifest(manifest: CapabilityManifestV1): GraphNodeCapabilityInvoke {
  const sealed = Object.freeze({
    manifestId: manifest.manifestId,
    operationId: manifest.operationId,
    purpose: manifest.purpose,
    effect: manifest.effect,
    accountId: manifest.accountId,
    invokePortId: manifest.invokePortId,
    argumentCompiler: manifest.argumentCompiler,
    acceptedInputKinds: Object.freeze([...manifest.acceptedInputKinds]),
    producedOutputKinds: Object.freeze([...manifest.producedOutputKinds]),
  });
  return async ({ payload, role, envelope, binding, authority }) => {
    refuseRoleSwitch(role, sealed.purpose);
    if (binding.capabilityId && binding.capabilityId !== sealed.manifestId) {
      throw new Error('invoke port is bound to a different capability identity');
    }
    if (authority) {
      if (authority.operationId !== sealed.operationId) {
        throw new Error('invoke authority operation does not match the sealed manifest');
      }
      if (authority.accountId !== sealed.accountId) {
        throw new Error('invoke authority account does not match the sealed manifest');
      }
      if (authority.capabilityRef !== sealed.manifestId) {
        throw new Error('invoke authority capability does not match the sealed manifest');
      }
      if (authority.invokePortId !== sealed.invokePortId) {
        throw new Error('invoke authority port does not match the sealed manifest');
      }
    }
    const accountId = sealedAccount(
      authority?.accountId ?? binding.account ?? envelope?.binding.account,
      sealed.accountId,
    );
    if (accountId !== sealed.accountId) {
      throw new Error('invoke account does not match the sealed manifest account');
    }
    if (sealed.operationId === BETA_PROVIDER_OPERATIONS.locator) {
      const compiled = authority?.canonicalArgs ?? compileSealedProviderArgs(
        { ...manifest, operationId: sealed.operationId, effect: sealed.effect, argumentCompiler: sealed.argumentCompiler, invokePortId: sealed.invokePortId, accountId: sealed.accountId } as CapabilityManifestV1,
        envelope,
        payload,
      );
      const query = {
        query: String(compiled.query ?? ''),
        fields: Array.isArray(compiled.fields) ? compiled.fields.map((entry) => String(entry)) : [],
        count: typeof compiled.count === 'number' ? compiled.count : 0,
        locator: locatorFromEnvelope(envelope).locator,
      };
      const result = await executeSealed(sealed.operationId, {
        query: query.query,
        fields: [...query.fields],
        count: query.count,
      }, accountId);
      const record = asRecord(result);
      const locator = firstString(record, ['locator']) || query.locator;
      return { locator, query: firstString(record, ['query']) || query.query, fields: query.fields, count: query.count };
    }
    if (sealed.operationId === BETA_PROVIDER_OPERATIONS.collection) {
      const compiled = authority?.canonicalArgs ?? compileSealedProviderArgs(manifest, envelope, payload);
      const result = await executeSealed(sealed.operationId, {
        locator: compiled.locator,
        query: compiled.query ?? '',
      }, accountId);
      const records = asRecords(result);
      assertDistinctReadyRecords(records, envelope?.cardinality);
      return { records };
    }
    if (sealed.effect === 'host_only' || sealed.operationId === BETA_PROVIDER_OPERATIONS.transform) {
      return asRecords(payload);
    }
    if (sealed.operationId === BETA_PROVIDER_OPERATIONS.create) {
      const args = createArgsFromEnvelope(envelope, payload);
      assertDistinctReadyRecords(args.sheet_json, envelope?.cardinality);
      const required = requiredFieldsFromCachedSchema(sealed.operationId);
      const createArgs = authority?.canonicalArgs ?? {
        title: args.title,
        sheet_name: args.sheet_name,
        sheet_json: args.sheet_json,
      };
      for (const field of required) {
        if (!(field in createArgs) || (createArgs as Record<string, unknown>)[field] == null) {
          throw new Error(`create missing required field ${field}`);
        }
      }
      const result = await executeSealed(sealed.operationId, createArgs, accountId);
      const artifact = sheetArtifactFromProvider(result);
      return {
        ...artifact,
        grid: args.grid,
        range: args.grid.range,
        sheet_name: args.sheet_name,
        providerReceipt: firstString(asRecord(result), ['receipt', 'response_id', 'requestId'])
          || (typeof (result as { receipt?: unknown })?.receipt === 'string'
            ? String((result as { receipt: string }).receipt)
            : undefined),
      };
    }
    if (sealed.operationId === BETA_PROVIDER_OPERATIONS.readback) {
      const predecessor = envelope?.predecessors.find((prior) => (
        prior.value && typeof prior.value === 'object' && 'id' in (prior.value as object)
      ))?.value as { id?: unknown; range?: unknown; sheet_name?: unknown; grid?: unknown } | undefined;
      const id = typeof payload === 'string'
        ? payload
        : String((payload as { id?: unknown })?.id ?? predecessor?.id ?? '');
      if (!id || looksLikeContentDigest(id)) throw new Error('readback requires an exact artifact id');
      const intendedRange = typeof (payload as { range?: unknown })?.range === 'string'
        ? String((payload as { range: string }).range)
        : typeof predecessor?.range === 'string'
          ? String(predecessor.range)
          : envelope?.cardinality
            ? canonicalizeSheetGrid([], envelope.cardinality.fields).range
            : 'Sheet1!A1:Z1000';
      const range = intendedRange;
      try {
        const result = await executeSealed(sealed.operationId, {
          spreadsheet_id: id,
          ranges: [range],
        }, accountId);
        const record = asRecord(result);
        const returnedId = firstString(record, ['spreadsheet_id', 'spreadsheetId', 'id']) || id;
        if (returnedId !== id) throw new Error('readback spreadsheet id does not match the created id');
        return {
          id,
          handle: firstString(record, ['spreadsheet_url', 'spreadsheetUrl', 'url']) || undefined,
          content: normalizeSheetRows(result),
          grid: normalizeSheetGrid(result),
          range,
          receipt: firstString(record, ['receipt', 'response_id', 'requestId']) || undefined,
          dispatchRef: envelope?.identity.acceptedTaskId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/transport unavailable|account/i.test(message)) {
          throw new Error(`read_transport_failed:${message}`);
        }
        throw error;
      }
    }
    throw new Error(`no sealed invoke for exact operation ${sealed.operationId}`);
  };
}

export function reconcileForSealedManifest(manifest: CapabilityManifestV1): GraphNodeCapabilityReconcile {
  const supported = manifest.reconciliation.supported;
  const policy = manifest.reconciliation.policy;
  const accountId = manifest.accountId;
  const operationId = manifest.operationId === BETA_PROVIDER_OPERATIONS.create
    ? SHEET_RECONCILE
    : manifest.operationId;
  return async ({ artifactId }) => {
    if (!supported || policy === 'uncertain_if_absent') {
      return { exists: false };
    }
    const id = artifactId?.trim() || '';
    if (!id || looksLikeContentDigest(id)) return { exists: false };
    const attested = (() => {
      try {
        return requireAttestedTransport();
      } catch {
        return null;
      }
    })();
    if (!attested) return { exists: false };
    const result = await attested.reconcile({
      artifactId: id,
      accountId,
      operationId,
    });
    if (!result.exists || result.artifactId !== id) return { exists: false };
    return {
      exists: true,
      id: result.artifactId,
      handle: result.handle,
      receipt: result.receipt,
      ...(result.contentDigest ? { contentDigest: result.contentDigest } : {}),
    };
  };
}

export function sealedPortsForManifest(manifest: CapabilityManifestV1): {
  invoke: GraphNodeCapabilityInvoke;
  reconcile?: GraphNodeCapabilityReconcile;
} {
  const write = manifest.effect === 'external_write' || manifest.effect === 'local_write';
  return {
    invoke: invokeForSealedManifest(manifest),
    ...(write ? { reconcile: reconcileForSealedManifest(manifest) } : {}),
  };
}

/** @deprecated Role-switched lookup. Tests should use sealedPortsForManifest. */
export const invokeHostLookup: GraphNodeCapabilityInvoke = async (input) => {
  const purpose = input.role === 'source'
    ? 'locate_source'
    : input.role === 'collection' || input.role === 'collect'
      ? 'collect_records'
      : 'verify_created_resource';
  return invokeForSealedManifest(attachSemanticContract({
    version: 1,
    manifestId: input.binding.capabilityId,
    providerKind: 'local_registry',
    operationId: 'host_lookup',
    providerIdentity: 'local_registry',
    providerVersion: 'host-catalog-v1',
    operationVersion: '1',
    definitionFingerprint: input.binding.schemaDigest,
    effect: 'read',
    accountId: input.binding.account ?? 'host:catalog:source',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: purpose === 'locate_source' ? 'locator' : 'records' },
    purpose,
    acceptedInputKinds: purpose === 'locate_source' ? ['query'] : purpose === 'collect_records' ? ['locator'] : ['created_resource'],
    producedOutputKinds: purpose === 'locate_source' ? ['locator'] : ['records'],
    applicableDeliverableKinds: purpose === 'locate_source' ? ['locator'] : ['records'],
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '1970-01-01T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
  }))(input);
};

export const invokeHostCompute: GraphNodeCapabilityInvoke = async ({ payload }) => {
  return asRecords(payload);
};

export const invokeHostCreate: GraphNodeCapabilityInvoke = async (input) => {
  return invokeForSealedManifest(attachSemanticContract({
    version: 1,
    manifestId: input.binding.capabilityId,
    providerKind: 'local_registry',
    operationId: SHEET_CREATE,
    providerIdentity: 'composio',
    providerVersion: '1',
    operationVersion: '1',
    definitionFingerprint: input.binding.schemaDigest,
    effect: 'external_write',
    accountId: input.binding.account ?? 'acct:beta:sheets:v1',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: false, policy: 'uncertain_if_absent' },
    outputContract: { kind: 'created_resource' },
    purpose: 'persist_collection',
    acceptedInputKinds: ['records'],
    producedOutputKinds: ['created_resource'],
    applicableDeliverableKinds: ['created_resource'],
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    provenance: { issuer: 'host:test', issuedAt: '1970-01-01T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
  }))(input);
};

export const reconcileHostCreate: GraphNodeCapabilityReconcile = async ({ artifactId }) => {
  const id = artifactId?.trim() || '';
  if (!id || looksLikeContentDigest(id)) return { exists: false };
  return { exists: false };
};
