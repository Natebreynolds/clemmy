import { workflowDisplayName } from './workflow-name.js';

export interface AttentionReportIdentity {
  id: string;
  attentionKey?: string | null;
  generation?: string | null;
  /** Questions, approvals and proposals keep their own decision identity. */
  protected?: boolean;
}

export interface AttentionReportGroup<T> {
  id: string;
  attentionKey?: string;
  generation?: string;
  /** Original objects, in their original order. Grouping never settles them. */
  reports: T[];
}

export function genericAttentionKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && /^(flow|session|calendar|notification|heartbeat):\S[\s\S]*$/.test(key);
}

/** A presentation hierarchy, never deduplication or acknowledgement. Unknown
 * identities and different source generations remain independently visible. */
export function groupAttentionReports<T>(reports: readonly T[], identify: (report: T) => AttentionReportIdentity): AttentionReportGroup<T>[] {
  const groups: AttentionReportGroup<T>[] = [];
  const byIdentity = new Map<string, AttentionReportGroup<T>>();
  for (const report of reports) {
    const identity = identify(report);
    const eligible = !identity.protected && genericAttentionKey(identity.attentionKey)
      && typeof identity.generation === 'string' && /^[a-f0-9]{64}$/.test(identity.generation);
    const id = eligible ? `attention:${JSON.stringify([identity.attentionKey, identity.generation])}` : `report:${identity.id}`;
    const existing = eligible ? byIdentity.get(id) : undefined;
    if (existing) existing.reports.push(report);
    else {
      const group: AttentionReportGroup<T> = { id, reports: [report],
        ...(eligible ? { attentionKey: identity.attentionKey!, generation: identity.generation! } : {}) };
      groups.push(group);
      if (eligible) byIdentity.set(id, group);
    }
  }
  return groups;
}

/** Work is named from its canonical identity, never inferred from report prose. */
export function attentionWorkTitle(key: string | undefined, fallback = 'Request from Clem'): string {
  if (key?.startsWith('flow:')) return workflowDisplayName(key.slice('flow:'.length));
  if (key?.startsWith('session:')) return 'Conversation';
  if (key?.startsWith('calendar:')) return 'Calendar request';
  return fallback;
}

/** Equivalent reports may already share a server row. Their retained source
 * IDs still contribute to the visible count and exact child navigation. */
export function attentionReportCount<T>(reports: readonly T[], sourceIds: (report: T) => readonly string[]): number {
  return new Set(reports.flatMap(report => [...sourceIds(report)])).size;
}

/** Summaries may repeat display-equivalent text once. This does not replace
 * the retained report collection, its IDs, count, destinations or controls. */
export function attentionReportSummary<T>(reports: readonly T[], display: (report: T) => { title?: string | null; body?: string | null }): T[] {
  const seen = new Set<string>();
  return reports.filter(report => {
    const value = display(report);
    const key = JSON.stringify([value.title ?? '', value.body ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
