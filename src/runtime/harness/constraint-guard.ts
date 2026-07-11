/**
 * Pre-execution constraint checking for tool dispatch.
 *
 * Constraints are hard rules that gate tool execution before dispatch.
 * Example: "Use scorpion.co email account for all Outlook sends"
 *
 * This guard intercepts high-risk tools (composio_execute_tool, etc.) and
 * checks their args against active constraints before execution. If a
 * violation is detected, it escalates to the user instead of executing.
 */

import { listConstraints, type ConsolidatedFact } from '../../memory/facts.js';
import { isIrreversibleSendSlug } from './execution-gate.js';

export interface ConstraintViolation {
  constraint: ConsolidatedFact;
  reason: string;
  toolName: string;
  violatingField: string;
}

export interface EmailSendConstraint {
  constraint: ConsolidatedFact;
  /** The only mailbox this send is allowed to leave from (lowercased). */
  allowedAccount: string;
}

export interface OutlookCalendarReadConstraint {
  constraint: ConsolidatedFact;
  /** The Outlook connected account this calendar read must use. */
  routeConnectionId: string;
}

const EMAIL_IN_TEXT = /[\w\-.+]+@[\w\-.]+\.[a-z]{2,}/i;
const CONNECTION_ID_IN_TEXT = /\bca_[A-Za-z0-9_-]+\b/;
const OUTLOOK_MUTATING_CALENDAR_RE = /(?:^|[_\W])(?:create|add|insert|update|patch|delete|remove|cancel|send|draft|reply|forward)(?:$|[_\W])/i;

// Vocabulary that can't distinguish one pinned calendar from another. The
// distinguishing label (an org/workspace/account name) is whatever
// non-generic word the constraint AND the live intent share — fully
// data-driven, never a hardcoded account name.
const GENERIC_CALENDAR_RULE_TOKENS = new Set([
  'outlook', 'calendar', 'calendars', 'connection', 'connections', 'connected', 'account', 'accounts',
  'lookup', 'lookups', 'event', 'events', 'meeting', 'meetings', 'schedule', 'scheduling',
  'appointment', 'appointments', 'read', 'reads', 'reading', 'check', 'checks', 'checking',
  'view', 'get', 'list', 'use', 'using', 'used', 'for', 'the', 'and', 'this', 'that', 'with',
  'from', 'only', 'other', 'others', 'active', 'returned', 'return', 'returns', 'not', 'none',
  'when', 'all', 'any', 'was', 'were', 'been', 'must', 'should', 'always', 'never', 'please',
  'its', 'instead', 'because', 'via', 'has', 'have', 'had', 'one', 'two', 'both', 'known',
]);

