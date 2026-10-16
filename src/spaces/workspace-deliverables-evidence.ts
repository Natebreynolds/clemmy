/** Read-only, revision-bound facts for the existing Workspace completion check.
 * A declaration is configuration, persisted content is content, and only a
 * matching current successful observation is data readback. None is execution,
 * visual, account or deployment-relationship authority. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';
import { BASE_DIR } from '../config.js';
import { isSecretLikeKey, redactSensitiveText } from '../runtime/security.js';
import type { SpaceRecord } from './store.js';
import type { WorkspaceEvidenceKind } from './workspace-deliverables-contract.js';
import { countWorkspaceRecords, locateWorkspaceRecords } from './workspace-data-digest.js';
import { workspaceDataContentDigest } from './workspace-set-data-contract.js';
import { withWorkspaceSnapshotRead, workspaceSnapshotRevision } from './workspace-snapshot.js';
import { workspaceManifestAuthoringFields } from './workspace-manifest-authoring.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface WorkspaceDeliverablesFact {
  id: string;
  supports: WorkspaceEvidenceKind[];
  detail: Json;
}
export interface WorkspaceDeliverablesFeed {
  workflow: string;
  collections: readonly string[];
  enabled: boolean;
}
interface EvidencePacket {
  version: 1;
  fingerprint: string;
  facts: WorkspaceDeliverablesFact[];
  truncation: { text: boolean; links: boolean; datasets: boolean; configuration: boolean; fields: boolean };
  unavailableEvidence: WorkspaceEvidenceKind[];
  limitations: string[];
}
export type WorkspaceDeliverablesEvidence = EvidencePacket & ({
  status: 'available';
  snapshot: {
    workspaceId: string;
    version: number;
    revision: string;
    manifestSha256: string;
    viewSha256: string;
    dataSha256: string | null;
    dataState: 'present' | 'absent' | 'unreadable';
  };
} | { status: 'unavailable'; reason: string; snapshot: null });

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_VIEW_BYTES = 2_000_000;
const MAX_DATA_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 6_000;
const MAX_LINKS = 24;
const MAX_DATASETS = 40;
const MAX_CONFIG = 40;
const MAX_FIELDS = 24;
const MAX_DOM_NODES = 50_000;
const UNAVAILABLE: WorkspaceEvidenceKind[] = ['render_readback', 'operation_readback', 'deployment_relationship'];

function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
function authoringSurface(value: Record<string, unknown>): string {
  return stable(workspaceManifestAuthoringFields(value));
}
function safeLabel(value: string, max = 160): string {
  return redactSensitiveText(value).replace(/https?:\/\/[^\s<>"']+/gi, raw => safeWorkspaceEvidenceUrl(raw) ?? '[private link omitted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Hints, never relationship proof. Opaque/capability paths and local routes
 * are omitted; credentials, query parameters and fragments never escape. */
export function safeWorkspaceEvidenceUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || raw.length > 4_096) return null;
    if (/^(?:localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/i.test(url.hostname) || url.hostname.endsWith('.local')) return null;
    const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (segments.some(segment => /^(?:auth|oauth|callback|login|session|sessions|viewer|liveview|capability|capabilities|token|secret|share)$/i.test(segment))) return null;
    if (segments.some(segment => /[\u0000-\u001f\u007f]/.test(segment)
      || (segment.length >= 24 && /^[a-z\d_=-]+$/i.test(segment)
        && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(segment)))) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    const result = url.toString();
    return result.length <= 512 && redactSensitiveText(result) === result ? result : null;
  } catch { return null; }
}

