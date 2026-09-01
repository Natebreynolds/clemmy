import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import {
  hostLocalWorkspaceCompoundCommitMatchesArgs,
  validateHostLocalWorkspaceStructuredCreateArgs,
  type HostLocalWorkspaceStructuredCollectionLocator,
} from './host-local-write-commit.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { inspectProviderEnvelope } from './provider-read-evidence.js';
import { computeResultHasSubstance } from './expected-work-matcher.js';

type WorkBindingRow = {
  accepted_task_id: string;
  contract_id: string;
  requirement_id: string;
  logical_tool_call_id: string;
  tool_name: string;
  argument_digest: string;
  effect_kind: string;
  result_handle_id?: string;
};

type SourceProjectionRow = {
  call_id: string;
  settlement_logical_tool_call_id: string;
  result_class: string;
  result_item_bytes: number;
  result_item_sha256: string;
};

type AcceptedBatchRow = {
  accepted_task_id: string;
  work_contract_id: string | null;
  frame_history_json: string;
  pre_history_json: string;
  disposition: string;
};

type SuccessfulResult = {
  ok: true;
  rawPayload: unknown;
  toolName: string;
  executionSite: string;
} | { ok: false; reason: string };

type WorkOperation = {
  id: string;
  effect: string;
  dependsOn: string[];
  dataFrom: string[];
  cardinality: { kind: string };
};

type WorkspaceSocialSourceEvidenceContract = {
  operationId: string;
  recordsPointer: string;
  minDistinctRecords: number;
  titlePointer: string;
  urlPointer: string;
  publishedDatePointer: string;
  findingPointers: [string, string, string, string];
  publisherPointer: string;
  maxAgeDays: number;
  asOf: string;
};

type WorkspaceSocialStructuredContract = {
  count: number;
  requiredFields: string[];
  locator: HostLocalWorkspaceStructuredCollectionLocator;
};

export interface WorkspaceSocialSourceTuple {
  url: string;
  title: string;
  publishedDate: string;
  publisher: string;
}

export type HostLocalWorkspaceDerivationProof =
  | {
      status: 'verified';
      bundleDigest: string;
      sourceLogicalToolCallId: string;
      sourceResultHandleId: string;
      sourceProjectionCallId: string;
      sourceProjectionDigest: string;
      sourceTuples: readonly WorkspaceSocialSourceTuple[];
    }
  | { status: 'unavailable'; reason: string };

function unavailable(reason: string): HostLocalWorkspaceDerivationProof {
  return { status: 'unavailable', reason };
}

function parseItems(raw: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => (
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        ))
      : null;
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite model result');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') return 'null';
  if (typeof value !== 'object') throw new Error('non-JSON model result');
  if (ancestors.has(value)) throw new Error('cyclic model result');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function parsedJsonPayload(value: unknown): unknown | null {
  let current = value;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current === 'string') {
      let source = current.trim();
      if (!source || Buffer.byteLength(source, 'utf8') > MAX_EMBEDDED_PROJECTION_JSON_BYTES) return null;
      const routeMarker = source.indexOf('\n\n[account-route] ');
      if (routeMarker >= 0) {
        const hostRouteSuffix = source.slice(routeMarker + 2);
        if (
          Buffer.byteLength(hostRouteSuffix, 'utf8') > 8_192
          || !hostRouteSuffix.split('\n').every((line) => (
            /^\[account-route\] [^\r\n]{1,2048}$/u.test(line)
          ))
        ) return null;
        // The Composio adapter appends these host-authored route attestations
        // after the exact JSON it gives the model. They are not provider data,
        // so remove only this bounded, typed suffix before parsing. Arbitrary
        // prose/code-fence extraction remains forbidden.
        source = source.slice(0, routeMarker).trimEnd();
      }
      try { current = JSON.parse(source) as unknown; } catch { return null; }
      continue;
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record);
      // Accepted model history stores a tool result in this exact SDK content
      // block. Peel only that host-owned carrier; never scan arbitrary provider
      // prose for a convenient embedded object.
      if (
        record.type === 'text'
        && typeof record.text === 'string'
        && keys.every((key) => key === 'type' || key === 'text')
      ) {
        current = record.text;
        continue;
      }
      // Composio's durable result is a success/error envelope whose provider
      // payload is under `data`. The graph freezes provider-relative pointers
      // such as `/news`, so normalize the carrier rather than teaching plans
      // the gateway's `/data` implementation detail.
      if (
        Object.hasOwn(record, 'data')
        && (
          Object.hasOwn(record, 'successful')
          || Object.hasOwn(record, 'success')
          || Object.hasOwn(record, 'error')
        )
      ) {
        current = record.data ?? null;
        continue;
      }
    }
    return current;
  }
  return current;
}

function jsonPointerValue(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/') || pointer.length > 512 || /~(?![01])/u.test(pointer)) return undefined;
  const tokens = pointer.slice(1).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (tokens.length > 32) return undefined;
  let current = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index];
    } else if (current && typeof current === 'object' && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function exactHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || !value) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.href === value
      ? value
      : null;
  } catch { return null; }
}

function canonicalResearchIdentity(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/iu.test(key) || /^(?:fbclid|gclid|msclkid|mc_cid|mc_eid)$/iu.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    return parsed.href;
  } catch { return null; }
}

