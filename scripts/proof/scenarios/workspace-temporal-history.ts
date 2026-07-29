/**
 * Selectable Clementine 3.0 Workspace temporal-history proof.
 *
 * This scenario deliberately stays out of the default matrix until it has had
 * an all-brain soak. It uses only authenticated console APIs to create the
 * fixture and commit its two snapshots, restarts the real daemon, proves the
 * retained HTTP history/diff, and only then asks the selected brain to explain
 * the delta through the read-only `space_diff` tool.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

import { TOOL_REGISTRY } from '../../../src/tools/tool-registry.js';
import {
  narrationCheck,
  openHarnessDb,
  reportBackCheck,
  sessionMetrics,
  stormCheck,
  tokenCeilingCheck,
} from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const SLUG = 'proof-temporal-history';
const SOURCE_ID = '$document';
const MODEL_TOOL_LIMIT = 5;
const MODEL_TOKEN_LIMIT = 120_000;

export type TemporalScalar = string | number | boolean | null;

export interface TemporalReportedChange {
  id: string;
  field: string;
  before: TemporalScalar;
  after: TemporalScalar;
}

export const TEMPORAL_SNAPSHOT_BEFORE = {
  report: 'Proof campaign watch',
  accounts: [
    {
      id: 'northstar-ads',
      spend: 1200,
      conversions: 24,
      status: 'active',
    },
    {
      id: 'ember-search',
      spend: 800,
      conversions: 16,
      status: 'active',
    },
    {
      id: 'cedar-social',
      spend: 300,
      conversions: 6,
      status: 'active',
    },
  ],
  currency: 'USD',
} as const;

/**
 * Drop the reserved `_meta` provenance key so a committed snapshot can be
 * compared against what the caller actually sent. `_meta` is maintained by the
 * runner, is rejected as a source id by the store, and is stripped on publish.
 */
function withoutReservedMeta(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { _meta, ...sources } = value as Record<string, unknown>;
  void _meta;
  return sources;
}

export const TEMPORAL_SNAPSHOT_AFTER = {
  report: 'Proof campaign watch',
  accounts: [
    {
      id: 'northstar-ads',
      spend: 1375,
      conversions: 31,
      status: 'active',
    },
    {
      id: 'ember-search',
      spend: 800,
      conversions: 16,
      status: 'paused',
    },
    {
      id: 'cedar-social',
      spend: 300,
      conversions: 6,
      status: 'active',
    },
  ],
  currency: 'USD',
} as const;

export const EXPECTED_TEMPORAL_CHANGES: readonly TemporalReportedChange[] = [
  {
    id: 'ember-search',
    field: 'status',
    before: 'active',
    after: 'paused',
  },
  {
    id: 'northstar-ads',
    field: 'conversions',
    before: 24,
    after: 31,
  },
  {
    id: 'northstar-ads',
    field: 'spend',
    before: 1200,
    after: 1375,
  },
] as const;

const EXPECTED_HTTP_CHANGES = [
  {
    op: 'replace',
    path: '/accounts/@id=ember-search/status',
    entityKey: 'id=ember-search',
    before: '"active"',
    after: '"paused"',
  },
  {
    op: 'replace',
    path: '/accounts/@id=northstar-ads/conversions',
    entityKey: 'id=northstar-ads',
    before: '24',
    after: '31',
  },
  {
    op: 'replace',
    path: '/accounts/@id=northstar-ads/spend',
    entityKey: 'id=northstar-ads',
    before: '1200',
    after: '1375',
  },
] as const;

interface TemporalHistoryObservation {
  id?: unknown;
  sourceKey?: unknown;
  status?: unknown;
  changed?: unknown;
  cause?: unknown;
  observedAt?: unknown;
  previousObservationId?: unknown;
  isCurrent?: unknown;
}

interface TemporalHistoryResponse {
  observations?: unknown;
  hasMore?: unknown;
  sourceKey?: unknown;
}

