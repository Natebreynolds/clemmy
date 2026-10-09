import { loadToolContract } from '../../tools/tool-contract-store.js';
import { planStagedFileUploads } from './staged-file-transfer-plan.js';
import { LocalFileSendRefusal, looksLikeLocalFilePath, resolveLocalFileToSend } from '../../runtime/local-file-sending.js';

/**
 * The local files one Composio call sends: the values at parameters the
 * tool's own schema marks `file_uploadable` that name a file on this
 * computer. A value that is already an uploaded handle or a URL is not one.
 */
export interface ComposioFileInput {
  /** RFC 6901 pointer into the call's arguments. */
  pointer: string;
  path: string;
}

export function readArgumentPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let current: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) current = current[Number(token)];
    else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[token];
    else return undefined;
  }
  return current;
}

export function writeArgumentPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const tokens = pointer.split('/').slice(1).map((raw) => raw.replace(/~1/g, '/').replace(/~0/g, '~'));
  const last = tokens.pop();
  if (last === undefined) return;
  let current: unknown = root;
  for (const token of tokens) {
    current = Array.isArray(current) ? current[Number(token)] : (current as Record<string, unknown> | undefined)?.[token];
  }
  if (Array.isArray(current)) current[Number(last)] = value;
  else if (current && typeof current === 'object') (current as Record<string, unknown>)[last] = value;
}

/** The schema's file inputs that this call fills with a local path. An
 * argument shape the plan cannot read yields none: the provider's own
 * validation answers it. */
export function composioFileInputs(schema: unknown, args: unknown): ComposioFileInput[] {
  if (!schema) return [];
  let nodes: readonly { pointer: string }[];
  try { nodes = planStagedFileUploads(schema, args); } catch { return []; }
  return nodes.flatMap((node) => {
    const value = readArgumentPointer(args, node.pointer);
    return typeof value === 'string' && looksLikeLocalFilePath(value) ? [{ pointer: node.pointer, path: value }] : [];
  });
}

/** The schema a Composio operation was learned with, for finding its file inputs. */
export function composioOperationInputSchema(operationId: string): unknown {
  try { return loadToolContract(operationId)?.schema; } catch { return undefined; }
}

/**
 * The first file this call cannot send, checked before anything is reserved
 * or sent; null when every file input can be sent (or there are none).
 */
export function composioFileInputRefusal(
  schema: unknown,
  args: unknown,
): { pointer: string; refusal: LocalFileSendRefusal } | null {
  for (const input of composioFileInputs(schema, args)) {
    try {
      resolveLocalFileToSend(input.path);
    } catch (error) {
      if (error instanceof LocalFileSendRefusal) return { pointer: input.pointer, refusal: error };
      throw error;
    }
  }
  return null;
}
