/**
 * Delivered — the shelf of finished work, fed by the durable deliverable
 * index. The board above answers "what is she doing"; this answers "what has
 * she made me", and it survives chat scroll, budget stops, and daemon
 * restarts (born from the 2026-07-30 incident where a finished brief sat on
 * disk while the chat claimed she gave up).
 *
 * Each card carries the two affordances that make completed work ALIVE:
 * "Ask Clem" (chat with this deliverable as the subject) and "Run again"
 * (re-invoke the stored producing route — Clem confirms inputs herself, and
 * every effect gate still applies).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, ExternalLink, FileText, Globe, MessageCircle, Package, RotateCw, Table2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { listDelivered, type DeliveredItem } from '@/lib/delivered';

function kindIcon(item: DeliveredItem) {
  const target = item.target.toLowerCase();
  if (item.kind === 'url' || target.startsWith('http')) {
    return target.includes('docs.google.com/spreadsheets') ? Table2 : Globe;
  }
  if (item.kind === 'file') return FileText;
  return Package;
}

function displayTitle(item: DeliveredItem): string {
  if (item.title.trim()) return item.title;
  const tail = item.target.split('/').filter(Boolean).pop() ?? item.target;
  return tail.length > 60 ? `${tail.slice(0, 57)}…` : tail;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function DeliveredShelf() {
  const navigate = useNavigate();
  const delivered = usePoll(['delivered'], () => listDelivered(30), 30000);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const items = delivered.data ?? [];
  if (delivered.isLoading || items.length === 0) return null;

  const askClem = (item: DeliveredItem) => {
    navigate(`/chat?prompt=${encodeURIComponent(
      `About the ${displayTitle(item)} you delivered (${item.target}): `,
    )}`);
  };
  const runAgain = (item: DeliveredItem) => {
    navigate(`/chat?prompt=${encodeURIComponent(
      `I want to run the same work again that produced "${displayTitle(item)}" (${item.why.slice(0, 300)}). `
      + 'Confirm the inputs with me first if anything should change, then run it.',
    )}`);
  };
  const copyPath = (item: DeliveredItem) => {
    void navigator.clipboard?.writeText(item.target);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId((current) => (current === item.id ? null : current)), 1500);
  };

  return (
    <section aria-label="Delivered" className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-h3 text-fg">Delivered</h3>
        <StatusPill tone="neutral">{items.length}</StatusPill>
        <span className="text-caption text-muted">Finished work — it never gets lost from here.</span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const Icon = kindIcon(item);
          const isUrl = item.kind === 'url' || item.target.startsWith('http');
          return (
            <Card key={item.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-semibold text-fg" title={item.target}>{displayTitle(item)}</p>
                  <p className="mt-0.5 line-clamp-2 text-caption text-muted" title={item.why}>{item.why}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {item.lane && <StatusPill tone="neutral">{item.lane}</StatusPill>}
                {item.kind === 'file' && item.stillExists === false && (
                  <StatusPill tone="warning">file moved</StatusPill>
                )}
                <span className="text-caption text-faint">{relativeTime(item.createdAt)}</span>
                <span className="flex-1" />
                {isUrl ? (
                  <a
                    className="inline-flex items-center gap-1 text-caption text-muted hover:text-fg"
                    href={item.target}
                    target="_blank"
                    rel="noreferrer"
                    title="Open"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open
                  </a>
                ) : (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-caption text-muted hover:text-fg"
                    onClick={() => copyPath(item)}
                    title={item.target}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden /> {copiedId === item.id ? 'Copied' : 'Copy path'}
                  </button>
                )}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-caption text-muted hover:text-fg"
                  onClick={() => askClem(item)}
                  title="Open chat about this deliverable"
                >
                  <MessageCircle className="h-3.5 w-3.5" aria-hidden /> Ask Clem
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-caption text-muted hover:text-fg"
                  onClick={() => runAgain(item)}
                  title="Ask Clem to run the producing route again"
                >
                  <RotateCw className="h-3.5 w-3.5" aria-hidden /> Run again
                </button>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
