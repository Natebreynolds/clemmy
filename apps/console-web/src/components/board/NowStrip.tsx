/**
 * NowStrip — a live one-line-per-lane rail of everything the daemon is running
 * RIGHT NOW, above the Tasks board. It rides the same operational-telemetry SSE
 * feed the ObservabilityView uses (lib/telemetry.subscribeTelemetry) and folds
 * events through the pure lib/activity-lanes reducer, so it shows swarm fan-out,
 * open tool calls, brain switches, and auto-continues as they happen — signal
 * the 4s board poll can't surface.
 *
 * Clicking a lane that maps to a board card opens the existing LiveTraceDrawer
 * (via the card's onOpen), so "watch it live" is one click from the rail.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Radio, Wrench, Users, GitBranch, RefreshCw, Hand } from 'lucide-react';
import { cn } from '@/lib/cn';
import { subscribeTelemetry } from '@/lib/telemetry';
import { foldOperationalEvent, lanesToSortedArray, type ActivityLane } from '@/lib/activity-lanes';
import type { BoardCard } from '@/lib/board';

/** Drop terminal lanes shortly after they finish, and stale non-terminal lanes,
 *  so the rail stays a "now" view and the map can't grow unbounded. */
const TERMINAL_KEEP_MS = 90_000;
const STALE_LANE_MS = 15 * 60_000;

function elapsedLabel(startedAt: string | undefined, nowMs: number): string {
  if (!startedAt) return '';
  const ms = nowMs - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return '<1m';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

function prune(lanes: Map<string, ActivityLane>, nowMs: number): void {
  for (const [key, lane] of lanes) {
    const age = nowMs - Date.parse(lane.lastEventAt);
    if (!Number.isFinite(age)) continue;
    if (lane.terminal && age > TERMINAL_KEEP_MS) lanes.delete(key);
    else if (!lane.terminal && age > STALE_LANE_MS) lanes.delete(key);
  }
}

export function NowStrip({ cards, onOpen }: { cards: BoardCard[]; onOpen: (card: BoardCard) => void }) {
  const lanesRef = useRef<Map<string, ActivityLane>>(new Map());
  const [rows, setRows] = useState<ActivityLane[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const refresh = () => {
      prune(lanesRef.current, Date.now());
      setRows(lanesToSortedArray(lanesRef.current).filter((l) => !l.terminal));
    };
    const unsub = subscribeTelemetry({
      onReplay: (events) => { for (const e of events) foldOperationalEvent(lanesRef.current, e); refresh(); },
      onEvent: (e) => { foldOperationalEvent(lanesRef.current, e); refresh(); },
    });
    // Tick elapsed labels (and re-prune) without needing a new event.
    const timer = window.setInterval(() => { setNowMs(Date.now()); refresh(); }, 30_000);
    return () => { unsub(); window.clearInterval(timer); };
  }, []);

  // Map a lane to a board card so a click can open the existing live drawer.
  const cardForLane = useMemo(() => {
    return (lane: ActivityLane): BoardCard | undefined =>
      cards.find((c) =>
        (!!lane.sessionId && c.sessionId === lane.sessionId)
        || (!!lane.workflowRunId && c.raw.runId === lane.workflowRunId));
  }, [cards]);

  if (rows.length === 0) return null;

  return (
    <section className="mb-4 rounded-lg border border-border bg-surface p-3" aria-label="Running now">
      <div className="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
        <Radio className="h-3.5 w-3.5 animate-breathe text-primary" />
        Now · {rows.length}
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((lane) => {
          const card = cardForLane(lane);
          const clickable = !!card;
          return (
            <li key={lane.key}>
              <div
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => onOpen(card!) : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(card!); } } : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-body',
                  clickable ? 'cursor-pointer hover:bg-hover' : 'cursor-default',
                )}
              >
                <span className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-semibold text-muted">{lane.kind}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{lane.title}</span>

                {lane.model && <span className="hidden text-caption text-faint sm:inline">{lane.model}</span>}

                {lane.openTool && (
                  <span className="inline-flex items-center gap-1 text-caption text-primary">
                    <Wrench className="h-3 w-3" />
                    <span className="max-w-[10rem] truncate">{lane.openTool.name}</span>
                    <Radio className="h-3 w-3 animate-breathe" />
                  </span>
                )}

                {(lane.workers.active > 0 || lane.workers.queued > 0 || lane.workers.failed > 0) && (
                  <span className="inline-flex items-center gap-1 text-caption text-muted" title="workers: active · queued · failed">
                    <Users className="h-3 w-3" />
                    {lane.workers.active > 0 && <span>{lane.workers.active}⚙</span>}
                    {lane.workers.queued > 0 && <span>{lane.workers.queued}⏳</span>}
                    {lane.workers.failed > 0 && <span className="text-danger">{lane.workers.failed}✕</span>}
                  </span>
                )}

                {lane.badges.fallover > 0 && (
                  <span className="inline-flex items-center gap-1 text-caption text-warning" title="brain switched">
                    <GitBranch className="h-3 w-3" />{lane.badges.fallover}
                  </span>
                )}
                {lane.badges.autoContinues > 0 && (
                  <span className="inline-flex items-center gap-1 text-caption text-faint" title="auto-continued">
                    <RefreshCw className="h-3 w-3" />{lane.badges.autoContinues}
                  </span>
                )}
                {lane.needsApproval && (
                  <span className="inline-flex items-center gap-1 text-caption text-warning" title="needs your approval">
                    <Hand className="h-3 w-3" />
                  </span>
                )}

                <span className="w-9 shrink-0 text-right text-caption text-faint">{elapsedLabel(lane.startedAt, nowMs)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
