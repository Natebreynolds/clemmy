import { digestSchema } from '../../tools/tool-contract-store.js';
import { refreshExactComposioSchemaFromProvider } from '../../tools/composio-schema-cache.js';
import { revalidateSelectedComposioConnections } from './client.js';
import { fingerprintComposioProviderDefinition } from './provider-definition-identity.js';
import {
  parseOperationVerificationContract,
  validateOperationVerificationContractForSchemas,
  type OperationVerificationContractV1,
} from '../../runtime/harness/mutation-verification-contract.js';
import {
  parseCapabilityManifestOperationSemantics,
  validateCapabilityManifestOperationSemanticsForInputSchema,
  type CapabilityManifestOperationSemanticsV1,
} from '../../runtime/harness/capability-manifest.js';

export interface SelectedComposioDefinition {
  identifier: string;
  /** Exact provider input-schema digest exposed to the planning frame. */
  schemaDigest: string;
  accountIdentity: string;
  /** Optional full identity when this ref came from an already-materialized
   * catalog entry. Novel disclosures acquire it at final revalidation. */
  definitionFingerprint?: string;
  outputSchemaDigest?: string | null;
  providerOperationVersion?: string;
  invokePortId?: string;
  /** Presence is significant. Omitted legacy rows never acquire verifier
   * authority from current code; null explicitly declares no authority. */
  verificationContract?: OperationVerificationContractV1 | null;
  /** Presence is significant for the same reason as verificationContract. */
  operationSemantics?: CapabilityManifestOperationSemanticsV1 | null;
}

export interface RevalidatedComposioDefinition extends SelectedComposioDefinition {
  schema: Record<string, unknown>;
  fingerprint: string;
  outputSchema: Record<string, unknown> | null;
  outputSchemaDigest: string | null;
  providerOperationVersion: string;
  invokePortId: string;
  definitionFingerprint: string;
}

export type SelectedComposioRevalidationRefusalCode =
  | 'selected_definition_selection_limit_exceeded'
  | 'selected_definition_identity_conflict'
  | 'selected_definition_digest_invalid'
  | 'selected_connection_refresh_unavailable'
  | 'selected_connection_missing_or_changed'
  | 'selected_connection_inactive_or_suppressed'
  | 'selected_definition_exact_refresh_unavailable'
  | 'selected_definition_schema_drift'
  | 'selected_definition_output_schema_drift'
  | 'selected_definition_operation_version_unavailable'
  | 'selected_definition_operation_version_drift'
  | 'selected_definition_fingerprint_drift'
  | 'selected_definition_semantic_contract_drift';

export type SelectedComposioRevalidationResult =
  | {
      ok: true;
      definitions: ReadonlyMap<string, RevalidatedComposioDefinition>;
    }
  | {
      ok: false;
      refusal: {
        code: SelectedComposioRevalidationRefusalCode;
        identifier: string;
      };
    };

// The accepted plan contract permits 32 operation bindings. Revalidation must
// cover that whole immutable set; an operational batch size is not task
// authority and must never force the model to drop a valid requirement.
const MAX_SELECTED_COMPOSIO_DEFINITIONS = 32;
const SELECTED_DEFINITION_REFRESH_CONCURRENCY = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Final provider-owned proof for the exact Composio refs selected by a plan.
 * Initial-card and foreground-disclosed refs share this one path: one fresh
 * connection snapshot, then one exact schema read per distinct selected slug.
 * Nothing is published until every selected ref has passed.
 */
