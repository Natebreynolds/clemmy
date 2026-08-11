import { authoritativePresentationLineMask } from './presentation-authority.js';

/** A provider row as observed in a trusted read snapshot. */
export interface ReadHistoryRow {
  id: string;
  title: string;
  status: string;
}

/**
 * The small, provider-independent snapshot needed to ground narrative history.
 * `sourceKey` is an internal stable source identity, not presentation text.
 */
export interface ReadHistorySnapshot {
  sourceKey: string;
  /** Digest of the complete canonical provider snapshot, including fields
   * outside the typed transition core. Generic changed/unchanged claims must
   * never be decided from a lossy id/title/status projection. */
  contentDigest: string;
  revision: number | null;
  count: number;
  rows: ReadHistoryRow[];
}

export type ReadHistoryClaim =
  | { kind: 'same_source'; lineIndex: number; text: string }
  | { kind: 'same_revision'; lineIndex: number; text: string }
  | { kind: 'unchanged'; lineIndex: number; text: string }
  | { kind: 'changed'; lineIndex: number; text: string }
  | { kind: 'count_still'; count: number; lineIndex: number; text: string }
  | { kind: 'status_still'; status: string; rowId: string | null; lineIndex: number; text: string }
  | { kind: 'status_transition'; from: string; to: string; rowId: string | null; lineIndex: number; text: string }
  | { kind: 'status_target'; to: string; rowId: string | null; lineIndex: number; text: string }
  | { kind: 'revision_transition'; from: number; to: number; lineIndex: number; text: string }
  | {
      kind: 'revision_target';
      to: number;
      /** `true` for wording such as "bumped to 2"; no origin is inferred. */
      requiresChange: boolean;
      lineIndex: number;
      text: string;
    };

export interface UnparsedReadHistorySegment {
  lineIndex: number;
  text: string;
}

export interface ReadHistoryClaimParse {
  claims: ReadHistoryClaim[];
  unparsedTemporalSegments: UnparsedReadHistorySegment[];
}

export type ReadHistoryDecision = 'certified' | 'needs_semantic_judge' | 'contradicted';

export type ReadHistoryReasonCode =
  | 'no_temporal_claims'
  | 'all_claims_match'
  | 'unknown_temporal_wording'
  | 'prior_snapshot_required'
  | 'source_key_mismatch'
  | 'snapshot_changed'
  | 'snapshot_unchanged'
  | 'count_mismatch'
  | 'count_not_still'
  | 'status_mismatch'
  | 'status_not_still'
  | 'stable_row_required'
  | 'revision_unavailable'
  | 'revision_mismatch'
  | 'revision_not_still'
  | 'revision_not_changed'
  | 'revision_transition_mismatch'
  | 'status_transition_mismatch';

export interface ReadHistoryValidationResult extends ReadHistoryClaimParse {
  decision: ReadHistoryDecision;
  reasonCodes: ReadHistoryReasonCode[];
}

export interface ValidateReadHistoryClaimsInput {
  /** Provider-facing text. It is inspected only and is never normalized in place. */
  text: string;
  current: ReadHistorySnapshot;
  prior?: ReadHistorySnapshot | null;
}

type ClaimWithoutLocation =
  | { kind: 'same_source' }
  | { kind: 'same_revision' }
  | { kind: 'unchanged' }
  | { kind: 'changed' }
  | { kind: 'count_still'; count: number }
  | { kind: 'status_still'; status: string; rowId: string | null }
  | { kind: 'status_transition'; from: string; to: string; rowId: string | null }
  | { kind: 'status_target'; to: string; rowId: string | null }
  | { kind: 'revision_transition'; from: number; to: number }
  | { kind: 'revision_target'; to: number; requiresChange: boolean };

function plainPresentationLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/(?:\*\*|__|`)/g, '')
    .replace(/\s{2,}$/g, '')
    .trim();
}

function markdownTableCells(line: string): string[] | null {
  if (!/^\s*\|.*\|\s*$/.test(line)) return null;
  return line.trim().slice(1, -1).split('|').map((cell) => plainPresentationLine(cell));
}

function markdownTableDivider(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function countToken(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (/^one$/i.test(value)) return 1;
  if (/^zero$/i.test(value)) return 0;
  return null;
}

function addClaims(
  target: ReadHistoryClaim[],
  lineIndex: number,
  text: string,
  claims: readonly ClaimWithoutLocation[],
): void {
  for (const claim of claims) target.push({ ...claim, lineIndex, text } as ReadHistoryClaim);
}

function claimNumbersAreSafe(claims: readonly ClaimWithoutLocation[]): boolean {
  return claims.every((claim) => {
    if (claim.kind === 'count_still') return Number.isSafeInteger(claim.count) && claim.count >= 0;
    if (claim.kind === 'revision_target') return Number.isSafeInteger(claim.to) && claim.to >= 0;
    if (claim.kind === 'revision_transition') {
      return Number.isSafeInteger(claim.from)
        && claim.from >= 0
        && Number.isSafeInteger(claim.to)
        && claim.to >= 0;
    }
    return true;
  });
}

function fieldHistoryClaims(
  value: string,
  field: 'revision' | 'status',
  rowId: string | null,
): ClaimWithoutLocation[] | null {
  if (field === 'revision') {
    const transition = /^(\d+)\s*\(\s*(?:was|from|previously|up\s+from)\s+(\d+)\s*\)[.!]?$/i.exec(value);
    if (!transition) return null;
    return [{
      kind: 'revision_transition',
      from: Number(transition[2]),
      to: Number(transition[1]),
    }];
  }

  const transition = /^([A-Za-z0-9_-]+)\s*\(\s*(?:was|from|previously)\s+([A-Za-z0-9_-]+)\s*\)[.!]?$/i.exec(value);
  if (!transition) return null;
  return [{
    kind: 'status_transition',
    from: transition[2]!,
    to: transition[1]!,
    rowId,
  }];
}

function historicalCue(text: string): boolean {
  // Bare `was` is ordinary passive voice ("no account was selected"), not a
  // history claim. Supported `(was VALUE)` field annotations are recognized
  // by the concrete parsers; unknown history still carries an explicit cue.
  return /\bsame\s+(?:connected\s+)?source\b|\bstill\b|\bremains?\b|\bunchanged\b|\bno\s+changes?\b|\bchanges?\s+since\b|\b(?:formerly|previously|earlier|prior)\b|\bused\s+to\b|\bup\s+from\b|\bsince\s+(?:the\s+)?(?:last|previous)\b|\b(?:changed|updated|advanced|flipped|moved|bumped)\s+(?:since|from|to)\b|\b(?:provider\s+state|state|queue|feed|list|snapshot|revision|status)\s+(?:has\s+|is\s+)?(?:changed|updated|advanced|moved)\b|\(\s*(?:was|from|previously|up\s+from)\s+[^)]+\)|(?:→|->)/i.test(text);
}

function parseKnownNarrativeLine(plain: string): ClaimWithoutLocation[] | null {
  const sameSource = '(?:the\\s+)?same(?:\\s+connected)?\\s+source';
  if (/^fresh\s+data\s+from\s+the\s+same(?:\s+connected)?\s+source\s*:\s*$/i.test(plain)) {
    return [{ kind: 'same_source' }];
  }
  if (new RegExp(`^(?:fresh\\s+read(?:\\s+complete)?|(?:[A-Za-z0-9 _-]{1,80}(?:queue|feed|list|snapshot))\\s+(?:is\\s+)?(?:refreshed|updated)|(?:refreshed|updated)\\s+(?:the\\s+)?[A-Za-z0-9 _-]{1,80}(?:queue|feed|list|snapshot))\\s+from\\s+${sameSource}\\s*:\\s*$`, 'i').test(plain)) {
    return [{ kind: 'same_source' }];
  }
  if (new RegExp(`^pulled\\s+fresh\\s+from\\s+${sameSource}\\s+via\\s+the\\s+proven\\s+capability[.]\\s+(?:one|\\d+)\\s+(?:[A-Za-z0-9_-]+\\s+)?(?:items?|records?|rows?|tasks?)(?:\\s+in\\s+(?:the\\s+)?(?:queue|feed|list|snapshot))?[.]?$`, 'i').test(plain)) {
    return [{ kind: 'same_source' }];
  }

  let match = /^(?:the\s+)?(?:item|record|row|task)\s+remains\s+([A-Za-z0-9_-]+)[.!]?$/i.exec(plain)
    ?? /^(?:status|state)\s+remains\s+([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
  if (match) return [{ kind: 'status_still', status: match[1]!, rowId: null }];

  match = /^revision\s+remains\s+(\d+)[.!]?$/i.exec(plain);
  if (match) {
    return [
      { kind: 'same_revision' },
      { kind: 'revision_target', to: Number(match[1]), requiresChange: false },
    ];
  }

  if (/^no\s+changes?\s+since\s+(?:the\s+)?last\s+(?:check|read|pull)[.!]?$/i.test(plain)
    || /^unchanged\s+(?:from\s+before|since\s+(?:the\s+)?(?:last|previous)\s+(?:read|check|pull))[.!]?$/i.test(plain)
    || /^(?:queue|feed|list|snapshot)\s+refreshed\s*[—–-]\s*unchanged\s+from\s+(?:the\s+)?last\s+pull\s*:$/i.test(plain)
    || /^refreshed\s*[—–-]\s*(?:the\s+)?(?:queue|feed|list|snapshot)\s+is\s+unchanged\s*:$/i.test(plain)) {
    return [{ kind: 'unchanged' }];
  }

  match = /^fresh\s+read\s*[—–-]\s*(?:the\s+)?(?:queue|feed|list|snapshot)\s+state\s+has\s+changed\s*\(\s*revision\s+(?:bumped|advanced|changed|moved)\s+(?:from\s+)?(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+)\s*\)\s*:$/i.exec(plain);
  if (match) {
    return [
      { kind: 'revision_transition', from: Number(match[1]), to: Number(match[2]) },
      { kind: 'changed' },
    ];
  }

  match = /^unchanged\s+from\s+(?:the\s+)?(?:last|previous)\s+(?:pull|read|check)\s*[—–-]\s*still\s+(one|zero|\d+)\s+(items?|records?|rows?|tasks?)(?:\s+total)?,\s*revision\s+(\d+)[.!]?$/i.exec(plain);
  if (match) {
    const count = countToken(match[1]!);
    if (count === null) return null;
    return [
      { kind: 'unchanged' },
      { kind: 'count_still', count },
      { kind: 'revision_target', to: Number(match[3]), requiresChange: false },
    ];
  }

  match = /^still\s+(one|zero|\d+)\s+([A-Za-z0-9_-]+)\s+(items?|records?|rows?|tasks?),\s+at\s+revision\s+(\d+)[.!]?$/i.exec(plain);
  if (match) {
    const count = countToken(match[1]!);
    if (count === null) return null;
    return [
      { kind: 'count_still', count },
      { kind: 'status_still', status: match[2]!, rowId: null },
      { kind: 'revision_target', to: Number(match[4]), requiresChange: false },
    ];
  }

  match = /^still\s+(one|zero|\d+)\s+(items?|records?|rows?|tasks?)(?:\s+total)?(?:,\s+all\s+([A-Za-z0-9_-]+))?[.!]?$/i.exec(plain);
  if (match) {
    const count = countToken(match[1]!);
    if (count === null) return null;
    return [
      { kind: 'count_still', count },
      ...(match[3] ? [{ kind: 'status_still', status: match[3], rowId: null } as const] : []),
    ];
  }

  match = /^still\s+(one|zero|\d+)\s+(items?|records?|rows?|tasks?),\s+unchanged\s+since\s+(?:the\s+)?(?:last|previous)\s+read\s*[—–-]\s*same\s+source\s+and\s+revision(?:\s+via\s+the\s+[A-Za-z0-9 _-]{1,80}\s+provider)?[.!]?$/i.exec(plain);
  if (match) {
    const count = countToken(match[1]!);
    if (count === null) return null;
    return [
      { kind: 'count_still', count },
      { kind: 'unchanged' },
      { kind: 'same_source' },
      { kind: 'same_revision' },
    ];
  }

  const token = '([A-Za-z0-9_-]+)';
  const arrow = '(?:→|->|to)';
  match = new RegExp(
    `^(?:the\\s+)?(?:single\\s+|only\\s+)?(?:item|record|row|task)\\s+(?:moved|changed|flipped)\\s+from\\s+${token}\\s*${arrow}\\s*${token},\\s*and\\s+the\\s+revision\\s+(?:bumped|advanced|changed|moved)\\s+(?:from\\s+)?(\\d+)\\s*${arrow}\\s*(?:revision\\s+)?(\\d+)[.!]?$`,
    'i',
  ).exec(plain);
  if (match) {
    return [
      { kind: 'status_transition', from: match[1]!, to: match[2]!, rowId: null },
      { kind: 'revision_transition', from: Number(match[3]), to: Number(match[4]) },
      { kind: 'changed' },
    ];
  }

  match = /^the\s+(?:queue|feed|list|snapshot)\s+(?:advanced|changed|moved)\s+from\s+revision\s+(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+),\s+and\s+the\s+(?:status|state)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
  if (match) {
    return [
      { kind: 'revision_transition', from: Number(match[1]), to: Number(match[2]) },
      { kind: 'status_transition', from: match[3]!, to: match[4]!, rowId: null },
      { kind: 'changed' },
    ];
  }

  match = new RegExp(
    `^still\\s+(one|zero|\\d+)\\s+(?:items?|records?|rows?|tasks?),\\s+but\\s+its\\s+(?:current\\s+)?(?:status|state)\\s+(?:moved|changed|flipped)\\s+from\\s+${token}\\s*${arrow}\\s*${token}\\s+and\\s+the\\s+revision\\s+(?:advanced|changed|moved|bumped)\\s+(?:from\\s+)?(?:revision\\s+)?(\\d+)\\s*${arrow}\\s*(?:revision\\s+)?(\\d+)\\s*[—–-]\\s*the\\s+provider\\s+state\\s+changed\\s+since\\s+(?:the\\s+)?(?:last|previous)\\s+read[.!]?$`,
    'i',
  ).exec(plain);
  if (match) {
    const count = countToken(match[1]!);
    if (count === null) return null;
    return [
      { kind: 'count_still', count },
      { kind: 'status_transition', from: match[2]!, to: match[3]!, rowId: null },
      { kind: 'revision_transition', from: Number(match[4]), to: Number(match[5]) },
      { kind: 'changed' },
    ];
  }

  match = new RegExp(
    `^the\\s+(?:queue|feed|list|snapshot)\\s+(?:advanced|changed|moved)\\s+from\\s+revision\\s+(\\d+)\\s*${arrow}\\s*(?:revision\\s+)?(\\d+),\\s+and\\s+the\\s+(?:(?:single|only|one)\\s+)?(?:item|record|row|task)(?:[’']s\\s+(?:status|state))?\\s+(?:moved|changed|flipped)\\s+from\\s+${token}\\s*${arrow}\\s*${token}[.!]?$`,
    'i',
  ).exec(plain);
  if (match) {
    return [
      { kind: 'revision_transition', from: Number(match[1]), to: Number(match[2]) },
      { kind: 'status_transition', from: match[3]!, to: match[4]!, rowId: null },
      { kind: 'changed' },
    ];
  }

  match = new RegExp(
    `^(?:the\\s+)?(?:single\\s+|only\\s+)?(?:item|record|row|task)\\s+(?:moved|changed|flipped)\\s+from\\s+${token}\\s*${arrow}\\s*${token}(?:\\s+since\\s+(?:the\\s+)?(?:last|previous)\\s+read)?\\s*\\(\\s*revision\\s+(?:bumped|advanced|changed|moved)\\s+(?:from\\s+)?(\\d+)\\s*${arrow}\\s*(\\d+)\\s*\\)[.!]?$`,
    'i',
  ).exec(plain);
  if (match) {
    return [
      { kind: 'status_transition', from: match[1]!, to: match[2]!, rowId: null },
      { kind: 'revision_transition', from: Number(match[3]), to: Number(match[4]) },
      { kind: 'changed' },
    ];
  }

  match = new RegExp(
    `^(?:the\\s+)?(?:status|state)\\s+(?:moved|changed|flipped)\\s+from\\s+${token}\\s*${arrow}\\s*${token},\\s+and\\s+the\\s+revision\\s+(?:bumped|advanced|changed|moved)\\s+(?:from\\s+)?(\\d+)\\s*${arrow}\\s*(\\d+)[.!]?$`,
    'i',
  ).exec(plain);
  if (match) {
    return [
      { kind: 'status_transition', from: match[1]!, to: match[2]!, rowId: null },
      { kind: 'revision_transition', from: Number(match[3]), to: Number(match[4]) },
      { kind: 'changed' },
    ];
  }

  match = new RegExp(
    `^it(?:'|’)s\\s+advanced\\s+since\\s+last\\s+check\\s*[—–-]\\s*(?:status|state)\\s+(?:moved|changed|flipped)\\s+from\\s+${token}\\s*${arrow}\\s*${token},\\s+and\\s+the\\s+revision\\s+(?:bumped|advanced|changed|moved)\\s+to\\s+(\\d+)[.!]?$`,
    'i',
  ).exec(plain);
  if (match) {
    return [
      { kind: 'status_transition', from: match[1]!, to: match[2]!, rowId: null },
      { kind: 'revision_target', to: Number(match[3]), requiresChange: true },
      { kind: 'changed' },
    ];
  }

  match = new RegExp(
    `^the\\s+state\\s+changed\\s+since\\s+(?:the\\s+)?(?:last|previous)\\s+read\\s*:\\s*the\\s+(?:item|record|row|task)\\s+(?:moved|changed|flipped)\\s+from\\s+${token}\\s*${arrow}\\s*${token}\\s*\\(\\s*revision\\s+(\\d+)\\s*${arrow}\\s*(?:revision\\s+)?(\\d+)\\s*\\)[.!]?$`,
    'i',
  ).exec(plain);
  if (match) {
    return [
      { kind: 'status_transition', from: match[1]!, to: match[2]!, rowId: null },
      { kind: 'revision_transition', from: Number(match[3]), to: Number(match[4]) },
      { kind: 'changed' },
    ];
  }

  match = new RegExp(
    `^(?:the\\s+)?(?:only\\s+)?(?:item|record|row|task)\\s+(?:moved|changed|flipped)\\s+from\\s+${token}\\s*${arrow}\\s*${token}(?:\\s+since\\s+(?:the\\s+)?(?:last|previous)\\s+read)?[.!]?$`,
    'i',
  ).exec(plain);
  if (match) {
    return [
      { kind: 'status_transition', from: match[1]!, to: match[2]!, rowId: null },
      { kind: 'changed' },
    ];
  }

  match = /^state\s+changed\s+since\s+(?:the\s+)?(?:last|previous)\s+read\s*[—–-]\s*the\s+(?:item|record|row|task)\s+is\s+now\s+([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
  if (match) {
    return [
      { kind: 'status_target', to: match[1]!, rowId: null },
      { kind: 'changed' },
    ];
  }

  match = /^fresh\s+read\s*[—–-]\s*the\s+(?:queue|feed|list|snapshot)\s+(?:advanced|changed|moved)\s+to\s+revision\s+(\d+)\s*:$/i.exec(plain);
  if (match) {
    return [
      { kind: 'revision_target', to: Number(match[1]), requiresChange: true },
      { kind: 'changed' },
    ];
  }

  if (/^(?:refreshed\s+[A-Za-z0-9 _-]{1,80}(?:queue|feed|list|snapshot)\s*[—–-]\s*it\s+changed\s+since\s+last\s+check|(?:queue|feed|list|snapshot)\s+refreshed\s*[—–-]\s*there(?:'|’)s\s+been\s+a\s+change\s+since\s+(?:the\s+)?last\s+pull|(?:provider\s+)?state\s+has\s+(?:advanced|changed)\s*[—–-]\s*here(?:'|’)s\s+the\s+(?:current|fresh|latest|refreshed)\s+(?:queue|result|snapshot)|fresh\s+read\s+complete\s*[—–-]\s*the\s+provider\s+state\s+(?:updated|changed|advanced))\s*:\s*$/i.test(plain)) {
    return [{ kind: 'changed' }];
  }

  return null;
}

function parseNarrativeLine(plain: string): ClaimWithoutLocation[] | null {
  const fieldPrefix = '(?:(?:current|final|latest)\\s+)?';
  const fieldBinding = '\\s*(?:is|remains|equals|=|:)\\s*';
  const revisionField = new RegExp(`^${fieldPrefix}revision${fieldBinding}(.+)$`, 'i').exec(plain);
  if (revisionField) {
    const parsed = fieldHistoryClaims(revisionField[1]!, 'revision', null);
    if (parsed) return parsed;
  }

  const statusField = new RegExp(`^${fieldPrefix}(?:status|state)${fieldBinding}(.+)$`, 'i').exec(plain);
  if (statusField) {
    const parsed = fieldHistoryClaims(statusField[1]!, 'status', null);
    if (parsed) return parsed;
  }

  const itemStatus = /^(?:item\s*:\s*(?:id\s+)?|)([A-Za-z0-9][A-Za-z0-9_.:/-]*)\b.*\bstatus\s*:\s*([A-Za-z0-9_-]+\s*\(\s*was\s+[A-Za-z0-9_-]+\s*\))[.!]?$/i.exec(plain);
  if (itemStatus) return fieldHistoryClaims(itemStatus[2]!, 'status', itemStatus[1]!);

  const sourceSuffix = /^source\s+marker\s*:\s*[A-Za-z0-9][A-Za-z0-9_.:/-]*\.\s+(.+)$/i.exec(plain);
  if (sourceSuffix) return parseKnownNarrativeLine(sourceSuffix[1]!);

  return parseKnownNarrativeLine(plain);
}

/**
 * Parse only the bounded temporal productions used by verified-read replies.
 * Unknown historical prose is surfaced instead of being guessed at.
 */
export function parseReadHistoryClaims(text: string): ReadHistoryClaimParse {
  const lines = text.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(text);
  const claims: ReadHistoryClaim[] = [];
  const unparsedTemporalSegments: UnparsedReadHistorySegment[] = [];
  const consumed = new Set<number>();

  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!authority[index] || !authority[index + 1]) continue;
    const headers = markdownTableCells(lines[index]!);
    const divider = markdownTableCells(lines[index + 1]!);
    if (!headers || !divider || headers.length !== divider.length || !markdownTableDivider(divider)) continue;

    consumed.add(index);
    consumed.add(index + 1);
    const normalized = headers.map(normalizeHeader);
    const idIndex = normalized.findIndex((header) => /^(?:item\s+)?(?:id|identifier)$/.test(header));
    const statusIndex = normalized.findIndex((header) => /^(?:status|state)$/.test(header));
    const revisionIndex = normalized.findIndex((header) => /^revision$/.test(header));
    const verticalFieldIndex = normalized.findIndex((header) => /^field$/.test(header));
    const verticalValueIndex = normalized.findIndex((header) => /^value$/.test(header));
    const vertical = headers.length === 2
      && verticalFieldIndex >= 0
      && verticalValueIndex >= 0;
    let cursor = index + 2;
    while (cursor < lines.length && authority[cursor]) {
      const cells = markdownTableCells(lines[cursor]!);
      if (!cells || cells.length !== headers.length || markdownTableDivider(cells)) break;
      consumed.add(cursor);
      const rowId = idIndex >= 0 ? cells[idIndex] || null : null;
      if (vertical) {
        const label = normalizeHeader(cells[verticalFieldIndex]!);
        const value = cells[verticalValueIndex]!;
        const field = /^(?:(?:current|final|latest)\s+)?revision$/.test(label)
          ? 'revision'
          : /^(?:(?:current|final|latest)\s+)?(?:status|state)$/.test(label)
            ? 'status'
            : null;
        if (field) {
          const parsed = fieldHistoryClaims(value, field, null);
          if (parsed && claimNumbersAreSafe(parsed)) addClaims(claims, cursor, lines[cursor]!, parsed);
          else if (historicalCue(value)) unparsedTemporalSegments.push({ lineIndex: cursor, text: lines[cursor]! });
        }
      }
      for (const [field, fieldIndex] of [['status', statusIndex], ['revision', revisionIndex]] as const) {
        if (fieldIndex < 0) continue;
        const value = cells[fieldIndex]!;
        const parsed = fieldHistoryClaims(value, field, rowId);
        if (parsed && claimNumbersAreSafe(parsed)) addClaims(claims, cursor, lines[cursor]!, parsed);
        else if (historicalCue(value)) unparsedTemporalSegments.push({ lineIndex: cursor, text: lines[cursor]! });
      }
      cursor += 1;
    }
    index = cursor - 1;
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!authority[index] || consumed.has(index) || !lines[index]!.trim()) continue;
    const plain = plainPresentationLine(lines[index]!);
    const parsed = parseNarrativeLine(plain);
    if (parsed && claimNumbersAreSafe(parsed)) addClaims(claims, index, lines[index]!, parsed);
    else if (historicalCue(plain)) unparsedTemporalSegments.push({ lineIndex: index, text: lines[index]! });
  }

  return { claims, unparsedTemporalSegments };
}

