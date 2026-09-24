/**
 * A Space's summary on Home: the same projection the phone shows
 * (spaces/mobile-projection.ts — the Space's own authored `_mobile` summary
 * when it wrote one, a modest inference otherwise), plus its freshness and
 * per-source health. One definition, so a Space reads the same on Home and on
 * the phone, and a failed refresh is never shown as current numbers.
 */
import { projectSourceHealth, projectWorkspaceData, type MobileSourceHealth, type MobileWorkspaceBreakdown, type MobileWorkspaceField } from '../spaces/mobile-projection.js';

export interface HomeSpaceSummary {
  id: string;
  title: string;
  objective: string | null;
  lastRefreshedAt: string | null;
  freshness: string;
  /** Headline figures the Space wrote (or the row count it can honestly claim). */
  headline: MobileWorkspaceField[];
  /** What the rows are ("Deals", "Messages"), and how many. */
  recordLabel: string | null;
  total: number;
  records: Array<{ key: string; primary: string; fields: MobileWorkspaceField[] }>;
  /** The first breakdown the Space wrote (by stage, by rep), drawn as bars. */
  breakdown: MobileWorkspaceBreakdown | null;
  sources: MobileSourceHealth[];
  issues: string[];
}

const HEADLINE = 3;
const RECORDS = 3;
const RECORD_FIELDS = 2;

export function summarizeSpaceForHome(input: {
  id: string;
  title: string;
  objective?: string | null;
  lastRefreshedAt?: string | null;
  freshness?: string | null;
  issues?: readonly string[];
  data: unknown;
}): HomeSpaceSummary {
  let projection: ReturnType<typeof projectWorkspaceData> | null = null;
  try { projection = projectWorkspaceData(input.data); } catch { projection = null; }
  let sources: MobileSourceHealth[] = [];
  try { sources = projectSourceHealth(input.data); } catch { sources = []; }
  return {
    id: input.id,
    title: input.title,
    objective: input.objective ?? null,
    lastRefreshedAt: input.lastRefreshedAt ?? null,
    freshness: input.freshness ?? 'unknown',
    headline: (projection?.headline ?? []).slice(0, HEADLINE),
    recordLabel: projection?.recordLabel ?? null,
    total: projection?.total ?? 0,
    records: (projection?.records ?? []).slice(0, RECORDS).map((record) => ({
      key: record.key,
      primary: record.primary,
      fields: record.fields.slice(0, RECORD_FIELDS),
    })),
    breakdown: projection?.breakdowns?.[0]
      ? { label: projection.breakdowns[0].label, entries: projection.breakdowns[0].entries.slice(0, 5) }
      : null,
    sources,
    issues: [...(input.issues ?? [])].slice(0, 3),
  };
}
