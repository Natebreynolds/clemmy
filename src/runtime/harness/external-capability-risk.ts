/**
 * Pure, provider-neutral risk projection for one exact external capability.
 *
 * Provider adapters own live I/O. They hand this module a closed snapshot of
 * the current manifest, current definition, behavior declarations, and any
 * host-reviewed semantic. This module never consults provider names, prose,
 * storage, policy scope, or process state. Its only output is the risk portion
 * of a call attestation plus a digest that invalidates when any authority or
 * classifier byte changes.
 */
import { createHash } from 'node:crypto';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import type {
  CapabilityRiskAttestationV1,
  InteractiveConsentConsequence,
  InteractiveConsentDestination,
  InteractiveConsentReversibility,
} from './interactive-consent-policy.js';

export const EXTERNAL_CAPABILITY_RISK_INPUT_VERSION = 1 as const;
export const EXTERNAL_CAPABILITY_RISK_CLASSIFIER_VERSION = 1 as const;

export type ExternalCapabilityProviderKind = 'composio' | 'native_mcp';
export type ExternalCapabilityEffect = 'read' | 'external_write' | 'admin';

export interface ExternalCapabilityRiskInputV1 {
  version: typeof EXTERNAL_CAPABILITY_RISK_INPUT_VERSION;
  manifest: {
    manifestVersion: number;
    manifestId: string;
    manifestDigest: string;
    providerKind: ExternalCapabilityProviderKind;
    providerIdentity: string;
    providerVersion: string;
    operationId: string;
    operationVersion: string;
    schemaFingerprint: string;
    accountId: string;
    effect: ExternalCapabilityEffect;
    destination: InteractiveConsentDestination;
  };
  liveDefinition: {
    definitionDigest: string;
    providerKind: ExternalCapabilityProviderKind;
    providerIdentity: string;
    providerVersion: string;
    operationId: string;
    operationVersion: string;
    schemaFingerprint: string;
    accountId: string;
    /** Operation-only vocabulary. The adapter removes toolkit/server names. */
    semanticName: string;
  };
  behaviorHints: {
    readOnly: boolean | null;
    destructive: boolean | null;
    idempotent: boolean | null;
    openWorld: boolean | null;
  };
  /** Host-derived from the exact bound arguments, never model-authored. */
  callSignals: {
    outboundDelivery: boolean | null;
  };
  documentedSemantic: null | {
    sourceDigest: string;
    effect: ExternalCapabilityEffect;
    reversibility: InteractiveConsentReversibility;
    consequence: InteractiveConsentConsequence;
    destructive: boolean;
  };
  safety: CapabilityRiskAttestationV1['safety'];
}

export interface ExternalCapabilityRiskProjectionV1 {
  version: typeof EXTERNAL_CAPABILITY_RISK_INPUT_VERSION;
  effect: ExternalCapabilityEffect;
  risk: CapabilityRiskAttestationV1['risk'];
  semanticBasis: {
    kind: 'current_external_definition';
    digest: string;
  };
  safety: CapabilityRiskAttestationV1['safety'];
}

export type ExternalCapabilityRiskRefusal =
  | 'malformed_input'
  | 'identity_mismatch'
  | 'effect_conflict'
  | 'semantic_conflict';

export type ExternalCapabilityRiskProjectionResult =
  | { ok: true; projection: ExternalCapabilityRiskProjectionV1 }
  | { ok: false; reason: ExternalCapabilityRiskRefusal };

const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_IDENTITY_BYTES = 2_048;
const CANONICAL_LIMITS = Object.freeze({
  maxDepth: 12,
  maxNodes: 512,
  maxStringBytes: MAX_IDENTITY_BYTES,
  maxTotalBytes: 32_768,
});

