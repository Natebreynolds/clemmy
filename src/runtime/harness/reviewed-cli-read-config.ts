/**
 * Durable, provider-neutral reviewed CLI read configuration.
 *
 * PATH discovery and saved bare CLI names never enter this registry. A row is
 * authority only after an operator-facing provisioning caller supplies the
 * complete closed argument contract and explicitly declares the read effect.
 * Provisioning resolves the executable to one real file and records its bytes;
 * every later observation and crossing revalidates both facts.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import { BASE_DIR } from '../../config.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { atomicJsonMutate } from '../atomic-json.js';
import {
  openCanonicalArguments,
  sealCanonicalArguments,
} from './authority-argument-seal.js';

export const REVIEWED_CLI_READ_CONFIG_VERSION = 1 as const;
export const REVIEWED_CLI_READ_ACCOUNT = 'reviewed_cli:host' as const;
export const REVIEWED_CLI_READ_CARRIER = 'reviewed-cli-config' as const;
export const REVIEWED_CLI_ARGUMENT_COMPILER_ID = 'host:reviewed-cli-structured-argv:v1' as const;

const MAX_DESCRIPTORS = 1_000;
const MAX_ARGUMENTS = 128;
const MAX_PREFIX_TOKENS = 128;
const MAX_IDENTITY_BYTES = 512;
const MAX_DESCRIPTION_BYTES = 16_384;
const MAX_TOKEN_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const HASH_BUFFER_BYTES = 64 * 1024;
const CLOSED_OPTIONS = Object.freeze({
  maxDepth: 12,
  maxNodes: 25_000,
  maxStringBytes: MAX_TOKEN_BYTES,
  maxTotalBytes: 4 * 1024 * 1024,
});

export type ReviewedCliArgumentValueType = 'string' | 'number' | 'integer' | 'boolean';
export type ReviewedCliArgumentKind = 'option' | 'positional' | 'switch';

/** One generic ordered structured-argv compiler row. `token` is null only for
 * positional values. No row can provide a shell string, cwd, or environment. */
export interface ReviewedCliArgumentV1 {
  name: string;
  kind: ReviewedCliArgumentKind;
  token: string | null;
  valueType: ReviewedCliArgumentValueType;
  required: boolean;
}

export interface ReviewedCliReadDescriptorV1 {
  version: typeof REVIEWED_CLI_READ_CONFIG_VERSION;
  descriptorId: string;
  operationId: string;
  displayName: string;
  description: string;
  effect: 'read';
  accountId: typeof REVIEWED_CLI_READ_ACCOUNT;
  executableRealpath: string;
  binarySha256: string;
  argvPrefix: readonly string[];
  arguments: readonly ReviewedCliArgumentV1[];
  limits: {
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    maxArgumentBytes: number;
  };
}

interface SealedReviewedCliReadDescriptorV1 {
  version: typeof REVIEWED_CLI_READ_CONFIG_VERSION;
  descriptor: ReviewedCliReadDescriptorV1;
  authoritySeal: string;
}

interface ReviewedCliReadConfigFileV1 {
  version: typeof REVIEWED_CLI_READ_CONFIG_VERSION;
  descriptors: SealedReviewedCliReadDescriptorV1[];
}

export interface ProvisionReviewedCliReadDescriptorInputV1 {
  version: typeof REVIEWED_CLI_READ_CONFIG_VERSION;
  descriptorId: string;
  operationId: string;
  displayName: string;
  description: string;
  effect: 'read';
  accountId: typeof REVIEWED_CLI_READ_ACCOUNT;
  /** Must be absolute. Provisioning stores its resolved realpath, never a bare
   * name or a PATH-dependent lookup. */
  executablePath: string;
  argvPrefix: readonly string[];
  arguments: readonly ReviewedCliArgumentV1[];
  limits: ReviewedCliReadDescriptorV1['limits'];
}

