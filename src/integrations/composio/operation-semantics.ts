/**
 * Documented semantics for provider operations whose public action names do
 * not carry enough verb evidence to classify themselves.
 *
 * This is intentionally a small, pure registry. Most actions stay governed by
 * the structural classifier in slug-effect.ts; an entry belongs here only when
 * provider documentation gives the noun-shaped operation a stable effect that
 * every runtime consumer must share. Keeping the descriptor here prevents an
 * artifact recognizer, approval gate, and settlement projection from inventing
 * different meanings for the same canonical action.
 *
 * Entries describe an ACTION, never a particular request. Anything that would
 * only match one caller's arguments — an actor id, a column layout, a row
 * count — is a fact about a single run, so it has to be learned at runtime
 * rather than frozen here.
 */

import type {
  MutationVerificationContractV1,
  OperationVerificationContractV1,
  ReadbackVerificationContractV1,
} from '../../runtime/harness/mutation-verification-contract.js';
import type {
  CapabilityManifestOperationSemanticsV1,
} from '../../runtime/harness/capability-manifest.js';
import {
  isRfc6901Pointer,
  validateOperationVerificationContractForSchemas,
} from '../../runtime/harness/mutation-verification-contract.js';

export type DocumentedComposioEffect = 'read' | 'write';
export type DocumentedComposioReversibility = 'read_only' | 'reversible' | 'irreversible';
export type DocumentedComposioConsequence = 'read' | 'create' | 'update' | 'delete' | 'send' | 'other';

export interface DocumentedComposioOperationSemantic {
  effect: DocumentedComposioEffect;
  reversibility: DocumentedComposioReversibility;
  consequence: DocumentedComposioConsequence;
  /** Present only when the operation creates the root deliverable itself. */
  rootArtifact?: {
    kind: 'resource' | 'google_doc';
    provider: string;
  };
  /**
   * The provider documents this exact operation as one atomic
   * input-to-created-content commit. This is deliberately narrower than
   * `consequence: create`: most creates still owe an independent readback.
   */
  atomicInputContentCommit?: {
    kind: 'googlesheets_sheet_from_json_content_v1';
    evidence: readonly ['receipt', 'content_commit'];
  };
}

const SLACK_CONVERSATIONS_HISTORY = Object.freeze({
  effect: 'read',
  reversibility: 'read_only',
  consequence: 'read',
} satisfies DocumentedComposioOperationSemantic);

const TWITTER_USER_TIMELINE = Object.freeze({
  effect: 'read',
  reversibility: 'read_only',
  consequence: 'read',
} satisfies DocumentedComposioOperationSemantic);

const GOOGLE_DRIVE_DOWNLOAD_FILE = Object.freeze({
  effect: 'read',
  reversibility: 'read_only',
  consequence: 'read',
} satisfies DocumentedComposioOperationSemantic);

const GOOGLE_SHEETS_SHEET_FROM_JSON = Object.freeze({
  effect: 'write',
  reversibility: 'reversible',
  consequence: 'create',
  rootArtifact: Object.freeze({
    kind: 'resource',
    provider: 'googlesheets',
  }),
  atomicInputContentCommit: Object.freeze({
    kind: 'googlesheets_sheet_from_json_content_v1',
    evidence: Object.freeze(['receipt', 'content_commit'] as const),
  }),
} satisfies DocumentedComposioOperationSemantic);

const GOOGLE_DOCS_CREATE_DOCUMENT_MARKDOWN = Object.freeze({
  effect: 'write',
  reversibility: 'reversible',
  consequence: 'create',
  rootArtifact: Object.freeze({
    kind: 'google_doc',
    provider: 'Google Docs',
  }),
} satisfies DocumentedComposioOperationSemantic);

/**
 * The current Sheets vertical deliberately does not use deprecated
 * GOOGLESHEETS_BATCH_UPDATE. Composio's wrapper exposes one exact-range write
 * as GOOGLESHEETS_VALUES_UPDATE (`spreadsheet_id`, `range`, `values`) and all
 * three operations return the SDK's closed `{data,error,successful}` envelope.
 * The `data` schema is intentionally opaque, so create identity is projected
 * only at runtime after that exact envelope is positively acknowledged, while
 * readback identity remains bound to the exact settled request. A drifted
 * field or payload shape can fail verification, never manufacture authority.
 */

