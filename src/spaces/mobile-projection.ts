/**
 * Workspaces, projected for a phone.
 *
 * A workspace is an agent-authored HTML app over an opaque JSON blob, and
 * that view is loopback-only by design — agent-written JavaScript is never
 * served off this machine. So the phone cannot mirror the desktop; it has to
 * re-derive something useful from the data itself.
 *
 * The honest constraint: a real workspace is 40–190 rows × ~40 columns, and
 * which nine columns matter is knowledge that lives only inside the authored
 * HTML. Rather than pretend otherwise, this projection does three things a
 * phone is actually good at:
 *
 *   1. Freshness told truthfully — per-source `_meta.ok`, not just a
 *      `pulledAt` string, because a failed refresh leaves a stale timestamp
 *      looking healthy.
 *   2. The headline numbers, lifted from the workspace's own `summary`
 *      object. That is where the agent already condensed the dataset, so it
 *      is the one piece of "what matters" we do not have to guess.
 *   3. The rows as scannable cards with a handful of fields, chosen by a
 *      stable ranking rather than column order.
 *
 * All of it is deterministic so it can be pinned by tests, and it is capped
 * so a 350 KB dataset never becomes a 350 KB mobile response.
 */

export interface MobileWorkspaceField {
  label: string;
  value: string;
}

export interface MobileWorkspaceRecord {
  key: string;
  primary: string;
  /** Every scalar the row carries, most meaningful first. The card shows the
   *  leading few; the rest are one tap away, because "I can see the summary
   *  but not the actual data" is the complaint a summary-only view earns. */
  fields: MobileWorkspaceField[];
  /** Authored-only long copy. Raw/inferred datasets never get this escape
   * hatch, keeping arbitrary provider payloads inside the old 80-char cap. */
  body?: string;
  /** Authored-only, protocol-checked citations/actions. */
  links?: MobileWorkspaceLink[];
}

export interface MobileWorkspaceLink {
  label: string;
  url: string;
}

/** A named breakdown out of the summary — byStage, byBand, byLeadSource. */
export interface MobileWorkspaceBreakdown {
  label: string;
  entries: Array<{ label: string; value: string; ratio: number }>;
}

export interface MobileWorkspaceProjection {
  /** Where the rows came from, e.g. "risk.deals" — shown so the phone never
   *  implies it is showing more than it is. */
  recordPath: string | null;
  recordLabel: string | null;
  total: number;
  shown: number;
  headline: MobileWorkspaceField[];
  breakdowns: MobileWorkspaceBreakdown[];
  records: MobileWorkspaceRecord[];
}

const MAX_RECORDS = 60;
const MAX_HEADLINE = 6;
/** Shown on a collapsed card; the rest expand in place. */
export const CARD_FIELDS = 4;
/** Ceiling on a fully expanded row — real workspaces reach 40 columns. */
const MAX_FIELDS = 28;
const MAX_BREAKDOWNS = 4;
const MAX_BREAKDOWN_ENTRIES = 8;
const MAX_VALUE_CHARS = 80;

/** Field-name families, most identifying first. Ranking beats column order:
 *  the first key in a 39-column row is rarely the one you'd read first. */
const NAME_PATTERNS: Array<{ re: RegExp; rank: number }> = [
  { re: /^(account|company|customer|client|name|title|subject|deal|opportunity)$/i, rank: 0 },
  // Anchored at the start on purpose: an unanchored match promoted
  // `emailOnAccount` over `amount` on a real deal-risk workspace, because
  // "Account" appears at the END of a field that is actually a counter.
  { re: /^(account|company|customer|client|deal|opportunity)[_A-Z]/i, rank: 1 },
  { re: /^(amount|value|revenue|arr|mrr|price)$/i, rank: 2 },
  { re: /^(stage|status|state|band|priority|health|risk|score)$/i, rank: 3 },
  { re: /^(amount|value|revenue|arr|mrr|price)[_A-Z]/i, rank: 4 },
  { re: /^(closedate|close_date|duedate|due_date|date)/i, rank: 5 },
  { re: /^(owner|rep|assignee|user|contact)/i, rank: 6 },
  { re: /(stage|status|band|priority)/i, rank: 7 },
];

