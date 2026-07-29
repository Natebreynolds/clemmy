/**
 * Selectable pre-tag proof for a bookkeeping receipt lifecycle.
 *
 * The proof deliberately uses two manual conversational runs for ambiguity:
 * the workflow runner does not yet expose a first-class resumable
 * `needs_input` node. Run 1 asks the user instead of guessing or writing; run
 * 2 receives the explicit, workflow-scoped correction and stores it. Only then
 * does a deterministic direct-call graph append one exact row behind a durable
 * approval and read it back from the proof-local provider before completion.
 *
 * No real Google account is reachable. The provider boundary is the isolated
 * Composio CLI shim provisioned inside daemon.home.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  narrationCheck,
  openHarnessDb,
  sessionMetrics,
  stormCheck,
} from '../score.js';
import type {
  Check,
  DaemonHandle,
  ScenarioDef,
} from '../types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from '../timeouts.js';

export const BOOKKEEPING_APPEND_TOOL = 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND';
export const BOOKKEEPING_READ_TOOL = 'GOOGLESHEETS_VALUES_GET';
export const BOOKKEEPING_HEADERS = [
  'fingerprint',
  'source_receipt_id',
  'purchased_on',
  'merchant',
  'amount',
  'currency',
  'tax',
  'category',
  'category_scope',
  'source_uri',
  'captured_at',
  'evidence_note',
] as const;

const APPEND_STEP_ID = 'append-receipt';
const READBACK_STEP_ID = 'readback-receipt';
const PAYLOAD_LOG = 'proof-composio-payloads.log';
const RECEIPT_LOG = 'proof-googlesheets-receipts.log';
const OPERATION_LOG = 'proof-googlesheets-operations.log';
const SHEETS_STATE = 'proof-googlesheets-state.json';
const NORMAL_TERMINAL_RUN_STATUSES = new Set(['completed', 'error', 'failed', 'cancelled']);
const CATEGORY = 'Meals & Entertainment';
const OTHER_CATEGORY = 'Travel';

export interface SyntheticBookkeepingReceipt {
  source: string;
  sourceReceiptId: string;
  purchasedOn: string;
  merchant: string;
  amount: string | number;
  currency: string;
  tax: string | number;
  sourceUri: string;
  evidenceNote: string;
  capturedAt: string;
}

export interface BookkeepingAppendExpectation {
  spreadsheetId: string;
  range: string;
  row: readonly string[];
}

export interface ExactBookkeepingAppendResult {
  pass: boolean;
  problems: string[];
}

export interface ProofSheetsState {
  version: number;
  sheets: Record<string, {
    spreadsheetId?: string;
    range?: string;
    rows: string[][];
  }>;
}

interface WorkflowRunRow {
  id?: string;
  status?: string;
  finishedAt?: string;
  output?: unknown;
  stepOutputs?: unknown;
  error?: unknown;
}

interface ApprovalRow {
  approvalId?: string;
  sessionId?: string;
  status?: string;
}

interface WorkflowEvent {
  kind?: string;
  stepId?: string;
  output?: unknown;
}

interface ProviderObservation {
  slug: string;
  payload: string;
}

interface ProofSheetReceipt {
  id?: string;
  slug?: string;
  spreadsheetId?: string;
  range?: string;
  rowCount?: number;
  fingerprint?: string | null;
}

interface ProofSheetOperation {
  operation?: string;
  slug?: string;
  spreadsheetId?: string;
  range?: string;
  rowCount?: number;
  fingerprint?: string | null;
}

interface ActiveFact {
  kind: string;
  content: string;
  source_session_id: string | null;
}

interface MutationLedgerSummary {
  receipts: number;
  commits: number;
  calls: Array<{ tool?: string; args?: Record<string, unknown> }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function normalizedIdentityText(value: unknown): string {
  return normalizedText(value).toLocaleLowerCase('en-US');
}

function normalizedMoney(value: string | number): string {
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) throw new Error(`invalid receipt money value: ${String(value)}`);
  return parsed.toFixed(2);
}

function canonicalReceiptIdentity(receipt: SyntheticBookkeepingReceipt): string {
  return JSON.stringify([
    'bookkeeping-receipt-v1',
    normalizedIdentityText(receipt.source),
    normalizedIdentityText(receipt.sourceReceiptId),
    normalizedText(receipt.purchasedOn).slice(0, 10),
    normalizedIdentityText(receipt.merchant),
    normalizedMoney(receipt.amount),
    normalizedText(receipt.currency).toUpperCase(),
    normalizedMoney(receipt.tax),
    normalizedText(receipt.sourceUri),
  ]);
}

/** Receipt identity excludes category: a later human correction must refer to
 * the same source receipt, not create a second bookkeeping item. */
export function fingerprintSyntheticReceipt(receipt: SyntheticBookkeepingReceipt): string {
  return `receipt-sha256:${createHash('sha256').update(canonicalReceiptIdentity(receipt)).digest('hex')}`;
}