export interface ReviewedCliExecutableIdentity {
  executableRealpath: string;
  binarySha256: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function boundedText(value: unknown, maxBytes = MAX_IDENTITY_BYTES): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function closedArray(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value) || value.length > max || Object.getOwnPropertySymbols(value).length > 0) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => (
    key !== 'length' && (!/^\d+$/.test(key) || Number(key) >= value.length)
  ))) return null;
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function closeArgument(value: unknown): ReviewedCliArgumentV1 | null {
  if (
    !plainRecord(value)
    || Object.getOwnPropertySymbols(value).length > 0
    || !exactKeys(value, ['name', 'kind', 'token', 'valueType', 'required'])
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => entry.get || entry.set)
  ) return null;
  const { name, kind, token, valueType, required } = value;
  if (
    !boundedText(name)
    || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)
    || (kind !== 'option' && kind !== 'positional' && kind !== 'switch')
    || (valueType !== 'string' && valueType !== 'number' && valueType !== 'integer' && valueType !== 'boolean')
    || typeof required !== 'boolean'
    || (kind === 'positional' ? token !== null : !boundedText(token, MAX_TOKEN_BYTES))
    || (kind === 'switch' && valueType !== 'boolean')
  ) return null;
  return Object.freeze({
    name,
    kind,
    token: kind === 'positional' ? null : token as string,
    valueType,
    required,
  });
}

function closeLimits(value: unknown): ReviewedCliReadDescriptorV1['limits'] | null {
  if (
    !plainRecord(value)
    || Object.getOwnPropertySymbols(value).length > 0
    || !exactKeys(value, ['timeoutMs', 'maxStdoutBytes', 'maxStderrBytes', 'maxArgumentBytes'])
  ) return null;
  const integer = (candidate: unknown, min: number, max: number): candidate is number => (
    typeof candidate === 'number'
    && Number.isSafeInteger(candidate)
    && candidate >= min
    && candidate <= max
  );
  if (
    !integer(value.timeoutMs, 1, MAX_TIMEOUT_MS)
    || !integer(value.maxStdoutBytes, 1, MAX_OUTPUT_BYTES)
    || !integer(value.maxStderrBytes, 1, MAX_OUTPUT_BYTES)
    || !integer(value.maxArgumentBytes, 1, MAX_TOKEN_BYTES)
  ) return null;
  return Object.freeze({
    timeoutMs: value.timeoutMs,
    maxStdoutBytes: value.maxStdoutBytes,
    maxStderrBytes: value.maxStderrBytes,
    maxArgumentBytes: value.maxArgumentBytes,
  });
}

export function closeReviewedCliReadDescriptor(
  value: unknown,
): ReviewedCliReadDescriptorV1 | null {
  if (
    !plainRecord(value)
    || Object.getOwnPropertySymbols(value).length > 0
    || !exactKeys(value, [
      'version', 'descriptorId', 'operationId', 'displayName', 'description',
      'effect', 'accountId', 'executableRealpath', 'binarySha256', 'argvPrefix',
      'arguments', 'limits',
    ])
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => entry.get || entry.set)
  ) return null;
  const prefix = closedArray(value.argvPrefix, MAX_PREFIX_TOKENS);
  const argumentRows = closedArray(value.arguments, MAX_ARGUMENTS);
  const limits = closeLimits(value.limits);
  if (
    value.version !== REVIEWED_CLI_READ_CONFIG_VERSION
    || !boundedText(value.descriptorId)
    || !boundedText(value.operationId)
    || !boundedText(value.displayName)
    || typeof value.description !== 'string'
    || value.description !== value.description.trim()
    || Buffer.byteLength(value.description, 'utf8') > MAX_DESCRIPTION_BYTES
    || value.effect !== 'read'
    || value.accountId !== REVIEWED_CLI_READ_ACCOUNT
    || !boundedText(value.executableRealpath, MAX_TOKEN_BYTES)
    || !path.isAbsolute(value.executableRealpath)
    || path.resolve(value.executableRealpath) !== value.executableRealpath
    || typeof value.binarySha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.binarySha256)
    || !prefix
    || prefix.some((token) => !boundedText(token, MAX_TOKEN_BYTES))
    || !argumentRows
    || !limits
  ) return null;
  const args = argumentRows.map(closeArgument);
  if (
    args.some((row) => !row)
    || new Set(args.map((row) => row!.name)).size !== args.length
  ) return null;
  const closed: ReviewedCliReadDescriptorV1 = {
    version: REVIEWED_CLI_READ_CONFIG_VERSION,
    descriptorId: value.descriptorId,
    operationId: value.operationId,
    displayName: value.displayName,
    description: value.description,
    effect: 'read',
    accountId: REVIEWED_CLI_READ_ACCOUNT,
    executableRealpath: value.executableRealpath,
    binarySha256: value.binarySha256,
    argvPrefix: Object.freeze(prefix as string[]),
    arguments: Object.freeze(args as ReviewedCliArgumentV1[]),
    limits,
  };
  try {
    return Object.freeze(JSON.parse(closedCanonicalJson(closed, CLOSED_OPTIONS)) as ReviewedCliReadDescriptorV1);
  } catch {
    return null;
  }
}

