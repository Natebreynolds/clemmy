import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Clipboard, GitBranch, History, Loader2, MessageSquare,
  RefreshCw, Route, ShieldCheck, Timer, Wrench, Zap,
} from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import {
  getReplayPreview,
  getTrace,
  listTraces,
  type TraceDetail,
  type TraceNode,
  type TraceNodeCategory,
  type TraceReplayPreview,
  type TraceRiskLevel,
  type TraceSeverity,
  type TraceSummary,
} from '@/lib/traces';

const CATEGORY_LABEL: Record<TraceNodeCategory, string> = {
  user: 'User',
  model: 'Model',
  tool: 'Tool',
  external_write: 'Write',
  guardrail: 'Guard',
  approval: 'Approval',
  handoff: 'Handoff',
  memory: 'Memory',
  plan: 'Plan',
  workflow: 'Workflow',
  system: 'System',
};

const CATEGORY_ICON: Record<TraceNodeCategory, typeof History> = {
  user: MessageSquare,
  model: Route,
  tool: Wrench,
  external_write: Zap,
  guardrail: ShieldCheck,
  approval: AlertTriangle,
  handoff: GitBranch,
  memory: History,
  plan: Route,
  workflow: GitBranch,
  system: History,
};

const SEVERITY_DOT: Record<TraceSeverity, string> = {
  debug: 'bg-faint',
  info: 'bg-accent',
  warn: 'bg-warning',
  error: 'bg-danger',
};

function riskTone(risk: TraceRiskLevel): Tone {
  if (risk === 'high') return 'danger';
  if (risk === 'medium') return 'warning';
  if (risk === 'low') return 'info';
  return 'success';
}