/** Fields that are machinery rather than meaning on a summary card. */
const DEMOTED = /(count$|^num|^is[A-Z]|^has[A-Z]|days|^id$|id$|url|link|email|phone)/i;

function nameRank(key: string): number {
  for (const { re, rank } of NAME_PATTERNS) {
    if (re.test(key)) return rank;
  }
  return DEMOTED.test(key) ? 80 : 50;
}

/** Humanizes camelCase / snake_case keys the way the authored views do. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Money, narrowly. `total` is deliberately NOT here: real workspaces carry
 * `totalOpen` (a deal count) beside `totalOpenValue` (dollars), and treating
 * the family as currency rendered "41 open deals" as "$41".
 */
const CURRENCYISH = /(amount|value|revenue|arr|mrr|price)/i;

/** Formats a scalar for a small screen: compact money, thousands separators,
 *  ISO dates as dates, everything else trimmed. */
export function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (CURRENCYISH.test(key) && Math.abs(value) >= 1000) {
      const millions = Math.abs(value) >= 1_000_000;
      const scaled = millions ? value / 1_000_000 : value / 1000;
      return `$${scaled.toFixed(scaled >= 10 ? 0 : 1)}${millions ? 'M' : 'k'}`;
    }
    if (CURRENCYISH.test(key)) return `$${value.toLocaleString('en-US')}`;
    return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1);
  }
  const text = String(value).trim();
  if (!text) return '—';
  // An ISO timestamp reads as noise on a phone; the date is the signal.
  const iso = /^(\d{4}-\d{2}-\d{2})T[\d:.]+Z?$/.exec(text);
  if (iso) return iso[1];
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;
}

function isScalar(value: unknown): boolean {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function isObjectArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value)
    && value.length > 0
    && value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row));
}

/**
 * Finds the largest array-of-objects anywhere in the blob — the dataset's
 * actual rows. Breadth-limited: workspaces nest one or two levels
 * (`risk.deals`), never deeply.
 */
function findRecords(data: unknown): { path: string; rows: Array<Record<string, unknown>> } | null {
  let best: { path: string; rows: Array<Record<string, unknown>> } | null = null;
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 3 || node === null || typeof node !== 'object') return;
    if (isObjectArray(node)) {
      if (!best || node.length > best.rows.length) best = { path, rows: node };
      return;
    }
    if (Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // `_meta` is provenance and `_mobile` is the authored summary —
      // neither is the dataset.
      if (key === '_meta' || key === '_mobile') continue;
      visit(value, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  visit(data, '', 0);
  return best;
}

/** Lifts scalar leaves out of any `summary` object the workspace maintains. */
function findHeadline(data: unknown): MobileWorkspaceField[] {
  const summaries: Array<Record<string, unknown>> = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 3 || node === null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '_meta' || key === '_mobile') continue;
      if (/^(summary|totals|stats|overview)$/i.test(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        summaries.push(value as Record<string, unknown>);
      }
      visit(value, depth + 1);
    }
  };
  visit(data, 0);
  if (summaries.length === 0) return [];

  const fields: MobileWorkspaceField[] = [];
  for (const summary of summaries) {
    for (const [key, value] of Object.entries(summary)) {
      // Nested breakdowns (byStage, byBand) are charts, not tiles.
      if (!isScalar(value) || value === null || value === '') continue;
      // Labels like `thisMonthLabel` exist to caption other numbers.
      if (/label$/i.test(key)) continue;
      fields.push({ label: humanizeKey(key), value: formatValue(key, value) });
    }
  }
  // Numbers first — a tile row of counts and dollars beats a row of strings.
  return fields
    .sort((a, b) => Number(/^[\$\d]/.test(b.value)) - Number(/^[\$\d]/.test(a.value)))
    .slice(0, MAX_HEADLINE);
}

