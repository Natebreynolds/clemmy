import { createHash } from 'node:crypto';
import {
  ErrorCodes,
  parse,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from 'parse5';

export const VERIFIED_RECENT_ARTICLES_PROTOCOL =
  'clementine.verified_recent_articles.v1' as const;

export interface RecentArticleCandidateV1 {
  recordId: string;
  title: string;
  url: string;
  finding: string;
  publisher?: string;
}

export interface VerifiedRecentArticleV1 {
  recordId: string;
  title: string;
  url: string;
  /** Candidate-owned summary normalized onto the existing structured source
   * locator vocabulary. */
  snippet: string;
  publisher: string;
  publishedAt: string;
  dateEvidence: 'json_ld_article' | 'article_published_time' | 'article_time';
}

export interface VerifiedRecentArticlesV1 {
  protocol: typeof VERIFIED_RECENT_ARTICLES_PROTOCOL;
  parserVersion: 1;
  asOf: string;
  maxAgeDays: number;
  records: VerifiedRecentArticleV1[];
  candidateDigest: string;
  evidenceDigest: string;
}

export type VerifyRecentArticleDateEvidenceResult =
  | { status: 'verified'; evidence: VerifiedRecentArticlesV1 }
  | { status: 'insufficient'; reason: string; verifiedCount: number };

export type PrepareRecentArticleBatchCandidatesResult =
  | { status: 'prepared'; candidates: RecentArticleCandidateV1[]; candidateDigest: string }
  | { status: 'refused'; reason: string; canonicalRecordIds?: readonly string[] };

const MAX_CANDIDATES = 8;
const MAX_HTML_BYTES = 2_000_000;
const MAX_JSON_LD_SCRIPTS = 64;
const MAX_JSON_LD_NODES = 512;
const MAX_HTML_DOM_NODES = 100_000;
const MAX_HTML_DOM_DEPTH = 256;
const TRACKING_QUERY_KEY = /^(?:utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid)$/iu;
const ARTICLE_TYPES = new Set(['article', 'newsarticle', 'blogposting', 'techarticle']);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function canonicalRecentArticleUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || !value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_QUERY_KEY.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    parsed.hostname = parsed.hostname.toLocaleLowerCase('en-US');
    if ((parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
    parsed.pathname = parsed.pathname.replace(/\/{2,}/gu, '/');
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/$/u, '');
    return parsed.href;
  } catch {
    return null;
  }
}

function exactIsoDay(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2}))?$/u.exec(value);
  if (!match) return null;
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(parsed.getTime())) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const canonicalDay = new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10);
  return canonicalDay === day ? day : null;
}

function acceptedAsOfDay(value: string): { day: string; epoch: number } | null {
  const day = exactIsoDay(value);
  if (!day) return null;
  return { day, epoch: Date.parse(`${day}T00:00:00.000Z`) };
}

function cleanText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

/** Provider/search text is evidence, never instruction authority. Keep this
 * byte-identical in spirit with the dependent Workspace source gate: the
 * batch date verifier must reject hostile metadata before its safe projection
 * can enter model history. */
