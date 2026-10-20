/** Pure closed retained recovery-semantics codec, never current execution authority. */
export interface CurrentManifestRecoverySemanticsV1 {
  version: 1;
  operationId: string;
  manifestDigest: string;
  basis: 'reversible_operation' | 'exact_artifact_reconciliation';
}

export function parseCurrentManifestRecoverySemantics(
  value: unknown,
): CurrentManifestRecoverySemanticsV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1
    || (row.basis !== 'reversible_operation' && row.basis !== 'exact_artifact_reconciliation')
    || typeof row.operationId !== 'string'
    || !row.operationId.trim()
    || typeof row.manifestDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.manifestDigest)
    || Object.keys(row).some((key) => !['version', 'operationId', 'manifestDigest', 'basis'].includes(key))
    || Object.keys(row).length !== 4
  ) return null;
  return {
    version: 1,
    operationId: row.operationId,
    manifestDigest: row.manifestDigest,
    basis: row.basis,
  };
}
