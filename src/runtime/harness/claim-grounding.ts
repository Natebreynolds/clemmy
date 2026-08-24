/**
 * Claim grounding — the pointer-shaped sibling of the output-grounding
 * (figures) judge, born from two live 2026-07-30 incidents: a reply handed the
 * user a production URL that had never been fetched or published ("verified"
 * came from a resource-exists check), and the general class behind it — a
 * final reply can hand over ANY deliverable pointer (a URL, a file path, a
 * "pushed"/"sent" claim) that nothing in the run ever observed.
 *
 * Philosophy (owner-set, explicit): NO provider rules, NO URL/domain
 * knowledge, NO verification recipes. The harness only asks one structural
 * question — "did this run OBSERVE the thing the reply hands over?" — and when
 * the answer is no, the model gets ONE advisory nudge to check it however it
 * sees fit or to say plainly what is real. A brand-new project shape works on
 * day one because nothing here is shaped like any particular task.
 *
 * Everything in this module is pure; the loop supplies the evidence texts
 * (lossless tool outputs + call args — the run's observation set).
 */

export interface DeliverablePointer {
  kind: 'url' | 'path';
  /** As written in the reply. */
  raw: string;
  /** Canonical comparison form (lowercased; URLs lose scheme/trailing slash). */
  normalized: string;
  /** Distinctive token for indexed evidence search (host or basename). */
  searchTerm: string;
}