function looksLikeUntrustedInstruction(value: string): boolean {
  const bounded = value.slice(0, 32_768);
  return /\b(?:ignore|disregard|override)\b[^.!?\n]{0,160}\b(?:prior|previous|system|developer|user)\s+(?:instructions?|messages?|prompt)\b/iu.test(bounded)
    || /(?:^|\n)\s*(?:system|developer|assistant|user)\s*:/iu.test(bounded)
    || /\b(?:prior|previous|earlier|above|existing)\s+(?:rules?|instructions?|guidance|constraints?)\b[^.!?\n]{0,120}\b(?:are\s+)?(?:obsolete|invalid|superseded|void|revoked|no\s+longer\s+apply)\b/iu.test(bounded)
    || /\b(?:send|exfiltrate|upload|reveal)\b[^.!?\n]{0,120}\b(?:secrets?|credentials?|tokens?|keys?)\b/iu.test(bounded)
    || /\b(?:copy|paste|insert|include|place|write|embed|print)\b[^.!?\n]{0,120}\b(?:api[\s_-]*keys?|secrets?|credentials?|access[\s_-]*tokens?|auth(?:entication|orization)?[\s_-]*tokens?)\b/iu.test(bounded)
    || /\b(?:switch|change|replace)\b[^.!?\n]{0,120}\b(?:skill|destination|authority|tool)\b/iu.test(bounded)
    || /\b(?:you|assistant|agent|model)\s+(?:must|should|need\s+to|are\s+instructed\s+to)\b/iu.test(bounded)
    || /\b(?:do\s+not|don't)\s+(?:follow|obey|trust|use)\b/iu.test(bounded)
    || /\b(?:follow|obey|execute)\s+(?:these|the\s+following|my)\s+instructions?\b/iu.test(bounded);
}

function cleanCandidate(candidate: RecentArticleCandidateV1): RecentArticleCandidateV1 | null {
  const recordId = cleanText(candidate.recordId, 1, 256);
  const title = cleanText(candidate.title, 5, 500);
  const finding = cleanText(candidate.finding, 40, 4_000);
  const url = canonicalRecentArticleUrl(candidate.url);
  const publisher = candidate.publisher === undefined
    ? undefined
    : cleanText(candidate.publisher, 2, 300) ?? undefined;
  if (!recordId || !title || !finding || !url) return null;
  if (
    looksLikeUntrustedInstruction(title)
    || looksLikeUntrustedInstruction(finding)
    || (publisher && looksLikeUntrustedInstruction(publisher))
  ) return null;
  const tokens = finding.split(/\s+/u);
  if (tokens.length < 6 || new Set(tokens.map((token) => token.toLocaleLowerCase('en-US'))).size < 4) {
    return null;
  }
  return { recordId, title, url, finding, ...(publisher ? { publisher } : {}) };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const ACCOUNT_ROUTE_SUFFIX = /\n\n\[account-route\] Using the exact account frozen by the accepted host plan \([^\r\n()]{1,256}\)\.$/u;

function parsedSearchPayload(value: unknown): unknown | null {
  let cursor: unknown = value;
  const textCarrier = record(cursor);
  if (textCarrier?.type === 'text' && typeof textCarrier.text === 'string') cursor = textCarrier.text;
  if (typeof cursor === 'string') {
    const text = cursor.replace(ACCOUNT_ROUTE_SUFFIX, '');
    if (Buffer.byteLength(text, 'utf8') > 1_048_576) return null;
    try { cursor = JSON.parse(text) as unknown; } catch { return null; }
  }
  for (let depth = 0; depth < 3; depth += 1) {
    const envelope = record(cursor);
    if (!envelope || !Object.hasOwn(envelope, 'successful')) break;
    if (envelope.successful !== true || envelope.error) return null;
    cursor = envelope.data;
  }
  return cursor;
}

function searchRows(value: unknown): unknown[] | null {
  const payload = parsedSearchPayload(value);
  if (Array.isArray(payload)) return payload.length <= 512 ? payload : null;
  const row = record(payload);
  if (!row) return null;
  const groups = ['news', 'web'].flatMap((key) => Array.isArray(row[key]) ? row[key] as unknown[] : []);
  return groups.length > 0 && groups.length <= 512 ? groups : null;
}

function candidatesForSelectedUrls(value: unknown, selectedUrls: readonly string[]): RecentArticleCandidateV1[] | null {
  const rows = searchRows(value);
  if (!rows) return null;
  const selected = new Set(selectedUrls);
  const found = new Map<string, RecentArticleCandidateV1>();
  for (const value of rows) {
    const row = record(value);
    if (!row) continue;
    const url = canonicalRecentArticleUrl(row.url);
    if (!url || !selected.has(url)) continue;
    if (found.has(url)) return null;
    const finding = [row.snippet, row.description, row.content, row.markdown]
      .find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
    const candidate = cleanCandidate({
      recordId: url,
      title: typeof row.title === 'string' ? row.title : '',
      url,
      finding: typeof finding === 'string' ? finding : '',
      ...(typeof row.publisher === 'string' && row.publisher.trim()
        ? { publisher: row.publisher }
        : {}),
    });
    if (!candidate) return null;
    found.set(url, candidate);
  }
  return found.size === selected.size
    ? selectedUrls.map((url) => found.get(url)!)
    : null;
}

/** Freeze exact, model-visible Search rows into one rawHtml-only batch start.
 * The selected URLs must exist identically in both the durable result and the
 * accepted model projection. No result prose or HTML is returned. */
export function prepareRecentArticleBatchCandidates(input: {
  rawSearchResult: unknown;
  projectedSearchResult: unknown;
  selectedRecordIds: unknown;
  batchArguments: unknown;
}): PrepareRecentArticleBatchCandidatesResult {
  if (
    !Array.isArray(input.selectedRecordIds)
    || input.selectedRecordIds.length < 3
    || input.selectedRecordIds.length > MAX_CANDIDATES
  ) return { status: 'refused', reason: 'batch scrape requires 3..8 exact selected Search URLs' };
  const selectedUrls = input.selectedRecordIds.map(canonicalRecentArticleUrl);
  if (
    selectedUrls.some((url) => !url)
    || new Set(selectedUrls).size !== selectedUrls.length
  ) return { status: 'refused', reason: 'batch scrape Search URL selection is malformed or ambiguous' };
  const canonicalRecordIds = selectedUrls as string[];
  if (input.selectedRecordIds.some((value, index) => value !== canonicalRecordIds[index])) {
    return {
      status: 'refused',
      reason: 'batch scrape Search URLs must be retried byte-exactly in canonical form',
      canonicalRecordIds,
    };
  }
  const batchArguments = record(input.batchArguments);
  if (!batchArguments) {
    return { status: 'refused', reason: 'batch scrape provider arguments are unavailable' };
  }
  const argumentKeys = Object.keys(batchArguments);
  if (
    argumentKeys.length !== 2
    || !argumentKeys.includes('urls')
    || !argumentKeys.includes('formats')
    || !Array.isArray(batchArguments.urls)
    || !Array.isArray(batchArguments.formats)
    || batchArguments.formats.length !== 1
    || batchArguments.formats[0] !== 'rawHtml'
  ) return { status: 'refused', reason: 'batch scrape must request only rawHtml for the exact selected URLs' };
  const argumentUrls = batchArguments.urls.map(canonicalRecentArticleUrl);
  if (
    batchArguments.urls.some((value, index) => value !== argumentUrls[index])
    || JSON.stringify(argumentUrls) !== JSON.stringify(selectedUrls)
  ) {
    return {
      status: 'refused',
      reason: 'batch scrape URLs differ from the selected canonical Search records',
      canonicalRecordIds,
    };
  }
  const raw = candidatesForSelectedUrls(input.rawSearchResult, selectedUrls as string[]);
  const projected = candidatesForSelectedUrls(input.projectedSearchResult, selectedUrls as string[]);
  if (!raw || !projected || canonicalJson(raw) !== canonicalJson(projected)) {
    return { status: 'refused', reason: 'selected Search candidates are absent, hostile, or differ from model-visible bytes' };
  }
  return { status: 'prepared', candidates: raw, candidateDigest: digest(raw) };
}

function completedBatchRows(value: unknown): unknown[] | null {
  let cursor = record(value);
  if (!cursor) return null;
  if (Object.hasOwn(cursor, 'successful')) {
    if (cursor.successful !== true || cursor.error) return null;
    cursor = record(cursor.data);
    if (!cursor) return null;
  }
  const status = typeof cursor.status === 'string' ? cursor.status.toLocaleLowerCase('en-US') : '';
  if (status !== 'completed') return null;
  return Array.isArray(cursor.data) ? cursor.data : null;
}

function typeNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => typeof entry === 'string'
    ? [entry.split('/').at(-1)!.toLocaleLowerCase('en-US')]
    : []);
}

