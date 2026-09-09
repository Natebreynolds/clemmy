/**
 * Instant refresh for the Automate list. Every workflow write (create, update,
 * enable, delete) emits `workflow_changed` on `/api/console/workflows/events`;
 * the console never listened, so an authored workflow appeared on the next
 * 10s poll. Now the list and the open drawer refetch the moment it lands —
 * which is what makes "watch a workflow being created" read as live.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { withToken } from './api';

export function useWorkflowChanges(onChange?: (change: { name?: string; op?: string }) => void): void {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      if (closed) return;
      es = new EventSource(withToken('/api/console/workflows/events'));
      es.addEventListener('workflow_changed', (e) => {
        let change: { name?: string; op?: string } = {};
        try { change = JSON.parse((e as MessageEvent).data) as { name?: string; op?: string }; } catch { /* still a change */ }
        void qc.invalidateQueries({ queryKey: ['workflows'] });
        void qc.invalidateQueries({ queryKey: ['workflows-home'] });
        if (change.name) void qc.invalidateQueries({ queryKey: ['workflow', change.name] });
        onChange?.(change);
      });
      es.onerror = () => {
        if (closed) return;
        try { es?.close(); } catch { /* ignore */ }
        es = null;
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      try { es?.close(); } catch { /* ignore */ }
    };
    // onChange is read at event time; re-subscribing per render would churn the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);
}
