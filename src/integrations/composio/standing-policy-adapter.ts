import type { ConsolidatedFact } from '../../memory/facts.js';
import type {
  StandingPolicyCapabilityHint,
  StandingPolicyIdentityDirective,
  StandingPolicyRouteDirective,
} from '../../memory/policy-enforcement.js';
import {
  checkStandingPolicyViolation,
  formatConstraintEscalation,
  matchingStandingPolicyDirectives,
  standingPoliciesForBinding,
  standingPolicyCapabilityHints,
  type ConstraintViolation,
  type StandingPolicyDispatchContext,
  type StandingPolicyDirectiveMatch,
} from '../../runtime/harness/constraint-guard.js';
import { isIrreversibleSendSlug } from '../../runtime/harness/execution-gate.js';
import {
  actionTargetsUnsentDraft,
  classifyComposioSlugEffect,
} from './slug-effect.js';
import { registeredToolkitOfSlug } from './toolkit-slug.js';
import { COMPOSIO_STANDING_POLICY_ADAPTER_ID } from './standing-policy-compiler.js';

export interface EmailSendConstraint {
  constraint: ConsolidatedFact;
  allowedAccount: string;
  verifierCapability: string;
  overrideAllowed: boolean;
}

export interface EmailDraftAuthoringPreference {
  constraint: ConsolidatedFact;
  preferredAccount: string;
}

export interface ComposioConnectionReadConstraint {
  constraint: ConsolidatedFact;
  routeConnectionId: string;
}

const RECIPIENT_KEY_RE = /^(to|cc|bcc|to_recipients?|cc_recipients?|bcc_recipients?|recipients?|to_emails?|recipient_emails?|to_address(es)?|from|from_email|reply_to)$/i;
const EMAIL_LITERAL_RE = /[\w\-.+]+@[\w\-.]+\.[a-z]{2,}/i;
const EMAILISH_SLUG_RE = /MAIL|EMAIL|OUTLOOK|SMTP|MESSAGE_SEND_AS/i;
const CALENDAR_TOKEN_RE = /(?:^|_)(?:CALENDAR|EVENT|EVENTS)(?:_|$)/i;

function argsAddressEmailRecipients(args: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(args)) {
    if (!RECIPIENT_KEY_RE.test(key)) continue;
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
      if (EMAIL_LITERAL_RE.test(text)) return true;
    } catch { /* unreadable addressing value is not positive family evidence */ }
  }
  return false;
}

/** Provider-shape predicate intentionally owned by the Composio adapter. */
export function isComposioEmailFamilySend(toolSlug: string, args: Record<string, unknown>): boolean {
  return EMAILISH_SLUG_RE.test(toolSlug) || argsAddressEmailRecipients(args);
}

function targetEnvironment(args: Record<string, unknown>): string | undefined {
  const values = [
    args.target_org,
    args.org,
    args.environment,
    args.env,
    args.table,
    args.tableName,
  ].map((value) => String(value ?? '').trim()).filter(Boolean);
  return values.length > 0 ? values.join(' ') : undefined;
}

function composioPolicyContext(
  toolName: string,
  toolSlug: string,
  args: Record<string, unknown>,
): StandingPolicyDispatchContext {
  const toolkit = registeredToolkitOfSlug(toolSlug).toLowerCase();
  const tags = new Set<string>([`toolkit:${toolkit}`]);
  if (toolkit === 'outlook') tags.add('provider:outlook');
  if (CALENDAR_TOKEN_RE.test(toolSlug)) tags.add('domain:calendar');
  const effect = classifyComposioSlugEffect(toolSlug);
  tags.add(effect === 'read' ? 'effect:read' : 'effect:external-write');
  if (isIrreversibleSendSlug(toolSlug)) tags.add('effect:irreversible-send');
  if (actionTargetsUnsentDraft(toolSlug)
    && /(?:^|_)CREATE(?:_[A-Z0-9]+)*_DRAFT(?:_|$)/.test(toolSlug.trim().toUpperCase())) {
    tags.add('effect:reversible-draft');
  }
  if (isComposioEmailFamilySend(toolSlug, args)) tags.add('channel:email');
  return {
    adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
    toolName,
    tags: [...tags],
    fields: {
      'target-environment': targetEnvironment(args),
      'identity:mailbox': String(args.from ?? args.account ?? '').trim() || undefined,
    },
  };
}

