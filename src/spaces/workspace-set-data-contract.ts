import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Keep the reviewed call below the durable Workspace projection ceiling. */
export const WORKSPACE_SET_DATA_MAX_BYTES = 5 * 1024 * 1024;
export const WORKSPACE_SET_DATA_MAX_SOURCE_CHARS = 120;

const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const SOURCE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ARTIFACT_PREFIX = 'workspace-dataset:v1';
const REFRESH_PREFIX = 'workspace-set-data:v1';
const MAX_JSON_NODES = 200_000;
const MAX_JSON_DEPTH = 64;

/**
 * One schema is shared by the first-class tool and the reviewed workflow
 * carrier. Semantic JSON/source checks below remain necessary because JSON
 * Schema cannot express "this string contains an object/array document".
 */
export const WORKSPACE_SET_DATA_TOOL_PARAMETERS = {
  slug: z.string()
    .min(2)
    .max(63)
    .regex(WORKSPACE_SLUG_RE)
    .describe('The existing active workspace slug.'),
  source_id: z.string()
    .min(1)
    .max(WORKSPACE_SET_DATA_MAX_SOURCE_CHARS)
    .describe('The canonical non-reserved source id to replace.'),
  data_json: z.string()
    .min(1)
    .max(WORKSPACE_SET_DATA_MAX_BYTES)
    .describe('A complete JSON object or array for this source id.'),
};

export interface WorkspaceSetDataArguments {
  slug: string;
  source_id: string;
  data_json: string;
}

export type WorkspaceSetDataContractErrorCode =
  | 'arguments_invalid'
  | 'invalid_slug'
  | 'invalid_source'
  | 'reserved_source'
  | 'invalid_json'
  | 'invalid_json_root'
  | 'json_limit_exceeded';

export class WorkspaceSetDataContractError extends Error {
  constructor(
    readonly code: WorkspaceSetDataContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSetDataContractError';
  }
}

export interface PreparedWorkspaceSetData {
  args: WorkspaceSetDataArguments;
  slug: string;
  sourceId: string;
  data: Record<string, unknown> | unknown[];
  canonicalData: string;
  contentDigest: string;
  argsDigest: string;
  refreshId: string;
}

