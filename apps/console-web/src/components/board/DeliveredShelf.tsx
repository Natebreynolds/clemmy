/**
 * Delivered — the shelf of finished work, fed by the durable deliverable
 * index. The board above answers "what is she doing"; this answers "what has
 * she made me", and it survives chat scroll, budget stops, and daemon
 * restarts (born from the 2026-07-30 incident where a finished brief sat on
 * disk while the chat claimed she gave up).
 *
 * The unit is a PIECE OF WORK, grouped server-side — the first render showed
 * six GOOGLESHEETS_* slug cards from one edit and three bare index.htmls from
 * one brief, which is exactly the noise this surface exists to prevent.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, ExternalLink, FileText, Globe, MessageCircle, RotateCw, Table2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { listDelivered, type DeliveredGroup } from '@/lib/delivered';

function groupIcon(group: DeliveredGroup) {
  if (group.url?.includes('docs.google.com/spreadsheets')) return Table2;
  if (group.url) return Globe;
  if (group.filePath) return FileText;
  return Table2;
}

const LANE_LABEL: Record<string, string> = {
  guest: 'CLI project',
  local: 'built locally',
  workflow: 'workflow',
  external: 'connected app',
};

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
  const delivered = usePoll(['delivered'], () => listDelivered(12), 30000);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const groups = delivered.data ?? [];
  if (delivered.isLoading || groups.length === 0) return null;

  const askClem = (g: DeliveredGroup) => {
    navigate(`/chat?prompt=${encodeURIComponent(
      `About "${g.title}" you delivered${g.filePath ? ` (${g.filePath})` : g.url ? ` (${g.url})` : ''}: `,
    )}`);
  };
  const runAgain = (g: DeliveredGroup) => {
    navigate(`/chat?prompt=${encodeURIComponent(
      `I want to run the same work again that produced "${g.title}" (original ask: ${g.why.slice(0, 280)}). `
      + 'Confirm the inputs with me first if anything should change, then run it.',
    )}`);
  };
  const copyPath = (g: DeliveredGroup) => {
    if (!g.filePath) return;
    void navigator.clipboard?.writeText(g.filePath);
    setCopiedId(g.id);
    setTimeout(() => setCopiedId((current) => (current === g.id ? null : current)), 1500);
  };

  return (
    <section aria-label="Delivered" className="mt-8">
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="text-h3 text-fg">Delivered</h3>
        <span className="text-caption text-muted">Finished work — it never gets lost from here.</span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => {
          const Icon = groupIcon(g);
          return (
            <Card key={g.id} className="flex flex-col gap-2.5 p-4">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary-tint text-primary">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-semibold text-fg" title={g.filePath ?? g.url ?? g.title}>{g.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-caption text-muted" title={g.why}>“{g.why}”</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-caption text-faint">
                {g.lane && <span>{LANE_LABEL[g.lane] ?? g.lane}</span>}
                {g.artifactCount > 1 && <span>· {g.artifactCount} artifacts</span>}
                <span>· {relativeTime(g.createdAt)}</span>
                {g.filePath && g.fileStillExists === false && <StatusPill tone="warning">file moved</StatusPill>}
              </div>
              <div className="flex items-center gap-1.5 border-t border-border pt-2">
                {g.url ? (
                  <a
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-primary hover:bg-primary-tint"
                    href={g.url} target="_blank" rel="noreferrer"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open
                  </a>
                ) : g.filePath ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-primary hover:bg-primary-tint"
                    onClick={() => copyPath(g)}
                    title={g.filePath}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden /> {copiedId === g.id ? 'Copied' : 'Copy path'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption text-muted hover:bg-subtle hover:text-fg"
                  onClick={() => askClem(g)}
                >
                  <MessageCircle className="h-3.5 w-3.5" aria-hidden /> Ask Clem
                </button>
                {g.rerunnable && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption text-muted hover:bg-subtle hover:text-fg"
                    onClick={() => runAgain(g)}
                  >
                    <RotateCw className="h-3.5 w-3.5" aria-hidden /> Run again
                  </button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
