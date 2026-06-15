/**
 * Live "see the agent working" trace for one board card. Compact by default
 * (a milestone timeline + current activity), expandable to the raw event
 * stream.
 *
 *  - background / run / execution cards stream the harness session over SSE,
 *    reusing runHarnessStream from lib/chat.ts (the same pipe chat uses).
 *  - workflow cards can't use that pipe (their steps run under per-step
 *    `workflow:<suffix>` sessions), so they poll the run-events endpoint.
 */
import { useEffect, useState } from 'react';
import { X, Radio, Wrench, CheckCircle2, AlertCircle, Hand, Cpu, Dot } from 'lucide-react';
import { runHarnessStream, humanHarnessText } from '@/lib/chat';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/cn';
import { StatusPill } from '@/components/ui/StatusPill';
import { cardTone, sourceLabel, type BoardCard } from '@/lib/board';
import type { HarnessEvent } from '@/lib/types';

interface TraceRow {
  key: string;
  icon: typeof Radio;
  label: string;
  detail?: string;
  time?: string | number;
  tone: 'live' | 'success' | 'danger' | 'warning' | 'muted';
}

const HARNESS_MILESTONES: Record<string, { label: string; icon: typeof Radio; tone: TraceRow['tone'] }> = {
  session_started: { label: 'Started', icon: Cpu, tone: 'muted' },
  model_started: { label: 'Thinking', icon: Cpu, tone: 'live' },
  turn_started: { label: 'Turn started', icon: Dot, tone: 'muted' },
  step_started: { label: 'Step', icon: Dot, tone: 'live' },
  tool_called: { label: 'Tool call', icon: Wrench, tone: 'live' },
  tool_started: { label: 'Tool call', icon: Wrench, tone: 'live' },
  tool_returned: { label: 'Tool result', icon: CheckCircle2, tone: 'success' },
  approval_requested: { label: 'Needs approval', icon: Hand, tone: 'warning' },
  awaiting_user_input: { label: 'Waiting on you', icon: Hand, tone: 'warning' },
  guardrail_tripped: { label: 'Guardrail', icon: AlertCircle, tone: 'warning' },
  run_failed: { label: 'Failed', icon: AlertCircle, tone: 'danger' },
  conversation_completed: { label: 'Completed', icon: CheckCircle2, tone: 'success' },
};

const WORKFLOW_MILESTONES: Record<string, { label: string; icon: typeof Radio; tone: TraceRow['tone'] }> = {
  run_started: { label: 'Run started', icon: Cpu, tone: 'muted' },
  step_started: { label: 'Step started', icon: Dot, tone: 'live' },
  step_completed: { label: 'Step done', icon: CheckCircle2, tone: 'success' },
  step_failed: { label: 'Step failed', icon: AlertCircle, tone: 'danger' },
  step_retry: { label: 'Retry', icon: Wrench, tone: 'warning' },
  tool_called: { label: 'Tool call', icon: Wrench, tone: 'live' },
  approval_requested: { label: 'Needs approval', icon: Hand, tone: 'warning' },
  run_completed: { label: 'Completed', icon: CheckCircle2, tone: 'success' },
  run_failed: { label: 'Failed', icon: AlertCircle, tone: 'danger' },
  run_cancelled: { label: 'Cancelled', icon: X, tone: 'muted' },
};

const toneText: Record<TraceRow['tone'], string> = {
  live: 'text-primary',
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-faint',
};

function toolName(data?: Record<string, unknown>): string {
  if (!data) return '';
  const n = (data.tool ?? data.name ?? data.toolName) as unknown;
  return typeof n === 'string' ? n : '';
}