function htmlFacts(html: string): { facts: WorkspaceDeliverablesFact[]; text: boolean; links: boolean } {
  const doc = parse(html);
  const stack: Html.Node[] = [...doc.childNodes].reverse();
  const text: string[] = [];
  const links: Array<{ destination: string }> = [];
  const seen = new Set<string>();
  let nodes = 0;
  let omittedLinks = 0;
  let limited = false;
  while (stack.length) {
    if (++nodes > MAX_DOM_NODES) { limited = true; break; }
    const node = stack.pop()!;
    if ('tagName' in node) {
      if (['script', 'style', 'template', 'noscript', 'head', 'iframe', 'object'].includes(node.tagName)
        || node.attrs.some(attr => attr.name === 'hidden' || (attr.name === 'aria-hidden' && attr.value === 'true'))) continue;
      if (node.tagName === 'a') {
        const href = node.attrs.find(attr => attr.name === 'href')?.value;
        if (href) {
          const destination = safeWorkspaceEvidenceUrl(href);
          if (!destination) omittedLinks += 1;
          else if (!seen.has(destination)) { seen.add(destination); links.push({ destination }); }
        }
      }
    }
    if (node.nodeName === '#text') text.push((node as Html.TextNode).value);
    if ('childNodes' in node) stack.push(...node.childNodes.slice().reverse());
  }
  const rawText = safeLabel(text.join(' '), MAX_VIEW_BYTES);
  return {
    facts: [
      { id: 'saved-view', supports: ['saved_content'], detail: { text: rawText.slice(0, MAX_TEXT), viewSha256: hash(html), textTruncated: limited || rawText.length > MAX_TEXT, visualRenderVerified: false } },
      { id: 'saved-links', supports: ['saved_content'], detail: { links: links.slice(0, MAX_LINKS), omittedUnsafeLinks: omittedLinks, linksTruncated: limited || links.length > MAX_LINKS || omittedLinks > 0, relationshipVerified: false } },
    ],
    text: limited || rawText.length > MAX_TEXT,
    links: limited || links.length > MAX_LINKS || omittedLinks > 0,
  };
}