const GOOGLE_SHEETS_CREATE_VERIFICATION = Object.freeze({
  version: 1,
  resourceFamily: 'googlesheets',
  producedHandleKind: 'created_resource',
  proof: 'resource_identity_v1',
  target: Object.freeze({
    source: 'authoritative_result',
    pointers: Object.freeze(['/spreadsheetId'] as const),
  }),
  resultEnvelope: 'successful_data_envelope_v1',
} satisfies MutationVerificationContractV1);

const GOOGLE_SHEETS_VALUES_UPDATE_VERIFICATION = Object.freeze({
  version: 1,
  resourceFamily: 'googlesheets',
  producedHandleKind: 'created_resource',
  proof: 'exact_content_v1',
  target: Object.freeze({
    source: 'provider_arguments',
    pointers: Object.freeze(['/spreadsheet_id'] as const),
  }),
  resultEnvelope: 'successful_data_envelope_v1',
  expectedContent: Object.freeze({
    projection: Object.freeze({
      version: 1,
      kind: 'exact_single_range_values_v1',
      rangePointer: '/range',
      valuesPointer: '/values',
    }),
    verifierRequestRangePointer: '/ranges',
  }),
} satisfies MutationVerificationContractV1);

const GOOGLE_SHEETS_BATCH_GET_VERIFICATION = Object.freeze({
  version: 1,
  resourceFamily: 'googlesheets',
  acceptedHandleKind: 'created_resource',
  requestTargetPointers: Object.freeze(['/spreadsheet_id'] as const),
  responseTarget: Object.freeze({
    version: 1,
    kind: 'request_bound_success_v1',
  }),
  resultEnvelope: 'successful_data_envelope_v1',
  observedContent: Object.freeze({
    projection: Object.freeze({
      version: 1,
      kind: 'exact_range_values_v1',
      entriesPointer: '/valueRanges',
      rangePointer: '/range',
      valuesPointer: '/values',
    }),
    requestRangePointer: '/ranges',
  }),
} satisfies ReadbackVerificationContractV1);

const DOCUMENTED_OPERATION_SEMANTICS: ReadonlyMap<string, DocumentedComposioOperationSemantic> = new Map<string, DocumentedComposioOperationSemantic>([
  ['SLACKCONVERSATIONSHISTORY', SLACK_CONVERSATIONS_HISTORY],
  ['TWITTERUSERTIMELINE', TWITTER_USER_TIMELINE],
  ['GOOGLEDRIVEDOWNLOADFILE', GOOGLE_DRIVE_DOWNLOAD_FILE],
  // Composio has exposed both GOOGLE_SHEET and GOOGLE_SHEETS toolkit spellings.
  ['GOOGLESHEETSHEETFROMJSON', GOOGLE_SHEETS_SHEET_FROM_JSON],
  ['GOOGLESHEETSSHEETFROMJSON', GOOGLE_SHEETS_SHEET_FROM_JSON],
  ['GOOGLEDOCSCREATEDOCUMENTMARKDOWN', GOOGLE_DOCS_CREATE_DOCUMENT_MARKDOWN],
]);

function documentedOperationKey(action: string): string {
  const tokens = action
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  // Dynamic Composio wrappers expose cx_<slug>; CX is transport, not part of
  // the provider action. Other leading tokens remain untouched.
  if (tokens[0] === 'CX') tokens.shift();
  return tokens.join('');
}

export function documentedComposioOperationSemantic(
  action: string | null | undefined,
): DocumentedComposioOperationSemantic | null {
  const key = documentedOperationKey(String(action ?? '').trim());
  return key ? DOCUMENTED_OPERATION_SEMANTICS.get(key) ?? null : null;
}

/**
 * Translate the adapter's reviewed declaration into the provider-neutral
 * manifest contract consumed by the shared kernel.  This remains adapter code:
 * provider/action identity is used only to author data which is subsequently
 * sealed into a current manifest digest.
 */
