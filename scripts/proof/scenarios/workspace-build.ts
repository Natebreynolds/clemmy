/**
 * Scenario 8 — workspace-build: THE creation wow, gated forever. One chat turn
 * asks Clem to build a small LOCAL-data workspace (no external systems — a
 * runner over her own task list), and the checks assert the result is a real,
 * working surface: manifest active, view served with the clem bridge, data
 * pulled or an honest gap question asked. This is the end-to-end pipeline
 * (write_file → space_save → auto-repair → creation smoke → gap test) that no
 * unit test exercises with a live brain.
 */
import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SLUG = 'proof-cockpit';

export const workspaceBuild: ScenarioDef = {
  name: 'workspace-build',
  summary: 'one ask → a live, data-connected workspace (creation pipeline end-to-end)',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-wsbuild-${Date.now().toString(36)}`;

    const turn = await daemon.chat(
      `Build me a workspace with the EXACT slug "${SLUG}" titled "Proof Cockpit": a simple page listing my open local tasks. `
      + 'Use a data source RUNNER that reads your local task list (or emits an empty list if there are none) — do NOT touch any external system, CLI login, or Composio app. '
      + 'Build it now without asking me anything first; make reasonable choices.',
      sessionId,
      600_000,
    );

    const checks: Check[] = [];
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
      dataSources?: Array<{ id?: string }>;
    };
    checks.push({ name: 'workspace saved', pass: rec.status === 200 && record.id === SLUG, detail: `GET status ${rec.status}, id ${record.id ?? 'n/a'}` });
    checks.push({ name: 'workspace ACTIVE (creation smoke passed)', pass: record.status === 'active', detail: `status ${record.status ?? 'n/a'}` });
    checks.push({
      name: 'a data source is declared (dynamic, not a static page)',
      pass: Array.isArray(record.dataSources) && record.dataSources.length > 0,
      detail: `dataSources: ${Array.isArray(record.dataSources) ? record.dataSources.length : 'n/a'}`,
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
  },
};
