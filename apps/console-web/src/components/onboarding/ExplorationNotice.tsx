import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { dismissExploration, explorationWasDismissed, onboardingDraftReturn, onboardingModelAccounts, readOnboardingEntry } from '@/lib/onboarding-entry';

/** Only the owner's explicit no-model completion creates this note. */
export function ExplorationNotice() {
  const location = useLocation();
  const entry = readOnboardingEntry(location.state);
  const [closed, setClosed] = useState<number | null>(null);
  if (location.pathname !== '/chat' || entry?.intent !== 'explore' || closed === entry.stamp || explorationWasDismissed(entry)) return null;
  const destination = onboardingModelAccounts(entry);
  return <aside className="flex items-start gap-3 rounded-md bg-subtle px-4 py-3" aria-label="Getting started">
    <div className="min-w-0 flex-1">
      <h2 className="text-small font-semibold text-fg">Explore at your own pace</h2>
      <p className="mt-1 max-w-prose text-small text-muted">When you want Clem to work on a request, connect and choose a model in Model accounts. You can keep a draft here while you do.</p>
      <Link to={{ pathname: destination.pathname, hash: destination.hash }} state={destination.state} className="mt-1 inline-flex min-h-9 items-center text-small font-semibold text-primary hover:underline">Connect a model</Link>
    </div>
    <button type="button" className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg" aria-label="Dismiss exploration note" onClick={() => { dismissExploration(entry); setClosed(entry.stamp); }}><X size={17} aria-hidden /></button>
  </aside>;
}

/** A scoped return link carries the existing draft owner, never draft text or credentials. */
export function OnboardingModelReturn() {
  const location = useLocation();
  const destination = onboardingDraftReturn(location.state);
  if (location.pathname !== '/settings' || !destination || location.hash
    && !['#accounts', '#models', '#who-does-what'].includes(location.hash)) return null;
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-subtle px-4 py-3 text-small text-muted">
    <p>You can return to Today at any time. Your draft stays with you.</p>
    <Link to={destination.pathname} state={destination.state} className="inline-flex min-h-9 items-center font-semibold text-primary hover:underline">Back to your draft</Link>
  </div>;
}
