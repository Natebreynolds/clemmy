/**
 * Provider-intent advertisement at the Composio edge.
 *
 * This is catalog visibility only—not execution authority. It lives outside
 * the MCP scope kernel so adding/changing a provider family never adds a
 * provider-name branch to shared runtime policy.
 */
export interface ComposioMcpScopeCandidate {
  reason: string;
  allowedServerSlugs: string[];
  toolPatterns: string[];
  priorityKeywords: string[];
  maxTools: number;
  serverMaxTools: Record<string, number>;
}

const SALESFORCE_STRONG_RE = /\b(salesforce|sf cli|soql)\b/i;
const SALESFORCE_OBJECT_RE = /\b(opportunit(?:y|ies)|account(?:s)?|lead(?:s)?|contact(?:s)?)\b/i;
const SALESFORCE_CONTEXT_RE = /\b(crm|sales pipeline|salesforce pipeline|deal(?:s)?|prospect(?:s)?)\b/i;
const OUTLOOK_RE = /\b(outlook|email|emails|inbox|meeting invite)\b/i;
const CALENDAR_OPERATION_RE =
  /\b(?:check|show|list|read|open|view|add|put|create|update|edit|delete|remove|schedule|book|move|reschedule|block|clear)\b[^.!?\n]{0,80}\b(?:my|our|team|work|personal)\s+calendar\b|\b(?:add|put|schedule|book|move|reschedule|block)\b[^.!?\n]{0,50}\b(?:to|on)\s+(?:the\s+)?calendar\b|\b(?:my|our|team|work|personal)\s+calendar\b|\bcalendar\s+(?:event|events|invite|invites|meeting|meetings|availability)\b/i;
const EMAIL_DATA_FIELD_RE =
  /\b(?:column|columns|field|fields|header|headers|property|properties|key|keys)\b[^.!?\n]{0,80}?\be-?mails?\b|\be-?mail\b\s+(?:column|field|address|value|missing|blank|data)\b/i;
const EMAIL_DATA_LIST_RE =
  /([,;|]\s*)e-?mail\b|\be-?mail\b(?=\s*(?:[,;|/]|and\b)\s*(?:company|name|contact|account|domain|phone|title|status|value|field|column|header)\b)/gi;
const EMAIL_DATA_SHAPE_RE = /\be-?mail[-\s]shaped\s+(?:string|strings|value|values|field|fields|data)\b/gi;
const QUOTED_EMAIL_FIELD_RE = /(["'])e-?mail\1(?=\s*[,\]}:])/gi;
const STRUCTURED_TABULAR_CONTEXT_RE =
  /\b(?:google\s+sheets?|googlesheets?|spreadsheet|worksheet|sheet\s+(?:range|row|rows|tab|cells?)|cell\s+data|matrix|tabular|headers?|columns?|value\s+range)\b/i;
const CALENDAR_ARTIFACT_RE =
  /\b(?:social(?:\s+media)?\s+)?(?:content|editorial|marketing|campaign|publishing|post|production|release|launch|roadmap)\s+calendar\b/gi;
const NEGATED_OUTLOOK_ACTION_RE =
  /\b(?:do\s+not|don't|dont|never|without)\s+(?:(?:send|sending|draft|drafting|read|reading|search|searching|check|checking|use|using|open|opening|call|calling|contact|contacting|access|accessing|query|querying|invoke|invoking|create|creating|schedule|scheduling)\s+)?(?:any\s+)?(?:outlook|e-?mail(?:s|ing|ed)?|inbox|calendar|meeting\s+invites?)(?:\s+(?:or|and)\s+(?:(?:send|sending|draft|drafting|read|reading|search|searching|check|checking|use|using|open|opening|call|calling|contact|contacting|access|accessing|query|querying|invoke|invoking|create|creating|schedule|scheduling)\s+)?(?:any\s+)?(?:outlook|e-?mail(?:s|ing|ed)?|inbox|calendar|meeting\s+invites?))?/gi;
const NO_OUTLOOK_ACTION_RE = /\bno\s+(?:outlook|e-?mail|mail|calendar)\s+(?:action|actions|tool|tools|call|calls|send|sends|draft|drafts|access)\b/gi;

function withoutStructuredEmailMentions(input: string): string {
  const projected = STRUCTURED_TABULAR_CONTEXT_RE.test(input)
    ? input.replace(QUOTED_EMAIL_FIELD_RE, '"structured_field"')
    : input;
  return projected
    .replace(new RegExp(EMAIL_DATA_FIELD_RE.source, 'gi'), ' structured_field ')
    .replace(EMAIL_DATA_LIST_RE, '$1structured_field')
    .replace(EMAIL_DATA_SHAPE_RE, ' structured_data ');
}

function withoutNegatedOutlookMentions(input: string): string {
  return withoutStructuredEmailMentions(input)
    .replace(CALENDAR_ARTIFACT_RE, ' planning_artifact ')
    .replace(NEGATED_OUTLOOK_ACTION_RE, ' prohibited_outlook_action ')
    .replace(NO_OUTLOOK_ACTION_RE, ' prohibited_outlook_action ');
}

export function resolveComposioMcpScopeCandidates(input: string): ComposioMcpScopeCandidate[] {
  const candidates: ComposioMcpScopeCandidate[] = [];
  const wantsSalesforce = SALESFORCE_STRONG_RE.test(input)
    || (SALESFORCE_OBJECT_RE.test(input) && SALESFORCE_CONTEXT_RE.test(input));
  const outlookInput = withoutNegatedOutlookMentions(input);
  const wantsOutlook = OUTLOOK_RE.test(outlookInput) || CALENDAR_OPERATION_RE.test(outlookInput);

  if (wantsSalesforce) {
    candidates.push({
      reason: 'salesforce intent',
      allowedServerSlugs: ['salesforce'],
      toolPatterns: ['salesforce', 'soql', 'account', 'lead', 'contact', 'opportunit'],
      priorityKeywords: ['query', 'search', 'list', 'get', 'create', 'update'],
      maxTools: 8,
      serverMaxTools: { salesforce: 8 },
    });
  }
  if (wantsOutlook) {
    candidates.push({
      reason: 'outlook/email intent',
      allowedServerSlugs: ['outlook', 'microsoft_outlook', 'microsoft'],
      toolPatterns: ['outlook', 'email', 'mail', 'draft', 'message', 'calendar', 'event'],
      priorityKeywords: ['draft', 'send', 'list', 'search', 'create', 'calendar'],
      maxTools: 8,
      serverMaxTools: { outlook: 8, microsoft_outlook: 8, microsoft: 8 },
    });
  }
  return candidates;
}
