export type DeterministicConstraintFamily =
  | 'outlook_sender'
  | 'outlook_calendar_route'
  | 'salesforce_cli_only'
  | 'salesforce_environment'
  | 'production_environment';

export interface ConstraintEnforcementDescriptor {
  schemaVersion: 1;
  family: DeterministicConstraintFamily | 'unclassified';
  deterministic: boolean;
  tools: string[];
  reason: string;
}

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const CONNECTION_RE = /\bca_[A-Za-z0-9_-]+\b/;

/**
 * Describe only rule families that Clementine's dispatch layer can actually
 * evaluate from a tool name and its concrete arguments. A natural-language
 * instruction is not called “hard” merely because it lives in a constraint
 * row: unsupported guidance remains a standing prompt policy until a real
 * deterministic compiler exists for it.
 */
export function classifyConstraintEnforcement(content: string): ConstraintEnforcementDescriptor {
  const text = content.replace(/\s+/g, ' ').trim().toLowerCase();
  if (text.includes('outlook') && /\b(?:send|sending|mail|email)\b/.test(text) && EMAIL_RE.test(content)) {
    return {
      schemaVersion: 1,
      family: 'outlook_sender',
      deterministic: true,
      tools: ['composio_execute_tool'],
      reason: 'The dispatch gate verifies the connected Outlook mailbox before an irreversible send.',
    };
  }
  if (text.includes('outlook') && text.includes('calendar') && CONNECTION_RE.test(content)) {
    return {
      schemaVersion: 1,
      family: 'outlook_calendar_route',
      deterministic: true,
      tools: ['composio_execute_tool'],
      reason: 'The dispatch router binds a named calendar lookup to the persisted connection id.',
    };
  }
  if (text.includes('salesforce') && text.includes('composio') && /\bsf\s+cli\b/.test(text)
    && /\b(?:never|do not|don't|expired|dead)\b/.test(text)) {
    return {
      schemaVersion: 1,
      family: 'salesforce_cli_only',
      deterministic: true,
      tools: ['composio_execute_tool'],
      reason: 'Every Composio Salesforce dispatch is blocked so the required local sf CLI path is the only route.',
    };
  }
  if (text.includes('salesforce') && text.includes('org')
    && (text.includes('sandbox') || text.includes('production_disabled'))) {
    return {
      schemaVersion: 1,
      family: 'salesforce_environment',
      deterministic: true,
      tools: ['composio_execute_tool'],
      reason: 'The dispatch gate compares the requested Salesforce organization with the allowed environment.',
    };
  }
  if (text.includes('production') && text.includes('sandbox')
    && /\b(?:never|do not|don't|only|requires?)\b/.test(text)) {
    return {
      schemaVersion: 1,
      family: 'production_environment',
      deterministic: true,
      tools: ['composio_execute_tool'],
      reason: 'The dispatch gate rejects concrete production environment or table arguments.',
    };
  }
  return {
    schemaVersion: 1,
    family: 'unclassified',
    deterministic: false,
    tools: [],
    reason: 'No deterministic dispatch compiler currently covers this natural-language rule.',
  };
}

export function parseConstraintEnforcementDescriptor(value: string | null | undefined): ConstraintEnforcementDescriptor | null {
  try {
    const parsed = JSON.parse(value ?? '') as Partial<ConstraintEnforcementDescriptor>;
    if (parsed.schemaVersion !== 1 || typeof parsed.family !== 'string'
      || typeof parsed.deterministic !== 'boolean' || !Array.isArray(parsed.tools)
      || typeof parsed.reason !== 'string') return null;
    return parsed as ConstraintEnforcementDescriptor;
  } catch {
    return null;
  }
}