const TOP_LEVEL_KEYS = new Set([
  'version',
  'manifest',
  'liveDefinition',
  'behaviorHints',
  'callSignals',
  'documentedSemantic',
  'safety',
]);
const MANIFEST_KEYS = new Set([
  'manifestVersion',
  'manifestId',
  'manifestDigest',
  'providerKind',
  'providerIdentity',
  'providerVersion',
  'operationId',
  'operationVersion',
  'schemaFingerprint',
  'accountId',
  'effect',
  'destination',
]);
const LIVE_DEFINITION_KEYS = new Set([
  'definitionDigest',
  'providerKind',
  'providerIdentity',
  'providerVersion',
  'operationId',
  'operationVersion',
  'schemaFingerprint',
  'accountId',
  'semanticName',
]);
const HINT_KEYS = new Set(['readOnly', 'destructive', 'idempotent', 'openWorld']);
const CALL_SIGNAL_KEYS = new Set(['outboundDelivery']);
const DOCUMENTED_KEYS = new Set([
  'sourceDigest',
  'effect',
  'reversibility',
  'consequence',
  'destructive',
]);
const DESTINATION_KEYS = new Set(['digest', 'posture']);

const PROVIDER_KINDS = new Set<ExternalCapabilityProviderKind>(['composio', 'native_mcp']);
const EFFECTS = new Set<ExternalCapabilityEffect>(['read', 'external_write', 'admin']);
const SAFETY = new Set<CapabilityRiskAttestationV1['safety']>([
  'admissible', 'protected', 'untrusted',
]);
const REVERSIBILITY = new Set<InteractiveConsentReversibility>([
  'read_only',
  'reversible',
  'ordinary_non_destructive',
  'irreversible',
  'unknown',
]);
const CONSEQUENCES = new Set<InteractiveConsentConsequence>([
  'read', 'create', 'update', 'delete', 'send', 'execute', 'admin', 'unknown',
]);
const DESTINATION_POSTURES = new Set<InteractiveConsentDestination['posture']>([
  'create_new', 'named_existing', 'not_applicable',
]);

const READ_ACTIONS = new Set([
  'GET', 'LIST', 'SEARCH', 'FIND', 'FETCH', 'READ', 'QUERY', 'LOOKUP',
  'RETRIEVE', 'DESCRIBE', 'BROWSE', 'SCAN', 'VIEW', 'INSPECT', 'STATUS',
  'HEAD', 'PEEK', 'COUNT', 'PREVIEW', 'SHOW', 'CHECK', 'DISCOVER',
  'ENUMERATE', 'AUDIT', 'OBSERVE',
]);
const CREATE_ACTIONS = new Set([
  'CREATE', 'INSERT', 'ADD', 'NEW', 'COPY', 'DUPLICATE', 'UPLOAD', 'REGISTER',
]);
const UPDATE_ACTIONS = new Set([
  'UPDATE', 'EDIT', 'PATCH', 'MODIFY', 'REPLACE', 'SET', 'RENAME', 'MOVE',
  'APPEND', 'SAVE', 'UPSERT', 'MERGE', 'MARK', 'ARCHIVE', 'RESTORE',
  'ASSIGN', 'UNASSIGN', 'ATTACH', 'DETACH', 'LINK', 'UNLINK', 'ACCEPT',
  'REJECT', 'APPROVE', 'DECLINE', 'CANCEL',
]);
const DELETE_ACTIONS = new Set([
  'DELETE', 'REMOVE', 'DESTROY', 'PURGE', 'ERASE', 'DROP', 'TRASH',
]);
const SEND_ACTIONS = new Set([
  'SEND', 'PUBLISH', 'DISPATCH', 'BROADCAST', 'FORWARD', 'REPLY', 'DM',
  'TWEET', 'DIAL', 'INVITE', 'NOTIFY', 'DELIVER', 'ANNOUNCE',
]);
const EXECUTE_ACTIONS = new Set([
  'RUN', 'EXECUTE', 'TRIGGER', 'SUBMIT', 'START', 'LAUNCH', 'INVOKE', 'CALL',
]);
const ADMIN_ACTIONS = new Set([
  'ADMIN', 'INSTALL', 'UNINSTALL', 'CONFIGURE', 'GRANT', 'REVOKE', 'ROTATE',
  'ENABLE', 'DISABLE', 'CONNECT', 'DISCONNECT', 'AUTHORIZE', 'DEAUTHORIZE',
]);
const ADMIN_OBJECTS = new Set([
  'CREDENTIAL', 'CREDENTIALS', 'SECRET', 'SECRETS', 'APIKEY', 'APIKEYS',
  'AUTH', 'AUTHORIZATION', 'PERMISSION', 'PERMISSIONS', 'ROLE', 'ROLES',
  'MEMBER', 'MEMBERS', 'OWNER', 'OWNERS', 'INTEGRATION', 'INTEGRATIONS',
  'WEBHOOK', 'WEBHOOKS', 'ACCOUNT', 'ACCOUNTS', 'CONNECTION', 'CONNECTIONS',
]);
const COMMUNICATION_OBJECTS = new Set([
  'MESSAGE', 'MESSAGES', 'EMAIL', 'EMAILS', 'MAIL', 'SMS', 'CALL', 'POST',
  'POSTS', 'TWEET', 'TWEETS', 'INVITE', 'INVITES', 'INVITATION', 'DM',
  'NOTIFICATION', 'NOTIFICATIONS', 'ANNOUNCEMENT', 'EVENT', 'EVENTS',
  'MEETING', 'MEETINGS',
]);
const NON_DELIVERY_CREATE_OBJECTS = new Set([
  'DRAFT', 'DRAFTS', 'ATTACHMENT', 'ATTACHMENTS', 'FOLDER', 'FOLDERS',
  'RULE', 'RULES', 'EXTENSION', 'EXTENSIONS', 'TEMPLATE', 'TEMPLATES',
  'SCHEMA', 'SCHEMAS', 'UPLOAD_SESSION', 'UPLOAD_SESSIONS',
]);
const CONNECTORS = new Set(['AND', 'OR', 'THEN']);

