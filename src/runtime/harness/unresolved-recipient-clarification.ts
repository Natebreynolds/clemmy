/**
 * Provider-neutral stop condition for a directed external action whose exact
 * operation/account path is known but whose recipient identity is not.
 *
 * This module is deliberately pure. It cannot mint capability authority,
 * publish a question, or execute a lookup/write. The caller must supply one
 * host-attested, same-source read observation and an exact current action path.
 * A later orchestration seam may turn the returned text into the ordinary
 * `ask_user_question` candidate.
 */
import { classifyExternalEffectRequest } from '../../assistant/external-effect-taxonomy.js';

const EMAIL_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const HANDLE_RE = /(?:^|\s)[@#][a-z0-9][a-z0-9._-]{1,63}\b/i;
const PHONE_RE = /(?:^|\s)\+?\d(?:[\s().-]*\d){7,14}\b/;
const EXPLICIT_ID_RE = /\b(?:contact|recipient|user|member|attendee|invitee)[ _-]?id\b\s*[:=#]?\s*[a-z0-9][a-z0-9._:-]{2,}\b/i;
const IDENTIFIER_SOURCE = [
  String.raw`[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}`,
  String.raw`[@#][a-z0-9][a-z0-9._-]{1,63}`,
  String.raw`\+?\d(?:[\s().-]*\d){7,14}`,
  String.raw`(?:contact|recipient|user|member|attendee|invitee)[ _-]?id\b\s*[:=#]?\s*[a-z0-9][a-z0-9._:-]{2,}`,
].join('|');
const METADATA_LOOKUP_RE = /^(?:tool_search|mcp_search|schema_search|list_tools|recall_tool_result)$/i;
const EXACT_OPERATION_RE = /^[A-Za-z][A-Za-z0-9_.:-]{2,255}$/;
const EXACT_CAPABILITY_REF_RE = /^cap:[A-Za-z0-9][A-Za-z0-9_.:@/-]{2,511}$/;
const PERSON_TOKEN_RE = /^[A-Z][A-Za-z'\u2019-]{1,48}$/;
const TARGET_STOP_WORDS = new Set([
  'About', 'After', 'At', 'Before', 'For', 'From', 'On', 'Please', 'Tell',
  'Department', 'Everyone', 'Group', 'Mailbox', 'Project', 'Team',
  'That', 'The', 'Today', 'Tomorrow', 'Using', 'With',
]);

export type ExactRecipientActionPath =
  | {
      kind: 'capability_ref';
      sourceUserSeq: number;
      capabilityRef: string;
      /**
       * Must be copied from the same-source capability_discovered/staged
       * connection record. A public tool_search card is not account authority.
       */
      accountIdentity: string;
      accountIdentityProvenance: 'same_source_capability_discovered';
    }
  | {
      kind: 'capability_refs';
      sourceUserSeq: number;
      /** Closed, unique same-source result-batch set; never rank-selected. */
      capabilityRefs: readonly string[];
      accountIdentity: string;
      accountIdentityProvenance: 'same_source_capability_discovered';
    }
  | {
      kind: 'selected_account_blocker';
      sourceUserSeq: number;
      operationName: string;
      accountChoices: readonly string[];
      selectedAccountIdentity: string;
    }
  | {
      kind: 'selected_account_blockers';
      sourceUserSeq: number;
      /** Closed, unique same-batch operation set; never rank-selected. */
      operationNames: readonly string[];
      accountChoices: readonly string[];
      selectedAccountIdentity: string;
    };

export interface RecipientTurnObservation {
  sourceUserSeq: number;
  toolName: string;
  /** Exact invocation/query bytes used to aim the read at the named target. */
  queryText: string;
  result: unknown;
  settled: boolean;
  effect: string;
  evidenceRole: string | null;
}

export interface UnresolvedRecipientClarificationInput {
  sourceUserSeq: number;
  acceptedText: string;
  currentPath: ExactRecipientActionPath | null;
  /** All observed tool results for this accepted source so far. */
  observations: readonly RecipientTurnObservation[];
  /**
   * True once the exact source has entered an approval or effect path, even if
   * that path has not produced a host result observation yet.
   */
  effectOrApprovalPathEntered: boolean;
}

export interface UnresolvedRecipientClarification {
  targetLabel: string;
  question: string;
}

function normalizedIdentity(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function exactCurrentPath(
  sourceUserSeq: number,
  path: ExactRecipientActionPath | null,
): boolean {
  if (!path || path.sourceUserSeq !== sourceUserSeq) return false;
  if (path.kind === 'capability_ref') {
    return EXACT_CAPABILITY_REF_RE.test(path.capabilityRef.trim())
      && normalizedIdentity(path.accountIdentity).length > 0
      && path.accountIdentityProvenance === 'same_source_capability_discovered';
  }
  if (path.kind === 'capability_refs') {
    const refs = path.capabilityRefs.map((ref) => ref.trim());
    return refs.length > 0
      && new Set(refs).size === refs.length
      && refs.every((ref) => EXACT_CAPABILITY_REF_RE.test(ref))
      && normalizedIdentity(path.accountIdentity).length > 0
      && path.accountIdentityProvenance === 'same_source_capability_discovered';
  }
  const operations = path.kind === 'selected_account_blocker'
    ? [path.operationName.trim()]
    : path.operationNames.map((operation) => operation.trim());
  if (
    operations.length === 0
    || new Set(operations).size !== operations.length
    || operations.some((operation) => !EXACT_OPERATION_RE.test(operation))
  ) return false;
  const selected = normalizedIdentity(path.selectedAccountIdentity);
  const choices = [...new Set(path.accountChoices.map(normalizedIdentity).filter(Boolean))];
  return choices.length >= 2
    && selected.length > 0
    && choices.filter((choice) => choice === selected).length === 1;
}

function exactIdentifierIn(value: string): boolean {
  return EMAIL_RE.test(value)
    || HANDLE_RE.test(value)
    || PHONE_RE.test(value)
    || EXPLICIT_ID_RE.test(value);
}

function cleanTargetTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (!PERSON_TOKEN_RE.test(token) || TARGET_STOP_WORDS.has(token)) break;
    out.push(token);
    if (out.length >= 4) break;
  }
  return out.length >= 2 ? out : [];
}

/**
 * Extract only a conservative human-name target from direct recipient grammar.
 * Lowercase/ambiguous/common-noun targets intentionally abstain.
 */
export function directedRecipientLabelFromAcceptedSource(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const patterns = [
    /\b(?:calendar\s+)?invite\s+for\s+([A-Z][A-Za-z'\u2019-]*(?:\s+[A-Z][A-Za-z'\u2019-]*){1,5})/g,
    /\b(?:invite|email|message|notify)\s+([A-Z][A-Za-z'\u2019-]*(?:\s+[A-Z][A-Za-z'\u2019-]*){1,5})/g,
    /\b(?:send|forward)\s+([A-Z][A-Za-z'\u2019-]*(?:\s+[A-Z][A-Za-z'\u2019-]*){1,5})\s+(?:an?|the|this|that)\b/g,
    /\bto\s+([A-Z][A-Za-z'\u2019-]*(?:\s+[A-Z][A-Za-z'\u2019-]*){1,5})/g,
    new RegExp(String.raw`\bto\s+<?[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}>?\s+for\s+([A-Z][A-Za-z'\u2019-]*(?:\s+[A-Z][A-Za-z'\u2019-]*){1,5})`, 'g'),
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const tokens = cleanTargetTokens((match[1] ?? '').split(/\s+/));
      if (tokens.length >= 2) return tokens.join(' ');
    }
  }
  return null;
}

function normalizedNameTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
}

function containsAllNameTokens(value: string, targetTokens: readonly string[]): boolean {
  const words = new Set(normalizedNameTokens(value));
  return targetTokens.every((token) => words.has(token));
}

function identityBindingBridge(value: string, identifierAfterTarget: boolean): boolean {
  if (value.length > 64 || /[.!?;\n]/.test(value)) return false;
  if (
    identifierAfterTarget
    && /\b(?:using|from|via|sender|account|mailbox|my|work|personal)\b/i.test(value)
  ) return false;
  const residue = value
    .replace(/['\u2019]s\b/gi, '')
    .replace(/\b(?:e-?mail|address|recipient|contact|attendee|invitee|id|is|at)\b/gi, '')
    .replace(/[\s,:()<>\[\]{}=\-/\u2013\u2014]/g, '');
  return residue.length === 0;
}

function exactTargetSpan(value: string, targetLabel: string): { start: number; end: number } | null {
  const escapedTarget = targetLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`\\b${escapedTarget}\\b`, 'i').exec(value);
  if (exact?.index !== undefined) {
    return { start: exact.index, end: exact.index + exact[0].length };
  }
  const tokens = normalizedNameTokens(targetLabel);
  if (tokens.length < 2) return null;
  const tokenPattern = tokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(String.raw`\b\s+(?:[A-Za-z]\.\s+){0,2}\b`);
  const match = new RegExp(`\\b${tokenPattern}\\b`, 'i').exec(value);
  return match?.index === undefined
    ? null
    : { start: match.index, end: match.index + match[0].length };
}

function exactIdentifierSpans(value: string): Array<{ start: number; end: number }> {
  return [...value.matchAll(new RegExp(IDENTIFIER_SOURCE, 'gi'))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function textBindsExactTargetIdentity(value: string, targetLabel: string): boolean {
  const target = exactTargetSpan(value, targetLabel);
  if (!target) return false;
  return exactIdentifierSpans(value).some((identifier) => {
    if (identifier.start >= target.end) {
      return identityBindingBridge(value.slice(target.end, identifier.start), true);
    }
    if (identifier.end <= target.start) {
      const bridge = value.slice(identifier.end, target.start);
      if (identityBindingBridge(bridge, false)) return true;
      const prefix = value.slice(Math.max(0, identifier.start - 8), identifier.start);
      return /^\s*>?\s*for\s+$/i.test(bridge) && /\bto\s*<?\s*$/i.test(prefix);
    }
    return false;
  });
}

function acceptedSourceCarriesExactTargetIdentity(text: string, targetLabel: string): boolean {
  return textBindsExactTargetIdentity(text, targetLabel);
}

function structuredRecordBindsTargetIdentity(
  value: unknown,
  targetTokens: readonly string[],
  depth = 0,
): boolean {
  if (!value || typeof value !== 'object' || depth > 6) return false;
  if (Array.isArray(value)) {
    return value.slice(0, 100).some((entry) => (
      structuredRecordBindsTargetIdentity(entry, targetTokens, depth + 1)
    ));
  }
  const record = value as Record<string, unknown>;
  const nameValues: string[] = [];
  const identifierValues: string[] = [];
  for (const [key, entry] of Object.entries(record).slice(0, 100)) {
    if (typeof entry !== 'string') continue;
    if (/^(?:display_?name|full_?name|name|recipient_?name|attendee_?name|contact_?name)$/i.test(key)) {
      nameValues.push(entry);
    }
    if (/^(?:address|email|email_?address|mail|recipient|recipient_?id|attendee|attendee_?id|contact_?id|user_?id|handle|phone|phone_?number)$/i.test(key)) {
      identifierValues.push(entry);
    }
  }
  if (
    nameValues.some((name) => containsAllNameTokens(name, targetTokens))
    && identifierValues.some((identifier) => exactIdentifierIn(identifier))
  ) return true;
  return Object.values(record).slice(0, 100).some((entry) => (
    structuredRecordBindsTargetIdentity(entry, targetTokens, depth + 1)
  ));
}

function resultBindsTargetIdentity(result: unknown, targetLabel: string): boolean {
  const targetTokens = normalizedNameTokens(targetLabel);
  if (targetTokens.length < 2) return false;
  let structured = result;
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { structured = JSON.parse(trimmed) as unknown; } catch { structured = null; }
    } else {
      structured = null;
    }
  }
  if (structured && structuredRecordBindsTargetIdentity(structured, targetTokens)) return true;

  const text = typeof result === 'string'
    ? result.slice(0, 100_000)
    : (() => {
        try { return JSON.stringify(result).slice(0, 100_000); } catch { return ''; }
      })();
  if (!text) return false;
  for (const line of text.split(/\r?\n/).slice(0, 1_000)) {
    if (!containsAllNameTokens(line, targetTokens)) continue;
    if (textBindsExactTargetIdentity(line, targetLabel)) return true;
  }
  return false;
}

function exactOneGroundedLookup(
  input: UnresolvedRecipientClarificationInput,
  targetLabel: string,
): RecipientTurnObservation | null {
  const targetTokens = normalizedNameTokens(targetLabel);
  const eligible = input.observations.filter((lookup) => (
    lookup.sourceUserSeq === input.sourceUserSeq
    && lookup.settled
    && lookup.effect === 'read'
    && lookup.evidenceRole === 'source_read'
    && !METADATA_LOOKUP_RE.test(lookup.toolName.trim())
    && containsAllNameTokens(lookup.queryText, targetTokens)
  ));
  return eligible.length === 1 ? eligible[0]! : null;
}

function effectOrApprovalPathObserved(input: UnresolvedRecipientClarificationInput): boolean {
  if (input.effectOrApprovalPathEntered) return true;
  return input.observations.some((observation) => (
    observation.sourceUserSeq === input.sourceUserSeq
    && observation.settled
    && (
      observation.evidenceRole === 'committed_effect'
      || /^(?:write|local_write|external_write|admin)$/i.test(observation.effect.trim())
    )
  ));
}

/**
 * Return one clarification only after one grounded target lookup has settled
 * without binding an exact recipient identity. Every uncertain classification
 * abstains; write/provenance authority remains elsewhere and unchanged.
 */
export function unresolvedRecipientClarification(
  input: UnresolvedRecipientClarificationInput,
): UnresolvedRecipientClarification | null {
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) return null;
  const effect = classifyExternalEffectRequest(input.acceptedText);
  if (
    !effect.requested
    || !effect.kinds.some((kind) => (
      kind === 'communication' || kind === 'meeting_change' || kind === 'calendar_change'
    ))
  ) return null;
  if (!exactCurrentPath(input.sourceUserSeq, input.currentPath)) return null;
  if (effectOrApprovalPathObserved(input)) return null;
  const targetLabel = directedRecipientLabelFromAcceptedSource(input.acceptedText);
  if (!targetLabel) return null;
  if (acceptedSourceCarriesExactTargetIdentity(input.acceptedText, targetLabel)) return null;
  const lookup = exactOneGroundedLookup(input, targetLabel);
  if (!lookup || resultBindsTargetIdentity(lookup.result, targetLabel)) return null;
  return {
    targetLabel,
    question: `I couldn't ground an exact recipient address for ${targetLabel}. What exact email address or recipient ID should I use?`,
  };
}
