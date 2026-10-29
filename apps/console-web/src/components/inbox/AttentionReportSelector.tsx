import { oneLine } from '@clem/chat-engine';
import { relativeTime, type NotificationRow } from '../../lib/inbox';

/** A compact chooser; the selected report is read in full immediately below. */
export function AttentionReportSelector({ reports, attentionKey, selectedId, onSelect }: {
  reports: readonly NotificationRow[];
  attentionKey?: string;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return <details data-report-selector={attentionKey}>
    <summary className="min-h-11 cursor-pointer py-2 text-small font-semibold text-primary">{reports.length} reports · Change report</summary>
    <ul className="divide-y divide-border">
      {reports.map(report => <li key={report.id}><button type="button" aria-current={selectedId === report.id ? 'true' : undefined}
        onClick={() => onSelect(report.id)} className="min-h-11 w-full rounded-sm py-2 text-left text-small text-fg hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <span className="block font-medium">{oneLine(report.title || report.body, 140)}</span>
        <span className="text-caption text-muted">{selectedId === report.id ? 'Selected · ' : ''}{report.createdAt ? relativeTime(report.createdAt) : ''}</span>
      </button></li>)}
    </ul>
  </details>;
}