type StructuralConsequence = InteractiveConsentConsequence | 'post';

interface StructuralClassification {
  consequence: InteractiveConsentConsequence;
  destructive: boolean;
  reversibility: InteractiveConsentReversibility;
  affirmativeMutation: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function boundedNonBlank(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= MAX_IDENTITY_BYTES;
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function validDestination(value: unknown): value is InteractiveConsentDestination {
  return isRecord(value)
    && hasExactKeys(value, DESTINATION_KEYS)
    && typeof value.digest === 'string'
    && SHA256.test(value.digest)
    && typeof value.posture === 'string'
    && DESTINATION_POSTURES.has(value.posture as InteractiveConsentDestination['posture']);
}

function validDocumentedSemantic(
  value: unknown,
): value is NonNullable<ExternalCapabilityRiskInputV1['documentedSemantic']> {
  if (!isRecord(value) || !hasExactKeys(value, DOCUMENTED_KEYS)) return false;
  if (typeof value.sourceDigest !== 'string' || !SHA256.test(value.sourceDigest)) return false;
  if (typeof value.effect !== 'string' || !EFFECTS.has(value.effect as ExternalCapabilityEffect)) return false;
  if (
    typeof value.reversibility !== 'string'
    || !REVERSIBILITY.has(value.reversibility as InteractiveConsentReversibility)
  ) return false;
  if (
    typeof value.consequence !== 'string'
    || !CONSEQUENCES.has(value.consequence as InteractiveConsentConsequence)
  ) return false;
  return typeof value.destructive === 'boolean';
}

function parseClosedInput(raw: unknown): ExternalCapabilityRiskInputV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(closedCanonicalJson(raw, CANONICAL_LIMITS)) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, TOP_LEVEL_KEYS)) return null;
  if (parsed.version !== EXTERNAL_CAPABILITY_RISK_INPUT_VERSION) return null;

  const manifest = parsed.manifest;
  const live = parsed.liveDefinition;
  const hints = parsed.behaviorHints;
  const signals = parsed.callSignals;
  if (
    !isRecord(manifest)
    || !hasExactKeys(manifest, MANIFEST_KEYS)
    || !Number.isSafeInteger(manifest.manifestVersion)
    || Number(manifest.manifestVersion) <= 0
    || !boundedNonBlank(manifest.manifestId)
    || typeof manifest.manifestDigest !== 'string'
    || !SHA256.test(manifest.manifestDigest)
    || typeof manifest.providerKind !== 'string'
    || !PROVIDER_KINDS.has(manifest.providerKind as ExternalCapabilityProviderKind)
    || !boundedNonBlank(manifest.providerIdentity)
    || !boundedNonBlank(manifest.providerVersion)
    || !boundedNonBlank(manifest.operationId)
    || !boundedNonBlank(manifest.operationVersion)
    || typeof manifest.schemaFingerprint !== 'string'
    || !SHA256.test(manifest.schemaFingerprint)
    || !boundedNonBlank(manifest.accountId)
    || typeof manifest.effect !== 'string'
    || !EFFECTS.has(manifest.effect as ExternalCapabilityEffect)
    || !validDestination(manifest.destination)
  ) return null;

  if (
    !isRecord(live)
    || !hasExactKeys(live, LIVE_DEFINITION_KEYS)
    || typeof live.definitionDigest !== 'string'
    || !SHA256.test(live.definitionDigest)
    || typeof live.providerKind !== 'string'
    || !PROVIDER_KINDS.has(live.providerKind as ExternalCapabilityProviderKind)
    || !boundedNonBlank(live.providerIdentity)
    || !boundedNonBlank(live.providerVersion)
    || !boundedNonBlank(live.operationId)
    || !boundedNonBlank(live.operationVersion)
    || typeof live.schemaFingerprint !== 'string'
    || !SHA256.test(live.schemaFingerprint)
    || !boundedNonBlank(live.accountId)
    || !boundedNonBlank(live.semanticName)
  ) return null;

  if (
    !isRecord(hints)
    || !hasExactKeys(hints, HINT_KEYS)
    || !nullableBoolean(hints.readOnly)
    || !nullableBoolean(hints.destructive)
    || !nullableBoolean(hints.idempotent)
    || !nullableBoolean(hints.openWorld)
  ) return null;
  if (
    !isRecord(signals)
    || !hasExactKeys(signals, CALL_SIGNAL_KEYS)
    || !nullableBoolean(signals.outboundDelivery)
  ) return null;
  if (parsed.documentedSemantic !== null && !validDocumentedSemantic(parsed.documentedSemantic)) {
    return null;
  }
  if (typeof parsed.safety !== 'string' || !SAFETY.has(parsed.safety as CapabilityRiskAttestationV1['safety'])) {
    return null;
  }
  return parsed as unknown as ExternalCapabilityRiskInputV1;
}

