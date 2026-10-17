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