function findingLooksLikeUntrustedInstruction(value: string): boolean {
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

function substantiveResearchFinding(value: string): boolean {
  const text = value.trim();
  const tokens = text.split(/\s+/u).filter(Boolean);
  return text === value
    && text.length >= 40
    && tokens.length >= 6
    && new Set(tokens.map((token) => token.toLocaleLowerCase('en-US'))).size >= 4;
}

function normalizedPublishedDay(value: unknown, asOf: string): string | null {
  if (typeof value !== 'string' || value !== value.trim() || !value) return null;
  const anchor = new Date(asOf);
  if (Number.isNaN(anchor.valueOf())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
  }
  const relative = /^(today|yesterday|([1-9]\d{0,2})\s+(hours?|days?|weeks?)\s+ago)$/iu.exec(value);
  if (!relative) return null;
  let offsetMs = 0;
  if (relative[1]!.toLowerCase() === 'yesterday') offsetMs = 86_400_000;
  if (relative[2] && relative[3]) {
    const count = Number(relative[2]);
    const unit = relative[3].toLowerCase();
    offsetMs = count * (unit.startsWith('hour') ? 3_600_000 : unit.startsWith('day') ? 86_400_000 : 604_800_000);
  }
  return new Date(anchor.valueOf() - offsetMs).toISOString().slice(0, 10);
}

function workspaceSocialStructuredContractFor(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  writeRequirementId: string;
}): WorkspaceSocialStructuredContract | null {
  const rows = input.db.prepare(`
    SELECT data_json
      FROM events
     WHERE session_id = ? AND type = 'turn_graph_compiled'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
     ORDER BY seq ASC
  `).all(input.sessionId, input.sourceUserSeq) as Array<{ data_json: string }>;
  if (rows.length !== 1) return null;
  let graph: { identity?: { sessionId?: unknown; sourceUserSeq?: unknown }; nodes?: unknown[] };
  try {
    const data = JSON.parse(rows[0]!.data_json) as { graph?: typeof graph };
    if (!data.graph) return null;
    graph = data.graph;
  } catch { return null; }
  if (
    graph.identity?.sessionId !== input.sessionId
    || graph.identity?.sourceUserSeq !== input.sourceUserSeq
    || !Array.isArray(graph.nodes)
  ) return null;
  const nodes = graph.nodes.filter((node): node is Record<string, unknown> => (
    Boolean(node) && typeof node === 'object' && !Array.isArray(node)
  ));
  const writeNode = nodes.find((node) => node.operationId === input.writeRequirementId);
  const locator = writeNode?.structuredCollectionLocator;
  if (
    !writeNode
    || !Number.isSafeInteger(writeNode.cardinality)
    || (writeNode.cardinality as number) < 1
    || (writeNode.cardinality as number) > 10_000
    || !Array.isArray(writeNode.requiredFields)
    || writeNode.requiredFields.length < 1
    || writeNode.requiredFields.length > 32
    || !writeNode.requiredFields.every((field) => typeof field === 'string')
    || !locator
    || typeof locator !== 'object'
    || Array.isArray(locator)
  ) return null;
  const structured = locator as Record<string, unknown>;
  const sourceEvidence = structured.sourceEvidence;
  if (
    structured.contract !== 'workspace_social_posts_v1'
    || structured.collectionPointer !== '/posts'
    || structured.visibleMirrorPointer !== '/_mobile/records/items'
    || structured.calendarPointer !== '/calendar'
    || JSON.stringify(structured.calendarRequiredFields) !== JSON.stringify(['date', 'channel', 'theme'])
    || !sourceEvidence
    || typeof sourceEvidence !== 'object'
    || Array.isArray(sourceEvidence)
  ) return null;
  const evidence = sourceEvidence as Record<string, unknown>;
  if (
    typeof evidence.operationId !== 'string'
    || typeof evidence.recordsPointer !== 'string'
    || !Number.isSafeInteger(evidence.minDistinctRecords)
    || typeof evidence.titlePointer !== 'string'
    || typeof evidence.urlPointer !== 'string'
    || typeof evidence.publishedDatePointer !== 'string'
    || !Array.isArray(evidence.findingPointers)
    || evidence.findingPointers.length !== 4
    || !evidence.findingPointers.every((pointer) => typeof pointer === 'string')
    || typeof evidence.publisherPointer !== 'string'
    || !Number.isSafeInteger(evidence.maxAgeDays)
    || typeof evidence.asOf !== 'string'
  ) return null;
  const sourceNode = nodes.find((node) => (
    node.operationId === evidence.operationId
    && (node.effect as { kind?: unknown } | undefined)?.kind === 'read'
  ));
  if (!sourceNode) return null;
  return {
    count: writeNode.cardinality as number,
    requiredFields: [...writeNode.requiredFields] as string[],
    locator: {
      contract: 'workspace_social_posts_v1',
      collectionPointer: '/posts',
      visibleMirrorPointer: '/_mobile/records/items',
      calendarPointer: '/calendar',
      calendarRequiredFields: ['date', 'channel', 'theme'],
      sourceEvidence: {
        operationId: evidence.operationId,
        recordsPointer: evidence.recordsPointer,
        minDistinctRecords: evidence.minDistinctRecords as number,
        titlePointer: evidence.titlePointer,
        urlPointer: evidence.urlPointer,
        publishedDatePointer: evidence.publishedDatePointer,
        findingPointers: [...evidence.findingPointers] as [string, string, string, string],
        publisherPointer: evidence.publisherPointer,
        maxAgeDays: evidence.maxAgeDays as number,
        asOf: evidence.asOf,
      },
    },
  };
}

function sourceEvidenceContractFor(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  writeRequirementId: string;
}): WorkspaceSocialSourceEvidenceContract | null {
  return workspaceSocialStructuredContractFor(input)?.locator.sourceEvidence ?? null;
}

