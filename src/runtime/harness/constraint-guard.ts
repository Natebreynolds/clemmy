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

export interface ConstraintViolation {
  constraint: ConsolidatedFact;
  reason: string;
  toolName: string;
  violatingField: string;
}

/**
 * Check if a tool call violates any active constraints.
 * Returns a violation object if found, null if OK to proceed.
 */
export function checkConstraintViolation(
  toolName: string,
  args: Record<string, unknown>,
): ConstraintViolation | null {
  try {
    const constraints = listConstraints();
    if (constraints.length === 0) return null;

    for (const constraint of constraints) {
      const violation = checkSingleConstraint(toolName, args, constraint);
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
): ConstraintViolation | null {
  const content = constraint.content.toLowerCase();

  // Email account constraint: "use [account] for Outlook"
  if (content.includes('email') && content.includes('outlook') && toolName === 'composio_execute_tool') {
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
