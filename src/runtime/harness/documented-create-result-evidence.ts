/**
 * Canonical evidence projection for one documented provider create result.
 *
 * This is deliberately a projection, not another execution or settlement
 * owner.  The provider adapter invokes it only after its exact host catalog,
 * expected-work, logical-call, account, schema and argument identities agree.
 * The returned value is used as the settlement payload; the adapter's
 * model-visible provider output remains the raw provider response.
 */
import { createHash } from 'node:crypto';
import { documentedAtomicInputContentCommit } from '../../integrations/composio/operation-semantics.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { extractGoogleSheetsSheetFromJsonTarget } from './sheet-from-json-content-contract.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactText(value: string, max = 512): boolean {
  return value.length > 0 && value.length <= max && value === value.trim();
}

export interface DocumentedCreateResultAuthorityV1 {
  version: 1;
  acceptedTaskId: string;
  logicalToolCallId: string;
  requirementId: string;
  operationId: string;
  accountId: string;
  providerInputSchemaDigest: string;
  argumentDigest: string;
  submittedContentDigest: string;
  effect: 'external_write';
}

export interface DocumentedCreateResultActualCallV1 {
  acceptedTaskId: string;
  logicalToolCallId: string;
  operationId: string;
  accountId: string;
  providerInputSchemaDigest: string;
  argumentDigest: string;
  submittedContentDigest: string;
  effect: 'external_write';
}

export type DocumentedCreateResultAdmission =
  | {
      status: 'ready';
      authority: Readonly<DocumentedCreateResultAuthorityV1>;
    }
  | {
      status: 'not_applicable';
      reason: 'operation_is_not_a_documented_root_create';
    }
  | {
      status: 'refused';
      reason:
        | 'authority_is_malformed'
        | 'actual_call_is_malformed'
        | 'accepted_task_mismatch'
        | 'logical_call_mismatch'
        | 'operation_mismatch'
        | 'account_mismatch'
        | 'schema_mismatch'
        | 'argument_mismatch'
        | 'submitted_content_mismatch'
        | 'effect_mismatch';
    };

function validAuthority(input: DocumentedCreateResultAuthorityV1): boolean {
  return input.version === 1
    && exactText(input.acceptedTaskId)
    && exactText(input.logicalToolCallId)
    && exactText(input.requirementId, 256)
    && exactText(input.operationId)
    && exactText(input.accountId)
    && SHA256_RE.test(input.providerInputSchemaDigest)
    && SHA256_RE.test(input.argumentDigest)
    && SHA256_RE.test(input.submittedContentDigest)
    && input.effect === 'external_write';
}

function validActual(input: DocumentedCreateResultActualCallV1): boolean {
  return exactText(input.acceptedTaskId)
    && exactText(input.logicalToolCallId)
    && exactText(input.operationId)
    && exactText(input.accountId)
    && SHA256_RE.test(input.providerInputSchemaDigest)
    && SHA256_RE.test(input.argumentDigest)
    && SHA256_RE.test(input.submittedContentDigest)
    && input.effect === 'external_write';
}

/**
 * Freeze the exact call identity before provider I/O.  Documented operation
 * semantics decide applicability; no provider/tool name substring can turn a
 * lookalike into a create projection.
 */
export function admitDocumentedCreateResultProjection(input: {
  authority: DocumentedCreateResultAuthorityV1;
  actual: DocumentedCreateResultActualCallV1;
}): DocumentedCreateResultAdmission {
  if (!documentedAtomicInputContentCommit(input.actual.operationId)) {
    return { status: 'not_applicable', reason: 'operation_is_not_a_documented_root_create' };
  }
  if (!validAuthority(input.authority)) {
    return { status: 'refused', reason: 'authority_is_malformed' };
  }
  if (!validActual(input.actual)) {
    return { status: 'refused', reason: 'actual_call_is_malformed' };
  }
  if (input.authority.acceptedTaskId !== input.actual.acceptedTaskId) {
    return { status: 'refused', reason: 'accepted_task_mismatch' };
  }
  if (input.authority.logicalToolCallId !== input.actual.logicalToolCallId) {
    return { status: 'refused', reason: 'logical_call_mismatch' };
  }
  if (input.authority.operationId !== input.actual.operationId) {
    return { status: 'refused', reason: 'operation_mismatch' };
  }
  if (input.authority.accountId !== input.actual.accountId) {
    return { status: 'refused', reason: 'account_mismatch' };
  }
  if (input.authority.providerInputSchemaDigest !== input.actual.providerInputSchemaDigest) {
    return { status: 'refused', reason: 'schema_mismatch' };
  }
  if (input.authority.argumentDigest !== input.actual.argumentDigest) {
    return { status: 'refused', reason: 'argument_mismatch' };
  }
  if (input.authority.submittedContentDigest !== input.actual.submittedContentDigest) {
    return { status: 'refused', reason: 'submitted_content_mismatch' };
  }
  if (input.authority.effect !== input.actual.effect) {
    return { status: 'refused', reason: 'effect_mismatch' };
  }
  return { status: 'ready', authority: Object.freeze({ ...input.authority }) };
}

export interface CanonicalDocumentedCreateResultV1 {
  version: 1;
  kind: 'documented_provider_create_result';
  binding: Readonly<DocumentedCreateResultAuthorityV1>;
  created: {
    id: string;
    handle: string;
    /** Digest of the exact acknowledged provider return and admitted call. */
    receipt: string;
    /** Exact provider-ready worksheet content acknowledged by this create. */
    writtenDigest: string;
  };
  contentCommit: {
    kind: 'provider_acknowledged_atomic_input_v1';
    submittedContentDigest: string;
  };
  /** Exact provider value retained inside the authoritative result handle. */
  rawProviderResult: unknown;
  rawProviderDigest: string;
}

