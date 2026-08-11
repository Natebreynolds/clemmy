/**
 * Clem 4 horizon proof: pay discovery once, learn from verified evidence,
 * reuse without discovery on later turns, survive a real daemon restart, and
 * distinguish an explicit zero-work answer replay from a substantive correction.
 *
 * The provider is the isolated Composio CLI shim in provision.ts. It has no
 * real account or network path, but it exercises the production CLI search,
 * schema cache, governed execute, settlement, learning, restart, and replay
 * seams end to end.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';

import { measureAcceptedTurn, type AcceptedTurnMeasurement } from '../../session-comparison.js';
import { narrationCheck, openHarnessDb, reportBackCheck, stormCheck } from '../score.js';
import type { BrainKind, Check, DaemonHandle, ScenarioDef } from '../types.js';
import {
  authoritativePresentationLineMask,
  parseAuthoritativeMarkdownTables,
  parseCollectionCountHeading,
  parseCollectionStatusSummary,
  parseReadNavigationHeading,
  parseScopedProviderSnapshotBlocks,
  presentationRequiresSemanticJudge,
  projectScopedProviderSnapshotNarrative,
} from '../../../src/runtime/harness/presentation-authority.js';
import {
  validateReadHistoryClaims,
  type ReadHistorySnapshot,
} from '../../../src/runtime/harness/read-history-claims.js';

const IDENTIFIER = 'PROOF_LIST_TASKS';
const SOURCE_MARKER = 'PROOF_RELEASE_QUEUE:LOCAL_ONLY';
const ITEM_ID = 'proof-release-1';
const ITEM_TITLE = 'Review the Clementine 4 release proof';
const REVISION_ONE = 1;
const REVISION_TWO = 2;
const ORDINARY_BRAIN_COMPLETION_REASONS = new Set(['success', 'claude_agent_sdk_brain']);
const PRIVATE_CONTROL_REPLY = /\[harness settled-read(?: replay)?\]|same_source_settled_read_replay|replayedFromCallId|replayCalledEventId/i;

interface TerminalConversationSurface {
  completionVerdicts: number;
  reason: string | null;
  receiptKind: string | null;
  receiptPresentationDigest: string | null;
  receiptSourceUserSeq: number | null;
  transport: string | null;
  reply: string | null;
  presentationText: string | null;
}

/**
 * This protects conversation-surface integrity, not raw model provenance.
 * The event log does not retain an untruncated provider-neutral raw brain
 * output for every lane, so the strongest honest assertion here is exact byte
 * equality across the terminal reply, public presentation, and delivered HTTP
 * text, plus absence of known private control prose.
 */
export function terminalConversationSurfacesPreserveBytes(input: {
  terminal: TerminalConversationSurface | null;
  deliveredText: string;
}): boolean {
  if (!input.terminal || !input.deliveredText.trim()) return false;
  const allowedTerminalReason = ORDINARY_BRAIN_COMPLETION_REASONS.has(input.terminal.reason ?? '')
    || input.terminal.reason === 'stall_judge_delivered'
    || input.terminal.reason === 'awaiting_user_input';
  return input.terminal.transport === null
    && allowedTerminalReason
    && input.terminal.reply === input.deliveredText
    && input.terminal.presentationText === input.deliveredText
    && !PRIVATE_CONTROL_REPLY.test(input.deliveredText);
}

function terminalConversationSurface(
  home: string,
  sessionId: string,
  sourceUserSeq: number,
): TerminalConversationSurface | null {
  const db = openHarnessDb(home);
  try {
    const row = db.prepare(`
      SELECT seq, data_json
      FROM events
      WHERE session_id = ?
        AND type = 'conversation_completed'
        AND COALESCE(
          json_extract(data_json, '$.sourceUserSeq'),
          json_extract(data_json, '$.presentation.identity.sourceUserSeq')
        ) = ?
      ORDER BY seq ASC
    `).all(sessionId, sourceUserSeq) as Array<{ seq: number; data_json: string }>;
    if (row.length !== 1) return null;
    const data = JSON.parse(row[0]!.data_json) as Record<string, unknown>;
    const presentation = data.presentation && typeof data.presentation === 'object'
      && !Array.isArray(data.presentation)
      ? data.presentation as Record<string, unknown>
      : null;
    const receipt = data.verifiedReadCompletionReceipt
      && typeof data.verifiedReadCompletionReceipt === 'object'
      && !Array.isArray(data.verifiedReadCompletionReceipt)
      ? data.verifiedReadCompletionReceipt as Record<string, unknown>
      : null;
    const completionVerdicts = db.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE session_id = ?
        AND seq > ?
        AND seq < ?
        AND type = 'verdict_recorded'
        AND json_extract(data_json, '$.door') = 'completion'
    `).get(sessionId, sourceUserSeq, row[0]!.seq) as { count: number };
    return {
      completionVerdicts: completionVerdicts.count,
      reason: typeof data.reason === 'string' ? data.reason : null,
      receiptKind: typeof receipt?.kind === 'string' ? receipt.kind : null,
      receiptPresentationDigest: typeof receipt?.presentationDigest === 'string'
        ? receipt.presentationDigest
        : null,
      receiptSourceUserSeq: Number.isSafeInteger(receipt?.sourceUserSeq)
        ? receipt!.sourceUserSeq as number
        : null,
      transport: typeof data.transport === 'string' ? data.transport : null,
      reply: typeof data.reply === 'string' ? data.reply : null,
      presentationText: typeof presentation?.text === 'string' ? presentation.text : null,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function conversationSurfaceDetail(
  terminal: TerminalConversationSurface | null,
  deliveredText: string,
): string {
  const delivered = deliveredText.trim();
  return JSON.stringify({
    reason: terminal?.reason ?? null,
    transport: terminal?.transport ?? null,
    exactReplyMatches: terminal?.reply === deliveredText,
    exactPresentationMatches: terminal?.presentationText === deliveredText,
    replyMatches: terminal?.reply?.trim() === delivered,
    presentationMatches: terminal?.presentationText?.trim() === delivered,
    privateControlVisible: PRIVATE_CONTROL_REPLY.test(delivered),
  });
}

export function verifiedReadOptimizationChecks(
  label: string,
  terminal: TerminalConversationSurface | null,
  deliveredText: string,
  sourceUserSeq: number,
  selectedBrain: BrainKind,
  expectedReceiptKind: 'single_collection_read' | 'read_discovery_scaffold',
): Check[] {
  const receiptSupported = selectedBrain !== 'claude';
  const deliveredDigest = createHash('sha256').update(deliveredText).digest('hex');
  const receiptValid = terminal?.receiptSourceUserSeq === sourceUserSeq
    && terminal.receiptPresentationDigest === deliveredDigest
    && terminal.receiptKind === expectedReceiptKind;
  return [
    {
      name: `${label}: redundant completion judge was absent`,
      pass: terminal?.completionVerdicts === 0,
      detail: `completion verdicts=${terminal?.completionVerdicts ?? 'missing terminal'}`,
    },
    !receiptSupported
      ? {
          name: `${label}: Claude SDK path is explicitly outside verified-read receipt support`,
          pass: terminal?.reason === 'claude_agent_sdk_brain'
            && terminal.receiptKind === null
            && terminal.receiptSourceUserSeq === null
            && terminal.receiptPresentationDigest === null,
          detail: JSON.stringify({
            supported: false,
            selectedBrain,
            reason: terminal?.reason ?? null,
            kind: terminal?.receiptKind ?? null,
          }),
        }
      : {
          name: `${label}: supported path has an exact verified-read receipt for the delivered bytes`,
          pass: receiptValid,
          detail: JSON.stringify({
            supported: true,
            selectedBrain,
            kind: terminal?.receiptKind ?? null,
            expectedKind: expectedReceiptKind,
            sourceMatches: terminal?.receiptSourceUserSeq === sourceUserSeq,
            presentationDigestMatches: terminal?.receiptPresentationDigest === deliveredDigest,
          }),
        },
  ];
}

function acceptedSourceSeq(home: string, sessionId: string): number {
  const db = openHarnessDb(home);
  try {
    const row = db.prepare(`
      SELECT seq
      FROM events
      WHERE session_id = ?
        AND type = 'user_input_received'
        AND role = 'user'
        AND COALESCE(json_extract(data_json, '$.synthetic'), 0) != 1
      ORDER BY seq DESC
      LIMIT 1
    `).get(sessionId) as { seq?: unknown } | undefined;
    if (!row || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq <= 0) {
      throw new Error(`accepted source missing for ${sessionId}`);
    }
    return row.seq;
  } finally {
    db.close();
  }
}

function learnedCapabilityCommitted(
  home: string,
  sessionId: string,
  sourceUserSeq: number,
): boolean {
  const root = path.join(home, 'memory', 'capability-aliases');
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'aliases.db');
    if (!existsSync(file)) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const row = db.prepare(`
        SELECT 1 AS committed
        FROM pending_learning AS pending
        WHERE pending.session_id = ?
          AND pending.source_user_seq = ?
          AND pending.identifier = ?
          AND pending.status = 'done'
          AND EXISTS (
            SELECT 1
            FROM aliases AS alias
            WHERE alias.identifier = pending.identifier
              AND alias.klass = 'capability_only'
          )
        LIMIT 1
      `).get(sessionId, sourceUserSeq, IDENTIFIER) as { committed?: number } | undefined;
      if (row?.committed === 1) return true;
    } catch {
      // The worker may be creating/migrating the database; retry the poll.
    } finally {
      db?.close();
    }
  }
  return false;
}

async function waitForLearnedCapability(
  home: string,
  sessionId: string,
  sourceUserSeq: number,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (learnedCapabilityCommitted(home, sessionId, sourceUserSeq)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return learnedCapabilityCommitted(home, sessionId, sourceUserSeq);
}

function lines(home: string, name: string): string[] {
  const file = path.join(home, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

interface ProviderCall {
  slug: string;
  payload: string;
}

function providerCalls(home: string, name: string): ProviderCall[] {
  return lines(home, name).flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { slug?: unknown; payload?: unknown };
      return typeof parsed.slug === 'string' && typeof parsed.payload === 'string'
        ? [{ slug: parsed.slug, payload: parsed.payload }]
        : [];
    } catch {
      return [];
    }
  });
}

function exactToolShape(
  turn: AcceptedTurnMeasurement,
  expected: Record<string, number>,
): boolean {
  const actualKeys = Object.keys(turn.perTool).sort();
  const expectedKeys = Object.keys(expected).sort();
  return turn.canonicalTopLevelToolCalls === Object.values(expected).reduce((sum, count) => sum + count, 0)
    && JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((tool) => turn.perTool[tool] === expected[tool]);
}

function stripOuterMarkdown(value: string): string {
  let normalized = value.trim();
  const wrappers = ['**', '__', '`', '*', '_'] as const;
  while (true) {
    const wrapper = wrappers.find((candidate) => normalized.length > candidate.length * 2
      && normalized.startsWith(candidate)
      && normalized.endsWith(candidate));
    if (!wrapper) return normalized;
    normalized = normalized.slice(wrapper.length, -wrapper.length).trim();
  }
}

function markdownTableFields(
  text: string,
  fields: readonly string[],
): Record<string, string> | null {
  const rows = text.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(text);
  const cells = (row: string): string[] => row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => stripOuterMarkdown(cell));
  const requested = fields.map((field) => field.toLowerCase());
  for (let index = 0; index < rows.length; index += 1) {
    if (!authority[index] || !rows[index]?.includes('|')) continue;
    const headers = cells(rows[index]!);
    const fieldIndexes = requested.map((field) => headers.findIndex((header) => header.toLowerCase() === field));
    if (fieldIndexes.some((fieldIndex) => fieldIndex < 0)) continue;
    const separator = rows[index + 1];
    if (!authority[index + 1]
      || !separator?.includes('|')
      || !cells(separator).every((value) => /^:?-+:?$/.test(value))) continue;
    for (let candidate = index + 2; candidate < rows.length; candidate += 1) {
      if (!authority[candidate] || !rows[candidate]?.includes('|')) break;
      const values = cells(rows[candidate]!);
      return Object.fromEntries(requested.map((field, fieldOffset) => [
        field,
        values[fieldIndexes[fieldOffset]!] ?? '',
      ]));
    }
  }
  return null;
}