function identityUrls(value: Record<string, unknown>): string[] {
  const candidates: unknown[] = [value.url];
  const main = value.mainEntityOfPage;
  if (typeof main === 'string') candidates.push(main);
  else {
    const row = record(main);
    if (row) candidates.push(row['@id'], row.url);
  }
  return [...new Set(candidates.flatMap((candidate) => {
    const url = canonicalRecentArticleUrl(candidate);
    return url ? [url] : [];
  }))];
}

function jsonLdArticleDates(
  text: string,
  pageUrl: string,
  budget: { nodes: number },
): string[] {
  const dates: string[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return dates; }
  const queue: unknown[] = [parsed];
  while (queue.length > 0 && budget.nodes < MAX_JSON_LD_NODES) {
    budget.nodes += 1;
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current.slice(0, MAX_JSON_LD_NODES - budget.nodes));
      continue;
    }
    const row = record(current);
    if (!row) continue;
    if (Array.isArray(row['@graph'])) {
      queue.push(...row['@graph'].slice(0, MAX_JSON_LD_NODES - budget.nodes));
    }
    if (!typeNames(row['@type']).some((type) => ARTICLE_TYPES.has(type))) continue;
    if (!identityUrls(row).includes(pageUrl)) continue;
    const day = exactIsoDay(row.datePublished);
    if (day) dates.push(day);
  }
  return dates;
}

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const INERT_OR_RAWTEXT_ELEMENTS = new Set([
  'style', 'template', 'noscript', 'textarea', 'title', 'xmp', 'iframe',
  'noembed', 'noframes', 'plaintext',
]);
const FATAL_HTML_PARSE_ERRORS = new Set<ParserError['code']>([
  ErrorCodes.unexpectedNullCharacter,
  ErrorCodes.eofBeforeTagName,
  ErrorCodes.eofInTag,
  ErrorCodes.eofInScriptHtmlCommentLikeText,
  ErrorCodes.eofInComment,
  ErrorCodes.eofInCdata,
  ErrorCodes.eofInElementThatCanContainOnlyText,
]);

