/**
 * What an author wrote into a Workspace manifest, apart from upkeep.
 *
 * Refreshing a Workspace and opening it advance operational timestamps on the
 * manifest. Those changes are the host keeping the Workspace current, not an
 * edit, so a proof about what was authored must not be broken by them. Every
 * other manifest field is authoring and stays exact.
 */
import { createHash } from 'node:crypto';

export const WORKSPACE_OPERATIONAL_MANIFEST_KEYS = ['updatedAt', 'lastRefreshedAt', 'lastOpenedAt'] as const;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry === undefined ? null : entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

/** The authoring fields of a manifest document, operational timestamps removed. */
export function workspaceManifestAuthoringFields(manifest: Record<string, unknown>): Record<string, unknown> {
  const authoring: Record<string, unknown> = { ...manifest };
  for (const key of WORKSPACE_OPERATIONAL_MANIFEST_KEYS) delete authoring[key];
  return authoring;
}

/** Digest of a manifest's authoring fields, or null when the bytes are not a
 *  manifest object. */
export function workspaceManifestAuthoringDigest(bytes: Buffer | string): string | null {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return createHash('sha256')
      .update(stableJson(workspaceManifestAuthoringFields(parsed as Record<string, unknown>)))
      .digest('hex');
  } catch {
    return null;
  }
}