function closeSealedDescriptor(value: unknown): SealedReviewedCliReadDescriptorV1 | null {
  if (
    !plainRecord(value)
    || !exactKeys(value, ['version', 'descriptor', 'authoritySeal'])
    || value.version !== REVIEWED_CLI_READ_CONFIG_VERSION
    || typeof value.authoritySeal !== 'string'
    || Buffer.byteLength(value.authoritySeal, 'utf8') > 48_000
  ) return null;
  const descriptor = closeReviewedCliReadDescriptor(value.descriptor);
  if (!descriptor) return null;
  let opened: Record<string, unknown> | null;
  try {
    opened = openCanonicalArguments(value.authoritySeal);
  } catch {
    return null;
  }
  if (
    !opened
    || !exactKeys(opened, ['domain', 'descriptorDigest'])
    || opened.domain !== 'reviewed-cli-read-descriptor:v1'
    || opened.descriptorDigest !== reviewedCliDescriptorDigest(descriptor)
  ) return null;
  return Object.freeze({
    version: REVIEWED_CLI_READ_CONFIG_VERSION,
    descriptor,
    authoritySeal: value.authoritySeal,
  });
}

function closeConfigFile(value: unknown): ReviewedCliReadConfigFileV1 | null {
  if (!plainRecord(value) || !exactKeys(value, ['version', 'descriptors'])) return null;
  const rows = closedArray(value.descriptors, MAX_DESCRIPTORS);
  if (value.version !== REVIEWED_CLI_READ_CONFIG_VERSION || !rows) return null;
  const descriptors = rows.map(closeSealedDescriptor);
  if (
    descriptors.some((entry) => !entry)
    || new Set(descriptors.map((entry) => entry!.descriptor.descriptorId)).size !== descriptors.length
  ) return null;
  return {
    version: REVIEWED_CLI_READ_CONFIG_VERSION,
    descriptors: (descriptors as SealedReviewedCliReadDescriptorV1[])
      .sort((left, right) => left.descriptor.descriptorId.localeCompare(right.descriptor.descriptorId)),
  };
}

export function reviewedCliReadConfigPath(): string {
  return path.join(BASE_DIR, 'state', 'reviewed-cli-read-descriptors.json');
}

export function listReviewedCliReadDescriptors(
  filePath = reviewedCliReadConfigPath(),
): readonly ReviewedCliReadDescriptorV1[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('reviewed CLI descriptor registry is malformed');
  }
  const closed = closeConfigFile(parsed);
  if (!closed) throw new Error('reviewed CLI descriptor registry is not closed reviewed data');
  return Object.freeze(closed.descriptors.map((entry) => Object.freeze(entry.descriptor)));
}

function hashOpenFile(fd: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let position = 0;
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, position);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  return hash.digest('hex');
}

/** Resolve and hash a stable executable file. A symlink at the stored realpath,
 * a non-executable file, or a path replacement during hashing is refused. */
