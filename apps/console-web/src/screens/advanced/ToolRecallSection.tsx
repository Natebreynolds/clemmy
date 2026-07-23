/**
 * Learned tool procedures — moved here from the Memory tab (2026-07-22 UI
 * audit): canonical procedure slugs, intent aliases, and quarantine counts are
 * operator telemetry, the same class as the Evolution metrics, not user memory.
 */
import { Wrench, CheckCircle2, XCircle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePoll } from '@/lib/poll';
import { getToolRecall, type ToolRecallRecord } from '@/lib/memory';

export function ToolRecallSection() {
  const recall = usePoll(['tool-recall'], getToolRecall, 30000);
  const rows = recall.data?.records ?? [];
  return (
    <section className="mt-8">
      <h3 className="mb-1 flex items-center gap-2 text-h3 text-fg"><Wrench className="h-5 w-5 text-primary" aria-hidden /> Tool recall</h3>
      <p className="mb-3 text-small text-muted">Reusable tool procedures, with every phrasing kept as an alias instead of a duplicate memory. Outcomes belong to the procedure actually used; impressions are shown separately.</p>
      {recall.data && rows.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2 text-caption text-muted">
          <span className="rounded-full border border-border bg-surface px-2.5 py-1">{recall.data.count} canonical procedures</span>
          <span className="rounded-full border border-border bg-surface px-2.5 py-1">{recall.data.aliasCount ?? rows.length} intent aliases</span>
          {(recall.data.collapsedAliases ?? 0) > 0 && <span className="rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-success">{recall.data.collapsedAliases} duplicates collapsed</span>}
          {(recall.data.quarantinedAliases ?? 0) > 0 && <span className="rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-warning">{recall.data.quarantinedAliases} noisy aliases quarantined</span>}
        </div>
      )}
      {recall.isLoading ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        : rows.length === 0 ? <Card><EmptyState title="No learned procedures yet" description="As Clementine proves out which tool handles a kind of task, it lands here so she doesn't rediscover it next time." /></Card>
          : <div className="space-y-2">{rows.map((r) => <ProcedureCard key={r.procedureId ?? r.intent} rec={r} />)}</div>}
    </section>
  );
}

function ProcedureCard({ rec }: { rec: ToolRecallRecord }) {
  const c = rec.choice;
  const score = typeof c?.score === 'number' ? Math.round(c.score * 100) : null;
  const success = c?.successCount ?? 0;
  const failure = c?.failureCount ?? 0;
  const aliases = rec.aliases ?? [];
  const quarantined = aliases.filter((alias) => alias.status === 'quarantined').length;
  return (
    <Card className="p-3.5">
      <div className="flex items-start gap-3">
        <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{rec.intent}</span>
            {c ? <StatusPill tone="neutral">{c.kind}</StatusPill> : <StatusPill tone="warning">needs rediscovery</StatusPill>}
            {score != null && <span className="shrink-0 text-caption text-faint">{score}%</span>}
          </div>
          {c && <p className="mt-0.5 font-mono text-small text-muted">→ {c.identifier}</p>}
          {rec.description && <p className="mt-0.5 text-small text-muted">{rec.description}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
            {(success > 0 || failure > 0) && (
              <span className="inline-flex items-center gap-2">
                <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />{success}</span>
                <span className="inline-flex items-center gap-1"><XCircle className="h-3.5 w-3.5 text-warning" aria-hidden />{failure}</span>
              </span>
            )}
            {rec.fallbacks.length > 0 && <span>{rec.fallbacks.length} fallback{rec.fallbacks.length === 1 ? '' : 's'} tried</span>}
            {aliases.length > 0 && <span>{aliases.length} intent alias{aliases.length === 1 ? '' : 'es'}</span>}
            {(rec.evidenceCount ?? 0) > 0 && <span>{rec.evidenceCount} evidence event{rec.evidenceCount === 1 ? '' : 's'}</span>}
            {(rec.impressionCount ?? 0) > 0 && <span>{rec.impressionCount} impression{rec.impressionCount === 1 ? '' : 's'} (not rank)</span>}
            {quarantined > 0 && <span className="text-warning">{quarantined} quarantined alias{quarantined === 1 ? '' : 'es'}</span>}
          </div>
          {aliases.length > 1 && (
            <details className="mt-2 text-caption text-muted">
              <summary className="cursor-pointer select-none">Show intent aliases</summary>
              <div className="mt-1.5 space-y-1 rounded-md bg-subtle p-2">
                {aliases.map((alias) => (
                  <div key={`${alias.status}:${alias.intent}`} className="flex items-start gap-2">
                    <StatusPill tone={alias.status === 'active' ? 'success' : alias.status === 'quarantined' ? 'warning' : 'neutral'}>{alias.status}</StatusPill>
                    <span className="min-w-0 break-words">{alias.intent}</span>
                    <span className="ml-auto shrink-0 text-faint">{alias.source.replace(/_/g, ' ')}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </Card>
  );
}