function isHtmlElement(
  node: DefaultTreeAdapterTypes.Node,
): node is DefaultTreeAdapterTypes.Element {
  return 'tagName' in node && node.namespaceURI === HTML_NAMESPACE;
}

function elementAttributes(
  element: DefaultTreeAdapterTypes.Element,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const attribute of element.attrs) {
    const key = attribute.name.toLocaleLowerCase('en-US');
    if (Object.hasOwn(out, key)) return null;
    out[key] = attribute.value;
  }
  return out;
}

function directText(element: DefaultTreeAdapterTypes.Element): string | null {
  const textNodes = element.childNodes.filter((node): node is DefaultTreeAdapterTypes.TextNode => (
    node.nodeName === '#text' && 'value' in node
  ));
  if (textNodes.length !== element.childNodes.length) return null;
  return textNodes.map((node) => node.value).join('');
}

function parsedPageDateGroups(html: string, pageUrl: string): Array<{
    kind: VerifiedRecentArticleV1['dateEvidence'];
    dates: string[];
  }> | null {
  const parseErrors: ParserError[] = [];
  let document: DefaultTreeAdapterTypes.Document;
  try {
    document = parse(html, {
      scriptingEnabled: true,
      onParseError: (error) => parseErrors.push(error),
    });
  } catch {
    return null;
  }
  // Browser HTML is often recoverably imperfect. The HTML5 tree is still the
  // authority, but truncated tag/rawtext/comment states are rejected because
  // their recovery boundary can swallow or expose apparent evidence. Bound
  // the total error surface so pathological documents cannot amplify work.
  if (
    parseErrors.length > 256
    || parseErrors.some((error) => FATAL_HTML_PARSE_ERRORS.has(error.code))
  ) return null;

  const groups: Array<{
    kind: VerifiedRecentArticleV1['dateEvidence'];
    dates: string[];
  }> = [
    { kind: 'json_ld_article', dates: [] },
    { kind: 'article_published_time', dates: [] },
    { kind: 'article_time', dates: [] },
  ];
  const jsonLd = groups[0]!.dates;
  const meta = groups[1]!.dates;
  const time = groups[2]!.dates;
  const jsonLdBudget = { nodes: 0 };
  let scripts = 0;
  let visited = 0;
  const stack: Array<{
    node: DefaultTreeAdapterTypes.Node;
    depth: number;
    inHead: boolean;
    inArticle: boolean;
  }> = document.childNodes.slice().reverse().map((node) => ({
    node,
    depth: 1,
    inHead: false,
    inArticle: false,
  }));
  while (stack.length > 0) {
    const current = stack.pop()!;
    visited += 1;
    if (visited > MAX_HTML_DOM_NODES || current.depth > MAX_HTML_DOM_DEPTH) return null;
    if (!isHtmlElement(current.node)) continue;
    const tag = current.node.tagName.toLocaleLowerCase('en-US');
    const attrs = elementAttributes(current.node);
    if (!attrs) return null;
    const inHead = current.inHead || tag === 'head';
    const inArticle = current.inArticle || tag === 'article';

    if (tag === 'script') {
      if (attrs.type?.trim().toLocaleLowerCase('en-US') === 'application/ld+json') {
        scripts += 1;
        if (scripts > MAX_JSON_LD_SCRIPTS) return null;
        const text = directText(current.node);
        if (text !== null) jsonLd.push(...jsonLdArticleDates(text, pageUrl, jsonLdBudget));
      }
      continue;
    }
    if (INERT_OR_RAWTEXT_ELEMENTS.has(tag)) continue;
    if (tag === 'meta' && inHead) {
      const key = (attrs.property ?? attrs.name ?? '').trim().toLocaleLowerCase('en-US');
      if (key === 'article:published_time') {
        const day = exactIsoDay(attrs.content);
        if (day) meta.push(day);
      }
    } else if (tag === 'time' && inArticle) {
      const itemprops = (attrs.itemprop ?? '').split(/\s+/u).filter(Boolean);
      const publicationMarker = Object.hasOwn(attrs, 'pubdate')
        || itemprops.some((value) => value.toLocaleLowerCase('en-US') === 'datepublished');
      if (publicationMarker) {
        const day = exactIsoDay(attrs.datetime);
        if (day) time.push(day);
      }
    }
    for (let index = current.node.childNodes.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: current.node.childNodes[index]!,
        depth: current.depth + 1,
        inHead,
        inArticle,
      });
    }
  }
  return groups;
}

