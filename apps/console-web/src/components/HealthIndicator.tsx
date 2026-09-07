import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/lib/api';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';

/**
 * ONE calm status affordance in the top bar. When everything is fine it is
 * a single dot — no label, no popover, nothing to read. Only when something
 * needs attention does it grow a label and open a small popover with the
 * per-component detail. Polls the daemon and MCP health.
 */
interface McpHealth {
  // Per-server health field is `state` (connected|connecting|degraded|unavailable).
  servers?: Array<{ name?: string; state?: string }>;
  summary?: { total?: number; degraded?: number; unavailable?: number };
}

function summarizeMcp(h: McpHealth | undefined): { down: number; total: number } | null {
  if (!h) return null;
  if (Array.isArray(h.servers)) {
    const total = h.servers.length;
    const down = h.servers.filter((s) => /degraded|unavailable|error|fail|down/.test((s.state ?? '').toLowerCase())).length;
    return { down, total };
  }
  if (h.summary && typeof h.summary.total === 'number') {
    return { down: (h.summary.degraded ?? 0) + (h.summary.unavailable ?? 0), total: h.summary.total };
  }
  return null;
}

type Health = 'checking' | 'good' | 'attention';

export function HealthIndicator() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const status = usePoll(['status'], () => apiGet<{ status: string }>('/api/status'), 5000);
  const mcp = usePoll(['mcp-health'], () => apiGet<McpHealth>('/api/console/mcp/health'), 8000);

  // Before the first status answer arrives we know nothing — that is not
  // "needs attention", it is a quiet dot until the daemon speaks.
  const online: boolean | null = status.isSuccess ? true : status.isError ? false : null;
  const mcpSummary = summarizeMcp(mcp.data);
  const mcpDown = (mcpSummary?.down ?? 0) > 0;
  const health: Health = online === false || mcpDown ? 'attention' : online === null ? 'checking' : 'good';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Healed while the popover was open: there is nothing left to show.
  useEffect(() => {
    if (health !== 'attention') setOpen(false);
  }, [health]);

  if (health !== 'attention') {
    const good = health === 'good';
    const text = good ? 'All good' : 'Checking status…';
    return (
      <span
        role="status"
        aria-label={text}
        title={text}
        className="app-no-drag inline-flex h-10 w-8 shrink-0 items-center justify-center"
      >
        <span
          className={cn('h-2 w-2 rounded-full', good ? 'bg-success' : 'bg-faint')}
          aria-hidden
        />
      </span>
    );
  }

  return (
    <div className="relative app-no-drag" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-9 items-center gap-2 rounded-sm px-3 text-small font-semibold text-warning',
          'transition-colors duration-fast hover:bg-warning-tint cursor-pointer',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="System status"
      >
        <span className="h-2 w-2 rounded-full bg-warning" aria-hidden />
        Needs attention
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="System status"
          className="absolute right-0 top-full z-50 mt-2 w-64 rounded-md border border-border bg-surface p-2 shadow-popover animate-fade-in"
        >
          <Row label="Daemon" ok={online === true} okText="Connected" badText="Reconnecting…" />
          <Row
            label="Integrations"
            ok={!mcpDown}
            okText={mcpSummary ? `${mcpSummary.total} ready` : 'OK'}
            badText={mcpSummary ? `${mcpSummary.down} need attention` : 'Check connections'}
          />
        </div>
      )}
    </div>
  );
}

function Row({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }) {
  return (
    <div className="flex items-center justify-between rounded-sm px-2 py-1.5">
      <span className="text-small text-muted">{label}</span>
      <span className={cn('inline-flex items-center gap-1.5 text-caption font-semibold', ok ? 'text-success' : 'text-warning')}>
        <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-success' : 'bg-warning')} aria-hidden />
        {ok ? okText : badText}
      </span>
    </div>
  );
}