export function buildBookkeepingRow(
  receipt: SyntheticBookkeepingReceipt,
  category: string,
  categoryScope: string,
): string[] {
  return [
    fingerprintSyntheticReceipt(receipt),
    normalizedText(receipt.sourceReceiptId),
    normalizedText(receipt.purchasedOn).slice(0, 10),
    normalizedText(receipt.merchant),
    normalizedMoney(receipt.amount),
    normalizedText(receipt.currency).toUpperCase(),
    normalizedMoney(receipt.tax),
    normalizedText(category),
    normalizedText(categoryScope),
    normalizedText(receipt.sourceUri),
    normalizedText(receipt.capturedAt),
    normalizedText(receipt.evidenceNote),
  ];
}

export function buildBookkeepingAppendPayload(
  expectation: BookkeepingAppendExpectation,
): Record<string, unknown> {
  return {
    spreadsheetId: expectation.spreadsheetId,
    range: expectation.range,
    valueInputOption: 'RAW',
    majorDimension: 'ROWS',
    insertDataOption: 'INSERT_ROWS',
    includeValuesInResponse: true,
    values: [[...expectation.row]],
  };
}

export function exactBookkeepingAppendPayload(
  value: unknown,
  expectation: BookkeepingAppendExpectation,
): ExactBookkeepingAppendResult {
  const problems: string[] = [];
  const row = asRecord(value);
  if (!row) return { pass: false, problems: ['payload must be one object'] };
  const expectedKeys = [
    'includeValuesInResponse',
    'insertDataOption',
    'majorDimension',
    'range',
    'spreadsheetId',
    'valueInputOption',
    'values',
  ].sort();
  const actualKeys = Object.keys(row).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    problems.push(`keys must be exactly ${expectedKeys.join(', ')} (including camelCase spreadsheetId)`);
  }
  if (row.spreadsheetId !== expectation.spreadsheetId) problems.push('spreadsheetId differs');
  if (row.range !== expectation.range) problems.push('range differs');
  if (row.valueInputOption !== 'RAW') problems.push('valueInputOption must be RAW');
  if (row.majorDimension !== 'ROWS') problems.push('majorDimension must be ROWS');
  if (row.insertDataOption !== 'INSERT_ROWS') problems.push('insertDataOption must be INSERT_ROWS');
  if (row.includeValuesInResponse !== true) problems.push('includeValuesInResponse must be true');
  if (JSON.stringify(row.values) !== JSON.stringify([[...expectation.row]])) {
    problems.push('values must contain exactly the expected receipt row');
  }
  return { pass: problems.length === 0, problems };
}

function readbackValues(value: unknown): unknown {
  const outer = asRecord(value);
  if (!outer) return undefined;
  if (Array.isArray(outer.values)) return outer.values;
  const data = asRecord(outer.data);
  if (data && Array.isArray(data.values)) return data.values;
  const result = asRecord(outer.result);
  if (result) return readbackValues(result);
  return undefined;
}

/** The isolated proof Sheet contains exactly one header plus one receipt. */
export function bookkeepingReadbackMatches(value: unknown, expectedRow: readonly string[]): boolean {
  const values = readbackValues(value);
  return Array.isArray(values)
    && values.length === 2
    && JSON.stringify(values[0]) === JSON.stringify(BOOKKEEPING_HEADERS)
    && JSON.stringify(values[1]) === JSON.stringify([...expectedRow]);
}

export function parseProofSheetsState(raw: string): ProofSheetsState | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const row = asRecord(parsed);
    const sheets = asRecord(row?.sheets);
    if (!row || !sheets) return null;
    const normalized: ProofSheetsState['sheets'] = {};
    for (const [key, value] of Object.entries(sheets)) {
      const sheet = asRecord(value);
      if (!sheet || !Array.isArray(sheet.rows)) continue;
      const rows = sheet.rows
        .filter((candidate): candidate is unknown[] => Array.isArray(candidate))
        .map((candidate) => candidate.map((cell) => String(cell ?? '')));
      normalized[key] = {
        ...(typeof sheet.spreadsheetId === 'string' ? { spreadsheetId: sheet.spreadsheetId } : {}),
        ...(typeof sheet.range === 'string' ? { range: sheet.range } : {}),
        rows,
      };
    }
    return {
      version: typeof row.version === 'number' ? row.version : 1,
      sheets: normalized,
    };
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function readJsonLines<T>(file: string): T[] {
  return readText(file)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try { return [JSON.parse(line) as T]; } catch { return []; }
    });
}

function providerObservations(home: string): ProviderObservation[] {
  return readJsonLines<{ slug?: unknown; payload?: unknown }>(path.join(home, PAYLOAD_LOG))
    .flatMap((row) => (
      typeof row.slug === 'string' && typeof row.payload === 'string'
        ? [{ slug: row.slug, payload: row.payload }]
        : []
    ));
}

