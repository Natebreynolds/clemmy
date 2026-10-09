import { History } from 'lucide-react';
import { changeText, feedTime, type SpaceCollectionChange } from '@/lib/spaces';

const SHOWN = 4;

/**
 * What changed in this Space, drawn by the app above every page from the
 * history it keeps: per collection, the last real change and when. A page
 * never has to build this. Renders nothing until something has changed.
 */
export function WhatChangedStrip({
  changes,
  onOpenHistory,
}: {
  changes: SpaceCollectionChange[];
  onOpenHistory: () => void;
}) {
  const changed = changes.filter((change) => change.state === 'changed' && change.changedAt);
  if (changed.length === 0) return null;
  const shown = changed.slice(0, SHOWN);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-1.5 text-small">
      <span className="inline-flex items-center gap-1.5 text-muted">
        <History className="h-3.5 w-3.5" aria-hidden /> What changed
      </span>
      {shown.map((change) => (
        <span key={change.collection} className="text-fg">
          <span className="font-medium">{change.collection.replace(/[_-]+/g, ' ')}</span>
          <span className="text-muted">: {changeText(change)}</span>
          <span className="text-faint"> · {feedTime(change.changedAt!)}</span>
        </span>
      ))}
      {changed.length > SHOWN && <span className="text-faint">+{changed.length - SHOWN} more</span>}
      <button type="button" onClick={onOpenHistory} className="ml-auto text-caption text-muted hover:text-primary hover:underline">
        Details
      </button>
    </div>
  );
}