interface Validation {
  pass: boolean;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): value is TemporalScalar {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function oneJsonDocument(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function changeKey(change: TemporalReportedChange): string {
  return JSON.stringify([change.id, change.field, change.before, change.after]);
}

/**
 * Strictly parse the live-brain report. Extra prose, extra object fields,
 * non-scalar values, duplicates, and stringified numbers are all rejected so a
 * superficially plausible answer cannot satisfy the grounded-delta proof.
 */
export function validateTemporalChangeReport(
  text: string,
  expected: readonly TemporalReportedChange[] = EXPECTED_TEMPORAL_CHANGES,
): Validation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(oneJsonDocument(text));
  } catch (error) {
    return {
      pass: false,
      detail: `reply is not one JSON document: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'changes') {
    return { pass: false, detail: 'reply must contain exactly one top-level "changes" field' };
  }
  if (!Array.isArray(parsed.changes)) {
    return { pass: false, detail: '"changes" is not an array' };
  }

  const reported: TemporalReportedChange[] = [];
  for (const [index, value] of parsed.changes.entries()) {
    if (
      !isRecord(value)
      || Object.keys(value).sort().join(',') !== 'after,before,field,id'
      || typeof value.id !== 'string'
      || typeof value.field !== 'string'
      || !isScalar(value.before)
      || !isScalar(value.after)
    ) {
      return {
        pass: false,
        detail: `changes[${index}] is not an exact {id,field,before,after} scalar record`,
      };
    }
    reported.push({
      id: value.id,
      field: value.field,
      before: value.before,
      after: value.after,
    });
  }

  const expectedKeys = [...expected].map(changeKey).sort();
  const reportedKeys = reported.map(changeKey).sort();
  const uniqueReported = new Set(reportedKeys);
  const pass = reportedKeys.length === expectedKeys.length
    && uniqueReported.size === reportedKeys.length
    && isDeepStrictEqual(reportedKeys, expectedKeys);
  return {
    pass,
    detail: pass
      ? `${reported.length} exact grounded changes`
      : `expected ${JSON.stringify(expectedKeys)}; received ${JSON.stringify(reportedKeys)}`,
  };
}

/** Validate the deterministic, user-facing HTTP diff independently of model
 * prose. The exact set check rejects missing, duplicated, or invented fields. */
export function validateTemporalHttpDiff(value: unknown): Validation {
  if (!isRecord(value) || value.status !== 'ok' || value.sourceKey !== SOURCE_ID) {
    return { pass: false, detail: `unexpected diff envelope: ${JSON.stringify(value).slice(0, 800)}` };
  }
  const diff = value.diff;
  if (!isRecord(diff) || diff.changed !== true || diff.truncated !== false) {
    return { pass: false, detail: `diff was absent, unchanged, or truncated: ${JSON.stringify(diff).slice(0, 800)}` };
  }
  if (
    !isRecord(diff.counts)
    || diff.counts.add !== 0
    || diff.counts.remove !== 0
    || diff.counts.replace !== EXPECTED_HTTP_CHANGES.length
    || !Array.isArray(diff.changes)
  ) {
    return { pass: false, detail: `unexpected diff counts: ${JSON.stringify(diff.counts)}` };
  }
  const expected = EXPECTED_HTTP_CHANGES.map((change) => JSON.stringify(change)).sort();
  const actual = diff.changes.map((change) => {
    if (!isRecord(change)) return JSON.stringify(change);
    return JSON.stringify({
      op: change.op,
      path: change.path,
      entityKey: change.entityKey,
      before: change.before,
      after: change.after,
    });
  }).sort();
  const pass = actual.length === expected.length
    && new Set(actual).size === actual.length
    && isDeepStrictEqual(actual, expected);
  return {
    pass,
    detail: pass
      ? `${actual.length} exact HTTP diff entries`
      : `expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`,
  };
}

const READ_CLASS_STATE_MUTATORS = new Set([
  'dispatch_background_task',
  'execution_create',
  'hold_task_for_later',
  'workflow_run',
]);

/**
 * Return every called tool that could mutate local or external state. Unknown
 * tools fail closed. `call_tool` is the one safe wrapper exception: its inner
 * call is independently present in the transport-mirror counts and classified.
 */
export function temporalMutationToolCalls(
  toolCalls: Readonly<Record<string, number>>,
): Record<string, number> {
  const declarations = new Map(TOOL_REGISTRY.map((entry) => [entry.name, entry]));
  const unsafe: Record<string, number> = {};
  for (const [name, count] of Object.entries(toolCalls)) {
    if (!Number.isFinite(count) || count <= 0 || name === 'call_tool') continue;
    const declaration = declarations.get(name);
    if (
      !declaration
      || declaration.sideEffect !== 'read'
      || declaration.loopClass === 'mutating'
      || READ_CLASS_STATE_MUTATORS.has(name)
    ) {
      unsafe[name] = count;
    }
  }
  return unsafe;
}

function historyObservations(value: unknown): TemporalHistoryObservation[] {
  if (!isRecord(value)) return [];
  const response = value as TemporalHistoryResponse;
  return Array.isArray(response.observations)
    ? response.observations.filter(isRecord)
    : [];
}

function historySignature(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    sourceKey: value.sourceKey,
    hasMore: value.hasMore,
    observations: historyObservations(value).map((observation) => ({
      id: observation.id,
      sourceKey: observation.sourceKey,
      status: observation.status,
      changed: observation.changed,
      cause: observation.cause,
      observedAt: observation.observedAt,
      previousObservationId: observation.previousObservationId,
      isCurrent: observation.isCurrent,
    })),
  };
}

function validateTwoObservationChain(value: unknown): Validation {
  const observations = historyObservations(value);
  const [current, prior] = observations;
  const pass = observations.length === 2
    && current?.sourceKey === SOURCE_ID
    && prior?.sourceKey === SOURCE_ID
    && current?.status === 'ok'
    && prior?.status === 'ok'
    && current?.changed === true
    && current?.cause === 'direct_put'
    && prior?.cause === 'direct_put'
    && current?.isCurrent === true
    && prior?.isCurrent === false
    && typeof current?.id === 'string'
    && typeof prior?.id === 'string'
    && current.previousObservationId === prior.id
    && prior.previousObservationId === null;
  return {
    pass,
    detail: JSON.stringify(historySignature(value)).slice(0, 1_500),
  };
}

function providerDispatchCount(home: string): number {
  const file = path.join(home, 'proof-composio-dispatches.log');
  if (!existsSync(file)) return 0;
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch {
    return -1;
  }
}

function approvalCount(value: unknown): number | null {
  if (!isRecord(value) || !Number.isInteger(value.count) || (value.count as number) < 0) return null;
  return value.count as number;
}

function requireStatus(
  label: string,
  response: { status: number; json: unknown },
  expected: number,
): void {
  if (response.status !== expected) {
    throw new Error(`${label} returned HTTP ${response.status}: ${JSON.stringify(response.json).slice(0, 1_000)}`);
  }
}

export function workspaceTemporalPrompt(slug: string): string {
  return [
    `What changed between the current successful observation and its immediately prior successful observation in Workspace "${slug}", source "${SOURCE_ID}"?`,
    `You MUST call the read-only space_diff tool with slug "${slug}" and source_id "${SOURCE_ID}". Do not infer a delta from memory or the current snapshot.`,
    'Do not call any mutating, external, connector, shell, workflow, worker, memory-write, or Workspace-write tool.',
    'Return only one compact JSON object with exactly this shape:',
    '{"changes":[{"id":"record-id","field":"field-name","before":0,"after":0}]}',
    'The example zeros only show the shape. Copy each real before/after JSON scalar from the tool result, preserving strings as strings and numbers as numbers.',
    'List every and only changed scalar field. No markdown, prose, summary, unchanged fields, or guesses.',
  ].join('\n');
}

export const workspaceTemporalHistory: ScenarioDef = {
  name: 'workspace-temporal-history',
  summary: 'two snapshots → real restart → exact HTTP + live-brain grounded diff',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const create = await daemon.request('POST', '/api/console/spaces', {
      slug: SLUG,
      title: 'Temporal History Proof',
      objective: 'Show exact retained campaign changes without taking action.',
      successCriteria: [
        'Current and prior successful observations remain queryable after restart.',
        'Changes are reported only from deterministic retained evidence.',
      ],
      invariants: [
        'Never mutate a connected system from a history question.',
      ],
    });
    requireStatus('workspace create', create, 201);

    const firstCommit = await daemon.request(
      'PUT',
      `/api/console/spaces/${SLUG}/data`,
      { data: TEMPORAL_SNAPSHOT_BEFORE },
    );
    requireStatus('first snapshot commit', firstCommit, 200);
    const secondCommit = await daemon.request(
      'PUT',
      `/api/console/spaces/${SLUG}/data`,
      { data: TEMPORAL_SNAPSHOT_AFTER },
    );
    requireStatus('second snapshot commit', secondCommit, 200);

    const historyPath =
      `/api/console/spaces/${SLUG}/history?sourceKey=${encodeURIComponent(SOURCE_ID)}&limit=10`;
    const diffPath =
      `/api/console/spaces/${SLUG}/diff?sourceKey=${encodeURIComponent(SOURCE_ID)}`;
    const historyBeforeRestart = await daemon.request('GET', historyPath);
    requireStatus('pre-restart history', historyBeforeRestart, 200);
    const preRestartChain = validateTwoObservationChain(historyBeforeRestart.json);
    if (!preRestartChain.pass) {
      throw new Error(`pre-restart observation chain invalid: ${preRestartChain.detail}`);
    }

    await daemon.restart();

    const historyAfterRestart = await daemon.request('GET', historyPath);
    const diffAfterRestart = await daemon.request('GET', diffPath);
    const dataAfterRestart = await daemon.request('GET', `/api/console/spaces/${SLUG}/data`);
    requireStatus('post-restart history', historyAfterRestart, 200);
    requireStatus('post-restart diff', diffAfterRestart, 200);
    requireStatus('post-restart current data', dataAfterRestart, 200);

    const approvalsBefore = await daemon.request('GET', '/api/console/approvals/list');
    requireStatus('pre-turn approvals', approvalsBefore, 200);
    const providerDispatchesBefore = providerDispatchCount(daemon.home);

    const sessionId = `proof-temporal-${Date.now().toString(36)}`;
    const turn = await daemon.chat(workspaceTemporalPrompt(SLUG), sessionId, 300_000);

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      db.close();
    } catch {
      // Fail-closed checks below surface missing telemetry.
    }

    const historyAfterTurn = await daemon.request('GET', historyPath);
    const diffAfterTurn = await daemon.request('GET', diffPath);
    const dataAfterTurn = await daemon.request('GET', `/api/console/spaces/${SLUG}/data`);
    const approvalsAfter = await daemon.request('GET', '/api/console/approvals/list');
    requireStatus('post-turn history', historyAfterTurn, 200);
    requireStatus('post-turn diff', diffAfterTurn, 200);
    requireStatus('post-turn current data', dataAfterTurn, 200);
    requireStatus('post-turn approvals', approvalsAfter, 200);

    const chainAfterRestart = validateTwoObservationChain(historyAfterRestart.json);
    const httpDiffAfterRestart = validateTemporalHttpDiff(diffAfterRestart.json);
    const httpDiffAfterTurn = validateTemporalHttpDiff(diffAfterTurn.json);
    const report = validateTemporalChangeReport(turn.text);
    const calls = metrics?.toolCalls ?? {};
    const logicalCalls = metrics?.logicalToolCalls ?? {};
    const mutationCalls = temporalMutationToolCalls(calls);
    const approvalsBeforeCount = approvalCount(approvalsBefore.json);
    const approvalsAfterCount = approvalCount(approvalsAfter.json);

    const checks: Check[] = [
      { name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` },
      reportBackCheck(turn.text),
      narrationCheck(turn.text),
      stormCheck(daemon.log()),
      {
        name: 'restart preserved exact observation ids and chain',
        pass: chainAfterRestart.pass
          && isDeepStrictEqual(
            historySignature(historyAfterRestart.json),
            historySignature(historyBeforeRestart.json),
          ),
        detail: chainAfterRestart.detail,
      },
      {
        name: 'authenticated HTTP diff is exact after restart',
        pass: httpDiffAfterRestart.pass,
        detail: httpDiffAfterRestart.detail,
      },
      {
        name: 'current projection survived restart exactly',
        // `_meta` is a reserved runner-provenance key the store maintains
        // alongside the committed sources (see spaces/store.ts + publish.ts);
        // it is never one of them. Compare the source keys exactly, the same
        // way space-smoke.ts filters it, instead of expecting the committed
        // snapshot to contain provenance the caller never sent.
        pass: isRecord(dataAfterRestart.json)
          && isDeepStrictEqual(withoutReservedMeta(dataAfterRestart.json.data), TEMPORAL_SNAPSHOT_AFTER),
        detail: JSON.stringify(dataAfterRestart.json).slice(0, 1_000),
      },
      {
        name: 'live brain called space_diff',
        pass: (calls.space_diff ?? 0) >= 1 && (calls.space_diff ?? 0) <= 2,
        detail: `space_diff × ${calls.space_diff ?? 0}; calls=${JSON.stringify(calls)}`,
      },
      {
        name: 'live brain reported every and only exact grounded change',
        pass: report.pass,
        detail: report.detail,
      },
      {
        name: 'live turn made no mutating tool call',
        pass: metrics != null && Object.keys(mutationCalls).length === 0,
        detail: metrics
          ? `mutating=${JSON.stringify(mutationCalls)}; calls=${JSON.stringify(calls)}`
          : 'session metrics unavailable',
      },
      {
        name: 'live turn made zero external writes or provider dispatches',
        pass: metrics != null
          && metrics.externalWrites === 0
          && providerDispatchesBefore >= 0
          && providerDispatchCount(daemon.home) === providerDispatchesBefore,
        detail: `external_write=${metrics?.externalWrites ?? 'n/a'}; provider dispatches ${providerDispatchesBefore}→${providerDispatchCount(daemon.home)}`,
      },
      {
        name: 'live turn created no approval',
        pass: approvalsBeforeCount != null
          && approvalsAfterCount != null
          && approvalsAfterCount === approvalsBeforeCount,
        detail: `pending approvals ${approvalsBeforeCount ?? 'n/a'}→${approvalsAfterCount ?? 'n/a'}`,
      },
      {
        name: 'live turn did not mutate Workspace data or history',
        pass: isDeepStrictEqual(
          historySignature(historyAfterTurn.json),
          historySignature(historyAfterRestart.json),
        )
          && isDeepStrictEqual(dataAfterTurn.json, dataAfterRestart.json)
          && httpDiffAfterTurn.pass
          && isDeepStrictEqual(diffAfterTurn.json, diffAfterRestart.json),
        detail: [
          `history stable=${isDeepStrictEqual(historySignature(historyAfterTurn.json), historySignature(historyAfterRestart.json))}`,
          `data stable=${isDeepStrictEqual(dataAfterTurn.json, dataAfterRestart.json)}`,
          `diff stable=${isDeepStrictEqual(diffAfterTurn.json, diffAfterRestart.json)}`,
        ].join('; '),
      },
      {
        name: `live turn stayed within ${MODEL_TOOL_LIMIT} model tool calls`,
        pass: metrics != null && metrics.toolCallTotal <= MODEL_TOOL_LIMIT,
        detail: metrics
          ? `${metrics.toolCallTotal} logical calls; ${JSON.stringify(logicalCalls)}`
          : 'session metrics unavailable',
      },
      tokenCeilingCheck(metrics, MODEL_TOKEN_LIMIT),
    ];

    return {
      checks,
      latency: [{
        wallMs: turn.wallMs,
        ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null,
      }],
      sessionId: turn.sessionId,
      metrics: metrics ? {
        turns: metrics.turns,
        tokensUsed: metrics.tokensUsed,
        toolCallTotal: metrics.toolCallTotal,
        toolCalls: calls,
        externalWrites: metrics.externalWrites,
      } : undefined,
    };
  },
};
