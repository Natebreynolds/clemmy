import { createHash } from 'node:crypto';

import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { isRfc6901Pointer, resolveVerificationPointer } from './mutation-verification-contract.js';
import {
  inspectProviderEnvelope,
  pruneProviderRequestEchoes,
} from './provider-read-evidence.js';

export type AtomicContentCellV1 = string | number | boolean | null;

/**
 * Closed, provider-neutral projection of one created resource identity from a
 * positively acknowledged result.  Adapters author exact pointers and a
 * deterministic handle template; the shared kernel never switches on an
 * operation or provider name.
 */
export interface AtomicResultIdentityProjectionV1 {
  readonly version: 1;
  readonly kind: 'pointer_resource_identity_v1';
  readonly idPointers: readonly string[];
  readonly handlePointers: readonly string[];
  readonly handleTemplate: {
    readonly version: 1;
    readonly kind: 'prefix_suffix_v1';
    readonly prefix: string;
    readonly suffix: string;
  };
}

/**
 * Adapter-authored instructions for compiling one atomic input payload into a
 * durable content claim.  The shared kernel understands only this closed
 * projection language; provider and operation names are deliberately absent.
 */
export interface AtomicInputContentCommitDeclarationV1 {
  readonly version: 1;
  readonly compiler: {
    readonly version: 1;
    readonly kind: 'tabular_record_set_v1';
    /** RFC 6901 pointer to the logical tab/container name. */
    readonly namePointer: string;
    /** RFC 6901 pointer to the complete record array. */
    readonly recordsPointer: string;
    readonly recordsEncoding: 'json_or_value';
    readonly selector: 'a1_grid_v1';
  };
  readonly resultIdentity: AtomicResultIdentityProjectionV1;
  readonly evidence: readonly ['receipt', 'content_commit'];
}

/** Provider-neutral, self-verifying submitted-content contract. */
export interface AtomicTabularRecordSetContentContractV1 {
  readonly kind: 'atomic_tabular_record_set_content_v1';
  readonly compiler: AtomicInputContentCommitDeclarationV1['compiler'];
  readonly resultIdentity: AtomicResultIdentityProjectionV1;
  readonly name: string;
  readonly headers: readonly string[];
  readonly expectedValues: readonly (readonly AtomicContentCellV1[])[];
  /** Exact selector produced by the declared selector compiler. */
  readonly expectedSelector: string;
  readonly submittedContentDigest: string;
}

const MAX_ROWS = 2_048;
const MAX_COLUMNS = 256;
const SHA256 = /^[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function pointerList(value: unknown): string[] | null {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 32
    || !value.every(isRfc6901Pointer)
    || new Set(value).size !== value.length
  ) return null;
  return [...value];
}

export function parseAtomicResultIdentityProjection(
  value: unknown,
): AtomicResultIdentityProjectionV1 | null {
  if (
    !record(value)
    || !exactKeys(value, [
      'version', 'kind', 'idPointers', 'handlePointers', 'handleTemplate',
    ])
    || value.version !== 1
    || value.kind !== 'pointer_resource_identity_v1'
    || !record(value.handleTemplate)
    || !exactKeys(value.handleTemplate, ['version', 'kind', 'prefix', 'suffix'])
    || value.handleTemplate.version !== 1
    || value.handleTemplate.kind !== 'prefix_suffix_v1'
    || typeof value.handleTemplate.prefix !== 'string'
    || !value.handleTemplate.prefix
    || value.handleTemplate.prefix.length > 2_048
    || typeof value.handleTemplate.suffix !== 'string'
    || value.handleTemplate.suffix.length > 1_024
  ) return null;
  const idPointers = pointerList(value.idPointers);
  const handlePointers = pointerList(value.handlePointers);
  if (
    !idPointers
    || !handlePointers
    || [...idPointers, ...handlePointers].length
      !== new Set([...idPointers, ...handlePointers]).size
  ) return null;
  return {
    version: 1,
    kind: 'pointer_resource_identity_v1',
    idPointers,
    handlePointers,
    handleTemplate: {
      version: 1,
      kind: 'prefix_suffix_v1',
      prefix: value.handleTemplate.prefix,
      suffix: value.handleTemplate.suffix,
    },
  };
}

