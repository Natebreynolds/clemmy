import {
  looksLikeLocalFilePath,
  readLocalFileToSend,
  resolveLocalFileToSend,
} from './local-file-sending.js';
import { isAttachmentSnapshotPath, readSourceOwnedAttachmentFile, sourceOwnedAttachmentFile, type AttachmentFileSource } from './attachment-file-reference.js';

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

/** Display-only counterpart of the same schema rule used at native dispatch. */
export function mcpFileContentField(inputSchema: unknown, field: string, value: unknown): boolean {
  const root = record(inputSchema);
  if (!root) return false;
  const properties = record(root.properties) ?? variants(root).map(variant => record(variant.properties)).find(Boolean);
  const schema = properties ? record(properties[field]) : null;
  if (!schema) return false;
  if (typeof value === 'string') return declaresFileContent(schema) || variants(schema).some(declaresFileContent);
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return false;
  const items = record(schema.items) ?? variants(schema).map(variant => record(variant.items)).find(Boolean);
  return Boolean(items && (declaresFileContent(items) || variants(items).some(declaresFileContent)));
}

class McpFileInputRefusal extends Error {
  constructor(message: string) {
    super(message);
    // The nominal marker the settlement reads across module boundaries:
    // refused before the request, nothing was sent.
    this.name = 'ProviderPreDispatchRefusalError';
  }
}

function convert(schema: Schema | null, value: unknown, depth: number, attachmentSource?: AttachmentFileSource): { value: unknown; changed: boolean } {
  if (!schema || depth > 32) return { value, changed: false };
  if (typeof value === 'string') {
    const fileSchema = declaresFileContent(schema) ? schema : variants(schema).find(declaresFileContent);
    if (!fileSchema || !looksLikeLocalFilePath(value)) return { value, changed: false };
    try {
      if (isAttachmentSnapshotPath(value)) {
        if (!attachmentSource) throw new Error('This request does not own that attachment file.');
        const reference = sourceOwnedAttachmentFile(value.trim(), attachmentSource);
        if (reference.bytes > MCP_INLINE_FILE_MAX_BYTES) throw new Error('The attachment is over the file-content limit.');
        return { value: readSourceOwnedAttachmentFile(reference, attachmentSource).toString('base64'), changed: true };
      }
      const file = resolveLocalFileToSend(value, { maxBytes: MCP_INLINE_FILE_MAX_BYTES });
      return { value: readLocalFileToSend(file).toString('base64'), changed: true };
    } catch (error) {
      throw new McpFileInputRefusal(
        `${error instanceof Error ? error.message : 'The file could not be read.'} Nothing was sent.`,
      );
    }
  }
  if (Array.isArray(value)) {
    const items = record(schema.items) ?? variants(schema).map((variant) => record(variant.items)).find(Boolean) ?? null;
    let changed = false;
    const out = value.map((item) => {
      const next = convert(items, item, depth + 1, attachmentSource);
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
      const next = convert(record(properties[key]), item, depth + 1, attachmentSource);
      if (next.changed) { out[key] = next.value; changed = true; }
    }
    return changed ? { value: out, changed } : { value, changed: false };
  }
  return { value, changed: false };
}

/** The arguments with every declared file-content field that names a local
 * file replaced by that file's bytes; the same object when nothing changes. */
export function mcpArgumentsWithFileContent<T extends Record<string, unknown>>(inputSchema: unknown, args: T, attachmentSource?: AttachmentFileSource): T {
  // A local server may interpret a plain path itself. A snapshot reference
  // cannot bypass ownership merely by appearing outside a byte field. This
  // check confers no conversion or execution authority on that plain field.
  let nodes = 0;
  const checkReferences = (value: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 64) throw new McpFileInputRefusal('File arguments exceed the inspection limit. Nothing was sent.');
    if (typeof value === 'string' && isAttachmentSnapshotPath(value)) {
      try {
        if (!attachmentSource) throw new Error('This request does not own that attachment file. Attach the file to this request.');
        sourceOwnedAttachmentFile(value.trim(), attachmentSource);
      } catch (error) { throw new McpFileInputRefusal(`${error instanceof Error ? error.message : 'Attachment file unavailable.'} Nothing was sent.`); }
    } else if (Array.isArray(value)) for (const item of value) checkReferences(item, depth + 1);
    else if (record(value)) for (const item of Object.values(value as Schema)) checkReferences(item, depth + 1);
  };
  checkReferences(args, 0);
  const converted = convert(record(inputSchema), args, 0, attachmentSource);
  return (converted.changed ? converted.value : args) as T;
}