function normalizedStatus(value: string): string {
  return value.toLowerCase();
}

function coreSnapshotsEquivalent(left: ReadHistorySnapshot, right: ReadHistorySnapshot): boolean {
  if (left.sourceKey !== right.sourceKey
    || left.revision !== right.revision
    || left.count !== right.count
    || left.rows.length !== right.rows.length) return false;
  const leftIds = new Set(left.rows.map((row) => row.id));
  const rightRows = new Map(right.rows.map((row) => [row.id, row] as const));
  if (leftIds.size !== left.rows.length || rightRows.size !== right.rows.length) return false;
  return left.rows.every((row) => {
    const peer = rightRows.get(row.id);
    return peer !== undefined
      && peer.title === row.title
      && normalizedStatus(peer.status) === normalizedStatus(row.status);
  });
}

function completeSnapshotsEquivalent(left: ReadHistorySnapshot, right: ReadHistorySnapshot): boolean {
  return left.contentDigest === right.contentDigest && coreSnapshotsEquivalent(left, right);
}

function stableRow(
  current: ReadHistorySnapshot,
  prior: ReadHistorySnapshot,
  rowId: string | null,
): { current: ReadHistoryRow; prior: ReadHistoryRow } | null {
  const resolvedId = rowId ?? (
    current.rows.length === 1
      && prior.rows.length === 1
      && current.rows[0]!.id === prior.rows[0]!.id
      ? current.rows[0]!.id
      : null
  );
  if (resolvedId === null) return null;
  const currentRows = current.rows.filter((row) => row.id === resolvedId);
  const priorRows = prior.rows.filter((row) => row.id === resolvedId);
  return currentRows.length === 1 && priorRows.length === 1
    ? { current: currentRows[0]!, prior: priorRows[0]! }
    : null;
}