function identitiesMatch(input: ExternalCapabilityRiskInputV1): boolean {
  const manifest = input.manifest;
  const live = input.liveDefinition;
  return manifest.providerKind === live.providerKind
    && manifest.providerIdentity === live.providerIdentity
    && manifest.providerVersion === live.providerVersion
    && manifest.operationId === live.operationId
    && manifest.operationVersion === live.operationVersion
    && manifest.schemaFingerprint === live.schemaFingerprint
    && manifest.accountId === live.accountId;
}

function operationTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

function actionClass(token: string): StructuralConsequence | null {
  if (token === 'POST') return 'post';
  if (ADMIN_ACTIONS.has(token)) return 'admin';
  if (DELETE_ACTIONS.has(token)) return 'delete';
  if (SEND_ACTIONS.has(token)) return 'send';
  if (CREATE_ACTIONS.has(token)) return 'create';
  if (UPDATE_ACTIONS.has(token)) return 'update';
  if (READ_ACTIONS.has(token)) return 'read';
  if (EXECUTE_ACTIONS.has(token)) return 'execute';
  return null;
}

function connectedActions(
  tokens: readonly string[],
  primaryIndex: number,
): StructuralConsequence[] {
  const actions: StructuralConsequence[] = [];
  for (let index = primaryIndex + 1; index < tokens.length; index += 1) {
    const action = actionClass(tokens[index] ?? '');
    if (!action) continue;
    if (tokens.slice(primaryIndex + 1, index).some((token) => CONNECTORS.has(token))) {
      actions.push(action);
    }
  }
  return actions;
}

