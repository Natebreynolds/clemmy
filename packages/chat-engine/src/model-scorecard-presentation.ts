import { modelDisplayName } from './model-name.js';

/**
 * What a role's model did lately, as the one line Settings shows under that
 * role on desktop and phone. Every number comes from the daemon's scorecard
 * (usage ledger + route metrics); a fact the ledgers do not have is left out,
 * never shown as zero.
 */

export interface ModelScoreRowLike {
  role: string;
  modelId: string;
  calls: number;
  failedCalls: number;
  cacheHitRate: number | null;
  latencyMs: { p50: number; p95: number } | null;
  reviewed: number;
  passed: number;
  toolTurns: number;
  toolTurnsLanded: number;
  fellOver: number;
  stoodIn: number;
}

export interface ModelScorecardLike {
  window: { days: number };
  rows: readonly ModelScoreRowLike[];
}

/** Below this many, a share reads better as "9 of 10" than as a percent. */
const COUNT_NOT_PERCENT = 20;

/** The row for the role's current model; when that model has not served the
 *  role in the window, the model that did the most of it. */
export function modelScoreRow(card: ModelScorecardLike | null | undefined, role: string, modelId?: string | null): ModelScoreRowLike | null {
  const rows = (card?.rows ?? []).filter((row) => row.role === role);
  if (rows.length === 0) return null;
  const current = modelId ? rows.find((row) => row.modelId === modelId) : undefined;
  return current ?? [...rows].sort((a, b) => b.calls - a.calls)[0]!;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

function share(part: number, whole: number, words: string): string {
  return whole < COUNT_NOT_PERCENT ? `${part} of ${whole} ${words}` : `${Math.round((part / whole) * 100)}% ${words}`;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * "This week: 430 calls · 9 of 10 passed review · 2.1 s typical · 81% cached".
 * Null when nothing at all has been measured (a new home says nothing rather
 * than a row of blanks); "not used" when other roles ran and this one did not.
 */
export function modelScoreLine(card: ModelScorecardLike | null | undefined, role: string, modelId?: string | null): string | null {
  if (!card || card.rows.length === 0) return null;
  const when = card.window.days === 7 ? 'This week' : `Last ${card.window.days} days`;
  const row = modelScoreRow(card, role, modelId);
  if (!row) return `${when}: not used.`;
  const on = modelId && row.modelId !== modelId ? ` on ${modelDisplayName(row.modelId)}` : '';
  const parts = [
    role === 'judge' ? plural(row.calls, 'check', 'checks') : plural(row.calls, 'call', 'calls'),
    row.failedCalls > 0 ? `${row.failedCalls.toLocaleString('en-US')} failed` : '',
    row.reviewed > 0 ? share(row.passed, row.reviewed, 'passed review') : '',
    row.toolTurns > 0 ? (row.toolTurns < COUNT_NOT_PERCENT
      ? `tools worked ${row.toolTurnsLanded} of ${row.toolTurns} times`
      : `tools worked ${Math.round((row.toolTurnsLanded / row.toolTurns) * 100)}% of the time`) : '',
    row.latencyMs ? `${seconds(row.latencyMs.p50)} typical` : '',
    row.cacheHitRate !== null && row.cacheHitRate >= 0.01 ? `${Math.round(row.cacheHitRate * 100)}% cached` : '',
    row.fellOver > 0 ? `fell back ${plural(row.fellOver, 'time', 'times')}` : '',
    row.stoodIn > 0 ? `stood in ${plural(row.stoodIn, 'time', 'times')}` : '',
  ].filter(Boolean);
  return `${when}${on}: ${parts.join(' · ')}`;
}
