/**
 * Scenario 8 — workspace-build: THE creation wow, gated forever. One chat turn
 * asks Clem to build a small dynamic workspace over the proof-local,
 * provably-read-only Composio shim. The checks assert the result is a real,
 * working surface: manifest active, view served with the clem bridge, and data
 * pulled under the declared source id. This is the end-to-end pipeline
 * (write_file → space_save → read-only refresh → creation smoke → gap test)
 * that no unit test exercises with a live brain. Arbitrary data runners remain
 * forbidden by the production policy and are tested separately.
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from '../timeouts.js';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SLUG = 'proof-cockpit';
export const WORKSPACE_BUILD_SOURCE_ID = 'tasks';
export const WORKSPACE_BUILD_DATA_TOOL = 'PROOF_TASKS_LIST';

export function workspaceBuildPrompt(): string {
  return [
    `Build me a workspace with the EXACT slug "${SLUG}" titled "Proof Cockpit": a simple page listing the proof task feed.`,
    'Use exactly one dynamic data source with:',
    `- id: ${WORKSPACE_BUILD_SOURCE_ID}`,
    `- composio_slug: ${WORKSPACE_BUILD_DATA_TOOL}`,
    '- composio_args_json: {"scope":"isolated-proof"}',
    '- allow_empty: true',
    `The isolated proof runtime has ${WORKSPACE_BUILD_DATA_TOOL} connected to a local read-only shim; it reaches no real account or external service.`,
    `The authored view must load the declared source through clem.data() and read the exact "${WORKSPACE_BUILD_SOURCE_ID}" key.`,
    'Do not create or use a runner, do not perform any external write, and do not ask me anything first. Build and verify it now.',
  ].join('\n');
}

export const workspaceBuild: ScenarioDef = {
  name: 'workspace-build',
  summary: 'one ask → a live, data-connected workspace (creation pipeline end-to-end)',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-wsbuild-${Date.now().toString(36)}`;
    const connectionMarker = path.join(daemon.home, 'proof-composio-connected');
    writeFileSync(connectionMarker, 'connected\n', 'utf8');
    const refreshed = await daemon.request('POST', '/api/composio/refresh', {});

    try {
      const turn = await daemon.chat(
        workspaceBuildPrompt(),
        sessionId,
        PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
      );

      const checks: Check[] = [];
      checks.push({ name: 'proof-only read capability connected', pass: refreshed.status === 200, detail: `status ${refreshed.status}` });
      checks.push({ name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` });
      checks.push(reportBackCheck(turn.text));
      checks.push(narrationCheck(turn.text));
      checks.push(stormCheck(daemon.log()));

      // The workspace exists and is ACTIVE (a paused save = the pipeline parked it).
      const rec = await daemon.request('GET', `/api/console/spaces/${SLUG}`);
      const space = (rec.json ?? {}) as { id?: string; status?: string; dataSources?: unknown[]; space?: { id?: string; status?: string; dataSources?: unknown[] } };
      const record = (space.space ?? space) as {
        id?: string;
        status?: string;
        dataSources?: Array<{
          id?: string;
          runner?: string;
          composioSlug?: string;
          composio_slug?: string;
        }>;
      };
      checks.push({ name: 'workspace saved', pass: rec.status === 200 && record.id === SLUG, detail: `GET status ${rec.status}, id ${record.id ?? 'n/a'}` });
      checks.push({ name: 'workspace ACTIVE (creation smoke passed)', pass: record.status === 'active', detail: `status ${record.status ?? 'n/a'}` });
      const declaredSource = (record.dataSources ?? []).find((source) => source.id === WORKSPACE_BUILD_SOURCE_ID);
      checks.push({
        name: 'exact read-only data source is declared (dynamic, not a static page)',
        pass: record.dataSources?.length === 1
          && declaredSource?.id === WORKSPACE_BUILD_SOURCE_ID
          && (declaredSource.composioSlug ?? declaredSource.composio_slug) === WORKSPACE_BUILD_DATA_TOOL
          && !declaredSource.runner,
        detail: JSON.stringify(record.dataSources ?? null),
      });

      // The view actually serves — and is wired for the data plane (clem bridge
      // is injected at serve time; the authored HTML must READ its data).
      const view = await fetch(`${daemon.baseUrl}/console/spaces/${SLUG}/view`, {
        headers: { authorization: `Bearer ${daemon.secret}` },
      });
      const servedHtml = view.ok ? await view.text() : '';
      let authoredHtml = '';
      try {
        authoredHtml = readFileSync(path.join(daemon.home, 'spaces', SLUG, 'view', 'index.html'), 'utf-8');
      } catch { /* check below reports the miss */ }
      checks.push({
        name: 'view serves (HTTP 200, non-trivial HTML)',
        pass: view.ok && servedHtml.length > 200 && authoredHtml.length > 200,
        detail: `status ${view.status}, served ${servedHtml.length} bytes, authored ${authoredHtml.length} bytes`,
      });
      checks.push({
        name: 'authored view uses the canonical clem.data() bridge',
        pass: /\bclem\s*\.\s*data\s*\(/.test(authoredHtml),
        detail: /\bclem\s*\.\s*data\s*\(/.test(authoredHtml)
          ? undefined
          : 'authored view does not call clem.data() (served bridge injection cannot satisfy this check)',
      });
      checks.push({
        name: 'view has no broken relative data fetch',
        pass: !/\bfetch\s*\(\s*['"`](?:\.{1,2}\/)?data(?:\/|['"`?#])/i.test(authoredHtml),
        detail: 'relative fetch("./data/…") resolves below /view and returns 404',
      });

      const sourceIds = (record.dataSources ?? []).map((source) => source.id).filter((id): id is string => Boolean(id));
      const missingViewIds = sourceIds.filter((id) => !authoredHtml.includes(id));
      checks.push({
        name: 'view reads every declared source by its exact id',
        pass: sourceIds.length > 0 && missingViewIds.length === 0,
        detail: missingViewIds.length > 0 ? `missing ids: ${missingViewIds.join(', ')}` : `ids: ${sourceIds.join(', ')}`,
      });

      // The first pull landed under every declared key. Empty arrays are valid for
      // this scenario; absence of the key is not.
      const dataRes = await daemon.request('GET', `/api/console/spaces/${SLUG}/data`);
      const payload = (dataRes.json ?? {}) as { data?: Record<string, unknown> };
      const keys = Object.keys(payload.data ?? {}).filter((k) => !k.startsWith('_'));
      checks.push({
        name: 'first data pull persisted under every declared source id',
        pass: dataRes.status === 200 && sourceIds.length > 0 && sourceIds.every((id) => Object.hasOwn(payload.data ?? {}, id)),
        detail: `data keys: [${keys.join(', ')}]`,
      });

      let metrics = null;
      try {
        const db = openHarnessDb(daemon.home);
        metrics = sessionMetrics(db, turn.sessionId);
        db.close();
      } catch { /* fail closed below */ }
      checks.push({
        name: 'workspace build stayed free of external writes',
        pass: metrics != null && metrics.externalWrites === 0,
        detail: metrics ? `external_write × ${metrics.externalWrites}` : 'metrics unavailable',
      });
      checks.push({
        name: 'workspace authoring stays within a bounded tool budget',
        pass: metrics != null && metrics.toolCallTotal <= 24,
        detail: metrics ? `${metrics.toolCallTotal} tool calls (limit 24)` : 'metrics unavailable',
      });

      return {
        checks,
        latency: [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
        sessionId: turn.sessionId,
        metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal } : undefined,
      };
    } finally {
      rmSync(connectionMarker, { force: true });
      try { await daemon.request('POST', '/api/composio/refresh', {}); } catch { /* best-effort scenario isolation */ }
    }
  },
};