export function observeReviewedCliExecutable(
  executablePath: string,
): ReviewedCliExecutableIdentity | null {
  if (!path.isAbsolute(executablePath) || executablePath.includes('\0')) return null;
  let real: string;
  try {
    real = realpathSync(executablePath);
  } catch {
    return null;
  }
  let fd = -1;
  try {
    fd = openSync(real, 'r');
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || (before.mode & 0o111n) === 0n) return null;
    const binarySha256 = hashOpenFile(fd);
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = realpathSync(real);
    const pathStats = statSync(real, { bigint: true });
    if (
      pathAfter !== real
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || after.dev !== pathStats.dev
      || after.ino !== pathStats.ino
      || after.size !== pathStats.size
      || after.mtimeNs !== pathStats.mtimeNs
    ) return null;
    return Object.freeze({
      executableRealpath: real,
      binarySha256,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
    });
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

export function reviewedCliDescriptorDigest(descriptor: ReviewedCliReadDescriptorV1): string {
  const closed = closeReviewedCliReadDescriptor(descriptor);
  if (!closed) throw new Error('reviewed CLI descriptor is invalid');
  return createHash('sha256')
    .update(closedCanonicalJson(closed, CLOSED_OPTIONS), 'utf8')
    .digest('hex');
}

export function currentReviewedCliDescriptor(
  descriptor: ReviewedCliReadDescriptorV1,
): ReviewedCliReadDescriptorV1 | null {
  const closed = closeReviewedCliReadDescriptor(descriptor);
  if (!closed) return null;
  const executable = observeReviewedCliExecutable(closed.executableRealpath);
  if (
    !executable
    || executable.executableRealpath !== closed.executableRealpath
    || executable.binarySha256 !== closed.binarySha256
  ) return null;
  return closed;
}

function descriptorFromProvisioning(
  input: ProvisionReviewedCliReadDescriptorInputV1,
): ReviewedCliReadDescriptorV1 {
  if (
    !plainRecord(input)
    || Object.getOwnPropertySymbols(input).length > 0
    || !exactKeys(input, [
      'version', 'descriptorId', 'operationId', 'displayName', 'description',
      'effect', 'accountId', 'executablePath', 'argvPrefix', 'arguments', 'limits',
    ])
    || Object.values(Object.getOwnPropertyDescriptors(input)).some((entry) => entry.get || entry.set)
  ) throw new TypeError('reviewed CLI provisioning input is not closed data');
  if (!path.isAbsolute(input.executablePath)) {
    throw new TypeError('reviewed CLI executable must be an absolute path');
  }
  const executable = observeReviewedCliExecutable(input.executablePath);
  if (!executable) throw new Error('reviewed CLI executable is absent, mutable, or not executable');
  const closed = closeReviewedCliReadDescriptor({
    version: input.version,
    descriptorId: input.descriptorId,
    operationId: input.operationId,
    displayName: input.displayName,
    description: input.description,
    effect: input.effect,
    accountId: input.accountId,
    executableRealpath: executable.executableRealpath,
    binarySha256: executable.binarySha256,
    argvPrefix: input.argvPrefix,
    arguments: input.arguments,
    limits: input.limits,
  });
  if (!closed) throw new TypeError('reviewed CLI descriptor contract is invalid');
  return closed;
}

/**
 * The provisioning seam. Product UI/CLI code may call this after a human has
 * reviewed the complete descriptor; no discovery path calls it automatically.
 */
export async function provisionReviewedCliReadDescriptor(
  input: ProvisionReviewedCliReadDescriptorInputV1,
  options: { filePath?: string } = {},
): Promise<ReviewedCliReadDescriptorV1> {
  const descriptor = descriptorFromProvisioning(input);
  const sealed: SealedReviewedCliReadDescriptorV1 = Object.freeze({
    version: REVIEWED_CLI_READ_CONFIG_VERSION,
    descriptor,
    authoritySeal: sealCanonicalArguments({
      domain: 'reviewed-cli-read-descriptor:v1',
      descriptorDigest: reviewedCliDescriptorDigest(descriptor),
    }),
  });
  const filePath = options.filePath ?? reviewedCliReadConfigPath();
  await atomicJsonMutate<ReviewedCliReadConfigFileV1>(
    filePath,
    (raw) => {
      const current = closeConfigFile(raw);
      if (!current) throw new Error('reviewed CLI descriptor registry is not closed reviewed data');
      const descriptors = current.descriptors.filter((entry) => (
        entry.descriptor.descriptorId !== descriptor.descriptorId
      ));
      descriptors.push(sealed);
      if (descriptors.length > MAX_DESCRIPTORS) throw new Error('reviewed CLI descriptor registry is full');
      descriptors.sort((left, right) => (
        left.descriptor.descriptorId.localeCompare(right.descriptor.descriptorId)
      ));
      return { version: REVIEWED_CLI_READ_CONFIG_VERSION, descriptors };
    },
    { version: REVIEWED_CLI_READ_CONFIG_VERSION, descriptors: [] },
  );
  chmodSync(filePath, 0o600);
  return descriptor;
}

export async function removeReviewedCliReadDescriptor(
  descriptorId: string,
  options: { filePath?: string } = {},
): Promise<boolean> {
  if (!boundedText(descriptorId)) throw new TypeError('reviewed CLI descriptor id is invalid');
  const filePath = options.filePath ?? reviewedCliReadConfigPath();
  let removed = false;
  await atomicJsonMutate<ReviewedCliReadConfigFileV1>(
    filePath,
    (raw) => {
      const current = closeConfigFile(raw);
      if (!current) throw new Error('reviewed CLI descriptor registry is not closed reviewed data');
      const descriptors = current.descriptors.filter((entry) => entry.descriptor.descriptorId !== descriptorId);
      removed = descriptors.length !== current.descriptors.length;
      return { version: REVIEWED_CLI_READ_CONFIG_VERSION, descriptors };
    },
    { version: REVIEWED_CLI_READ_CONFIG_VERSION, descriptors: [] },
  );
  chmodSync(filePath, 0o600);
  return removed;
}

export function reviewedCliInputSchema(
  descriptor: ReviewedCliReadDescriptorV1,
): Readonly<Record<string, unknown>> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const argument of descriptor.arguments) {
    properties[argument.name] = Object.freeze({ type: argument.valueType === 'integer' ? 'integer' : argument.valueType });
    if (argument.required) required.push(argument.name);
  }
  return Object.freeze({
    type: 'object',
    properties: Object.freeze(properties),
    required: Object.freeze(required),
    additionalProperties: false,
  });
}