export async function revalidateSelectedComposioDefinitions(
  selections: readonly SelectedComposioDefinition[],
): Promise<SelectedComposioRevalidationResult> {
  const selected = new Map<string, SelectedComposioDefinition>();
  for (const raw of selections) {
    const identifier = raw.identifier.trim();
    const key = identifier.toLowerCase();
    const schemaDigest = raw.schemaDigest.trim().toLowerCase();
    const accountIdentity = raw.accountIdentity.trim();
    const definitionFingerprint = raw.definitionFingerprint?.trim().toLowerCase();
    const providerOperationVersion = raw.providerOperationVersion?.trim();
    const invokePortId = raw.invokePortId?.trim();
    const outputSchemaWasBound = Object.prototype.hasOwnProperty.call(raw, 'outputSchemaDigest');
    const verificationWasBound = Object.prototype.hasOwnProperty.call(raw, 'verificationContract');
    const operationSemanticsWasBound = Object.prototype.hasOwnProperty.call(raw, 'operationSemantics');
    const outputSchemaDigest = raw.outputSchemaDigest === null
      ? null
      : raw.outputSchemaDigest?.trim().toLowerCase();
    const verificationContract = raw.verificationContract === null
      ? null
      : raw.verificationContract === undefined
        ? undefined
        : parseOperationVerificationContract(raw.verificationContract);
    const operationSemantics = raw.operationSemantics === null
      ? null
      : raw.operationSemantics === undefined
        ? undefined
        : parseCapabilityManifestOperationSemantics(raw.operationSemantics);
    if (!identifier || !/^[a-f0-9]{64}$/.test(schemaDigest) || !accountIdentity) {
      return {
        ok: false,
        refusal: { code: 'selected_definition_digest_invalid', identifier: identifier || key },
      };
    }
    if (
      (definitionFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(definitionFingerprint))
      || (outputSchemaWasBound
        && outputSchemaDigest !== null
        && !/^[a-f0-9]{64}$/.test(outputSchemaDigest ?? ''))
      || (providerOperationVersion !== undefined && !providerOperationVersion)
      || (invokePortId !== undefined && !invokePortId)
      || (verificationWasBound
        && raw.verificationContract !== null
        && !verificationContract)
      || (operationSemanticsWasBound
        && raw.operationSemantics !== null
        && !operationSemantics)
    ) {
      return {
        ok: false,
        refusal: { code: 'selected_definition_digest_invalid', identifier },
      };
    }
    const normalized: SelectedComposioDefinition = {
      identifier,
      schemaDigest,
      accountIdentity,
      ...(definitionFingerprint ? { definitionFingerprint } : {}),
      ...(outputSchemaWasBound ? { outputSchemaDigest: outputSchemaDigest ?? null } : {}),
      ...(providerOperationVersion ? { providerOperationVersion } : {}),
      ...(invokePortId ? { invokePortId } : {}),
      ...(verificationWasBound
        ? { verificationContract: verificationContract ?? null }
        : {}),
      ...(operationSemanticsWasBound
        ? { operationSemantics: operationSemantics ?? null }
        : {}),
    };
    const prior = selected.get(key);
    if (prior && (
      prior.identifier !== normalized.identifier
      || prior.schemaDigest !== normalized.schemaDigest
      || prior.accountIdentity !== normalized.accountIdentity
      || (prior.definitionFingerprint ?? null) !== (normalized.definitionFingerprint ?? null)
      || (prior.outputSchemaDigest ?? null) !== (normalized.outputSchemaDigest ?? null)
      || (prior.providerOperationVersion ?? null) !== (normalized.providerOperationVersion ?? null)
      || (prior.invokePortId ?? null) !== (normalized.invokePortId ?? null)
      || JSON.stringify(prior.verificationContract ?? null)
        !== JSON.stringify(normalized.verificationContract ?? null)
      || Object.prototype.hasOwnProperty.call(prior, 'verificationContract')
        !== Object.prototype.hasOwnProperty.call(normalized, 'verificationContract')
      || JSON.stringify(prior.operationSemantics ?? null)
        !== JSON.stringify(normalized.operationSemantics ?? null)
      || Object.prototype.hasOwnProperty.call(prior, 'operationSemantics')
        !== Object.prototype.hasOwnProperty.call(normalized, 'operationSemantics')
    )) {
      return {
        ok: false,
        refusal: { code: 'selected_definition_identity_conflict', identifier },
      };
    }
    selected.set(key, normalized);
  }
  if (selected.size > MAX_SELECTED_COMPOSIO_DEFINITIONS) {
    return {
      ok: false,
      refusal: {
        code: 'selected_definition_selection_limit_exceeded',
        identifier: [...selected.values()][MAX_SELECTED_COMPOSIO_DEFINITIONS]!.identifier,
      },
    };
  }
  if (selected.size === 0) return { ok: true, definitions: new Map() };

  let connectionProof;
  try {
    connectionProof = await revalidateSelectedComposioConnections(
      [...selected.values()].map((entry) => ({
        identifier: entry.identifier,
        connectionId: entry.accountIdentity,
      })),
    );
  } catch {
    return {
      ok: false,
      refusal: {
        code: 'selected_connection_refresh_unavailable',
        identifier: selected.values().next().value!.identifier,
      },
    };
  }
  if (!connectionProof.ok) {
    return {
      ok: false,
      refusal: {
        code: connectionProof.reason === 'missing_or_changed'
          ? 'selected_connection_missing_or_changed'
          : 'selected_connection_inactive_or_suppressed',
        identifier: connectionProof.identifier,
      },
    };
  }

  const definitions = new Map<string, RevalidatedComposioDefinition>();
  const ordered = [...selected.entries()];
  for (let offset = 0; offset < ordered.length; offset += SELECTED_DEFINITION_REFRESH_CONCURRENCY) {
    const batch = ordered.slice(offset, offset + SELECTED_DEFINITION_REFRESH_CONCURRENCY);
    const outcomes = await Promise.all(batch.map(async ([key, selection]) => {
    const exact = await refreshExactComposioSchemaFromProvider(selection.identifier).catch(() => null);
    if (!exact || !isRecord(exact.schema)) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_exact_refresh_unavailable' as const,
          identifier: selection.identifier,
        },
      };
    }
    if (digestSchema(exact.schema) !== selection.schemaDigest) {
      return {
        ok: false as const,
        refusal: { code: 'selected_definition_schema_drift' as const, identifier: selection.identifier },
      };
    }
    const operationVersion = exact.providerOperationVersion?.trim();
    if (!operationVersion) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_operation_version_unavailable' as const,
          identifier: selection.identifier,
        },
      };
    }
    if (
      selection.providerOperationVersion
      && selection.providerOperationVersion !== operationVersion
    ) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_operation_version_drift' as const,
          identifier: selection.identifier,
        },
      };
    }
    if (!Object.prototype.hasOwnProperty.call(exact, 'outputSchema')) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_exact_refresh_unavailable' as const,
          identifier: selection.identifier,
        },
      };
    }
    const outputSchema = exact.outputSchema ?? null;
    const outputSchemaDigest = outputSchema ? digestSchema(outputSchema) : null;
    if (
      Object.prototype.hasOwnProperty.call(selection, 'outputSchemaDigest')
      && (selection.outputSchemaDigest ?? null) !== outputSchemaDigest
    ) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_output_schema_drift' as const,
          identifier: selection.identifier,
        },
      };
    }
    const semanticAuthorityFullyBound = Boolean(
      selection.definitionFingerprint
      && selection.providerOperationVersion
      && selection.invokePortId
      && Object.prototype.hasOwnProperty.call(selection, 'outputSchemaDigest'),
    );
    if (
      (selection.verificationContract || selection.operationSemantics)
      && !semanticAuthorityFullyBound
    ) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_semantic_contract_drift' as const,
          identifier: selection.identifier,
        },
      };
    }
    const currentVerification = selection.verificationContract
      ? validateOperationVerificationContractForSchemas({
          contract: selection.verificationContract,
          inputSchema: exact.schema,
          outputSchema,
        })
      : null;
    const currentOperationSemantics = selection.operationSemantics
      ? validateCapabilityManifestOperationSemanticsForInputSchema({
          semantics: selection.operationSemantics,
          inputSchema: exact.schema,
        })
      : null;
    if (
      Object.prototype.hasOwnProperty.call(selection, 'verificationContract')
      && JSON.stringify(selection.verificationContract ?? null)
        !== JSON.stringify(currentVerification ?? null)
    ) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_semantic_contract_drift' as const,
          identifier: selection.identifier,
        },
      };
    }
    if (
      Object.prototype.hasOwnProperty.call(selection, 'operationSemantics')
      && JSON.stringify(selection.operationSemantics ?? null)
        !== JSON.stringify(currentOperationSemantics ?? null)
    ) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_semantic_contract_drift' as const,
          identifier: selection.identifier,
        },
      };
    }
    const invokePortId = selection.invokePortId
      ?? `port:cap:resolved:${selection.identifier.toLowerCase()}:${selection.identifier}`;
    const definitionFingerprint = fingerprintComposioProviderDefinition({
      operationId: selection.identifier,
      operationVersion,
      accountId: selection.accountIdentity,
      invokePortId,
      inputSchema: exact.schema,
      outputSchema,
    });
    if (!definitionFingerprint) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_exact_refresh_unavailable' as const,
          identifier: selection.identifier,
        },
      };
    }
    if (
      selection.definitionFingerprint
      && selection.definitionFingerprint !== definitionFingerprint
    ) {
      return {
        ok: false as const,
        refusal: {
          code: 'selected_definition_fingerprint_drift' as const,
          identifier: selection.identifier,
        },
      };
    }
    return {
      ok: true as const,
      key,
      definition: {
        ...selection,
        schema: exact.schema,
        fingerprint: exact.fingerprint,
        outputSchema,
        outputSchemaDigest,
        providerOperationVersion: operationVersion,
        invokePortId,
        definitionFingerprint,
        ...(Object.prototype.hasOwnProperty.call(selection, 'verificationContract')
          ? { verificationContract: currentVerification ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(selection, 'operationSemantics')
          ? { operationSemantics: currentOperationSemantics ?? null }
          : {}),
      } satisfies RevalidatedComposioDefinition,
    };
    }));
    // Inspect in accepted-plan order so concurrent completion cannot change the
    // typed refusal identity. Publish into the local result only after the
    // entire batch passes; callers still receive nothing unless every batch
    // succeeds.
    for (const outcome of outcomes) {
      if (!outcome.ok) return outcome;
    }
    for (const outcome of outcomes) {
      if (outcome.ok) definitions.set(outcome.key, outcome.definition);
    }
  }
  return { ok: true, definitions };
}