function proofSheetReceipts(home: string): ProofSheetReceipt[] {
  return readJsonLines<ProofSheetReceipt>(path.join(home, RECEIPT_LOG));
}

function proofSheetOperations(home: string): ProofSheetOperation[] {
  return readJsonLines<ProofSheetOperation>(path.join(home, OPERATION_LOG));
}

function activeFactsContaining(home: string, marker: string): ActiveFact[] {
  const file = path.join(home, 'state', 'memory.db');
  if (!existsSync(file)) return [];
  try {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare(
        `SELECT kind, content, source_session_id
           FROM consolidated_facts
          WHERE active = 1 AND lower(content) LIKE ?
          ORDER BY id ASC`,
      ).all(`%${marker.toLocaleLowerCase('en-US')}%`) as ActiveFact[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function approvalsFromResponse(json: unknown): ApprovalRow[] {
  if (Array.isArray(json)) return json as ApprovalRow[];
  const body = asRecord(json);
  if (Array.isArray(body?.approvals)) return body.approvals as ApprovalRow[];
  return Array.isArray(body?.pending) ? body.pending as ApprovalRow[] : [];
}

async function pendingApprovalForRun(
  daemon: DaemonHandle,
  runId: string,
): Promise<ApprovalRow | null> {
  const res = await daemon.request('GET', '/api/console/approvals/list');
  if (res.status >= 300) return null;
  const gateSessionId = `workflow-gate:${runId}:${APPEND_STEP_ID}`;
  return approvalsFromResponse(res.json).find((row) => (
    row.status !== 'resolved' && row.sessionId === gateSessionId
  )) ?? null;
}

async function workflowRuns(
  daemon: DaemonHandle,
  workflowName: string,
): Promise<WorkflowRunRow[]> {
  const res = await daemon.request(
    'GET',
    `/api/console/workflows/${encodeURIComponent(workflowName)}/runs`,
  );
  if (res.status >= 300) return [];
  const body = asRecord(res.json);
  return Array.isArray(body?.runs) ? body.runs as WorkflowRunRow[] : [];
}

async function waitForWorkflowRun(
  daemon: DaemonHandle,
  workflowName: string,
  runId: string,
  predicate: (run: WorkflowRunRow) => boolean,
  timeoutMs = 420_000,
): Promise<WorkflowRunRow | null> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowRunRow | null = null;
  while (Date.now() < deadline) {
    last = (await workflowRuns(daemon, workflowName)).find((run) => run.id === runId) ?? null;
    if (last && predicate(last)) return last;
    await sleep(750);
  }
  return last;
}

async function waitForApproval(
  daemon: DaemonHandle,
  workflowName: string,
  runId: string,
): Promise<{ approval: ApprovalRow | null; run: WorkflowRunRow | null }> {
  const deadline = Date.now() + 180_000;
  let run: WorkflowRunRow | null = null;
  while (Date.now() < deadline) {
    const [approval, runs] = await Promise.all([
      pendingApprovalForRun(daemon, runId),
      workflowRuns(daemon, workflowName),
    ]);
    run = runs.find((candidate) => candidate.id === runId) ?? null;
    if (approval?.approvalId) return { approval, run };
    if (run?.status && NORMAL_TERMINAL_RUN_STATUSES.has(run.status)) return { approval: null, run };
    await sleep(750);
  }
  return { approval: null, run };
}

function workflowEvents(
  daemon: DaemonHandle,
  workflowSlug: string,
  runId: string,
): WorkflowEvent[] {
  return readJsonLines<WorkflowEvent>(path.join(
    daemon.home,
    'vault',
    '00-System',
    'workflows',
    workflowSlug,
    'runs',
    runId,
    'events.jsonl',
  ));
}

function mutationLedger(
  daemon: DaemonHandle,
  workflowSlug: string,
  runId: string,
): MutationLedgerSummary {
  const root = path.join(
    daemon.home,
    'vault',
    '00-System',
    'workflows',
    workflowSlug,
    'runs',
    runId,
    'call-mutations',
  );
  if (!existsSync(root)) return { receipts: 0, commits: 0, calls: [] };
  const operations = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => path.join(root, entry.name));
  return {
    receipts: operations.filter((dir) => existsSync(path.join(dir, 'receipt.json'))).length,
    commits: operations.filter((dir) => existsSync(path.join(dir, 'commit.json'))).length,
    calls: operations.flatMap((dir) => {
      try {
        const intent = JSON.parse(readFileSync(path.join(dir, 'intent.json'), 'utf8')) as {
          call?: { tool?: string; args?: Record<string, unknown> };
        };
        return intent.call ? [intent.call] : [];
      } catch {
        return [];
      }
    }),
  };
}

function metricsForSession(home: string, sessionId: string) {
  try {
    const db = openHarnessDb(home);
    try { return sessionMetrics(db, sessionId); } finally { db.close(); }
  } catch {
    return null;
  }
}

function parsedPayload(observation: ProviderObservation | undefined): Record<string, unknown> | null {
  if (!observation) return null;
  try { return asRecord(JSON.parse(observation.payload)); } catch { return null; }
}

export const bookkeepingReceiptExactOnce: ScenarioDef = {
  name: 'bookkeeping-receipt-exact-once',
  summary: 'ambiguous receipt asks → scoped correction recalled → gated append/readback exactly once',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const nonce = Date.now().toString(36);
    const workflowName = `proof-bookkeeping-receipt-${nonce}`;
    const workflowSlug = workflowName;
    const conversationSession = `proof-bookkeeping-clarify-${nonce}`;
    const recallSession = `proof-bookkeeping-recall-${nonce}`;
    const merchant = `Harbor Lantern Café ${nonce}`;
    const spreadsheetId = `proof-sheet-bookkeeping-${nonce}`;
    const range = 'Receipts!A:L';
    const receipt: SyntheticBookkeepingReceipt = {
      source: 'proof-camera-roll',
      sourceReceiptId: `receipt-${nonce}`,
      purchasedOn: '2026-07-27',
      merchant,
      amount: '84.20',
      currency: 'USD',
      tax: '7.20',
      sourceUri: `proof://receipts/${nonce}`,
      evidenceNote: 'Client dinner after airport pickup.',
      capturedAt: '2026-07-28T17:00:00.000Z',
    };
    const row = buildBookkeepingRow(receipt, CATEGORY, workflowName);
    const appendExpectation: BookkeepingAppendExpectation = { spreadsheetId, range, row };
    const appendPayload = buildBookkeepingAppendPayload(appendExpectation);
    const checks: Check[] = [];
    const startedAt = Date.now();
    let rejectedRunId = '';
    let approvedRunId = '';
    let finalRun: WorkflowRunRow | null = null;

    try {
      // Manual run 1: the evidence intentionally cannot choose between the two
      // valid categories. The correct product behavior is a question, not a
      // guessed category, provider write, or durable learned rule.
      const factsBefore = activeFactsContaining(daemon.home, workflowName);
      const observationsBeforeAmbiguity = providerObservations(daemon.home);
      const ambiguousTurn = await daemon.chat(
        [
          `Help me classify this one synthetic receipt for the workflow ${workflowName}.`,
          'Use local reasoning only. Do not call an external connector and do not store the receipt or an inferred category in durable memory.',
          `Our policy permits exactly two plausible categories here: "${CATEGORY}" or "${OTHER_CATEGORY}".`,
          'The receipt evidence does not distinguish them. Before any write, stop and ask me one concise question to choose; do not guess.',
          `Receipt: ${JSON.stringify(receipt)}`,
        ].join('\n'),
        conversationSession,
        300_000,
      );
      const factsAfterAmbiguity = activeFactsContaining(daemon.home, workflowName);
      const observationsAfterAmbiguity = providerObservations(daemon.home);
      const ambiguityMetrics = metricsForSession(daemon.home, conversationSession);
      const asksCategory = /\?/.test(ambiguousTurn.text)
        && ambiguousTurn.text.toLowerCase().includes(CATEGORY.toLowerCase())
        && ambiguousTurn.text.toLowerCase().includes(OTHER_CATEGORY.toLowerCase());

      checks.push({ name: 'ambiguous receipt turn returned HTTP 200', pass: ambiguousTurn.httpStatus === 200, detail: `status ${ambiguousTurn.httpStatus}` });
      checks.push(narrationCheck(ambiguousTurn.text));
      checks.push({
        name: 'manual run 1 represented needs_input honestly instead of guessing',
        pass: asksCategory,
        detail: ambiguousTurn.text.slice(0, 360),
      });
      checks.push({
        name: 'ambiguous run learned no workflow rule',
        pass: factsBefore.length === 0 && factsAfterAmbiguity.length === 0,
        detail: JSON.stringify({ before: factsBefore, after: factsAfterAmbiguity }),
      });
      checks.push({
        name: 'ambiguous run made zero provider dispatch and zero external write',
        pass: observationsAfterAmbiguity.length === observationsBeforeAmbiguity.length
          && ambiguityMetrics != null
          && ambiguityMetrics.externalWrites === 0,
        detail: JSON.stringify({
          observationsBefore: observationsBeforeAmbiguity.length,
          observationsAfter: observationsAfterAmbiguity.length,
          externalWrites: ambiguityMetrics?.externalWrites ?? null,
          logicalTools: ambiguityMetrics?.logicalToolCalls ?? null,
        }),
      });

      // Manual run 2: the user supplies explicit authority. Store the rule with
      // its workflow boundary in the fact itself, then prove a fresh session can
      // recall both the category and its non-global scope.
      const fact = `For the bookkeeping workflow "${workflowName}" only, receipts from "${merchant}" use category "${CATEGORY}". Do not apply this merchant rule outside that workflow.`;
      const correctionTurn = await daemon.chat(
        [
          'Use local memory only and do not call any external connector.',
          `That receipt belongs in "${CATEGORY}".`,
          `Call memory_remember exactly once with kind=project and this exact workflow-scoped fact, preserving every character: ${fact}`,
          'Then confirm briefly without doing the Sheet write yet.',
        ].join('\n'),
        conversationSession,
        300_000,
      );
      const correctedFacts = activeFactsContaining(daemon.home, workflowName);
      checks.push({ name: 'explicit correction turn returned HTTP 200', pass: correctionTurn.httpStatus === 200, detail: `status ${correctionTurn.httpStatus}` });
      checks.push({
        name: 'manual run 2 stored one explicit workflow-scoped correction',
        pass: correctedFacts.length === 1
          && correctedFacts[0].kind === 'project'
          && correctedFacts[0].content.includes(workflowName)
          && correctedFacts[0].content.includes(merchant)
          && correctedFacts[0].content.includes(CATEGORY)
          && /only|outside/i.test(correctedFacts[0].content),
        detail: JSON.stringify(correctedFacts),
      });

      const recallTurn = await daemon.chat(
        [
          'Use Clementine local memory only. Do not call an external connector and do not write or change memory.',
          `For the exact bookkeeping workflow "${workflowName}", what category did I explicitly set for merchant "${merchant}"?`,
          'Answer with the exact category and state whether the rule is global or limited to that workflow.',
        ].join('\n'),
        recallSession,
        300_000,
      );
      const recallMetrics = metricsForSession(daemon.home, recallSession);
      checks.push({ name: 'fresh scoped-recall turn returned HTTP 200', pass: recallTurn.httpStatus === 200, detail: `status ${recallTurn.httpStatus}` });
      checks.push(narrationCheck(recallTurn.text));
      checks.push({
        name: 'fresh session recalled the exact category and workflow scope',
        pass: recallTurn.text.toLowerCase().includes(CATEGORY.toLowerCase())
          && recallTurn.text.toLowerCase().includes(workflowName.toLowerCase())
          && /only|limited|not global|specific/i.test(recallTurn.text),
        detail: recallTurn.text.slice(0, 420),
      });
      checks.push({
        name: 'scoped recall stayed local and read-only',
        pass: recallMetrics != null && recallMetrics.externalWrites === 0,
        detail: `external writes ${recallMetrics?.externalWrites ?? 'n/a'}; tools ${JSON.stringify(recallMetrics?.logicalToolCalls ?? {})}`,
      });

      // Activate only the disposable provider shim after the conversational
      // ambiguity/correction boundary has been proven.
      writeFileSync(path.join(daemon.home, 'proof-composio-connected'), 'connected\n', 'utf8');
      const refreshed = await daemon.request('POST', '/api/composio/refresh', {});
      checks.push({
        name: 'proof-only Google Sheets capability connected',
        pass: refreshed.status === 200,
        detail: `refresh status ${refreshed.status}`,
      });

      const observationsBeforeCreate = providerObservations(daemon.home).length;
      const create = await daemon.request('POST', '/api/console/workflows', {
        name: workflowName,
        description: 'Proof-only receipt append followed by provider readback; no real account is reachable.',
        enabled: true,
        steps: [
          {
            id: APPEND_STEP_ID,
            prompt: 'Append the one prepared receipt row exactly as declared.',
            sideEffect: 'write',
            requiresApproval: true,
            approvalPreview: `Append one receipt ${row[0]} to ${spreadsheetId} ${range}`,
            call: {
              tool: BOOKKEEPING_APPEND_TOOL,
              args: appendPayload,
            },
          },
          {
            id: READBACK_STEP_ID,
            prompt: 'Read the provider row back before this workflow can complete.',
            dependsOn: [APPEND_STEP_ID],
            sideEffect: 'read',
            call: {
              tool: BOOKKEEPING_READ_TOOL,
              args: {
                spreadsheet_id: spreadsheetId,
                range,
              },
            },
            output: {
              type: 'object',
              required_keys: ['values'],
              non_empty: ['values'],
              min_items: { values: 2 },
              description: 'Provider readback must contain the header and exactly persisted receipt evidence.',
            },
          },
        ],
      });
      const createBody = asRecord(create.json);
      const creationRunId = typeof createBody?.runId === 'string' ? createBody.runId : '';
      checks.push({
        name: 'bookkeeping graph authored through the user-facing workflow API',
        pass: create.status < 300,
        detail: `status ${create.status}; ${JSON.stringify(create.json).slice(0, 500)}`,
      });

      let creationRun: WorkflowRunRow | null = null;
      if (creationRunId) {
        creationRun = await waitForWorkflowRun(
          daemon,
          workflowName,
          creationRunId,
          (run) => Boolean(run.finishedAt),
        );
      }
      const workflowDetail = await daemon.request(
        'GET',
        `/api/console/workflows/${encodeURIComponent(workflowName)}`,
      );
      const workflowBody = asRecord(workflowDetail.json);
      const creationObservations = providerObservations(daemon.home).slice(observationsBeforeCreate);
      checks.push({
        name: 'creation gate previewed the write and verified only provider readback',
        pass: create.status < 300
          && (!creationRunId || creationRun?.status === 'creation_test')
          && workflowDetail.status === 200
          && workflowBody?.enabled === true
          && creationObservations.filter((item) => item.slug === BOOKKEEPING_APPEND_TOOL).length === 0
          && creationObservations.filter((item) => item.slug === BOOKKEEPING_READ_TOOL).length <= 1,
        detail: JSON.stringify({
          createStatus: create.status,
          creationRunId: creationRunId || null,
          creationStatus: creationRun?.status ?? null,
          creationFinishedAt: creationRun?.finishedAt ?? null,
          enabled: workflowBody?.enabled ?? null,
          observations: creationObservations,
        }),
      });

      // From here onward the baseline excludes the creation-test GET. Every
      // append/read/receipt below belongs to reject or approved lifecycle runs.
      const providerBaseline = providerObservations(daemon.home).length;
      const receiptBaseline = proofSheetReceipts(daemon.home).length;
      const operationBaseline = proofSheetOperations(daemon.home).length;

      const rejectedQueue = await daemon.request(
        'POST',
        `/api/console/workflows/${encodeURIComponent(workflowName)}/run`,
        {},
      );
      rejectedRunId = String(asRecord(rejectedQueue.json)?.id ?? '');
      const rejectedPark = rejectedRunId
        ? await waitForApproval(daemon, workflowName, rejectedRunId)
        : { approval: null, run: null };
      const rejectedApprovalId = rejectedPark.approval?.approvalId ?? '';
      checks.push({
        name: 'reject candidate parked on one exact append approval',
        pass: rejectedQueue.status < 300
          && Boolean(rejectedRunId)
          && Boolean(rejectedApprovalId),
        detail: JSON.stringify({
          queueStatus: rejectedQueue.status,
          runId: rejectedRunId || null,
          approvalId: rejectedApprovalId || null,
          runStatus: rejectedPark.run?.status ?? null,
        }),
      });
      const rejectedDecision = rejectedApprovalId
        ? await daemon.approve(rejectedApprovalId, 'reject')
        : 0;
      const rejectedFinal = rejectedRunId
        ? await waitForWorkflowRun(
            daemon,
            workflowName,
            rejectedRunId,
            (run) => run.status === 'cancelled',
            90_000,
          )
        : null;
      const afterRejectObservations = providerObservations(daemon.home).slice(providerBaseline);
      checks.push({
        name: 'rejected append produced zero provider write, receipt, or row',
        pass: rejectedDecision > 0
          && rejectedDecision < 300
          && rejectedFinal?.status === 'cancelled'
          && afterRejectObservations.length === 0
          && proofSheetReceipts(daemon.home).length === receiptBaseline
          && !existsSync(path.join(daemon.home, SHEETS_STATE)),
        detail: JSON.stringify({
          decisionStatus: rejectedDecision,
          runStatus: rejectedFinal?.status ?? null,
          observations: afterRejectObservations,
          receiptCount: proofSheetReceipts(daemon.home).length - receiptBaseline,
          stateExists: existsSync(path.join(daemon.home, SHEETS_STATE)),
        }),
      });
      const rejectedLedger = rejectedRunId
        ? mutationLedger(daemon, workflowSlug, rejectedRunId)
        : { receipts: 0, commits: 0, calls: [] };
      checks.push({
        name: 'reject path created no mutation receipt or commit',
        pass: rejectedLedger.receipts === 0 && rejectedLedger.commits === 0,
        detail: JSON.stringify(rejectedLedger),
      });

      const approvedQueue = await daemon.request(
        'POST',
        `/api/console/workflows/${encodeURIComponent(workflowName)}/run`,
        {},
      );
      approvedRunId = String(asRecord(approvedQueue.json)?.id ?? '');
      const approvedPark = approvedRunId
        ? await waitForApproval(daemon, workflowName, approvedRunId)
        : { approval: null, run: null };
      const approvedId = approvedPark.approval?.approvalId ?? '';
      checks.push({
        name: 'fresh corrected run minted a distinct append approval',
        pass: approvedQueue.status < 300
          && Boolean(approvedRunId)
          && Boolean(approvedId)
          && approvedId !== rejectedApprovalId,
        detail: JSON.stringify({
          queueStatus: approvedQueue.status,
          runId: approvedRunId || null,
          approvalId: approvedId || null,
          rejectedApprovalId: rejectedApprovalId || null,
        }),
      });

      // Prove the parked authority survives process death. Race two decisions
      // only after restart: exactly one may win, and the durable runner resumes
      // the same occurrence.
      if (approvedId) await daemon.restart();
      const approvalAfterRestart = approvedRunId
        ? await waitForApproval(daemon, workflowName, approvedRunId)
        : { approval: null, run: null };
      checks.push({
        name: 'restart preserved the same parked approval authority',
        pass: Boolean(
          approvedId
          && approvalAfterRestart.approval?.approvalId === approvedId
        ),
        detail: JSON.stringify({
          before: approvedId || null,
          after: approvalAfterRestart.approval?.approvalId ?? null,
          runStatus: approvalAfterRestart.run?.status ?? null,
        }),
      });
      const racedStatuses = approvedId
        ? await Promise.all([
            daemon.approve(approvedId, 'approve'),
            daemon.approve(approvedId, 'approve'),
          ])
        : [];
      checks.push({
        name: 'racing duplicate approvals had exactly one winner',
        pass: racedStatuses.filter((status) => status >= 200 && status < 300).length === 1
          && racedStatuses.filter((status) => status === 409).length === 1,
        detail: `statuses [${racedStatuses.join(', ')}]`,
      });

      finalRun = approvedRunId
        ? await waitForWorkflowRun(
            daemon,
            workflowName,
            approvedRunId,
            (run) => Boolean(run.status && NORMAL_TERMINAL_RUN_STATUSES.has(run.status)),
            PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
          )
        : null;
      const finalObservations = providerObservations(daemon.home).slice(providerBaseline);
      const appendObservations = finalObservations.filter((item) => item.slug === BOOKKEEPING_APPEND_TOOL);
      const readObservations = finalObservations.filter((item) => item.slug === BOOKKEEPING_READ_TOOL);
      const observedAppend = parsedPayload(appendObservations[0]);
      const observedRead = parsedPayload(readObservations[0]);
      const exactAppend = exactBookkeepingAppendPayload(observedAppend, appendExpectation);
      checks.push({
        name: 'provider observed one exact camelCase append payload',
        pass: finalRun?.status === 'completed'
          && appendObservations.length === 1
          && exactAppend.pass,
        detail: JSON.stringify({
          runStatus: finalRun?.status ?? null,
          appendCount: appendObservations.length,
          payload: observedAppend,
          exactAppend,
        }),
      });
      checks.push({
        name: 'provider GET used its exact schema after append',
        pass: readObservations.length === 1
          && observedRead != null
          && JSON.stringify(Object.keys(observedRead).sort()) === JSON.stringify(['range', 'spreadsheet_id'])
          && observedRead.spreadsheet_id === spreadsheetId
          && observedRead.range === range,
        detail: JSON.stringify({ readCount: readObservations.length, payload: observedRead }),
      });

      const state = parseProofSheetsState(readText(path.join(daemon.home, SHEETS_STATE)));
      const stateRows = state?.sheets[`${spreadsheetId}\n${range}`]?.rows ?? [];
      const receipts = proofSheetReceipts(daemon.home).slice(receiptBaseline);
      const operations = proofSheetOperations(daemon.home).slice(operationBaseline);
      checks.push({
        name: 'provider readback proves exactly one receipt row',
        pass: bookkeepingReadbackMatches({
          data: {
            range,
            majorDimension: 'ROWS',
            values: stateRows,
          },
        }, row)
          && receipts.length === 1
          && receipts[0].slug === BOOKKEEPING_APPEND_TOOL
          && receipts[0].spreadsheetId === spreadsheetId
          && receipts[0].range === range
          && receipts[0].rowCount === 1
          && receipts[0].fingerprint === row[0],
        detail: JSON.stringify({ rows: stateRows, receipts }),
      });
      checks.push({
        name: 'provider operation order was append then readback before completion',
        pass: operations.length === 2
          && operations[0]?.operation === 'append'
          && operations[0]?.slug === BOOKKEEPING_APPEND_TOOL
          && operations[1]?.operation === 'read'
          && operations[1]?.slug === BOOKKEEPING_READ_TOOL,
        detail: JSON.stringify(operations),
      });

      const events = approvedRunId ? workflowEvents(daemon, workflowSlug, approvedRunId) : [];
      const appendCompletedIndexes = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.kind === 'step_completed' && event.stepId === APPEND_STEP_ID)
        .map(({ index }) => index);
      const readCompletedIndexes = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.kind === 'step_completed' && event.stepId === READBACK_STEP_ID)
        .map(({ index }) => index);
      const runCompletedIndexes = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.kind === 'run_completed')
        .map(({ index }) => index);
      checks.push({
        name: 'durable graph completed append then readback then run exactly once',
        pass: appendCompletedIndexes.length === 1
          && readCompletedIndexes.length === 1
          && runCompletedIndexes.length === 1
          && appendCompletedIndexes[0] < readCompletedIndexes[0]
          && readCompletedIndexes[0] < runCompletedIndexes[0],
        detail: JSON.stringify({
          appendCompletedIndexes,
          readCompletedIndexes,
          runCompletedIndexes,
          eventKinds: events.map((event) => `${event.kind ?? '?'}:${event.stepId ?? ''}`),
        }),
      });

      const ledger = approvedRunId
        ? mutationLedger(daemon, workflowSlug, approvedRunId)
        : { receipts: 0, commits: 0, calls: [] };
      const ledgerCall = ledger.calls[0];
      checks.push({
        name: 'durable mutation ledger has one exact intent, receipt, and commit',
        pass: ledger.receipts === 1
          && ledger.commits === 1
          && ledger.calls.length === 1
          && ledgerCall?.tool === BOOKKEEPING_APPEND_TOOL
          && exactBookkeepingAppendPayload(ledgerCall.args, appendExpectation).pass,
        detail: JSON.stringify(ledger),
      });

      // A second restart plus replay of the same resolved approval must remain
      // inert. This is the public authority that could otherwise redispatch the
      // exact call; the receipt/state/log counts must remain byte-stable.
      if (approvedId && finalRun?.status === 'completed') await daemon.restart();
      const replayStatus = approvedId ? await daemon.approve(approvedId, 'approve') : 0;
      await sleep(750);
      const afterReplayObservations = providerObservations(daemon.home).slice(providerBaseline);
      const afterReplayReceipts = proofSheetReceipts(daemon.home).slice(receiptBaseline);
      const afterReplayState = parseProofSheetsState(readText(path.join(daemon.home, SHEETS_STATE)));
      const afterReplayRows = afterReplayState?.sheets[`${spreadsheetId}\n${range}`]?.rows ?? [];
      const afterReplayLedger = approvedRunId
        ? mutationLedger(daemon, workflowSlug, approvedRunId)
        : { receipts: 0, commits: 0, calls: [] };
      checks.push({
        name: 'restart and resolved-authority replay stayed exactly once',
        pass: replayStatus === 409
          && afterReplayObservations.length === 2
          && afterReplayReceipts.length === 1
          && bookkeepingReadbackMatches({ data: { values: afterReplayRows } }, row)
          && afterReplayLedger.receipts === 1
          && afterReplayLedger.commits === 1,
        detail: JSON.stringify({
          replayStatus,
          observations: afterReplayObservations,
          receipts: afterReplayReceipts,
          rows: afterReplayRows,
          ledger: afterReplayLedger,
        }),
      });
      checks.push(stormCheck(daemon.log()));

      const correctionMetrics = metricsForSession(daemon.home, conversationSession);
      return {
        checks,
        latency: [
          {
            wallMs: recallTurn.wallMs,
            ttftMs: recallMetrics?.latency[0]?.ttftMs
              ?? recallMetrics?.firstByteMs
              ?? null,
          },
        ],
        sessionId: recallSession,
        metrics: {
          workflowName,
          rejectedRunId: rejectedRunId || null,
          approvedRunId: approvedRunId || null,
          fingerprint: row[0],
          providerAppendCount: appendObservations.length,
          providerReadCount: readObservations.length,
          providerReceiptCount: receipts.length,
          mutationReceipts: ledger.receipts,
          mutationCommits: ledger.commits,
          needsInputBoundary:
            'manual run 1 asks; manual run 2 supplies explicit correction because workflows lack a first-class resumable needs_input node',
          ambiguousTurnWallMs: ambiguousTurn.wallMs,
          correctionTurnWallMs: correctionTurn.wallMs,
          recallTurnWallMs: recallTurn.wallMs,
          workflowLifecycleWallMs:
            Date.now() - startedAt - ambiguousTurn.wallMs - correctionTurn.wallMs - recallTurn.wallMs,
          tokensUsed:
            (correctionMetrics?.tokensUsed ?? 0)
            + (recallMetrics?.tokensUsed ?? 0),
        },
      };
    } finally {
      for (const runId of [rejectedRunId, approvedRunId].filter(Boolean)) {
        const run = (await workflowRuns(daemon, workflowName)).find((candidate) => candidate.id === runId);
        if (run?.status && !NORMAL_TERMINAL_RUN_STATUSES.has(run.status)) {
          try {
            await daemon.request(
              'POST',
              `/api/console/workflows/${encodeURIComponent(workflowName)}/runs/${encodeURIComponent(runId)}/cancel`,
              {},
            );
          } catch {
            // Best-effort fixture cleanup; proof checks preserve the failure.
          }
        }
      }
      try {
        await daemon.request(
          'DELETE',
          `/api/console/workflows/${encodeURIComponent(workflowName)}`,
        );
      } catch {
        // Best-effort fixture cleanup; isolated HOME is deleted after the leg.
      }
    }
  },
};