const URL_RE = /https?:\/\/[^\s<>()'"\]]+/gi;
// A path claim: contains a slash and a plausible file/dir shape, or a
// backtick-quoted relative path. Conservative — misses are status quo; a false
// hit only risks an unnecessary (and cheap) advisory.
const PATH_RE = /(?:^|[\s`("'])((?:~?\/|\.\/)?(?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:html?|pdf|mdx?|docx?|pptx?|xlsx?|csv|png|jpe?g|json|zip|pages|key)\b)/g;

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?)*\]]+$/, '');
}

export function normalizeUrl(url: string): string {
  return stripTrailingPunctuation(url)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

/** Extract the pointers a reply hands the user. Deduped by normalized form. */
export function extractDeliverablePointers(text: string): DeliverablePointer[] {
  const out = new Map<string, DeliverablePointer>();
  if (!text || typeof text !== 'string') return [];
  for (const match of text.matchAll(URL_RE)) {
    const raw = stripTrailingPunctuation(match[0]);
    const normalized = normalizeUrl(raw);
    if (normalized.length < 4) continue;
    const host = normalized.split('/')[0] ?? normalized;
    out.set(normalized, { kind: 'url', raw, normalized, searchTerm: host });
  }
  for (const match of text.matchAll(PATH_RE)) {
    const raw = stripTrailingPunctuation(match[1]);
    const normalized = raw.toLowerCase().replace(/\/+$/, '');
    // Skip URL fragments already captured and trivial names.
    if (normalized.length < 6 || [...out.values()].some((p) => p.normalized.includes(normalized))) continue;
    // A bare well-known filename with no directory context is usually prose
    // ("update the README.md") — require a slash OR a document-ish extension.
    const hasSlash = normalized.includes('/');
    const documentish = /\.(html?|pdf|docx?|pptx?|xlsx?|csv|png|jpe?g|zip|pages|key)$/.test(normalized);
    if (!hasSlash && !documentish) continue;
    const segments = normalized.split('/').filter(Boolean);
    // Slash-delimited clock shorthand is a schedule, not a filesystem path
    // (live 2026-08-20: `8am/12pm/4pm` in a workflow schedule was treated as
    // three path segments and caused a false verification bounce after a
    // successful `workflow_get`). Keep this structural: every segment must be
    // a standalone clock token, so real paths that merely contain a time-like
    // directory remain eligible.
    const clockSequence = segments.length >= 2
      && segments.every((segment) => /^(?:(?:[01]?\d|2[0-3])(?::[0-5]\d)?(?:am|pm)?|noon|midnight)$/i.test(segment));
    if (clockSequence) continue;
    // A slashed pair of short plain words is prose, not a path: "call/task
    // records", "a yes/no decision", "24/7", "and/or" (live 2026-08-12: two
    // such pairs inside a quoted draft were judged as undelivered file paths
    // and bounced the user's own requested content into a verification
    // summary). Real paths keep grounding through an extension, a ./ ~/ /
    // marker, depth, or segment shapes prose pairs never have (dots, dashes,
    // underscores).
    const pathMarked = /^(?:~?\/|\.\/)/.test(raw);
    const prosePair = !documentish
      && !pathMarked
      && segments.length === 2
      && segments.every((segment) => /^[a-z0-9]{1,12}$/.test(segment));
    if (prosePair) continue;
    const basename = segments[segments.length - 1] || normalized;
    out.set(normalized, { kind: 'path', raw, normalized, searchTerm: basename });
  }
  return [...out.values()];
}

/** Comparison forms that count as evidence for a pointer. Structural only:
 *  a URL matches with/without scheme and by host+path; a path matches whole
 *  or by its last two segments (absolute-vs-relative tolerance). */
export function pointerEvidenceForms(pointer: DeliverablePointer): string[] {
  if (pointer.kind === 'url') {
    return [pointer.normalized];
  }
  const segments = pointer.normalized.split('/').filter(Boolean);
  const forms = [pointer.normalized];
  if (segments.length >= 2) forms.push(segments.slice(-2).join('/'));
  else if (segments.length === 1) forms.push(segments[0]);
  return forms;
}

/** Pure grounding check: a pointer is grounded when ANY evidence text contains
 *  one of its comparison forms (case-insensitive substring). */
export function ungroundedPointers(
  pointers: DeliverablePointer[],
  evidenceTexts: Iterable<string>,
): DeliverablePointer[] {
  if (pointers.length === 0) return [];
  const texts: string[] = [];
  for (const text of evidenceTexts) {
    if (typeof text === 'string' && text) texts.push(text.toLowerCase());
  }
  return pointers.filter((pointer) => {
    const forms = pointerEvidenceForms(pointer);
    return !texts.some((text) => forms.some((form) => text.includes(form)));
  });
}

/**
 * Call ids of THIS run's own recall reads (`recall_tool_result` /
 * `tool_output_query`). Bytes the model re-read this run are observed by
 * definition — this judge exists to catch invented pointers, never quotes of
 * content the run just had in context (live 2026-08-12: a reply quoting the
 * user's own requested draft, freshly recalled, was bounced as ungrounded and
 * replaced with a verification summary). Recall outputs remain
 * presentation-only for AUTHORITY resolution; they count here as grounding
 * evidence only.
 */
export function recallReadCallIdsForSource(
  events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>,
  sourceUserSeq: number,
): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool_called') continue;
    if (event.data.sourceUserSeq !== sourceUserSeq) continue;
    const tool = event.data.tool;
    if (tool !== 'recall_tool_result' && tool !== 'tool_output_query') continue;
    const callId = event.data.callId;
    if (typeof callId === 'string' && callId.trim()) out.push(callId.trim());
  }
  return [...new Set(out)];
}

/** The ONE advisory bounce, model-owned resolution. Null when everything the
 *  reply hands over is evidenced. */
export function claimGroundingNudge(ungrounded: DeliverablePointer[]): string | null {
  if (ungrounded.length === 0) return null;
  const listed = ungrounded.slice(0, 3).map((p) => `"${p.raw}"`).join(', ');
  const more = ungrounded.length > 3 ? ` (and ${ungrounded.length - 3} more)` : '';
  return `[claim-grounding] Your reply hands the user ${listed}${more}, but nothing in this run ever observed ${ungrounded.length === 1 ? 'it' : 'them'} — no tool output, receipt, or file listing mentions ${ungrounded.length === 1 ? 'it' : 'them'}. `
    + 'Before delivering: check whatever you are handing over actually exists, in whatever way fits (open it, list it, fetch it) — or re-state your reply to say plainly what is real and what is not yet. '
    + 'If the pointer genuinely appeared in your own verified work this turn, re-state your reply unchanged.';
}
