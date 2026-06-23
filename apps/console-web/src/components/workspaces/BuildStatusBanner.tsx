import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Wrench, Play, Inbox as InboxIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { GapQuestion, SpaceAudit } from '@/lib/spaces';

/**
 * Surfaces what the UI used to hide: a build that PARKED (paused), the data
 * sources that failed, the gap-test questions Clem flagged, and any action
 * still WAITING on approval — with one-click "Ask Clem to fix" / "Resume" so the
 * user isn't stranded on an empty/half-built surface. Renders nothing when all
 * is well (a clean active workspace stays chrome-free).
 */
export function BuildStatusBanner({
  paused,
  gaps,
  openApprovals,
  failures,
  busy,
  onResume,
  onAskClem,
}: {
  paused: boolean;
  gaps: GapQuestion[];
  openApprovals: number;
  failures: SpaceAudit[];
  busy: boolean;
  onResume: () => void;
  onAskClem: () => void;
}) {
  const navigate = useNavigate();
  if (!paused && gaps.length === 0 && openApprovals === 0 && failures.length === 0) return null;

  return (
    <div className="border-b border-border bg-subtle px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {paused && (
            <p className="inline-flex items-center gap-2 text-small text-fg">
              <AlertTriangle className="h-4 w-4 text-muted" aria-hidden />
              This workspace is <strong>paused</strong> — a data source didn’t return data when it was built. Fix it, then resume.
            </p>
          )}
          {failures.length > 0 && (
            <ul className="flex flex-col gap-1">
              {failures.map((f, i) => (
                <li key={i} className="text-caption text-danger">
                  <span className="font-mono">{f.path.replace('/refresh/', '')}</span>: {f.note ?? 'failed to refresh'}
                </li>
              ))}
            </ul>
          )}
          {gaps.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-small text-fg">Before you rely on this, confirm:</p>
              <ul className="ml-1 flex flex-col gap-1">
                {gaps.map((g, i) => (
                  <li key={i} className="text-caption text-muted">• {g.question}</li>
                ))}
              </ul>
            </div>
          )}
          {openApprovals > 0 && (
            <button
              type="button"
              onClick={() => navigate('/inbox?tab=needs')}
              className="inline-flex w-fit items-center gap-1.5 text-small text-fg hover:underline cursor-pointer"
            >
              <InboxIcon className="h-3.5 w-3.5" aria-hidden /> {openApprovals} action{openApprovals === 1 ? '' : 's'} waiting for your approval
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {paused && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={onResume}>
              <Play className="h-4 w-4" aria-hidden /> Resume
            </Button>
          )}
          <Button size="sm" onClick={onAskClem}>
            <Wrench className="h-4 w-4" aria-hidden /> Ask Clem to fix
          </Button>
        </div>
      </div>
    </div>
  );
}