/** Ranks a row's keys and keeps the few that identify and qualify it. */
/**
 * Rows whose substance lives one level down project as nearly-empty cards:
 * a sales rep row of { name, id, thisWeek: {...}, wow: {...}, risk: {...} }
 * has two flat fields — one is the title, one is an id — so the phone showed
 * a bare list of names (live). When a row set is scalar-sparse like that,
 * flatten ONE level: nested scalar leaves become "This week calls"-style
 * fields and the normal field ranking takes over. Rows that are already flat
 * are returned untouched, so well-shaped workspaces cannot regress.
 */
export function flattenSparseRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (rows.length === 0) return rows;
  const sample = rows.slice(0, 20);
  const scalarCounts = sample.map((row) =>
    Object.values(row).filter((value) => isScalar(value) && value !== null && value !== '').length);
  const avgScalars = scalarCounts.reduce((a, b) => a + b, 0) / scalarCounts.length;
  const hasNested = sample.some((row) =>
    Object.values(row).some((value) => value && typeof value === 'object' && !Array.isArray(value)));
  if (avgScalars >= 3 || !hasNested) return rows;
  return rows.map((row) => {
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (isScalar(value)) {
        flat[key] = value;
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && !key.startsWith('_')) {
        for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
          if (isScalar(innerValue)) flat[`${key} ${innerKey}`] = innerValue;
        }
      }
    }
    return flat;
  });
}

export function chooseFields(rows: Array<Record<string, unknown>>): string[] {
  const keys = new Map<string, number>();
  for (const row of rows.slice(0, 20)) {
    for (const [key, value] of Object.entries(row)) {
      if (!isScalar(value) || value === null || value === '') continue;
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
  }
  const present = [...keys.entries()]
    // A field only half the rows have makes a ragged card.
    .filter(([, count]) => count >= Math.min(rows.length, 20) * 0.5)
    .map(([key]) => key);
  return present
    .sort((a, b) => nameRank(a) - nameRank(b) || a.localeCompare(b))
    .slice(0, MAX_FIELDS + 1);
}

/**
 * Pulls the nested breakdowns out of the summary — `byStage`, `byBand`,
 * `byLeadSource`. These are the shape of the dataset, and leaving them out
 * was the difference between "a summary" and "the data".
 */
function findBreakdowns(data: unknown): MobileWorkspaceBreakdown[] {
  const out: MobileWorkspaceBreakdown[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 3 || node === null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '_meta' || key === '_mobile') continue;
      if (/^(summary|totals|stats|overview)$/i.test(key) && value && typeof value === 'object') {
        for (const [groupKey, groupValue] of Object.entries(value as Record<string, unknown>)) {
          if (!groupValue || typeof groupValue !== 'object' || Array.isArray(groupValue)) continue;
          const pairs = Object.entries(groupValue as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'number' && Number.isFinite(v)) as Array<[string, number]>;
          if (pairs.length < 2) continue;
          const max = Math.max(...pairs.map(([, v]) => Math.abs(v))) || 1;
          out.push({
            label: humanizeKey(groupKey),
            entries: pairs
              .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
              .slice(0, MAX_BREAKDOWN_ENTRIES)
              .map(([k, v]) => ({
                label: humanizeKey(k),
                value: formatValue(groupKey, v),
                // Drives a bar so the distribution is readable at a glance.
                ratio: Math.min(1, Math.abs(v) / max),
              })),
          });
        }
        continue;
      }
      visit(value, depth + 1);
    }
  };
  visit(data, 0);
  return out.slice(0, MAX_BREAKDOWNS);
}

/**
 * Does this workspace belong on the phone?
 *
 * One rule, decided on the daemon so every surface agrees and it can be
 * tested. Content decides by default — a workspace with nothing to show is
 * a draft, and a real library is half drafts — but an explicit preference
 * always wins, because "keep this one, it fills in on Monday" and "never
 * show me this" are things only the owner knows.
 */
