/**
 * Canonical host-owned proof carried by successful local authoring writes.
 *
 * The authoring implementation supplies only the stable created identity and
 * the committed file path. This leaf reopens that path beneath Clementine's
 * local root, derives the relative handle, hashes the bytes that are actually
 * on disk, and stamps those exact facts as the first result line. Consumers
 * still have to prove registered local-write effect and host execution; the
 * marker by itself grants no authority.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

export const HOST_LOCAL_WRITE_COMMIT_PREFIX = '[clementine:host-local-write-commit:v1]' as const;

export interface HostLocalWriteCommitIdentity {
  createdId: string;
  handle: string;
  contentDigest: string;
}

export interface HostLocalWriteCommitFacts extends HostLocalWriteCommitIdentity {
  receipt: string;
}

function canonicalIdentity(input: HostLocalWriteCommitIdentity): string {
  return JSON.stringify({
    version: 1 as const,
    createdId: input.createdId,
    handle: input.handle,
    contentDigest: input.contentDigest,
  });
}

function validCreatedId(createdId: string): boolean {
  return createdId.length > 0
    && createdId.length <= 512
    && createdId === createdId.trim()
    && !/[\u0000-\u001f\u007f]/.test(createdId);
}

function validRelativeHandle(handle: string): boolean {
  return handle.length > 0
    && handle.length <= 1_024
    && handle === handle.trim()
    && !path.posix.isAbsolute(handle)
    && !handle.includes('\\')
    && handle.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** Pure parser used at durable redemption. It accepts only one canonical JSON
 * spelling so alternate encodings cannot create multiple receipt identities. */
export function parseHostLocalWriteCommitFacts(result: unknown): HostLocalWriteCommitFacts | null {
  if (typeof result !== 'string') return null;
  const newline = result.indexOf('\n');
  if (newline < 0) return null;
  const receipt = result.slice(0, newline);
  if (!receipt.startsWith(`${HOST_LOCAL_WRITE_COMMIT_PREFIX} `) || receipt.length > 2_500) return null;
  const encoded = receipt.slice(HOST_LOCAL_WRITE_COMMIT_PREFIX.length + 1);
  try {
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    const createdId = typeof parsed.createdId === 'string' ? parsed.createdId : '';
    const handle = typeof parsed.handle === 'string' ? parsed.handle : '';
    const contentDigest = typeof parsed.contentDigest === 'string' ? parsed.contentDigest : '';
    const identity = { createdId, handle, contentDigest };
    if (
      parsed.version !== 1
      || encoded !== canonicalIdentity(identity)
      || !validCreatedId(createdId)
      || !validRelativeHandle(handle)
      || !/^[a-f0-9]{64}$/.test(contentDigest)
    ) return null;
    return { ...identity, receipt };
  } catch {
    return null;
  }
}

export function hostLocalWriteCommitResultIsProven(result: unknown): boolean {
  return parseHostLocalWriteCommitFacts(result) !== null;
}

/**
 * Stamp a successful result from bytes reopened after the local commit.
 * `rootDir` is a test seam; production uses Clementine's single BASE_DIR so
 * every handle has one provider-neutral namespace across Workspaces,
 * workflows, and future local authoring capabilities.
 */
export function withHostLocalWriteCommitFromFile(input: {
  createdId: string;
  committedPath: string;
  result: string;
  rootDir?: string;
}): string {
  if (!validCreatedId(input.createdId)) {
    throw new Error('Local authoring commit supplied an invalid created id.');
  }
  const root = realpathSync(path.resolve(input.rootDir ?? BASE_DIR));
  const committed = realpathSync(path.resolve(input.committedPath));
  const rel = path.relative(root, committed);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Local authoring commit path is outside the Clementine root.');
  }
  const handle = rel.split(path.sep).join('/');
  if (!validRelativeHandle(handle)) {
    throw new Error('Local authoring commit produced an invalid relative handle.');
  }
  const stat = statSync(committed);
  if (!stat.isFile()) throw new Error('Local authoring commit target is not a regular file.');
  const reopened = readFileSync(committed);
  const identity: HostLocalWriteCommitIdentity = {
    createdId: input.createdId,
    handle,
    contentDigest: createHash('sha256').update(reopened).digest('hex'),
  };
  return `${HOST_LOCAL_WRITE_COMMIT_PREFIX} ${canonicalIdentity(identity)}\n${input.result}`;
}

/** Test-only fixture constructor for transport tests that do not own a real
 * artifact. Production authoring code must use withHostLocalWriteCommitFromFile. */
export function _withHostLocalWriteCommitFactsForTest(
  input: HostLocalWriteCommitIdentity & { result: string },
): string {
  const line = `${HOST_LOCAL_WRITE_COMMIT_PREFIX} ${canonicalIdentity(input)}`;
  const stamped = `${line}\n${input.result}`;
  if (!parseHostLocalWriteCommitFacts(stamped)) {
    throw new Error('Invalid local-write commit test fixture.');
  }
  return stamped;
}