function selectedSourceTuples(input: {
  payload: unknown;
  contract: WorkspaceSocialSourceEvidenceContract;
  selectedRecordIds: unknown;
}): { ok: true; tuples: WorkspaceSocialSourceTuple[] } | { ok: false; reason: string } {
  if (
    !Array.isArray(input.selectedRecordIds)
    || input.selectedRecordIds.length < input.contract.minDistinctRecords
    || input.selectedRecordIds.length > 64
    || !input.selectedRecordIds.every((entry) => typeof entry === 'string' && entry.trim() === entry && entry.length > 0)
    || new Set(input.selectedRecordIds).size !== input.selectedRecordIds.length
  ) return { ok: false, reason: 'structured Workspace write must select enough distinct source record identities' };
  const payload = parsedJsonPayload(input.payload);
  const records = Array.isArray(payload)
    ? payload
    : jsonPointerValue(payload, input.contract.recordsPointer);
  if (!Array.isArray(records) || records.length > 512) {
    return { ok: false, reason: 'structured source record locator did not resolve one bounded array' };
  }
  const asOfInstant = new Date(input.contract.asOf);
  if (Number.isNaN(asOfInstant.valueOf())) return { ok: false, reason: 'structured source as-of authority is invalid' };
  const asOf = asOfInstant.toISOString().slice(0, 10);
  const asOfMs = Date.parse(`${asOf}T00:00:00.000Z`);
  const selected = new Set(input.selectedRecordIds as string[]);
  const found = new Map<string, WorkspaceSocialSourceTuple>();
  const foundResearchIdentities = new Set<string>();
  const foundTitles = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const url = exactHttpUrl(jsonPointerValue(record, input.contract.urlPointer));
    if (!url || !selected.has(url)) continue;
    if (found.has(url)) return { ok: false, reason: 'selected structured source identity is ambiguous or duplicated' };
    const title = jsonPointerValue(record, input.contract.titlePointer);
    const finding = input.contract.findingPointers
      .map((pointer) => jsonPointerValue(record, pointer))
      .find((value) => typeof value === 'string' && value.trim().length > 0);
    const publisherValue = jsonPointerValue(record, input.contract.publisherPointer);
    const publisher = typeof publisherValue === 'string' && publisherValue.trim()
      ? publisherValue.trim()
      : new URL(url).hostname;
    const publishedDate = normalizedPublishedDay(
      jsonPointerValue(record, input.contract.publishedDatePointer),
      input.contract.asOf,
    );
    if (
      typeof title !== 'string'
      || title.trim().length < 5
      || title.trim().length > 500
      || title !== title.trim()
      || findingLooksLikeUntrustedInstruction(title)
      || typeof finding !== 'string'
      || !substantiveResearchFinding(finding)
      || findingLooksLikeUntrustedInstruction(finding)
      || !publisher
      || publisher.length > 300
      || findingLooksLikeUntrustedInstruction(publisher)
      || !publishedDate
    ) return { ok: false, reason: 'selected structured source record is malformed or incomplete' };
    const researchIdentity = canonicalResearchIdentity(url);
    const titleIdentity = title.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
    if (
      !researchIdentity
      || foundResearchIdentities.has(researchIdentity)
      || foundTitles.has(titleIdentity)
    ) {
      return { ok: false, reason: 'selected structured source records are not independently distinct' };
    }
    foundResearchIdentities.add(researchIdentity);
    foundTitles.add(titleIdentity);
    const publishedMs = Date.parse(`${publishedDate}T00:00:00.000Z`);
    const ageDays = Math.floor((asOfMs - publishedMs) / 86_400_000);
    if (ageDays < 0 || ageDays > input.contract.maxAgeDays) {
      return { ok: false, reason: 'selected structured source record is outside the frozen recency window' };
    }
    found.set(url, { url, title, publishedDate, publisher });
  }
  if (found.size !== selected.size) {
    return { ok: false, reason: 'one or more selected structured source records are absent from the exact result' };
  }
  return {
    ok: true,
    tuples: (input.selectedRecordIds as string[]).map((url) => found.get(url)!),
  };
}

function workspaceCitationsMatchSelectedSources(input: {
  workspaceArgs: unknown;
  tuples: readonly WorkspaceSocialSourceTuple[];
}): boolean {
  if (!input.workspaceArgs || typeof input.workspaceArgs !== 'object' || Array.isArray(input.workspaceArgs)) return false;
  const initial = (input.workspaceArgs as Record<string, unknown>).initial_data_json;
  const data = parsedJsonPayload(initial);
  const posts = jsonPointerValue(data, '/posts');
  if (!Array.isArray(posts) || posts.length < 1) return false;
  const selected = new Map(input.tuples.map((tuple) => [tuple.url, tuple]));
  const cited = new Set<string>();
  for (const post of posts) {
    if (!post || typeof post !== 'object' || Array.isArray(post)) return false;
    const citations = (post as Record<string, unknown>).citations;
    if (!Array.isArray(citations) || citations.length < 1) return false;
    for (const citation of citations) {
      if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return false;
      const row = citation as Record<string, unknown>;
      const url = exactHttpUrl(row.url);
      const tuple = url ? selected.get(url) : undefined;
      const hostname = url ? new URL(url).hostname : '';
      if (
        !tuple
        || row.title !== tuple.title
        || row.publishedAt !== tuple.publishedDate
        || (row.publisher !== tuple.publisher && row.publisher !== hostname)
      ) return false;
      cited.add(tuple.url);
    }
  }
  return cited.size >= Math.min(input.tuples.length, 3)
    && input.tuples.every((tuple) => cited.has(tuple.url));
}

export function proveWorkspaceSocialSourceEvidence(input: {
  rawPayload: unknown;
  projectedPayload: unknown;
  workspaceArgs: unknown;
  selectedRecordIds: unknown;
  contract: WorkspaceSocialSourceEvidenceContract;
}): { ok: true; tuples: WorkspaceSocialSourceTuple[] } | { ok: false; reason: string } {
  const durable = selectedSourceTuples({
    payload: input.rawPayload,
    contract: input.contract,
    selectedRecordIds: input.selectedRecordIds,
  });
  if (!durable.ok) return durable;
  const visible = selectedSourceTuples({
    payload: input.projectedPayload,
    contract: input.contract,
    selectedRecordIds: input.selectedRecordIds,
  });
  if (!visible.ok || JSON.stringify(visible.tuples) !== JSON.stringify(durable.tuples)) {
    return { ok: false, reason: visible.ok
      ? 'model-visible structured source tuples differ from the durable result'
      : visible.reason };
  }
  if (!workspaceCitationsMatchSelectedSources({ workspaceArgs: input.workspaceArgs, tuples: durable.tuples })) {
    return { ok: false, reason: 'Workspace citations do not exactly redeem the selected source tuples' };
  }
  return durable;
}

