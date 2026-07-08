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
import { useEffect, useMemo, useState } from 'react';
import { X, Radio, Wrench, CheckCircle2, AlertCircle, Hand, Cpu, Dot, Users, GitBranch, RefreshCw, Layers, Upload, Play, Send, Save } from 'lucide-react';
import { runHarnessStream, humanHarnessText } from '@/lib/chat';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import { humanToolLabel, salientArgDetail, isHousekeepingTool } from '@/lib/toolLabels';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { WorkflowRunDetail } from '@/components/board/WorkflowRunDetail';
import { RunAgentsPanel } from '@/components/board/RunAgentsPanel';
import {
  cardTone,
  getBackgroundTaskDetail,
  listReportBackChannels,
  repostBackgroundTaskResult,
  repostBackgroundTaskResultByChannel,
  setBackgroundTaskReportBackChannel,
  setBackgroundTaskReportBackTarget,
  sourceLabel,
  type BackgroundReportBackTarget,
  type BackgroundReportBackTargetType,
  type BackgroundTaskNotification,
  type BoardButtonIntent,
  type BoardCard,
} from '@/lib/board';
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
  // Swarm + long-run milestones (already in the SSE pipe — just unmapped).
  worker_result: { label: 'Worker finished', icon: Users, tone: 'success' },
  worker_capped: { label: 'Worker hit turn cap', icon: Users, tone: 'warning' },
  brain_fallover: { label: 'Switched brain', icon: GitBranch, tone: 'warning' },
  sdk_auto_continue: { label: 'Auto-continued', icon: RefreshCw, tone: 'muted' },
  sdk_compact_boundary: { label: 'Compacted context', icon: Layers, tone: 'muted' },
  external_write: { label: 'External write', icon: Upload, tone: 'live' },
  external_write_orphaned: { label: 'Write timed out — may have landed', icon: AlertCircle, tone: 'warning' },
};

const WORKFLOW_MILESTONES: Record<string, { label: string; icon: typeof Radio; tone: TraceRow['tone'] }> = {
  run_started: { label: 'Run started', icon: Cpu, tone: 'muted' },
  step_started: { label: 'Step started', icon: Dot, tone: 'live' },
  step_completed: { label: 'Step done', icon: CheckCircle2, tone: 'success' },
  step_failed: { label: 'Step failed', icon: AlertCircle, tone: 'danger' },
  step_retry: { label: 'Retry', icon: Wrench, tone: 'warning' },
  step_advisory: { label: 'Note', icon: AlertCircle, tone: 'warning' },
  item_started: { label: 'Item started', icon: Dot, tone: 'live' },
  item_completed: { label: 'Item done', icon: CheckCircle2, tone: 'success' },
  item_failed: { label: 'Item failed', icon: AlertCircle, tone: 'danger' },
  tool_called: { label: 'Tool call', icon: Wrench, tone: 'live' },
  approval_requested: { label: 'Needs approval', icon: Hand, tone: 'warning' },
  run_summary: { label: 'Summary', icon: CheckCircle2, tone: 'success' },
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

function workflowDetail(ev: Record<string, unknown>): string {
  const kind = String(ev.kind ?? '');
  const stepId = typeof ev.stepId === 'string' ? ev.stepId : '';
  const itemKey = typeof ev.itemKey === 'string' ? ev.itemKey : '';
  const error = typeof ev.error === 'string' ? ev.error : '';
  const meta = ev.meta && typeof ev.meta === 'object' && !Array.isArray(ev.meta)
    ? ev.meta as Record<string, unknown>
    : {};
  if (kind === 'run_summary') {
    return [typeof meta.because === 'string' ? meta.because : '', workflowArtifactsText(meta.artifacts)]
      .filter(Boolean)
      .join(' · ');
  }
  if (kind === 'step_advisory') {
    return [stepId, typeof meta.reason === 'string' ? meta.reason : ''].filter(Boolean).join(' · ');
  }
  if (itemKey) return [stepId, itemKey, error].filter(Boolean).join(' — ');
  return [stepId, error].filter(Boolean).join(' — ');
}

function workflowArtifactsText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const artifacts = value as { counts?: unknown; files?: unknown; urls?: unknown };
  const parts = [
    ...(Array.isArray(artifacts.counts) ? artifacts.counts.map(String) : []),
    ...(Array.isArray(artifacts.files) ? artifacts.files.map(String) : []),
    ...(Array.isArray(artifacts.urls) ? artifacts.urls.map(String) : []),
  ];
  return parts.slice(0, 3).join(' · ');
}

