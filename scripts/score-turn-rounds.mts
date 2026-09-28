#!/usr/bin/env node
/**
 * Per-round score for one accepted source, read-only.
 *
 *   node --import tsx scripts/score-turn-rounds.mts --session <id> --seq <n|latest>
 *     [--home /abs/clem-home] [--json]
 *
 * One accepted turn is recorded in three stores that never share a key:
 *   - `model_request_provenance`: one row per provider request, with a
 *     request ordinal and the exact byte size of every prompt layer;
 *   - `prompt_composition` events: one per host model call, in seq order,
 *     with estimated token buckets and per-tool schema costs;
 *   - the token-usage ledger: provider tokens, served model, duration and
 *     first-token time per call, joined by `trace.acceptedSource`.
 * This scorer aligns them by order within the accepted source and reports
 * per-round and per-turn totals, plus the router (Jev) rows, the reviewer
 * rows, the recorded completion verdicts and the owned terminal.
 *
 * Nothing here opens a store for writing: SQLite is opened `readonly` with
 * `query_only`, and the ledger is read as plain NDJSON. A measurement must
 * never create, migrate or append to the home it measures.
 *
 * Nested calls made inside a brain round inherit the brain role and the
 * parent's prompt components through the attribution scope. They are not
 * brain rounds: a brain row whose components exceed twice its own provider
 * prompt is reported under `nestedExcluded`, never as a round.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

export const PROMPT_LAYERS = [
  'transport',
  'stablePolicy',
  'turnContext',
  'memoryContext',
  'catalog',
  'task',
] as const;
export type PromptLayer = (typeof PROMPT_LAYERS)[number];

/** Inherited components larger than this multiple of the row's own prompt
 *  mark a nested call that borrowed the parent's attribution. A brain round's
 *  own components track its provider prompt within the estimator's error
 *  (under 1.2x); a nested call carries a whole parent prompt (5x and more). */
const NESTED_COMPONENT_RATIO = 2;

interface LedgerRow {
  at: string;
  source?: string;
  kind?: string;
  model?: string;
  role?: string;
  roleReason?: string;
  channel?: string;
  ok?: boolean;
  failReason?: string;
  cacheDialect?: string;
  trace?: { acceptedSource?: string; logicalTurnId?: string; attemptId?: string; modelCallId?: string };
  canonical?: { certified?: boolean; promptTokens?: number; cachedReadTokens?: number; uncachedInputTokens?: number };
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  firstTokenMs?: number;
  reasoningEffort?: string;
  promptComponents?: Record<string, number>;
}

export interface LedgerCall {
  at: string;
  model: string | null;
  role: string | null;
  channel: string | null;
  ok: boolean;
  failReason: string | null;
  promptTokens: number;
  cachedTokens: number;
  uncachedTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  reasoningEffort: string | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  promptComponents: Record<string, number> | null;
}

export interface RoundScore {
  round: number;
  /** Provenance row (host lane). Null when this round has no provenance. */
  provenance: {
    requestOrdinal: number;
    createdAt: string;
    layerBytes: Record<PromptLayer, number>;
    totalBytes: number;
    /** Tool names whose schemas were on this request's wire, in wire order. */
    wireTools: string[];
    normalizedRequestDigest: string;
  } | null;
  /** The matching `prompt_composition` event (estimated tokens). */
  composition: {
    seq: number;
    totalTokens: number;
    buckets: Record<string, number>;
    bucketBytes: Record<string, number>;
    toolCount: number;
    toolSchemaCosts: Array<{ name: string; tokens: number; bytes: number; deferred: boolean }>;
  } | null;
  /** The matching brain ledger row (provider truth). */
  ledger: LedgerCall | null;
}

export type JevArm = 'jev_answered' | 'jev_unavailable' | 'jev_not_called';

