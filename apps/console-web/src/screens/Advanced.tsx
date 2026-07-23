import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePoll } from '@/lib/poll';
import { getUsage, getTools, fmtNum } from '@/lib/advanced';
import { BudgetsForm } from './advanced/BudgetsForm';
import { AutonomyForm } from './advanced/AutonomyForm';
import { DiagnosticsView } from './advanced/DiagnosticsView';
import { EvolutionView } from './advanced/EvolutionView';
import { ObservabilityView } from './advanced/ObservabilityView';
import { TraceLabView } from './advanced/TraceLabView';
import { DeveloperFlags } from './advanced/DeveloperFlags';
import { ToolRecallSection } from './advanced/ToolRecallSection';

function Usage() {
  const usage = usePoll(['usage'], getUsage, 15000);
  const d = usage.data;
  const bySource = d?.bySource ?? [];
  const byModel = Object.entries(d?.byModel ?? {});
  const kpis = [
    { label: 'Total tokens', value: fmtNum(d?.totalTokens) },
    { label: 'Calls', value: fmtNum(d?.totalCalls) },
    { label: 'Input', value: fmtNum(d?.totalInputTokens) },
    { label: 'Output', value: fmtNum(d?.totalOutputTokens) },
  ];
  return (
    <Page title="Usage" subtitle="Token spend & activity today">
      {usage.isLoading ? <Skeleton className="h-24 w-full" /> : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {kpis.map((k) => (
              <Card key={k.label} className="p-5">
                <div className="text-label text-faint">{k.label}</div>
                <div className="mt-1 text-h1 text-fg">{k.value}</div>
              </Card>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="mb-3 text-h3 text-fg">By source</h3>
              {bySource.length === 0 ? <p className="text-body text-muted">No usage logged yet today.</p> : (
                <ul className="space-y-2">
                  {bySource.slice(0, 10).map((s) => (
                    <li key={s.source} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-body text-fg">{s.source}</span>
                      <span className="shrink-0 text-small text-muted">{fmtNum(s.tokens)} · {fmtNum(s.calls)} calls</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="p-5">
              <h3 className="mb-3 text-h3 text-fg">By model</h3>
              {byModel.length === 0 ? <p className="text-body text-muted">No usage logged yet today.</p> : (
                <ul className="space-y-2">
                  {byModel.slice(0, 10).map(([model, v]) => (
                    <li key={model} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-mono text-small text-fg">{model}</span>
                      <span className="shrink-0 text-small text-muted">{fmtNum(v.tokens)} · {fmtNum(v.calls)} calls</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}

function Tools() {
  const tools = usePoll(['tools'], getTools, 30000);
  const [q, setQ] = useState('');
  const rows = (tools.data?.tools ?? []).filter((t) => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Page title="Tools" subtitle="Everything Clementine can do (read-only)">
      <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface px-3">
        <Search className="h-4 w-4 text-faint" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools…" aria-label="Search tools"
          className="h-11 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-faint" />
        <span className="text-caption text-faint">{rows.length}</span>
      </div>
      {tools.isLoading ? <Skeleton className="h-40 w-full" /> : rows.length === 0 ? (
        <EmptyState title="No tools" description="No tools match your search." />
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2">
          {rows.map((t) => (
            <Card key={t.name} className="p-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-small font-semibold text-fg">{t.name}</span>
                {t.needsApproval && <StatusPill tone="warning">Asks first</StatusPill>}
                {t.category && <span className="ml-auto text-caption text-faint">{t.category}</span>}
              </div>
              {t.description && <p className="mt-1 line-clamp-2 text-small text-muted">{t.description}</p>}
            </Card>
          ))}
        </div>
      )}
      <ToolRecallSection />
    </Page>
  );
}

export function Advanced() {
  const { pathname } = useLocation();
  const seg = pathname.split('/').filter(Boolean)[1] ?? 'usage';
  switch (seg) {
    case 'usage': return <Usage />;
    case 'tools': return <Tools />;
    case 'diagnostics': return <DiagnosticsView />;
    case 'observability': return <ObservabilityView />;
    case 'traces': return <TraceLabView />;
    case 'budgets': return <BudgetsForm />;
    case 'autonomy': return <AutonomyForm />;
    case 'evolution': return <EvolutionView />;
    case 'developer': return <DeveloperFlags />;
    default: return <Usage />;
  }
}