// Structural workflow events (steps, run lifecycle, attempts, advisories,
// synthesis) that WorkflowRunDetail folds the timeline from — never window
// these out. Only the noisy high-frequency kinds (item_*, tool_*, heartbeat)
// get trimmed once the buffer exceeds the cap.
const WORKFLOW_IMPORTANT_KIND = /^(step_|run_|attempt|advisory|synthesis)/;
const WORKFLOW_EVENT_CAP = 400;

/** Cap the workflow event buffer at WORKFLOW_EVENT_CAP, but evict only the
 *  OLDEST noisy events — every structural event is retained so a long forEach
 *  can't push the first steps out of the folded detail. Chronological order is
 *  preserved (we drop from the front of the noisy stream, in place). */
function trimWorkflowEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (events.length <= WORKFLOW_EVENT_CAP) return events;
  let noisy = 0;
  for (const ev of events) if (!WORKFLOW_IMPORTANT_KIND.test(String(ev.kind ?? ''))) noisy += 1;
  let drop = noisy - Math.max(0, WORKFLOW_EVENT_CAP - (events.length - noisy));
  if (drop <= 0) return events; // all-important overflow: keep everything
  const out: Array<Record<string, unknown>> = [];
  for (const ev of events) {
    if (drop > 0 && !WORKFLOW_IMPORTANT_KIND.test(String(ev.kind ?? ''))) { drop -= 1; continue; }
    out.push(ev);
  }
  return out;
}