const MAX_EMBEDDED_PROJECTION_JSON_BYTES = 1_048_576;
const INCOMPLETE_PROJECTION_STATES = new Set([
  'truncated_tool_output',
  'refused_pre_dispatch',
  'not_started',
  'effect_unknown',
  'user_rejected',
]);
const PROJECTION_ACK_OR_PAGINATION_KEYS = new Set([
  'success', 'successful', 'ok', 'status', 'statuscode', 'httpstatus',
  'message', 'messages', 'warning', 'warnings', 'error', 'errors',
  'log', 'logs', 'debug', 'meta', 'metadata',
  'pagination', 'paging', 'pager', 'pageinfo', 'links',
  'count', 'itemcount', 'recordcount', 'resultcount', 'size',
  'total', 'totalcount', 'totalrecords', 'totalitems', 'totalsize', 'odatacount',
  'returned', 'returnedcount', 'itemsreturned', 'recordsreturned',
  'pagesize', 'perpage', 'offset', 'start', 'startindex', 'skip',
  'page', 'pagenumber', 'currentpage', 'pagecount', 'totalpages', 'numpages',
  'hasmore', 'hasnext', 'hasnextpage', 'moreavailable', 'morepages',
  'complete', 'iscomplete', 'completed', 'exhausted', 'islastpage', 'done',
  'cursor', 'nextcursor', 'nextpagetoken', 'pagetoken', 'nexttoken',
  'continuation', 'continuationtoken', 'nextlink', 'odatanextlink',
  'nextrecordsurl', 'endcursor',
]);

function embeddedProjectionJson(value: string):
  | { kind: 'plain' }
  | { kind: 'oversized_json' }
  | { kind: 'parsed'; value: unknown } {
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return { kind: 'plain' };
  if (Buffer.byteLength(text, 'utf8') > MAX_EMBEDDED_PROJECTION_JSON_BYTES) {
    return { kind: 'oversized_json' };
  }
  try {
    return { kind: 'parsed', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'plain' };
  }
}

function containsIncompleteProjection(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === 'string') {
    const embedded = embeddedProjectionJson(value);
    if (embedded.kind === 'oversized_json') return true;
    return embedded.kind === 'parsed'
      ? containsIncompleteProjection(embedded.value, depth + 1)
      : false;
  }
  if (Array.isArray(value)) return value.some((entry) => containsIncompleteProjection(entry, depth + 1));
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (
    row.truncated_at_write === true
    || (typeof row.error_kind === 'string' && INCOMPLETE_PROJECTION_STATES.has(row.error_kind))
    || (typeof row.disposition === 'string' && INCOMPLETE_PROJECTION_STATES.has(row.disposition))
    || (typeof row.execution_kind === 'string' && INCOMPLETE_PROJECTION_STATES.has(row.execution_kind))
    || (typeof row.dispatch_state === 'string' && INCOMPLETE_PROJECTION_STATES.has(row.dispatch_state))
    || (typeof row.status === 'string' && INCOMPLETE_PROJECTION_STATES.has(row.status))
  ) return true;
  return Object.values(row).some((entry) => containsIncompleteProjection(entry, depth + 1));
}

function normalizedProjectionPayload(value: unknown): unknown | null {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  const embedded = embeddedProjectionJson(text);
  if (embedded.kind === 'oversized_json') return null;
  if (embedded.kind === 'parsed') return embedded.value;
  // Acknowledgement prose is not answer-bearing source material. Keep this
  // deliberately narrow so ordinary article/search text remains usable.
  if (/^(?:"?)(?:ok|okay|success|successful|done|completed|true)(?:"?)[.!]?$/i.test(text)) {
    return null;
  }
  return text;
}

function acknowledgementOrPaginationOnly(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 0 || entries.every(([key]) => (
    PROJECTION_ACK_OR_PAGINATION_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
  ));
}

/** Exact predicate shared by the durable derivation proof and focused carrier
 * tests. Model-result items may carry structured tool output as JSON text, so
 * merely checking a non-empty string is not substantive evidence. */
export function hostLocalWorkspaceSourceProjectionIsSubstantive(value: unknown): boolean {
  if (containsIncompleteProjection(value)) return false;
  const normalized = normalizedProjectionPayload(value);
  return normalized !== null
    && !acknowledgementOrPaginationOnly(normalized)
    && computeResultHasSubstance(normalized);
}

function parsedOperations(contractJson: string): WorkOperation[] | null {
  try {
    const contract = JSON.parse(contractJson) as { operations?: unknown };
    if (!Array.isArray(contract.operations)) return null;
    const operations: WorkOperation[] = [];
    for (const raw of contract.operations) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      if (
        typeof row.id !== 'string'
        || typeof row.effect !== 'string'
        || !Array.isArray(row.dependsOn)
        || !row.dependsOn.every((entry) => typeof entry === 'string')
        || !Array.isArray(row.dataFrom)
        || !row.dataFrom.every((entry) => typeof entry === 'string')
        || !row.cardinality
        || typeof row.cardinality !== 'object'
        || Array.isArray(row.cardinality)
        || typeof (row.cardinality as Record<string, unknown>).kind !== 'string'
      ) return null;
      operations.push({
        id: row.id,
        effect: row.effect,
        dependsOn: row.dependsOn as string[],
        dataFrom: row.dataFrom as string[],
        cardinality: { kind: (row.cardinality as Record<string, unknown>).kind as string },
      });
    }
    return operations;
  } catch {
    return null;
  }
}

type WorkspaceSourceSelection =
  | { status: 'selected'; source: WorkBindingRow; projection: SourceProjectionRow }
  | { status: 'unavailable'; reason: string };

