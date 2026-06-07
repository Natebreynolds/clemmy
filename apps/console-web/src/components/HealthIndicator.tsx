import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/lib/api';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';

/**
 * ONE calm status chip that replaces the legacy 6+ chips (RUNS/MEM/APPRV/
 * MODE/MCP/ONLINE) + the HEALTH dock card. Polls the daemon and MCP
 * health; opens a small popover with per-component detail.
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

export function HealthIndicator() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const status = usePoll(['status'], () => apiGet<{ status: string }>('/api/status'), 5000);
  const mcp = usePoll(['mcp-health'], () => apiGet<McpHealth>('/api/console/mcp/health'), 8000);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const online = status.isSuccess;
  const mcpSummary = summarizeMcp(mcp.data);
  const mcpDown = (mcpSummary?.down ?? 0) > 0;
  const allGood = online && !mcpDown;

  return (
    <div className="relative app-no-drag" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-small font-semibold transition-colors duration-fast cursor-pointer',
          allGood ? 'text-success hover:bg-success-tint' : 'text-warning hover:bg-warning-tint',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="System status"
      >
        <span
          className={cn('h-2 w-2 rounded-full', allGood ? 'bg-success' : 'bg-warning')}
          aria-hidden
        />
        {allGood ? 'All good' : 'Needs attention'}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="System status"
          className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border border-border bg-surface p-2 shadow-lg animate-fade-in"
        >
          <Row label="Daemon" ok={online} okText="Connected" badText="Reconnecting…" />
          <Row
            label="Integrations (MCP)"
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
    <div className="flex items-center justify-between rounded-md px-2 py-1.5">
      <span className="text-small text-muted">{label}</span>
      <span className={cn('inline-flex items-center gap-1.5 text-caption font-semibold', ok ? 'text-success' : 'text-warning')}>
        <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-success' : 'bg-warning')} aria-hidden />
        {ok ? okText : badText}
      </span>
    </div>
  );
}
