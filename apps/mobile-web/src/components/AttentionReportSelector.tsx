import { oneLine } from '@clem/chat-engine';
import type { InboxNotification } from '../lib/api';
import { relativeTime } from './Approvals';
import './attention-report-groups.css';

export function AttentionReportSelector({ reports, attentionKey, selectedId, onSelect }: {
  reports: readonly InboxNotification[];
  attentionKey?: string;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return <details class="attention-report-selector" data-report-selector={attentionKey}>
    <summary>{reports.length} reports · Change report</summary>
    <ul>{reports.map(report => <li key={report.id}><button type="button" aria-current={selectedId === report.id ? 'true' : undefined}
      onClick={() => onSelect(report.id)}>
      <span class="attention-report-cause">{oneLine(report.title || report.body, 140)}</span>
      <span class="home-row-note">{selectedId === report.id ? 'Selected · ' : ''}{relativeTime(report.createdAt)}</span>
    </button></li>)}</ul>
  </details>;
}
