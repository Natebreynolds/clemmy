import {
  STANDING_POLICY_COMPILER_PROTOCOL,
  STANDING_POLICY_SCHEMA_VERSION,
  sealStandingPolicyDescriptor,
  standingPolicySourceSha256,
  type StandingPolicyDescriptor,
  type StandingPolicyDescriptorBody,
} from '../../memory/policy-enforcement.js';

export const COMPOSIO_STANDING_POLICY_ADAPTER_ID = 'composio' as const;
export const COMPOSIO_STANDING_POLICY_COMPILER_VERSION = 1 as const;

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const CONNECTION_RE = /\bca_[A-Za-z0-9_-]+\b/;

const GENERIC_CALENDAR_RULE_TOKENS = new Set([
  'outlook', 'calendar', 'calendars', 'connection', 'connections', 'connected', 'account', 'accounts',
  'lookup', 'lookups', 'event', 'events', 'meeting', 'meetings', 'schedule', 'scheduling',
  'appointment', 'appointments', 'read', 'reads', 'reading', 'check', 'checks', 'checking',
  'view', 'get', 'list', 'use', 'using', 'used', 'for', 'the', 'and', 'this', 'that', 'with',
  'from', 'only', 'other', 'others', 'active', 'returned', 'return', 'returns', 'not', 'none',
  'when', 'all', 'any', 'was', 'were', 'been', 'must', 'should', 'always', 'never', 'please',
  'its', 'instead', 'because', 'via', 'has', 'have', 'had', 'one', 'two', 'both', 'known',
]);