function markdownKeyValueTableFields(
  text: string,
  fields: readonly string[],
): Record<string, string> | null {
  const rows = text.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(text);
  const cells = (row: string): string[] => row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => stripOuterMarkdown(cell));
  const requested = fields.map((field) => field.toLowerCase());
  for (let index = 0; index < rows.length; index += 1) {
    if (!authority[index] || !rows[index]?.includes('|')) continue;
    const headers = cells(rows[index]!).map((header) => header.toLowerCase());
    const fieldIndex = headers.indexOf('field');
    const valueIndex = headers.indexOf('value');
    if (fieldIndex < 0 || valueIndex < 0) continue;
    const separator = rows[index + 1];
    if (!authority[index + 1]
      || !separator?.includes('|')
      || !cells(separator).every((value) => /^:?-+:?$/.test(value))) continue;
    const found: Record<string, string> = {};
    for (let candidate = index + 2; candidate < rows.length; candidate += 1) {
      if (!authority[candidate] || !rows[candidate]?.includes('|')) break;
      const values = cells(rows[candidate]!);
      const key = (values[fieldIndex] ?? '').toLowerCase();
      if (requested.includes(key)) found[key] = values[valueIndex] ?? '';
    }
    if (requested.every((field) => Boolean(found[field]))) return found;
  }
  return null;
}

/** Parse the exact split-table block emitted by natural live provider prose:
 * one Field/Value table owns the source marker + revision, followed locally by
 * the known item's horizontal status table. Keeping the tables adjacent and
 * binding the marker inside the metadata table prevents evidence from being
 * composed across unrelated or historical sections. */
function markdownSplitProviderFields(text: string): {
  revision: string;
  itemId: string;
  title: string;
  status: string;
} | null {
  const rows = text.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(text);
  const cells = (row: string): string[] => row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => stripOuterMarkdown(cell));
  for (let index = 0; index < rows.length; index += 1) {
    if (!authority[index] || !rows[index]?.includes('|')) continue;
    const headers = cells(rows[index]!).map((header) => header.toLowerCase());
    const metadataFieldIndex = headers.indexOf('field');
    const metadataValueIndex = headers.indexOf('value');
    if (metadataFieldIndex < 0 || metadataValueIndex < 0) continue;
    const separator = rows[index + 1];
    if (!authority[index + 1]
      || !separator?.includes('|')
      || !cells(separator).every((value) => /^:?-+:?$/.test(value))) continue;

    const metadata: Record<string, string> = {};
    let cursor = index + 2;
    for (; cursor < rows.length && authority[cursor] && rows[cursor]?.includes('|'); cursor += 1) {
      const values = cells(rows[cursor]!);
      metadata[(values[metadataFieldIndex] ?? '').toLowerCase()] = values[metadataValueIndex] ?? '';
    }
    if (metadata['source marker'] !== SOURCE_MARKER || !metadata.revision) continue;

    while (cursor < rows.length && !rows[cursor]?.trim()) cursor += 1;
    const collectionHeading = authority[cursor]
      ? parseCollectionCountHeading(rows[cursor] ?? '')
      : null;
    if (collectionHeading?.count === 1) {
      cursor += 1;
      while (cursor < rows.length && !rows[cursor]?.trim()) cursor += 1;
    }
    if (!authority[cursor] || !rows[cursor]?.includes('|')) continue;
    const itemHeaders = cells(rows[cursor]!).map((header) => header.toLowerCase());
    const itemIndex = itemHeaders.findIndex((header) => header === 'item id' || header === 'item');
    const titleIndex = itemHeaders.indexOf('title');
    const statusIndex = itemHeaders.indexOf('status');
    if (itemIndex < 0 || titleIndex < 0 || statusIndex < 0) continue;
    const itemSeparator = rows[cursor + 1];
    if (!authority[cursor + 1]
      || !itemSeparator?.includes('|')
      || !cells(itemSeparator).every((value) => /^:?-+:?$/.test(value))) continue;
    for (let candidate = cursor + 2; candidate < rows.length; candidate += 1) {
      if (!authority[candidate] || !rows[candidate]?.includes('|')) break;
      const values = cells(rows[candidate]!);
      if ((values[itemIndex] ?? '').toLowerCase() !== ITEM_ID.toLowerCase()) continue;
      return {
        revision: metadata.revision,
        itemId: values[itemIndex] ?? '',
        title: values[titleIndex] ?? '',
        status: values[statusIndex] ?? '',
      };
    }
  }
  return null;
}

export function markdownTableField(text: string, field: string): string | null {
  return markdownTableFields(text, [field])?.[field.toLowerCase()]
    || markdownKeyValueTableFields(text, [field])?.[field.toLowerCase()]
    || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labeledField(text: string, field: string): string | null {
  const label = escapeRegExp(field);
  const pattern = new RegExp(`^\\s*(?:(?:[-+*]|\\d+[.)])\\s+)?${label}\\s*[:=]\\s*(.*?)\\s*$`, 'i');
  const authority = authoritativePresentationLineMask(text);
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!authority[index]) continue;
    // Removing Markdown delimiters makes both `**Revision:** 1` and
    // `- Revision: 1` use the same strict, line-scoped label parser.
    const match = pattern.exec(line.replace(/[*_`]/g, ''));
    if (!match) continue;
    return (match[1] ?? '').trim().replace(/[.,;]\s*$/, '').trim() || null;
  }
  return null;
}

function exactLabeledField(text: string, field: string): string | null {
  const label = escapeRegExp(field);
  const wrapper = '(?:\\*\\*|__|`|\\*|_)?';
  const pattern = new RegExp(
    `^\\s*(?:(?:[-+*]|\\d+[.)])\\s+)?${wrapper}${label}\\s*[:=]${wrapper}\\s*(.*?)\\s*$`,
    'i',
  );
  const authority = authoritativePresentationLineMask(text);
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!authority[index]) continue;
    const match = pattern.exec(line);
    if (!match) continue;
    return stripOuterMarkdown(match[1] ?? '')
      .trim()
      .replace(/[.,;]\s*$/, '')
      .trim() || null;
  }
  return null;
}

function terminalFieldWithinLabel(text: string, outerField: string, nestedField: string): string | null {
  const outerValue = labeledField(text, outerField);
  if (!outerValue) return null;
  const nested = escapeRegExp(nestedField);
  // Accept a nested field only as the terminal em/en-dash-delimited attribute
  // of a strict labeled line, e.g. `Item: id — title — status: open`. Incidental
  // status prose and historical comparisons cannot satisfy this shape.
  const match = new RegExp(
    `(?:^|\\s+[—–-]\\s+)${nested}\\s*[:=]\\s*([A-Za-z0-9_-]+)(?:\\s*\\((?:up\\s+from|was|from|previously)\\s+[A-Za-z0-9_-]+\\))?[.,;]?\\s*$`,
    'i',
  ).exec(outerValue);
  return match?.[1] ?? null;
}