export type DocumentedCreateResultProjection =
  | { status: 'projected'; value: CanonicalDocumentedCreateResultV1 }
  | {
      status: 'uncertain';
      reason: 'artifact_identity_missing_or_ambiguous' | 'provider_result_not_canonical_json';
      rawProviderResult: unknown;
    };

export type CanonicalDocumentedCreateResultVerification =
  | {
      status: 'verified';
      value: CanonicalDocumentedCreateResultV1;
    }
  | {
      status: 'refused';
      reason: string;
    };

export function documentedProviderAcknowledgementReceipt(
  binding: DocumentedCreateResultAuthorityV1,
  rawProviderResult: unknown,
): string {
  return `provider-ack:v1:${sha256(closedCanonicalJson({ binding, rawProviderResult }))}`;
}

/**
 * Project only response shapes documented by the operation-specific target
 * extractor.  A returned provider acknowledgement with no single exact
 * resource identity is an uncertain write: it never falls back to title
 * lookup, guessed ids, or a second create.
 */
export function projectDocumentedCreateResult(
  admission: Extract<DocumentedCreateResultAdmission, { status: 'ready' }>,
  rawProviderResult: unknown,
): DocumentedCreateResultProjection {
  let rawCanonical: string;
  try {
    rawCanonical = closedCanonicalJson(rawProviderResult);
  } catch {
    return {
      status: 'uncertain',
      reason: 'provider_result_not_canonical_json',
      rawProviderResult,
    };
  }

  const sheet = documentedAtomicInputContentCommit(admission.authority.operationId)
    ? extractGoogleSheetsSheetFromJsonTarget(rawProviderResult)
    : null;
  if (!sheet) {
    return {
      status: 'uncertain',
      reason: 'artifact_identity_missing_or_ambiguous',
      rawProviderResult,
    };
  }

  const handle = sheet.spreadsheetUrl
    ?? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheet.spreadsheetId)}/edit`;
  const binding = admission.authority;
  const rawProviderDigest = sha256(rawCanonical);
  // This is an acknowledgement receipt, not an invented provider identifier:
  // it binds the exact returned provider value to the exact admitted call.
  const receipt = documentedProviderAcknowledgementReceipt(binding, rawProviderResult);
  return {
    status: 'projected',
    value: {
      version: 1,
      kind: 'documented_provider_create_result',
      binding,
      created: {
        id: sheet.spreadsheetId,
        handle,
        receipt,
        writtenDigest: binding.submittedContentDigest,
      },
      contentCommit: {
        kind: 'provider_acknowledged_atomic_input_v1',
        submittedContentDigest: binding.submittedContentDigest,
      },
      rawProviderResult,
      rawProviderDigest,
    },
  };
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Re-redeem a durable projected result. This never trusts the receipt string:
 * it recomputes the raw digest, exact returned target, canonical URL and
 * acknowledgement over the complete admitted binding + raw provider value.
 */
export function verifyCanonicalDocumentedCreateResult(input: {
  value: unknown;
  expectedAuthority?: DocumentedCreateResultAuthorityV1;
}): CanonicalDocumentedCreateResultVerification {
  if (!exactRecord(input.value, [
    'version', 'kind', 'binding', 'created', 'contentCommit',
    'rawProviderResult', 'rawProviderDigest',
  ])) return { status: 'refused', reason: 'canonical create result shape is invalid' };
  const value = input.value as unknown as CanonicalDocumentedCreateResultV1;
  if (
    value.version !== 1
    || value.kind !== 'documented_provider_create_result'
    || !exactRecord(value.binding, [
      'version', 'acceptedTaskId', 'logicalToolCallId', 'requirementId',
      'operationId', 'accountId', 'providerInputSchemaDigest',
      'argumentDigest', 'submittedContentDigest', 'effect',
    ])
    || !validAuthority(value.binding)
    || !documentedAtomicInputContentCommit(value.binding.operationId)
    || !exactRecord(value.created, ['id', 'handle', 'receipt', 'writtenDigest'])
    || !exactRecord(value.contentCommit, ['kind', 'submittedContentDigest'])
    || value.contentCommit.kind !== 'provider_acknowledged_atomic_input_v1'
    || value.contentCommit.submittedContentDigest !== value.binding.submittedContentDigest
    || value.created.writtenDigest !== value.binding.submittedContentDigest
  ) return { status: 'refused', reason: 'canonical create result binding is invalid' };
  if (
    input.expectedAuthority
    && closedCanonicalJson(value.binding) !== closedCanonicalJson(input.expectedAuthority)
  ) return { status: 'refused', reason: 'canonical create result authority changed' };
  let rawCanonical: string;
  try { rawCanonical = closedCanonicalJson(value.rawProviderResult); } catch {
    return { status: 'refused', reason: 'raw provider result is not canonical JSON' };
  }
  if (value.rawProviderDigest !== sha256(rawCanonical)) {
    return { status: 'refused', reason: 'raw provider result digest changed' };
  }
  const target = extractGoogleSheetsSheetFromJsonTarget(value.rawProviderResult);
  if (!target || target.spreadsheetId !== value.created.id) {
    return { status: 'refused', reason: 'provider result no longer identifies one exact Sheet' };
  }
  const expectedHandle = target.spreadsheetUrl
    ?? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(target.spreadsheetId)}/edit`;
  if (value.created.handle !== expectedHandle) {
    return { status: 'refused', reason: 'created Sheet handle changed' };
  }
  if (value.created.receipt !== documentedProviderAcknowledgementReceipt(
    value.binding,
    value.rawProviderResult,
  )) return { status: 'refused', reason: 'provider acknowledgement receipt changed' };
  return { status: 'verified', value };
}
