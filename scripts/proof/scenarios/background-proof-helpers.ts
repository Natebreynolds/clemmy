import { existsSync, readFileSync } from 'node:fs';

import { openHarnessDb } from '../score.js';
import type { Check, DaemonHandle, TurnResult } from '../types.js';

export interface ProofBackgroundTask {
  id: string;
  title: string;
  status: string;
  originSessionId?: string;
  runSessionId: string;
  contractVersion?: number;
  contractRevisions?: Array<{
    version: number;
    instruction: string;
    evidencePolicy: string;
    queuedAt: string;
    appliedAt?: string;
  }>;
  pendingContractRevision?: { version?: number };
  result?: string;
  resultFull?: string;
  error?: string;
  pendingQuestion?: string;
  resumeCount?: number;
  restartRecovery?: {
    disposition?: string;
    reason?: string;
    externalWriteCount?: number;
    ambiguousWriteCount?: number;
  };
}

export interface ProofManifestPhase {
  id: string;
  label: string;
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  needsValidation: number;
  invalidated: number;
}

export interface ProofManifest {
  manifestId: string;
  contractVersion: string;
  phases: ProofManifestPhase[];
  total: number;
  completed: number;
  remaining: number;
  currentPhase?: string;
  evidenceCount: number;
  staleCheckpoints: number;
  untrackedCheckpoints: number;
  anomalies: string[];
  items?: unknown[];
}

export interface ProofBackgroundDetail {
  task: ProofBackgroundTask;
  detail?: {
    workManifests?: ProofManifest[];
    toolCallCount?: number;
  };
  workManifests: ProofManifest[];
  vitals?: { elapsedMs?: number; toolCallCount?: number };
  reportBack?: { label?: string };
}

export interface ProofBoardCard {
  id: string;
  sourceKind: string;
  title: string;
  column: string;
  status: string;
  progressHint?: string;
  sessionId?: string;
  raw?: {
    originSessionId?: string;
    resultPreview?: string;
    pendingQuestion?: string;
  };
}