function exactPageDate(html: string, pageUrl: string): {
  publishedAt: string;
  dateEvidence: VerifiedRecentArticleV1['dateEvidence'];
} | null {
  const groups = parsedPageDateGroups(html, pageUrl);
  if (!groups) return null;
  const all = [...new Set(groups.flatMap((group) => group.dates))];
  if (all.length !== 1) return null;
  const selected = groups.find((group) => group.dates.includes(all[0]!));
  return selected ? { publishedAt: all[0]!, dateEvidence: selected.kind } : null;
}

function batchRow(value: unknown): { url: string; rawHtml: string } | null {
  const row = record(value);
  if (!row) return null;
  const metadata = record(row.metadata);
  const sourceUrl = canonicalRecentArticleUrl(metadata?.sourceURL);
  const rowUrl = row.url === undefined ? sourceUrl : canonicalRecentArticleUrl(row.url);
  const statusCode = metadata?.statusCode;
  const rawHtml = typeof row.rawHtml === 'string' ? row.rawHtml : null;
  if (
    !sourceUrl
    || !rowUrl
    || rowUrl !== sourceUrl
    || !Number.isSafeInteger(statusCode)
    || Number(statusCode) < 200
    || Number(statusCode) > 299
    || rawHtml === null
    || Buffer.byteLength(rawHtml, 'utf8') > MAX_HTML_BYTES
  ) {
    return null;
  }
  return { url: sourceUrl, rawHtml };
}