/**
 * Select the exact model-visible result named by the accepted dependent write.
 *
 * The selected id is not new authority: it must redeem an immutable projection
 * receipt for one already-succeeded binding of the write's exact `dataFrom`
 * requirement. Omission remains compatible only when both the successful
 * settlement and its model projection are independently unique. This lets a
 * model refine a search without making the later write permanently ambiguous,
 * while an extra/wrong/unsettled id can never borrow a different result.
 */
export function selectHostLocalWorkspaceSourceProjection(input: {
  sourceRows: readonly WorkBindingRow[];
  projections: readonly SourceProjectionRow[];
  declaredSourceCallIds: unknown;
}): WorkspaceSourceSelection {
  if (input.sourceRows.length === 0) {
    return { status: 'unavailable', reason: 'compound Workspace source settlement is missing' };
  }
  const sourceByLogicalId = new Map<string, WorkBindingRow>();
  for (const row of input.sourceRows) {
    if (
      !row.logical_tool_call_id
      || !row.result_handle_id
      || sourceByLogicalId.has(row.logical_tool_call_id)
    ) {
      return { status: 'unavailable', reason: 'compound Workspace source settlement is ambiguous' };
    }
    sourceByLogicalId.set(row.logical_tool_call_id, row);
  }

  let selectedProjection: SourceProjectionRow | undefined;
  if (input.declaredSourceCallIds === null || input.declaredSourceCallIds === undefined) {
    if (input.sourceRows.length !== 1 || input.projections.length !== 1) {
      return {
        status: 'unavailable',
        reason: 'compound Workspace write must name its exact model-visible source result',
      };
    }
    selectedProjection = input.projections[0];
  } else {
    if (
      !Array.isArray(input.declaredSourceCallIds)
      || input.declaredSourceCallIds.length !== 1
      || typeof input.declaredSourceCallIds[0] !== 'string'
      || !input.declaredSourceCallIds[0].trim()
    ) {
      return {
        status: 'unavailable',
        reason: 'compound Workspace write must name exactly one source result call id',
      };
    }
    const declared = input.declaredSourceCallIds[0];
    const matches = input.projections.filter((candidate) => candidate.call_id === declared);
    if (matches.length !== 1) {
      return {
        status: 'unavailable',
        reason: 'compound Workspace named source has no exact settled projection receipt',
      };
    }
    selectedProjection = matches[0];
  }

  const source = sourceByLogicalId.get(selectedProjection.settlement_logical_tool_call_id);
  if (!source) {
    return {
      status: 'unavailable',
      reason: 'compound Workspace named source does not belong to its exact dataFrom requirement',
    };
  }
  if (selectedProjection.result_class !== 'text' && selectedProjection.result_class !== 'structured') {
    return {
      status: 'unavailable',
      reason: 'compound Workspace named source is not a substantive model projection',
    };
  }
  return { status: 'selected', source, projection: selectedProjection };
}

export type HostLocalWorkspaceSourceAdmission =
  | {
      status: 'verified';
      sourceLogicalToolCallId: string;
      sourceResultHandleId: string;
      sourceProjectionCallId: string;
      sourceProjectionDigest: string;
      sourceTuples: readonly WorkspaceSocialSourceTuple[];
    }
  | { status: 'unavailable'; reason: string };

/**
 * Pre-dispatch source gate for the intrinsic dependent Workspace write. This
 * validates the accepted carrier's nominated model-result id against the
 * frozen `dataFrom` requirement and its successful settlement/projection
 * receipts before `space_save` is allowed to cross its local mutation edge.
 */