export function workspacePhonePresence(input: {
  show?: boolean;
  rows: number;
  hasSummary: boolean;
  lastRefreshedAt?: string | null;
}): { onPhone: boolean; reason: 'pinned' | 'hidden' | 'has-content' | 'empty-draft' } {
  if (input.show === true) return { onPhone: true, reason: 'pinned' };
  if (input.show === false) return { onPhone: false, reason: 'hidden' };
  if (input.rows > 0 || input.hasSummary) return { onPhone: true, reason: 'has-content' };
  return { onPhone: false, reason: 'empty-draft' };
}

export function projectWorkspaceData(data: unknown): MobileWorkspaceProjection {
  // A summary the workspace wrote for itself always beats one we guessed.
  const authored = readAuthoredProjection(data);
  if (authored) return authored;

  const headline = findHeadline(data);
  const breakdowns = findBreakdowns(data);
  const found = findRecords(data);
  if (!found) {
    return { recordPath: null, recordLabel: null, total: 0, shown: 0, headline, breakdowns, records: [] };
  }
  const { path, rows: rawRows } = found as { path: string; rows: Array<Record<string, unknown>> };
  const rows = flattenSparseRows(rawRows);
  const chosen = chooseFields(rows);
  const [primaryKey, ...rest] = chosen;
  const records: MobileWorkspaceRecord[] = rows.slice(0, MAX_RECORDS).map((row, index) => {
    const primary = primaryKey ? formatValue(primaryKey, row[primaryKey]) : `Row ${index + 1}`;
    return {
      key: String(row.id ?? row.Id ?? `${path}-${index}`),
      primary,
      fields: rest
        .filter((key) => isScalar(row[key]) && row[key] !== null && row[key] !== '')
        .map((key) => ({ label: humanizeKey(key), value: formatValue(key, row[key]) }))
        // A field repeating the card's own title is wasted width. Real data
        // does this constantly — an `account` primary beside a `name` of
        // "Scherr & Legate | Pablo Lopez" — so containment, not equality.
        .filter((field) => field.value !== primary && !field.value.includes(primary))
        .slice(0, MAX_FIELDS),
    };
  });
  const label = path.split('.').pop() ?? path;
  return {
    recordPath: path,
    recordLabel: humanizeKey(label),
    total: rows.length,
    shown: records.length,
    // Most workspaces have no `summary` object at all — the agent only writes
    // one when it decided the dataset needed condensing. Without a fallback
    // those open to a blank top-of-screen above a wall of cards, so derive the
    // few aggregates a phone can compute honestly from the rows themselves.
    headline: headline.length > 0 ? headline : deriveHeadline(rows, chosen),
    breakdowns,
    records,
  };
}

/**
 * A headline for datasets that never wrote a summary: the row count, plus a
 * total for the first money-ish column if there is one. Deliberately modest —
 * inventing statistics the workspace never claimed would be worse than an
 * empty space.
 */
function deriveHeadline(rows: Array<Record<string, unknown>>, chosen: string[]): MobileWorkspaceField[] {
  const fields: MobileWorkspaceField[] = [{ label: 'Records', value: rows.length.toLocaleString('en-US') }];
  const moneyKey = chosen.find((key) => CURRENCYISH.test(key) && rows.some((row) => typeof row[key] === 'number'));
  if (moneyKey) {
    const total = rows.reduce((sum, row) => sum + (typeof row[moneyKey] === 'number' ? (row[moneyKey] as number) : 0), 0);
    if (total > 0) fields.push({ label: `Total ${humanizeKey(moneyKey).toLowerCase()}`, value: formatValue(moneyKey, total) });
  }
  return fields;
}

export interface MobileSourceHealth {
  id: string;
  ok: boolean;
  refreshedAt: string | null;
  error: string | null;
}

/**
 * Per-source truth from `_meta`. A workspace whose last refresh failed still
 * carries yesterday's data and yesterday's `pulledAt`; without this the phone
 * would present stale numbers as current.
 */
/**
 * Runner failures carry whole stack traces. Verbatim, one of them buried the
 * entire workspace below the fold on a phone — so they are cut to the part
 * that identifies the failure, and the full text stays on the Mac.
 */
