/**
 * Lines that may carry authoritative final-presentation bindings.
 *
 * Quoted/example/code content is still part of the delivered reply, but it
 * cannot lend field or table authority to an exact-completion certificate.
 * Keep this scanner presentation-only: it does not rewrite or remove bytes.
 */
export function authoritativePresentationLineMask(text: string): boolean[] {
  const mask: boolean[] = [];
  let fence: { character: string; length: number } | null = null;
  let htmlComment = false;
  let htmlLiteralTag: string | null = null;
  let lazyBlockquoteParagraph = false;

  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closing
        && closing[1]![0] === fence.character
        && closing[1]!.length >= fence.length) fence = null;
      mask.push(false);
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      const marker = opening[1]!;
      fence = { character: marker[0]!, length: marker.length };
      mask.push(false);
      continue;
    }

    if (htmlComment) {
      if (line.includes('-->')) htmlComment = false;
      mask.push(false);
      continue;
    }
    if (htmlLiteralTag) {
      if (new RegExp(`</${htmlLiteralTag}\\s*>`, 'i').test(line)) htmlLiteralTag = null;
      mask.push(false);
      continue;
    }
    const commentAt = line.indexOf('<!--');
    if (commentAt >= 0) {
      if (line.indexOf('-->', commentAt + 4) < 0) htmlComment = true;
      mask.push(false);
      continue;
    }
    const literalOpen = /<(blockquote|code|pre|script|style|textarea|xmp)\b/i.exec(line);
    if (literalOpen) {
      const tag = literalOpen[1]!.toLowerCase();
      if (!new RegExp(`</${tag}\\s*>`, 'i').test(line.slice((literalOpen.index ?? 0) + literalOpen[0].length))) {
        htmlLiteralTag = tag;
      }
      mask.push(false);
      continue;
    }

    const blockquote = /^\s*>\s?(.*)$/.exec(line);
    if (blockquote) {
      lazyBlockquoteParagraph = Boolean(blockquote[1]?.trim());
      mask.push(false);
      continue;
    }
    if (lazyBlockquoteParagraph) {
      if (!line.trim()) lazyBlockquoteParagraph = false;
      else {
        mask.push(false);
        continue;
      }
    }

    mask.push(!/^(?: {0,3}\t| {4})/.test(line)
      && !/^\s*(?:`|~~)/.test(line));
  }
  return mask;
}

export interface AuthoritativeMarkdownTable {
  headerLineIndex: number;
  endLineIndex: number;
  headers: string[];
  rows: string[][];
  lineIndexes: number[];
}

export interface AuthoritativeMarkdownTableParse {
  claimed: boolean;
  valid: boolean;
  tables: AuthoritativeMarkdownTable[];
  lineIndexes: Set<number>;
}

function markdownTableCells(line: string): string[] | null {
  if (!/^\s*\|.*\|\s*$/.test(line)) return null;
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
}

function markdownTableDivider(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** Parse only complete, authoritative CommonMark-style pipe tables.
 *
 * Every authoritative pipe line must belong to one exact header/divider/data
 * block. Consumers still own the allowed header and row schemas, but malformed
 * or detached tables can never disappear wholesale from narrative checking.
 */
export function parseAuthoritativeMarkdownTables(text: string): AuthoritativeMarkdownTableParse {
  const lines = text.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(text);
  const claimedIndexes = lines
    .map((line, index) => authority[index] && markdownTableCells(line) ? index : -1)
    .filter((index) => index >= 0);
  const lineIndexes = new Set<number>();
  const tables: AuthoritativeMarkdownTable[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!authority[index] || lineIndexes.has(index)) continue;
    const headers = markdownTableCells(lines[index]!);
    const divider = index + 1 < lines.length && authority[index + 1]
      ? markdownTableCells(lines[index + 1]!)
      : null;
    if (!headers
      || !divider
      || headers.length !== divider.length
      || !markdownTableDivider(divider)) continue;

    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && authority[cursor]) {
      const row = markdownTableCells(lines[cursor]!);
      if (!row) break;
      const following = cursor + 1 < lines.length && authority[cursor + 1]
        ? markdownTableCells(lines[cursor + 1]!)
        : null;
      // Let an immediately-adjacent header/divider pair begin a new table.
      if (following
        && row.length === following.length
        && markdownTableDivider(following)) break;
      if (row.length !== headers.length || markdownTableDivider(row)) break;
      rows.push(row);
      cursor += 1;
    }
    if (rows.length === 0) continue;

    const owned = Array.from(
      { length: cursor - index },
      (_, offset) => index + offset,
    );
    for (const lineIndex of owned) lineIndexes.add(lineIndex);
    tables.push({
      headerLineIndex: index,
      endLineIndex: cursor - 1,
      headers,
      rows,
      lineIndexes: owned,
    });
    index = cursor - 1;
  }

  return {
    claimed: claimedIndexes.length > 0,
    valid: claimedIndexes.every((index) => lineIndexes.has(index)),
    tables,
    lineIndexes,
  };
}

export interface ScopedProviderSnapshotBlock {
  headingLineIndex: number;
  itemLineIndex: number;
  sourceLineIndex: number;
  scope: string;
  providerQualifier: string;
  revision: string;
  itemId: string;
  title: string;
  status: string;
  sourceMarker: string;
  narrativeSuffix: string | null;
  narrativeSuffixStatus: string | null;
}

export interface ScopedProviderSnapshotParse {
  claimed: boolean;
  valid: boolean;
  blocks: ScopedProviderSnapshotBlock[];
}

function plainPresentationLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

/** Parse one exact collection-count heading such as `**Items (1 total):**`.
 *
 * This is deliberately narrower than a generic Markdown heading parser. It is
 * useful when a model labels the row table between an exact metadata table and
 * an exact one-row snapshot; callers still bind the count to the provider rows
 * and require the line itself to be authoritative.
 */
export function parseCollectionCountHeading(line: string): {
  count: number;
  noun: 'items' | 'records' | 'rows' | 'tasks';
} | null {
  const match = /^(items|records|rows|tasks)\s*\(\s*(\d+)\s+total\s*\)\s*:\s*$/i.exec(
    plainPresentationLine(line),
  );
  if (!match) return null;
  const count = Number(match[2]);
  if (!Number.isSafeInteger(count) || count < 0) return null;
  return {
    count,
    noun: match[1]!.toLowerCase() as 'items' | 'records' | 'rows' | 'tasks',
  };
}

export interface CollectionStatusSummary {
  count: number;
  noun: 'item' | 'record' | 'row' | 'task';
  status: string | null;
  revision: number | null;
  continuity: boolean;
}

function exactCountToken(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const count = Number(value);
    return Number.isSafeInteger(count) ? count : null;
  }
  if (/^one$/i.test(value)) return 1;
  if (/^zero$/i.test(value)) return 0;
  return null;
}

/** Parse a whole, compact collection summary without borrowing incidental
 * numbers or status words from surrounding prose. */
export function parseCollectionStatusSummary(line: string): CollectionStatusSummary | null {
  const plain = plainPresentationLine(line);
  const normalizeNoun = (value: string): CollectionStatusSummary['noun'] => (
    value.toLowerCase().replace(/s$/, '') as CollectionStatusSummary['noun']
  );
  const labeled = /^total\s*:\s*(\d+|one|zero)\s+(items?|records?|rows?|tasks?)[.!]?$/i.exec(plain)
    ?? /^total\s+(items?|records?|rows?|tasks?)\s*:\s*(\d+|one|zero)[.!]?$/i.exec(plain);
  if (labeled) {
    const reversed = /^total\s+(?:items?|records?|rows?|tasks?)\s*:/i.test(plain);
    const count = exactCountToken(labeled[reversed ? 2 : 1] ?? '');
    if (count === null) return null;
    return {
      count,
      noun: normalizeNoun(labeled[reversed ? 1 : 2] ?? 'item'),
      status: null,
      revision: null,
      continuity: false,
    };
  }

  const compact = /^(still\s+)?(\d+|one|zero)\s+(?:([A-Za-z][A-Za-z0-9_-]*)\s+)?(items?|records?|rows?|tasks?)(?:\s+total(?:,\s*all\s+([A-Za-z][A-Za-z0-9_-]*))?|(?:\s+in\s+(?:the\s+)?(?:queue|feed|list|snapshot))?(?:,\s*at\s+revision\s+(\d+))?)[.!]?$/i.exec(plain);
  if (!compact) return null;
  const count = exactCountToken(compact[2] ?? '');
  if (count === null) return null;
  const prefixStatus = compact[3]?.toLowerCase() ?? null;
  const allStatus = compact[5]?.toLowerCase() ?? null;
  if (prefixStatus && allStatus && prefixStatus !== allStatus) return null;
  const revision = compact[6] === undefined ? null : Number(compact[6]);
  if (revision !== null && !Number.isSafeInteger(revision)) return null;
  return {
    count,
    noun: normalizeNoun(compact[4] ?? 'item'),
    status: prefixStatus ?? allStatus,
    revision,
    continuity: Boolean(compact[1]),
  };
}

export interface ReadNavigationHeading {
  ownerMentioned: boolean;
  sameSource: boolean;
  changedState: boolean;
}

/** Parse a fact-free read/navigation heading compositionally.
 *
 * Values, field labels, modal/disclaimer words, and unknown vocabulary are not
 * accepted. Consumers bind same-source and changed-state modifiers to the
 * accepted objective/phase; the heading itself never supplies snapshot data.
 */
export function parseReadNavigationHeading(
  line: string,
  ownerScope: string,
): ReadNavigationHeading | null {
  const plain = plainPresentationLine(line);
  if (!/:\s*$/.test(plain) || /\d/.test(plain)) return null;
  const body = plain.replace(/:\s*$/, '').trim();
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const owner = escape(ownerScope.trim()).replace(/\s+/g, '\\s+');
  const ownerNoun = escape(ownerScope.trim().split(/\s+/).at(-1) ?? '');
  if (!owner) return null;
  const sameSource = 'from\\s+the\\s+same(?:\\s+connected)?\\s+source';
  const productions: Array<{
    pattern: RegExp;
    ownerMentioned: boolean;
    sameSource: boolean;
    changedState: boolean;
  }> = [
    {
      pattern: new RegExp(`^(?:here(?:'|’)s|here\\s+is)\\s+the\\s+(?:current\\s+)?${owner}(?:\\s+result)?$`, 'i'),
      ownerMentioned: true,
      sameSource: false,
      changedState: false,
    },
    {
      pattern: new RegExp(`^here\\s+(?:are|is)\\s+the\\s+(?:current|latest)\\s+(?:items?|records?|rows?|tasks?)\\s+(?:in|from|for|on)\\s+(?:the\\s+)?${owner}$`, 'i'),
      ownerMentioned: true,
      sameSource: false,
      changedState: false,
    },
    {
      pattern: /^fresh\s+data\s+from\s+the\s+same(?:\s+connected)?\s+source$/i,
      ownerMentioned: false,
      sameSource: true,
      changedState: false,
    },
    {
      pattern: new RegExp(`^fresh\\s+pull\\s+from\\s+(?:the\\s+)?${ownerNoun}$`, 'i'),
      ownerMentioned: true,
      sameSource: false,
      changedState: false,
    },
    {
      pattern: new RegExp(`^${owner}\\s*[—–-]\\s*current\\s+items$`, 'i'),
      ownerMentioned: true,
      sameSource: false,
      changedState: false,
    },
    {
      pattern: new RegExp(`^${owner}\\s+(?:is\\s+)?(?:refreshed|updated)(?:\\s+${sameSource})?$`, 'i'),
      ownerMentioned: true,
      sameSource: new RegExp(`\\s${sameSource}$`, 'i').test(body),
      changedState: false,
    },
    {
      pattern: new RegExp(`^(?:refreshed|updated)\\s+(?:the\\s+)?${owner}(?:\\s+${sameSource})?$`, 'i'),
      ownerMentioned: true,
      sameSource: new RegExp(`\\s${sameSource}$`, 'i').test(body),
      changedState: false,
    },
    {
      pattern: new RegExp(`^(?:fresh\\s+)?read(?:\\s+complete)?(?:\\s+${sameSource})?$`, 'i'),
      ownerMentioned: false,
      sameSource: new RegExp(`\\s${sameSource}$`, 'i').test(body),
      changedState: false,
    },
    {
      pattern: /^(?:fresh\s+)?read(?:\s+complete)?\s*[—–-]\s*(?:the\s+)?provider\s+state\s+(?:updated|changed|advanced)$/i,
      ownerMentioned: false,
      sameSource: false,
      changedState: true,
    },
  ];
  const matched = productions.find((production) => production.pattern.test(body));
  return matched
    ? {
        ownerMentioned: matched.ownerMentioned,
        sameSource: matched.sameSource,
        changedState: matched.changedState,
      }
    : null;
}

/** Split the one exact composite source-marker line observed in live reads.
 * This is an internal parse only; callers keep the delivered bytes unchanged. */
export function splitTrailingSourceMarkerNarrative(line: string): {
  sourceMarker: string;
  narrativeSuffix: string | null;
} | null {
  const plain = plainPresentationLine(line);
  const match = /^source\s+marker\s*:\s*([A-Za-z0-9][A-Za-z0-9_.:/-]*?)(?:\.\s+(.+)|\.?)$/i.exec(plain);
  if (!match) return null;
  return {
    sourceMarker: match[1]!,
    narrativeSuffix: match[2]?.trim() || null,
  };
}

function scopedSuffixStatus(suffix: string | null): string | null | undefined {
  if (suffix === null) return null;
  if (/^that(?:'|’)s\s+the\s+only\s+current\s+(?:item|record|row|task)[.!]?$/i.test(suffix)) return null;
  if (/^unchanged\s+since\s+(?:the\s+)?(?:last|previous)\s+read[.!]?$/i.test(suffix)) return null;
  const changed = /^state\s+changed\s+since\s+(?:the\s+)?(?:last|previous)\s+read\s*[—–-]\s*the\s+(?:item|record|row|task)\s+is\s+now\s+([A-Za-z0-9_-]+)[.!]?$/i.exec(suffix);
  return changed?.[1] ?? undefined;
}

/** Parse the exact heading → known-item bullet → source-marker block emitted by
 * the live GLM horizon. Any appearance of its heading or composite marker
 * syntax is a claim on this grammar and must validate as exactly one block. */
export function parseScopedProviderSnapshotBlocks(text: string): ScopedProviderSnapshotParse {
  const lines = text.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(text);
  const headingPattern = /^([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,8}\s+(?:queue|feed|list|snapshot))\s+\(((local|connected|authenticated)\s+provider),\s*revision\s+(\d+)\)\s*:\s*$/i;
  const itemPattern = /^([A-Za-z0-9][A-Za-z0-9_.:/-]*)\s*[—–]\s*["“]([^"”\n]{1,240})["”]\s*[—–]\s*status\s*:\s*([A-Za-z0-9_-]+)[.!]?$/i;
  const headingIndexes: number[] = [];
  const compositeSourceIndexes: number[] = [];
  const blocks: ScopedProviderSnapshotBlock[] = [];
  const nextNonblank = (start: number): number => {
    let index = start;
    while (index < lines.length && !lines[index]!.trim()) index += 1;
    return index;
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (!authority[index]) continue;
    const source = splitTrailingSourceMarkerNarrative(lines[index]!);
    if (source && source.narrativeSuffix !== null) compositeSourceIndexes.push(index);
    const heading = headingPattern.exec(plainPresentationLine(lines[index]!));
    if (!heading) continue;
    headingIndexes.push(index);

    const itemLineIndex = nextNonblank(index + 1);
    const item = itemLineIndex < lines.length && authority[itemLineIndex]
      ? itemPattern.exec(plainPresentationLine(lines[itemLineIndex]!))
      : null;
    if (!item) continue;
    const sourceLineIndex = nextNonblank(itemLineIndex + 1);
    const blockSource = sourceLineIndex < lines.length && authority[sourceLineIndex]
      ? splitTrailingSourceMarkerNarrative(lines[sourceLineIndex]!)
      : null;
    if (!blockSource) continue;
    const narrativeSuffixStatus = scopedSuffixStatus(blockSource.narrativeSuffix);
    if (narrativeSuffixStatus === undefined) continue;
    blocks.push({
      headingLineIndex: index,
      itemLineIndex,
      sourceLineIndex,
      scope: heading[1]!.replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase(),
      providerQualifier: heading[2]!.toLowerCase(),
      revision: heading[4]!,
      itemId: item[1]!,
      title: item[2]!,
      status: item[3]!,
      sourceMarker: blockSource.sourceMarker,
      narrativeSuffix: blockSource.narrativeSuffix,
      narrativeSuffixStatus,
    });
  }

  const blockSourceIndexes = new Set(blocks.map((block) => block.sourceLineIndex));
  const uniqueOwnedLines = new Set(blocks.flatMap((block) => [
    block.headingLineIndex,
    block.itemLineIndex,
    block.sourceLineIndex,
  ]));
  const valid = blocks.length === headingIndexes.length
    && uniqueOwnedLines.size === blocks.length * 3
    && compositeSourceIndexes.every((index) => blockSourceIndexes.has(index));
  return {
    claimed: headingIndexes.length > 0 || compositeSourceIndexes.length > 0,
    valid,
    blocks,
  };
}

/** Remove only internally-owned block lines, preserving a validated composite
 * marker's suffix for whole-sentence narrative checking. */
export function projectScopedProviderSnapshotNarrative(
  text: string,
  blocks: readonly ScopedProviderSnapshotBlock[],
): string {
  const replacements = new Map<number, string>();
  for (const block of blocks) {
    replacements.set(block.headingLineIndex, '');
    replacements.set(block.itemLineIndex, '');
    replacements.set(block.sourceLineIndex, block.narrativeSuffix ?? '');
  }
  return text.split(/\r?\n/)
    .map((line, index) => replacements.get(index) ?? line)
    .join('\n');
}

/** V1 exact completion intentionally abstains on quoted/code/raw-HTML blocks.
 * Their Markdown ownership rules are richer than a field parser should try to
 * emulate; the ordinary semantic judge remains the safe path for those rare
 * presentations. */
function presentationLineDisclaimsAuthority(line: string): boolean {
  const plain = plainPresentationLine(line);
  const subject = '(?:answer|response|data|results?|snapshot|table|values?)';
  return /^(?:(?:here(?:'|’)s|here\s+is|this\s+is)\s+(?:an?\s+)?)?(?:historical|fictional|hypothetical|example|earlier|prior|quoted|old)\b[^:\n]{0,60}:$/i.test(plain)
    || /^for\s+example\s*:$/i.test(plain)
    || new RegExp(`\\b(?:the|this|that|these)?\\s*${subject}(?:\\s+(?:above|below))?\\s+(?:is|are)\\s+(?:stale|outdated|wrong|incorrect|inaccurate|fictional|fabricated|hypothetical|unverified)\\b`, 'i').test(plain)
    || new RegExp(`\\b${subject}(?:\\s+(?:above|below))?\\s+(?:should|must|can)\\s+not\\s+be\\s+trusted\\b`, 'i').test(plain)
    || new RegExp(`\\b(?:ignore|disregard|discard|do\\s+not\\s+use|don['’]t\\s+use)\\s+(?:the\\s+)?${subject}(?:\\s+(?:above|below))?\\b`, 'i').test(plain)
    || /\b(?:this|that|it)\s+is\s+(?:only|just|merely)\s+an?\s+(?:example|illustration|hypothetical|fiction)\b/i.test(plain)
    || /\b(?:i|we)\s+(?:cannot|can['’]t)\s+(?:confirm|verify|validate|establish|vouch\s+for)\s+(?:this|that|it|them|these|the\s+(?:answer|response|data|results?|snapshot|table|values?))\b/i.test(plain)
    || /\b(?:this\s+(?:entire\s+)?(?:answer|response|result|snapshot)|these\s+(?:data|results|values)|the\s+(?:data|results|snapshot|values))\s+(?:is|are)\s+(?:fictional|fabricated|hypothetical|unverified)\b/i.test(plain)
    || /\b(?:this\s+(?:entire\s+)?(?:answer|response|result|snapshot)|these\s+(?:data|results|values)|the\s+(?:data|results|snapshot|values))\s+(?:may|might|could)\s+be\s+(?:wrong|incorrect|inaccurate|fabricated|fictional|unverified)\b/i.test(plain)
    || /\bdo\s+not\s+trust\s+(?:this|these|the)\s+(?:answer|response|data|results?|snapshot|table|values)\b/i.test(plain)
    || /\b(?:i|we)\s+(?:cannot|can['’]t)\s+confirm\s+(?:this|these|the)\s+(?:answer|response|data|results?|snapshot|table|values)\b/i.test(plain);
}

export function presentationRequiresSemanticJudge(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const mask = authoritativePresentationLineMask(text);
  return lines.some((line, index) => (
    Boolean(line.trim())
    && (!mask[index]
      || /<(?:\/?[A-Za-z][^>]*>|!|\?)/.test(line)
      || /^\s*["“”'‘’]/u.test(line)
      || presentationLineDisclaimsAuthority(line))
  ));
}
