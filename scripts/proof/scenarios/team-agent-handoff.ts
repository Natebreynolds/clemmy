/**
 * Scenario 9 — team-agent-handoff: the brain must create multiple durable team
 * agents, queue local inter-agent work, and report the persisted IDs. This is
 * the smallest hermetic proof of "Clementine can organize a team" without
 * firing real external writes.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { openHarnessDb, sessionMetrics, narrationCheck, reportBackCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const RESEARCHER = 'proof-researcher';
const BUILDER = 'proof-builder';

const PROMPT = [
  'Explicitly create/enable two active team agents now, using local team-agent tools only:',
  '1. Proof Researcher — durable research specialist. Slug should be proof-researcher. can_message=[proof-builder,clementine].',
  '2. Proof Builder — durable implementation specialist. Slug should be proof-builder. can_message=[proof-researcher,clementine].',
  '',
  'Then queue a structured team_request from Clementine to proof-researcher asking for exactly three implementation risks for an autonomy smoke test.',
  'Then delegate a task to proof-builder asking for a concise implementation checklist for the same smoke test.',
  '',
  'Do not use external services. Do not merely describe the plan. Actually create the two agents, queue the request, create the delegation, then report the two slugs plus the request ID and delegation ID.',
].join('\n');

function agentPath(home: string, slug: string): string {
  return path.join(home, 'vault', '00-System', 'agents', slug, 'agent.md');
}

function readJsonFiles<T>(dir: string): T[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try { return JSON.parse(readFileSync(path.join(dir, file), 'utf-8')) as T; }
        catch { return null; }
      })
      .filter((record): record is T => record !== null);
  } catch {
    return [];
  }
}

function readComms(home: string): Array<{ protocol?: string; toAgent?: string; fromAgent?: string; requestId?: string }> {
  try {
    return readFileSync(path.join(home, 'logs', 'team-comms.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as { protocol?: string; toAgent?: string; fromAgent?: string; requestId?: string }; }
        catch { return null; }
      })
      .filter((record): record is { protocol?: string; toAgent?: string; fromAgent?: string; requestId?: string } => record !== null);
  } catch {
    return [];
  }
}

function readToolAuditCounts(home: string, sessionId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const dir = path.join(home, 'state', 'tool-events');
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ndjson')) continue;
      for (const line of readFileSync(path.join(dir, file), 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { sessionId?: string; argsSummary?: string };
          if (record.sessionId !== sessionId) continue;
          const match = /\bsource_tool=([a-z0-9_]+)/.exec(record.argsSummary ?? '');
          if (match?.[1]) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
        } catch { /* skip malformed audit line */ }
      }
    }
  } catch { /* no audit dir */ }
  return counts;
}

function mergeToolCounts(primary: Record<string, number>, audit: Record<string, number>): Record<string, number> {
  const merged = { ...primary };
  for (const [tool, count] of Object.entries(audit)) {
    merged[tool] = Math.max(merged[tool] ?? 0, count);
  }
  return merged;
}

export const teamAgentHandoff: ScenarioDef = {
  name: 'team-agent-handoff',
  summary: 'create 2 agents → queue request + delegation → report IDs',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-team-${Date.now().toString(36)}`;
    const turn = await daemon.chat(PROMPT, sessionId, 600_000);

    const researcherPath = agentPath(daemon.home, RESEARCHER);
    const builderPath = agentPath(daemon.home, BUILDER);
    const researcherBody = existsSync(researcherPath) ? readFileSync(researcherPath, 'utf-8') : '';
    const builderBody = existsSync(builderPath) ? readFileSync(builderPath, 'utf-8') : '';
    const requests = readJsonFiles<{ id?: string; toAgent?: string; status?: string; content?: string }>(
      path.join(daemon.home, 'team-requests'),
    );
    const delegations = readJsonFiles<{ id?: string; toAgent?: string; status?: string; task?: string }>(
      path.join(daemon.home, 'delegations', BUILDER),
    );
    const comms = readComms(daemon.home);

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, turn.sessionId);
      db.close();
    } catch { /* checks below surface missing metrics */ }

    const request = requests.find((item) => item.toAgent === RESEARCHER);
    const delegation = delegations.find((item) => item.toAgent === BUILDER);
    const toolCalls = mergeToolCounts(metrics?.toolCalls ?? {}, readToolAuditCounts(daemon.home, turn.sessionId));

    const checks: Check[] = [];
    checks.push({ name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` });
    checks.push(reportBackCheck(turn.text));
    checks.push(narrationCheck(turn.text));
    checks.push(stormCheck(daemon.log()));
    checks.push({
      name: 'two durable team agents created',
      pass: existsSync(researcherPath) && existsSync(builderPath),
      detail: `researcher=${existsSync(researcherPath)} builder=${existsSync(builderPath)}`,
    });
    checks.push({
      name: 'agent permissions persisted',
      pass: /proof-builder/.test(researcherBody) && /proof-researcher/.test(builderBody),
      detail: 'expected reciprocal canMessage slugs in agent files',
    });
    checks.push({
      name: 'team_request persisted for researcher',
      pass: Boolean(request?.id),
      detail: request?.id ? `request ${request.id} status=${request.status ?? 'unknown'}` : `requests=${JSON.stringify(requests)}`,
    });
    checks.push({
      name: 'delegation persisted for builder',
      pass: Boolean(delegation?.id),
      detail: delegation?.id ? `delegation ${delegation.id} status=${delegation.status ?? 'unknown'}` : `delegations=${JSON.stringify(delegations)}`,
    });
    checks.push({
      name: 'team comms log records request',
      pass: comms.some((item) => item.protocol === 'request' && item.toAgent === RESEARCHER),
      detail: `comms=${JSON.stringify(comms.slice(-4))}`,
    });
    checks.push({
      name: 'brain used team tools',
      pass: (toolCalls.create_agent ?? 0) >= 2 && (toolCalls.team_request ?? 0) >= 1 && (toolCalls.delegate_task ?? 0) >= 1,
      detail: `tools=${JSON.stringify(toolCalls)}`,
    });
    checks.push({
      name: 'report includes durable IDs',
      pass: turn.text.includes(RESEARCHER) && turn.text.includes(BUILDER) && Boolean(request?.id && turn.text.includes(request.id)),
      detail: turn.text.slice(0, 260),
    });

    return {
      checks,
      latency: [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }],
      sessionId: turn.sessionId,
      metrics: metrics ? {
        turns: metrics.turns,
        toolCallTotal: Object.values(toolCalls).reduce((a, b) => a + b, 0),
        toolCalls,
        tokensUsed: metrics.tokensUsed,
        requestId: request?.id,
        delegationId: delegation?.id,
      } : undefined,
    };
  },
};