export function shortenDiagnostic(text: string, max = 140): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? text;
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function projectSourceHealth(data: unknown): MobileSourceHealth[] {
  if (!data || typeof data !== 'object') return [];
  const meta = (data as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== 'object') return [];
  return Object.entries(meta as Record<string, unknown>).map(([id, raw]) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    return {
      id,
      ok: entry.ok !== false,
      refreshedAt: typeof entry.refreshedAt === 'string' ? entry.refreshedAt : null,
      error: typeof entry.error === 'string' ? shortenDiagnostic(entry.error)
        : typeof entry.status === 'string' && entry.ok === false ? shortenDiagnostic(entry.status)
        : null,
    };
  });
}

// ─── the authored summary ───────────────────────────────────────────────────
//
// Everything above INFERS what matters from an opaque blob, and there is a
// hard ceiling on that: a real workspace's desktop view shows numbers like
// "Feature requests" that exist nowhere in the data — Clem computes them in
// her own view code. No heuristic can recover an intent that was never
// written down.
//
// So a workspace may write its own phone summary into `data.json` under
// `_mobile`, from the same runner that produces the data. That keeps the
// security boundary intact: the authored HTML view stays loopback-only, and
// what travels to the phone is plain DATA that no one executes.
//
// It is agent-authored, so none of it is trusted: every field is coerced,
// every list is capped, and anything malformed falls back to inference rather
// than propagating a broken shape to the phone.

const AUTHORED_MAX_TILES = 8;
const AUTHORED_MAX_RECORDS = 60;
const AUTHORED_MAX_FIELDS = 28;
const AUTHORED_MAX_BODY_CHARS = 4_000;
const AUTHORED_MAX_LINKS_PER_RECORD = 12;
const AUTHORED_MAX_URL_CHARS = 1_000;
/** Shared across every long body, link label, and URL in one response. */
const AUTHORED_LONG_CONTENT_BUDGET_CHARS = 48_000;

function asText(value: unknown, max = MAX_VALUE_CHARS): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function authoredFields(raw: unknown, cap: number): MobileWorkspaceField[] {
  if (!Array.isArray(raw)) return [];
  const out: MobileWorkspaceField[] = [];
  for (const entry of raw.slice(0, cap)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const label = asText(record.label, 40);
    const value = asText(record.value);
    if (label && value) out.push({ label, value });
  }
  return out;
}

function authoredBody(raw: unknown, budget: { remaining: number }): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const body = raw.trim();
  if (!body || budget.remaining <= 0) return undefined;
  const cap = Math.min(AUTHORED_MAX_BODY_CHARS, budget.remaining);
  const value = body.length <= cap
    ? body
    : cap > 1 ? `${body.slice(0, cap - 1)}…` : '…';
  budget.remaining -= value.length;
  return value;
}

function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > AUTHORED_MAX_URL_CHARS || /[\u0000-\u001f\u007f]/.test(text)) return null;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function authoredLinks(raw: unknown, budget: { remaining: number }): MobileWorkspaceLink[] {
  if (!Array.isArray(raw)) return [];
  const links: MobileWorkspaceLink[] = [];
  for (const candidate of raw.slice(0, AUTHORED_MAX_LINKS_PER_RECORD)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const label = asText(item.label, 80);
    const url = safeHttpUrl(item.url);
    if (!label || !url) continue;
    const cost = label.length + url.length;
    if (cost > budget.remaining) break;
    budget.remaining -= cost;
    links.push({ label, url });
  }
  return links;
}

/**
 * Reads `_mobile` if the workspace wrote one. Returns null when it is absent
 * or too malformed to be worth showing — inference then takes over, which is
 * why adding this can never make an existing workspace worse.
 *
 * Looked up at the top level AND one level inside each data source's output.
 * The nested spot is the one that actually works long-term: refresh rebuilds
 * data.json from per-source observations, so a top-level block written once
 * by hand is wiped on the next refresh — but a RUNNER that emits `_mobile`
 * inside its own result re-authors the layout with every refresh, so the
 * phone view can never go stale relative to the data it summarizes.
 */