function calendarIntentLabels(content: string): string[] {
  const withoutIds = content.replace(new RegExp(CONNECTION_RE.source, 'gi'), ' ');
  const words = withoutIds.toLowerCase().match(/\b[a-z][a-z0-9'-]{2,}\b/g) ?? [];
  return [...new Set(words.filter((word) => !GENERIC_CALENDAR_RULE_TOKENS.has(word)))].slice(0, 64);
}

function baseBody(content: string): Omit<StandingPolicyDescriptorBody,
  'deterministic' | 'policyClass' | 'gateways' | 'bindings' | 'directives' | 'capabilityHints' | 'reason'> {
  return {
    schemaVersion: STANDING_POLICY_SCHEMA_VERSION,
    contract: 'standing_policy',
    compiler: {
      protocol: STANDING_POLICY_COMPILER_PROTOCOL,
      adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
      version: COMPOSIO_STANDING_POLICY_COMPILER_VERSION,
    },
    sourceSha256: standingPolicySourceSha256(content),
  };
}

function promptToolkitBindings(content: string): StandingPolicyDescriptorBody['bindings'] {
  const bindings: StandingPolicyDescriptorBody['bindings'] = [];
  const text = content.toLowerCase();
  if (/\boutlook\b/.test(text)) {
    bindings.push({ adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID, kind: 'toolkit', value: 'outlook' });
  }
  if (/\bsalesforce\b/.test(text)) {
    bindings.push({ adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID, kind: 'toolkit', value: 'salesforce' });
  }
  return bindings;
}

function unclassified(content: string): StandingPolicyDescriptor {
  const bindings = promptToolkitBindings(content);
  return sealStandingPolicyDescriptor({
    ...baseBody(content),
    deterministic: false,
    policyClass: 'unclassified',
    gateways: [],
    bindings,
    directives: [],
    capabilityHints: [],
    reason: bindings.length > 0
      ? 'No deterministic compiler covers this rule; sealed toolkit bindings preserve it as prompt guidance only.'
      : 'No deterministic Composio standing-policy compiler covers this natural-language rule.',
  });
}

/**
 * Integration-edge compiler. All provider vocabulary and provider argument
 * shapes live here; the resulting contract is generic data consumed by the
 * memory and harness kernels.
 */
export function compileComposioStandingPolicy(content: string): StandingPolicyDescriptor {
  const text = content.replace(/\s+/g, ' ').trim().toLowerCase();
  const email = content.match(EMAIL_RE)?.[0]?.toLowerCase();
  if (text.includes('outlook') && /\b(?:send|sending|mail|email)\b/.test(text) && email) {
    return sealStandingPolicyDescriptor({
      ...baseBody(content),
      deterministic: true,
      policyClass: 'verified_sender_identity',
      gateways: ['composio_execute_tool'],
      bindings: [{ adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID, kind: 'toolkit', value: 'outlook' }],
      directives: [{
        kind: 'verified_identity',
        selector: {
          adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
          allTags: ['channel:email', 'effect:irreversible-send'],
        },
        preferenceSelector: {
          adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
          allTags: ['provider:outlook', 'effect:reversible-draft'],
        },
        identityKind: 'mailbox',
        requiredValue: email,
        verifierCapability: 'OUTLOOK_GET_PROFILE',
        reason: `The connected sending identity must verify as ${email}.`,
        violatingField: 'sending identity',
        overrideAllowed: true,
        recovery: `Select and verify the connected account for ${email}.`,
      }],
      capabilityHints: [],
      reason: 'The adapter verifies the connected mailbox before an irreversible email send.',
    });
  }

  const connection = content.match(CONNECTION_RE)?.[0];
  if (text.includes('outlook') && text.includes('calendar') && connection) {
    const intentLabels = calendarIntentLabels(content);
    return sealStandingPolicyDescriptor({
      ...baseBody(content),
      deterministic: true,
      policyClass: 'connection_route',
      gateways: ['composio_execute_tool'],
      bindings: [{ adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID, kind: 'toolkit', value: 'outlook' }],
      directives: [{
        kind: 'route',
        selector: {
          adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
          allTags: ['provider:outlook', 'domain:calendar', 'effect:read'],
        },
        bindingKind: 'connected-account',
        bindingValue: connection,
        intentLabels,
        reason: `The matching read must use the sealed connected-account route ${connection}.`,
        violatingField: 'connected account route',
        overrideAllowed: false,
        recovery: 'Use an account-addressable provider route that can honor the sealed connection.',
      }],
      capabilityHints: intentLabels.length === 0 ? [] : [{
        adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
        intentLabels,
        requiresTemporalCue: true,
        allowedServerSlugs: ['outlook', 'microsoft_outlook', 'microsoft'],
        toolPatterns: ['outlook', 'email', 'mail', 'calendar', 'event'],
        priorityKeywords: ['list', 'search', 'calendar'],
        maxTools: 8,
      }],
      reason: 'The adapter binds a labeled calendar read to a sealed connected-account id.',
    });
  }

  if (text.includes('salesforce') && text.includes('composio') && /\bsf\s+cli\b/.test(text)
    && /\b(?:never|do not|don't|expired|dead)\b/.test(text)) {
    return sealStandingPolicyDescriptor({
      ...baseBody(content),
      deterministic: true,
      policyClass: 'route_denial',
      gateways: ['composio_execute_tool'],
      bindings: [{ adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID, kind: 'toolkit', value: 'salesforce' }],
      directives: [{
        kind: 'deny',
        selector: {
          adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
          allTags: ['toolkit:salesforce'],
        },
        reason: 'This provider gateway route is forbidden by the sealed standing policy; use the authenticated local sf CLI.',
        violatingField: 'tool route',
        overrideAllowed: false,
        recovery: 'Use the authenticated local sf CLI route named by the standing policy.',
      }],
      capabilityHints: [],
      reason: 'The adapter denies the provider gateway route and preserves the required local route.',
    });
  }

  if (text.includes('salesforce') && text.includes('org')
    && (text.includes('sandbox') || text.includes('production_disabled'))) {
    const sandboxOnly = text.includes('sandbox');
    return sealStandingPolicyDescriptor({
      ...baseBody(content),
      deterministic: true,
      policyClass: 'environment_constraint',
      gateways: ['composio_execute_tool'],
      bindings: [{ adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID, kind: 'toolkit', value: 'salesforce' }],
      directives: [{
        kind: 'field_constraint',
        selector: {
          adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
          allTags: ['toolkit:salesforce'],
        },
        field: 'target-environment',
        operator: sandboxOnly ? 'require_contains' : 'forbid_contains',
        values: [sandboxOnly ? 'sandbox' : 'production'],
        requirePresent: false,
        reason: sandboxOnly
          ? 'The selected organization violates the sealed sandbox-only policy.'
          : 'The selected organization violates the sealed production-disabled policy.',
        violatingField: 'target environment',
        overrideAllowed: false,
        recovery: 'Select an environment allowed by the standing policy.',
      }],
      capabilityHints: [],
      reason: 'The adapter compares the normalized target environment with a sealed value constraint.',
    });
  }

  if (text.includes('production') && text.includes('sandbox')
    && /\b(?:never|do not|don't|only|requires?)\b/.test(text)) {
    return sealStandingPolicyDescriptor({
      ...baseBody(content),
      deterministic: true,
      policyClass: 'environment_constraint',
      gateways: ['composio_execute_tool'],
      bindings: [],
      directives: [{
        kind: 'field_constraint',
        selector: {
          adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
          allTags: ['effect:external-write'],
        },
        field: 'target-environment',
        operator: 'forbid_contains',
        values: ['production'],
        requirePresent: false,
        reason: 'The normalized target is production, which the sealed standing policy forbids.',
        violatingField: 'target environment',
        overrideAllowed: false,
        recovery: 'Select a sandbox or staging target.',
      }],
      capabilityHints: [],
      reason: 'The adapter rejects a normalized production target for an external write.',
    });
  }

  return unclassified(content);
}

/**
 * Exact historical v1 compiler used only by migration 28. Kept at the adapter
 * edge so replaying that immutable migration does not reintroduce provider
 * parsing into memory-core code.
 */
export function classifyConstraintEnforcementV1(content: string): {
  schemaVersion: 1;
  family: 'outlook_sender' | 'outlook_calendar_route' | 'salesforce_cli_only'
    | 'salesforce_environment' | 'production_environment' | 'unclassified';
  deterministic: boolean;
  tools: string[];
  reason: string;
} {
  const text = content.replace(/\s+/g, ' ').trim().toLowerCase();
  if (text.includes('outlook') && /\b(?:send|sending|mail|email)\b/.test(text) && EMAIL_RE.test(content)) {
    return { schemaVersion: 1, family: 'outlook_sender', deterministic: true, tools: ['composio_execute_tool'], reason: 'The dispatch gate verifies the connected Outlook mailbox before an irreversible send.' };
  }
  if (text.includes('outlook') && text.includes('calendar') && CONNECTION_RE.test(content)) {
    return { schemaVersion: 1, family: 'outlook_calendar_route', deterministic: true, tools: ['composio_execute_tool'], reason: 'The dispatch router binds a named calendar lookup to the persisted connection id.' };
  }
  if (text.includes('salesforce') && text.includes('composio') && /\bsf\s+cli\b/.test(text)
    && /\b(?:never|do not|don't|expired|dead)\b/.test(text)) {
    return { schemaVersion: 1, family: 'salesforce_cli_only', deterministic: true, tools: ['composio_execute_tool'], reason: 'Every Composio Salesforce dispatch is blocked so the required local sf CLI path is the only route.' };
  }
  if (text.includes('salesforce') && text.includes('org')
    && (text.includes('sandbox') || text.includes('production_disabled'))) {
    return { schemaVersion: 1, family: 'salesforce_environment', deterministic: true, tools: ['composio_execute_tool'], reason: 'The dispatch gate compares the requested Salesforce organization with the allowed environment.' };
  }
  if (text.includes('production') && text.includes('sandbox')
    && /\b(?:never|do not|don't|only|requires?)\b/.test(text)) {
    return { schemaVersion: 1, family: 'production_environment', deterministic: true, tools: ['composio_execute_tool'], reason: 'The dispatch gate rejects concrete production environment or table arguments.' };
  }
  return { schemaVersion: 1, family: 'unclassified', deterministic: false, tools: [], reason: 'No deterministic dispatch compiler currently covers this natural-language rule.' };
}