function structuralClassification(
  semanticName: string,
  hints: ExternalCapabilityRiskInputV1['behaviorHints'],
  signals: ExternalCapabilityRiskInputV1['callSignals'],
): StructuralClassification {
  const tokens = operationTokens(semanticName);
  const actionEntries = tokens.flatMap((token, index) => {
    const consequence = actionClass(token);
    return consequence ? [{ index, consequence }] : [];
  });
  const primary = actionEntries[0] ?? null;
  const connected = primary ? connectedActions(tokens, primary.index) : [];
  const draft = tokens.some((token) => token === 'DRAFT' || token === 'DRAFTS');
  const adminObject = tokens.some((token) => ADMIN_OBJECTS.has(token));
  const communicationObject = tokens.some((token) => COMMUNICATION_OBJECTS.has(token));
  const shieldedCreate = tokens.some((token) => NON_DELIVERY_CREATE_OBJECTS.has(token));

  const admin = primary?.consequence === 'admin'
    || connected.includes('admin')
    || Boolean(primary && ADMIN_ACTIONS.has(tokens[primary.index] ?? '') && adminObject);
  if (admin) {
    return {
      consequence: 'admin',
      reversibility: 'unknown',
      destructive: hints.destructive === true,
      affirmativeMutation: true,
    };
  }

  const deletion = primary?.consequence === 'delete' || connected.includes('delete');
  if (deletion) {
    return {
      consequence: 'delete',
      reversibility: 'unknown',
      destructive: true,
      affirmativeMutation: true,
    };
  }

  const explicitSend = primary?.consequence === 'send' || connected.includes('send');
  const postReadTransport = primary?.consequence === 'post'
    && tokens.slice(primary.index + 1).some((token) => READ_ACTIONS.has(token));
  const postDelivery = primary?.consequence === 'post'
    && !postReadTransport
    && communicationObject;
  const createDelivery = primary?.consequence === 'create'
    && communicationObject
    && !draft
    && !shieldedCreate
    && signals.outboundDelivery !== false;
  if (signals.outboundDelivery === true || explicitSend || postDelivery || createDelivery) {
    return {
      consequence: 'send',
      reversibility: 'irreversible',
      destructive: hints.destructive === true,
      affirmativeMutation: true,
    };
  }

  if (hints.destructive === true) {
    const consequence = primary?.consequence === 'create' || primary?.consequence === 'update'
      ? primary.consequence
      : primary?.consequence === 'execute' ? 'execute' : 'unknown';
    return {
      consequence,
      reversibility: 'unknown',
      destructive: true,
      affirmativeMutation: true,
    };
  }

  if (postReadTransport) {
    return {
      consequence: 'read',
      reversibility: 'read_only',
      destructive: false,
      affirmativeMutation: false,
    };
  }

  const primaryConsequence = primary?.consequence;
  const connectedMutations = connected.filter((value) => value === 'create' || value === 'update');
  if (
    (primaryConsequence === 'create' && connectedMutations.includes('update'))
    || (primaryConsequence === 'update' && connectedMutations.includes('create'))
  ) {
    return {
      consequence: 'unknown',
      reversibility: 'unknown',
      destructive: false,
      affirmativeMutation: true,
    };
  }
  if (primaryConsequence === 'create' || primaryConsequence === 'update') {
    return {
      consequence: primaryConsequence,
      reversibility: 'ordinary_non_destructive',
      destructive: false,
      affirmativeMutation: true,
    };
  }
  // Conditional read-or-mutate operations are mutations, but retain the one
  // concrete mutation consequence when it is structurally unique.
  if (primaryConsequence === 'read' && connectedMutations.length === 1) {
    return {
      consequence: connectedMutations[0]!,
      reversibility: 'ordinary_non_destructive',
      destructive: false,
      affirmativeMutation: true,
    };
  }
  if (primaryConsequence === 'read' || hints.readOnly === true) {
    return {
      consequence: 'read',
      reversibility: 'read_only',
      destructive: false,
      affirmativeMutation: false,
    };
  }
  if (primaryConsequence === 'execute') {
    return {
      consequence: 'execute',
      reversibility: 'unknown',
      destructive: false,
      affirmativeMutation: false,
    };
  }
  return {
    consequence: 'unknown',
    reversibility: 'unknown',
    destructive: false,
    affirmativeMutation: false,
  };
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function finishProjection(
  input: ExternalCapabilityRiskInputV1,
  effect: ExternalCapabilityEffect,
  risk: CapabilityRiskAttestationV1['risk'],
): ExternalCapabilityRiskProjectionResult {
  const digestBytes = closedCanonicalJson({
    domain: 'external-capability-risk-attestation',
    version: EXTERNAL_CAPABILITY_RISK_INPUT_VERSION,
    classifierVersion: EXTERNAL_CAPABILITY_RISK_CLASSIFIER_VERSION,
    input,
    projection: { effect, risk, safety: input.safety },
  }, CANONICAL_LIMITS);
  return {
    ok: true,
    projection: {
      version: EXTERNAL_CAPABILITY_RISK_INPUT_VERSION,
      effect,
      risk,
      semanticBasis: {
        kind: 'current_external_definition',
        digest: sha256(digestBytes),
      },
      safety: input.safety,
    },
  };
}

/**
 * Project risk from closed, exact current authority. Unknown/conflicted facts
 * are returned as data or a typed refusal; this function never asks a user.
 */
export function projectExternalCapabilityRiskV1(
  raw: unknown,
): ExternalCapabilityRiskProjectionResult {
  const input = parseClosedInput(raw);
  if (!input) return { ok: false, reason: 'malformed_input' };
  if (!identitiesMatch(input)) return { ok: false, reason: 'identity_mismatch' };

  const documented = input.documentedSemantic;
  if (documented) {
    if (documented.effect !== input.manifest.effect) {
      return { ok: false, reason: 'effect_conflict' };
    }
    if (
      documented.effect === 'read'
      && (
        documented.consequence !== 'read'
        || documented.reversibility !== 'read_only'
        || documented.destructive
        || input.behaviorHints.destructive === true
        || input.callSignals.outboundDelivery === true
      )
    ) return { ok: false, reason: 'semantic_conflict' };
    if (documented.effect !== 'read' && documented.consequence === 'read') {
      return { ok: false, reason: 'semantic_conflict' };
    }
    const outbound = input.callSignals.outboundDelivery === true;
    return finishProjection(input, documented.effect, outbound
      ? {
          reversibility: 'irreversible',
          consequence: 'send',
          destructive: documented.destructive || input.behaviorHints.destructive === true,
        }
      : {
          reversibility: documented.reversibility,
          consequence: documented.consequence,
          destructive: documented.destructive || input.behaviorHints.destructive === true,
        });
  }

  const structural = structuralClassification(
    input.liveDefinition.semanticName,
    input.behaviorHints,
    input.callSignals,
  );

  if (input.manifest.effect === 'admin') {
    return finishProjection(input, 'admin', {
      reversibility: 'unknown',
      consequence: 'admin',
      destructive: structural.destructive,
    });
  }

  const structurallyHigh = structural.consequence === 'send'
    || structural.consequence === 'delete'
    || structural.consequence === 'admin'
    || structural.destructive;
  if (input.manifest.effect === 'read') {
    if (structural.affirmativeMutation || structurallyHigh) {
      return { ok: false, reason: 'effect_conflict' };
    }
    return finishProjection(input, 'read', {
      reversibility: 'read_only',
      consequence: 'read',
      destructive: false,
    });
  }

  if (structural.consequence === 'admin') {
    // Administrative semantics require an administrative manifest ceiling;
    // an ordinary external-write manifest cannot silently widen itself.
    return { ok: false, reason: 'effect_conflict' };
  }
  if (structural.consequence === 'read' && !structural.destructive) {
    return { ok: false, reason: 'effect_conflict' };
  }
  if (
    input.behaviorHints.readOnly === true
    && !structural.affirmativeMutation
    && !structural.destructive
  ) return { ok: false, reason: 'effect_conflict' };

  return finishProjection(input, 'external_write', {
    reversibility: structural.reversibility,
    consequence: structural.consequence,
    destructive: structural.destructive,
  });
}
