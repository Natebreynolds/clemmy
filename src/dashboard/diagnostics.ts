/**
 * Read-only diagnostics surface for the Settings "Show diagnostics"
 * toggle. Aggregates:
 *
 *   - today's tool-event ndjson: per-tool count, per-session count,
 *     batched-vs-loop pattern detector (so we can see whether a chat
 *     session used the fast batch pattern or the slow per-item loop);
 *   - recent supervisor.log error/warning lines, with the noisy
 *     updater XML dumps stripped (they bury everything else);
 *   - the MCP server health snapshot (already in-memory).
 *
 * No writes. No mutations. Safe to poll from the UI.
 *
 * Hidden behind a UI toggle so end users don't see it by default —
 * power users and beta testers flip "Show diagnostics" in Settings
 * to reveal the panel.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { listMcpServerHealth, type MCPServerHealthSnapshot } from '../runtime/mcp-namespace-shim.js';
import { readCachedScan } from '../runtime/cli-discovery.js';

const SUPERVISOR_LOG_PATH = path.join(BASE_DIR, 'logs', 'desktop', 'supervisor.log');
const TOOL_EVENTS_DIR = path.join(BASE_DIR, 'state', 'tool-events');

export interface DiagnosticsSummary {
  generatedAt: string;
  toolEvents: ToolEventsSummary;
  recentErrors: LogLine[];
  mcp: { servers: MCPServerHealthSnapshot[]; summary: McpHealthSummary };
  /** v0.5.21 Phase 2.5 — CLI discovery readiness chip in the
   *  diagnostics summary, mirroring the existing MCP-ready chip.
   *  count is the number of CLIs found on $PATH by the most recent
   *  scan; null when no scan has run yet. lastScannedAt is the ISO
   *  timestamp from the cli-discovery cache. */
  cli: { count: number | null; lastScannedAt: string | null };
  storage: StorageStats;
}

export interface ToolEventsSummary {
  date: string;
  totalEvents: number;
  totalSessions: number;
  unscopedEvents: number;
  byTool: Array<{ toolName: string; count: number }>;
  bySession: Array<{
    sessionId: string;
    eventCount: number;
    distinctTools: number;
    topTool: string;
    firstAt?: string;
    lastAt?: string;
    /** Heuristic: when a single tool is called >=5 times within one
     *  session, that's a per-row loop pattern. When events are <5 per
     *  tool but the session covered N tools each once, that's batch. */
    suspectedPattern: 'batch' | 'per-row-loop' | 'mixed' | 'small';
  }>;
}

export interface LogLine {
  at: string;
  level: 'warn' | 'error';
  source: string;
  message: string;
}

interface McpHealthSummary {
  total: number;
  connected: number;
  connecting: number;
  degraded: number;
  unavailable: number;
}

interface StorageStats {
  baseDir: string;
  supervisorLogSizeBytes: number;
  toolEventsTodayBytes: number;
  /** Number of *.json files under state/ — useful for the bundle UI. */
  stateJsonCount: number;
}

/** Today's tool-events ndjson filename, in UTC (matches the file the
 *  recorder writes to). */
function todayLogFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(TOOL_EVENTS_DIR, `${date}.ndjson`);
}

interface RawToolEvent {
  at?: string;
  sessionId?: string;
  toolName?: string;
  phase?: string;
  outcome?: string;
}

function readToolEventsFile(filePath: string, maxLines = 5000): RawToolEvent[] {
  if (!existsSync(filePath)) return [];
  // Read whole file but cap parsed lines so a busy day doesn't blow
  // up the diagnostics call. 5000 lines is enough to cover a typical
  // day for any one user.
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const start = Math.max(0, lines.length - maxLines);
  const events: RawToolEvent[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      events.push(JSON.parse(line) as RawToolEvent);
    } catch { /* skip malformed */ }
  }
  return events;
}

