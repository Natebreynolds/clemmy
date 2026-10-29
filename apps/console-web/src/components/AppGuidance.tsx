import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { getAppGuidance } from '@clem/chat-engine';
import { lastChatSession } from '@/lib/last-session';
import { guidanceOriginPath } from '@/lib/app-link-navigation';
import { watchGuidanceTarget, type GuidanceTargetState } from '@/lib/app-guidance-target';
import { Button } from '@/components/ui/Button';

/** A destination and a real control, with guidance kept beside the work. */
export function AppGuidance() {
  const location = useLocation();
  const navigate = useNavigate();
  const id = new URLSearchParams(location.search).get('guide');
  const guide = id ? getAppGuidance(id, 'desktop') : null;
  const conversation = lastChatSession();
  const originPath = guidanceOriginPath(location.state);
  const returnPath = originPath ?? (conversation ? `/chat/${encodeURIComponent(conversation)}` : null);
  const [attempt, setAttempt] = useState(0);
  const targetSelector = guide?.target;
  const watchKey = `${location.pathname}:${id}:${targetSelector}:${attempt}`;
  const [tracking, setTracking] = useState<{ key: string; state: GuidanceTargetState } | null>(null);
  const state = tracking?.key === watchKey ? tracking.state : 'checking';
  useEffect(() => {
    if (!targetSelector) return;
    return watchGuidanceTarget(targetSelector, next => setTracking({ key: watchKey, state: next }));
  }, [watchKey, targetSelector]);
  if (!guide) return null;
  const close = () => {
    const search = new URLSearchParams(location.search);
    search.delete('guide');
    navigate({ pathname: location.pathname, search: search.toString() }, { replace: true, state: location.state });
  };
  return (
    <aside className="clem-guidance shrink-0 border-b border-border bg-primary-tint px-5 py-3 sm:px-8" aria-label="Clem’s guide">
      <div className="mx-auto flex max-w-6xl items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-small font-semibold text-fg">{guide.title}</p>
          <p role="status" aria-live="polite" className="mt-0.5 max-w-prose text-small text-muted">{state === 'ready' ? guide.instruction : state === 'checking' ? 'Checking this page for the control…' : 'This control isn’t available on this page yet. Retry the guide when the page is ready.'}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            {state === 'unavailable' && <Button size="sm" variant="secondary" onClick={() => setAttempt(value => value + 1)}>Retry guidance</Button>}
            {returnPath && <Link to={returnPath} className="inline-flex min-h-9 items-center text-small font-semibold text-primary hover:underline">{originPath === '/help' ? 'Back to Help' : 'Back to our conversation'}</Link>}
          </div>
        </div>
        <button type="button" onClick={close} aria-label="Close guide" className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"><X size={17} aria-hidden /></button>
      </div>
    </aside>
  );
}