export function LiveTraceDrawer({ card, onClose }: { card: BoardCard; onClose: () => void }) {
  const [rawHarness, setRawHarness] = useState<HarnessEvent[]>([]);
  const [rawWorkflow, setRawWorkflow] = useState<Array<Record<string, unknown>>>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [current, setCurrent] = useState<string>(card.progressHint || '');

  const isWorkflow = card.sourceKind === 'workflow';

  // Harness SSE for background / run / execution.
  useEffect(() => {
    if (isWorkflow || !card.sessionId) return;
    setRawHarness([]);
    const handle = runHarnessStream(card.sessionId, {
      onEvent: (ev) => {
        setRawHarness((prev) => (prev.length > 400 ? [...prev.slice(-400), ev] : [...prev, ev]));
        const text = humanHarnessText(ev.data, '');
        if (text) setCurrent(text);
      },
    });
    return () => handle.stop();
  }, [card.sessionId, isWorkflow]);

  // Run-events poll for workflow cards.
  useEffect(() => {
    if (!isWorkflow || !card.raw.workflowName || !card.raw.runId) return;
    let alive = true;
    let since = '';
    const tick = async () => {
      try {
        const url = `/api/console/workflows/${encodeURIComponent(card.raw.workflowName!)}/runs/${encodeURIComponent(card.raw.runId!)}/events${since ? `?since=${encodeURIComponent(since)}` : ''}`;
        const data = await apiGet<{ events: Array<Record<string, unknown>> }>(url);
        if (!alive) return;
        const fresh = data.events ?? [];
        if (fresh.length) {
          since = String(fresh[fresh.length - 1].t ?? since);
          setRawWorkflow((prev) => [...prev, ...fresh].slice(-400));
        }
      } catch { /* best effort */ }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [isWorkflow, card.raw.workflowName, card.raw.runId]);

  const rows: TraceRow[] = isWorkflow
    ? rawWorkflow.flatMap((ev, i) => {
        const kind = String(ev.kind ?? '');
        const m = WORKFLOW_MILESTONES[kind];
        if (!m) return [];
        const detail = [ev.stepId, ev.error].filter(Boolean).map(String).join(' — ');
        return [{ key: `wf-${i}`, icon: m.icon, label: m.label, detail, time: ev.t as string, tone: m.tone }];
      })
    : rawHarness.flatMap((ev) => {
        const m = HARNESS_MILESTONES[ev.type];
        if (!m) return [];
        const detail = ev.type.startsWith('tool') ? toolName(ev.data) : humanHarnessText(ev.data, '').slice(0, 140);
        return [{ key: `h-${ev.seq}`, icon: m.icon, label: m.label, detail, time: ev.createdAt, tone: m.tone }];
      });

  const tone = cardTone(card);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Live trace: ${card.title}`}>
      <div className="absolute inset-0 bg-black/30 animate-fade-in" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-xl flex-col border-l border-border bg-surface shadow-lg animate-fade-in">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-semibold text-muted">{sourceLabel(card.sourceKind)}</span>
              <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
            </div>
            <h3 className="mt-1.5 truncate text-h3 text-fg">{card.title}</h3>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-sm p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="border-b border-border px-5 py-3">
          <div className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
            <Radio className={cn('h-3.5 w-3.5', card.column === 'running' ? 'text-primary animate-breathe' : 'text-faint')} />
            Current
          </div>
          <p className="mt-1 text-body text-fg">{current || 'Waiting for activity…'}</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!showRaw ? (
            rows.length === 0 ? (
              <p className="text-body text-faint">No milestones yet — the trace streams in as the agent works.</p>
            ) : (
              <ol className="space-y-2.5">
                {rows.map((r) => {
                  const Icon = r.icon;
                  return (
                    <li key={r.key} className="flex items-start gap-2.5">
                      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', toneText[r.tone])} />
                      <div className="min-w-0">
                        <span className="text-body font-medium text-fg">{r.label}</span>
                        {r.detail && <span className="ml-2 text-body text-muted">{r.detail}</span>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-sm bg-canvas p-3 text-caption text-muted">
              {JSON.stringify(isWorkflow ? rawWorkflow : rawHarness, null, 2)}
            </pre>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-border px-5 py-3">
          <span className="text-caption text-faint">
            {isWorkflow ? `${rawWorkflow.length} events · polling` : card.sessionId ? `${rawHarness.length} events · live` : 'No live session'}
          </span>
          <button onClick={() => setShowRaw((v) => !v)} className="text-caption font-semibold text-primary hover:underline">
            {showRaw ? 'Show timeline' : 'Show raw events'}
          </button>
        </footer>
      </div>
    </div>
  );
}
