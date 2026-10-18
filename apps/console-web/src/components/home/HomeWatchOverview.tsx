import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Eye, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import type { WatchOverview } from './watch-overview-model';

/** Retained checks, not another running-work indicator. Only a changed report
 * receives a brief acknowledgement; an enabled setting never animates. */
export function HomeWatchOverview({ overview, onRetry, refreshing, animate }: {
  overview: WatchOverview; onRetry: () => void; refreshing: boolean; animate: boolean;
}) {
  const previous = useRef<Map<string, string | null> | null>(null);
  const [arrivals, setArrivals] = useState<Record<string, string>>({});
  const reports = JSON.stringify(overview.rows.map(row => [row.slug, row.reportAt]));
  useEffect(() => {
    const latest = new Map<string, string | null>(JSON.parse(reports));
    const before = previous.current;
    previous.current = latest;
    if (!animate || overview.status !== 'loaded' || document.visibilityState !== 'visible') {
      setArrivals({}); return;
    }
    const changed = Object.fromEntries([...latest].filter(([slug, at]) => at && before?.has(slug) && before.get(slug) !== at)) as Record<string, string>;
    setArrivals(changed);
    if (!Object.keys(changed).length) return;
    const timer = window.setTimeout(() => setArrivals({}), 1000);
    return () => window.clearTimeout(timer);
  }, [reports, animate, overview.status]);

  const current = overview.status === 'loaded';
  const empty = current && overview.currentCounts?.total === 0;
  const loading = overview.status === 'loading' && overview.rows.length === 0;
  return <section className="clem-home-watches" aria-labelledby="home-watches">
    <div className="clem-home-watch-heading"><h2 id="home-watches"><Eye size={17} aria-hidden />Keeping an eye on</h2>
      <Link to={overview.href} aria-label="See what Clem can see"><ArrowUpRight size={17} aria-hidden /></Link>
    </div>
    {loading ? <div className="clem-home-watch-loading" role="status"><span className="sr-only">Loading watches</span><Skeleton className="h-4 w-36" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/4" /></div>
      : <>
          <p className="clem-home-watch-label">{empty ? 'Something worth keeping in view?' : overview.label}</p>
          <p className={current ? 'clem-home-watch-detail' : 'clem-home-watch-detail clem-home-watch-caution'} role={current ? undefined : 'status'}>{empty ? 'Tell Clem what matters in a source you connect. She can bring useful findings back here.' : overview.detail}</p>
          {overview.rows.length > 0 && <ul className="clem-home-watch-list">{overview.rows.map(row => <li key={row.slug} className={arrivals[row.slug] === row.reportAt ? 'clem-home-watch-arrived' : undefined}>
            <Link to={row.href} className="clem-home-watch-source" title={`${row.name} · ${row.source}`}><span>{row.name}</span><ArrowUpRight size={14} aria-hidden /></Link>
            <p className="clem-home-watch-source-detail" title={row.lookFor}>{row.lookFor || row.source}</p>
            <div className="clem-home-watch-report"><span>{row.stateLabel}</span><span aria-hidden>·</span>
              {row.reportStatus === 'retained' && row.reportAt && row.reportTimeLabel
                ? <time dateTime={row.reportAt} title={row.reportAt}>Report {row.reportTimeLabel}</time>
                : <span>{row.reportLabel}</span>}
            </div>
          </li>)}</ul>}
          {!current && overview.status !== 'loading' && <Button variant="ghost" size="sm" onClick={onRetry} disabled={refreshing}><RefreshCw size={14} aria-hidden />{refreshing ? 'Refreshing…' : 'Refresh watches'}</Button>}
          {overview.freshnessLabel && !current && <p className="clem-home-watch-freshness">{overview.freshnessLabel}</p>}
          <Link to={overview.href} className="clem-home-watch-all">{empty ? 'Choose what Clem can see' : 'See your watches'}<ArrowUpRight size={15} aria-hidden /></Link>
        </>}
  </section>;
}

/** "Client Notes Deadline Watch" reads as "Client Notes Deadline" in a sentence. */
function watchNoun(name: string): string {
  return name.replace(/\s+watch$/i, '').trim() || name;
}

/** Today's one line about watches (owner 2026-10-18: calm, novice-first):
 * what Clem keeps an eye on, in a sentence, and where to change it. The full
 * panel lives on Watching. */
export function HomeWatchLine({ overview, onRetry, refreshing }: {
  overview: WatchOverview; onRetry: () => void; refreshing: boolean;
}) {
  const current = overview.status === 'loaded';
  const loading = overview.status === 'loading' && overview.rows.length === 0;
  const total = overview.currentCounts?.total ?? overview.rows.length;
  const names = overview.rows.map(row => watchNoun(row.name));
  const more = Math.max(0, total - names.length);
  const listed = names.map((name, index) => <span key={name + index}>
    {index > 0 && (index === names.length - 1 && more === 0 ? ' and ' : ', ')}
    <b className="font-semibold text-fg">{name}</b>
  </span>);
  return <section aria-label="What Clem is keeping an eye on"
    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-subtle px-5 py-4">
    <Eye size={18} className="shrink-0 text-muted" aria-hidden />
    {loading
      ? <Skeleton className="h-4 w-72" />
      : total === 0 && current
        ? <p className="min-w-0 flex-1 text-body text-muted">Clem isn’t keeping an eye on anything yet. Point her at a folder, inbox or channel and she’ll tell you what matters.</p>
        : <p className="min-w-0 flex-1 text-body text-muted">Clem is keeping an eye on {listed}{more > 0 ? <> and {more} more</> : null}.
            {!current && overview.status !== 'loading' && <span className="text-warning"> {overview.detail}</span>}</p>}
    {!current && overview.status !== 'loading' && !loading && <Button variant="ghost" size="sm" onClick={onRetry} disabled={refreshing}>
      <RefreshCw size={14} aria-hidden />{refreshing ? 'Refreshing…' : 'Refresh'}</Button>}
    <Link to={overview.href} className="rounded-sm text-small font-semibold text-primary hover:underline">{total === 0 && current ? 'Choose what she watches' : 'Manage'}</Link>
  </section>;
}