export function validateHostLocalWorkspaceSourceBeforeDispatch(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  writeLogicalToolCallId: string;
  writeRequirementId: string;
  declaredSourceCallIds: unknown;
  declaredSourceRecordIds: unknown;
  writeArgs: unknown;
  resolveSuccessfulResult: (logicalToolCallId: string) => SuccessfulResult;
}): HostLocalWorkspaceSourceAdmission {
  try {
    const contracts = input.db.prepare(`
      SELECT accepted_task_id, contract_id, contract_json
        FROM accepted_task_work_contracts
       WHERE session_id = ? AND source_user_seq = ?
    `).all(input.sessionId, input.sourceUserSeq) as Array<{
      accepted_task_id: string;
      contract_id: string;
      contract_json: string;
    }>;
    if (contracts.length !== 1 || contracts[0]!.accepted_task_id !== input.acceptedTaskId) {
      return { status: 'unavailable', reason: 'dependent Workspace source contract is missing or ambiguous' };
    }
    const contract = contracts[0]!;
    const operations = parsedOperations(contract.contract_json);
    const write = operations?.find((operation) => operation.id === input.writeRequirementId);
    if (
      !write
      || write.effect !== 'local_write'
      || write.cardinality.kind !== 'once'
      || write.dataFrom.length !== 1
      || !write.dependsOn.includes(write.dataFrom[0]!)
    ) {
      return { status: 'unavailable', reason: 'dependent Workspace write has no exact frozen dataFrom source' };
    }
    const sourceOperation = operations!.find((operation) => operation.id === write.dataFrom[0]);
    if (
      !sourceOperation
      || sourceOperation.effect !== 'read'
      || sourceOperation.cardinality.kind !== 'once'
      || sourceOperation.dataFrom.length !== 0
    ) {
      return { status: 'unavailable', reason: 'dependent Workspace source is not one exact root read' };
    }
    const structuredContract = workspaceSocialStructuredContractFor({
      db: input.db,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      writeRequirementId: input.writeRequirementId,
    });
    if (!structuredContract || structuredContract.locator.sourceEvidence.operationId !== sourceOperation.id) {
      return { status: 'unavailable', reason: 'dependent Workspace typed source-evidence contract is missing or contradictory' };
    }
    const sourceEvidence = structuredContract.locator.sourceEvidence;
    const accepted = input.db.prepare(`
      SELECT created_at FROM events
       WHERE session_id = ? AND seq = ? AND type = 'user_input_received'
    `).get(input.sessionId, input.sourceUserSeq) as { created_at: string } | undefined;
    if (!accepted || accepted.created_at !== sourceEvidence.asOf) {
      return { status: 'unavailable', reason: 'dependent Workspace source recency date is not host-owned' };
    }
    const sourceRows = input.db.prepare(`
      SELECT b.accepted_task_id, b.contract_id, b.requirement_id,
             b.logical_tool_call_id, b.tool_name, b.argument_digest, b.effect_kind,
             s.result_handle_id
        FROM expected_work_call_bindings b
        JOIN logical_call_settlements s
          ON s.session_id = b.session_id
         AND s.source_user_seq = b.source_user_seq
         AND s.logical_tool_call_id = b.logical_tool_call_id
       WHERE b.session_id = ? AND b.source_user_seq = ?
         AND b.contract_id = ? AND b.requirement_id = ?
         AND b.effect_kind = 'read'
         AND s.outcome_kind = 'succeeded'
         AND s.continues_requirement = 0
         AND s.requires_reconciliation = 0
         AND s.result_handle_id IS NOT NULL
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      contract.contract_id,
      sourceOperation.id,
    ) as WorkBindingRow[];
    const projections = input.db.prepare(`
      SELECT call_id, settlement_logical_tool_call_id, result_class,
             result_item_bytes, result_item_sha256
        FROM logical_model_result_projection_receipts
       WHERE session_id = ? AND source_user_seq = ?
    `).all(input.sessionId, input.sourceUserSeq) as SourceProjectionRow[];
    const candidateLogicalIds = new Set(sourceRows.map((row) => row.logical_tool_call_id));
    const selection = selectHostLocalWorkspaceSourceProjection({
      sourceRows,
      projections: projections.filter((projection) => (
        candidateLogicalIds.has(projection.settlement_logical_tool_call_id)
      )),
      declaredSourceCallIds: input.declaredSourceCallIds,
    });
    if (selection.status !== 'selected') return selection;
    if (selection.source.accepted_task_id !== input.acceptedTaskId) {
      return { status: 'unavailable', reason: 'dependent Workspace source belongs to another accepted task' };
    }
    const result = input.resolveSuccessfulResult(selection.source.logical_tool_call_id);
    if (
      !result.ok
      || inspectProviderEnvelope(result.rawPayload).verdict !== 'clean'
      || !hostLocalWorkspaceSourceProjectionIsSubstantive(result.rawPayload)
    ) {
      return { status: 'unavailable', reason: 'dependent Workspace source result is not clean substantive evidence' };
    }
    const batches = input.db.prepare(`
      SELECT accepted_task_id, work_contract_id, frame_history_json, pre_history_json
        FROM accepted_model_batch_admissions
       WHERE session_id = ? AND source_user_seq = ?
         AND EXISTS (
           SELECT 1 FROM json_each(call_ids_json)
            WHERE json_each.value = ?
         )
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      input.writeLogicalToolCallId,
    ) as Array<Omit<AcceptedBatchRow, 'disposition'>>;
    if (batches.length !== 1) {
      return { status: 'unavailable', reason: 'dependent Workspace accepted authoring batch is missing or ambiguous' };
    }
    const batch = batches[0]!;
    if (
      batch.accepted_task_id !== input.acceptedTaskId
      || batch.work_contract_id !== contract.contract_id
    ) {
      return { status: 'unavailable', reason: 'dependent Workspace authoring batch contradicts frozen authority' };
    }
    const frame = parseItems(batch.frame_history_json);
    const preHistory = parseItems(batch.pre_history_json);
    if (!frame || !preHistory) {
      return { status: 'unavailable', reason: 'dependent Workspace accepted model history is unreadable' };
    }
    const calls = frame.filter((item) => (
      item.type === 'function_call'
      && item.callId === input.writeLogicalToolCallId
      && item.name === 'work_call'
    ));
    if (calls.length !== 1 || typeof calls[0]!.arguments !== 'string') {
      return { status: 'unavailable', reason: 'dependent Workspace authoring call is not exact' };
    }
    try {
      const carrier = JSON.parse(calls[0]!.arguments as string) as Record<string, unknown>;
      if (
        carrier.requirement_id !== input.writeRequirementId
        || JSON.stringify(carrier.source_call_ids ?? null)
          !== JSON.stringify(input.declaredSourceCallIds ?? null)
        || JSON.stringify(carrier.source_record_ids ?? null)
          !== JSON.stringify(input.declaredSourceRecordIds ?? null)
      ) {
        return { status: 'unavailable', reason: 'dependent Workspace source nomination changed after batch admission' };
      }
    } catch {
      return { status: 'unavailable', reason: 'dependent Workspace accepted carrier is unreadable' };
    }
    const sourceItems = preHistory.filter((item) => (
      item.type === 'function_call_result'
      && item.callId === selection.projection.call_id
    ));
    if (sourceItems.length !== 1) {
      return {
        status: 'unavailable',
        reason: 'dependent Workspace accepted authoring batch did not contain the nominated source result',
      };
    }
    const sourceItem = sourceItems[0]!;
    const sourceItemJson = canonicalJson(sourceItem);
    if (
      Buffer.byteLength(sourceItemJson, 'utf8') !== selection.projection.result_item_bytes
      || createHash('sha256').update(sourceItemJson, 'utf8').digest('hex')
        !== selection.projection.result_item_sha256
      || !hostLocalWorkspaceSourceProjectionIsSubstantive(sourceItem.output)
    ) {
      return {
        status: 'unavailable',
        reason: 'dependent Workspace nominated source is absent or changed in accepted model history',
      };
    }
    const sourceProof = proveWorkspaceSocialSourceEvidence({
      rawPayload: result.rawPayload,
      projectedPayload: sourceItem.output,
      workspaceArgs: input.writeArgs,
      selectedRecordIds: input.declaredSourceRecordIds,
      contract: sourceEvidence,
    });
    if (!sourceProof.ok) {
      return { status: 'unavailable', reason: sourceProof.reason };
    }
    const structuredCreate = validateHostLocalWorkspaceStructuredCreateArgs({
      args: input.writeArgs,
      count: structuredContract.count,
      requiredFields: structuredContract.requiredFields,
      locator: structuredContract.locator,
    });
    if (!structuredCreate.ok) {
      return { status: 'unavailable', reason: structuredCreate.reason };
    }
    return {
      status: 'verified',
      sourceLogicalToolCallId: selection.source.logical_tool_call_id,
      sourceResultHandleId: selection.source.result_handle_id!,
      sourceProjectionCallId: selection.projection.call_id,
      sourceProjectionDigest: selection.projection.result_item_sha256,
      sourceTuples: sourceProof.tuples,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240),
    };
  }
}