function summarizeToolEvents(): ToolEventsSummary {
  const filePath = todayLogFile();
  const events = readToolEventsFile(filePath);
  // Only count `phase: 'start'` records so we don't double-count
  // start+end as 2 events.
  const starts = events.filter((e) => e.phase === 'start' || e.phase === undefined);

  const date = new Date().toISOString().slice(0, 10);
  if (starts.length === 0) {
    return { date, totalEvents: 0, totalSessions: 0, unscopedEvents: 0, byTool: [], bySession: [] };
  }

  const byTool = new Map<string, number>();
  const bySession = new Map<string, RawToolEvent[]>();
  for (const e of starts) {
    const t = e.toolName || '<unknown>';
    byTool.set(t, (byTool.get(t) ?? 0) + 1);
    const sid = e.sessionId || 'unscoped';
    const bucket = bySession.get(sid) ?? [];
    bucket.push(e);
    bySession.set(sid, bucket);
  }

  const unscoped = (bySession.get('unscoped') ?? []).length + Array.from(bySession.keys()).filter((k) => k.startsWith('unscoped:')).reduce((sum, k) => sum + (bySession.get(k)?.length ?? 0), 0);

  const sessionsArr: ToolEventsSummary['bySession'] = Array.from(bySession.entries()).map(([sessionId, evs]) => {
    const toolCounts = new Map<string, number>();
    for (const e of evs) toolCounts.set(e.toolName || '?', (toolCounts.get(e.toolName || '?') ?? 0) + 1);
    const distinctTools = toolCounts.size;
    const topTool = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
    const maxToolCount = Math.max(...Array.from(toolCounts.values()));
    let suspectedPattern: ToolEventsSummary['bySession'][0]['suspectedPattern'];
    if (evs.length < 3) suspectedPattern = 'small';
    else if (maxToolCount >= 5 && distinctTools <= 2) suspectedPattern = 'per-row-loop';
    else if (distinctTools >= 3 && maxToolCount <= 3) suspectedPattern = 'batch';
    else suspectedPattern = 'mixed';
    return {
      sessionId,
      eventCount: evs.length,
      distinctTools,
      topTool,
      firstAt: evs[0]?.at,
      lastAt: evs[evs.length - 1]?.at,
      suspectedPattern,
    };
  }).sort((a, b) => b.eventCount - a.eventCount);

  const byToolArr = Array.from(byTool.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([toolName, count]) => ({ toolName, count }));

  return {
    date,
    totalEvents: starts.length,
    totalSessions: bySession.size,
    unscopedEvents: unscoped,
    byTool: byToolArr,
    bySession: sessionsArr,
  };
}

/**
 * Pull the last ~5000 lines of supervisor.log and return warn+error
 * level entries. Strips the giant electron-updater XML payloads that
 * the updater log emits when GitHub releases parse fails — those are
 * 50KB+ each and would bury everything useful. We keep the "updater
 * error" headline and drop the XML body.
 */
function readRecentErrors(limit = 50): LogLine[] {
  if (!existsSync(SUPERVISOR_LOG_PATH)) return [];
  const raw = readFileSync(SUPERVISOR_LOG_PATH, 'utf-8');
  const lines = raw.split('\n');
  // Tail the file — process backwards until we have `limit` matches.
  const out: LogLine[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      const level = typeof d.level === 'number' ? d.level : 0;
      if (level < 40) continue; // warn (40) or error (50) only
      let msg = String(d.msg ?? '');
      // Strip the electron-updater Atom feed XML dump.
      if (msg.includes('<feed xmlns=')) {
        msg = msg.split('XML:')[0].trim() + ' …[XML dump stripped]';
      }
      // Strip giant stack traces past the first 4 frames.
      if (msg.length > 400) msg = msg.slice(0, 400) + '…';
      out.push({
        at: d.time ? new Date(Number(d.time)).toISOString() : new Date().toISOString(),
        level: level >= 50 ? 'error' : 'warn',
        source: String(d.name ?? '?').replace(/^clementine-next\./, ''),
        message: msg,
      });
    } catch { /* skip malformed */ }
  }
  // Return in ascending time order so the dashboard renders oldest→newest.
  return out.reverse();
}

function readStorageStats(): StorageStats {
  let supervisorBytes = 0;
  let toolEventsBytes = 0;
  let stateJsonCount = 0;
  try { if (existsSync(SUPERVISOR_LOG_PATH)) supervisorBytes = statSync(SUPERVISOR_LOG_PATH).size; } catch { /* ignore */ }
  try {
    const tf = todayLogFile();
    if (existsSync(tf)) toolEventsBytes = statSync(tf).size;
  } catch { /* ignore */ }
  try {
    const stateDir = path.join(BASE_DIR, 'state');
    if (existsSync(stateDir)) {
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      for (const entry of readdirSync(stateDir)) {
        if (entry.endsWith('.json')) stateJsonCount += 1;
      }
    }
  } catch { /* ignore */ }
  return { baseDir: BASE_DIR, supervisorLogSizeBytes: supervisorBytes, toolEventsTodayBytes: toolEventsBytes, stateJsonCount };
}

export function collectDiagnostics(): DiagnosticsSummary {
  const servers = listMcpServerHealth();
  const mcpSummary: McpHealthSummary = {
    total: servers.length,
    connected: servers.filter((s) => s.state === 'connected').length,
    connecting: servers.filter((s) => s.state === 'connecting').length,
    degraded: servers.filter((s) => s.state === 'degraded').length,
    unavailable: servers.filter((s) => s.state === 'unavailable').length,
  };
  const cliScan = readCachedScan();
  return {
    generatedAt: new Date().toISOString(),
    toolEvents: summarizeToolEvents(),
    recentErrors: readRecentErrors(40),
    mcp: { servers, summary: mcpSummary },
    cli: {
      count: cliScan ? cliScan.clis.length : null,
      lastScannedAt: cliScan ? cliScan.scannedAt : null,
    },
    storage: readStorageStats(),
  };
}