function terminalCommaFieldWithinKnownItemLabel(
  text: string,
  outerField: string,
  nestedField: string,
): string | null {
  const outerValue = labeledField(text, outerField);
  if (!outerValue) return null;
  const item = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(ITEM_ID)}(?![A-Za-z0-9_-])`, 'i');
  if (!item.test(outerValue)) return null;
  const nested = escapeRegExp(nestedField);
  // Claude also emits compact records such as
  // `Item: id proof-release-1, title "...", status open`. Accept only the
  // terminal field of a strict Item label for the known item; incidental or
  // historical status prose cannot satisfy this anchored shape.
  const match = new RegExp(
    `,\\s*${nested}(?:\\s*[:=]\\s*|\\s+)([A-Za-z0-9_-]+)(?:\\s*\\((?:up\\s+from|was|from|previously)\\s+[A-Za-z0-9_-]+\\))?[.,;]?\\s*$`,
    'i',
  ).exec(outerValue);
  return match?.[1] ?? null;
}

function terminalFieldWithinKnownItemLine(text: string, nestedField: string): string | null {
  const nested = escapeRegExp(nestedField);
  const item = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(ITEM_ID)}(?![A-Za-z0-9_-])`, 'i');
  // Natural provider prose sometimes omits the colon in a dash-delimited
  // terminal attribute (`Item: known-id — title — status open`). The exact
  // known item, dash boundary, scalar value, and end-of-line anchor keep this
  // from promoting incidental or historical status prose to current evidence.
  const field = new RegExp(
    `\\s+[—–-]\\s+${nested}(?:\\s*[:=]\\s*|\\s+)([A-Za-z0-9_-]+)(?:\\s*\\((?:up\\s+from|was|from|previously)\\s+[A-Za-z0-9_-]+\\))?[.,;]?\\s*$`,
    'i',
  );
  const authority = authoritativePresentationLineMask(text);
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!authority[index]) continue;
    const normalized = line.replace(/[*_`]/g, '');
    if (!item.test(normalized)) continue;
    const match = field.exec(normalized);
    if (match?.[1]) return match[1];
  }
  return null;
}

function currentScalar(value: string | null): string | null {
  if (!value) return null;
  const normalized = stripOuterMarkdown(value).trim();
  return /^([A-Za-z0-9_-]+)(?:\s*\((?:up\s+from|was|from|previously)\s+[A-Za-z0-9_-]+\))?[.,;]?\s*$/i.exec(normalized)?.[1] ?? null;
}

function exactCombinedItemLineMatches(line: string, expectedStatus: string): boolean {
  const plain = line.replace(/[*_`]/g, '').trim();
  const prefix = '^\\s*(?:(?:[-+*]|\\d+[.)])\\s+)?item\\s*[:=]\\s*';
  const scalarTail =
    '([A-Za-z0-9_-]+)(?:\\s*\\((?:up\\s+from|was|from|previously)\\s+[A-Za-z0-9_-]+\\))?[.,;]?\\s*$';
  const comma = new RegExp(
    `${prefix}id\\s+([A-Za-z0-9][A-Za-z0-9_.:/-]*)\\s*,\\s*title\\s+(.+?)\\s*,\\s*status(?:\\s*[:=]\\s*|\\s+)${scalarTail}`,
    'i',
  ).exec(plain);
  const dash = new RegExp(
    `${prefix}(?:id\\s+)?([A-Za-z0-9][A-Za-z0-9_.:/-]*)\\s+[—–-]\\s+(.+?)\\s+[—–-]\\s+status(?:\\s*[:=]\\s*|\\s+)${scalarTail}`,
    'i',
  ).exec(plain);
  const bullet = new RegExp(
    `^\\s*(?:(?:[-+]|\\d+[.)])\\s+)?([A-Za-z0-9][A-Za-z0-9_.:/-]*)\\s+[—–-]\\s+(.+?)\\s+[—–-]\\s+status(?:\\s*[:=]\\s*|\\s+)${scalarTail}`,
    'i',
  ).exec(plain);
  const match = comma ?? dash ?? bullet;
  return Boolean(match
    && exactProviderValue(match[1] ?? null, ITEM_ID)
    && exactProviderValue(match[2] ?? null, ITEM_TITLE)
    && currentScalar(match[3] ?? null)?.toLowerCase() === expectedStatus.toLowerCase());
}

function exactPresentedText(value: string | null): string | null {
  if (!value) return null;
  const normalized = stripOuterMarkdown(value)
    .trim()
    .replace(/[.,;]\s*$/, '')
    .trim();
  const quoted = /^(?:["“](.*)["”]|['‘](.*)['’])$/u.exec(normalized);
  return (quoted?.[1] ?? quoted?.[2] ?? normalized).trim() || null;
}

function exactProviderValue(value: string | null, expected: string): boolean {
  return exactPresentedText(value)?.toLowerCase() === expected.toLowerCase();
}

interface InlineCurrentMetadataPair {
  sourceMarker: string;
  revision: string;
  lineIndex: number;
  scope: string | null;
}