export function readAuthoredProjection(data: unknown): MobileWorkspaceProjection | null {
  if (!data || typeof data !== 'object') return null;
  const doc = data as Record<string, unknown>;
  let authored = doc._mobile;
  if (!authored || typeof authored !== 'object' || Array.isArray(authored)) {
    authored = undefined;
    for (const [key, value] of Object.entries(doc)) {
      if (key.startsWith('_') || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const nested = (value as Record<string, unknown>)._mobile;
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        authored = nested;
        break;
      }
    }
  }
  if (!authored || typeof authored !== 'object' || Array.isArray(authored)) return null;
  const block = authored as Record<string, unknown>;

  const headline = authoredFields(block.headline, AUTHORED_MAX_TILES);

  const breakdowns: MobileWorkspaceBreakdown[] = [];
  if (Array.isArray(block.breakdowns)) {
    for (const raw of block.breakdowns.slice(0, MAX_BREAKDOWNS)) {
      if (!raw || typeof raw !== 'object') continue;
      const group = raw as Record<string, unknown>;
      const label = asText(group.label, 40);
      if (!label || !Array.isArray(group.entries)) continue;
      const entries = group.entries
        .slice(0, MAX_BREAKDOWN_ENTRIES)
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const e = entry as Record<string, unknown>;
          const entryLabel = asText(e.label, 40);
          const value = asText(e.value, 24);
          if (!entryLabel || !value) return null;
          // A bar is only honest if the ratio is real; when the author gave
          // none, derive it from the numbers rather than invent a length.
          const ratio = typeof e.ratio === 'number' && Number.isFinite(e.ratio)
            ? Math.max(0, Math.min(1, e.ratio))
            : null;
          return { label: entryLabel, value, ratio, raw: typeof e.value === 'number' ? e.value : null };
        })
        .filter((e): e is { label: string; value: string; ratio: number | null; raw: number | null } => e !== null);
      if (entries.length < 2) continue;
      const max = Math.max(...entries.map((e) => Math.abs(e.raw ?? 0))) || 0;
      breakdowns.push({
        label,
        entries: entries.map((e) => ({
          label: e.label,
          value: e.value,
          ratio: e.ratio ?? (max > 0 ? Math.min(1, Math.abs(e.raw ?? 0) / max) : 0),
        })),
      });
    }
  }

  const recordsBlock = (block.records && typeof block.records === 'object' && !Array.isArray(block.records))
    ? block.records as Record<string, unknown>
    : null;
  const items = Array.isArray(recordsBlock?.items) ? recordsBlock!.items : [];
  const longContentBudget = { remaining: AUTHORED_LONG_CONTENT_BUDGET_CHARS };
  const records: MobileWorkspaceRecord[] = items
    .slice(0, AUTHORED_MAX_RECORDS)
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      const primary = asText(item.primary);
      if (!primary) return null;
      const body = authoredBody(item.body, longContentBudget);
      const links = authoredLinks(item.links, longContentBudget);
      return {
        key: asText(item.key, 64) ?? `authored-${index}`,
        primary,
        fields: authoredFields(item.fields, AUTHORED_MAX_FIELDS),
        ...(body ? { body } : {}),
        ...(links.length > 0 ? { links } : {}),
      };
    })
    .filter((r): r is MobileWorkspaceRecord => r !== null);

  // An authored block that says nothing is not an improvement on inference.
  if (headline.length === 0 && records.length === 0 && breakdowns.length === 0) return null;

  const total = typeof recordsBlock?.total === 'number' && Number.isFinite(recordsBlock.total)
    ? Math.max(records.length, Math.floor(recordsBlock.total))
    : records.length;

  return {
    recordPath: '_mobile',
    recordLabel: asText(recordsBlock?.label, 40) ?? (records.length > 0 ? 'Records' : null),
    total,
    shown: records.length,
    headline,
    breakdowns,
    records,
  };
}
