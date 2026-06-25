import { useState, type ReactNode } from 'react';
import { ExternalLink, RefreshCw, Brain, Wrench, Lightbulb, TrendingUp, Sparkles, ShieldCheck, GitPullRequest, Check, X } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePoll } from '@/lib/poll';
import {
  getAutoresearchReport, runAutoresearch, runMemoryCleanup,
  approveDuplicates, liftRecallGaps, retireInternalNoise,
  getImprovementProposals, approveImprovementProposal, dismissImprovementProposal,
  fmtNum, fmtPct, fmtWhen,
  type ObservatoryReport, type ToolHealth, type MemoryRefinements, type AutoCleanResult, type ApproveResult,
  type ImprovementProposal, type ImprovementProposalResponse, type ApplyImprovementResult,
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

/** A batch "Approve" control: button → in-flight → success pill with "N left". */
function BatchApprove({
  count, idle, busyLabel, doneVerb, run, onDone,
}: {
  count: number;
  idle: ReactNode;
  busyLabel: string;
  doneVerb: string;
  run: () => Promise<ApproveResult>;
  onDone: () => Promise<unknown> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ApproveResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const onClick = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await run();
      setRes(r);
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" onClick={onClick} disabled={busy || count === 0}>
        {busy ? busyLabel : count === 0 ? 'None left' : idle}
      </Button>
      {res && res.applied > 0 && (
        <StatusPill tone="success">{doneVerb} {fmtNum(res.applied)}</StatusPill>
      )}
      {res && res.applied === 0 && !err && (
        <span className="text-caption text-faint">Nothing eligible right now</span>
      )}
      {res && res.remaining > 0 && <span className="text-caption text-faint">{fmtNum(res.remaining)} left — run again</span>}
      {err && <span className="text-caption text-danger">{err}</span>}
    </div>
  );
}

function MemoryRefinementsCard({ data, onCleaned }: { data: MemoryRefinements; onCleaned: () => Promise<unknown> | void }) {
  const dups = data.duplicates;
  const noise = data.internalNoise;
  const junk = data.syntheticJunk;
  const gaps = data.recallGaps;
  const stale = data.stale;
  const dupPairs = Array.isArray(dups?.pairs) ? dups.pairs : [];
  const shownDups = dupPairs.slice(0, 8);
  // "More" reflects the true remainder (the detector counts every drop candidate
  // but only ships up to ~20 pairs), so the 7–20 range isn't silently hidden.
  const dupMore = Math.max(0, (dups?.count ?? 0) - shownDups.length);
  const byTool = Array.isArray(noise?.byTool) ? noise.byTool : [];
  const gapEx = Array.isArray(gaps?.examples) ? gaps.examples : [];
  const junkCount = junk?.count ?? 0;
  const noiseCount = noise?.count ?? 0;
  const gapCount = gaps?.count ?? 0;

  const [cleaning, setCleaning] = useState(false);
  const [cleaned, setCleaned] = useState<AutoCleanResult | null>(null);
  const [cleanError, setCleanError] = useState<string | null>(null);

  // Per-pair dedup approval state, keyed by dropId (so distinct rows don't share
  // one in-flight flag and a rapid double-click can't act twice).
  const [merging, setMerging] = useState<Set<number>>(new Set());
  const [merged, setMerged] = useState<Set<number>>(new Set());
  const [mergeError, setMergeError] = useState<string | null>(null);

  const onClean = async () => {
    setCleaning(true);
    setCleanError(null);
    try {
      const res = await runMemoryCleanup();
      setCleaned(res);
      await onCleaned();
    } catch (err) {
      setCleanError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setCleaning(false);
    }
  };

  const onMerge = async (keepId: number, dropId: number) => {
    setMerging((s) => new Set(s).add(dropId));
    setMergeError(null);
    try {
      const r = await approveDuplicates([{ keepId, dropId }]);
      if (r.applied > 0) setMerged((s) => new Set(s).add(dropId));
      else if (r.skipped?.[0]) setMergeError(`#${dropId} skipped (${r.skipped[0].reason})`);
      await onCleaned();
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Merge failed');
    } finally {
      setMerging((s) => { const n = new Set(s); n.delete(dropId); return n; });
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-faint" aria-hidden />
        <h3 className="text-h3 text-fg">Memory refinements</h3>
        <span className="ml-auto text-caption text-faint">{fmtNum(data.totalCandidates)} candidates</span>
      </div>
      <p className="mb-3 max-w-2xl text-small text-muted">
        How Clementine keeps memory sharp. The <span className="text-fg">provably-safe</span> class is cleaned automatically; everything that touches your real knowledge waits for your one-click approval below. Every action is soft and reversible.
      </p>

      {/* Provably-safe auto-clean — the one class we apply without asking. */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3">
        <ShieldCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-small font-medium text-fg">Safe to auto-clean: {fmtNum(junkCount)} synthetic test fact(s)</div>
          <div className="text-caption text-faint">
            Smoke-test pollution (exact-signature match). Soft-deleted &amp; undoable for 30 days. Runs nightly; clean on demand here.
          </div>
        </div>
        {cleaned ? (
          <StatusPill tone="success">Cleaned {fmtNum(cleaned.pruned)}</StatusPill>
        ) : (
          <Button variant="secondary" size="sm" onClick={onClean} disabled={cleaning || junkCount === 0}>
            {cleaning ? 'Cleaning…' : junkCount === 0 ? 'Nothing to clean' : `Clean up ${fmtNum(junkCount)} now`}
          </Button>
        )}
      </div>
      {cleanError && <p className="mb-3 text-small text-danger">Couldn’t clean: {cleanError}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <RefineStat label="Near-duplicates" value={`${fmtNum(dups?.count ?? 0)}${dups?.capped ? '+' : ''}`} />
        <RefineStat label="Internal-tool noise" value={fmtNum(noiseCount)} />
        <RefineStat label="High-value, never recalled" value={fmtNum(gapCount)} />
        <RefineStat label="Stale clutter" value={fmtNum(stale?.count ?? 0)} />
      </div>

      {/* (a) Near-duplicates — PER-PAIR approval. You see both sides + similarity
          and approve one at a time; we never bulk-merge the 0.90–0.95 band. */}
      {dupPairs.length > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-label text-faint">Near-duplicates — approve to keep the higher-scored fact, soft-delete the other</div>
          <ul className="space-y-2">
            {shownDups.map((p) => {
              const isMerging = merging.has(p.dropId);
              const isMerged = merged.has(p.dropId);
              return (
                <li key={p.dropId} className="flex items-start gap-3 rounded-md border border-border bg-surface p-2.5">
                  <StatusPill tone="neutral">{p.similarity.toFixed(2)}</StatusPill>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="truncate text-small text-fg" title={p.keep}><span className="text-caption text-success">KEEP #{p.keepId}</span> {p.keep}</div>
                    <div className="truncate text-small text-muted" title={p.drop}><span className="text-caption text-danger">DROP #{p.dropId}</span> {p.drop}</div>
                  </div>
                  {isMerged ? (
                    <StatusPill tone="success">Merged</StatusPill>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => onMerge(p.keepId, p.dropId)} disabled={isMerging}>
                      {isMerging ? 'Merging…' : 'Approve'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {dupMore > 0 && <p className="mt-1.5 text-caption text-faint">{fmtNum(dupMore)} more near-duplicate pair(s) — approve these, then they refresh.</p>}
          {mergeError && <p className="mt-1.5 text-caption text-danger">{mergeError}</p>}
        </div>
      )}

      {/* (b) High-value, never recalled — BATCH boost importance (NOT pin: pinning
          dozens would evict your real standing instructions). */}
      {gapCount > 0 && (
        <div className="mt-5">
          <div className="mb-1 text-label text-faint">High-value facts that never surface</div>
          <p className="mb-1 max-w-2xl text-caption text-faint">
            Raises these facts’ importance so they rank higher in recall — reversible, and it doesn’t crowd your pinned rules.
          </p>
          {gapEx.length > 0 && (
            <ul className="mb-1 space-y-1">
              {gapEx.slice(0, 3).map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-small">
                  <span className="shrink-0 text-caption text-faint">imp {e.importance ?? '—'}</span>
                  <span className="min-w-0 flex-1 truncate text-muted" title={e.content}>{e.content}</span>
                </li>
              ))}
            </ul>
          )}
          <BatchApprove
            count={gapCount}
            idle={`Boost ${fmtNum(Math.min(gapCount, 25))} now`}
            busyLabel="Boosting…"
            doneVerb="Boosted"
            run={liftRecallGaps}
            onDone={onCleaned}
          />
        </div>
      )}

      {/* (c) Internal-tool noise — BATCH retire (soft, capped at 25/click). */}
      {noiseCount > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-label text-faint">Internal-tool noise by source</div>
          {byTool.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {byTool.slice(0, 8).map((t) => (
                <span key={t.tool} className="rounded-md bg-surface px-2 py-0.5 font-mono text-caption text-muted">{t.tool} · {t.count}</span>
              ))}
            </div>
          )}
          <p className="mb-1 max-w-2xl text-caption text-faint">
            Soft-deletes self-referential tool clutter (memory_*, task_*, execution_*). Undoable for 30 days.
          </p>
          <BatchApprove
            count={noiseCount}
            idle={`Retire ${fmtNum(Math.min(noiseCount, 25))} now`}
            busyLabel="Retiring…"
            doneVerb="Retired"
            run={retireInternalNoise}
            onDone={onCleaned}
          />
        </div>
      )}

      <p className="mt-5 border-t border-border/60 pt-3 text-caption text-faint">
        Every approval is soft and reversible — undo anytime in{' '}
        <a className="text-accent underline-offset-2 hover:underline" href="/console-legacy" target="_self">Classic › Memory › Show forgotten</a>.
      </p>
    </Card>
  );
}

const IMPROVEMENT_KIND_LABEL: Record<ImprovementProposal['kind'], string> = {
  tool_desc: 'Tool description',
  skill_pitfall: 'Skill pitfall',
  retire_fact: 'Memory cleanup',
  workflow_step: 'Workflow step',
};

function improvementTone(p: ImprovementProposal): Parameters<typeof StatusPill>[0]['tone'] {
  if (p.applyMode === 'manual') return 'info';
  if (p.kind === 'retire_fact') return 'neutral';
  if (p.kind === 'workflow_step') return 'warning';
  return 'success';
}

function applyMessage(result: ApplyImprovementResult, p: ImprovementProposal): string {
  if (result.reason === 'manual-acknowledged') return `${p.target} acknowledged for manual source edit`;
  if (result.status === 'applied') return `${p.target} applied`;
  if (result.reason === 'already') return `${p.target} was already applied`;
  return `${p.target} approved`;
}

function applyError(result: ApplyImprovementResult): string {
  if (result.reason === 'disabled') return 'Approval is disabled by CLEMMY_MEMORY_APPROVE.';
  if (result.reason === 'not-found') return 'Proposal was not found.';
  if (result.reason === 'apply-failed') return 'Proposal could not be applied.';
  return 'Proposal was not approved.';
}

function ImprovementProposalsCard({
  data,
  onChanged,
}: {
  data: ImprovementProposalResponse;
  onChanged: () => Promise<unknown> | void;
}) {
  const items = Array.isArray(data.proposals) ? data.proposals : [];
  const [busy, setBusy] = useState<{ id: string; action: 'approve' | 'dismiss' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onApprove = async (p: ImprovementProposal) => {
    setBusy({ id: p.id, action: 'approve' });
    setErr(null);
    setNotice(null);
    try {
      const result = await approveImprovementProposal(p.id);
      if (!result.ok) {
        setErr(applyError(result));
        return;
      }
      setNotice(applyMessage(result, p));
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setBusy(null);
    }
  };

  const onDismiss = async (p: ImprovementProposal) => {
    setBusy({ id: p.id, action: 'dismiss' });
    setErr(null);
    setNotice(null);
    try {
      const result = await dismissImprovementProposal(p.id);
      if (!result.ok) {
        setErr(result.reason === 'not-found' ? 'Proposal was not found.' : 'Dismiss failed');
        return;
      }
      setNotice(result.reason === 'already' && result.status
        ? `${p.target} was already ${result.status}`
        : `${p.target} dismissed`);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Dismiss failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <GitPullRequest className="h-4 w-4 text-faint" aria-hidden />
        <h3 className="text-h3 text-fg">Self-improvement proposals</h3>
        <StatusPill tone={data.enabled ? 'success' : 'neutral'}>{data.enabled ? 'Drafting on' : 'Drafting off'}</StatusPill>
        <span className="ml-auto text-caption text-faint">{fmtNum(items.length)} pending</span>
      </div>
      <p className="mb-3 max-w-2xl text-small text-muted">
        Clementine drafts changes from recurring tool, memory, and workflow patterns. Auto proposals still wait for your approval; manual proposals are acknowledged for source edits.
      </p>

      {!data.enabled && (
        <div className="mb-3 rounded-md border border-border bg-surface p-3 text-small text-muted">
          Set CLEMMY_IMPROVEMENT_PROPOSER=on to draft new proposals during autoresearch. Existing pending proposals remain reviewable here.
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-small text-muted">No pending proposals.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((p) => {
            const approving = busy?.id === p.id && busy.action === 'approve';
            const dismissing = busy?.id === p.id && busy.action === 'dismiss';
            return (
              <li key={p.id} className="rounded-md border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={improvementTone(p)}>{IMPROVEMENT_KIND_LABEL[p.kind]}</StatusPill>
                  <StatusPill tone={p.applyMode === 'auto' ? 'success' : 'info'}>{p.applyMode === 'auto' ? 'Auto-applies' : 'Manual edit'}</StatusPill>
                  <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={p.target}>{p.target}</span>
                  <span className="text-caption text-faint">{fmtWhen(p.proposedAt)}</span>
                </div>
                <p className="mt-2 text-small font-medium text-fg">{p.proposedText}</p>
                <p className="mt-1 text-small text-muted">{p.rationale}</p>
                <p className="mt-2 break-words rounded-sm border border-border/70 bg-subtle px-2 py-1 font-mono text-caption text-faint">{p.evidence}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => onApprove(p)} disabled={!!busy}>
                    <Check className="h-4 w-4" aria-hidden /> {approving ? 'Approving…' : p.applyMode === 'manual' ? 'Acknowledge' : 'Approve'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onDismiss(p)} disabled={!!busy} className="text-muted">
                    <X className="h-4 w-4" aria-hidden /> {dismissing ? 'Dismissing…' : 'Dismiss'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {notice && <p className="mt-3 text-caption text-success">{notice}</p>}
      {err && <p className="mt-3 text-caption text-danger">{err}</p>}
    </Card>
  );
}

export function EvolutionView() {
  const q = usePoll(['autoresearch-report'], getAutoresearchReport, 0);
  const improvements = usePoll(['autoresearch-improvements'], getImprovementProposals, 0);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // Only treat it as a renderable report when it actually has the structured
  // shape — never spread/iterate a markdown or error payload (that crashed the
  // route the first time). Anything else falls through to the empty state.
  const raw = q.data?.report;
  const report = raw && Array.isArray(raw.toolHealth) && Array.isArray(raw.suggestions) ? raw : null;
  const mr = q.data?.memoryRefinements;
  const refinements = mr && typeof mr.totalCandidates === 'number' ? mr : null;
  const improvementData = improvements.data;
  const showImprovementsCard = !!improvementData && (!improvementData.enabled || improvementData.proposals.length > 0);

  const onRun = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await runAutoresearch();
      await q.refetch();
      await improvements.refetch();
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
      ) : !report && !refinements && !showImprovementsCard ? (
        <EmptyState
          title="No self-research yet"
          description="Clementine builds this nightly from how it worked for you. Hit “Run now” to generate the first report."
        />
      ) : (
        <div className="space-y-4">
          {showImprovementsCard && improvementData && (
            <ImprovementProposalsCard data={improvementData} onChanged={improvements.refetch} />
          )}
          {refinements && <MemoryRefinementsCard data={refinements} onCleaned={q.refetch} />}
          {report && <EvolutionReport report={report} />}
        </div>
      )}
    </Page>
  );
}