function pushReason(target: ReadHistoryReasonCode[], reason: ReadHistoryReasonCode): void {
  if (!target.includes(reason)) target.push(reason);
}

/** Validate parsed history against two trusted snapshots without changing text. */
export function validateReadHistoryClaims(input: ValidateReadHistoryClaimsInput): ReadHistoryValidationResult {
  const parsed = parseReadHistoryClaims(input.text);
  const temporalPresent = parsed.claims.length > 0 || parsed.unparsedTemporalSegments.length > 0;
  if (!temporalPresent) {
    return { ...parsed, decision: 'certified', reasonCodes: ['no_temporal_claims'] };
  }

  const reasons: ReadHistoryReasonCode[] = [];
  if (parsed.unparsedTemporalSegments.length > 0) pushReason(reasons, 'unknown_temporal_wording');
  const prior = input.prior ?? null;
  if (!prior) {
    // An unknown construction has not yet become a claim. Preserve the judge
    // escape hatch instead of pretending the bounded grammar understood it.
    if (parsed.claims.length === 0) {
      return { ...parsed, decision: 'needs_semantic_judge', reasonCodes: reasons };
    }
    pushReason(reasons, 'prior_snapshot_required');
    return { ...parsed, decision: 'contradicted', reasonCodes: reasons };
  }
  if (input.current.sourceKey !== prior.sourceKey) pushReason(reasons, 'source_key_mismatch');

  for (const claim of parsed.claims) {
    switch (claim.kind) {
      case 'same_source':
        if (input.current.sourceKey !== prior.sourceKey) pushReason(reasons, 'source_key_mismatch');
        break;
      case 'same_revision':
        if (input.current.revision === null || prior.revision === null) pushReason(reasons, 'revision_unavailable');
        else if (input.current.revision !== prior.revision) pushReason(reasons, 'revision_not_still');
        break;
      case 'unchanged':
        if (!completeSnapshotsEquivalent(input.current, prior)) pushReason(reasons, 'snapshot_changed');
        break;
      case 'changed':
        // A generic changed claim needs a durable business/core delta. Full
        // provider envelopes often contain volatile request ids or fetch
        // timestamps; those may disprove "unchanged" but never prove change.
        if (coreSnapshotsEquivalent(input.current, prior)) pushReason(reasons, 'snapshot_unchanged');
        break;
      case 'count_still':
        if (input.current.count !== claim.count) pushReason(reasons, 'count_mismatch');
        if (prior.count !== claim.count) pushReason(reasons, 'count_not_still');
        break;
      case 'status_still': {
        const row = stableRow(input.current, prior, claim.rowId);
        if (!row) pushReason(reasons, 'stable_row_required');
        else {
          if (normalizedStatus(row.current.status) !== normalizedStatus(claim.status)) pushReason(reasons, 'status_mismatch');
          if (normalizedStatus(row.prior.status) !== normalizedStatus(claim.status)) pushReason(reasons, 'status_not_still');
        }
        break;
      }
      case 'status_transition': {
        const row = stableRow(input.current, prior, claim.rowId);
        if (!row) pushReason(reasons, 'stable_row_required');
        else if (normalizedStatus(row.prior.status) !== normalizedStatus(claim.from)
          || normalizedStatus(row.current.status) !== normalizedStatus(claim.to)) {
          pushReason(reasons, 'status_transition_mismatch');
        }
        break;
      }
      case 'status_target': {
        const row = stableRow(input.current, prior, claim.rowId);
        if (!row) pushReason(reasons, 'stable_row_required');
        else if (normalizedStatus(row.current.status) !== normalizedStatus(claim.to)) pushReason(reasons, 'status_mismatch');
        break;
      }
      case 'revision_transition':
        if (prior.revision === null || input.current.revision === null) pushReason(reasons, 'revision_unavailable');
        else if (prior.revision !== claim.from || input.current.revision !== claim.to) pushReason(reasons, 'revision_transition_mismatch');
        break;
      case 'revision_target':
        if (input.current.revision === null) pushReason(reasons, 'revision_unavailable');
        else if (input.current.revision !== claim.to) pushReason(reasons, 'revision_mismatch');
        if (claim.requiresChange) {
          if (prior.revision === null) pushReason(reasons, 'revision_unavailable');
          else if (input.current.revision === prior.revision) pushReason(reasons, 'revision_not_changed');
        }
        break;
    }
  }

  const contradictions = reasons.filter((reason) => reason !== 'unknown_temporal_wording');
  if (contradictions.length > 0) return { ...parsed, decision: 'contradicted', reasonCodes: reasons };
  if (parsed.unparsedTemporalSegments.length > 0) {
    return { ...parsed, decision: 'needs_semantic_judge', reasonCodes: reasons };
  }
  return { ...parsed, decision: 'certified', reasonCodes: ['all_claims_match'] };
}