/**
 * Cycle-free proof for the one model-synthesis lane supported by the intrinsic
 * Workspace bundle. Issuance and terminal publication call this same proof
 * with their own exact successful-result resolver.
 */
export function proveHostLocalWorkspaceDerivation(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  writeLogicalToolCallId: string;
  resolveSuccessfulResult: (logicalToolCallId: string) => SuccessfulResult;
}): HostLocalWorkspaceDerivationProof {
  try {
    const contractRows = input.db.prepare(`
      SELECT accepted_task_id, contract_id, contract_json
        FROM accepted_task_work_contracts
       WHERE session_id = ? AND source_user_seq = ?
    `).all(input.sessionId, input.sourceUserSeq) as Array<{
      accepted_task_id: string;
      contract_id: string;
      contract_json: string;
    }>;
    if (contractRows.length !== 1 || contractRows[0]!.accepted_task_id !== input.acceptedTaskId) {
      return unavailable('compound Workspace derivation has no exact frozen work contract');
    }
    const contract = contractRows[0]!;
    const operations = parsedOperations(contract.contract_json);
    if (!operations) return unavailable('compound Workspace work contract is unreadable');
    const writeRows = input.db.prepare(`
      SELECT accepted_task_id, contract_id, requirement_id,
             logical_tool_call_id, tool_name, argument_digest, effect_kind
        FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).all(input.sessionId, input.sourceUserSeq, input.writeLogicalToolCallId) as WorkBindingRow[];
    if (writeRows.length !== 1) return unavailable('compound Workspace write binding is missing or ambiguous');
    const write = writeRows[0]!;
    if (
      write.accepted_task_id !== input.acceptedTaskId
      || write.contract_id !== contract.contract_id
      || write.tool_name !== 'space_save'
      || write.effect_kind !== 'local_write'
    ) return unavailable('compound Workspace write binding contradicts frozen authority');
    const operation = operations.find((candidate) => candidate.id === write.requirement_id);
    if (
      !operation
      || operation.effect !== 'local_write'
      || operation.cardinality.kind !== 'once'
      || operation.dataFrom.length !== 1
      || !operation.dependsOn.includes(operation.dataFrom[0]!)
    ) return unavailable('compound Workspace write requires one exact dependency-bound source');
    const sourceOperation = operations.find((candidate) => candidate.id === operation.dataFrom[0]);
    if (
      !sourceOperation
      || sourceOperation.effect !== 'read'
      || sourceOperation.cardinality.kind !== 'once'
      || sourceOperation.dataFrom.length !== 0
    ) return unavailable('compound Workspace derivation source is not one exact root read');

    const sourceRows = input.db.prepare(`
      SELECT b.accepted_task_id, b.contract_id, b.requirement_id,
             b.logical_tool_call_id, b.tool_name, b.argument_digest, b.effect_kind,
             s.result_handle_id
        FROM expected_work_call_bindings b
        JOIN logical_call_settlements s
          ON s.session_id = b.session_id
         AND s.source_user_seq = b.source_user_seq
         AND s.logical_tool_call_id = b.logical_tool_call_id
       WHERE b.session_id = ? AND b.source_user_seq = ?
         AND b.contract_id = ? AND b.requirement_id = ?
         AND b.effect_kind = 'read'
         AND s.outcome_kind = 'succeeded'
         AND s.continues_requirement = 0
         AND s.requires_reconciliation = 0
         AND s.result_handle_id IS NOT NULL
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      contract.contract_id,
      sourceOperation.id,
    ) as WorkBindingRow[];

    const batches = input.db.prepare(`
      SELECT admission.accepted_task_id, admission.work_contract_id,
             admission.frame_history_json, admission.pre_history_json,
             checkpoint.disposition
        FROM accepted_model_batch_admissions admission
        JOIN accepted_model_batch_checkpoints checkpoint
          ON checkpoint.session_id = admission.session_id
         AND checkpoint.source_user_seq = admission.source_user_seq
         AND checkpoint.batch_ordinal = admission.batch_ordinal
         AND checkpoint.batch_id = admission.batch_id
       WHERE admission.session_id = ? AND admission.source_user_seq = ?
         AND EXISTS (
           SELECT 1 FROM json_each(admission.call_ids_json)
            WHERE json_each.value = ?
         )
    `).all(input.sessionId, input.sourceUserSeq, input.writeLogicalToolCallId) as AcceptedBatchRow[];
    if (batches.length !== 1) return unavailable('compound Workspace authoring batch is missing or ambiguous');
    const batch = batches[0]!;
    if (
      batch.accepted_task_id !== input.acceptedTaskId
      || batch.work_contract_id !== contract.contract_id
      || batch.disposition !== 'ready'
    ) return unavailable('compound Workspace authoring batch is not durably ready');
    const frame = parseItems(batch.frame_history_json);
    const preHistory = parseItems(batch.pre_history_json);
    if (!frame || !preHistory) return unavailable('compound Workspace model history is unreadable');
    const calls = frame.filter((item) => item.type === 'function_call' && item.callId === input.writeLogicalToolCallId);
    if (calls.length !== 1) return unavailable('compound Workspace authoring call is not exact');
    const call = calls[0]!;
    if (call.name !== 'work_call' || typeof call.arguments !== 'string') {
      return unavailable('compound Workspace authoring call is not the accepted carrier');
    }
    let carrier: Record<string, unknown>;
    let workspaceArgs: Record<string, unknown>;
    try {
      carrier = JSON.parse(call.arguments) as Record<string, unknown>;
      workspaceArgs = JSON.parse(String(carrier.args_json ?? '')) as Record<string, unknown>;
    } catch {
      return unavailable('compound Workspace authoring arguments are unreadable');
    }
    if (
      carrier.requirement_id !== operation.id
      || carrier.name !== 'space_save'
      || !workspaceArgs
      || typeof workspaceArgs !== 'object'
      || Array.isArray(workspaceArgs)
    ) return unavailable('compound Workspace carrier contradicts the exact requirement');
    const logical = durableLogicalCallContract(input.acceptedTaskId, 'space_save', workspaceArgs);
    if (!logical || logical.argumentDigest !== write.argument_digest) {
      return unavailable('compound Workspace accepted arguments do not match the write binding');
    }

    const projections = input.db.prepare(`
      SELECT call_id, settlement_logical_tool_call_id, result_class,
             result_item_bytes, result_item_sha256
        FROM logical_model_result_projection_receipts
       WHERE session_id = ? AND source_user_seq = ?
         AND settlement_logical_tool_call_id IN (
           SELECT b.logical_tool_call_id
             FROM expected_work_call_bindings b
             JOIN logical_call_settlements s
               ON s.session_id = b.session_id
              AND s.source_user_seq = b.source_user_seq
              AND s.logical_tool_call_id = b.logical_tool_call_id
            WHERE b.session_id = ? AND b.source_user_seq = ?
              AND b.contract_id = ? AND b.requirement_id = ?
              AND b.effect_kind = 'read'
              AND s.outcome_kind = 'succeeded'
              AND s.continues_requirement = 0
              AND s.requires_reconciliation = 0
              AND s.result_handle_id IS NOT NULL
         )
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      input.sessionId,
      input.sourceUserSeq,
      contract.contract_id,
      sourceOperation.id,
    ) as SourceProjectionRow[];
    const selection = selectHostLocalWorkspaceSourceProjection({
      sourceRows,
      projections,
      declaredSourceCallIds: carrier.source_call_ids,
    });
    if (selection.status !== 'selected') return unavailable(selection.reason);
    const { source, projection } = selection;
    if (source.accepted_task_id !== input.acceptedTaskId) {
      return unavailable('compound Workspace source belongs to a different accepted task');
    }
    const sourceResult = input.resolveSuccessfulResult(source.logical_tool_call_id);
    if (
      !sourceResult.ok
      || inspectProviderEnvelope(sourceResult.rawPayload).verdict !== 'clean'
      || !hostLocalWorkspaceSourceProjectionIsSubstantive(sourceResult.rawPayload)
    ) return unavailable('compound Workspace source result is not clean substantive evidence');

    const sourceItems = preHistory.filter((item) => (
      item.type === 'function_call_result' && item.callId === projection.call_id
    ));
    if (sourceItems.length !== 1) {
      return unavailable('compound Workspace authoring batch did not contain the exact source result');
    }
    const sourceItem = sourceItems[0]!;
    const sourceItemJson = canonicalJson(sourceItem);
    if (
      Buffer.byteLength(sourceItemJson, 'utf8') !== projection.result_item_bytes
      || createHash('sha256').update(sourceItemJson, 'utf8').digest('hex') !== projection.result_item_sha256
      || !hostLocalWorkspaceSourceProjectionIsSubstantive(sourceItem.output)
    ) return unavailable('compound Workspace model-visible source result is incomplete or non-substantive');

    const sourceEvidence = sourceEvidenceContractFor({
      db: input.db,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      writeRequirementId: operation.id,
    });
    if (!sourceEvidence || sourceEvidence.operationId !== sourceOperation.id) {
      return unavailable('compound Workspace typed source-evidence contract is missing or contradictory');
    }
    const accepted = input.db.prepare(`
      SELECT created_at FROM events
       WHERE session_id = ? AND seq = ? AND type = 'user_input_received'
    `).get(input.sessionId, input.sourceUserSeq) as { created_at: string } | undefined;
    if (!accepted || accepted.created_at !== sourceEvidence.asOf) {
      return unavailable('compound Workspace source recency date is not host-owned');
    }
    const sourceProof = proveWorkspaceSocialSourceEvidence({
      rawPayload: sourceResult.rawPayload,
      projectedPayload: sourceItem.output,
      workspaceArgs,
      selectedRecordIds: carrier.source_record_ids,
      contract: sourceEvidence,
    });
    if (!sourceProof.ok) return unavailable(sourceProof.reason);

    const writeResult = input.resolveSuccessfulResult(input.writeLogicalToolCallId);
    if (!writeResult.ok || writeResult.toolName !== 'space_save' || writeResult.executionSite !== 'host') {
      return unavailable('compound Workspace committed result is unavailable');
    }
    const compound = hostLocalWorkspaceCompoundCommitMatchesArgs({
      result: writeResult.rawPayload,
      args: workspaceArgs,
    });
    if (!compound || compound.createdId !== workspaceArgs.slug) {
      return unavailable('compound Workspace committed bytes do not match accepted arguments');
    }
    return {
      status: 'verified',
      bundleDigest: compound.contentDigest,
      sourceLogicalToolCallId: source.logical_tool_call_id,
      sourceResultHandleId: source.result_handle_id!,
      sourceProjectionCallId: projection.call_id,
      sourceProjectionDigest: projection.result_item_sha256,
      sourceTuples: sourceProof.tuples,
    };
  } catch (error) {
    return unavailable(String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240));
  }
}