function constraintLabelTokens(content: string): string[] {
  const withoutIds = content.replace(new RegExp(CONNECTION_ID_IN_TEXT.source, 'gi'), ' ');
  const words = withoutIds.toLowerCase().match(/\b[a-z][a-z0-9'-]{2,}\b/g) ?? [];
  return [...new Set(words.filter((w) => !GENERIC_CALENDAR_RULE_TOKENS.has(w)))];
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isOutlookCalendarReadSlug(toolSlug: string): boolean {
  const slug = toolSlug.toLowerCase();
  if (!slug.startsWith('outlook')) return false;
  if (!/\b(?:calendar|event|events)\b|calendar|event/.test(slug)) return false;
  return !OUTLOOK_MUTATING_CALENDAR_RE.test(slug);
}

function argsIntentText(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args).slice(0, 2000);
  } catch {
    return '';
  }
}

/**
 * Find the active email-account constraint that applies to this composio
 * call, if any. A constraint applies when it names email + outlook and the
 * slug is a send/draft action. The dispatch layer (composio-tools) uses this
 * to VERIFY the actual connected mailbox before the send leaves — pattern
 * matching alone cannot know which account `user_id: 'me'` resolves to.
 */
export function findEmailSendConstraint(
  toolSlug: string,
  _args: Record<string, unknown>,
): EmailSendConstraint | null {
  try {
    // Unify send detection on the single canonical chokepoint predicate: this
    // catches FORWARD/REPLY-send slugs (which contain neither "send" nor "draft"
    // — the pre-fix hole) and SEND_DRAFT, while correctly leaving reversible
    // CREATE_*_DRAFT ungated (a draft is not a send).
    if (!isIrreversibleSendSlug(toolSlug)) return null;
    for (const constraint of listConstraints()) {
      const content = constraint.content.toLowerCase();
      if (!content.includes('email') && !content.includes('mail')) continue;
      const match = constraint.content.match(EMAIL_IN_TEXT);
      if (!match) continue;
      return { constraint, allowedAccount: match[0].toLowerCase() };
    }
  } catch (err) {
    console.error('[constraint-guard] error finding email constraint:', err);
  }
  return null;
}

/**
 * Distinguishing labels of every pinned-calendar rule (e.g. the org names in
 * "For <Org> calendar lookups, use Outlook connection ca_..."). Used by the
 * tool scoper so a shorthand ask that names the org instead of the word
 * "calendar" still scopes the Outlook tools. Data-driven from constraints —
 * empty for users with no pinned calendars.
 */
export function pinnedCalendarRuleLabels(): string[] {
  const labels = new Set<string>();
  try {
    for (const constraint of listConstraints()) {
      const content = constraint.content.toLowerCase();
      if (!content.includes('outlook')) continue;
      if (!content.includes('calendar')) continue;
      if (!CONNECTION_ID_IN_TEXT.test(constraint.content)) continue;
      for (const label of constraintLabelTokens(constraint.content)) labels.add(label);
    }
  } catch (err) {
    console.error('[constraint-guard] error listing pinned calendar labels:', err);
  }
  return [...labels];
}

/**
 * Find a pinned Outlook calendar read route, e.g. "For <Org> calendar
 * lookups, use Outlook connection ca_...". This intentionally does NOT apply
 * to generic calendar reads: a user may have multiple active calendars, so a
 * read only collapses to a pinned connection when the live intent names the
 * rule's distinguishing label (the non-generic word the constraint and the
 * intent share). With several pinned calendars, each intent routes to the
 * rule whose label it names.
 */
export function findOutlookCalendarReadConstraint(
  toolSlug: string,
  args: Record<string, unknown>,
  intentText = '',
): OutlookCalendarReadConstraint | null {
  try {
    if (!isOutlookCalendarReadSlug(toolSlug)) return null;
    const combinedIntent = `${intentText}\n${argsIntentText(args)}`;
    if (!combinedIntent.trim()) return null;

    for (const constraint of listConstraints()) {
      const content = constraint.content.toLowerCase();
      if (!content.includes('outlook')) continue;
      if (!content.includes('calendar')) continue;
      const match = constraint.content.match(CONNECTION_ID_IN_TEXT);
      if (!match) continue;
      const intentNamesRule = constraintLabelTokens(constraint.content)
        .some((label) => new RegExp(`\\b${escapeForRegExp(label)}\\b`, 'i').test(combinedIntent));
      if (!intentNamesRule) continue;
      return { constraint, routeConnectionId: match[0] };
    }
  } catch (err) {
    console.error('[constraint-guard] error finding outlook calendar constraint:', err);
  }
  return null;
}

/**
 * GLOBAL tool↔rule binding: a constraint is bound to a toolkit when its
 * content names that toolkit ("outlook", "salesforce", "airtable", …).
 * Bound rules ride with the tool on EVERY call — injected into the tool's
 * description, into search results at discovery time, and into each call's
 * output — so following them never depends on memory recall surfacing the
 * rule for that particular turn.
 */
export function constraintsForToolkit(toolkitSlug: string): ConsolidatedFact[] {
  const slug = toolkitSlug.trim().toLowerCase();
  if (!slug || slug === 'unknown' || slug === '*') return [];
  try {
    const wordMatch = new RegExp(`\\b${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return listConstraints().filter((c) => wordMatch.test(c.content));
  } catch (err) {
    console.error('[constraint-guard] error binding constraints to toolkit:', err);
    return [];
  }
}

/** Render the bound rules as a block to attach to tool surfaces/outputs.
 *  Null when the toolkit has no bound rules (the common case — zero cost). */
export function renderToolkitConstraintBanner(toolkitSlug: string): string | null {
  const rules = constraintsForToolkit(toolkitSlug);
  if (rules.length === 0) return null;
  return [
    '',
    `⚖️ STANDING RULES bound to the ${toolkitSlug} toolkit — they apply to EVERY call, no exceptions:`,
    ...rules.map((c) => `- ${c.content}`),
  ].join('\n');
}

/**
 * Check if a tool call violates any active constraints.
 * Returns a violation object if found, null if OK to proceed.
 *
 * `emailHandledExternally` — the composio dispatch path verifies the real
 * sending mailbox (profile lookup) via findEmailSendConstraint and must not
 * ALSO trip the pattern-only email check here.
 */
export function checkConstraintViolation(
  toolName: string,
  args: Record<string, unknown>,
  opts: { emailHandledExternally?: boolean } = {},
): ConstraintViolation | null {
  try {
    const constraints = listConstraints();
    if (constraints.length === 0) return null;

    for (const constraint of constraints) {
      const violation = checkSingleConstraint(toolName, args, constraint, opts);
      if (violation) return violation;
    }
  } catch (err) {
    // Constraint checking is advisory; don't break dispatch on errors
    console.error('[constraint-guard] error checking constraints:', err);
  }

  return null;
}

/**
 * Check a single constraint against the tool call.
 * Pattern-matches on constraint content to determine applicability.
 */
function checkSingleConstraint(
  toolName: string,
  args: Record<string, unknown>,
  constraint: ConsolidatedFact,
  opts: { emailHandledExternally?: boolean } = {},
): ConstraintViolation | null {
  const content = constraint.content.toLowerCase();

  // Email account constraint: "use [account] for Outlook"
  if (!opts.emailHandledExternally
      && content.includes('email') && content.includes('outlook') && toolName === 'composio_execute_tool') {
    const violation = checkEmailAccountConstraint(args, constraint.content);
    if (violation) {
      return { constraint, reason: violation, toolName, violatingField: 'from/account' };
    }
  }

  // Salesforce org constraint: "use [org] for Salesforce"
  if (content.includes('salesforce') && content.includes('org') && toolName === 'composio_execute_tool') {
    const violation = checkSalesforceOrgConstraint(args, constraint.content);
    if (violation) {
      return { constraint, reason: violation, toolName, violatingField: 'org' };
    }
  }

  // Production safety: "don't touch production"
  if (content.includes('production') && content.includes('sandbox')) {
    const violation = checkProductionSafetyConstraint(args, constraint.content);
    if (violation) {
      return { constraint, reason: violation, toolName, violatingField: 'target environment' };
    }
  }

  return null;
}

/**
 * Check email account constraint.
 * Pattern: "use [account] for all [Outlook/email] sends"
 * Extracts allowed account from constraint and checks args.from / args.account
 */
function checkEmailAccountConstraint(args: Record<string, unknown>, constraintContent: string): string | null {
  // Extract allowed account from constraint (e.g., "nathan.reynolds@scorpion.co")
  const emailPattern = /[\w\-\.]+@[\w\-\.]+/;
  const match = constraintContent.match(emailPattern);
  if (!match) return null;

  const allowedAccount = match[0].toLowerCase();

  // Check composio args for email send actions
  const actionStr = String(args.action || '').toLowerCase();
  if (!actionStr.includes('send') && !actionStr.includes('draft')) return null;

  // Check from/account field
  const fromField = (args.from || args.account || '').toString().toLowerCase();
  if (!fromField) {
    // If no from field is specified, assume default (may violate constraint)
    return `No email account specified. Constraint requires: ${allowedAccount}`;
  }

  if (!fromField.includes(allowedAccount)) {
    return `Email account "${fromField}" violates constraint requiring "${allowedAccount}"`;
  }

  return null;
}

/**
 * Check Salesforce org constraint.
 * Pattern: "use [org] for Salesforce" or "don't touch production"
 */
function checkSalesforceOrgConstraint(args: Record<string, unknown>, constraintContent: string): string | null {
  const actionStr = String(args.action || '').toLowerCase();
  if (!actionStr.includes('salesforce')) return null;

  // Pattern: "use [org] only" or "sandbox only"
  if (constraintContent.includes('sandbox')) {
    const org = (args.target_org || args.org || '').toString();
    if (org && !org.includes('sandbox')) {
      return `Cannot modify Salesforce org "${org}" — constraint requires sandbox only`;
    }
  }

  if (constraintContent.includes('production_disabled')) {
    const org = (args.target_org || args.org || '').toString();
    if (org && org.includes('production')) {
      return `Cannot modify production Salesforce org — constraint disables production writes`;
    }
  }

  return null;
}

/**
 * Check production safety constraint.
 * Pattern: "don't touch production" or "sandbox only"
 */
function checkProductionSafetyConstraint(args: Record<string, unknown>, constraintContent: string): string | null {
  const env = (args.environment || args.env || '').toString().toLowerCase();
  const table = (args.table || args.tableName || '').toString().toLowerCase();

  // Heuristics: check for production indicators
  if (env === 'production' || table.includes('production')) {
    if (constraintContent.includes('sandbox')) {
      return `Cannot write to production — constraint requires sandbox/staging only`;
    }
    if (constraintContent.includes("don't touch")) {
      return `Cannot modify production — constraint forbids production writes`;
    }
  }

  return null;
}

/**
 * Format a constraint violation for user escalation.
 */
export function formatConstraintEscalation(violation: ConstraintViolation): string {
  return [
    `⚠️  This action would violate a standing constraint:`,
    ``,
    `Constraint: "${violation.constraint.content}"`,
    `Issue: ${violation.reason}`,
    `Tool: ${violation.toolName} (field: ${violation.violatingField})`,
    ``,
    `Should I proceed anyway, or change your approach?`,
  ].join('\n');
}