export function verifyRecentArticleDateEvidence(input: {
  acceptedAt: string;
  maxAgeDays: number;
  minDistinctRecords: number;
  candidates: readonly RecentArticleCandidateV1[];
  completedBatchResult: unknown;
}): VerifyRecentArticleDateEvidenceResult {
  const asOf = acceptedAsOfDay(input.acceptedAt);
  if (
    !asOf
    || !Number.isSafeInteger(input.maxAgeDays)
    || input.maxAgeDays < 1
    || input.maxAgeDays > 30
    || !Number.isSafeInteger(input.minDistinctRecords)
    || input.minDistinctRecords < 1
    || input.minDistinctRecords > MAX_CANDIDATES
    || input.candidates.length < input.minDistinctRecords
    || input.candidates.length > MAX_CANDIDATES
  ) return { status: 'insufficient', reason: 'recent article verifier contract is invalid', verifiedCount: 0 };
  const candidates = input.candidates.map(cleanCandidate);
  if (candidates.some((candidate) => !candidate)) {
    return { status: 'insufficient', reason: 'candidate source record is malformed or insubstantial', verifiedCount: 0 };
  }
  const clean = candidates as RecentArticleCandidateV1[];
  if (
    new Set(clean.map((candidate) => candidate.recordId)).size !== clean.length
    || new Set(clean.map((candidate) => candidate.url)).size !== clean.length
    || new Set(clean.map((candidate) => candidate.title
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/\s+/gu, ' ')
      .trim())).size !== clean.length
  ) return { status: 'insufficient', reason: 'candidate source identities are ambiguous', verifiedCount: 0 };
  const rawRows = completedBatchRows(input.completedBatchResult);
  if (!rawRows || rawRows.length < 1 || rawRows.length > MAX_CANDIDATES * 2) {
    return { status: 'insufficient', reason: 'completed batch result is unavailable or unbounded', verifiedCount: 0 };
  }
  // A completed batch may truthfully contain failed/partial pages alongside
  // usable ones. Such a row proves nothing and is discarded; it never erases
  // another candidate's exact 2xx sourceURL/rawHtml evidence. The frozen
  // minimum still prevents partial success from laundering an insufficient
  // corpus into completion.
  const rows = rawRows.flatMap((value) => {
    const parsed = batchRow(value);
    return parsed ? [parsed] : [];
  });
  if (rows.length === 0) {
    return { status: 'insufficient', reason: 'completed batch has no exact page URL/rawHtml evidence', verifiedCount: 0 };
  }
  const byUrl = new Map<string, Array<{ url: string; rawHtml: string }>>();
  for (const row of rows) {
    byUrl.set(row.url, [...(byUrl.get(row.url) ?? []), row]);
  }
  const verified: VerifiedRecentArticleV1[] = [];
  for (const candidate of clean) {
    const matches = byUrl.get(candidate.url) ?? [];
    if (matches.length !== 1) continue;
    const date = exactPageDate(matches[0]!.rawHtml, candidate.url);
    if (!date) continue;
    const epoch = Date.parse(`${date.publishedAt}T00:00:00.000Z`);
    const ageDays = Math.floor((asOf.epoch - epoch) / 86_400_000);
    if (ageDays < 0 || ageDays > input.maxAgeDays) continue;
    verified.push({
      recordId: candidate.recordId,
      title: candidate.title,
      url: candidate.url,
      snippet: candidate.finding,
      publisher: candidate.publisher ?? new URL(candidate.url).hostname,
      publishedAt: date.publishedAt,
      dateEvidence: date.dateEvidence,
    });
  }
  if (verified.length < input.minDistinctRecords) {
    return {
      status: 'insufficient',
      reason: `only ${verified.length} candidate article(s) have one unambiguous page-owned recent publication date`,
      verifiedCount: verified.length,
    };
  }
  const identity = {
    protocol: VERIFIED_RECENT_ARTICLES_PROTOCOL,
    parserVersion: 1 as const,
    asOf: asOf.day,
    maxAgeDays: input.maxAgeDays,
    records: verified,
    candidateDigest: digest(clean),
  };
  return {
    status: 'verified',
    evidence: {
      ...identity,
      evidenceDigest: digest(identity),
    },
  };
}