export function documentedComposioManifestOperationSemantics(
  action: string | null | undefined,
): CapabilityManifestOperationSemanticsV1 | null {
  const documented = documentedComposioOperationSemantic(action);
  if (!documented) return null;
  // Read-only is already sealed by manifest.effect and therefore does not get
  // a second registration plane here.
  if (documented.effect === 'read' && !documented.atomicInputContentCommit) return null;
  return {
    version: 1,
    ...(documented.reversibility === 'read_only'
      ? {}
      : { reversibility: documented.reversibility }),
    ...(documented.atomicInputContentCommit
      ? {
          atomicInputContent: {
            version: 1,
            compiler: {
              version: 1,
              kind: 'tabular_record_set_v1',
              namePointer: '/sheet_name',
              recordsPointer: '/sheet_json',
              recordsEncoding: 'json_or_value',
              selector: 'a1_grid_v1',
            },
            resultIdentity: {
              version: 1,
              kind: 'pointer_resource_identity_v1',
              idPointers: [
                '/spreadsheetId', '/spreadsheet_id',
                '/data/spreadsheetId', '/data/spreadsheet_id',
                '/response/spreadsheetId', '/response/spreadsheet_id',
                '/result/spreadsheetId', '/result/spreadsheet_id',
                '/output/spreadsheetId', '/output/spreadsheet_id',
              ],
              handlePointers: [
                '/spreadsheetUrl', '/spreadsheet_url', '/displayUrl', '/display_url',
                '/data/spreadsheetUrl', '/data/spreadsheet_url', '/data/displayUrl', '/data/display_url',
                '/response/spreadsheetUrl', '/response/spreadsheet_url', '/response/displayUrl', '/response/display_url',
                '/result/spreadsheetUrl', '/result/spreadsheet_url', '/result/displayUrl', '/result/display_url',
                '/output/spreadsheetUrl', '/output/spreadsheet_url', '/output/displayUrl', '/output/display_url',
              ],
              handleTemplate: {
                version: 1,
                kind: 'prefix_suffix_v1',
                prefix: 'https://docs.google.com/spreadsheets/d/',
                suffix: '/edit',
              },
            },
            evidence: ['receipt', 'content_commit'],
          },
        }
      : {}),
  };
}

/** Seal adapter semantics only while their generic compiler pointers still
 * address compatible fields on the exact provider input definition. */
export function validateDocumentedComposioManifestOperationSemantics(input: {
  operationId: string;
  inputSchema: unknown;
}): CapabilityManifestOperationSemanticsV1 | null {
  const semantics = documentedComposioManifestOperationSemantics(input.operationId);
  if (!semantics?.atomicInputContent) return semantics;
  const declaration = semantics.atomicInputContent.compiler;
  const name = schemaAtPointer(input.inputSchema, declaration.namePointer);
  const records = schemaAtPointer(input.inputSchema, declaration.recordsPointer);
  const required = record(input.inputSchema) && Array.isArray(input.inputSchema.required)
    ? input.inputSchema.required
    : [];
  const namePath = pointerPath(declaration.namePointer);
  const recordsPath = pointerPath(declaration.recordsPointer);
  if (
    !namePath || namePath.length !== 1
    || !recordsPath || recordsPath.length !== 1
    || !required.includes(namePath[0])
    || !required.includes(recordsPath[0])
    || name?.type !== 'string'
    || (records?.type !== 'string' && records?.type !== 'array')
  ) return null;
  return semantics;
}

/** Adapter edge used during fresh Composio definition staging. It returns
 * provider-neutral fields only; shared planning code never queries the
 * provider/tool-name registry directly. A reviewed declaration whose exact
 * schemas drift is an adapter-definition failure, not a silent downgrade. */
export function validatedDocumentedComposioDefinitionContracts(input: {
  operationId: string;
  inputSchema: unknown;
  outputSchema: unknown;
}): {
  ok: true;
  verificationContract: OperationVerificationContractV1 | null;
  operationSemantics: CapabilityManifestOperationSemanticsV1 | null;
} | { ok: false } {
  const declaredVerification = documentedComposioMutationVerification(input.operationId)
    ?? documentedComposioReadbackVerification(input.operationId);
  const verificationContract = validateDocumentedComposioVerification(input);
  if (declaredVerification && !verificationContract) return { ok: false };
  const declaredSemantics = documentedComposioManifestOperationSemantics(input.operationId);
  const operationSemantics = validateDocumentedComposioManifestOperationSemantics({
    operationId: input.operationId,
    inputSchema: input.inputSchema,
  });
  if (declaredSemantics && !operationSemantics) return { ok: false };
  return {
    ok: true,
    verificationContract,
    operationSemantics,
  };
}

