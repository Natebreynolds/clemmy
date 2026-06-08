/**
 * Workspace authoring gap test — the Space mirror of workflow-gap-test.ts.
 *
 * checkSpaceForWrite (space-enforce.ts) BLOCKS the Workspace-killers (a source
 * with no backend, a missing runner file, a bad cron). This is the softer half:
 * a deterministic, no-LLM/no-API pass over a freshly-saved Workspace that
 * surfaces the gaps which won't fail validation but WILL produce a wrong/empty
 * surface — and turns each into a plain clarifying QUESTION for Clem to ask the
 * user before the Workspace is relied on.
 *
 * Conservative (the owner's "don't make simple workflows hard"): each heuristic
 * fires only on a clear signal and the whole report is capped, so a thin, well-
 * formed Workspace saves with zero questions.
 */
import type { SpaceRecord } from './store.js';

export interface SpaceGap {
  severity: 'clarify';
  sourceId?: string;
  actionId?: string;
  question: string;
  why: string;
}

const MAX_GAPS = 5;

const SEND_LIKE_RE = /\b(send|reply|email|message|publish|post|tweet|dm|invite|sms|notify)\b/i;
const RECIPIENT_KEY_RE = /\b(to|to_email|toemail|recipient|recipients|email|address|toaddress|to_address)\b/i;

function actionLooksLikeSend(a: SpaceRecord['actions'][number]): boolean {
  // Normalize underscores to spaces so \b matches inside slugs like
  // OUTLOOK_OUTLOOK_SEND_EMAIL (underscores are word chars → no boundary).
  const hay = `${a.composioSlug ?? ''} ${a.runner ?? ''} ${a.label ?? ''} ${a.id}`.replace(/_/g, ' ');
  return SEND_LIKE_RE.test(hay);
}

function templateHasRecipient(a: SpaceRecord['actions'][number]): boolean {
  const tpl = a.argsTemplate ?? {};
  return Object.keys(tpl).some((k) => RECIPIENT_KEY_RE.test(k.replace(/_/g, ' ')));
}

/**
 * Run the gap test over a saved Workspace + its installed view HTML. Returns
 * clarifying questions (possibly empty). Deterministic, side-effect free.
 * `zeroRowSourceIds` is fed from the creation smoke (space-smoke.ts) so a source
 * that returned nothing becomes a question too.
 */
export function analyzeSpaceGaps(
  record: SpaceRecord,
  viewHtml: string,
  zeroRowSourceIds: string[] = [],
): SpaceGap[] {
  const gaps: SpaceGap[] = [];
  const html = viewHtml ?? '';
  const sources = record.dataSources ?? [];

  // 1: the view never fetches its data at all.
  if (sources.length > 0 && !/\/data\b/.test(html) && !/\/refresh\b/.test(html)) {
    gaps.push({
      severity: 'clarify',
      question: `The view declares ${sources.length} data source${sources.length === 1 ? '' : 's'} but its HTML never calls GET …/data — how does the surface get populated?`,
      why: 'The Workspace will render empty on load — the data is fetched, not embedded.',
    });
  }

  // 2: the view never references a declared source by id (so it can't be reading
  // its rows). NB: the data is nested at data["<id>"] — a view that reads the
  // wrong key renders 0 rows (the exact bug from the first real build).
  for (const s of sources) {
    if (html && !html.includes(s.id)) {
      gaps.push({
        severity: 'clarify',
        sourceId: s.id,
        question: `The view never references source "${s.id}" — confirm it reads the rows from data["${s.id}"] (the /refresh route nests each source's output under its id, so the array is at data["${s.id}"].<yourKey>).`,
        why: 'Reading the wrong key renders an empty table even though the data is there — the most common Workspace bug.',
      });
    }
  }

  // 3: a send-like action whose args template carries no recipient — confirm the
  // view supplies it, so it can't go to the wrong person (or nobody).
  for (const a of record.actions ?? []) {
    if (!actionLooksLikeSend(a)) continue;
    if (templateHasRecipient(a)) continue;
    gaps.push({
      severity: 'clarify',
      actionId: a.id,
      question: `Action "${a.id}" sends to the outside world but its argsTemplate has no recipient — does the view supply the recipient (to/to_email) at click time, and is it always the right person?`,
      why: 'A send to nobody — or the wrong person — is the costliest thing to get wrong.',
    });
  }

  // 4: a source that returned ZERO rows in the creation smoke.
  for (const id of zeroRowSourceIds) {
    gaps.push({
      severity: 'clarify',
      sourceId: id,
      question: `Source "${id}" returned 0 rows when I ran it — is that expected right now, or is the query/filter wrong?`,
      why: 'An empty data source ships a working-looking but useless Workspace.',
    });
  }

  return gaps.slice(0, MAX_GAPS);
}

/**
 * Render gap questions for the space_save tool result so the AUTHORING agent
 * asks the user before the Workspace is relied on. Empty string when there are
 * no gaps (a clean save stays byte-identical).
 */
export function renderSpaceGapQuestions(gaps: SpaceGap[]): string {
  if (gaps.length === 0) return '';
  const lines = gaps.map((g) => `- ${g.question}\n  (why: ${g.why})`);
  return [
    '',
    '',
    "Gap test — before this Workspace is reliable, get the user's answer on:",
    ...lines,
    '',
    'Ask these now, then refine with space_save (same slug). Do not present it as ready until they\'re resolved.',
  ].join('\n');
}