export interface TurnRoundsScore {
  home: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedSource: string;
  sourceAt: string;
  terminal: {
    seq: number;
    at: string;
    status: string | null;
    kind: string | null;
    replyChars: number | null;
  } | null;
  rounds: RoundScore[];
  counts: {
    provenanceRequests: number;
    compositionEvents: number;
    brainLedgerRows: number;
    nestedExcluded: number;
  };
  /** Differences between the three stores' round counts; empty when aligned. */
  alignmentIssues: string[];
  round1: {
    layerBytes: Record<PromptLayer, number> | null;
    totalBytes: number | null;
    bucketTokens: Record<string, number> | null;
    compositionTokens: number | null;
    wireTools: string[];
    providerPromptTokens: number | null;
    providerUncachedTokens: number | null;
  };
  totals: {
    rounds: number;
    requestBytes: number;
    brainPromptTokens: number;
    brainCachedTokens: number;
    brainUncachedTokens: number;
    brainOutputTokens: number;
    brainReasoningTokens: number;
    brainSeconds: number;
    wallSeconds: number | null;
    servedBrainModels: string[];
  };
  topLevelToolCalls: Array<{ seq: number; at: string; tool: string; effectiveTool: string | null }>;
  jev: {
    arm: JevArm;
    calls: LedgerCall[];
    seconds: number;
  };
  reviewer: {
    calls: LedgerCall[];
    promptTokens: number;
    uncachedTokens: number;
    seconds: number;
    verdicts: Array<ReturnType<typeof projectReviewVerdict>>;
  };
  other: LedgerCall[];
  nestedExcluded: LedgerCall[];
  routedModel: string | null;
}

/** A delivered fail-open answer is not a successful independent review. */
export function projectReviewVerdict(seq: number, data: Record<string, unknown>) {
  const failedOpen = data.failedOpen === true;
  const reportedFulfills = typeof data.fulfills === 'boolean' ? data.fulfills : null;
  return {
    seq,
    kind: typeof data.kind === 'string' ? data.kind : null,
    fulfills: failedOpen ? null : reportedFulfills,
    reportedFulfills,
    failedOpen,
    carriedVerdict: data.carriedVerdict === true,
    reviewFailure: typeof data.reviewFailure === 'string' ? data.reviewFailure : null,
    reviewDepth: typeof data.reviewDepth === 'string' ? data.reviewDepth : null,
    judgeModelId: typeof data.judgeModelId === 'string' ? data.judgeModelId : null,
  };
}