function encodeArgumentValue(
  value: unknown,
  type: ReviewedCliArgumentValueType,
  maxBytes: number,
): string | null {
  let encoded: string;
  if (type === 'string') {
    if (typeof value !== 'string') return null;
    encoded = value;
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return null;
    encoded = value ? 'true' : 'false';
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (type === 'integer' && !Number.isSafeInteger(value)) return null;
    encoded = String(value);
  }
  if (encoded.includes('\0') || Buffer.byteLength(encoded, 'utf8') > maxBytes) return null;
  return encoded;
}

/** Compile one strict plain object into an argv vector. Spaces, semicolons,
 * pipes, glob characters, and dollar signs remain bytes in one token. */
export function compileReviewedCliArgv(
  descriptor: ReviewedCliReadDescriptorV1,
  args: Record<string, unknown>,
): readonly string[] | null {
  if (!plainRecord(args) || Object.getOwnPropertySymbols(args).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(args);
  if (Object.values(descriptors).some((entry) => entry.get || entry.set || !('value' in entry))) return null;
  const declared = new Set(descriptor.arguments.map((argument) => argument.name));
  if (Object.keys(args).some((key) => !declared.has(key))) return null;
  const argv = [...descriptor.argvPrefix];
  for (const argument of descriptor.arguments) {
    const present = Object.hasOwn(args, argument.name);
    if (!present) {
      if (argument.required) return null;
      continue;
    }
    const value = descriptors[argument.name]!.value;
    if (argument.kind === 'switch') {
      if (typeof value !== 'boolean') return null;
      if (value) argv.push(argument.token!);
      continue;
    }
    const encoded = encodeArgumentValue(value, argument.valueType, descriptor.limits.maxArgumentBytes);
    if (encoded === null) return null;
    if (argument.kind === 'option') argv.push(argument.token!);
    argv.push(encoded);
  }
  return Object.freeze(argv);
}