/**
 * Exact opt-in for the one reviewed atomic-input create. Unlike the broader
 * documented-operation lookup, this function intentionally accepts neither
 * aliases nor suffix/name-shape inference: an adjacent create/update cannot
 * borrow the content-commit contract.
 */
export function documentedAtomicInputContentCommit(
  action: string | null | undefined,
): NonNullable<DocumentedComposioOperationSemantic['atomicInputContentCommit']> | null {
  // Durable call identity is case-normalized by the call kernel. Accept that
  // byte-equivalent canonical spelling, but no toolkit alias, transport
  // prefix, suffix, or token-shape approximation.
  if (String(action ?? '').trim().toUpperCase() !== 'GOOGLESHEETS_SHEET_FROM_JSON') return null;
  return GOOGLE_SHEETS_SHEET_FROM_JSON.atomicInputContentCommit;
}

/**
 * Exact reviewed mutation-verification declaration.  Unlike the broader
 * semantic lookup, this accepts no wrapper prefix, alias, suffix, or token
 * normalization.  Durable call identity is case-normalized, so only the exact
 * canonical spelling (in either case) qualifies.
 */
export function documentedComposioMutationVerification(
  action: string | null | undefined,
): MutationVerificationContractV1 | null {
  switch (String(action ?? '').trim().toUpperCase()) {
    case 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1':
      return GOOGLE_SHEETS_CREATE_VERIFICATION;
    case 'GOOGLESHEETS_VALUES_UPDATE':
      return GOOGLE_SHEETS_VALUES_UPDATE_VERIFICATION;
    default: return null;
  }
}

/** Exact reviewed readback declaration; generic/lookalike reads remain inert. */
export function documentedComposioReadbackVerification(
  action: string | null | undefined,
): ReadbackVerificationContractV1 | null {
  return String(action ?? '').trim().toUpperCase() === 'GOOGLESHEETS_BATCH_GET'
    ? GOOGLE_SHEETS_BATCH_GET_VERIFICATION
    : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pointerPath(pointer: string): string[] | null {
  if (!isRfc6901Pointer(pointer)) return null;
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function schemaAtPointer(schema: unknown, pointer: string): Record<string, unknown> | null {
  if (!record(schema)) return null;
  const path = pointerPath(pointer);
  if (!path) return null;
  let cursor: Record<string, unknown> = schema;
  for (const segment of path) {
    const properties = cursor.properties;
    if (!record(properties) || !record(properties[segment])) return null;
    cursor = properties[segment] as Record<string, unknown>;
  }
  return cursor;
}

function topLevelPointerType(schema: unknown, pointer: string, type: string): boolean {
  const path = pointerPath(pointer);
  return Boolean(path && path.length === 1 && schemaAtPointer(schema, pointer)?.type === type);
}

function currentSheetsCreateInputSchema(schema: unknown): boolean {
  if (!record(schema) || schema.type !== 'object' || !record(schema.properties)) return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.length === 0
    && topLevelPointerType(schema, '/title', 'string')
    && topLevelPointerType(schema, '/folder_id', 'string')
    && topLevelPointerType(schema, '/folder_name', 'string');
}

/**
 * Validate the adapter declaration against the exact provider definition
 * observed now.  A reviewed operation whose schema drifted returns null and
 * therefore cannot be staged, published, or restamped into verifier authority.
 */
export function validateDocumentedComposioVerification(input: {
  operationId: string;
  inputSchema: unknown;
  outputSchema: unknown;
}): OperationVerificationContractV1 | null {
  const mutation = documentedComposioMutationVerification(input.operationId);
  if (mutation) {
    const parsed = validateOperationVerificationContractForSchemas({
      contract: { mutation },
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
    });
    if (!parsed || !('mutation' in parsed)) return null;
    if (
      input.operationId.trim().toUpperCase() === 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1'
      && !currentSheetsCreateInputSchema(input.inputSchema)
    ) return null;
    return parsed;
  }
  const readback = documentedComposioReadbackVerification(input.operationId);
  if (readback) {
    return validateOperationVerificationContractForSchemas({
      contract: { readback },
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
    });
  }
  return null;
}