function fmtTime(ts?: string): string {
  if (!ts) return '';
  const t = new Date(ts);
  return Number.isFinite(t.getTime()) ? t.toLocaleString() : '';
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function TraceRow({ trace, selected, onSelect }: { trace: TraceSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full rounded-md border px-3 py-2.5 text-left transition-colors cursor-pointer',
        selected ? 'border-primary bg-primary-tint' : 'border-border bg-surface hover:border-border-strong',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-small font-semibold text-fg">{trace.title || trace.sessionId}</span>
        <StatusPill tone={riskTone(trace.replay.riskLevel)}>{trace.replay.riskLevel}</StatusPill>
      </div>
      <div className="mt-1 flex items-center gap-2 text-caption text-muted">
        <span>{trace.kind}</span>
        <span>{trace.status}</span>
        <span className="ml-auto tabular-nums">{trace.metrics.events} events</span>
      </div>
    </button>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof History; label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border bg-subtle px-3 py-2">
      <div className="flex items-center gap-1.5 text-caption text-faint">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
      </div>
      <div className="mt-1 text-title-sm font-semibold text-fg">{value}</div>
    </div>
  );
}

function TimelineNode({ node }: { node: TraceNode }) {
  const Icon = CATEGORY_ICON[node.category] ?? History;
  return (
    <div className="flex gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="mt-1 flex flex-col items-center gap-1">
        <span className={cn('h-2 w-2 rounded-full', SEVERITY_DOT[node.severity])} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <span className="shrink-0 text-caption text-faint">#{node.seq}</span>
          <span className="min-w-0 truncate text-small font-semibold text-fg">{node.label}</span>
          <span className="ml-auto shrink-0 text-caption text-faint">{CATEGORY_LABEL[node.category]}</span>
        </div>
        {node.detail && <p className="mt-1 truncate text-small text-muted">{node.detail}</p>}
        <div className="mt-1 flex flex-wrap gap-1.5 text-caption text-faint">
          <span>turn {node.turn}</span>
          {node.tool && <span>{node.tool}</span>}
          {node.callId && <span>{node.callId}</span>}
          {node.target && <span>{node.target}</span>}
        </div>
      </div>
    </div>
  );
}

function TraceDetailPanel({ trace, replay, onReplay }: {
  trace?: TraceDetail;
  replay: TraceReplayPreview | null;
  onReplay: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [busy, setBusy] = useState(false);
  const categories = useMemo(() => {
    const out = new Map<TraceNodeCategory, number>();
    for (const node of trace?.nodes ?? []) out.set(node.category, (out.get(node.category) ?? 0) + 1);
    return [...out.entries()];
  }, [trace]);

  if (!trace) return <Skeleton className="h-[560px] w-full" />;

  const startReplay = async () => {
    setBusy(true);
    try { await onReplay(); } finally { setBusy(false); }
  };
  const prompt = replay?.prompt ?? '';
  const copyPrompt = async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1200);
    } catch { /* ignore */ }
  };
  const openChat = () => {
    if (!prompt) return;
    navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
  };

  return (
    <div className="min-w-0 space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-h2 text-fg">{trace.title || trace.sessionId}</h2>
              <StatusPill tone={riskTone(trace.replay.riskLevel)}>{trace.replay.riskLevel}</StatusPill>
            </div>
            <p className="mt-1 truncate font-mono text-caption text-faint">{trace.sessionId}</p>
            {trace.objective && <p className="mt-2 text-small text-muted">{trace.objective}</p>}
          </div>
          <Button variant="secondary" disabled={busy || !trace.replay.ready} onClick={startReplay}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            Replay preview
          </Button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Metric icon={History} label="Events" value={trace.metrics.events} />
          <Metric icon={Wrench} label="Tools" value={trace.metrics.toolCalls} />
          <Metric icon={ShieldCheck} label="Guards" value={trace.metrics.guardrails} />
          <Metric icon={Timer} label="Duration" value={fmtDuration(trace.metrics.durationMs)} />
        </div>

        {(trace.replay.risks.length > 0 || trace.truncated) && (
          <div className="mt-4 rounded-md border border-warning/40 bg-warning-tint px-3 py-2">
            <div className="flex items-start gap-2 text-small text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="min-w-0">
                {trace.replay.risks.length > 0 ? trace.replay.risks.slice(0, 3).map((risk) => <p key={risk}>{risk}</p>) : <p>Trace timeline is truncated.</p>}
                {trace.truncated && <p>Only the latest {trace.nodes.length} nodes are shown.</p>}
              </div>
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            {categories.map(([category, count]) => (
              <span key={category} className="rounded-full bg-subtle px-2 py-1 text-caption text-muted">
                {CATEGORY_LABEL[category]} {count}
              </span>
            ))}
          </div>
          <div className="max-h-[620px] overflow-auto">
            {trace.nodes.length === 0
              ? <p className="px-4 py-8 text-center text-small text-muted">No events in this trace.</p>
              : trace.nodes.map((node) => <TimelineNode key={node.id} node={node} />)}
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <h3 className="mb-2 text-h3 text-fg">Causal Links</h3>
            {trace.edges.length === 0 ? (
              <p className="text-small text-muted">No explicit links.</p>
            ) : (
              <ul className="space-y-2">
                {trace.edges.filter((edge) => edge.kind !== 'temporal').slice(0, 12).map((edge) => (
                  <li key={edge.id} className="flex items-center gap-2 text-caption text-muted">
                    <span className="font-mono text-fg">{edge.kind}</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    <span className="truncate">{edge.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-h3 text-fg">Replay</h3>
              {replay && <StatusPill tone={riskTone(replay.riskLevel)}>{replay.mode}</StatusPill>}
            </div>
            {!replay ? (
              <p className="text-small text-muted">Generate a replay preview for this trace.</p>
            ) : (
              <div className="space-y-3">
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-subtle p-3 font-mono text-caption text-fg">{replay.prompt}</pre>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={copyPrompt}>
                    <Clipboard className="h-4 w-4" aria-hidden /> {copyState === 'copied' ? 'Copied' : 'Copy'}
                  </Button>
                  <Button size="sm" onClick={openChat}>
                    <MessageSquare className="h-4 w-4" aria-hidden /> Open in chat
                  </Button>
                </div>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h3 className="mb-2 text-h3 text-fg">Run</h3>
            <dl className="space-y-2 text-small">
              <div className="flex justify-between gap-3"><dt className="text-muted">Kind</dt><dd className="text-fg">{trace.kind}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Status</dt><dd className="text-fg">{trace.status}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Started</dt><dd className="text-right text-fg">{fmtTime(trace.firstEventAt || trace.startedAt)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Updated</dt><dd className="text-right text-fg">{fmtTime(trace.updatedAt)}</dd></div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function TraceLabView() {
  const traces = usePoll(['traces'], () => listTraces({ limit: 80, status: 'any' }), 8000);
  const [selected, setSelected] = useState<string | null>(null);
  const [replay, setReplay] = useState<TraceReplayPreview | null>(null);

  useEffect(() => {
    if (!selected && traces.data?.traces?.[0]) setSelected(traces.data.traces[0].sessionId);
  }, [selected, traces.data]);

  const detail = usePoll(
    ['trace', selected],
    () => getTrace(selected!).then((r) => r.trace),
    6000,
    { enabled: !!selected },
  );

  useEffect(() => { setReplay(null); }, [selected]);

  const selectedTrace = detail.data;
  const openReplay = async () => {
    if (!selected) return;
    const res = await getReplayPreview(selected);
    setReplay(res.replay);
  };

  return (
    <Page title="Trace Lab" subtitle="Harness timelines, causal links, and safe replay prompts">
      <div className="grid min-h-[640px] gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-h3 text-fg">Recent Runs</h2>
            {traces.isFetching && <Loader2 className="h-4 w-4 animate-spin text-faint" aria-hidden />}
          </div>
          {traces.isLoading ? (
            <Skeleton className="h-96 w-full" />
          ) : (traces.data?.traces ?? []).length === 0 ? (
            <EmptyState title="No traces" description="Harness traces appear after Clementine runs." />
          ) : (
            <div className="max-h-[760px] space-y-2 overflow-auto pr-1">
              {(traces.data?.traces ?? []).map((trace) => (
                <TraceRow
                  key={trace.sessionId}
                  trace={trace}
                  selected={selected === trace.sessionId}
                  onSelect={() => setSelected(trace.sessionId)}
                />
              ))}
            </div>
          )}
        </div>

        {selected && detail.isError ? (
          <EmptyState title="Trace unavailable" description="This harness trace could not be loaded." />
        ) : selected ? (
          <TraceDetailPanel trace={selectedTrace} replay={replay} onReplay={openReplay} />
        ) : (
          <EmptyState title="Select a trace" description="Pick a recent run to inspect." />
        )}
      </div>
    </Page>
  );
}
