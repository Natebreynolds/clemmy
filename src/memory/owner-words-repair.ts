import { openMemoryDb } from './db.js';
import { forgetFact } from './facts.js';
import { acceptedOwnerTexts } from './auto-capture.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { bumpStableContextGeneration } from '../runtime/stable-context-generation.js';

/**
 * Automatic memory admits only the owner's words: the message a capture
 * consumes must lie inside the accepted source it cites. Rows admitted before
 * that boundary held can carry host text — a reviewed plan expanded for
 * Execute — as a pinned standing rule that then rides every prompt and every
 * tool result bound to its toolkit.
 *
 * This pass retires exactly those rows and nothing it cannot prove. A fact is
 * retired only when its text is verbatim what automatic capture proposed, and
 * every accepted source that proposed it is on record and does not contain the
 * message capture consumed. One source that does contain it keeps the fact; a
 * source that is missing or unreadable keeps it too. Retirement is the ordinary
 * soft forget: the fact, its candidates and its episodes remain for audit.
 */

const OWNER_SOURCE_CALL_RE = /^auto-capture:user-source:(\d+)$/;

export interface OwnerWordsRepairResult {
  scanned: number;
  retired: Array<{ factId: number; sources: string[] }>;
  kept: number;
  unverifiable: number;
}

interface CaptureProposalRow {
  fact_id: number;
  session_id: string | null;
  call_id: string | null;
  evidence_excerpt: string | null;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

type ProposalVerdict = 'owner_words' | 'not_owner_words' | 'unverifiable';

export function retireAutoCaptureFactsOutsideOwnerWords(
  options: { dryRun?: boolean } = {},
): OwnerWordsRepairResult {
  const rows = openMemoryDb().prepare(`
    SELECT cf.id AS fact_id, mrc.session_id, mrc.call_id, me.evidence_excerpt
      FROM consolidated_facts cf
      JOIN memory_reflection_candidates mrc
        ON mrc.resulting_fact_id = cf.id AND mrc.source_type = 'auto_capture'
      LEFT JOIN memory_episodes me ON me.id = mrc.episode_id
     WHERE cf.active = 1 AND mrc.text = cf.content
     ORDER BY cf.id
  `).all() as CaptureProposalRow[];

  const proposalsByFact = new Map<number, CaptureProposalRow[]>();
  for (const row of rows) {
    const list = proposalsByFact.get(row.fact_id) ?? [];
    list.push(row);
    proposalsByFact.set(row.fact_id, list);
  }

  const sourceRow = openEventLog().prepare(`
    SELECT type, data_json FROM events WHERE session_id = ? AND seq = ?
  `);
  const judge = (row: CaptureProposalRow): ProposalVerdict => {
    const seq = OWNER_SOURCE_CALL_RE.exec(row.call_id ?? '')?.[1];
    const consumed = normalize(row.evidence_excerpt ?? '');
    if (!seq || !row.session_id || !consumed) return 'unverifiable';
    const event = sourceRow.get(row.session_id, Number(seq)) as { type: string; data_json: string } | undefined;
    if (!event || event.type !== 'user_input_received') return 'unverifiable';
    let data: unknown;
    try { data = JSON.parse(event.data_json); } catch { return 'unverifiable'; }
    if (!data || typeof data !== 'object') return 'unverifiable';
    const owner = acceptedOwnerTexts(data as Record<string, unknown>);
    if (owner.length === 0) return 'unverifiable';
    return owner.some((text) => normalize(text).includes(consumed)) ? 'owner_words' : 'not_owner_words';
  };

  const result: OwnerWordsRepairResult = { scanned: proposalsByFact.size, retired: [], kept: 0, unverifiable: 0 };
  for (const [factId, proposals] of proposalsByFact) {
    const verdicts = proposals.map(judge);
    if (verdicts.includes('owner_words')) { result.kept += 1; continue; }
    if (verdicts.includes('unverifiable')) { result.unverifiable += 1; continue; }
    const sources = [...new Set(proposals.map((row) => `${row.session_id}#${row.call_id}`))];
    if (options.dryRun || forgetFact(factId)) result.retired.push({ factId, sources });
  }
  if (!options.dryRun && result.retired.length > 0) {
    try { bumpStableContextGeneration(); } catch { /* generation bump is best-effort */ }
  }
  return result;
}