export interface DispatchedBackgroundTask {
  turn: TurnResult;
  taskId: string;
  detail: ProofBackgroundDetail;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function proofSessionId(label: string): string {
  return `proof-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function getBoardCards(daemon: DaemonHandle): Promise<ProofBoardCard[]> {
  const response = await daemon.request('GET', '/api/console/board');
  if (response.status !== 200) throw new Error(`board returned HTTP ${response.status}`);
  const cards = (response.json as { cards?: unknown }).cards;
  if (!Array.isArray(cards)) throw new Error('board response has no cards array');
  return cards as ProofBoardCard[];
}

export async function getBackgroundDetail(
  daemon: DaemonHandle,
  taskId: string,
): Promise<{ detail: ProofBackgroundDetail; bytes: number }> {
  const response = await daemon.request(
    'GET',
    `/api/console/background-tasks/${encodeURIComponent(taskId)}`,
  );
  if (response.status !== 200) {
    throw new Error(`background detail ${taskId} returned HTTP ${response.status}`);
  }
  const detail = response.json as ProofBackgroundDetail;
  return { detail, bytes: Buffer.byteLength(JSON.stringify(response.json), 'utf8') };
}

export async function dispatchBackground(
  daemon: DaemonHandle,
  originSessionId: string,
  instruction: string,
): Promise<DispatchedBackgroundTask> {
  const before = new Set(
    (await getBoardCards(daemon))
      .filter((card) => card.sourceKind === 'background')
      .map((card) => card.id),
  );
  const turn = await daemon.chat(`/background ${instruction}`, originSessionId, 180_000);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const card = (await getBoardCards(daemon)).find((candidate) => (
      candidate.sourceKind === 'background'
      && !before.has(candidate.id)
      && candidate.raw?.originSessionId === turn.sessionId
    ));
    if (card) {
      const { detail } = await getBackgroundDetail(daemon, card.id);
      return { turn, taskId: card.id, detail };
    }
    await sleep(250);
  }
  throw new Error(`no new background task appeared for origin ${turn.sessionId}; reply=${turn.text.slice(0, 300)}`);
}

export async function waitForBackground(
  daemon: DaemonHandle,
  taskId: string,
  predicate: (detail: ProofBackgroundDetail) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<{ detail: ProofBackgroundDetail; bytes: number }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
  let last: ProofBackgroundDetail | undefined;
  let bytes = 0;
  while (Date.now() < deadline) {
    const current = await getBackgroundDetail(daemon, taskId);
    last = current.detail;
    bytes = current.bytes;
    if (predicate(current.detail)) return current;
    await sleep(opts.intervalMs ?? 500);
  }
  throw new Error(
    `${opts.label ?? 'background condition'} timed out for ${taskId}; `
    + `last=${JSON.stringify({
      status: last?.task.status,
      contractVersion: last?.task.contractVersion,
      manifests: last?.workManifests,
      error: last?.task.error,
    }).slice(0, 2_000)} bytes=${bytes}`,
  );
}

export async function waitForTerminal(
  daemon: DaemonHandle,
  taskId: string,
  timeoutMs = 20 * 60_000,
): Promise<{ detail: ProofBackgroundDetail; bytes: number }> {
  const terminal = new Set(['done', 'blocked', 'failed', 'aborted', 'interrupted', 'awaiting_input', 'awaiting_continue']);
  return waitForBackground(
    daemon,
    taskId,
    (detail) => terminal.has(detail.task.status),
    { timeoutMs, label: 'background settlement' },
  );
}

export function manifestFor(detail: ProofBackgroundDetail, manifestId: string): ProofManifest | undefined {
  return detail.workManifests?.find((manifest) => manifest.manifestId === manifestId)
    ?? detail.detail?.workManifests?.find((manifest) => manifest.manifestId === manifestId);
}

interface HarnessEvent {
  type: string;
  data: Record<string, unknown>;
}

export function isPassiveOutcomeEvent(
  event: HarnessEvent,
  taskId: string,
): boolean {
  return event.data.synthetic === true
    && event.data.source === 'outcome'
    && event.data.sourceId === taskId
    // Older eventlogs have no phase marker and remain readable. New proactive
    // model directives are explicitly marked and are internal orchestration,
    // not a second terminal delivery.
    && event.data.deliveryPhase !== 'directive';
}

export function sessionEvents(
  daemon: DaemonHandle,
  sessionId: string,
  types?: string[],
): HarnessEvent[] {
  const db = openHarnessDb(daemon.home);
  const rows = (types?.length
    ? db.prepare(
      `SELECT type, data_json FROM events WHERE session_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq ASC`,
    ).all(sessionId, ...types)
    : db.prepare(
      'SELECT type, data_json FROM events WHERE session_id = ? ORDER BY seq ASC',
    ).all(sessionId)) as Array<{ type: string; data_json: string }>;
  db.close();
  return rows.map((row) => {
    try {
      return { type: row.type, data: JSON.parse(row.data_json) as Record<string, unknown> };
    } catch {
      return { type: row.type, data: {} };
    }
  });
}

export function outcomeEvents(
  daemon: DaemonHandle,
  originSessionId: string,
  taskId: string,
): HarnessEvent[] {
  return sessionEvents(daemon, originSessionId, ['user_input_received'])
    .filter((event) => isPassiveOutcomeEvent(event, taskId));
}

export async function waitForOutcomeEvents(
  daemon: DaemonHandle,
  originSessionId: string,
  taskId: string,
  predicate: (events: HarnessEvent[]) => boolean,
  timeoutMs = 15_000,
): Promise<HarnessEvent[]> {
  const deadline = Date.now() + timeoutMs;
  let events: HarnessEvent[] = [];
  while (Date.now() < deadline) {
    events = outcomeEvents(daemon, originSessionId, taskId);
    if (predicate(events)) return events;
    await sleep(100);
  }
  return events;
}

export function workerExecutionCounts(
  daemon: DaemonHandle,
  runSessionId: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of sessionEvents(daemon, runSessionId, ['worker_started'])) {
    const item = typeof event.data.item === 'string' ? event.data.item : '';
    if (item) counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

export function succeededWorkerItems(
  daemon: DaemonHandle,
  runSessionId: string,
): string[] {
  return [...new Set(
    sessionEvents(daemon, runSessionId, ['worker_result'])
      .filter((event) => event.data.ok === true && typeof event.data.item === 'string')
      .map((event) => event.data.item as string),
  )];
}

export function manifestEventCounts(
  daemon: DaemonHandle,
  runSessionId: string,
  manifestId: string,
): {
  declarations: number;
  revisions: number;
  checkpoints: number;
  succeeded: number;
  failed: number;
  versions: string[];
} {
  const events = sessionEvents(
    daemon,
    runSessionId,
    ['work_manifest_declared', 'work_contract_revised', 'work_item_checkpoint'],
  ).filter((event) => event.data.manifestId === manifestId);
  const checkpoints = events.filter((event) => event.type === 'work_item_checkpoint');
  return {
    declarations: events.filter((event) => event.type === 'work_manifest_declared').length,
    revisions: events.filter((event) => event.type === 'work_contract_revised').length,
    checkpoints: checkpoints.length,
    succeeded: checkpoints.filter((event) => event.data.status === 'succeeded').length,
    failed: checkpoints.filter((event) => event.data.status === 'failed').length,
    versions: [...new Set(events.map((event) => String(event.data.contractVersion ?? event.data.toVersion ?? '')).filter(Boolean))],
  };
}

export function compactManifestChecks(
  detail: ProofBackgroundDetail,
  payloadBytes: number,
  manifestId: string,
): Check[] {
  const manifest = manifestFor(detail, manifestId);
  return [
    {
      name: 'cockpit exposes logical work progress',
      pass: Boolean(manifest && manifest.phases.length > 0),
      detail: manifest ? `${manifest.currentPhase ?? 'complete'} ${manifest.completed}/${manifest.total}` : 'manifest missing',
    },
    {
      name: 'cockpit manifest projection stays compact',
      pass: Boolean(manifest) && !Object.prototype.hasOwnProperty.call(manifest, 'items') && payloadBytes < 50_000,
      detail: `${payloadBytes} bytes; item graph ${manifest && Object.prototype.hasOwnProperty.call(manifest, 'items') ? 'present' : 'omitted'}`,
    },
  ];
}

export function localArtifactText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
