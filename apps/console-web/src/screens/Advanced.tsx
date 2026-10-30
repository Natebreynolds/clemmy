import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Page } from '@/components/Page';
import { cn } from '@/lib/cn';
import { advancedNavFor, type NavDest } from '@/lib/nav';
import { getSettings } from '@/lib/settings';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Button } from '@/components/ui/Button';
import { usePoll } from '@/lib/poll';
import { getUsage, getTools, fmtNum } from '@/lib/advanced';
import { AutonomyForm } from './advanced/AutonomyForm';
import { DiagnosticsView } from './advanced/DiagnosticsView';
import { EvolutionView } from './advanced/EvolutionView';
import { ObservabilityView } from './advanced/ObservabilityView';
import { TraceLabView } from './advanced/TraceLabView';
import { DeveloperFlags } from './advanced/DeveloperFlags';
import { ToolRecallSection } from './advanced/ToolRecallSection';
import { WorkflowCanvas } from './WorkflowCanvas';

function Usage() {
  const usage = usePoll(['usage'], getUsage, 15000);
  const [showAll, setShowAll] = useState(false);
  const d = usage.data;
  const bySource = d?.bySource ?? [];
  const byModel = Object.entries(d?.byModel ?? {});
  // The work and its checks apart: Jev is the `router` role.
  const ROLE_LABELS: Record<string, string> = { brain: 'Task work', worker: 'Delegated work', reviewer: 'Model review',
    router: 'Jev checks', writer: 'Reply writing', memory: 'Memory work', quick: 'Quick checks', other: 'Other' };
  const byRole = Object.entries(d?.byRole ?? {}).sort((a, b) => b[1].tokens - a[1].tokens);
  const kpis = [
    { label: 'Total tokens', value: fmtNum(d?.totalTokens) },
    { label: 'Calls', value: fmtNum(d?.totalCalls) },
    { label: 'Input', value: fmtNum(d?.totalInputTokens) },
    { label: 'Output', value: fmtNum(d?.totalOutputTokens) },
  ];
  return (
    <Page title="Usage" subtitle="Token spend & activity today">
      {usage.isError && <QueryUnavailable title="Usage couldn’t be refreshed" description={d ? 'Showing the last loaded usage. These totals may have changed.' : 'Usage is unavailable, so today’s totals cannot be confirmed.'} onRetry={() => { void usage.refetch(); }} className="mb-4 py-5" />}
      {usage.isLoading ? <Skeleton className="h-24 w-full" /> : (
        d ? <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {kpis.map((k) => (
              <Card key={k.label} className="p-5">
                <div className="text-label text-faint">{k.label}</div>
                <div className="mt-1 text-h1 text-fg">{k.value}</div>
              </Card>
            ))}
          </div>
          {byRole.length > 0 && (
            <Card className="p-5">
              <h3 className="mb-3 text-h3 text-fg">By role</h3>
              <ul className="space-y-2">
                {byRole.map(([role, v]) => (
                  <li key={role} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-body text-fg">{ROLE_LABELS[role] ?? role}</span>
                    <span className="shrink-0 text-small text-muted">{fmtNum(v.tokens)} · {fmtNum(v.calls)} calls · {fmtNum(Math.round(v.durationMs / 1000))} s</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="mb-3 text-h3 text-fg">By source</h3>
              {bySource.length === 0 ? <p className="text-body text-muted">No usage logged yet today.</p> : (
                <ul className="space-y-2">
                  {(showAll ? bySource : bySource.slice(0, 10)).map((s) => (
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
                  {(showAll ? byModel : byModel.slice(0, 10)).map(([model, v]) => (
                    <li key={model} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-mono text-small text-fg">{model}</span>
                      <span className="shrink-0 text-small text-muted">{fmtNum(v.tokens)} · {fmtNum(v.calls)} calls</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          {(bySource.length > 10 || byModel.length > 10) && <Button className="mt-4" variant="ghost" size="sm" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? 'Show fewer rows' : `Show all ${bySource.length} sources and ${byModel.length} models`}</Button>}
        </> : null
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
      <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-primary">
        <Search className="h-4 w-4 text-faint" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools…" aria-label="Search tools"
          className="h-11 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-faint" />
        <span className="text-caption text-faint">{tools.data ? rows.length : tools.isLoading ? '…' : '—'}</span>
      </div>
      {tools.isError && <QueryUnavailable title="Tools couldn’t be refreshed" description={tools.data ? 'Showing the last loaded catalog.' : 'The tool catalog is unavailable, so it cannot be confirmed empty.'} onRetry={() => { void tools.refetch(); }} className="mb-4 py-5" />}
      {tools.isLoading ? <Skeleton className="h-40 w-full" /> : rows.length === 0 && !tools.isError ? (
        <EmptyState title={q ? 'No matching tools' : 'No tools listed'} description={q ? 'Try another name or clear your search.' : 'Registered tools appear here when the catalog is available.'}
          action={q ? <Button variant="secondary" onClick={() => setQ('')}>Clear search</Button> : undefined} />
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2">
          {rows.map((t) => (
            <Card key={t.name} className="p-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-small font-semibold text-fg">{t.name}</span>
                {t.needsApproval && <StatusPill tone="warning">Asks first</StatusPill>}
                {t.category && <span className="ml-auto text-caption text-faint">{t.category}</span>}
              </div>
              {t.description && <><p className={cn('mt-1 break-words text-small text-muted', t.description.length > 120 && 'line-clamp-2')}>{t.description}</p>
                {t.description.length > 120 && <details className="mt-2 text-small text-muted"><summary className="cursor-pointer rounded-sm">Read full description</summary><p className="mt-2 whitespace-pre-wrap break-words">{t.description}</p></details>}</>}
            </Card>
          ))}
        </div>
      )}
      <ToolRecallSection />
    </Page>
  );
}

/**
 * Advanced's sections, and the way between them.
 *
 * All of them shipped as routes with NO navigation of any kind: once you landed
 * on one — and only two were linked from anywhere — the rest were reachable
 * solely by editing the address bar. Working screens behind a dead end.
 *
 * The rail mirrors Settings' (screens/Settings.tsx NAV) because this is a
 * settings-shaped place and the product rule is familiar over clever. What it
 * OFFERS comes from lib/nav.ts — one list, already used by the sidebar and the
 * command palette — so a panel cannot be advertised here and forgotten there.
 * Developer-tier panels stay routed but unadvertised until developer mode is on.
 */
function AdvancedRail({ current, developerMode }: { current: string; developerMode: boolean }) {
  const offered = advancedNavFor(developerMode);
  const everyday = offered.filter((d) => d.tier !== 'developer');
  const instruments = offered.filter((d) => d.tier === 'developer');
  const row = (item: NavDest) => {
    const Icon = item.icon;
    const active = item.path.endsWith(`/${current}`);
    return (
      <Link
        key={item.path}
        to={item.path}
        title={item.hint}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-small font-medium transition-colors hover:bg-surface hover:text-fg',
          active ? 'bg-surface text-fg' : 'text-muted',
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {item.label}
      </Link>
    );
  };
  return (
    <nav aria-label="Advanced sections" className="hidden w-[200px] shrink-0 flex-col overflow-y-auto border-r border-border bg-subtle px-3 py-6 xl:flex">
      {everyday.map(row)}
      {instruments.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-1 px-2.5 text-caption font-semibold uppercase tracking-widest text-faint">Instruments</p>
          {instruments.map(row)}
        </div>
      )}
      <div className="mt-4 border-t border-border pt-3">
        <Link to="/settings" className="block rounded-md px-2.5 py-1.5 text-small text-muted hover:text-fg">Settings</Link>
      </div>
    </nav>
  );
}


export function Advanced() {
  const { pathname } = useLocation();
  const seg = pathname.split('/').filter(Boolean)[1] ?? 'usage';
  const settings = usePoll(['settings'], getSettings, 0);
  const developerMode = settings.data?.developerMode === true;
  const view = (): ReactNode => {
    switch (seg) {
      case 'usage': return <Usage />;
      case 'tools': return <Tools />;
      case 'canvas': return <WorkflowCanvas />;
      case 'diagnostics': return <DiagnosticsView />;
      case 'observability': return <ObservabilityView />;
      case 'traces': return <TraceLabView />;
      case 'autonomy': return <AutonomyForm />;
      case 'evolution': return <EvolutionView />;
      case 'developer': return <DeveloperFlags />;
      default: return <Usage />;
    }
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col xl:flex-row">
      <AdvancedRail current={seg} developerMode={developerMode} />
      <nav aria-label="Advanced sections" className="flex shrink-0 gap-4 overflow-x-auto border-b border-border px-5 xl:hidden">
        {advancedNavFor(developerMode).map(item => <Link key={item.path} to={item.path} aria-current={item.path.endsWith(`/${seg}`) ? 'page' : undefined}
          className={cn('inline-flex min-h-12 shrink-0 items-center border-b-2 text-small font-semibold', item.path.endsWith(`/${seg}`) ? 'border-primary text-fg' : 'border-transparent text-muted hover:text-fg')}>{item.label}</Link>)}
        <Link to="/settings" className="inline-flex min-h-12 shrink-0 items-center text-small text-muted">Settings</Link>
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{view()}</div>
    </div>
  );
}