function cell(value: unknown): value is AtomicContentCellV1 {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function decodedJsonOrValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function columnName(columnCount: number): string {
  let value = columnCount;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function quotedName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function contentDigest(input: {
  compiler: AtomicInputContentCommitDeclarationV1['compiler'];
  resultIdentity: AtomicResultIdentityProjectionV1;
  name: string;
  expectedValues: readonly (readonly AtomicContentCellV1[])[];
}): string {
  return createHash('sha256').update(closedCanonicalJson({
    version: 1,
    compiler: input.compiler,
    resultIdentity: input.resultIdentity,
    name: input.name,
    expectedValues: input.expectedValues,
  }), 'utf8').digest('hex');
}

export function parseAtomicInputContentCommitDeclaration(
  value: unknown,
): AtomicInputContentCommitDeclarationV1 | null {
  if (!record(value) || value.version !== 1 || !record(value.compiler)) return null;
  if (
    Object.keys(value).length !== 4
    || !Object.hasOwn(value, 'compiler')
    || !Object.hasOwn(value, 'resultIdentity')
    || !Object.hasOwn(value, 'evidence')
    || Object.keys(value.compiler).length !== 6
    || value.compiler.version !== 1
    || value.compiler.kind !== 'tabular_record_set_v1'
    || !isRfc6901Pointer(value.compiler.namePointer)
    || !isRfc6901Pointer(value.compiler.recordsPointer)
    || value.compiler.namePointer === value.compiler.recordsPointer
    || value.compiler.recordsEncoding !== 'json_or_value'
    || value.compiler.selector !== 'a1_grid_v1'
    || !Array.isArray(value.evidence)
    || value.evidence.length !== 2
    || value.evidence[0] !== 'receipt'
    || value.evidence[1] !== 'content_commit'
  ) return null;
  const resultIdentity = parseAtomicResultIdentityProjection(value.resultIdentity);
  if (!resultIdentity) return null;
  return {
    version: 1,
    compiler: {
      version: 1,
      kind: 'tabular_record_set_v1',
      namePointer: value.compiler.namePointer,
      recordsPointer: value.compiler.recordsPointer,
      recordsEncoding: 'json_or_value',
      selector: 'a1_grid_v1',
    },
    resultIdentity,
    evidence: ['receipt', 'content_commit'],
  };
}

function schemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaPointerPath(pointer: string): string[] | null {
  if (!isRfc6901Pointer(pointer)) return null;
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function requiredSchemaAtPointer(
  schema: unknown,
  pointer: string,
): Record<string, unknown> | null {
  const path = schemaPointerPath(pointer);
  if (!schemaRecord(schema) || !path || path.length === 0) return null;
  let cursor = schema;
  for (const segment of path) {
    const properties = cursor.properties;
    const required = cursor.required;
    if (
      !schemaRecord(properties)
      || !schemaRecord(properties[segment])
      || !Array.isArray(required)
      || !required.includes(segment)
    ) return null;
    cursor = properties[segment] as Record<string, unknown>;
  }
  return cursor;
}

/** Revalidate a sealed generic compiler against the exact current provider
 * input schema. This checks only the closed projection language; provider and
 * operation identity are intentionally absent. */
export function atomicInputContentDeclarationFitsSchema(input: {
  declaration: AtomicInputContentCommitDeclarationV1;
  inputSchema: unknown;
}): boolean {
  const declaration = parseAtomicInputContentCommitDeclaration(input.declaration);
  if (!declaration) return false;
  const name = requiredSchemaAtPointer(input.inputSchema, declaration.compiler.namePointer);
  const records = requiredSchemaAtPointer(input.inputSchema, declaration.compiler.recordsPointer);
  return name?.type === 'string'
    && (records?.type === 'string' || records?.type === 'array');
}

export function compileAtomicInputContentContract(input: {
  declaration: AtomicInputContentCommitDeclarationV1;
  providerArguments: unknown;
}): AtomicTabularRecordSetContentContractV1 | null {
  const declaration = parseAtomicInputContentCommitDeclaration(input.declaration);
  if (!declaration || !record(input.providerArguments)) return null;
  const nameValue = resolveVerificationPointer(
    input.providerArguments,
    declaration.compiler.namePointer,
  );
  const name = typeof nameValue === 'string' ? nameValue.trim() : '';
  if (!name || name.length > 256) return null;
  const rowsValue = decodedJsonOrValue(resolveVerificationPointer(
    input.providerArguments,
    declaration.compiler.recordsPointer,
  ));
  if (!Array.isArray(rowsValue) || rowsValue.length < 1 || rowsValue.length > MAX_ROWS) return null;
  if (!rowsValue.every(record)) return null;

  const headers = Object.keys(rowsValue[0]!);
  if (
    headers.length < 1
    || headers.length > MAX_COLUMNS
    || headers.some((header) => !header || header.length > 256)
    || new Set(headers).size !== headers.length
  ) return null;
  const headerSet = new Set(headers);
  const expectedRows: AtomicContentCellV1[][] = [];
  for (const row of rowsValue) {
    const keys = Object.keys(row);
    if (keys.length !== headers.length || keys.some((key) => !headerSet.has(key))) return null;
    const values = headers.map((header) => row[header]);
    if (!values.every(cell)) return null;
    expectedRows.push(values as AtomicContentCellV1[]);
  }
  const expectedValues = [headers, ...expectedRows] as AtomicContentCellV1[][];
  const expectedSelector = `${quotedName(name)}!A1:${columnName(headers.length)}${expectedValues.length}`;
  const contract = {
    kind: 'atomic_tabular_record_set_content_v1' as const,
    compiler: declaration.compiler,
    resultIdentity: declaration.resultIdentity,
    name,
    headers,
    expectedValues,
    expectedSelector,
    submittedContentDigest: contentDigest({
      compiler: declaration.compiler,
      resultIdentity: declaration.resultIdentity,
      name,
      expectedValues,
    }),
  };
  return parseAtomicTabularRecordSetContentContract(contract);
}

export function parseAtomicTabularRecordSetContentContract(
  value: unknown,
): AtomicTabularRecordSetContentContractV1 | null {
  if (!record(value) || !record(value.compiler)) return null;
  if (
    Object.keys(value).length !== 8
    || value.kind !== 'atomic_tabular_record_set_content_v1'
    || typeof value.name !== 'string'
    || !value.name.trim()
    || value.name !== value.name.trim()
    || value.name.length > 256
    || typeof value.expectedSelector !== 'string'
    || !Array.isArray(value.headers)
    || !Array.isArray(value.expectedValues)
    || typeof value.submittedContentDigest !== 'string'
    || !SHA256.test(value.submittedContentDigest)
  ) return null;
  const resultIdentity = parseAtomicResultIdentityProjection(value.resultIdentity);
  if (!resultIdentity) return null;
  const declaration = parseAtomicInputContentCommitDeclaration({
    version: 1,
    compiler: value.compiler,
    resultIdentity,
    evidence: ['receipt', 'content_commit'],
  });
  if (!declaration) return null;
  const headers = value.headers as unknown[];
  const expectedValues = value.expectedValues as unknown[];
  const headerRow = expectedValues[0];
  if (
    headers.length < 1
    || headers.length > MAX_COLUMNS
    || !headers.every((header) => typeof header === 'string' && header.length > 0 && header.length <= 256)
    || new Set(headers).size !== headers.length
    || expectedValues.length < 2
    || expectedValues.length > MAX_ROWS + 1
    || !expectedValues.every((row) => Array.isArray(row)
      && row.length === headers.length
      && row.every(cell))
    || !Array.isArray(headerRow)
    || !headers.every((header, index) => headerRow[index] === header)
  ) return null;
  const expectedSelector = `${quotedName(value.name)}!A1:${columnName(headers.length)}${expectedValues.length}`;
  if (value.expectedSelector !== expectedSelector) return null;
  const expectedDigest = contentDigest({
    compiler: declaration.compiler,
    resultIdentity,
    name: value.name,
    expectedValues: expectedValues as AtomicContentCellV1[][],
  });
  if (value.submittedContentDigest !== expectedDigest) return null;
  return {
    kind: 'atomic_tabular_record_set_content_v1',
    compiler: declaration.compiler,
    resultIdentity,
    name: value.name,
    headers: headers as string[],
    expectedValues: expectedValues as AtomicContentCellV1[][],
    expectedSelector: value.expectedSelector,
    submittedContentDigest: value.submittedContentDigest,
  };
}

export interface AtomicCreatedResourceIdentityV1 {
  readonly id: string;
  readonly handle: string;
}

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function exactResourceId(value: unknown): string | null {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= 4_096
    && !/\s/.test(value)
    ? value
    : null;
}

function idFromHandle(
  handle: string,
  template: AtomicResultIdentityProjectionV1['handleTemplate'],
): string | null {
  if (!handle.startsWith(template.prefix) || !handle.endsWith(template.suffix)) return null;
  const encoded = handle.slice(
    template.prefix.length,
    handle.length - template.suffix.length,
  );
  if (!encoded) return null;
  try {
    const id = decodeURIComponent(encoded);
    return exactResourceId(id)
      && `${template.prefix}${encodeURIComponent(id)}${template.suffix}` === handle
      ? id
      : null;
  } catch {
    return null;
  }
}

/** Project one exact resource id/handle from an acknowledged provider value. */
export function projectAtomicCreatedResourceIdentity(input: {
  projection: AtomicResultIdentityProjectionV1;
  authoritativeResult: unknown;
}): AtomicCreatedResourceIdentityV1 | null {
  const projection = parseAtomicResultIdentityProjection(input.projection);
  if (!projection) return null;
  const raw = decoded(input.authoritativeResult);
  if (inspectProviderEnvelope(raw).verdict !== 'clean') return null;
  const root = pruneProviderRequestEchoes(raw);
  const ids = new Set<string>();
  const handles = new Set<string>();
  for (const pointer of projection.idPointers) {
    const value = resolveVerificationPointer(root, pointer);
    if (value === undefined) continue;
    const id = exactResourceId(value);
    if (!id) return null;
    ids.add(id);
  }
  for (const pointer of projection.handlePointers) {
    const value = resolveVerificationPointer(root, pointer);
    if (value === undefined) continue;
    if (typeof value !== 'string' || value !== value.trim()) return null;
    const id = idFromHandle(value, projection.handleTemplate);
    if (!id) return null;
    ids.add(id);
    handles.add(value);
  }
  if (ids.size !== 1 || handles.size > 1) return null;
  const id = [...ids][0]!;
  const fallback = `${projection.handleTemplate.prefix}${encodeURIComponent(id)}${projection.handleTemplate.suffix}`;
  const handle = handles.size === 1 ? [...handles][0]! : fallback;
  return { id, handle };
}

/** All and only the source records, independent of object-key order. */
export function atomicTabularContentMatchesSourceRecords(
  contract: AtomicTabularRecordSetContentContractV1,
  sourceRecords: unknown,
): boolean {
  const parsed = parseAtomicTabularRecordSetContentContract(contract);
  if (!parsed || !Array.isArray(sourceRecords) || sourceRecords.length !== parsed.expectedValues.length - 1) {
    return false;
  }
  const submittedRows = parsed.expectedValues.slice(1).map((values) =>
    Object.fromEntries(parsed.headers.map((header, index) => [header, values[index]])));
  try {
    return closedCanonicalJson(submittedRows) === closedCanonicalJson(sourceRecords);
  } catch {
    return false;
  }
}
