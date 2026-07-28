/**
 * Pure state logic for editing a Workspace operating contract (Purpose /
 * Done when / Always preserve). The server clips objectives at 1200 chars and
 * lists at 12×500 — the editor surfaces every limit explicitly instead of
 * letting anything truncate or no-op silently.
 */
export const OBJECTIVE_MAX_CHARS = 1200;
export const LIST_MAX_ITEMS = 12;
export const LIST_ITEM_MAX_CHARS = 500;

export interface ListParseResult {
  items: string[];
  /** Human notes about anything the parse had to drop/clip — shown, never silent. */
  warnings: string[];
}

/** One item per line; blanks dropped; caps surfaced as warnings. */
export function parseListInput(text: string, label: string): ListParseResult {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean);
  const warnings: string[] = [];
  let items = lines;
  if (items.length > LIST_MAX_ITEMS) {
    warnings.push(`${label}: only the first ${LIST_MAX_ITEMS} items are kept (${items.length} entered).`);
    items = items.slice(0, LIST_MAX_ITEMS);
  }
  const long = items.filter((item) => item.length > LIST_ITEM_MAX_CHARS);
  if (long.length > 0) {
    warnings.push(`${label}: ${long.length} item${long.length === 1 ? '' : 's'} over ${LIST_ITEM_MAX_CHARS} characters will be shortened.`);
    items = items.map((item) => item.slice(0, LIST_ITEM_MAX_CHARS));
  }
  return { items, warnings };
}

export interface ContractDraft {
  objective: string;
  criteriaText: string;
  invariantsText: string;
  /** Whether the workspace already has a pinned contract. */
  hadContract: boolean;
}

export interface ContractDraftValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** The PATCH body to send when ok. Blank objective on an existing contract
   *  means "objective unchanged" (server semantics) and is omitted. */
  patch: { objective?: string; successCriteria: string[]; invariants: string[] } | null;
}

export function validateContractDraft(draft: ContractDraft): ContractDraftValidation {
  const objective = draft.objective.trim();
  const criteria = parseListInput(draft.criteriaText, 'Done when');
  const invariants = parseListInput(draft.invariantsText, 'Always preserve');
  const errors: string[] = [];

  if (objective.length > OBJECTIVE_MAX_CHARS) {
    errors.push(`The purpose is ${objective.length} characters — the limit is ${OBJECTIVE_MAX_CHARS}. Trim it rather than letting it be cut off mid-sentence.`);
  }
  if (!objective && !draft.hadContract) {
    errors.push('A purpose is required before Done-when or Always-preserve items can be saved.');
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings: [...criteria.warnings, ...invariants.warnings],
    patch: ok
      ? {
          ...(objective ? { objective } : {}),
          successCriteria: criteria.items,
          invariants: invariants.items,
        }
      : null,
  };
}