export interface WorkspaceDatasetArtifactIdentity {
  slug: string;
  sourceId: string;
  argsDigest: string;
  contentDigest: string;
  refreshId: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function utf8(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function canonicalWorkspaceJson(value: unknown): string {
  let nodes = 0;
  const visit = (input: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new WorkspaceSetDataContractError(
        'json_limit_exceeded',
        'data_json exceeds the reviewed JSON traversal limit',
      );
    }
    if (input === null || typeof input === 'string' || typeof input === 'boolean') {
      return JSON.stringify(input);
    }
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (Array.isArray(input)) {
      return `[${input.map((entry) => visit(entry, depth + 1)).join(',')}]`;
    }
    if (input && typeof input === 'object') {
      const object = input as Record<string, unknown>;
      return `{${Object.keys(object).sort().map(
        (key) => `${JSON.stringify(key)}:${visit(object[key], depth + 1)}`,
      ).join(',')}}`;
    }
    throw new WorkspaceSetDataContractError(
      'invalid_json',
      'data_json contains a value outside the JSON domain',
    );
  };
  const canonical = visit(value, 0);
  if (utf8(canonical) > WORKSPACE_SET_DATA_MAX_BYTES) {
    throw new WorkspaceSetDataContractError(
      'json_limit_exceeded',
      `data_json exceeds the ${WORKSPACE_SET_DATA_MAX_BYTES}-byte limit`,
    );
  }
  return canonical;
}

/** Exact digest used by the Workspace observation blob store. */
export function workspaceDataContentDigest(value: unknown): string {
  return sha256(canonicalWorkspaceJson(value));
}

function exactArguments(value: unknown): WorkspaceSetDataArguments {
  const parsed = z.strictObject(WORKSPACE_SET_DATA_TOOL_PARAMETERS).safeParse(value);
  if (!parsed.success) {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    if (typeof record.slug === 'string' && !WORKSPACE_SLUG_RE.test(record.slug)) {
      throw new WorkspaceSetDataContractError('invalid_slug', `invalid workspace slug "${record.slug}"`);
    }
    throw new WorkspaceSetDataContractError(
      'arguments_invalid',
      'space_set_data arguments do not match the closed reviewed schema',
    );
  }
  return parsed.data;
}

/** Validate and close all identity-bearing bytes before any storage lookup. */
export function prepareWorkspaceSetData(
  value: unknown,
): PreparedWorkspaceSetData {
  const args = exactArguments(value);
  if (!WORKSPACE_SLUG_RE.test(args.slug)) {
    throw new WorkspaceSetDataContractError('invalid_slug', `invalid workspace slug "${args.slug}"`);
  }
  const sourceId = args.source_id;
  if (
    sourceId !== sourceId.trim()
    || sourceId.length === 0
    || sourceId.length > WORKSPACE_SET_DATA_MAX_SOURCE_CHARS
    || SOURCE_CONTROL_RE.test(sourceId)
  ) {
    throw new WorkspaceSetDataContractError(
      'invalid_source',
      'source_id must already be canonical, bounded, and free of control characters',
    );
  }
  if (sourceId === '_meta') {
    throw new WorkspaceSetDataContractError(
      'reserved_source',
      '"_meta" is a reserved Workspace source key',
    );
  }
  if (utf8(args.data_json) > WORKSPACE_SET_DATA_MAX_BYTES) {
    throw new WorkspaceSetDataContractError(
      'json_limit_exceeded',
      `data_json exceeds the ${WORKSPACE_SET_DATA_MAX_BYTES}-byte limit`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(args.data_json);
  } catch (error) {
    throw new WorkspaceSetDataContractError(
      'invalid_json',
      `data_json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!data || typeof data !== 'object') {
    throw new WorkspaceSetDataContractError(
      'invalid_json_root',
      'data_json must contain one complete JSON object or array',
    );
  }
  const canonicalData = canonicalWorkspaceJson(data);
  const contentDigest = sha256(canonicalData);
  const argsDigest = sha256([
    `${ARTIFACT_PREFIX}\0`,
    args.slug,
    '\0',
    sourceId,
    '\0',
    canonicalData,
  ].join(''));
  return Object.freeze({
    args: Object.freeze({ ...args }),
    slug: args.slug,
    sourceId,
    data: data as Record<string, unknown> | unknown[],
    canonicalData,
    contentDigest,
    argsDigest,
    refreshId: `${REFRESH_PREFIX}:${argsDigest}`,
  });
}

function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeSegment(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return encodeSegment(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

export function workspaceDatasetArtifactId(
  value: Pick<PreparedWorkspaceSetData, 'slug' | 'sourceId' | 'argsDigest' | 'contentDigest'>,
): string {
  return [
    ARTIFACT_PREFIX,
    encodeSegment(value.slug),
    encodeSegment(value.sourceId),
    value.argsDigest,
    value.contentDigest,
  ].join(':');
}

export function parseWorkspaceDatasetArtifactId(
  artifactId: string,
): WorkspaceDatasetArtifactIdentity | null {
  const parts = artifactId.split(':');
  if (parts.length !== 6 || `${parts[0]}:${parts[1]}` !== ARTIFACT_PREFIX) return null;
  const slug = decodeSegment(parts[2]!);
  const sourceId = decodeSegment(parts[3]!);
  const argsDigest = parts[4]!;
  const contentDigest = parts[5]!;
  if (
    !slug
    || !WORKSPACE_SLUG_RE.test(slug)
    || sourceId === null
    || sourceId !== sourceId.trim()
    || sourceId.length === 0
    || sourceId.length > WORKSPACE_SET_DATA_MAX_SOURCE_CHARS
    || SOURCE_CONTROL_RE.test(sourceId)
    || sourceId === '_meta'
    || !DIGEST_RE.test(argsDigest)
    || !DIGEST_RE.test(contentDigest)
  ) return null;
  return {
    slug,
    sourceId,
    argsDigest,
    contentDigest,
    refreshId: `${REFRESH_PREFIX}:${argsDigest}`,
  };
}