function inlineCurrentMetadataPairs(text: string): InlineCurrentMetadataPair[] {
  const pairs: InlineCurrentMetadataPair[] = [];
  const pairPattern = /\(\s*source\s+marker\s*(?:(?:is|remains|equals)\s+|[:=]\s*)?([A-Za-z0-9][A-Za-z0-9_.:/-]*)\s*,\s*(?:now\s+at\s+|current\s+)?revision\s*(?:(?:is|remains|equals)\s+|[:=]\s*)?(\d+)\s*\)/gi;
  const authority = authoritativePresentationLineMask(text);
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    if (!authority[lineIndex]) continue;
    const line = rawLine.replace(/\*\*/g, '').replace(/`/g, '');
    const matches = [...line.matchAll(pairPattern)];
    if (matches.length !== 1) continue;
    for (const match of matches) {
      const prefix = line.slice(0, match.index ?? 0);
      const suffix = line.slice((match.index ?? 0) + match[0].length);
      const heading = prefix.trim().replace(/^#{1,6}\s*/, '');
      const hereHeading = /^here\s+(?:are|is)\s+the\s+(?:current|latest)\s+(?:items?|records?|rows?|tasks?)(?:\s+(?:in|from|for|on)\s+the\s+([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,8}\s+(?:queue|feed|list|snapshot)))?$/i.exec(heading);
      const freshHeading = /^fresh\s+read\s+of\s+the\s+([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,8}\s+(?:queue|feed|list|snapshot))$/i.exec(heading);
      if (!hereHeading && !freshHeading) continue;
      if (/^\s*(?:>\s*)?["“'‘]/u.test(prefix) || /["“'‘]\s*$/u.test(prefix)) continue;
      if (!/^\s*:\s*$/.test(suffix)) continue;
      pairs.push({
        sourceMarker: match[1]!,
        revision: match[2]!,
        lineIndex,
        scope: (hereHeading?.[1] ?? freshHeading?.[1] ?? '')
          .replace(/[^a-z0-9]+/gi, ' ')
          .trim()
          .toLowerCase() || null,
      });
    }
  }
  return pairs;
}

function inlineCurrentMetadataPairOwnsItemTable(
  text: string,
  pair: InlineCurrentMetadataPair,
): boolean {
  const lines = text.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(text);
  let headerIndex = pair.lineIndex + 1;
  while (headerIndex < lines.length && !lines[headerIndex]!.trim()) headerIndex += 1;
  const cells = (line: string): string[] | null => {
    if (!/^\s*\|.*\|\s*$/.test(line)) return null;
    return line.trim().slice(1, -1).split('|').map((cell) => stripOuterMarkdown(cell).trim());
  };
  const headers = headerIndex < lines.length ? cells(lines[headerIndex]!) : null;
  const divider = headerIndex + 1 < lines.length ? cells(lines[headerIndex + 1]!) : null;
  const row = headerIndex + 2 < lines.length ? cells(lines[headerIndex + 2]!) : null;
  if (!authority[pair.lineIndex]
    || !authority[headerIndex]
    || !authority[headerIndex + 1]
    || !authority[headerIndex + 2]
    || !headers || !divider || !row
    || headers.length !== 3
    || divider.length !== 3
    || row.length !== 3
    || !divider.every((value) => /^:?-{3,}:?$/.test(value))) return false;
  const normalizedHeaders = headers.map((header) => header.toLowerCase());
  if (!(
    (normalizedHeaders[0] === 'item id' || normalizedHeaders[0] === 'item')
    && normalizedHeaders[1] === 'title'
    && (normalizedHeaders[2] === 'status' || normalizedHeaders[2] === 'state')
  )) return false;
  const following = headerIndex + 3 < lines.length ? cells(lines[headerIndex + 3]!) : null;
  return !following;
}

function itemLineEvidence(text: string, expectedStatus: string): boolean {
  const authority = authoritativePresentationLineMask(text);
  return text.split(/\r?\n/).some((line, index) => (
    Boolean(authority[index]) && exactCombinedItemLineMatches(line, expectedStatus)
  ));
}

function metadataLabelsMatch(text: string, revision: number): boolean {
  const sourceLabels = [
    exactLabeledField(text, 'Source marker'),
    exactLabeledField(text, 'Source'),
  ].filter((value): value is string => Boolean(value));
  const labeled = sourceLabels.length > 0
    && sourceLabels.every((value) => exactProviderValue(value, SOURCE_MARKER))
    && currentScalar(labeledField(text, 'Revision')) === String(revision);
  const inline = inlineCurrentMetadataPairs(text);
  return labeled || (inline.length === 1
    && inlineCurrentMetadataPairOwnsItemTable(text, inline[0]!)
    && (inline[0]!.scope === null || inline[0]!.scope === 'proof release queue')
    && exactProviderValue(inline[0]!.sourceMarker, SOURCE_MARKER)
    && inline[0]!.revision === String(revision));
}

function itemLabelsMatch(text: string, expectedStatus: string): boolean {
  const exactSeparateLabels = exactProviderValue(exactLabeledField(text, 'Item ID'), ITEM_ID)
    && exactProviderValue(exactLabeledField(text, 'Title'), ITEM_TITLE)
    && currentScalar(labeledField(text, 'Status'))?.toLowerCase() === expectedStatus.toLowerCase();
  if (exactSeparateLabels) return true;

  return itemLineEvidence(text, expectedStatus);
}

function horizontalItemTableMatches(text: string, expectedStatus: string): boolean {
  const fields = markdownTableFields(text, ['Item ID', 'Title', 'Status'])
    ?? markdownTableFields(text, ['Item', 'Title', 'Status']);
  return exactProviderValue(fields?.['item id'] ?? fields?.item ?? null, ITEM_ID)
    && exactProviderValue(fields?.title ?? null, ITEM_TITLE)
    && currentScalar(fields?.status ?? null)?.toLowerCase() === expectedStatus.toLowerCase();
}

function structuredProviderAssertionsMatch(text: string, revision: number, status: string): boolean {
  type FieldKey = 'source marker' | 'revision' | 'item id' | 'title' | 'status';
  const normalizedLabel = (value: string): string => stripOuterMarkdown(value)
    .trim()
    .toLowerCase()
    .replace(/^(?:current|final|latest)\s+/, '');
  const canonicalField = (value: string): FieldKey | null => {
    const label = normalizedLabel(value);
    if (label === 'source marker' || label === 'source') return 'source marker';
    if (label === 'revision') return 'revision';
    if (label === 'item id' || label === 'item') return 'item id';
    if (label === 'title') return 'title';
    if (label === 'status' || label === 'state') return 'status';
    return null;
  };
  const expected = new Map<FieldKey, { value: string; scalar: boolean; scope: 'metadata' | 'row' }>([
    ['source marker', { value: SOURCE_MARKER, scalar: false, scope: 'metadata' }],
    ['revision', { value: String(revision), scalar: true, scope: 'metadata' }],
    ['item id', { value: ITEM_ID, scalar: false, scope: 'row' }],
    ['title', { value: ITEM_TITLE, scalar: false, scope: 'row' }],
    ['status', { value: status, scalar: true, scope: 'row' }],
  ]);
  const valueMatches = (value: string, field: FieldKey): boolean => {
    const spec = expected.get(field)!;
    return spec.scalar
      ? currentScalar(value)?.toLowerCase() === spec.value.toLowerCase()
      : exactProviderValue(value, spec.value);
  };

  const parsed = parseAuthoritativeMarkdownTables(text);
  if (!parsed.valid || parsed.tables.length > 2) return false;
  const lines = text.split(/\r?\n/);
  const claimed = new Set<FieldKey>();
  const tableKinds: Array<{
    kind: 'vertical' | 'horizontal';
    fields: FieldKey[];
    headerLineIndex: number;
    endLineIndex: number;
  }> = [];

  for (const table of parsed.tables) {
    const headers = table.headers.map(normalizedLabel);
    const tableFields: FieldKey[] = [];
    if (headers.length === 2 && headers[0] === 'field' && headers[1] === 'value') {
      for (const row of table.rows) {
        const field = canonicalField(row[0] ?? '');
        if (!field || claimed.has(field) || tableFields.includes(field)
          || !valueMatches(row[1] ?? '', field)) return false;
        claimed.add(field);
        tableFields.push(field);
      }
      tableKinds.push({
        kind: 'vertical',
        fields: tableFields,
        headerLineIndex: table.headerLineIndex,
        endLineIndex: table.endLineIndex,
      });
      continue;
    }

    if (table.rows.length !== 1 || new Set(headers).size !== headers.length) return false;
    const row = table.rows[0]!;
    for (let index = 0; index < headers.length; index += 1) {
      const field = canonicalField(headers[index]!);
      if (!field || claimed.has(field) || tableFields.includes(field)
        || !valueMatches(row[index] ?? '', field)) return false;
      claimed.add(field);
      tableFields.push(field);
    }
    tableKinds.push({
      kind: 'horizontal',
      fields: tableFields,
      headerLineIndex: table.headerLineIndex,
      endLineIndex: table.endLineIndex,
    });
  }

  if (tableKinds.length === 2) {
    const [first, second] = tableKinds;
    const authority = authoritativePresentationLineMask(text);
    const bridgeIndexes = lines
      .map((line, index) => ({ index, line }))
      .slice(first!.endLineIndex + 1, second!.headerLineIndex)
      .filter(({ line }) => line.trim())
      .map(({ index }) => index);
    const bridge = bridgeIndexes.length === 1 && authority[bridgeIndexes[0]!]
      ? parseCollectionCountHeading(lines[bridgeIndexes[0]!]!)
      : null;
    const bridgeIsOwned = bridgeIndexes.length === 0
      || (bridgeIndexes.length === 1 && bridge?.count === 1);
    if (first!.kind !== 'vertical'
      || second!.kind !== 'horizontal'
      || first!.fields.some((field) => expected.get(field)!.scope !== 'metadata')
      || second!.fields.some((field) => expected.get(field)!.scope !== 'row')
      || !bridgeIsOwned) {
      return false;
    }
  }
  return true;
}

function ownedCollectionTableBridgeLineIndexes(text: string, expectedCount: number): Set<number> {
  const parsed = parseAuthoritativeMarkdownTables(text);
  if (!parsed.valid || parsed.tables.length !== 2) return new Set();
  const [first, second] = parsed.tables;
  const lines = text.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(text);
  const bridgeIndexes = lines
    .map((line, index) => ({ index, line }))
    .slice(first!.endLineIndex + 1, second!.headerLineIndex)
    .filter(({ line }) => line.trim())
    .map(({ index }) => index);
  if (bridgeIndexes.length !== 1 || !authority[bridgeIndexes[0]!]) return new Set();
  const heading = parseCollectionCountHeading(lines[bridgeIndexes[0]!]!);
  return heading?.count === expectedCount ? new Set(bridgeIndexes) : new Set();
}

function contradictoryNarrativeItemStatus(text: string, expectedStatus: string): boolean {
  const item = escapeRegExp(ITEM_ID);
  const subject = `(?<![A-Za-z0-9_-])(?:item|record|row|task|${item})(?![A-Za-z0-9_-])`;
  const patterns = [
    new RegExp(`(?:^|[.!?]\\s+|\\n)\\s*(?:(?:the|this|that)\\s+)?${subject}\\s+(?:is|remains)\\s+(?:(?:currently|now)\\s+)?([^.!?\\n]{1,80})(?=[.!?]|$)`, 'gi'),
    new RegExp(`(?:^|[.!?]\\s+|\\n)\\s*(?:(?:the|this|that)\\s+)?${subject}[’']s\\s+(?:current\\s+)?(?:status|state)\\s*(?:is|remains|[:=])\\s*([^.!?\\n]{1,80})(?=[.!?]|$)`, 'gi'),
    /(?:^|[.!?]\s+|\n)\s*its\s+(?:current\s+)?(?:status|state)\s*(?:is|remains|[:=])\s*([^.!?\n]{1,80})(?=[.!?]|$)/gi,
    /(?:^|\n)\s*(?:current|final|latest)\s+(?:status|state)\s*[:=]\s*([^.!?\n]{1,80})(?=[.!?]|$)/gi,
  ];
  const narrative = text
    .replace(/[*_`]/g, '')
    .replace(/\bisn[’']t\b/gi, 'is not');
  for (const pattern of patterns) {
    for (const match of narrative.matchAll(pattern)) {
      const claimed = currentScalar(match[1] ?? '');
      if (!claimed || claimed.toLowerCase() !== expectedStatus.toLowerCase()) return true;
    }
  }
  return false;
}

function strictSnapshotLineMatches(line: string, revision: number, status: string): boolean {
  return exactProviderValue(exactLabeledField(line, 'Source marker'), SOURCE_MARKER)
    || exactProviderValue(exactLabeledField(line, 'Source'), SOURCE_MARKER)
    || currentScalar(labeledField(line, 'Revision')) === String(revision)
    || exactProviderValue(exactLabeledField(line, 'Item ID'), ITEM_ID)
    || exactProviderValue(exactLabeledField(line, 'Title'), ITEM_TITLE)
    || currentScalar(labeledField(line, 'Status'))?.toLowerCase() === status.toLowerCase()
    || itemLabelsMatch(line, status);
}

function wholeSegmentExplicitProviderFieldClaim(segment: string): boolean {
  const prefix = '(?:(?:actually|however|in fact|for clarity),\\s*|but(?:,\\s*|\\s+))?';
  const aliases = ['source marker', 'source', 'revision', 'item id', 'id', 'identifier', 'title', 'status', 'state'];
  for (const alias of aliases) {
    const escaped = escapeRegExp(alias).replace(/\s+/g, '\\s+');
    const direct = new RegExp(
      `^${prefix}(?:(?:the|this|that)\\s+)?(?:current|final|latest)?\\s*${escaped}(?![A-Za-z0-9_-])\\s*(?:is|remains|equals|=|:)\\s*([^.!?\\n;,]+)[.!]?$`,
      'i',
    );
    const possessive = new RegExp(
      `^${prefix}(?:its|(?:(?:the|this|that)\\s+)?(?:item|record|row|task|${escapeRegExp(ITEM_ID)})[’']s)\\s+(?:current\\s+)?${escaped}(?![A-Za-z0-9_-])\\s*(?:is|remains|equals|=|:)\\s*([^.!?\\n;,]+)[.!]?$`,
      'i',
    );
    if (direct.test(segment) || possessive.test(segment)) return true;
  }
  const subject = `(?:item|record|row|task|${escapeRegExp(ITEM_ID)})`;
  return new RegExp(
    `^${prefix}(?:(?:the|this|that)\\s+)?${subject}\\s+(?:is|remains)\\s+(?:(?:currently|now)\\s+)?([^.!?\\n;,]+)[.!]?$`,
    'i',
  ).test(segment)
    || new RegExp(
      `^${prefix}(?:(?:the|this|that)\\s+)?${subject}\\s+(?:is\\s+)?titled\\s+([^.!?\\n;,]+)[.!]?$`,
      'i',
    ).test(segment);
}

export type ProviderEvidencePhase = 'snapshot' | 'cold' | 'reuse' | 'correction';

const PROOF_HISTORY_SOURCE_KEY = `${IDENTIFIER}\u0000${SOURCE_MARKER}`;

function proofHistorySnapshot(revision: number, status: string): ReadHistorySnapshot {
  return {
    sourceKey: PROOF_HISTORY_SOURCE_KEY,
    contentDigest: `${SOURCE_MARKER}\u0000${revision}\u0000${ITEM_ID}\u0000${ITEM_TITLE}\u0000${status.toLowerCase()}`,
    revision,
    count: 1,
    rows: [{ id: ITEM_ID, title: ITEM_TITLE, status }],
  };
}

/** This scenario owns an exact provider transition. Its phase selects only
 * history already established by the preceding scored turn; production uses
 * a durable receipt resolver instead of a phase label. */
function proofPriorHistorySnapshot(
  revision: number,
  status: string,
  phase: ProviderEvidencePhase,
): ReadHistorySnapshot | null {
  if (phase === 'reuse') return proofHistorySnapshot(revision, status);
  if (phase === 'correction' && revision === REVISION_TWO && status.toLowerCase() === 'done') {
    return proofHistorySnapshot(REVISION_ONE, 'open');
  }
  return null;
}

function neutralProviderNarrativeSegment(
  segment: string,
  revision: number,
  phase: ProviderEvidencePhase,
): boolean {
  const totalWithNoun = /^(?:[-*+]\s+)?total\s*:\s*(\d+)\s+(?:items?|records?|rows?|tasks?)[.!]?$/i.exec(segment);
  const totalLabel = /^(?:[-*+]\s+)?total\s+(?:items?|records?|rows?|tasks?)\s*:\s*(\d+)[.!]?$/i.exec(segment);
  if (totalWithNoun || totalLabel) return (totalWithNoun?.[1] ?? totalLabel?.[1]) === '1';
  const scopedHeading = /^here(?:'|’)s\s+the\s+(?:current\s+)?proof\s+release\s+queue(?:\s+result)?(?:\s*\(\s*(\d+)\s+items?\s*\))?\s*:$/i.exec(segment);
  if (scopedHeading) return scopedHeading[1] === undefined || scopedHeading[1] === '1';
  const navigationHeading = parseReadNavigationHeading(segment, 'proof release queue');
  if (navigationHeading) {
    if (navigationHeading.sameSource && phase !== 'reuse' && phase !== 'correction') return false;
    if (navigationHeading.changedState && (phase !== 'correction' || revision !== REVISION_TWO)) return false;
    return true;
  }
  return new RegExp(`^results?\\s+from\\s+${escapeRegExp(IDENTIFIER)}\\s*:$`, 'i').test(segment)
    || /^proof\s+release\s+queue\s*[—–-]\s*current\s+items\s*:\s*$/i.test(segment)
    || (phase === 'reuse' && revision === REVISION_ONE
      && /^pulled\s+fresh\s+from\s+the\s+same\s+connected\s+source\s+via\s+the\s+proven\s+capability[.!]?$/i.test(segment))
    || (phase === 'correction' && revision === REVISION_TWO
      && /^fresh\s+read\s+complete\s*[—–-]\s*the\s+provider\s+state\s+updated\s*:\s*$/i.test(segment))
    || /^read\s+fetched\s+fresh\s+via\s+the\s+authenticated\s+composio\s+cli[’']s\s+local\s+proof\s+provider\s*\(\s*no\s+account\s+selected\s*\)[.!]?$/i.test(segment)
    || new RegExp(`^retrieved\\s+via\\s+${escapeRegExp(IDENTIFIER)}\\s+on\\s+the\\s+local\\s+proof\\s+provider\\s*;\\s*no\\s+connected\\s+account\\s+was\\s+selected[.!]?$`, 'i').test(segment)
    || ((phase === 'reuse' || phase === 'correction') && /^refreshed\s+(?:the\s+)?proof\s+release\s+queue\s*:$/i.test(segment))
    || (phase === 'correction' && revision === REVISION_TWO && /^refreshed\s+(?:the\s+)?proof\s+release\s+queue\s*[—–-]\s*it\s+changed\s+since\s+last\s+check\s*:$/i.test(segment))
    || (phase === 'reuse' && revision === REVISION_ONE && /^queue\s+refreshed\s*[—–-]\s*unchanged\s+from\s+the\s+last\s+pull\s*:$/i.test(segment))
    || (phase === 'correction' && revision === REVISION_TWO && /^queue\s+refreshed\s*[—–-]\s*there(?:'|’)s\s+been\s+a\s+change\s+since\s+the\s+last\s+pull\s*:$/i.test(segment))
    || (phase === 'reuse' && revision === REVISION_ONE && /^refreshed\s*[—–-]\s*(?:the\s+)?queue\s+is\s+unchanged\s*:$/i.test(segment))
    || (phase === 'reuse' && revision === REVISION_ONE && /^no\s+changes\s+since\s+last\s+check[.!]?$/i.test(segment))
    || (phase === 'reuse' && revision === REVISION_ONE && /^unchanged\s+from\s+before[.!]?$/i.test(segment))
    || /^no\s+account\s+was\s+selected[.!]?$/i.test(segment)
    || (phase === 'reuse' && revision === REVISION_ONE && /^unchanged\s+since\s+(?:the\s+)?(?:last|previous)\s+read[.!]?$/i.test(segment))
    || /^that(?:'|’)s\s+the\s+only\s+current\s+(?:item|record|row|task)[.!]?$/i.test(segment);
}

function providerNarrativeSnapshotMatches(
  text: string,
  revision: number,
  status: string,
  phase: ProviderEvidencePhase,
): boolean {
  const expectedFields = [
    { aliases: ['source marker', 'source'], expected: SOURCE_MARKER },
    { aliases: ['revision'], expected: String(revision) },
    { aliases: ['item id', 'id', 'identifier'], expected: ITEM_ID },
    { aliases: ['title'], expected: ITEM_TITLE },
    { aliases: ['status', 'state'], expected: status },
  ] as const;
  const ownedBridgeLines = ownedCollectionTableBridgeLineIndexes(text, 1);
  const narrative = text.split(/\r?\n/)
    .filter((line, index) => !ownedBridgeLines.has(index)
      && !/^\s*\|.*\|\s*$/.test(line)
      && !strictSnapshotLineMatches(line, revision, status))
    .join('\n');
  const segments = narrative
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const plain = segment
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\bisn[’']t\b/gi, 'is not');
    let parsedAssertions = 0;
    let wholeSegmentOwned = false;

    const collectionSummary = parseCollectionStatusSummary(plain);
    if (collectionSummary) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if ((collectionSummary.continuity && phase !== 'reuse' && phase !== 'correction')
        || collectionSummary.count !== 1
        || (collectionSummary.status !== null
          && collectionSummary.status.toLowerCase() !== status.toLowerCase())
        || (collectionSummary.revision !== null
          && collectionSummary.revision !== revision)) return false;
    }

    const inlinePairs = inlineCurrentMetadataPairs(plain);
    for (const pair of inlinePairs) {
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      if (!exactProviderValue(pair.sourceMarker, SOURCE_MARKER)
        || pair.revision !== String(revision)) return false;
    }

    const oneItemSummary = /^(?:still\s+)?(?:one|1)\s+([A-Za-z0-9_-]+)\s+(?:item|record|row|task)(?:\s+in\s+(?:the\s+)?(?:queue|feed|list|snapshot))?,\s+at\s+revision\s+(\d+)[.!]?$/i.exec(plain);
    if (oneItemSummary) {
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      if (oneItemSummary[1]?.toLowerCase() !== status.toLowerCase()
        || oneItemSummary[2] !== String(revision)) return false;
    }

    const compactOneItemSummary = /^(?:still\s+)?(?:one|1)\s+([A-Za-z0-9_-]+)\s+(?:item|record|row|task)\s+in\s+(?:the\s+)?(?:queue|feed|list|snapshot)[.!]?$/i.exec(plain);
    if (compactOneItemSummary) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (compactOneItemSummary[1]?.toLowerCase() !== status.toLowerCase()) return false;
    }

    const unchangedFromPull = /^unchanged\s+from\s+(?:the\s+)?(?:last|previous)\s+(?:pull|read|check)\s*[—–-]\s*still\s+(one|zero|\d+)\s+(?:items?|records?|rows?|tasks?)(?:\s+total)?,\s*revision\s+(\d+)[.!]?$/i.exec(plain);
    if (unchangedFromPull) {
      if (phase !== 'reuse' || revision !== REVISION_ONE) return false;
      parsedAssertions += 3;
      wholeSegmentOwned = true;
      const count = /^(?:one)$/i.test(unchangedFromPull[1] ?? '')
        ? 1
        : /^(?:zero)$/i.test(unchangedFromPull[1] ?? '')
          ? 0
          : Number(unchangedFromPull[1]);
      if (count !== 1 || unchangedFromPull[2] !== String(revision)) return false;
    }

    const unchangedSnapshotSummary = /^still\s+(?:one|1)\s+(?:item|record|row|task),\s+unchanged\s+since\s+(?:the\s+)?(?:last|previous)\s+read\s*[—–-]\s*same\s+source\s+and\s+revision(?:\s+via\s+the\s+[A-Za-z0-9 _-]{1,80}\s+provider)?[.!]?$/i.test(plain);
    if (unchangedSnapshotSummary) {
      if (phase !== 'reuse' || revision !== REVISION_ONE) return false;
      parsedAssertions += 1;
      wholeSegmentOwned = true;
    }

    const compatibleStateRefreshHeading = /^(?:provider\s+)?state\s+has\s+(?:advanced|changed)\s*[—–-]\s*here(?:'|’)s\s+the\s+(?:current|fresh|latest|refreshed)\s+(?:queue|result|snapshot)\s*:$/i.test(plain);
    if (compatibleStateRefreshHeading) {
      if (phase !== 'correction' || revision !== REVISION_TWO) return false;
      parsedAssertions += 1;
      wholeSegmentOwned = true;
    }

    const rowOnlyStatusTransition = /^(?:the\s+)?(?:only\s+)?(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)(?:\s+since\s+(?:the\s+)?(?:last|previous)\s+read)?[.!]?$/i.exec(plain);
    if (rowOnlyStatusTransition) {
      if (phase !== 'correction' || revision !== REVISION_TWO) return false;
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (rowOnlyStatusTransition[2]?.toLowerCase() !== status.toLowerCase()) return false;
    }

    const itemThenRevisionSentence = /^(?:the\s+)?(?:single\s+|only\s+)?(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+),\s*and\s+the\s+revision\s+(?:bumped|advanced|changed|moved)\s+(?:from\s+)?(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+)[.!]?$/i.exec(plain);
    if (itemThenRevisionSentence) {
      if (phase !== 'correction' || revision !== REVISION_TWO) return false;
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      if (itemThenRevisionSentence[2]?.toLowerCase() !== status.toLowerCase()
        || itemThenRevisionSentence[4] !== String(revision)) return false;
    }

    const statusThenRevision = /^still\s+(?:one|1)\s+(?:item|record|row|task),\s+but\s+its\s+(?:current\s+)?(?:status|state)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)\s+and\s+the\s+revision\s+(?:advanced|changed|moved)\s+from\s+(?:revision\s+)?(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+)\s*[—–-]\s*the\s+provider\s+state\s+changed\s+since\s+(?:the\s+)?(?:last|previous)\s+read[.!]?$/i.exec(plain);
    const stateStatusThenRevision = /^the\s+state\s+changed\s+since\s+(?:the\s+)?(?:last|previous)\s+read\s*:\s*the\s+(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)\s*\(\s*revision\s+(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+)\s*\)[.!]?$/i.exec(plain);
    const revisionThenStatus = /^the\s+(?:queue|feed|list|snapshot)\s+(?:advanced|changed|moved)\s+from\s+revision\s+(\d+)\s+to\s+revision\s+(\d+),\s+and\s+the\s+(?:(?:single\s+)?item[’']s\s+)?(?:status|state)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s+to\s+([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
    const revisionThenItem = /^the\s+(?:queue|feed|list|snapshot)\s+(?:advanced|changed|moved)\s+from\s+revision\s+(\d+)\s*(?:→|->|to)\s*(\d+),\s+and\s+the\s+(?:single|only|one)\s+(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
    const itemThenRevisionAnnotation = /^the\s+(?:single\s+|only\s+)?(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)(?:\s+since\s+(?:the\s+)?(?:last|previous)\s+read)?\s*\(\s*revision\s+(?:bumped|advanced|changed|moved)\s+(\d+)\s*(?:→|->|to)\s*(\d+)\s*\)[.!]?$/i.exec(plain);
    const claudeStatusThenRevision = /^it(?:'|’)s\s+advanced\s+since\s+last\s+check\s*[—–-]\s*(?:status|state)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s+to\s+([A-Za-z0-9_-]+),\s+and\s+the\s+revision\s+(?:bumped|advanced|changed|moved)\s+to\s+(\d+)[.!]?$/i.exec(plain);
    if (statusThenRevision || stateStatusThenRevision || revisionThenStatus || revisionThenItem || itemThenRevisionAnnotation || claudeStatusThenRevision) {
      if (phase !== 'correction' || revision !== REVISION_TWO) return false;
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      const currentStatus = statusThenRevision?.[2]
        ?? stateStatusThenRevision?.[2]
        ?? revisionThenStatus?.[4]
        ?? revisionThenItem?.[4]
        ?? itemThenRevisionAnnotation?.[2]
        ?? claudeStatusThenRevision?.[2]
        ?? '';
      const currentRevision = statusThenRevision?.[4]
        ?? stateStatusThenRevision?.[4]
        ?? revisionThenStatus?.[2]
        ?? revisionThenItem?.[2]
        ?? itemThenRevisionAnnotation?.[4]
        ?? claudeStatusThenRevision?.[3]
        ?? '';
      if (currentStatus.toLowerCase() !== status.toLowerCase()
        || currentRevision !== String(revision)) return false;
    }

    const currentRevisionTarget = /^fresh\s+read\s*[—–-]\s*the\s+(?:queue|feed|list|snapshot)\s+(?:advanced|changed|moved)\s+to\s+revision\s+(\d+)\s*:$/i.exec(plain);
    if (currentRevisionTarget) {
      if (phase !== 'correction' || revision !== REVISION_TWO) return false;
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (currentRevisionTarget[1] !== String(revision)) return false;
    }

    const revisionStateChangeHeading = /^fresh\s+read\s*[—–-]\s*(?:the\s+)?queue\s+state\s+has\s+changed\s*\(\s*revision\s+(?:bumped|advanced|changed|moved)\s+(?:from\s+)?(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+)\s*\)\s*:$/i.exec(plain);
    if (revisionStateChangeHeading) {
      if (phase !== 'correction' || revision !== REVISION_TWO) return false;
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      if (revisionStateChangeHeading[2] !== String(revision)) return false;
    }

    const stateChangedStatus = /^state\s+changed\s+since\s+(?:the\s+)?(?:last|previous)\s+read\s*[—–-]\s*the\s+(?:item|record|row|task)\s+is\s+now\s+([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
    if (stateChangedStatus) {
      if (phase !== 'correction' || revision !== REVISION_TWO) return false;
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (stateChangedStatus[1]?.toLowerCase() !== status.toLowerCase()) return false;
    }

    const pronounStatus = /^(?:(?:actually|correction)\s*[:,]\s*)?(?:it|this|that)\s+(?:is|remains)\s+(?:(?:currently|now)\s+)?([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
    if (pronounStatus) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (pronounStatus[1]?.toLowerCase() !== status.toLowerCase()) return false;
    }

    for (const field of expectedFields) {
      for (const alias of field.aliases) {
        const escaped = escapeRegExp(alias).replace(/\s+/g, '\\s+');
        const patterns = [
          new RegExp(`(?<![A-Za-z0-9_-])(?:(?:the|this|that)\\s+)?(?:current|final|latest)?\\s*${escaped}(?![A-Za-z0-9_-])\\s*(?:is|remains|equals|=|:)\\s*([^.!?\\n;,]+)`, 'gi'),
          new RegExp(`(?<![A-Za-z0-9_-])(?:its|(?:(?:the|this|that)\\s+)?(?:item|record|row|task|${escapeRegExp(ITEM_ID)})[’']s)\\s+(?:current\\s+)?${escaped}(?![A-Za-z0-9_-])\\s*(?:is|remains|equals|=|:)\\s*([^.!?\\n;,]+)`, 'gi'),
        ];
        for (const pattern of patterns) {
          for (const match of plain.matchAll(pattern)) {
            parsedAssertions += 1;
            if (!exactProviderValue(match[1] ?? null, field.expected)) return false;
          }
        }
      }
    }

    const rowStatus = new RegExp(
      `(?<![A-Za-z0-9_-])(?:(?:the|this|that)\\s+)?(?:item|record|row|task|${escapeRegExp(ITEM_ID)})(?![A-Za-z0-9_-])\\s+(?:is|remains)\\s+(?:(?:currently|now)\\s+)?([^.!?\\n;,]+)`,
      'gi',
    );
    for (const match of plain.matchAll(rowStatus)) {
      parsedAssertions += 1;
      if (!exactProviderValue(match[1] ?? null, status)) return false;
    }
    const rowTitle = new RegExp(
      `(?<![A-Za-z0-9_-])(?:(?:the|this|that)\\s+)?(?:item|record|row|task|${escapeRegExp(ITEM_ID)})(?![A-Za-z0-9_-])\\s+(?:is\\s+)?titled\\s+([^.!?\\n;,]+)`,
      'gi',
    );
    for (const match of plain.matchAll(rowTitle)) {
      parsedAssertions += 1;
      if (!exactProviderValue(match[1] ?? null, ITEM_TITLE)) return false;
    }

    if (wholeSegmentExplicitProviderFieldClaim(plain)) wholeSegmentOwned = true;

    const hasFieldToken = expectedFields.some((field) => field.aliases.some((alias) => (
      new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(alias).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9_-])`, 'i').test(plain)
    )));
    const hasPresentAssertionShape = /\b(?:at\s+revision|current|currently|now|equals|has|is|lists?|remains|shows?|still|titled)\b|[:=]/i.test(plain);
    const transitionBearingAssertion = /\b(?:item|record|row|task|status|state|revision|queue|feed|list|snapshot)\b[^.!?\n]{0,180}\b(?:advanced|changed|flipped|moved)\b|\b(?:advanced|changed|flipped|moved)\b[^.!?\n]{0,180}\b(?:item|record|row|task|status|state|revision|queue|feed|list|snapshot)\b/i.test(plain);
    const neutralSegment = parsedAssertions === 0
      && neutralProviderNarrativeSegment(plain, revision, phase);
    if (((hasFieldToken && hasPresentAssertionShape) || transitionBearingAssertion)
      && parsedAssertions === 0
      && !neutralSegment) return false;
    if (parsedAssertions > 0 && !wholeSegmentOwned) return false;
    if (parsedAssertions === 0 && !neutralSegment) return false;
  }
  return true;
}

export function hasProviderEvidence(
  text: string,
  revision: number,
  status: string,
  phase: ProviderEvidencePhase = 'snapshot',
): boolean {
  if (presentationRequiresSemanticJudge(text)) return false;
  const history = validateReadHistoryClaims({
    text,
    current: proofHistorySnapshot(revision, status),
    prior: proofPriorHistorySnapshot(revision, status, phase),
  });
  if (history.decision !== 'certified') return false;
  const scoped = parseScopedProviderSnapshotBlocks(text);
  if (!scoped.valid
    || scoped.blocks.length > 1
    || (scoped.claimed && scoped.blocks.length !== 1)) return false;
  const scopedBlock = scoped.blocks[0] ?? null;
  const scopedBlockMatches = Boolean(scopedBlock
    && scopedBlock.scope === 'proof release queue'
    && scopedBlock.revision === String(revision)
    && exactProviderValue(scopedBlock.sourceMarker, SOURCE_MARKER)
    && exactProviderValue(scopedBlock.itemId, ITEM_ID)
    && exactProviderValue(scopedBlock.title, ITEM_TITLE)
    && currentScalar(scopedBlock.status)?.toLowerCase() === status.toLowerCase()
    && (scopedBlock.narrativeSuffixStatus === null
      || currentScalar(scopedBlock.narrativeSuffixStatus)?.toLowerCase() === status.toLowerCase()));
  if (scopedBlock && !scopedBlockMatches) return false;
  const parsingText = projectScopedProviderSnapshotNarrative(text, scoped.blocks);
  const parsedTables = parseAuthoritativeMarkdownTables(parsingText);
  if (!parsedTables.valid || (scopedBlock !== null && parsedTables.claimed)) return false;
  if (scopedBlock !== null) {
    const authority = authoritativePresentationLineMask(parsingText);
    if (parsingText.split(/\r?\n/).some((line, index) => (
      Boolean(authority[index]) && strictSnapshotLineMatches(line, revision, status)
    ))) return false;
  }
  const inline = inlineCurrentMetadataPairs(parsingText);
  if (inline.length > 1
    || (inline.length === 1
      && (!inlineCurrentMetadataPairOwnsItemTable(parsingText, inline[0]!)
        || (inline[0]!.scope !== null && inline[0]!.scope !== 'proof release queue')))) return false;
  const fullHorizontal = markdownTableFields(
    parsingText,
    ['Source marker', 'Revision', 'Item ID', 'Title', 'Status'],
  ) ?? markdownTableFields(parsingText, ['Source marker', 'Revision', 'Item', 'Title', 'Status']);
  const fullHorizontalMatches = exactProviderValue(fullHorizontal?.['source marker'] ?? null, SOURCE_MARKER)
    && currentScalar(fullHorizontal?.revision ?? null) === String(revision)
    && exactProviderValue(fullHorizontal?.['item id'] ?? fullHorizontal?.item ?? null, ITEM_ID)
    && exactProviderValue(fullHorizontal?.title ?? null, ITEM_TITLE)
    && currentScalar(fullHorizontal?.status ?? null)?.toLowerCase() === status.toLowerCase();

  const fullVertical = markdownKeyValueTableFields(
    parsingText,
    ['Source marker', 'Revision', 'Item id', 'Title', 'Status'],
  );
  const fullVerticalMatches = exactProviderValue(fullVertical?.['source marker'] ?? null, SOURCE_MARKER)
    && currentScalar(fullVertical?.revision ?? null) === String(revision)
    && exactProviderValue(fullVertical?.['item id'] ?? null, ITEM_ID)
    && exactProviderValue(fullVertical?.title ?? null, ITEM_TITLE)
    && currentScalar(fullVertical?.status ?? null)?.toLowerCase() === status.toLowerCase();

  const split = markdownSplitProviderFields(parsingText);
  const splitTablesMatch = currentScalar(split?.revision ?? null) === String(revision)
    && exactProviderValue(split?.itemId ?? null, ITEM_ID)
    && exactProviderValue(split?.title ?? null, ITEM_TITLE)
    && currentScalar(split?.status ?? null)?.toLowerCase() === status.toLowerCase();

  const labeledMetadata = metadataLabelsMatch(parsingText, revision);
  const completeItemSnapshot = horizontalItemTableMatches(parsingText, status)
    || itemLabelsMatch(parsingText, status);
  const evidenceShapeCount = [
    fullHorizontalMatches,
    fullVerticalMatches,
    splitTablesMatch,
    labeledMetadata && completeItemSnapshot,
    scopedBlockMatches,
  ].filter(Boolean).length;
  return structuredProviderAssertionsMatch(parsingText, revision, status)
    && !contradictoryNarrativeItemStatus(parsingText, status)
    && providerNarrativeSnapshotMatches(parsingText, revision, status, phase)
    && evidenceShapeCount === 1;
}

interface FileSnapshot {
  existed: boolean;
  content: Buffer | null;
}

function snapshotFile(file: string): FileSnapshot {
  return existsSync(file)
    ? { existed: true, content: readFileSync(file) }
    : { existed: false, content: null };
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (snapshot.existed && snapshot.content) writeFileSync(file, snapshot.content);
  else rmSync(file, { force: true });
}

function exactModelTurnChecks(label: string, turn: AcceptedTurnMeasurement): Check[] {
  return [
    {
      name: `${label}: exactly one brain route`,
      pass: turn.exactModelRouteEvents === 1 && turn.modelRouteEvents === 1,
      detail: `exact=${turn.exactModelRouteEvents}, total=${turn.modelRouteEvents}`,
    },
    {
      name: `${label}: model usage is exact-turn certified`,
      pass: turn.exactUsageRecords >= 1 && turn.usageAttributionCertified,
      detail: `exact=${turn.exactUsageRecords}, attribution=${turn.usageAttribution}, issues=${turn.usageCertificationIssues.join(',') || 'none'}`,
    },
  ];
}

export const discoveryReuseHorizon: ScenarioDef = {
  name: 'discovery-reuse-horizon',
  summary: 'cold discovery → verified learning → zero rediscovery → explicit restart answer replay → fresh correction',
  routeExpectation: 'exact-brain',
  expectedModelTurns: 3,
  async run(daemon: DaemonHandle, context?: { brain: BrainKind }) {
    if (!context) throw new Error('discovery horizon requires the explicitly selected proof brain');
    const { brain } = context;
    const suffix = Date.now().toString(36);
    const coldSessionId = `proof-discovery-cold-${suffix}`;
    const learnedSessionId = `proof-discovery-learned-${suffix}`;
    const connectionMarker = path.join(daemon.home, 'proof-composio-connected');
    const providerState = path.join(daemon.home, 'proof-task-feed-state.json');
    const connectionBefore = snapshotFile(connectionMarker);
    const providerStateBefore = snapshotFile(providerState);
    const searchBaseline = lines(daemon.home, 'proof-composio-searches.log').length;
    const dispatchBaseline = lines(daemon.home, 'proof-composio-dispatches.log').length;
    const payloadBaseline = providerCalls(daemon.home, 'proof-composio-payloads.log').length;
    const successBaseline = providerCalls(daemon.home, 'proof-composio-successes.log').length;
    writeFileSync(connectionMarker, 'connected\n', 'utf8');
    writeFileSync(providerState, `${JSON.stringify({
      revision: REVISION_ONE,
      id: 'proof-release-1',
      title: 'Review the Clementine 4 release proof',
      status: 'open',
    }, null, 2)}\n`, 'utf8');
    const refreshed = await daemon.request('POST', '/api/composio/refresh', {});

    try {
      const cold = await daemon.chat([
        'Proof release queue current items — cold learning check.',
        'Retrieve the current item feed from the connected local provider. You do not know the action identifier yet.',
        'Call composio_search_tools exactly once with query "proof release queue current items". Choose its single read-only match, then call composio_execute_tool exactly once with that action and the empty argument object {}.',
        'Do not use any other discovery, code mode, shell, workspace tool, or memory. Do not ask a question.',
        'Return the source marker, revision, item id, title, and status.',
      ].join('\n'), coldSessionId, 300_000);
      const coldSeq = acceptedSourceSeq(daemon.home, cold.sessionId);
      const learned = await waitForLearnedCapability(daemon.home, cold.sessionId, coldSeq);
      // A new process and a new chat session eliminate conversation history
      // and process caches as explanations for the next zero-discovery turn.
      await daemon.restart();

      const reuse = await daemon.chat([
        'Refresh the proof release queue current items from the same connected source.',
        'Reuse the capability already proved on this machine. Do not discover, inspect a contract, use code mode, shell, workspace, or memory.',
        'Return the source marker, revision, item id, title, and status.',
      ].join('\n'), learnedSessionId, 300_000);
      const reuseSeq = acceptedSourceSeq(daemon.home, reuse.sessionId);

      await daemon.restart();
      writeFileSync(providerState, `${JSON.stringify({
        revision: REVISION_TWO,
        id: 'proof-release-1',
        title: 'Review the Clementine 4 release proof',
        status: 'done',
      }, null, 2)}\n`, 'utf8');
      const dispatchesBeforeReplay = lines(daemon.home, 'proof-composio-dispatches.log').length;

      const replay = await daemon.acceptedChat('Repeat the last answer.', learnedSessionId, 120_000);
      if (!replay.sourceUserSeq) throw new Error('durable answer-replay receipt did not resolve its exact accepted source');
      const replaySeq = replay.sourceUserSeq;
      const dispatchesAfterReplay = lines(daemon.home, 'proof-composio-dispatches.log').length;

      const correction = await daemon.chat([
        'Correction: refresh the proof release queue current items now.',
        'The provider state changed after the prior answer, so perform a fresh read with the capability already proved.',
        'Do not replay the earlier result and do not discover anything.',
        'Return the source marker, revision, item id, title, and status.',
      ].join('\n'), learnedSessionId, 300_000);
      const correctionSeq = acceptedSourceSeq(daemon.home, correction.sessionId);

      const coldMeasure = measureAcceptedTurn(daemon.home, coldSessionId, coldSeq);
      const reuseMeasure = measureAcceptedTurn(daemon.home, learnedSessionId, reuseSeq);
      const replayMeasure = measureAcceptedTurn(daemon.home, learnedSessionId, replaySeq);
      const correctionMeasure = measureAcceptedTurn(daemon.home, learnedSessionId, correctionSeq);
      const coldTerminal = terminalConversationSurface(daemon.home, coldSessionId, coldSeq);
      const reuseTerminal = terminalConversationSurface(daemon.home, learnedSessionId, reuseSeq);
      const correctionTerminal = terminalConversationSurface(daemon.home, learnedSessionId, correctionSeq);
      const searches = lines(daemon.home, 'proof-composio-searches.log').slice(searchBaseline);
      const dispatches = lines(daemon.home, 'proof-composio-dispatches.log').slice(dispatchBaseline);
      const payloads = providerCalls(daemon.home, 'proof-composio-payloads.log').slice(payloadBaseline);
      const successes = providerCalls(daemon.home, 'proof-composio-successes.log').slice(successBaseline);

      const checks: Check[] = [
        { name: 'proof-only CLI provider connected', pass: refreshed.status === 200, detail: `status ${refreshed.status}` },
        { name: 'synchronous cold, reuse, and correction turns returned HTTP 200', pass: [cold, reuse, correction].every((turn) => turn.httpStatus === 200), detail: [cold, reuse, correction].map((turn) => turn.httpStatus).join(',') },
        { name: 'explicit restart answer replay used the durable accepted ingress', pass: replay.httpStatus === 202, detail: `status ${replay.httpStatus}, source ${replaySeq}` },
        reportBackCheck(cold.text),
        reportBackCheck(reuse.text),
        reportBackCheck(correction.text),
        narrationCheck(cold.text),
        narrationCheck(reuse.text),
        narrationCheck(correction.text),
        {
          name: 'cold read kept terminal, presentation, and delivered conversation bytes identical',
          pass: terminalConversationSurfacesPreserveBytes({ terminal: coldTerminal, deliveredText: cold.text }),
          detail: conversationSurfaceDetail(coldTerminal, cold.text),
        },
        {
          name: 'learned read kept terminal, presentation, and delivered conversation bytes identical',
          pass: terminalConversationSurfacesPreserveBytes({ terminal: reuseTerminal, deliveredText: reuse.text }),
          detail: conversationSurfaceDetail(reuseTerminal, reuse.text),
        },
        {
          name: 'correction kept terminal, presentation, and delivered conversation bytes identical',
          pass: terminalConversationSurfacesPreserveBytes({ terminal: correctionTerminal, deliveredText: correction.text }),
          detail: conversationSurfaceDetail(correctionTerminal, correction.text),
        },
        ...verifiedReadOptimizationChecks(
          'cold read',
          coldTerminal,
          cold.text,
          coldSeq,
          brain,
          'read_discovery_scaffold',
        ),
        ...verifiedReadOptimizationChecks(
          'learned read',
          reuseTerminal,
          reuse.text,
          reuseSeq,
          brain,
          'single_collection_read',
        ),
        ...verifiedReadOptimizationChecks(
          'correction',
          correctionTerminal,
          correction.text,
          correctionSeq,
          brain,
          'single_collection_read',
        ),
        stormCheck(daemon.log()),
        {
          name: 'cold read returned revision-1 provider evidence',
          pass: hasProviderEvidence(cold.text, REVISION_ONE, 'open', 'cold'),
          detail: cold.text.slice(0, 260),
        },
        {
          name: 'verified cold settlement materialized reusable capability memory',
          pass: learned,
          detail: learned ? IDENTIFIER : 'learning artifact did not materialize within 20s',
        },
        {
          name: 'cold task admitted exactly one successful broad discovery',
          pass: coldMeasure.governorKnownCapability === false
            && coldMeasure.discoveryClaimsByCategory.broad_discovery === 1
            && coldMeasure.discoveryClaimsByOutcome.succeeded === 1
            && coldMeasure.discoveryOperations === 1,
          detail: JSON.stringify({
            known: coldMeasure.governorKnownCapability,
            claims: coldMeasure.discoveryClaimsByCategory,
            outcomes: coldMeasure.discoveryClaimsByOutcome,
            operations: coldMeasure.discoveryOperations,
          }),
        },
        ...exactModelTurnChecks('cold', coldMeasure),
        {
          name: 'cold turn used only one search and one business read',
          pass: exactToolShape(coldMeasure, { composio_search_tools: 1, [IDENTIFIER]: 1 }),
          detail: JSON.stringify({ total: coldMeasure.canonicalTopLevelToolCalls, calls: coldMeasure.perTool }),
        },
        {
          name: 'learned turn resolved capability before the brain and paid zero discovery',
          pass: reuseMeasure.governorKnownCapability === true
            && reuseMeasure.discoveryOperations === 0
            && (reuseMeasure.discoveryClaimsByCategory.broad_discovery ?? 0) === 0,
          detail: JSON.stringify({ known: reuseMeasure.governorKnownCapability, discovery: reuseMeasure.discoveryOperations, claims: reuseMeasure.discoveryClaimsByCategory }),
        },
        {
          name: 'learned turn performed exactly one fresh business read',
          pass: reuseMeasure.perTool[IDENTIFIER] === 1
            && hasProviderEvidence(reuse.text, REVISION_ONE, 'open', 'reuse'),
          detail: JSON.stringify({ calls: reuseMeasure.perTool, text: reuse.text.slice(0, 180) }),
        },
        ...exactModelTurnChecks('learned reuse', reuseMeasure),
        {
          name: 'learned turn eliminated discovery without adding compensating tool work',
          pass: exactToolShape(reuseMeasure, { [IDENTIFIER]: 1 })
            && reuseMeasure.canonicalTopLevelToolCalls < coldMeasure.canonicalTopLevelToolCalls,
          detail: JSON.stringify({ cold: coldMeasure.perTool, learned: reuseMeasure.perTool }),
        },
        {
          name: 'explicit restart request replayed the exact completed answer',
          pass: replay.text.trim() === reuse.text.trim()
            && replayMeasure.terminalTransport === 'completed_answer_replay'
            && replayMeasure.terminalSteps === 0,
          detail: `transport=${replayMeasure.terminalTransport}, steps=${replayMeasure.terminalSteps}`,
        },
        {
          name: 'explicit restart answer replay did zero model, token, tool, and discovery work',
          pass: replayMeasure.modelRouteEvents === 0
            && replayMeasure.usageRecords === 0
            && replayMeasure.canonicalTopLevelToolCalls === 0
            && replayMeasure.discoveryOperations === 0
            && replayMeasure.governorKnownCapability === null
            && dispatchesAfterReplay === dispatchesBeforeReplay
            && replayMeasure.usageAttributionCertified,
          detail: JSON.stringify({
            routes: replayMeasure.modelRouteEvents,
            usage: replayMeasure.usageRecords,
            tools: replayMeasure.canonicalTopLevelToolCalls,
            discovery: replayMeasure.discoveryOperations,
            providerDispatchDelta: dispatchesAfterReplay - dispatchesBeforeReplay,
            usageIssues: replayMeasure.usageCertificationIssues,
          }),
        },
        {
          name: 'substantive correction bypassed replay and returned changed provider evidence',
          pass: correctionMeasure.terminalTransport !== 'completed_answer_replay'
            && hasProviderEvidence(correction.text, REVISION_TWO, 'done', 'correction')
            && correction.text.trim() !== replay.text.trim(),
          detail: correction.text.slice(0, 260),
        },
        {
          name: 'correction reused learned capability with zero rediscovery and one read',
          pass: correctionMeasure.governorKnownCapability === true
            && correctionMeasure.discoveryOperations === 0
            && correctionMeasure.perTool[IDENTIFIER] === 1,
          detail: JSON.stringify({ known: correctionMeasure.governorKnownCapability, discovery: correctionMeasure.discoveryOperations, calls: correctionMeasure.perTool }),
        },
        ...exactModelTurnChecks('correction', correctionMeasure),
        {
          name: 'correction used only the learned business read',
          pass: exactToolShape(correctionMeasure, { [IDENTIFIER]: 1 }),
          detail: JSON.stringify({ total: correctionMeasure.canonicalTopLevelToolCalls, calls: correctionMeasure.perTool }),
        },
        {
          name: 'whole horizon paid one physical search and exactly three valid successful business reads',
          pass: searches.length === 1
            && dispatches.length === 3
            && dispatches.every((slug) => slug === IDENTIFIER)
            && payloads.length === 3
            && payloads.every((call) => call.slug === IDENTIFIER && call.payload === '{}')
            && successes.length === 3
            && successes.every((call) => call.slug === IDENTIFIER && call.payload === '{}'),
          detail: JSON.stringify({ searches: searches.length, dispatches, payloads, successes }),
        },
      ];

      return {
        checks,
        latency: [cold, reuse, replay, correction].map((turn) => ({ wallMs: turn.wallMs, ttftMs: null })),
        sessionId: learnedSessionId,
        routeSessions: [
          { sessionId: coldSessionId, expectedModelTurns: 1 },
          { sessionId: learnedSessionId, expectedModelTurns: 2 },
        ],
        metrics: {
          cold: coldMeasure,
          learnedReuse: reuseMeasure,
          restartReplay: replayMeasure,
          correction: correctionMeasure,
          physicalSearches: searches.length,
          providerDispatches: dispatches.length,
          providerSuccesses: successes.length,
          efficiencyDelta: {
            discoveryOperationsSavedOnLearnedReuse: coldMeasure.discoveryOperations - reuseMeasure.discoveryOperations,
            canonicalToolCallsSavedOnLearnedReuse: coldMeasure.canonicalTopLevelToolCalls - reuseMeasure.canonicalTopLevelToolCalls,
            promptTokensCold: coldMeasure.promptTokens,
            promptTokensLearnedReuse: reuseMeasure.promptTokens,
            uncachedInputTokensCold: coldMeasure.uncachedInputTokens,
            uncachedInputTokensLearnedReuse: reuseMeasure.uncachedInputTokens,
            outputTokensCold: coldMeasure.outputTokens,
            outputTokensLearnedReuse: reuseMeasure.outputTokens,
            sdkDurationMsCold: coldMeasure.sdkDurationMs,
            sdkDurationMsLearnedReuse: reuseMeasure.sdkDurationMs,
            turnWallMsCold: coldMeasure.turnWallMs,
            turnWallMsLearnedReuse: reuseMeasure.turnWallMs,
            restartReplaySavedModelCalls: reuseMeasure.usageRecords - replayMeasure.usageRecords,
            restartReplaySavedToolCalls: reuseMeasure.canonicalTopLevelToolCalls - replayMeasure.canonicalTopLevelToolCalls,
          },
        },
      };
    } finally {
      restoreFile(connectionMarker, connectionBefore);
      restoreFile(providerState, providerStateBefore);
      try { await daemon.request('POST', '/api/composio/refresh', {}); } catch { /* best-effort scenario isolation */ }
    }
  },
};