function readComponent(root: string, relative: string, cap: number): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '.' || part === '..')) throw new Error('unsafe_component');
  const file = path.join(root, relative);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > cap) throw new Error('unreadable_component');
  const realRoot = realpathSync(root);
  const rootRelative = path.relative(realpathSync(path.join(BASE_DIR, 'spaces')), realRoot);
  if (!rootRelative || rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) throw new Error('unsafe_component');
  const rel = path.relative(realRoot, realpathSync(file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('unsafe_component');
  const bytes = readFileSync(file);
  if (bytes.length > cap) throw new Error('unreadable_component');
  return bytes.toString('utf8');
}

interface Observation {
  id: string; status: string; observed_at: string; cause: string;
  projection_mode: string; content_hash: string | null; is_current: number;
}
function shape(value: unknown): { kind: string; count: number | null; fields: string[]; fieldsTruncated: boolean } {
  const rows = locateWorkspaceRecords(value)?.records;
  const fields = new Set<string>();
  const candidates = rows ? rows.slice(0, 5) : [value];
  for (const candidate of candidates) if (object(candidate)) for (const key of Object.keys(candidate)) {
    if (!isSecretLikeKey(key) && !key.startsWith('_')) fields.add(safeLabel(key, 100));
  }
  return { kind: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
    count: countWorkspaceRecords(value), fields: [...fields].filter(Boolean).slice(0, MAX_FIELDS), fieldsTruncated: fields.size > MAX_FIELDS };
}

/** Only current, non-retired observations. Latest commit status wins over an
 * older is_current success: a failed refresh keeps old data for display. */
function latestObservation(db: Database.Database, workspaceId: string, sourceKey: string): Observation | undefined {
  return db.prepare(`SELECT o.id,o.status,o.observed_at,o.cause,o.projection_mode,o.content_hash,o.is_current
    FROM workspace_dataset_observations o
    LEFT JOIN workspace_dataset_source_retirements r ON r.workspace_id=o.workspace_id AND r.source_key=o.source_key
    WHERE o.workspace_id=? AND o.source_key=? AND (r.workspace_id IS NULL OR o.rowid>r.retired_after_rowid)
    ORDER BY o.rowid DESC LIMIT 1`).get(workspaceId, sourceKey) as Observation | undefined;
}

function unavailable(reason: string): WorkspaceDeliverablesEvidence {
  return { version: 1, status: 'unavailable', reason, fingerprint: hash(reason), snapshot: null, facts: [],
    truncation: { text: false, links: false, datasets: false, configuration: false, fields: false },
    unavailableEvidence: ['saved_content', 'configuration', 'data_readback', ...UNAVAILABLE],
    limitations: ['No completion evidence was captured; do not infer an empty or working Workspace.'] };
}

/** No provider calls, refresh, schema/bootstrap or projection healing. The
 * existing cooperative snapshot read may finish its owner's recovery journal. */
export function captureWorkspaceDeliverablesEvidence(
  record: SpaceRecord,
  expectedViewHtml: string,
  feeds: readonly WorkspaceDeliverablesFeed[],
): WorkspaceDeliverablesEvidence {
  try {
    return withWorkspaceSnapshotRead<WorkspaceDeliverablesEvidence>(record.id, () => {
      const root = path.join(BASE_DIR, 'spaces', record.id);
      const manifestText = readComponent(root, 'space.json', MAX_MANIFEST_BYTES);
      const manifest: unknown = JSON.parse(manifestText);
      const { manifestErrors: _diagnostics, ...persisted } = record;
      const candidate = JSON.parse(JSON.stringify(persisted)) as Record<string, unknown>;
      if (!object(manifest) || manifest.id !== record.id || !Number.isSafeInteger(manifest.version)
        || !Array.isArray(manifest.dataSources) || !Array.isArray(manifest.actions)
        || typeof manifest.viewEntry !== 'string' || manifest.version !== record.version
        || authoringSurface(manifest) !== authoringSurface(candidate)) return unavailable('saved_authoring_surface_changed');
      const view = readComponent(root, manifest.viewEntry, MAX_VIEW_BYTES);
      if (view !== expectedViewHtml) return unavailable('saved_view_changed');
      let dataText: string | null = null;
      let data: unknown;
      let dataState: 'present' | 'absent' | 'unreadable' = 'absent';
      try {
        dataText = readComponent(root, 'data.json', MAX_DATA_BYTES);
        data = JSON.parse(dataText);
        if (!object(data)) throw new Error('invalid_document');
        dataState = 'present';
      } catch (error) {
        dataState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
      }
      const projection = htmlFacts(view);
      const facts = [...projection.facts];
      facts.unshift({ id: 'saved-manifest', supports: ['saved_content', 'configuration'], detail: {
        workspaceId: safeLabel(record.id), version: record.version, manifestSha256: hash(manifestText),
        contentMode: record.contentMode ?? 'dynamic_or_unspecified',
      } });
      for (const [index, source] of record.dataSources.slice(0, MAX_CONFIG).entries()) facts.push({
        id: `source-${index + 1}`, supports: ['configuration'], detail: { sourceKey: safeLabel(source.id), configured: true, executionVerified: false },
      });
      for (const [index, action] of record.actions.slice(0, MAX_CONFIG).entries()) facts.push({
        id: `action-${index + 1}`, supports: ['configuration'], detail: { actionId: safeLabel(action.id), label: safeLabel(action.label ?? action.id), configured: true, executionVerified: false },
      });
      for (const [index, feed] of feeds.slice(0, MAX_CONFIG).entries()) facts.push({
        id: `feed-${index + 1}`, supports: ['configuration'], detail: { workflow: safeLabel(feed.workflow), enabled: feed.enabled,
          collections: feed.collections.slice(0, MAX_CONFIG).map(key => safeLabel(key)), executionVerified: false },
      });
      const keys = new Set(record.contentMode === 'static_snapshot' ? ['$document'] : []);
      for (const source of record.dataSources) keys.add(source.id);
      for (const feed of feeds) for (const key of feed.collections) keys.add(key);
      if (object(data)) for (const key of Object.keys(data)) if (!key.startsWith('_')) keys.add(key);
      const dataKeys = [...keys];
      let db: Database.Database | undefined;
      let observationsAvailable = false;
      try {
        const dbPath = path.join(BASE_DIR, 'state', 'workspaces.db');
        if (existsSync(dbPath)) {
          db = new Database(dbPath, { readonly: true, fileMustExist: true });
          db.pragma('query_only = ON'); db.exec('BEGIN');
          // Missing/corrupt ledgers are unknown, never a manufactured zero.
          db.prepare('SELECT 1 FROM workspace_dataset_observations LIMIT 1').get();
          observationsAvailable = true;
        }
        let fieldsTruncated = false;
        for (const [index, key] of dataKeys.slice(0, MAX_DATASETS).entries()) {
          const present = dataState === 'present' && (key === '$document' || (object(data) && Object.hasOwn(data, key)));
          const value = key === '$document' ? data : object(data) ? data[key] : undefined;
          let observation: Observation | undefined;
          if (db && observationsAvailable) {
            try { observation = latestObservation(db, record.id, key); } catch { observationsAvailable = false; }
          }
          let contentMatches = false;
          try { contentMatches = present && Boolean(observation?.content_hash && workspaceDataContentDigest(value) === observation.content_hash); } catch { /* bounded JSON unreadable */ }
          const successful = observation?.status === 'ok' && observation.is_current === 1 && contentMatches
            && observation.projection_mode === (key === '$document' ? 'document' : 'source');
          const state = observation?.status === 'error' ? 'failed'
            : observation?.status === 'awaiting_approval' ? 'awaiting_approval'
              : dataState === 'unreadable' ? 'unreadable'
                : !present ? 'absent' : successful ? countWorkspaceRecords(value) === 0 ? 'empty_success' : 'readback' : 'stored_unverified';
          const summary = present ? shape(value) : null;
          fieldsTruncated ||= summary?.fieldsTruncated ?? false;
          facts.push({ id: `dataset-${index + 1}`, supports: successful ? ['saved_content', 'data_readback'] : present ? ['saved_content'] : [], detail: {
            sourceKey: safeLabel(key), state, summary: summary as Json,
            observation: observation ? { id: safeLabel(observation.id, 240), status: observation.status,
              observedAt: safeLabel(observation.observed_at, 80), contentHash: observation.content_hash,
              contentMatches, current: observation.is_current === 1,
              causeClass: observation.cause === 'legacy_import' ? 'imported_baseline' : key === '$document' ? 'authored_document' : 'committed_observation' } : null,
            providerAccountVerified: false, providerExecutionVerified: false,
          } });
        }
        // Re-read exact bytes under the same cooperative owner. Unmanaged raw
        // writers are not covered by its lock and must not create a mixed proof.
        if (readComponent(root, 'space.json', MAX_MANIFEST_BYTES) !== manifestText
          || readComponent(root, manifest.viewEntry, MAX_VIEW_BYTES) !== view
          || (dataText !== null && readComponent(root, 'data.json', MAX_DATA_BYTES) !== dataText)
          || (dataState === 'absent' && existsSync(path.join(root, 'data.json')))) return unavailable('snapshot_changed_during_capture');
        const revision = workspaceSnapshotRevision({ manifest: manifestText, view, data: dataText ?? '{}' });
        const packet: WorkspaceDeliverablesEvidence = { version: 1, status: 'available', fingerprint: '', snapshot: { workspaceId: record.id, version: record.version, revision,
          manifestSha256: hash(manifestText), viewSha256: hash(view), dataSha256: dataText === null ? null : hash(dataText), dataState },
          facts, truncation: { text: projection.text, links: projection.links, datasets: dataKeys.length > MAX_DATASETS,
            configuration: record.dataSources.length > MAX_CONFIG || record.actions.length > MAX_CONFIG || feeds.length > MAX_CONFIG || feeds.some(feed => feed.collections.length > MAX_CONFIG), fields: fieldsTruncated },
          unavailableEvidence: UNAVAILABLE.slice(), limitations: [
            'Saved content and configuration do not prove visual rendering, a working button, provider/account identity or any deployment relationship.',
            'Data readback proves only the matching committed observation value; no provider success or account correspondence is inferred.',
            ...(observationsAvailable ? [] : ['Dataset observation evidence is unavailable.']),
            ...(dataState === 'present' ? [] : [`Saved dataset is ${dataState}; do not infer successful empty data.`]),
          ] };
        packet.fingerprint = hash(stable({ ...packet, fingerprint: undefined }));
        return packet;
      } finally { if (db) { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); } }
    });
  } catch { return unavailable('saved_snapshot_unreadable'); }
}