function formatTime(value?: string): string {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Human elapsed for the vitals timer: <1m shows seconds, then m/s, then h/m. */
function formatElapsed(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${String(sec).padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${String(min % 60).padStart(2, '0')}m`;
}

/** Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M". */
function formatTokens(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function reportBackTargetText(target?: BackgroundReportBackTarget): string {
  if (!target) return 'this chat';
  if (target.type === 'slack_user') return `Slack DM ${target.userId ?? ''}`.trim();
  if (target.type === 'slack_channel') return `Slack channel ${target.channelId ?? ''}${target.threadTs ? ` · ${target.threadTs}` : ''}`.trim();
  if (target.type === 'discord_user') return `Discord DM ${target.userId ?? ''}`.trim();
  return `Discord channel ${target.channelId ?? ''}`.trim();
}

function targetValue(target?: BackgroundReportBackTarget): string {
  return target?.userId ?? target?.channelId ?? '';
}

function targetThread(target?: BackgroundReportBackTarget): string {
  return target?.type === 'slack_channel' ? target.threadTs ?? '' : '';
}

function buildReportBackTarget(type: BackgroundReportBackTargetType, value: string, threadTs: string): BackgroundReportBackTarget | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (type === 'slack_user' || type === 'discord_user') return { type, userId: trimmed };
  if (type === 'slack_channel') {
    const thread = threadTs.trim();
    return { type, channelId: trimmed, ...(thread ? { threadTs: thread } : {}) };
  }
  return { type, channelId: trimmed };
}

/**
 * Render a delivery entry by its TRUE state, not a perpetual "queued" chip.
 * Prefers the backend-persisted `state` when present, else derives one from the
 * timestamp/error fields so older rows still read truthfully:
 *   sent → "delivered to Discord DM · 9:31 PM"   failed → the reason
 *   pending → "sending…"
 */
function deliveryView(n: BackgroundTaskNotification): { tone: Tone; label: string; detail: string } {
  const state = String(n.state ?? '').toLowerCase();
  const hasLanded = Boolean(n.deliveredAt) || Boolean(n.deliveredDestinations?.length);
  const isFailed = state === 'failed' || state === 'error' || (!state && Boolean(n.deliveryError) && !hasLanded);
  const isSent = state === 'sent' || state === 'delivered' || (!state && hasLanded);
  const dest = n.deliveredDestinations?.join(', ') || n.channelLabel || '';
  const when = n.deliveredAt ? formatTime(n.deliveredAt) : '';

  if (isFailed) {
    return { tone: 'danger', label: 'failed', detail: n.deliveryError || 'Couldn’t deliver.' };
  }
  if (isSent) {
    const detail = [dest ? `delivered to ${dest}` : 'delivered', when].filter(Boolean).join(' · ');
    // A row that landed but still carries an error was retried — flag it amber.
    return { tone: n.deliveryError ? 'warning' : 'success', label: 'delivered', detail };
  }
  return { tone: 'neutral', label: 'sending…', detail: 'Sending…' };
}

export function LiveTraceDrawer({
  card,
  onClose,
  onAction,
}: {
  card: BoardCard;
  onClose: () => void;
  onAction?: (card: BoardCard, intent: BoardButtonIntent) => void;
}) {
  const [rawHarness, setRawHarness] = useState<HarnessEvent[]>([]);
  const [rawWorkflow, setRawWorkflow] = useState<Array<Record<string, unknown>>>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [current, setCurrent] = useState<string>(card.progressHint || '');
  const [targetType, setTargetType] = useState<BackgroundReportBackTargetType>('slack_user');
  const [targetId, setTargetId] = useState('');
  const [targetThreadTs, setTargetThreadTs] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [targetNotice, setTargetNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [channelKey, setChannelKey] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  // A finished run loses its `sourceKind === 'workflow'` tag but still carries a
  // runId + workflow reference — treat those as workflow cards too, else the
  // drawer opens EMPTY for completed workflows (the structured detail never
  // renders because it falls into the harness-SSE branch with no session).
  const isWorkflow =
    card.sourceKind === 'workflow' ||
    Boolean(card.raw.runId && (card.raw.workflowSlug || card.raw.workflowName));
  const isBackground = card.sourceKind === 'background';

  useEffect(() => {
    setCurrent(card.progressHint || '');
  }, [card.id, card.progressHint]);

  const backgroundDetail = usePoll(
    ['background-task-detail', card.id],
    () => getBackgroundTaskDetail(card.id),
    4000,
    { enabled: isBackground },
  );
  const taskDetail = backgroundDetail.data;

  // Report-back channels for the dropdown. Fetched once (interval 0) so a 404
  // — until the backend ships the endpoint — doesn't spam. On any error we fall
  // back to the legacy free-text target controls so the drawer never breaks.
  const channelsQ = usePoll(['report-back-channels'], listReportBackChannels, 0, { enabled: isBackground });
  const channels = channelsQ.data?.channels ?? [];
  const useChannelDropdown = isBackground && channelsQ.isSuccess && channels.length > 0;
  const connectedChannels = useMemo(() => channels.filter((c) => c.connected), [channels]);
  const selectedChannel = channels.find((c) => c.key === channelKey);

  // Tick a 1s clock while a background task is still running so the elapsed
  // vitals timer moves between the 4s detail polls (server sends the authoritative
  // elapsedMs; we tick up from the task's start timestamp locally).
  const taskRunning = Boolean(taskDetail && taskDetail.vitals?.running !== false && !taskDetail.task.completedAt);
  useEffect(() => {
    if (!isBackground || !taskRunning) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isBackground, taskRunning]);

  const elapsedMs = useMemo(() => {
    if (!taskDetail) return undefined;
    const startBasis = taskDetail.task.startedAt ?? taskDetail.task.createdAt;
    const startMs = startBasis ? Date.parse(startBasis) : NaN;
    if (taskRunning && Number.isFinite(startMs)) return Math.max(0, nowMs - startMs);
    // Terminal (or missing timestamp): trust the server's frozen value.
    return taskDetail.vitals?.elapsedMs;
  }, [taskDetail, taskRunning, nowMs]);

  useEffect(() => {
    if (!taskDetail?.task.reportBackTarget) return;
    const target = taskDetail.task.reportBackTarget;
    const key = `${target.type}:${targetValue(target)}:${targetThread(target)}`;
    if (key === targetKey) return;
    setTargetType(target.type);
    setTargetId(targetValue(target));
    setTargetThreadTs(targetThread(target));
    setTargetKey(key);
  }, [targetKey, taskDetail?.task.reportBackTarget]);

  const cockpitTarget = useMemo(
    () => buildReportBackTarget(targetType, targetId, targetThreadTs),
    [targetId, targetThreadTs, targetType],
  );

  // Preselect the default channel once channels load (and there's no pick yet).
  useEffect(() => {
    if (!useChannelDropdown || channelKey) return;
    const preferred = channels.find((c) => c.isDefault && c.connected)
      ?? channels.find((c) => c.isDefault)
      ?? connectedChannels[0]
      ?? channels[0];
    if (preferred) setChannelKey(preferred.key);
  }, [useChannelDropdown, channelKey, channels, connectedChannels]);

  const saveTarget = async () => {
    if (!cockpitTarget) {
      setTargetNotice({ tone: 'danger', text: 'Target ID required.' });
      return;
    }
    try {
      const response = await setBackgroundTaskReportBackTarget(card.id, cockpitTarget);
      if (!response.ok) {
        setTargetNotice({ tone: 'danger', text: response.reason ?? 'Could not save target.' });
        return;
      }
      setTargetNotice({ tone: 'success', text: 'Report-back target saved.' });
      void backgroundDetail.refetch();
    } catch (err) {
      setTargetNotice({ tone: 'danger', text: err instanceof Error ? err.message : 'Could not save target.' });
    }
  };

  const repostResult = async () => {
    if (!cockpitTarget) {
      setTargetNotice({ tone: 'danger', text: 'Target ID required.' });
      return;
    }
    try {
      const response = await repostBackgroundTaskResult(card.id, cockpitTarget);
      if (!response.ok) {
        setTargetNotice({ tone: 'danger', text: response.reason ?? 'Could not repost result.' });
        return;
      }
      setTargetNotice({ tone: 'success', text: 'Result queued for delivery.' });
      void backgroundDetail.refetch();
    } catch (err) {
      setTargetNotice({ tone: 'danger', text: err instanceof Error ? err.message : 'Could not repost result.' });
    }
  };

  const saveChannel = async () => {
    if (!channelKey) {
      setTargetNotice({ tone: 'danger', text: 'Pick a channel first.' });
      return;
    }
    try {
      const response = await setBackgroundTaskReportBackChannel(card.id, channelKey);
      if (!response.ok) {
        setTargetNotice({ tone: 'danger', text: response.reason ?? 'Could not save target.' });
        return;
      }
      setTargetNotice({ tone: 'success', text: 'Report-back target saved.' });
      void backgroundDetail.refetch();
    } catch (err) {
      setTargetNotice({ tone: 'danger', text: err instanceof Error ? err.message : 'Could not save target.' });
    }
  };

  const repostChannel = async () => {
    if (!channelKey) {
      setTargetNotice({ tone: 'danger', text: 'Pick a channel first.' });
      return;
    }
    try {
      const response = await repostBackgroundTaskResultByChannel(card.id, channelKey);
      if (!response.ok) {
        setTargetNotice({ tone: 'danger', text: response.reason ?? 'Could not repost result.' });
        return;
      }
      setTargetNotice({ tone: 'success', text: 'Result queued for delivery.' });
      void backgroundDetail.refetch();
    } catch (err) {
      setTargetNotice({ tone: 'danger', text: err instanceof Error ? err.message : 'Could not repost result.' });
    }
  };

  // The session whose live event feed this drawer shows. Background tasks run
  // under a dedicated `runSessionId` — NOT their origin/chat `sessionId` — so we
  // stream that; otherwise the cockpit shows chat-reflection noise while the
  // Goal card (which already keys off the run session) shows the real work. This
  // is the unification: cockpit + the SAME live feed the goal/trace view shows.
  const traceSessionId = isWorkflow
    ? null
    : isBackground
      ? (taskDetail?.task.runSessionId || card.sessionId)
      : card.sessionId;

  // Harness SSE for background / run / execution.
  useEffect(() => {
    if (!traceSessionId) return;
    setRawHarness([]);
    const handle = runHarnessStream(traceSessionId, {
      onEvent: (ev) => {
        setRawHarness((prev) => (prev.length > 400 ? [...prev.slice(-400), ev] : [...prev, ev]));
        const text = humanHarnessText(ev.data, '');
        if (text) setCurrent(text);
      },
    });
    return () => handle.stop();
  }, [traceSessionId]);

  // Run-events poll for workflow cards.
  useEffect(() => {
    setRawWorkflow([]);
    const workflowRef = card.raw.workflowSlug || card.raw.workflowName;
    if (!isWorkflow || !workflowRef || !card.raw.runId) return;
    let alive = true;
    let since = '';
    const tick = async () => {
      try {
        const url = `/api/console/workflows/${encodeURIComponent(workflowRef)}/runs/${encodeURIComponent(card.raw.runId!)}/events${since ? `?since=${encodeURIComponent(since)}` : ''}`;
        const data = await apiGet<{ events: Array<Record<string, unknown>> }>(url);
        if (!alive) return;
        const fresh = data.events ?? [];
        if (fresh.length) {
          since = String(fresh[fresh.length - 1].t ?? since);
          setRawWorkflow((prev) => trimWorkflowEvents([...prev, ...fresh]));
          const latest = fresh[fresh.length - 1];
          const latestKind = String(latest.kind ?? '');
          const label = WORKFLOW_MILESTONES[latestKind]?.label ?? latestKind.replace(/_/g, ' ');
          const detail = workflowDetail(latest);
          setCurrent([label, detail].filter(Boolean).join(': '));
        }
      } catch { /* best effort */ }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [isWorkflow, card.raw.workflowName, card.raw.workflowSlug, card.raw.runId]);

  const rows: TraceRow[] = isWorkflow
    ? rawWorkflow.flatMap((ev, i) => {
        const kind = String(ev.kind ?? '');
        const m = WORKFLOW_MILESTONES[kind];
        if (!m) return [];
        const detail = workflowDetail(ev);
        return [{ key: `wf-${i}`, icon: m.icon, label: m.label, detail, time: ev.t as string, tone: m.tone }];
      })
    : rawHarness.flatMap((ev) => {
        const m = HARNESS_MILESTONES[ev.type];
        if (!m) return [];
        const tName = toolName(ev.data);
        // Hide the brain's own bookkeeping ("reflection end", tool-choice scoring)
        // — those aren't actions the user asked for.
        if (ev.type.startsWith('tool') && isHousekeepingTool(tName)) return [];
        const detail = ev.type.startsWith('tool') ? humanToolLabel(tName) : humanHarnessText(ev.data, '').slice(0, 140);
        return [{ key: `h-${ev.seq}`, icon: m.icon, label: m.label, detail, time: ev.createdAt, tone: m.tone }];
      });

  const tone = cardTone(card);
  const taskResult = taskDetail?.task.resultFull ?? taskDetail?.task.result ?? '';

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

        {isBackground && (
          <div className="border-b border-border px-5 py-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-small font-semibold text-fg">Task cockpit</div>
                <div className="text-caption text-faint">{taskDetail?.task.id ?? card.id}</div>
              </div>
              {onAction && (
                <div className="flex flex-wrap gap-2">
                  {card.primaryAction === 'continue' && (
                    <Button size="sm" onClick={() => onAction(card, 'resume')}>
                      <Play className="h-4 w-4" aria-hidden /> Continue
                    </Button>
                  )}
                  {card.actions.includes('cancel') && (
                    <Button size="sm" variant="secondary" onClick={() => onAction(card, 'cancel')}>
                      <X className="h-4 w-4" aria-hidden /> Cancel
                    </Button>
                  )}
                </div>
              )}
            </div>

            {backgroundDetail.isLoading && !taskDetail ? (
              <p className="text-body text-faint">Loading task details…</p>
            ) : taskDetail ? (
              <div className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-3">
                  <CockpitMetric label="Status" value={taskDetail.task.status} />
                  <CockpitMetric
                    label="Elapsed"
                    value={formatElapsed(elapsedMs)}
                    live={taskRunning}
                  />
                  <CockpitMetric label="Tool calls" value={String(taskDetail.vitals?.toolCallCount ?? taskDetail.detail.toolEvents.length)} />
                  {taskDetail.vitals?.tokensUsed !== undefined && (
                    <CockpitMetric label="Tokens" value={formatTokens(taskDetail.vitals.tokensUsed)} />
                  )}
                  <CockpitMetric
                    label="Report back"
                    value={useChannelDropdown
                      ? (selectedChannel?.label ?? channels.find((c) => c.isDefault)?.label ?? 'this chat')
                      : reportBackTargetText(taskDetail.task.reportBackTarget)}
                  />
                  <CockpitMetric label="Updated" value={formatTime(taskDetail.task.updatedAt)} />
                </div>

                {(taskDetail.task.pendingQuestion || taskDetail.task.pendingApprovalId || taskDetail.task.error || taskDetail.detail.latestActivitySummary) && (
                  <div className="rounded-md border border-border bg-subtle px-3 py-2.5">
                    {taskDetail.task.pendingQuestion && (
                      <div className="mb-2">
                        <div className="text-caption font-semibold text-warning">Needs input</div>
                        <div className="text-small text-fg">{taskDetail.task.pendingQuestion}</div>
                      </div>
                    )}
                    {taskDetail.task.pendingApprovalId && (
                      <div className="mb-2">
                        <div className="text-caption font-semibold text-warning">Needs approval</div>
                        <div className="text-small text-fg">{taskDetail.task.pendingApprovalId}</div>
                      </div>
                    )}
                    {taskDetail.task.error && (
                      <div className="mb-2">
                        <div className="text-caption font-semibold text-danger">Error</div>
                        <div className="text-small text-fg">{taskDetail.task.error}</div>
                      </div>
                    )}
                    {taskDetail.detail.latestActivitySummary && (
                      <div>
                        <div className="text-caption font-semibold text-faint">Latest activity</div>
                        <div className="text-small text-fg">{taskDetail.detail.latestActivitySummary}</div>
                      </div>
                    )}
                  </div>
                )}

                <div className="rounded-md border border-border px-3 py-3">
                  <div className="mb-2 flex items-center gap-2 text-small font-semibold text-fg">
                    <Send className="h-4 w-4" aria-hidden /> Report-back target
                  </div>
                  {useChannelDropdown ? (
                    <>
                      <p className="mb-2 text-caption text-muted">
                        Reports back to:{' '}
                        <span className="font-semibold text-fg">{selectedChannel?.label ?? 'this chat'}</span>
                      </p>
                      <Select
                        value={channelKey}
                        onChange={(e) => setChannelKey(e.target.value)}
                        aria-label="Report-back channel"
                      >
                        {channels.map((c) => (
                          <option key={c.key} value={c.key} disabled={!c.connected}>
                            {c.label}{c.isDefault ? ' (default)' : ''}{c.connected ? '' : ' — not connected'}
                          </option>
                        ))}
                      </Select>
                    </>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Select value={targetType} onChange={(e) => setTargetType(e.target.value as BackgroundReportBackTargetType)} aria-label="Report-back target type">
                        <option value="slack_user">Slack DM</option>
                        <option value="slack_channel">Slack channel</option>
                        <option value="discord_user">Discord DM</option>
                        <option value="discord_channel">Discord channel</option>
                      </Select>
                      <Input
                        value={targetId}
                        onChange={(e) => setTargetId(e.target.value)}
                        placeholder={targetType.endsWith('_user') ? 'User ID' : 'Channel ID'}
                        aria-label="Report-back target ID"
                      />
                      {targetType === 'slack_channel' && (
                        <Input
                          value={targetThreadTs}
                          onChange={(e) => setTargetThreadTs(e.target.value)}
                          placeholder="Thread timestamp"
                          aria-label="Slack thread timestamp"
                          className="sm:col-span-2"
                        />
                      )}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void (useChannelDropdown ? saveChannel() : saveTarget())}>
                      <Save className="h-4 w-4" aria-hidden /> Save target
                    </Button>
                    <Button size="sm" onClick={() => void (useChannelDropdown ? repostChannel() : repostResult())} disabled={!taskResult}>
                      <Send className="h-4 w-4" aria-hidden /> Repost result
                    </Button>
                    {targetNotice && (
                      <span className={cn('text-caption', targetNotice.tone === 'danger' ? 'text-danger' : 'text-success')}>
                        {targetNotice.text}
                      </span>
                    )}
                  </div>
                </div>

                {taskResult && (
                  <div>
                    <div className="mb-1 text-small font-semibold text-fg">Result</div>
                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-3 text-caption text-muted">
                      {taskResult.slice(0, 4000)}
                    </pre>
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-small font-semibold text-fg">Tools</div>
                    {(() => {
                      // Hide the brain's own bookkeeping (reflection, tool-choice
                      // scoring); show real tools humanized like the chat strip.
                      const realTools = taskDetail.detail.toolEvents.filter((e) => !isHousekeepingTool(e.toolName));
                      if (realTools.length === 0) {
                        return <div className="rounded-md border border-border px-3 py-2 text-caption text-faint">No tool events.</div>;
                      }
                      return (
                        <ul className="space-y-1.5">
                          {realTools.slice(-5).map((event) => (
                            <li key={`${event.at}-${event.toolName}-${event.phase ?? ''}`} className="rounded-md border border-border px-2.5 py-2 text-caption">
                              <div className="truncate font-semibold text-fg">{humanToolLabel(event.toolName, event.argsSummary)}</div>
                              <div className="truncate text-faint">{event.errorMessage ?? (salientArgDetail(event.argsSummary) || event.outcome || formatTime(event.at))}</div>
                            </li>
                          ))}
                        </ul>
                      );
                    })()}
                  </div>
                  <div>
                    <div className="mb-1 text-small font-semibold text-fg">Delivery</div>
                    {taskDetail.detail.notifications.length === 0 ? (
                      <div className="rounded-md border border-border px-3 py-2 text-caption text-faint">No notifications.</div>
                    ) : (
                      <ul className="space-y-1.5">
                        {taskDetail.detail.notifications.slice(-5).map((notification) => {
                          const dv = deliveryView(notification);
                          return (
                            <li key={notification.id} className="rounded-md border border-border px-2.5 py-2 text-caption">
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0 truncate font-semibold text-fg">{notification.title}</div>
                                <StatusPill tone={dv.tone}>{dv.label}</StatusPill>
                              </div>
                              <div className="truncate text-faint">{dv.detail}</div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-body text-danger">Task details unavailable.</p>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!showRaw ? (
            isWorkflow ? (
              // Workflow runs get the structured, step-grouped detail (timeline +
              // attempts + advisories + summary + per-step tokens) — the flat
              // milestone list above can't express a finished run's depth.
              <>
                <WorkflowRunDetail events={rawWorkflow} />
                {(card.raw.workflowSlug || card.raw.workflowName) && card.raw.runId && (
                  <RunAgentsPanel
                    slug={String(card.raw.workflowSlug || card.raw.workflowName)}
                    runId={String(card.raw.runId)}
                  />
                )}
              </>
            ) : rows.length === 0 ? (
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
            {isWorkflow ? `${rawWorkflow.length} events · polling` : traceSessionId ? `${rawHarness.length} events · live` : 'No live session'}
          </span>
          <button onClick={() => setShowRaw((v) => !v)} className="text-caption font-semibold text-primary hover:underline">
            {showRaw ? 'Show timeline' : 'Show raw events'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function CockpitMetric({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border border-border px-3 py-2">
      <div className="flex items-center gap-1 text-caption font-semibold text-faint">
        {live && <Radio className="h-3 w-3 shrink-0 animate-breathe text-primary" />}
        {label}
      </div>
      <div className="mt-0.5 truncate text-small text-fg">{value}</div>
    </div>
  );
}
