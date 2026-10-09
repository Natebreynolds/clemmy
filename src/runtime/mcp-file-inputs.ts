import {
  LocalFileSendRefusal,
  looksLikeLocalFilePath,
  readLocalFileToSend,
  resolveLocalFileToSend,
} from './local-file-sending.js';

/**
 * File content an MCP tool takes, from its own input schema: a string the
 * schema declares as encoded bytes (`contentEncoding: "base64"`, `format:
 * "byte"` or `"binary"`, or a `contentMediaType`). When the call fills such
 * a field with the path of a file on this computer, the host reads the file
 * (after the same check every lane uses) and sends its bytes as base64. A
 * field that is a plain string, a URL or already content is sent as given.
 */

/** Inline content is bounded tighter than an upload: it rides in the request. */
export const MCP_INLINE_FILE_MAX_BYTES = 20 * 1024 * 1024;

type Schema = Record<string, unknown>;

function record(value: unknown): Schema | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Schema : null;
}

function declaresFileContent(schema: Schema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type !== undefined && !types.includes('string')) return false;
  return schema.contentEncoding === 'base64'
    || schema.format === 'byte'
    || schema.format === 'binary'
    || (typeof schema.contentMediaType === 'string' && schema.contentMediaType.length > 0);
}

function variants(schema: Schema): Schema[] {
  return ['anyOf', 'oneOf', 'allOf'].flatMap((key) => (Array.isArray(schema[key]) ? schema[key] as unknown[] : []))
    .map(record).filter((entry): entry is Schema => entry !== null);
}

class McpFileInputRefusal extends Error {
  constructor(message: string) {
    super(message);
    // The nominal marker the settlement reads across module boundaries:
    // refused before the request, nothing was sent.
    this.name = 'ProviderPreDispatchRefusalError';
  }
}

function convert(schema: Schema | null, value: unknown, depth: number): { value: unknown; changed: boolean } {
  if (!schema || depth > 32) return { value, changed: false };
  if (typeof value === 'string') {
    const fileSchema = declaresFileContent(schema) ? schema : variants(schema).find(declaresFileContent);
    if (!fileSchema || !looksLikeLocalFilePath(value)) return { value, changed: false };
    try {
      const file = resolveLocalFileToSend(value, { maxBytes: MCP_INLINE_FILE_MAX_BYTES });
      return { value: readLocalFileToSend(file).toString('base64'), changed: true };
    } catch (error) {
      throw new McpFileInputRefusal(
        `${error instanceof LocalFileSendRefusal ? error.message : 'The file could not be read.'} Nothing was sent.`,
      );
    }
  }
  if (Array.isArray(value)) {
    const items = record(schema.items) ?? variants(schema).map((variant) => record(variant.items)).find(Boolean) ?? null;
    let changed = false;
    const out = value.map((item) => {
      const next = convert(items, item, depth + 1);
      changed ||= next.changed;
      return next.value;
    });
    return changed ? { value: out, changed } : { value, changed: false };
  }
  const object = record(value);
  if (object) {
    const properties = record(schema.properties)
      ?? variants(schema).map((variant) => record(variant.properties)).find(Boolean) ?? null;
    if (!properties) return { value, changed: false };
    let changed = false;
    const out: Schema = { ...object };
    for (const [key, item] of Object.entries(object)) {
      const next = convert(record(properties[key]), item, depth + 1);
      if (next.changed) { out[key] = next.value; changed = true; }
    }
    return changed ? { value: out, changed } : { value, changed: false };
  }
  return { value, changed: false };
}

/** The arguments with every declared file-content field that names a local
 * file replaced by that file's bytes; the same object when nothing changes. */
export function mcpArgumentsWithFileContent<T extends Record<string, unknown>>(inputSchema: unknown, args: T): T {
  const converted = convert(record(inputSchema), args, 0);
  return (converted.changed ? converted.value : args) as T;
}