function uniqueIdentityMatch(
  matches: Array<StandingPolicyDirectiveMatch<StandingPolicyIdentityDirective>>,
): StandingPolicyDirectiveMatch<StandingPolicyIdentityDirective> | null {
  if (matches.length === 0) return null;
  const values = new Set(matches.map((match) => match.directive.requiredValue.toLowerCase()));
  if (values.size !== 1) throw new Error('conflicting sealed sender-identity standing policies');
  return matches[0]!;
}

export function findComposioEmailSendConstraint(
  toolSlug: string,
  args: Record<string, unknown>,
): EmailSendConstraint | null {
  if (!isIrreversibleSendSlug(toolSlug) || !isComposioEmailFamilySend(toolSlug, args)) return null;
  const match = uniqueIdentityMatch(matchingStandingPolicyDirectives(
    composioPolicyContext('composio_execute_tool', toolSlug, args),
    'verified_identity',
  ));
  return match ? {
    constraint: match.constraint,
    allowedAccount: match.directive.requiredValue.toLowerCase(),
    verifierCapability: match.directive.verifierCapability,
    overrideAllowed: match.directive.overrideAllowed,
  } : null;
}

export function findComposioEmailDraftAuthoringPreference(
  toolSlug: string,
): EmailDraftAuthoringPreference | null {
  const context = composioPolicyContext('composio_execute_tool', toolSlug, {});
  const match = uniqueIdentityMatch(matchingStandingPolicyDirectives(
    context,
    'verified_identity',
    { selector: 'preference' },
  ));
  return match ? {
    constraint: match.constraint,
    preferredAccount: match.directive.requiredValue.toLowerCase(),
  } : null;
}

function intentNamesLabel(intent: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(intent);
}

export function findComposioConnectionReadConstraint(
  toolSlug: string,
  args: Record<string, unknown>,
  intentText = '',
): ComposioConnectionReadConstraint | null {
  let argsText = '';
  try { argsText = JSON.stringify(args).slice(0, 2_000); } catch { /* no argument intent */ }
  const combinedIntent = `${intentText}\n${argsText}`;
  if (!combinedIntent.trim()) return null;
  const matches = matchingStandingPolicyDirectives(
    composioPolicyContext('composio_execute_tool', toolSlug, args),
    'route',
  ).filter((match) => match.directive.intentLabels.some((label) => intentNamesLabel(combinedIntent, label)));
  if (matches.length === 0) return null;
  const routes = new Set(matches.map((match) => match.directive.bindingValue));
  if (routes.size !== 1) throw new Error('conflicting sealed connected-account standing-policy routes');
  return { constraint: matches[0]!.constraint, routeConnectionId: matches[0]!.directive.bindingValue };
}

export function checkComposioConstraintViolation(
  toolName: string,
  toolSlug: string,
  args: Record<string, unknown>,
  options: { senderIdentityHandledExternally?: boolean } = {},
): ConstraintViolation | null {
  return checkStandingPolicyViolation(
    composioPolicyContext(toolName, toolSlug, args),
    options.senderIdentityHandledExternally
      ? { externallyHandledKinds: ['verified_identity'] }
      : {},
  );
}

export function composioStandingPolicyCapabilityHints(): StandingPolicyCapabilityHint[] {
  return standingPolicyCapabilityHints(COMPOSIO_STANDING_POLICY_ADAPTER_ID);
}

export function constraintsForComposioToolkit(toolkitSlug: string): ConsolidatedFact[] {
  const slug = toolkitSlug.trim().toLowerCase();
  if (!slug || slug === 'unknown' || slug === '*') return [];
  return standingPoliciesForBinding({
    adapterId: COMPOSIO_STANDING_POLICY_ADAPTER_ID,
    kind: 'toolkit',
    value: slug,
  }, { includePrompt: true }).map((policy) => policy.constraint);
}

export function renderComposioToolkitConstraintBanner(toolkitSlug: string): string | null {
  const rules = constraintsForComposioToolkit(toolkitSlug);
  if (rules.length === 0) return null;
  return [
    '',
    `⚖️ SEALED STANDING POLICIES bound to the ${toolkitSlug} toolkit:`,
    ...rules.map((constraint) => `- ${constraint.content}`),
  ].join('\n');
}

export { formatConstraintEscalation };
