import { useState } from 'react';
import { ExternalLink, RefreshCw, Brain, Wrench, Lightbulb, TrendingUp, Sparkles } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePoll } from '@/lib/poll';
import {
  getAutoresearchReport, runAutoresearch, fmtNum, fmtPct, fmtWhen,
  type ObservatoryReport, type ToolHealth, type MemoryRefinements,
} from '@/lib/advanced';

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

/** A compact label/value row used inside the health cards. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-small text-muted">{label}</span>
      <span className="text-right text-small font-medium text-fg" title={hint}>{value}</span>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, sub }: { icon: typeof Brain; title: string; sub?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Icon className="h-4 w-4 text-faint" aria-hidden />
      <h3 className="text-h3 text-fg">{title}</h3>
      {sub && <span className="ml-auto text-caption text-faint">{sub}</span>}
    </div>
  );
}

function ToolHealthRow({ t }: { t: ToolHealth }) {
  const successPct = pct(t.successes, t.calls);
  const wrongPickPct = pct(t.wrongPickHints, t.calls);
  // Surface the failure modes that actually matter: low success or high wrong-pick.
  const tone = successPct < 60 ? 'danger' : wrongPickPct >= 50 ? 'warning' : 'success';
  return (
    <div className="flex items-center gap-3 border-b border-border/60 py-2 last:border-0">
      <span className="min-w-0 flex-1 truncate font-mono text-small text-fg" title={t.toolName}>{t.toolName}</span>
      <span className="shrink-0 text-caption text-faint">{fmtNum(t.calls)} calls</span>
      <StatusPill tone={tone}>{successPct}% ok</StatusPill>
      {t.wrongPickHints > 0 && (
        <span className="shrink-0 text-caption text-warning" title="Times this looked like the wrong tool for the job">
          {t.wrongPickHints} wrong-pick
        </span>
      )}
    </div>
  );
}

function EvolutionReport({ report }: { report: ObservatoryReport }) {
  const bh = report.brainHealth;
  const tc = report.toolChoiceHealth;
  const rc = bh?.reflectionCounts;
  const tools = [...report.toolHealth].sort((a, b) => b.calls - a.calls).slice(0, 12);

  return (
    <div className="space-y-4">
      {/* window / totals */}
      <p className="text-small text-muted">
        {fmtWhen(report.windowStart)} → {fmtWhen(report.windowEnd)} · {fmtNum(report.totalToolCalls)} tool calls ·{' '}
        {fmtNum(report.sessionCount)} sessions · generated {fmtWhen(report.generatedAt)}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Getting better at your work — the tool-reuse signal */}
        {tc && (
          <Card className="p-5">
            <SectionHeader icon={TrendingUp} title="Getting better at your work" sub="tool reuse, last 24h" />
            <div className="flex items-end gap-2">
              <span className="text-h1 text-fg">{fmtPct(tc.hitRatePct)}</span>
              <span className="mb-1 text-small text-muted">recall hit-rate</span>
            </div>
            <p className="mt-1 text-caption text-faint">
              How often Clementine reused a proven tool instead of re-searching. Higher = sharper over time.
            </p>
            <div className="mt-3 border-t border-border/60 pt-2">
              <Stat label="Recalls (exact / fuzzy)" value={`${fmtNum(tc.hits)} / ${fmtNum(tc.fuzzyHits)}`} />
              <Stat label="Misses (forced re-search)" value={fmtNum(tc.misses)} />
              <Stat label="New tool choices learned" value={fmtNum(tc.remembers)} />
              <Stat label="Invalidated" value={fmtNum(tc.invalidations)} />
            </div>
          </Card>
        )}

        {/* Memory / brain health */}
        {bh && (
          <Card className="p-5">
            <SectionHeader icon={Brain} title="Memory health" sub="last 24h" />
            {rc && (
              <Stat
                label="Facts reflected (kept / skipped)"
                value={`${fmtNum(rc.success)} / ${fmtNum(rc.cancelledTooShort + rc.cancelledLowImportance + rc.cancelledAlreadyReflected)}`}
                hint="Kept = a durable fact was written; skipped = too short / low importance / already known"
              />
            )}
            <Stat
              label="Higher-order patterns"
              value={`${fmtNum(bh.recursiveReflection.patternsWrittenTotal)} written · ${bh.recursiveReflection.runs} run(s)`}
              hint={`Last outcome: ${bh.recursiveReflection.lastOutcome ?? '—'}`}
            />
            {rc && rc.extractorFailed + rc.error > 0 && (
              <div className="py-1.5">
                <StatusPill tone="warning">{rc.extractorFailed + rc.error} reflection failure(s)</StatusPill>
              </div>
            )}
            <Stat
              label="Fact depth (atomic · pattern · meta)"
              value={`${fmtNum(bh.factDepth.atomic)} · ${fmtNum(bh.factDepth.depthOne)} · ${fmtNum(bh.factDepth.depthTwo)}`}
            />
            <Stat
              label="Importance (avg · p50 · p90)"
              value={`${bh.factImportance.avg?.toFixed(1) ?? '—'} · ${bh.factImportance.p50 ?? '—'} · ${bh.factImportance.p90 ?? '—'}`}
            />
          </Card>
        )}
      </div>

      {/* Tool health */}
      {tools.length > 0 && (
        <Card className="p-5">
          <SectionHeader icon={Wrench} title="Tool health" sub={`${report.toolHealth.length} tools used`} />
          <div>{tools.map((t) => <ToolHealthRow key={t.toolName} t={t} />)}</div>
        </Card>
      )}

      {/* Suggestions */}
      <Card className="p-5">
        <SectionHeader icon={Lightbulb} title="Suggestions" />
        {report.suggestions.length === 0 ? (
          <p className="text-small text-muted">No standout patterns this window — things look healthy.</p>
        ) : (
          <ul className="space-y-2">
            {report.suggestions.map((s, i) => (
              <li key={i} className="flex gap-2 text-small text-fg">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RefineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="text-h3 text-fg">{value}</div>
      <div className="mt-0.5 text-caption text-faint">{label}</div>
    </div>
  );
}

function MemoryRefinementsCard({ data }: { data: MemoryRefinements }) {
  const dups = data.duplicates;
  const noise = data.internalNoise;
  const gaps = data.recallGaps;
  const stale = data.stale;
  const dupPairs = Array.isArray(dups?.pairs) ? dups.pairs : [];
  const byTool = Array.isArray(noise?.byTool) ? noise.byTool : [];
  const gapEx = Array.isArray(gaps?.examples) ? gaps.examples : [];
  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-faint" aria-hidden />
        <h3 className="text-h3 text-fg">Memory refinements</h3>
        <span className="ml-auto text-caption text-faint">{fmtNum(data.totalCandidates)} candidates · read-only preview</span>
      </div>
      <p className="mb-3 max-w-2xl text-small text-muted">
        What Clementine would tidy to keep memory sharp. Nothing is changed yet — auto-applying the safe cleanups and one-click approvals for the rest are coming next.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <RefineStat label="Near-duplicates" value={`${fmtNum(dups?.count ?? 0)}${dups?.capped ? '+' : ''}`} />
        <RefineStat label="Internal-tool noise" value={fmtNum(noise?.count ?? 0)} />
        <RefineStat label="High-value, never recalled" value={fmtNum(gaps?.count ?? 0)} />
        <RefineStat label="Stale clutter" value={fmtNum(stale?.count ?? 0)} />
      </div>

      {dupPairs.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-label text-faint">Near-duplicates — keep the higher-scored, drop the other</div>
          <ul className="space-y-1.5">
            {dupPairs.slice(0, 5).map((p, i) => (
              <li key={i} className="flex items-center gap-2 text-small">
                <StatusPill tone="neutral">{p.similarity.toFixed(2)}</StatusPill>
                <span className="min-w-0 flex-1 truncate text-muted" title={p.drop}>#{p.dropId} {p.drop}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {byTool.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-label text-faint">Internal-tool noise by source</div>
          <div className="flex flex-wrap gap-1.5">
            {byTool.slice(0, 8).map((t) => (
              <span key={t.tool} className="rounded-md bg-surface px-2 py-0.5 font-mono text-caption text-muted">{t.tool} · {t.count}</span>
            ))}
          </div>
        </div>
      )}

      {gapEx.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-label text-faint">High-value facts that never surface</div>
          <ul className="space-y-1">
            {gapEx.slice(0, 3).map((e) => (
              <li key={e.id} className="flex items-center gap-2 text-small">
                <span className="shrink-0 text-caption text-faint">imp {e.importance ?? '—'}</span>
                <span className="min-w-0 flex-1 truncate text-muted" title={e.content}>{e.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function EvolutionView() {
  const q = usePoll(['autoresearch-report'], getAutoresearchReport, 0);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // Only treat it as a renderable report when it actually has the structured
  // shape — never spread/iterate a markdown or error payload (that crashed the
  // route the first time). Anything else falls through to the empty state.
  const raw = q.data?.report;
  const report = raw && Array.isArray(raw.toolHealth) && Array.isArray(raw.suggestions) ? raw : null;
  const mr = q.data?.memoryRefinements;
  const refinements = mr && typeof mr.totalCandidates === 'number' ? mr : null;

  const onRun = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await runAutoresearch();
      await q.refetch();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  const actions = (
    <>
      <Button variant="primary" size="sm" onClick={onRun} disabled={running}>
        <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} aria-hidden /> {running ? 'Running…' : 'Run now'}
      </Button>
      <a href="/console-legacy" target="_self">
        <Button variant="secondary" size="sm"><ExternalLink className="h-4 w-4" aria-hidden /> Classic</Button>
      </a>
    </>
  );

  return (
    <Page title="Evolution" subtitle="What Clementine is learning about working better for you" actions={actions}>
      {runError && (
        <Card className="mb-4 p-4">
          <p className="text-small text-danger">Couldn’t run self-research: {runError}</p>
        </Card>
      )}
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !report && !refinements ? (
        <EmptyState
          title="No self-research yet"
          description="Clementine builds this nightly from how it worked for you. Hit “Run now” to generate the first report."
        />
      ) : (
        <div className="space-y-4">
          {refinements && <MemoryRefinementsCard data={refinements} />}
          {report && <EvolutionReport report={report} />}
        </div>
      )}
    </Page>
  );
}
