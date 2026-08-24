/**
 * Provider-neutral admission for an automatic pilot's interpretation of live
 * read output bytes. The model may propose paths, but only exact paths proven
 * by a carrier-declared or host-reviewed output schema survive. No business
 * invocation, catalog name, description, example, or prior result is accepted
 * as substitute authority.
 */
import { createHash } from 'node:crypto';

import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import { fingerprintSchema } from '../tools/tool-contract-store.js';
import type {
  AutomationPilotAuthoringRequestV1,
  AutomationPilotAuthoringResultV1,
} from './automation-pilot-advancement-control-plane.js';

const VERSION = 1 as const;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const SCHEMA_FINGERPRINT_RE = /^[a-f0-9]{32}$/;
const PATH_RE = /^(?:[A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9]\d*)\])*$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_SCHEMA_BYTES = 2_000_000;

export interface AutomationPilotOutputShapeReceiptV1 {
  version: 1;
  advancementId: string;
  requestId: string;
  requestDigest: string;
  capabilityId: string;
  capabilityIdentityDigest: string;
  definitionFingerprint: string;
  source: 'carrier_declared' | 'host_reviewed';
  schemaFingerprint: string;
  schema: Record<string, unknown>;
  receiptDigest: string;
}

export type AttestAutomationPilotOutputShapeResult =
  | { ok: true; receipt: AutomationPilotOutputShapeReceiptV1 }
  | { ok: false; code: string; reason: string };

export type ValidateAutomationPilotOutputShapeResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 48,
    maxNodes: 250_000,
    maxStringBytes: 1_048_576,
    maxTotalBytes: MAX_SCHEMA_BYTES,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function withoutReceiptDigest(
  receipt: AutomationPilotOutputShapeReceiptV1,
): Omit<AutomationPilotOutputShapeReceiptV1, 'receiptDigest'> {
  const { receiptDigest: _receiptDigest, ...body } = receipt;
  return body;
}

export function automationPilotOutputShapeReceiptDigest(
  receipt: Omit<AutomationPilotOutputShapeReceiptV1, 'receiptDigest'>
    | AutomationPilotOutputShapeReceiptV1,
): string {
  const body = 'receiptDigest' in receipt
    ? withoutReceiptDigest(receipt as AutomationPilotOutputShapeReceiptV1)
    : receipt;
  return sha256(canonicalJson({
    domain: 'automation-pilot-output-shape-receipt',
    version: VERSION,
    receipt: body,
  }));
}

export function attestAutomationPilotOutputShape(input: {
  request: AutomationPilotAuthoringRequestV1;
  requestDigest: string;
}): AttestAutomationPilotOutputShapeResult {
  if (!DIGEST_RE.test(input.requestDigest)) {
    return { ok: false, code: 'authoring_request_digest_invalid', reason: 'The exact authoring request digest is malformed.' };
  }
  const shape = input.request.acquisition.outputShape;
  if (!shape) {
    return {
      ok: false,
      code: 'output_shape_unavailable',
      reason: 'The exact live read definition does not declare a reviewed output schema; no business call was sampled.',
    };
  }
  if (
    (shape.source !== 'carrier_declared' && shape.source !== 'host_reviewed')
    || !SCHEMA_FINGERPRINT_RE.test(shape.schemaFingerprint)
    || !plainRecord(shape.schema)
  ) {
    return { ok: false, code: 'output_shape_malformed', reason: 'The retained output-shape metadata is malformed.' };
  }
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(canonicalJson(shape.schema)) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      code: 'output_shape_malformed',
      reason: error instanceof Error ? error.message : 'The output schema is not bounded closed JSON.',
    };
  }
  if (fingerprintSchema(schema) !== shape.schemaFingerprint) {
    return { ok: false, code: 'output_shape_drift', reason: 'The retained output schema failed its exact fingerprint.' };
  }
  const body: Omit<AutomationPilotOutputShapeReceiptV1, 'receiptDigest'> = {
    version: VERSION,
    advancementId: input.request.advancementId,
    requestId: input.request.requestId,
    requestDigest: input.requestDigest,
    capabilityId: input.request.acquisition.capabilityId,
    capabilityIdentityDigest: input.request.acquisition.capabilityIdentityDigest,
    definitionFingerprint: input.request.acquisition.definitionFingerprint,
    source: shape.source,
    schemaFingerprint: shape.schemaFingerprint,
    schema,
  };
  return {
    ok: true,
    receipt: { ...body, receiptDigest: automationPilotOutputShapeReceiptDigest(body) },
  };
}