function openReadOnly(home: string): Database.Database {
  const dbPath = path.join(home, 'state', 'harness.db');
  if (!existsSync(dbPath)) throw new Error(`Harness event log not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  db.pragma('query_only = ON');
  return db;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return parseObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ledgerCall(row: LedgerRow): LedgerCall {
  const input = finite(row.inputTokens) ?? 0;
  const cached = finite(row.cachedInputTokens) ?? 0;
  const prompt = finite(row.canonical?.promptTokens) ?? input;
  const cachedTokens = finite(row.canonical?.cachedReadTokens) ?? cached;
  const uncached = finite(row.canonical?.uncachedInputTokens) ?? Math.max(0, prompt - cachedTokens);
  return {
    at: row.at,
    model: row.model ?? null,
    role: row.role ?? null,
    channel: row.channel ?? null,
    ok: row.ok !== false,
    failReason: row.failReason ?? null,
    promptTokens: prompt,
    cachedTokens,
    uncachedTokens: uncached,
    outputTokens: finite(row.outputTokens) ?? 0,
    reasoningTokens: finite(row.reasoningTokens),
    reasoningEffort: row.reasoningEffort ?? null,
    durationMs: finite(row.durationMs),
    firstTokenMs: finite(row.firstTokenMs),
    promptComponents: row.promptComponents ?? null,
  };
}

function isNestedInheritedBrainRow(row: LedgerRow): boolean {
  const components = row.promptComponents;
  if (!components) return false;
  const inherited = Object.values(components)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
  const own = finite(row.inputTokens) ?? 0;
  return inherited > NESTED_COMPONENT_RATIO * own;
}

function utcDay(iso: string, offsetDays: number): string {
  const at = Date.parse(iso);
  return new Date(at + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function readLedgerForSource(home: string, acceptedSource: string, fromIso: string, toIso: string): LedgerRow[] {
  const usageDir = path.join(home, 'state', 'token-usage');
  if (!existsSync(usageDir)) return [];
  const first = utcDay(fromIso, -1);
  const last = utcDay(toIso, 1);
  const rows: LedgerRow[] = [];
  for (const name of readdirSync(usageDir).filter((file) => file.endsWith('.ndjson')).sort()) {
    const day = name.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && (day < first || day > last)) continue;
    for (const line of readFileSync(path.join(usageDir, name), 'utf8').split('\n')) {
      if (!line.includes(acceptedSource)) continue;
      try {
        const row = JSON.parse(line) as LedgerRow;
        if (row.trace?.acceptedSource === acceptedSource) rows.push(row);
      } catch {
        // A torn trailing line is not this source's evidence.
      }
    }
  }
  return rows.sort((left, right) => left.at.localeCompare(right.at));
}

export function latestAcceptedSourceSeq(home: string, sessionId: string): number {
  const db = openReadOnly(home);
  try {
    const row = db.prepare(`
      SELECT source.seq AS seq
        FROM events source
       WHERE source.session_id = ?
         AND source.type = 'user_input_received'
         AND source.role = 'user'
         AND COALESCE(json_extract(source.data_json, '$.synthetic'), 0) != 1
         AND EXISTS (
           SELECT 1 FROM events terminal
            WHERE terminal.session_id = source.session_id
              AND terminal.type = 'conversation_completed'
              AND terminal.seq > source.seq
              AND COALESCE(
                json_extract(terminal.data_json, '$.presentation.identity.sourceUserSeq'),
                json_extract(terminal.data_json, '$.sourceUserSeq')
              ) = source.seq)
       ORDER BY source.seq DESC
       LIMIT 1
    `).get(sessionId) as { seq: number } | undefined;
    if (!row) throw new Error(`No accepted source with an owned terminal in session ${sessionId}`);
    return row.seq;
  } finally {
    db.close();
  }
}

/**
 * Score one accepted source round by round. Read-only; see the file header.
 */
export function scoreAcceptedTurnRounds(
  home: string,
  sessionId: string,
  sourceUserSeq: number,
): TurnRoundsScore {
  if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) {
    throw new Error('sourceUserSeq must be a positive event sequence');
  }
  const acceptedSource = `${sessionId}:${sourceUserSeq}`;
  const db = openReadOnly(home);
  let sourceAt: string;
  let terminal: TurnRoundsScore['terminal'] = null;
  let provenanceRows: Array<{ request_ordinal: number; created_at: string; normalized_request_digest: string; provenance_json: string }>;
  let compositionRows: Array<{ seq: number; data_json: string }>;
  let verdictRows: Array<{ seq: number; data_json: string }>;
  let toolRows: Array<{ seq: number; created_at: string; data_json: string }>;
  let routedModel: string | null = null;
  try {
    const source = db.prepare(`
      SELECT seq, type, role, created_at, data_json FROM events
       WHERE session_id = ? AND seq = ?
    `).get(sessionId, sourceUserSeq) as { seq: number; type: string; role: string; created_at: string; data_json: string } | undefined;
    if (!source) throw new Error(`No event ${sourceUserSeq} in session ${sessionId}`);
    if (source.type !== 'user_input_received' || source.role !== 'user') {
      throw new Error(`${acceptedSource} is not an accepted user input`);
    }
    sourceAt = source.created_at;

    const owned = (data: Record<string, unknown> | null): boolean => {
      if (!data) return false;
      const presentation = parseObject(data.presentation);
      const identity = parseObject(presentation?.identity);
      return identity?.sourceUserSeq === sourceUserSeq || data.sourceUserSeq === sourceUserSeq;
    };

    const tail = db.prepare(`
      SELECT seq, type, created_at, data_json FROM events
       WHERE session_id = ? AND seq > ?
         AND type IN ('conversation_completed', 'prompt_composition', 'goal_alignment_judged',
                      'turn_model_routed', 'tool_called')
       ORDER BY seq ASC
    `).all(sessionId, sourceUserSeq) as Array<{ seq: number; type: string; created_at: string; data_json: string }>;
    compositionRows = [];
    verdictRows = [];
    toolRows = [];
    for (const row of tail) {
      const data = parseObject(row.data_json);
      if (row.type === 'conversation_completed') {
        if (!terminal && owned(data)) {
          const presentation = parseObject(data?.presentation);
          const outcome = parseObject(data?.turnOutcome);
          const status = [presentation?.status, outcome?.status, data?.status]
            .find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
          const text = typeof presentation?.text === 'string' ? presentation.text : null;
          terminal = {
            seq: row.seq,
            at: row.created_at,
            status,
            kind: typeof presentation?.kind === 'string' ? presentation.kind : null,
            replyChars: text === null ? null : text.length,
          };
        }
        continue;
      }
      if (data?.sourceUserSeq !== sourceUserSeq) continue;
      if (row.type === 'prompt_composition') compositionRows.push(row);
      else if (row.type === 'goal_alignment_judged') verdictRows.push(row);
      else if (row.type === 'turn_model_routed' && routedModel === null && typeof data?.model === 'string') routedModel = data.model;
      else if (row.type === 'tool_called' && data?.accounting === 'top_level') toolRows.push(row);
    }

    provenanceRows = db.prepare(`
      SELECT request_ordinal, created_at, normalized_request_digest, provenance_json
        FROM model_request_provenance
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY request_ordinal ASC
    `).all(sessionId, sourceUserSeq) as typeof provenanceRows;
  } finally {
    db.close();
  }

  const ledgerRows = readLedgerForSource(home, acceptedSource, sourceAt, (terminal as TurnRoundsScore['terminal'])?.at ?? sourceAt);
  const brainRows: LedgerRow[] = [];
  const nestedExcluded: LedgerCall[] = [];
  const jevCalls: LedgerCall[] = [];
  const reviewerCalls: LedgerCall[] = [];
  const other: LedgerCall[] = [];
  for (const row of ledgerRows) {
    if (row.role === 'brain') {
      if (isNestedInheritedBrainRow(row)) nestedExcluded.push(ledgerCall(row));
      else brainRows.push(row);
    } else if (row.role === 'router' && typeof row.channel === 'string' && row.channel.startsWith('jev-')) {
      jevCalls.push(ledgerCall(row));
    } else if (row.role === 'reviewer') {
      reviewerCalls.push(ledgerCall(row));
    } else {
      other.push(ledgerCall(row));
    }
  }

  const roundCount = Math.max(provenanceRows.length, compositionRows.length, brainRows.length);
  const rounds: RoundScore[] = [];
  for (let index = 0; index < roundCount; index += 1) {
    const provenanceRow = provenanceRows[index];
    const compositionRow = compositionRows[index];
    const brainRow = brainRows[index];
    let provenance: RoundScore['provenance'] = null;
    if (provenanceRow) {
      const parsed = parseObject(provenanceRow.provenance_json) ?? {};
      const layers = parseObject(parsed.layers) ?? {};
      const layerBytes = Object.fromEntries(PROMPT_LAYERS.map((layer) => [
        layer,
        finite(parseObject(layers[layer])?.bytes) ?? 0,
      ])) as Record<PromptLayer, number>;
      const toolSchemas = parseObject(parsed.toolSchemas);
      const digests = Array.isArray(toolSchemas?.schemaDigests) ? toolSchemas.schemaDigests : [];
      provenance = {
        requestOrdinal: provenanceRow.request_ordinal,
        createdAt: provenanceRow.created_at,
        layerBytes,
        totalBytes: PROMPT_LAYERS.reduce((sum, layer) => sum + layerBytes[layer], 0),
        wireTools: digests
          .map((entry) => parseObject(entry)?.name)
          .filter((name): name is string => typeof name === 'string'),
        normalizedRequestDigest: provenanceRow.normalized_request_digest,
      };
    }
    let composition: RoundScore['composition'] = null;
    if (compositionRow) {
      const data = parseObject(compositionRow.data_json) ?? {};
      const buckets: Record<string, number> = {};
      const bucketBytes: Record<string, number> = {};
      for (const bucket of Array.isArray(data.buckets) ? data.buckets : []) {
        const entry = parseObject(bucket);
        if (typeof entry?.name !== 'string') continue;
        buckets[entry.name] = finite(entry.tokens) ?? 0;
        const bytes = finite(entry.bytes);
        if (bytes !== null) bucketBytes[entry.name] = bytes;
      }
      composition = {
        seq: compositionRow.seq,
        totalTokens: finite(data.totalTokens) ?? 0,
        buckets,
        bucketBytes,
        toolCount: finite(data.toolCount) ?? 0,
        toolSchemaCosts: (Array.isArray(data.toolSchemaCosts) ? data.toolSchemaCosts : [])
          .map((cost) => parseObject(cost))
          .filter((cost): cost is Record<string, unknown> => typeof cost?.name === 'string')
          .map((cost) => ({
            name: cost.name as string,
            tokens: finite(cost.tokens) ?? 0,
            bytes: finite(cost.bytes) ?? 0,
            deferred: cost.deferred === true,
          })),
      };
    }
    rounds.push({
      round: index + 1,
      provenance,
      composition,
      ledger: brainRow ? ledgerCall(brainRow) : null,
    });
  }

  const alignmentIssues: string[] = [];
  const counts = {
    provenanceRequests: provenanceRows.length,
    compositionEvents: compositionRows.length,
    brainLedgerRows: brainRows.length,
    nestedExcluded: nestedExcluded.length,
  };
  if (counts.provenanceRequests > 0 && counts.compositionEvents !== counts.provenanceRequests) {
    alignmentIssues.push(`composition_events=${counts.compositionEvents} provenance_requests=${counts.provenanceRequests}`);
  }
  if (counts.provenanceRequests > 0 && counts.brainLedgerRows !== counts.provenanceRequests) {
    alignmentIssues.push(`brain_ledger_rows=${counts.brainLedgerRows} provenance_requests=${counts.provenanceRequests}`);
  }

  const brain = brainRows.map(ledgerCall);
  const sum = (values: Array<number | null>): number => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const first = rounds[0];
  const terminalAt = (terminal as TurnRoundsScore['terminal'])?.at ?? null;
  const wallMs = terminalAt ? Date.parse(terminalAt) - Date.parse(sourceAt) : null;
  const turnStart = jevCalls.filter((call) => call.channel === 'jev-turn-start');
  const arm: JevArm = turnStart.length === 0
    ? 'jev_not_called'
    : turnStart.some((call) => call.ok) ? 'jev_answered' : 'jev_unavailable';

  return {
    home,
    sessionId,
    sourceUserSeq,
    acceptedSource,
    sourceAt,
    terminal,
    rounds,
    counts,
    alignmentIssues,
    round1: {
      layerBytes: first?.provenance?.layerBytes ?? null,
      totalBytes: first?.provenance?.totalBytes ?? null,
      bucketTokens: first?.composition?.buckets ?? null,
      compositionTokens: first?.composition?.totalTokens ?? null,
      wireTools: first?.provenance?.wireTools
        ?? first?.composition?.toolSchemaCosts.filter((cost) => !cost.deferred).map((cost) => cost.name)
        ?? [],
      providerPromptTokens: first?.ledger?.promptTokens ?? null,
      providerUncachedTokens: first?.ledger?.uncachedTokens ?? null,
    },
    totals: {
      rounds: roundCount,
      requestBytes: sum(rounds.map((round) => round.provenance?.totalBytes ?? null)),
      brainPromptTokens: sum(brain.map((call) => call.promptTokens)),
      brainCachedTokens: sum(brain.map((call) => call.cachedTokens)),
      brainUncachedTokens: sum(brain.map((call) => call.uncachedTokens)),
      brainOutputTokens: sum(brain.map((call) => call.outputTokens)),
      brainReasoningTokens: sum(brain.map((call) => call.reasoningTokens)),
      brainSeconds: Math.round(sum(brain.map((call) => call.durationMs)) / 100) / 10,
      wallSeconds: wallMs === null ? null : Math.round(wallMs / 100) / 10,
      servedBrainModels: [...new Set(brain.map((call) => call.model).filter((model): model is string => Boolean(model)))],
    },
    topLevelToolCalls: toolRows.map((row) => {
      const data = parseObject(row.data_json) ?? {};
      return {
        seq: row.seq,
        at: row.created_at,
        tool: typeof data.tool === 'string' ? data.tool : '?',
        effectiveTool: typeof data.effectiveTool === 'string' ? data.effectiveTool : null,
      };
    }),
    jev: {
      arm,
      calls: jevCalls,
      seconds: Math.round(sum(jevCalls.map((call) => call.durationMs)) / 100) / 10,
    },
    reviewer: {
      calls: reviewerCalls,
      promptTokens: sum(reviewerCalls.map((call) => call.promptTokens)),
      uncachedTokens: sum(reviewerCalls.map((call) => call.uncachedTokens)),
      seconds: Math.round(sum(reviewerCalls.map((call) => call.durationMs)) / 100) / 10,
      verdicts: verdictRows.map((row) => projectReviewVerdict(row.seq, parseObject(row.data_json) ?? {})),
    },
    other,
    nestedExcluded,
    routedModel,
  };
}

function pad(value: unknown, width: number): string {
  const text = value === null || value === undefined ? '-' : String(value);
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/** Plain-text rendering of a score, one line per round then turn totals. */
export function formatTurnRoundsScore(score: TurnRoundsScore): string {
  const lines: string[] = [];
  lines.push(`accepted source ${score.acceptedSource}  (routed ${score.routedModel ?? '-'})`);
  lines.push(`terminal: ${score.terminal ? `seq ${score.terminal.seq} status=${score.terminal.status} kind=${score.terminal.kind} replyChars=${score.terminal.replyChars}` : 'none'}`);
  lines.push('');
  lines.push(`${pad('rnd', 3)} ${pad('bytes', 7)} ${pad('policy', 6)} ${pad('turnCx', 6)} ${pad('memory', 6)} ${pad('catalog', 7)} ${pad('task', 7)} ${pad('estTok', 6)} ${pad('prompt', 6)} ${pad('cached', 6)} ${pad('uncach', 6)} ${pad('out', 5)} ${pad('reason', 6)} ${pad('secs', 5)} ${pad('ttft', 5)} model / wire tools`);
  for (const round of score.rounds) {
    const layers = round.provenance?.layerBytes;
    const ledger = round.ledger;
    lines.push([
      pad(round.round, 3),
      pad(round.provenance?.totalBytes ?? null, 7),
      pad(layers?.stablePolicy ?? null, 6),
      pad(layers?.turnContext ?? null, 6),
      pad(layers?.memoryContext ?? null, 6),
      pad(layers?.catalog ?? null, 7),
      pad(layers?.task ?? null, 7),
      pad(round.composition?.totalTokens ?? null, 6),
      pad(ledger?.promptTokens ?? null, 6),
      pad(ledger?.cachedTokens ?? null, 6),
      pad(ledger?.uncachedTokens ?? null, 6),
      pad(ledger?.outputTokens ?? null, 5),
      pad(ledger?.reasoningTokens ?? null, 6),
      pad(ledger?.durationMs === null || ledger?.durationMs === undefined ? null : (ledger.durationMs / 1000).toFixed(1), 5),
      pad(ledger?.firstTokenMs === null || ledger?.firstTokenMs === undefined ? null : (ledger.firstTokenMs / 1000).toFixed(1), 5),
      `${ledger?.model ?? '-'} / ${round.provenance?.wireTools.length ?? round.composition?.toolCount ?? 0} tools`,
    ].join(' '));
  }
  lines.push('');
  const r1 = score.round1;
  lines.push(`round 1: ${r1.totalBytes ?? '-'} bytes; layers ${r1.layerBytes ? PROMPT_LAYERS.map((layer) => `${layer}=${r1.layerBytes![layer]}`).join(' ') : '-'}`);
  lines.push(`round 1 buckets (est. tokens): ${r1.bucketTokens ? Object.entries(r1.bucketTokens).map(([name, tokens]) => `${name}=${tokens}`).join(' ') : '-'}`);
  lines.push(`round 1 provider: prompt=${r1.providerPromptTokens ?? '-'} uncached=${r1.providerUncachedTokens ?? '-'}`);
  lines.push(`round 1 wire tools (${r1.wireTools.length}): ${r1.wireTools.join(', ')}`);
  const t = score.totals;
  lines.push(`turn: rounds=${t.rounds} requestBytes=${t.requestBytes} prompt=${t.brainPromptTokens} cached=${t.brainCachedTokens} uncached=${t.brainUncachedTokens} output=${t.brainOutputTokens} reasoning=${t.brainReasoningTokens} brainSecs=${t.brainSeconds} wallSecs=${t.wallSeconds ?? '-'} models=${t.servedBrainModels.join(',') || '-'}`);
  lines.push(`tools (top-level): ${score.topLevelToolCalls.map((call) => call.effectiveTool && call.effectiveTool !== call.tool ? `${call.tool}>${call.effectiveTool}` : call.tool).join(', ') || '-'}`);
  lines.push(`jev: arm=${score.jev.arm} calls=${score.jev.calls.length} secs=${score.jev.seconds} [${score.jev.calls.map((call) => `${call.channel}${call.ok ? '' : `:fail(${call.failReason ?? '?'})`}`).join(', ')}]`);
  lines.push(`reviewer: calls=${score.reviewer.calls.length} prompt=${score.reviewer.promptTokens} uncached=${score.reviewer.uncachedTokens} secs=${score.reviewer.seconds} verdicts=[${score.reviewer.verdicts.map((verdict) => `${verdict.kind}:${verdict.failedOpen ? `unreviewed(${verdict.reviewFailure ?? 'unavailable'})` : verdict.fulfills}@${verdict.judgeModelId ?? '-'}/${verdict.reviewDepth ?? '-'}`).join(', ')}]`);
  if (score.nestedExcluded.length > 0) {
    lines.push(`nested rows excluded from rounds: ${score.nestedExcluded.length} [${score.nestedExcluded.map((call) => `${call.model}:${call.promptTokens}`).join(', ')}]`);
  }
  if (score.other.length > 0) {
    lines.push(`other rows: ${score.other.map((call) => `${call.role ?? 'unset'}/${call.channel ?? '-'}/${call.model}`).join(', ')}`);
  }
  lines.push(`alignment: ${score.alignmentIssues.length ? score.alignmentIssues.join('; ') : 'provenance, composition and ledger agree on round count'}`);
  return lines.join('\n');
}

function main(argv: readonly string[]): void {
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    const value = index < 0 ? undefined : argv[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
  };
  const home = path.resolve(option('--home') ?? process.env.CLEMENTINE_HOME ?? path.join(os.homedir(), '.clementine-next'));
  const sessionId = option('--session');
  const seqArg = option('--seq') ?? 'latest';
  if (!sessionId) {
    console.error('usage: score-turn-rounds.mts --session <id> [--seq <n|latest>] [--home DIR] [--json]');
    process.exit(2);
  }
  const seq = seqArg === 'latest' ? latestAcceptedSourceSeq(home, sessionId) : Number(seqArg);
  const score = scoreAcceptedTurnRounds(home, sessionId, seq);
  console.log(argv.includes('--json') ? JSON.stringify(score, null, 2) : formatTurnRoundsScore(score));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