interface PathToken {
  kind: 'property' | 'index';
  value: string | number;
}

function pathTokens(path: string): PathToken[] | null {
  if (!PATH_RE.test(path)) return null;
  const tokens: PathToken[] = [];
  let cursor = 0;
  while (cursor < path.length) {
    const property = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(path.slice(cursor));
    if (!property || FORBIDDEN.has(property[0])) return null;
    tokens.push({ kind: 'property', value: property[0] });
    cursor += property[0].length;
    while (path[cursor] === '[') {
      const index = /^\[(0|[1-9]\d*)\]/.exec(path.slice(cursor));
      if (!index) return null;
      tokens.push({ kind: 'index', value: Number(index[1]) });
      cursor += index[0].length;
    }
    if (cursor === path.length) break;
    if (path[cursor] !== '.') return null;
    cursor += 1;
  }
  return tokens;
}

function schemaTypes(schema: Record<string, unknown>): Set<string> | null {
  if (typeof schema.type === 'string') return new Set([schema.type]);
  if (
    Array.isArray(schema.type)
    && schema.type.length > 0
    && schema.type.every((entry) => typeof entry === 'string')
  ) return new Set(schema.type as string[]);
  return null;
}

function unsupportedComposition(schema: Record<string, unknown>): boolean {
  return ['$ref', '$dynamicRef', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']
    .some((key) => Object.hasOwn(schema, key));
}

function nodeAtPath(input: {
  root: Record<string, unknown>;
  path: string;
  requirePresent: boolean;
}): { ok: true; node: Record<string, unknown> } | { ok: false; reason: string } {
  const tokens = pathTokens(input.path);
  if (!tokens) return { ok: false, reason: `Path "${input.path}" is malformed.` };
  let node = input.root;
  for (const token of tokens) {
    if (unsupportedComposition(node)) {
      return { ok: false, reason: `Path "${input.path}" crosses an unsupported schema composition.` };
    }
    const types = schemaTypes(node);
    if (token.kind === 'property') {
      if (!types || !types.has('object') || !plainRecord(node.properties)) {
        return { ok: false, reason: `Path "${input.path}" is not explicitly declared through object properties.` };
      }
      const property = node.properties[String(token.value)];
      if (!plainRecord(property)) {
        return { ok: false, reason: `Path "${input.path}" is absent from the exact output schema.` };
      }
      if (
        input.requirePresent
        && (!Array.isArray(node.required) || !node.required.includes(String(token.value)))
      ) {
        return { ok: false, reason: `Required path "${input.path}" is optional in the exact output schema.` };
      }
      node = property;
    } else {
      if (!types || !types.has('array') || !plainRecord(node.items)) {
        return { ok: false, reason: `Path "${input.path}" does not have explicit array item schema.` };
      }
      node = node.items;
    }
  }
  if (unsupportedComposition(node)) {
    return { ok: false, reason: `Path "${input.path}" resolves to an unsupported schema composition.` };
  }
  return { ok: true, node };
}

function requireTypes(input: {
  root: Record<string, unknown>;
  path: string;
  requirePresent: boolean;
  allowed: readonly string[];
  label: string;
}): string | null {
  const resolved = nodeAtPath(input);
  if (!resolved.ok) return resolved.reason;
  const types = schemaTypes(resolved.node);
  if (!types || [...types].some((type) => !input.allowed.includes(type))) {
    return `${input.label} path "${input.path}" is not explicitly typed as ${input.allowed.join(' or ')}.`;
  }
  return null;
}

function fieldSchemaType(type: string): readonly string[] {
  if (type === 'number') return ['number', 'integer'];
  if (type === 'timestamp') return ['string'];
  return [type];
}

function resultShapeIssue(input: {
  receipt: AutomationPilotOutputShapeReceiptV1;
  result: AutomationPilotAuthoringResultV1;
}): string | null {
  const { receipt, result } = input;
  if (
    receipt.version !== VERSION
    || !DIGEST_RE.test(receipt.receiptDigest)
    || automationPilotOutputShapeReceiptDigest(receipt) !== receipt.receiptDigest
    || result.requestId !== receipt.requestId
    || result.requestDigest !== receipt.requestDigest
  ) return 'The authoring result and output-shape receipt do not share exact request lineage.';
  const root = receipt.schema;
  const evidence = result.contract.evidence;
  for (const path of evidence.requiredPaths) {
    const resolved = nodeAtPath({ root, path, requirePresent: true });
    if (!resolved.ok) return resolved.reason;
  }
  for (const path of evidence.nonEmptyPaths) {
    const issue = requireTypes({
      root,
      path,
      requirePresent: true,
      allowed: ['array', 'object', 'string'],
      label: 'Non-empty evidence',
    });
    if (issue) return issue;
  }
  for (const [path, minimum] of Object.entries(evidence.minItems)) {
    if (!Number.isSafeInteger(minimum) || minimum < 1) return `Minimum items for "${path}" is malformed.`;
    const issue = requireTypes({ root, path, requirePresent: true, allowed: ['array'], label: 'Minimum-items evidence' });
    if (issue) return issue;
  }
  for (const path of result.contract.completeness.evidencePaths) {
    const resolved = nodeAtPath({ root, path, requirePresent: true });
    if (!resolved.ok) return resolved.reason;
  }
  const continuation = result.contract.continuation ?? { kind: 'none' as const };
  if (result.contract.completeness.kind === 'finite_exhaustive') {
    const issue = requireTypes({
      root,
      path: result.contract.completeness.exhaustedPath,
      requirePresent: true,
      allowed: ['boolean'],
      label: 'Exhaustion',
    });
    if (issue) return issue;
  }
  if (continuation.kind === 'cursor') {
    const exhaustedIssue = requireTypes({
      root,
      path: continuation.exhaustedPath,
      requirePresent: true,
      allowed: ['boolean'],
      label: 'Cursor exhaustion',
    });
    if (exhaustedIssue) return exhaustedIssue;
    const cursorIssue = requireTypes({
      root,
      path: continuation.nextCursorPath,
      requirePresent: false,
      allowed: ['string', 'null'],
      label: 'Next cursor',
    });
    if (cursorIssue) return cursorIssue;
  }
  const projection = result.contract.resultProjection;
  if (!projection) return null;
  if (
    !evidence.requiredPaths.includes(projection.recordsPath)
    || !evidence.nonEmptyPaths.includes(projection.recordsPath)
    || (evidence.minItems[projection.recordsPath] ?? 0) < 1
    || !result.contract.completeness.evidencePaths.includes(projection.recordsPath)
  ) return 'The canonical records path is not required, non-empty, counted, and completeness-bearing.';
  const records = nodeAtPath({ root, path: projection.recordsPath, requirePresent: true });
  if (!records.ok) return records.reason;
  const recordTypes = schemaTypes(records.node);
  if (!recordTypes || recordTypes.size !== 1 || !recordTypes.has('array') || !plainRecord(records.node.items)) {
    return `Canonical records path "${projection.recordsPath}" is not an explicit array of objects.`;
  }
  const item = records.node.items;
  const itemTypes = schemaTypes(item);
  if (!itemTypes || itemTypes.size !== 1 || !itemTypes.has('object')) {
    return `Canonical records path "${projection.recordsPath}" has no explicit object item schema.`;
  }
  const fieldByName = new Map(projection.fields.map((field) => [field.field, field]));
  for (const field of projection.fields) {
    const issue = requireTypes({
      root: item,
      path: field.recordPath,
      requirePresent: field.required,
      allowed: fieldSchemaType(field.type),
      label: `Projected field ${field.field}`,
    });
    if (issue) return issue;
  }
  const identityFields = new Set(projection.identityRules.flatMap((rule) => rule.fields));
  for (const fieldName of identityFields) {
    const field = fieldByName.get(fieldName);
    if (!field || !field.required) return `Identity field "${fieldName}" is not a required projected field.`;
  }
  const sourceId = projection.fields.find((field) => field.recordPath === projection.sourceRecord.idPath);
  if (!sourceId?.required) return 'The source record id path is not a required projected field.';
  if (projection.sourceRecord.revisionPath) {
    const resolved = nodeAtPath({ root: item, path: projection.sourceRecord.revisionPath, requirePresent: false });
    if (!resolved.ok) return resolved.reason;
  }
  if (projection.sourceRecord.observedAt.kind === 'record_path') {
    const issue = requireTypes({
      root: item,
      path: projection.sourceRecord.observedAt.path,
      requirePresent: true,
      allowed: ['string', 'number', 'integer'],
      label: 'Observed-at',
    });
    if (issue) return issue;
  }
  return null;
}

export function validateAutomationPilotAuthoringOutputShape(input: {
  receipt: AutomationPilotOutputShapeReceiptV1;
  result: AutomationPilotAuthoringResultV1;
}): ValidateAutomationPilotOutputShapeResult {
  let receipt: AutomationPilotOutputShapeReceiptV1;
  let result: AutomationPilotAuthoringResultV1;
  try {
    receipt = JSON.parse(canonicalJson(input.receipt)) as AutomationPilotOutputShapeReceiptV1;
    result = JSON.parse(canonicalJson(input.result)) as AutomationPilotAuthoringResultV1;
  } catch (error) {
    return {
      ok: false,
      code: 'output_shape_candidate_malformed',
      reason: error instanceof Error ? error.message : 'The output-shape candidate is not bounded closed JSON.',
    };
  }
  const issue = resultShapeIssue({ receipt, result });
  return issue
    ? { ok: false, code: 'output_shape_unproven', reason: issue }
    : { ok: true };
}

/** Host-side prompt projection. It contains metadata and exact schemas only;
 * no provider result bytes or execution authority are introduced. */
export function automationPilotAuthoringPrompt(input: {
  request: AutomationPilotAuthoringRequestV1;
  requestDigest: string;
  receipt: AutomationPilotOutputShapeReceiptV1;
}): string {
  return [
    'Author one typed read-pilot contract candidate as strict JSON.',
    'Do not call tools. Do not choose a provider, account, Workspace, schedule, recurrence, or approval outcome.',
    'Use only the exact approved proposal, selected Workspace bytes, input schema, and attested output schema below.',
    'Never invent a path. For a dataset, map canonical entity fields only to explicitly declared record-item paths.',
    'For pagination, use finite_exhaustive plus one host-owned optional continuation_cursor only when exact next-cursor and boolean exhausted paths exist.',
    'Return exactly {version:1,requestId,requestDigest,contract,workflowInputs}.',
    canonicalJson({
      request: {
        version: input.request.version,
        requestId: input.request.requestId,
        advancementId: input.request.advancementId,
        proposal: input.request.proposal,
        acceptedSource: input.request.acceptedSource,
        requirement: input.request.requirement,
        ...(input.request.workspaceSelection
          ? { workspaceSelection: input.request.workspaceSelection }
          : {}),
        capabilityBinding: {
          capabilityId: input.request.acquisition.capabilityId,
          capabilityIdentityDigest: input.request.acquisition.capabilityIdentityDigest,
          definitionFingerprint: input.request.acquisition.definitionFingerprint,
          inputSchema: input.request.acquisition.inputSchema,
        },
        authority: input.request.authority,
      },
      requestDigest: input.requestDigest,
      outputShapeReceipt: input.receipt,
    }),
  ].join('\n\n');
}
