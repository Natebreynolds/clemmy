import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import { recordToolEvent } from '../agents/tool-observability.js';

/**
 * Tool-choice memory store.
 *
 * Stores reusable per-machine tool procedures. Intent prose is an alias used
 * for retrieval; the physical procedure is keyed by tool/provider, account,
 * and operation fingerprint so paraphrases do not create duplicate memory.
 *
 * Layout:
 *   ~/.clementine-next/memory/tool-choices/<machine-id>/<intent-slug>.md
 *   ~/.clementine-next/memory/tool-procedures/<machine-id>/<procedure-id>.md
 *
 * Legacy tool-choice files remain additive alias/evidence records. Canonical
 * procedure files own the active choice, outcome counters, evidence, aliases,
 * and impressions. No migration deletes historical intent files.
 *
 * `recallToolChoice` scores aliases within each procedure, so paraphrases
 * reinforce one candidate rather than tying duplicate physical records.
 *
 * Re-validation is event-driven only (decision 2026-05-19). A choice
 * stays valid until `invalidateToolChoice(intent, reason)` is called,
 * which moves the active choice into `fallbacks` and clears it.
 */

export type ToolChoiceKind = 'cli' | 'composio' | 'mcp';

/** Fold-3 pin namespace: workflow-step tool pins live in this store under
 *  workflow:<name>:<stepId> intents but are SCOPED OUT of every shared
 *  advertised surface and the fuzzy recall fallback (review wf_8e927519-d43:
 *  pins flooded the chat tool-choice block, evicting genuine chat memories
 *  and leaking workflow run args into unrelated turns). Exact-intent reads
 *  (peekToolChoice) still return them — that is the pin's only door. */
export const WORKFLOW_PIN_INTENT_PREFIX = 'workflow:';

export interface ToolChoiceRecordChoice {
  kind: ToolChoiceKind;
  /** CLI command name when kind=cli; Composio slug when kind=composio; MCP tool name when kind=mcp. */
  identifier: string;
  /** Free-form template the Executor renders. May contain `{{var}}` placeholders. */
  invocationTemplate?: string;
  /** kind=composio only: the STABLE mailbox identity (normalized email) this
   *  intent last used, so a multi-account user recalls the RIGHT mailbox. NEVER
   *  a volatile `ca_…` connection id (that rotates on re-auth) — the email is
   *  resolved to the current live connection at execute time. Absent on legacy
   *  / single-account choices. */
  accountIdentity?: string;
  /** ISO-8601 of when this choice was last validated. Informational. */
  testedAt: string;
  /** Short string describing how validation passed (e.g. "sf --version exit 0"). */
  testEvidence?: string;
  // ── Thread 2 — outcome-driven procedural memory ──
  // Track record of how this proven path has FARED since it was learned, so
  // retrieval can prefer procedures that actually work and retire ones that
  // don't. Reset when the identifier changes (a different tool earns its own
  // record). All optional → absent on legacy/never-measured choices.
  successCount?: number;
  failureCount?: number;
  approvalCount?: number;
  rejectionCount?: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export interface ToolChoiceRecordFallback {
  kind: ToolChoiceKind;
  identifier: string;
  failedAt: string;
  reason: string;
}

export interface ToolChoiceRecord {
  intent: string;
  description?: string;
  /** The currently active choice. Null when invalidated and not yet rediscovered. */
  choice: ToolChoiceRecordChoice | null;
  fallbacks: ToolChoiceRecordFallback[];
  /** Free-form markdown body after the frontmatter — optional human notes. */
  body: string;
  /** Absolute path of the underlying file. Useful for debugging. */
  filePath: string;
  /** Stable reusable procedure identity. Legacy records omit this until the
   * additive migration links them; the original intent file is retained. */
  procedureId?: string;
  procedureKey?: string;
  /** Status of this intent alias. Quarantined historical objective prose stays
   * inspectable but cannot drive recall or workflow binding. */
  aliasStatus?: ToolProcedureAliasStatus;
  /** All known aliases when this record is a canonical procedure projection. */
  aliases?: ToolProcedureAlias[];
  impressionCount?: number;
  lastImpressedAt?: string;
  evidenceCount?: number;
}

export type ToolProcedureAliasStatus = 'active' | 'quarantined' | 'superseded';
export type ToolProcedureAliasSource = 'manual' | 'composio_search' | 'native_mcp' | 'migration' | 'synthetic';

export interface ToolProcedureAlias {
  intent: string;
  description?: string;
  status: ToolProcedureAliasStatus;
  source: ToolProcedureAliasSource;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Historical alias file, when one exists. Synthetic canonical aliases do
   * not invent a legacy record. */
  legacyFilePath?: string;
}

export interface ToolProcedureEvidence {
  evidenceId: string;
  at: string;
  type: 'remember' | 'migration' | 'outcome' | 'supersession';
  intent?: string;
  text?: string;
}

export interface ToolProcedureRecord {
  procedureId: string;
  procedureKey: string;
  provider: string;
  operationHash: string;
  choice: ToolChoiceRecordChoice | null;
  aliases: ToolProcedureAlias[];
  fallbacks: ToolChoiceRecordFallback[];
  evidence: ToolProcedureEvidence[];
  /** Exposure is diagnostic only and never boosts ranking. */
  impressionCount: number;
  lastImpressedAt?: string;
  createdAt: string;
  updatedAt: string;
  filePath: string;
}

export interface RememberToolChoiceInput {
  intent: string;
  description?: string;
  choice: Omit<ToolChoiceRecordChoice, 'testedAt'> & { testedAt?: string };
  /** Optional fallbacks to record alongside the choice. Merged with any pre-existing fallbacks. */
  fallbacks?: ToolChoiceRecordFallback[];
  /** Optional body text. When omitted, preserves the existing body on update. */
  body?: string;
  /** Origin of this intent alias. It affects retrieval trust, not the canonical
   * procedure identity. */
  aliasSource?: ToolProcedureAliasSource;
  /** Additional contextual aliases. These enrich retrieval but never become
   * separate procedure records. */
  aliases?: Array<string | { intent: string; source?: ToolProcedureAliasSource; status?: ToolProcedureAliasStatus }>;
  /** Optional operation/schema fingerprint supplied by a discovery surface.
   * When absent, a stable conservative fingerprint is derived. */
  operationHash?: string;
}

const TOOL_CHOICES_ROOT = path.join(BASE_DIR, 'memory', 'tool-choices');
const TOOL_PROCEDURES_ROOT = path.join(BASE_DIR, 'memory', 'tool-procedures');

function machineDir(): string {
  return path.join(TOOL_CHOICES_ROOT, getMachineId());
}

function ensureMachineDir(): string {
  const dir = machineDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function procedureMachineDir(): string {
  return path.join(TOOL_PROCEDURES_ROOT, getMachineId());
}

function ensureProcedureMachineDir(): string {
  const dir = procedureMachineDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Slugify a free-form intent string for use as a filename. Conservative — preserves dots. */
export function slugifyIntent(intent: string): string {
  return intent
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function filePathFor(intent: string): string {
  const slug = slugifyIntent(intent);
  return path.join(machineDir(), `${slug}.md`);
}

function parseRecordRaw(filePath: string): ToolChoiceRecord | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const intent = typeof fm.intent === 'string' ? fm.intent : path.basename(filePath, '.md');
    const description = typeof fm.description === 'string' ? fm.description : undefined;
    const choice = parseChoice(fm.choice);
    const fallbacks = Array.isArray(fm.fallbacks) ? fm.fallbacks.map(parseFallback).filter(isFallback) : [];
    const procedureId = typeof fm.procedureId === 'string' ? fm.procedureId : undefined;
    const procedureKey = typeof fm.procedureKey === 'string' ? fm.procedureKey : undefined;
    const status = fm.aliasStatus;
    const aliasStatus = status === 'active' || status === 'quarantined' || status === 'superseded' ? status : undefined;
    return { intent, description, choice, fallbacks, body: parsed.content ?? '', filePath, procedureId, procedureKey, aliasStatus };
  } catch {
    // A torn write or hand-edited file must degrade to "no record", never
    // poison migration/recall for every other intent on this machine.
    return null;
  }
}

function parseRecord(filePath: string): ToolChoiceRecord | null {
  const raw = parseRecordRaw(filePath);
  if (!raw?.procedureId) return raw;
  const procedure = parseProcedure(procedureFilePath(raw.procedureId));
  if (!procedure) return raw;
  return {
    ...raw,
    procedureKey: procedure.procedureKey,
    choice: procedure.choice,
    fallbacks: mergeFallbacks(raw.fallbacks, procedure.fallbacks),
    aliases: procedure.aliases,
    impressionCount: procedure.impressionCount,
    lastImpressedAt: procedure.lastImpressedAt,
    evidenceCount: procedure.evidence.length,
  };
}

function placeholderChoiceString(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0
    || normalized === 'null'
    || normalized === 'undefined'
    || normalized === 'none'
    || normalized === 'n/a'
    || normalized === 'na'
    || normalized === 'unknown';
}

function cleanInvocationTemplate(value: unknown): string | undefined {
  if (placeholderChoiceString(value)) return undefined;
  return stripBakedConnectionId(value as string);
}

function parseChoice(raw: unknown): ToolChoiceRecordChoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  const identifier = r.identifier ?? r.command ?? r.slug ?? r.name;
  if (kind !== 'cli' && kind !== 'composio' && kind !== 'mcp') return null;
  if (placeholderChoiceString(identifier)) return null;
  return {
    kind,
    identifier: (identifier as string).trim(),
    // Strip any baked `connected_account_id` on READ too (not just on write):
    // 50+ legacy choices on disk still carry a hardcoded ca_… that, if the model
    // copied the template verbatim into composio_execute_tool, would override the
    // LIVE connection resolution and silently fail when that id rotates/revokes
    // (the 2026-06-01 Airtable INVALID_PERMISSIONS class). Stripping at the single
    // read source means every consumer — context injection, recall, the authoring
    // matcher — sees a connection-less template and always falls to live resolve.
    invocationTemplate: cleanInvocationTemplate(r.invocationTemplate),
    accountIdentity: parseAccountIdentity(r.accountIdentity),
    testedAt: typeof r.testedAt === 'string' ? r.testedAt : new Date().toISOString(),
    testEvidence: typeof r.testEvidence === 'string' ? r.testEvidence : undefined,
    // Outcome counters — only present once measured, so legacy files round-trip
    // byte-identically until an outcome is recorded.
    successCount: numOrUndef(r.successCount),
    failureCount: numOrUndef(r.failureCount),
    approvalCount: numOrUndef(r.approvalCount),
    rejectionCount: numOrUndef(r.rejectionCount),
    lastSuccessAt: typeof r.lastSuccessAt === 'string' ? r.lastSuccessAt : undefined,
    lastFailureAt: typeof r.lastFailureAt === 'string' ? r.lastFailureAt : undefined,
  };
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** kind=composio mailbox identity guard: accept ONLY a real, normalized email;
 *  reject a volatile `ca_…` connection id or any non-email so a confused/hostile
 *  caller can never re-smuggle a volatile handle as a stable recall binding.
 *  Mirrors normalizeEmail (sender-verify) so identities compare identically. */
function parseAccountIdentity(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase().replace(/^smtp:/, '');
  if (!t || /^ca_/i.test(t) || !t.includes('@')) return undefined;
  return t;
}

function parseFallback(raw: unknown): ToolChoiceRecordFallback | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  const identifier = r.identifier ?? r.command ?? r.slug ?? r.name;
  const reason = r.reason;
  if (kind !== 'cli' && kind !== 'composio' && kind !== 'mcp') return null;
  if (typeof identifier !== 'string') return null;
  if (typeof reason !== 'string') return null;
  return {
    kind,
    identifier,
    failedAt: typeof r.failedAt === 'string' ? r.failedAt : new Date().toISOString(),
    reason,
  };
}

function isFallback(x: ToolChoiceRecordFallback | null): x is ToolChoiceRecordFallback {
  return x !== null;
}

function writeRecord(record: Omit<ToolChoiceRecord, 'filePath'> & { filePath?: string }): ToolChoiceRecord {
  ensureMachineDir();
  const filePath = record.filePath ?? filePathFor(record.intent);
  const fm: Record<string, unknown> = {
    intent: record.intent,
    ...(record.description ? { description: record.description } : {}),
    ...(record.procedureId ? { procedureId: record.procedureId } : {}),
    ...(record.procedureKey ? { procedureKey: record.procedureKey } : {}),
    ...(record.aliasStatus ? { aliasStatus: record.aliasStatus } : {}),
    choice: record.choice ?? null,
    fallbacks: record.fallbacks,
  };
  const body = record.body ?? defaultBodyFor(record.intent, record.description);
  // gray-matter / js-yaml refuses to serialize `undefined`. Strip
  // undefined keys recursively before dumping so callers can pass
  // partial objects (e.g. choice without invocationTemplate) without
  // having to construct exact-shape literals.
  const stringified = matter.stringify(body, stripUndefined(fm) as object);
  writeFileSync(filePath, stringified, 'utf-8');
  return { ...record, body, filePath };
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as unknown as T;
  }
  return value;
}

function defaultBodyFor(intent: string, description?: string): string {
  return [
    `# Tool choice — \`${intent}\``,
    '',
    description ?? '_(no description provided)_',
    '',
    'This file is maintained by Clementine\'s tool-choice memory. Edits are safe; the frontmatter is the source of truth.',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────
// Canonical procedures — one reusable operation, many intent aliases
// ─────────────────────────────────────────────────────────────────

function procedureFilePath(procedureId: string): string {
  return path.join(procedureMachineDir(), `${procedureId}.md`);
}

function parseAlias(raw: unknown): ToolProcedureAlias | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const intent = typeof value.intent === 'string' ? value.intent.trim() : '';
  if (!intent) return null;
  const status = value.status;
  const source = value.source;
  return {
    intent,
    description: typeof value.description === 'string' ? value.description : undefined,
    status: status === 'quarantined' || status === 'superseded' ? status : 'active',
    source: source === 'composio_search' || source === 'native_mcp' || source === 'migration' || source === 'synthetic'
      ? source
      : 'manual',
    firstSeenAt: typeof value.firstSeenAt === 'string' ? value.firstSeenAt : new Date(0).toISOString(),
    lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : new Date(0).toISOString(),
    legacyFilePath: typeof value.legacyFilePath === 'string' ? value.legacyFilePath : undefined,
  };
}

function parseEvidence(raw: unknown): ToolProcedureEvidence | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const evidenceId = typeof value.evidenceId === 'string' ? value.evidenceId : '';
  const type = value.type;
  if (!evidenceId || (type !== 'remember' && type !== 'migration' && type !== 'outcome' && type !== 'supersession')) return null;
  return {
    evidenceId,
    at: typeof value.at === 'string' ? value.at : new Date(0).toISOString(),
    type,
    intent: typeof value.intent === 'string' ? value.intent : undefined,
    text: typeof value.text === 'string' ? value.text : undefined,
  };
}

function parseProcedure(filePath: string): ToolProcedureRecord | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = matter(readFileSync(filePath, 'utf-8'));
    const fm = parsed.data as Record<string, unknown>;
    const procedureId = typeof fm.procedureId === 'string' ? fm.procedureId : path.basename(filePath, '.md');
    const procedureKey = typeof fm.procedureKey === 'string' ? fm.procedureKey : '';
    const provider = typeof fm.provider === 'string' ? fm.provider : '';
    const operationHash = typeof fm.operationHash === 'string' ? fm.operationHash : '';
    if (!procedureId || !procedureKey || !provider || !operationHash) return null;
    return {
      procedureId,
      procedureKey,
      provider,
      operationHash,
      choice: parseChoice(fm.choice),
      aliases: Array.isArray(fm.aliases) ? fm.aliases.map(parseAlias).filter((x): x is ToolProcedureAlias => x !== null) : [],
      fallbacks: Array.isArray(fm.fallbacks) ? fm.fallbacks.map(parseFallback).filter(isFallback) : [],
      evidence: Array.isArray(fm.evidence) ? fm.evidence.map(parseEvidence).filter((x): x is ToolProcedureEvidence => x !== null) : [],
      impressionCount: numOrUndef(fm.impressionCount) ?? 0,
      lastImpressedAt: typeof fm.lastImpressedAt === 'string' ? fm.lastImpressedAt : undefined,
      createdAt: typeof fm.createdAt === 'string' ? fm.createdAt : new Date(0).toISOString(),
      updatedAt: typeof fm.updatedAt === 'string' ? fm.updatedAt : new Date(0).toISOString(),
      filePath,
    };
  } catch {
    return null;
  }
}

function writeProcedure(procedure: ToolProcedureRecord): ToolProcedureRecord {
  ensureProcedureMachineDir();
  const filePath = procedureFilePath(procedure.procedureId);
  const fm = stripUndefined({
    schemaVersion: 1,
    procedureId: procedure.procedureId,
    procedureKey: procedure.procedureKey,
    provider: procedure.provider,
    operationHash: procedure.operationHash,
    choice: procedure.choice,
    aliases: procedure.aliases,
    fallbacks: procedure.fallbacks,
    evidence: procedure.evidence,
    impressionCount: procedure.impressionCount,
    lastImpressedAt: procedure.lastImpressedAt,
    createdAt: procedure.createdAt,
    updatedAt: procedure.updatedAt,
  });
  const label = procedure.choice ? `${procedure.choice.kind}:${procedure.choice.identifier}` : procedure.procedureId;
  writeFileSync(filePath, matter.stringify(
    `# Canonical tool procedure — \`${label}\`\n\nThis file owns reusable procedure identity and outcome evidence. Intent-specific legacy files are retained as aliases.\n`,
    fm as object,
  ), 'utf-8');
  return { ...procedure, filePath };
}

function shortHash(value: string, length = 20): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function normalizeIdentityPart(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function providerForChoice(choice: Pick<ToolChoiceRecordChoice, 'kind' | 'identifier'>): string {
  const identifier = normalizeIdentityPart(choice.identifier);
  if (choice.kind === 'mcp') return identifier.split('__')[0] || identifier;
  if (choice.kind === 'composio') return identifier.split('_')[0] || identifier;
  return identifier.split(/\s+/)[0] || identifier;
}

function cliOperationSignature(intent: string, choice: Pick<ToolChoiceRecordChoice, 'identifier' | 'invocationTemplate'>): string {
  const template = cleanInvocationTemplate(choice.invocationTemplate);
  const head = template ? normalizeIdentityPart(cliCommandHead(template)) : '';
  const identifier = normalizeIdentityPart(choice.identifier);
  // A concrete command head is the most truthful operation/schema proxy. If a
  // legacy CLI memo only knows the binary, retain a conservative intent hash so
  // unrelated subcommands are never collapsed merely because they share `sf`,
  // `gh`, or `netlify`.
  const meaningfulHead = head
    .split(/\s+/)
    .filter((token) => token && token !== '...' && !/^<.*>$/.test(token))
    .join(' ');
  if (meaningfulHead && meaningfulHead !== identifier) return meaningfulHead;
  return `legacy-intent:${slugifyIntent(intent)}`;
}

export interface CanonicalToolProcedureIdentity {
  procedureId: string;
  procedureKey: string;
  provider: string;
  operationHash: string;
}

/** Stable physical identity for a reusable operation. Intent prose is an alias,
 * not the primary key. Composio/MCP identifiers already encode an operation;
 * CLI paths use the command head or a conservative legacy-intent fallback. */
export function canonicalToolProcedureIdentity(input: {
  intent: string;
  choice: Pick<ToolChoiceRecordChoice, 'kind' | 'identifier' | 'invocationTemplate' | 'accountIdentity'>;
  operationHash?: string;
}): CanonicalToolProcedureIdentity {
  const kind = input.choice.kind;
  const identifier = normalizeIdentityPart(input.choice.identifier);
  const provider = providerForChoice(input.choice);
  const accountIdentity = parseAccountIdentity(input.choice.accountIdentity) ?? '';
  const operationSignature = input.intent.startsWith(WORKFLOW_PIN_INTENT_PREFIX)
    ? `workflow-pin:${slugifyIntent(input.intent)}:${identifier}`
    : kind === 'cli'
      ? cliOperationSignature(input.intent, input.choice)
      : identifier;
  const operationHash = normalizeIdentityPart(input.operationHash) || shortHash(operationSignature, 24);
  const procedureKey = ['v1', kind, provider, identifier, accountIdentity, operationHash].join('|');
  return {
    procedureId: `tp_${shortHash(procedureKey, 24)}`,
    procedureKey,
    provider,
    operationHash,
  };
}

function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Duplicate legacy records often carry the SAME broadcast outcome. Taking the
 * maximum counter preserves the evidence without multiplying one real use by
 * the number of aliases. */
function mergeProcedureChoice(
  current: ToolChoiceRecordChoice | null,
  incoming: ToolChoiceRecordChoice,
): ToolChoiceRecordChoice {
  if (!current) return { ...incoming };
  const incomingIsNewer = (incoming.testedAt ?? '') >= (current.testedAt ?? '');
  const preferred = incomingIsNewer ? incoming : current;
  return {
    ...preferred,
    invocationTemplate: preferred.invocationTemplate ?? current.invocationTemplate ?? incoming.invocationTemplate,
    accountIdentity: preferred.accountIdentity ?? current.accountIdentity ?? incoming.accountIdentity,
    testEvidence: preferred.testEvidence ?? current.testEvidence ?? incoming.testEvidence,
    successCount: Math.max(current.successCount ?? 0, incoming.successCount ?? 0) || undefined,
    failureCount: Math.max(current.failureCount ?? 0, incoming.failureCount ?? 0) || undefined,
    approvalCount: Math.max(current.approvalCount ?? 0, incoming.approvalCount ?? 0) || undefined,
    rejectionCount: Math.max(current.rejectionCount ?? 0, incoming.rejectionCount ?? 0) || undefined,
    lastSuccessAt: laterIso(current.lastSuccessAt, incoming.lastSuccessAt),
    lastFailureAt: laterIso(current.lastFailureAt, incoming.lastFailureAt),
  };
}

function mergeProcedureAliases(existing: ToolProcedureAlias[], incoming: ToolProcedureAlias[]): ToolProcedureAlias[] {
  const byIntent = new Map<string, ToolProcedureAlias>();
  for (const alias of [...existing, ...incoming]) {
    const key = slugifyIntent(alias.intent) || alias.intent.toLowerCase();
    const prior = byIntent.get(key);
    if (!prior) { byIntent.set(key, alias); continue; }
    byIntent.set(key, {
      ...prior,
      ...alias,
      description: alias.description ?? prior.description,
      firstSeenAt: prior.firstSeenAt <= alias.firstSeenAt ? prior.firstSeenAt : alias.firstSeenAt,
      lastSeenAt: prior.lastSeenAt >= alias.lastSeenAt ? prior.lastSeenAt : alias.lastSeenAt,
      // Never let a later migration silently reactivate a quarantined alias.
      status: prior.status === 'quarantined' || alias.status === 'quarantined'
        ? 'quarantined'
        : alias.status,
      legacyFilePath: alias.legacyFilePath ?? prior.legacyFilePath,
    });
  }
  return [...byIntent.values()];
}

function mergeProcedureEvidence(existing: ToolProcedureEvidence[], incoming: ToolProcedureEvidence[]): ToolProcedureEvidence[] {
  const seen = new Set<string>();
  const out: ToolProcedureEvidence[] = [];
  for (const evidence of [...existing, ...incoming]) {
    if (seen.has(evidence.evidenceId)) continue;
    seen.add(evidence.evidenceId);
    out.push(evidence);
  }
  return out.slice(-200);
}

function nativeMcpCanonicalIntent(identifier: string): string {
  const [server = 'mcp', tool = 'tool'] = identifier.trim().split('__', 2);
  return `${server}.${tool}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '.');
}

function looksLikeLegacyObjectiveAlias(rec: ToolChoiceRecord): boolean {
  const choice = rec.choice;
  if (!choice || choice.kind !== 'mcp') return false;
  if (
    rec.description?.startsWith('Auto-remembered: this native MCP tool satisfied the active objective.')
    && slugifyIntent(rec.intent) !== slugifyIntent(nativeMcpCanonicalIntent(choice.identifier))
  ) return true;
  const escaped = choice.identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\s[—-]\\s${escaped}$`, 'i').test(rec.intent.trim());
}

function inferredAliasSource(rec: ToolChoiceRecord): ToolProcedureAliasSource {
  if (looksLikeLegacyObjectiveAlias(rec)) return 'native_mcp';
  if (rec.description?.startsWith('Auto-remembered: this Composio slug satisfied')) return 'composio_search';
  return rec.procedureId ? 'manual' : 'migration';
}

function migrationEvidenceId(rec: ToolChoiceRecord, identity: CanonicalToolProcedureIdentity): string {
  return `ev_${shortHash(`${identity.procedureId}|${rec.intent}|${rec.choice?.testedAt ?? ''}|migration`, 24)}`;
}

function upsertCanonicalProcedure(input: {
  identity: CanonicalToolProcedureIdentity;
  choice: ToolChoiceRecordChoice;
  aliases: ToolProcedureAlias[];
  fallbacks?: ToolChoiceRecordFallback[];
  evidence?: ToolProcedureEvidence[];
  now: string;
}): ToolProcedureRecord {
  const current = parseProcedure(procedureFilePath(input.identity.procedureId));
  return writeProcedure({
    procedureId: input.identity.procedureId,
    procedureKey: input.identity.procedureKey,
    provider: input.identity.provider,
    operationHash: input.identity.operationHash,
    choice: mergeProcedureChoice(current?.choice ?? null, input.choice),
    aliases: mergeProcedureAliases(current?.aliases ?? [], input.aliases),
    fallbacks: mergeFallbacks(current?.fallbacks ?? [], input.fallbacks ?? []),
    evidence: mergeProcedureEvidence(current?.evidence ?? [], input.evidence ?? []),
    impressionCount: current?.impressionCount ?? 0,
    lastImpressedAt: current?.lastImpressedAt,
    createdAt: current?.createdAt ?? input.now,
    updatedAt: input.now,
    filePath: procedureFilePath(input.identity.procedureId),
  });
}

function markCanonicalAliasStatus(
  procedureId: string | undefined,
  intent: string,
  status: ToolProcedureAliasStatus,
  evidenceText?: string,
): void {
  if (!procedureId) return;
  const current = parseProcedure(procedureFilePath(procedureId));
  if (!current) return;
  const now = new Date().toISOString();
  const aliases = current.aliases.map((alias) => (
    slugifyIntent(alias.intent) === slugifyIntent(intent)
      ? { ...alias, status, lastSeenAt: now }
      : alias
  ));
  writeProcedure({
    ...current,
    aliases,
    evidence: mergeProcedureEvidence(current.evidence, [{
      evidenceId: `ev_${randomUUID()}`,
      at: now,
      type: 'supersession',
      intent,
      text: evidenceText,
    }]),
    updatedAt: now,
  });
}

export interface ToolProcedureMigrationReport {
  aliasesScanned: number;
  aliasesLinked: number;
  proceduresCreated: number;
  quarantinedAliases: number;
}

const migratedMachines = new Set<string>();

/** Additive, idempotent migration. Original intent files remain in place and
 * gain only procedure-link metadata; canonical files own shared counters.
 * Existing duplicated broadcast counters are merged with max(), never summed. */
export function migrateToolChoicesToCanonicalProcedures(): ToolProcedureMigrationReport {
  const machineId = getMachineId();
  const report: ToolProcedureMigrationReport = { aliasesScanned: 0, aliasesLinked: 0, proceduresCreated: 0, quarantinedAliases: 0 };
  const dir = machineDir();
  if (!existsSync(dir)) { migratedMachines.add(machineId); return report; }
  const records = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => parseRecordRaw(path.join(dir, name)))
    .filter((record): record is ToolChoiceRecord => record !== null);
  report.aliasesScanned = records.length;
  const existed = new Set<string>();
  const pdir = procedureMachineDir();
  if (existsSync(pdir)) {
    for (const name of readdirSync(pdir)) if (name.endsWith('.md')) existed.add(name.slice(0, -3));
  }
  for (const rec of records) {
    if (!rec.choice) continue;
    const linkedProcedure = rec.procedureId ? parseProcedure(procedureFilePath(rec.procedureId)) : null;
    const linkedChoice = linkedProcedure?.choice;
    const sameLinkedPath = Boolean(
      linkedProcedure
      && linkedChoice
      && linkedChoice.kind === rec.choice.kind
      && linkedChoice.identifier === rec.choice.identifier
      && (linkedChoice.accountIdentity ?? '') === (rec.choice.accountIdentity ?? ''),
    );
    // Trust an existing canonical link when the physical path still matches.
    // This preserves an explicit schema/operation hash that legacy alias files
    // intentionally do not duplicate.
    const identity: CanonicalToolProcedureIdentity = sameLinkedPath && linkedProcedure
      ? {
          procedureId: linkedProcedure.procedureId,
          procedureKey: linkedProcedure.procedureKey,
          provider: linkedProcedure.provider,
          operationHash: linkedProcedure.operationHash,
        }
      : canonicalToolProcedureIdentity({ intent: rec.intent, choice: rec.choice });
    const now = new Date().toISOString();
    const quarantined = looksLikeLegacyObjectiveAlias(rec);
    const status: ToolProcedureAliasStatus = quarantined ? 'quarantined' : 'active';
    if (quarantined) report.quarantinedAliases += 1;
    const aliases: ToolProcedureAlias[] = [{
      intent: rec.intent,
      description: rec.description,
      status,
      source: inferredAliasSource(rec),
      firstSeenAt: rec.choice.testedAt || now,
      lastSeenAt: rec.choice.testedAt || now,
      legacyFilePath: rec.filePath,
    }];
    // Historical native-MCP objective prose is retained but cannot be the
    // binding key. Add a compact operation-derived alias so the capability is
    // still recallable without the project prose.
    if (quarantined) {
      aliases.push({
        intent: nativeMcpCanonicalIntent(rec.choice.identifier),
        status: 'active',
        source: 'synthetic',
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
    upsertCanonicalProcedure({
      identity,
      choice: rec.choice,
      aliases,
      fallbacks: rec.fallbacks,
      evidence: [{
        evidenceId: migrationEvidenceId(rec, identity),
        at: rec.choice.testedAt || now,
        type: 'migration',
        intent: rec.intent,
        text: rec.choice.testEvidence,
      }],
      now,
    });
    if (!existed.has(identity.procedureId)) {
      existed.add(identity.procedureId);
      report.proceduresCreated += 1;
    }
    writeRecord({
      ...rec,
      procedureId: identity.procedureId,
      procedureKey: identity.procedureKey,
      aliasStatus: status,
      filePath: rec.filePath,
    });
    report.aliasesLinked += 1;
  }
  migratedMachines.add(machineId);
  return report;
}

function ensureCanonicalMigration(): void {
  const machineId = getMachineId();
  if (!migratedMachines.has(machineId)) migrateToolChoicesToCanonicalProcedures();
}

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

/**
 * Look up a recorded tool choice for an intent.
 *
 * Lookup strategy:
 *   1. Exact slug match → return that record.
 *   2. No exact match → fuzzy scan: rank existing slugs by token-overlap
 *      with the query slug; if the best candidate's score is ≥ 0.5 and
 *      strictly higher than the runner-up, return it.
 *   3. Otherwise return null.
 *
 * The fuzzy threshold is deliberately conservative: a borderline match
 * is more dangerous than a miss (false-positive picks a wrong tool).
 */
export function recallToolChoice(intent: string): ToolChoiceRecord | null {
  const slug = slugifyIntent(intent);
  if (!slug) return null;

  ensureCanonicalMigration();

  const exactPath = path.join(machineDir(), `${slug}.md`);
  const exact = parseRecord(exactPath);
  if (exact && exact.aliasStatus !== 'quarantined' && exact.aliasStatus !== 'superseded') {
    emitToolChoiceEvent('recall_hit', intent, exact.choice?.identifier);
    return exact;
  }

  // Canonical fallback: score aliases WITHIN each procedure, then rank one
  // candidate per procedure. Near-duplicate intent files now reinforce a single
  // procedure instead of tying each other and causing a miss.
  const queryTokens = tokenize(slug);
  const scored = listToolChoices()
    .filter((record) => !record.intent.startsWith(WORKFLOW_PIN_INTENT_PREFIX))
    .map((record) => {
      const aliases = (record.aliases?.length ? record.aliases : [{
        intent: record.intent,
        status: record.aliasStatus ?? 'active',
        source: 'manual' as const,
        firstSeenAt: '',
        lastSeenAt: '',
      }])
        .filter((alias) => alias.status === 'active' && alias.source !== 'native_mcp');
      const bestAlias = aliases
        .map((alias) => ({ alias, score: jaccardOverlap(queryTokens, tokenize(slugifyIntent(alias.intent))) }))
        .sort((a, b) => b.score - a.score)[0];
      return { record, alias: bestAlias?.alias, score: bestAlias?.score ?? 0 };
    })
    .filter((entry) => entry.alias)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score < 0.5) { emitToolChoiceEvent('recall_miss', intent); return null; }
  if (runnerUp && runnerUp.score >= best.score) { emitToolChoiceEvent('recall_miss', intent); return null; }
  const fuzzy = best.record;
  emitToolChoiceEvent('recall_hit_fuzzy', intent, fuzzy.choice?.identifier);
  return fuzzy;
}

function tokenize(slug: string): Set<string> {
  return new Set(
    slug
      .split(/[._\-/]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Upsert a tool choice. Merges with any existing record:
 *   - `choice` is replaced wholesale.
 *   - `fallbacks` from the input are appended to existing fallbacks
 *     (deduped by kind+identifier+reason).
 *   - `description` updates only if the input provides one.
 *   - `body` updates only if the input provides one.
 */
/**
 * Strip a hardcoded `connected_account_id` (Composio connection id, `ca_…`)
 * from a saved invocation template. Connection ids ROT — they get re-issued,
 * duplicated, or revoked — and a stale one baked into a tool-choice silently
 * breaks the WHOLE toolkit (observed 2026-06-01: Airtable returned
 * INVALID_PERMISSIONS for every records call because the cached template
 * pinned a dead `ca_…`). We never persist a specific connection; the composio
 * client resolves the LIVE connection for the toolkit at call time instead.
 */
export function stripBakedConnectionId(template: string | undefined): string | undefined {
  if (!template) return template;
  return template
    .replace(/connected_account_id\s*[=:]\s*["'][^"']*["']\s*,?\s*/g, '')
    .replace(/,\s*\)/g, ')')
    .replace(/\(\s*,\s*/g, '(')
    // Also clean the JSON-object/array case (e.g. stripping a mid-object
    // `connected_account_id` can leave a dangling `, }` or `{ ,`).
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{[])\s*,/g, '$1')
    .trim();
}

/**
 * Detect when a tool-choice's OWN evidence says the attempt FAILED or was
 * BLOCKED by a gate — so we never persist a failure as a PROVEN choice.
 *
 * The 2026-06-21 poisoning: a `netlify deploy` was hard-blocked by the
 * destination gate, after which the model called `tool_choice_remember` with
 * evidence "refused by harness UNVERIFIED_DESTINATION gate … must run manually"
 * — and the store saved it as the proven path, so the NEXT deploy would recall
 * "must run manually" instead of the real working memo (`netlify.deploy.local_site`).
 * A proven choice must represent something that WORKED. This is a code-level
 * guard (not a prompt rule), general across gates/CLIs/vendors. Conservative:
 * requires a STRONG failure/refusal marker, so a memo that merely *mentions*
 * handling failures ("retries on a 5xx") is not dropped.
 */
export function evidenceLooksFailedOrBlocked(text: string | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  return (
    // Harness gate refusals — the exact poisoning vector (any gate, not netlify).
    /\b(unverified_destination|implicit_destination|execution_wrap_required|confirm_first_required|grounding_check_failed|duplicate_external_write)\b/.test(t)
    // "(refused|blocked) by the [destination|grounding|…] (gate|harness|guardrail)"
    // — allow one adjective between the article and the noun.
    || /(?:refused|blocked) by (?:the )?(?:\w+ )?(?:harness|gate|guardrail)|tool call refused/.test(t)
    // Punted to the human — the choice did NOT complete programmatically. Anchor
    // to a NECESSITY/failure cue near "manual(ly)" so a success aside ("X works,
    // but you can also deploy it manually") is NOT misread as a failure that
    // drops a genuinely-proven choice. "can/could" are permissive, NOT cues.
    || /\b(?:must|need(?:s|ed)? to|have to|had to|only way|only option|instead|couldn't|could not|can't|cannot|unable to|forced to|gave up and)\b[^.]{0,30}\bmanual/.test(t)
    // Unambiguous failure of the action this memo is supposed to encode.
    || /\b(?:could not|couldn't|cannot|can't|unable to|failed to)\s+(?:deploy|publish|run|send|create|upload|complete|execute|connect|authenticate)/.test(t)
    || /\b(?:was|were|got) (?:blocked|refused|rejected|denied)\b/.test(t)
  );
}

export function rememberToolChoice(input: RememberToolChoiceInput): ToolChoiceRecord {
  ensureCanonicalMigration();
  const existing = parseRecord(filePathFor(input.intent));
  const now = new Date().toISOString();
  if (placeholderChoiceString(input.choice.identifier)) {
    const saved = writeRecord({
      intent: input.intent,
      description: input.description ?? existing?.description,
      choice: existing?.choice ?? null,
      fallbacks: existing?.fallbacks ?? [],
      body: input.body ?? existing?.body ?? defaultBodyFor(input.intent, input.description ?? existing?.description),
      filePath: existing?.filePath,
      procedureId: existing?.procedureId,
      procedureKey: existing?.procedureKey,
      aliasStatus: existing?.aliasStatus,
    });
    emitToolChoiceEvent('remember_rejected_failed', input.intent, 'placeholder');
    return saved;
  }
  // Write-back guard (2026-06-21 poisoned-memo class): if the model's OWN
  // evidence/description says this attempt was BLOCKED by a gate or FAILED, never
  // promote it to the active proven choice. Record it as a fallback (preserving
  // the "what was tried" history) and KEEP any existing proven choice — so recall
  // surfaces the real working memo (or triggers clean rediscovery), never "must
  // run manually". General + code-level; emits its own telemetry action.
  if (evidenceLooksFailedOrBlocked(input.choice.testEvidence) || evidenceLooksFailedOrBlocked(input.description)) {
    const reason = (input.choice.testEvidence || input.description || 'attempt blocked/failed').slice(0, 300);
    const failedFallback: ToolChoiceRecordFallback = {
      kind: input.choice.kind,
      identifier: input.choice.identifier,
      failedAt: now,
      reason,
    };
    const saved = writeRecord({
      intent: input.intent,
      description: input.description ?? existing?.description,
      // Keep an EXISTING proven choice; never overwrite it with a failure. If
      // none exists, leave choice null so recall won't serve a poisoned path.
      choice: existing?.choice ?? null,
      fallbacks: mergeFallbacks(existing?.fallbacks ?? [], [failedFallback]),
      body: input.body ?? existing?.body ?? defaultBodyFor(input.intent, input.description ?? existing?.description),
      filePath: existing?.filePath,
      procedureId: existing?.procedureId,
      procedureKey: existing?.procedureKey,
      aliasStatus: existing?.aliasStatus,
    });
    emitToolChoiceEvent('remember_rejected_failed', input.intent, input.choice.identifier);
    return saved;
  }
  const merged = mergeFallbacks(existing?.fallbacks ?? [], input.fallbacks ?? []);
  // Thread 2: carry the outcome track record forward when re-remembering the
  // SAME tool (a re-validation shouldn't wipe its history); reset when the
  // identifier changes (a different tool earns a fresh record).
  const prev = existing?.choice;
  const samePath = prev && prev.kind === input.choice.kind && prev.identifier === input.choice.identifier;
  const choice: ToolChoiceRecordChoice = {
    kind: input.choice.kind,
    identifier: input.choice.identifier.trim(),
    invocationTemplate: cleanInvocationTemplate(input.choice.invocationTemplate),
    // Learn the mailbox: a new valid email wins; else keep the one this same
    // slug last used (re-validating the intent must not forget its mailbox).
    accountIdentity: parseAccountIdentity(input.choice.accountIdentity) ?? (samePath ? prev.accountIdentity : undefined),
    testedAt: input.choice.testedAt ?? now,
    testEvidence: input.choice.testEvidence,
    ...(samePath ? {
      successCount: prev.successCount,
      failureCount: prev.failureCount,
      approvalCount: prev.approvalCount,
      rejectionCount: prev.rejectionCount,
      lastSuccessAt: prev.lastSuccessAt,
      lastFailureAt: prev.lastFailureAt,
    } : {}),
  };
  const identity = canonicalToolProcedureIdentity({
    intent: input.intent,
    choice,
    operationHash: input.operationHash,
  });
  if (existing?.procedureId && existing.procedureId !== identity.procedureId) {
    markCanonicalAliasStatus(
      existing.procedureId,
      input.intent,
      'superseded',
      `Intent now resolves to ${identity.procedureId} (${choice.kind}:${choice.identifier}).`,
    );
  }
  const source = input.aliasSource ?? 'manual';
  const aliases: ToolProcedureAlias[] = [{
    intent: input.intent,
    description: input.description ?? existing?.description,
    status: 'active',
    source,
    firstSeenAt: existing?.choice?.testedAt ?? now,
    lastSeenAt: now,
    legacyFilePath: existing?.filePath ?? filePathFor(input.intent),
  }];
  for (const aliasInput of input.aliases ?? []) {
    const aliasIntent = typeof aliasInput === 'string' ? aliasInput : aliasInput.intent;
    const trimmed = aliasIntent.trim();
    if (!trimmed || slugifyIntent(trimmed) === slugifyIntent(input.intent)) continue;
    aliases.push({
      intent: trimmed,
      status: typeof aliasInput === 'string' ? 'active' : (aliasInput.status ?? 'active'),
      source: typeof aliasInput === 'string' ? source : (aliasInput.source ?? source),
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }
  const procedure = upsertCanonicalProcedure({
    identity,
    choice,
    aliases,
    fallbacks: merged,
    evidence: [{
      evidenceId: `ev_${randomUUID()}`,
      at: now,
      type: 'remember',
      intent: input.intent,
      text: input.choice.testEvidence ?? input.description,
    }],
    now,
  });
  const saved = writeRecord({
    intent: input.intent,
    description: input.description ?? existing?.description,
    // Retain the choice in the legacy alias file for backwards compatibility;
    // canonical reads overlay it from the procedure file.
    choice: procedure.choice,
    fallbacks: merged,
    body: input.body ?? existing?.body ?? defaultBodyFor(input.intent, input.description ?? existing?.description),
    filePath: existing?.filePath,
    procedureId: identity.procedureId,
    procedureKey: identity.procedureKey,
    aliasStatus: 'active',
    aliases: procedure.aliases,
  });
  emitToolChoiceEvent('remember', input.intent, choice.identifier);
  return saved;
}

function mergeFallbacks(
  existing: ToolChoiceRecordFallback[],
  incoming: ToolChoiceRecordFallback[],
): ToolChoiceRecordFallback[] {
  const seen = new Set<string>();
  const out: ToolChoiceRecordFallback[] = [];
  const key = (f: ToolChoiceRecordFallback) => `${f.kind}:${f.identifier}:${f.reason}`;
  for (const arr of [existing, incoming]) {
    for (const f of arr) {
      const k = key(f);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}

/**
 * Invalidate the current choice for an intent.
 *
 * Moves the active choice into `fallbacks` with the supplied reason,
 * then clears `choice`. The next `recallToolChoice` for this intent
 * still finds the file (so the fallbacks history is preserved and the
 * caller knows what's been tried) but `choice` is null — the
 * Orchestrator's pre-flight will see that and trigger fresh discovery.
 *
 * Returns the updated record, or null if no record existed.
 */
export function invalidateToolChoice(
  intent: string,
  reason: string,
  opts: { automatic?: boolean } = {},
): ToolChoiceRecord | null {
  ensureCanonicalMigration();
  const existing = parseRecord(filePathFor(intent));
  if (!existing) return null;
  // Idempotent: already invalidated (choice null) → no-op success, no re-emit.
  // This makes a manual invalidate after the automatic one (or vice-versa) a
  // clean no-op instead of double-counting / re-writing.
  if (!existing.choice) return existing;
  const now = new Date().toISOString();
  const newFallbacks = [
    ...existing.fallbacks,
    {
      kind: existing.choice.kind,
      identifier: existing.choice.identifier,
      failedAt: now,
      reason,
    } as ToolChoiceRecordFallback,
  ];
  const invalidatedIdentifier = existing.choice.identifier;
  if (existing.procedureId) {
    const procedure = parseProcedure(procedureFilePath(existing.procedureId));
    if (procedure?.choice) {
      const updatedAt = new Date().toISOString();
      const updatedProcedure = writeProcedure({
        ...procedure,
        choice: null,
        fallbacks: mergeFallbacks(procedure.fallbacks, newFallbacks),
        evidence: mergeProcedureEvidence(procedure.evidence, [{
          evidenceId: `ev_${randomUUID()}`,
          at: updatedAt,
          type: 'outcome',
          intent,
          text: reason,
        }]),
        updatedAt,
      });
      // Mirror inactivity into every linked legacy alias so a future process
      // cannot re-promote stale embedded choices during migration.
      const dir = machineDir();
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.md')) continue;
          const raw = parseRecordRaw(path.join(dir, name));
          if (!raw || raw.procedureId !== existing.procedureId) continue;
          writeRecord({
            ...raw,
            choice: null,
            fallbacks: mergeFallbacks(raw.fallbacks, newFallbacks),
            filePath: raw.filePath,
          });
        }
      }
      emitToolChoiceEvent(opts.automatic ? 'auto_invalidate' : 'invalidate', intent, invalidatedIdentifier);
      return { ...existing, choice: null, fallbacks: updatedProcedure.fallbacks };
    }
  }
  const updated = writeRecord({
    intent: existing.intent,
    description: existing.description,
    choice: null,
    fallbacks: newFallbacks,
    body: existing.body,
    filePath: existing.filePath,
  });
  // Split the telemetry action so background self-correction (automatic) is
  // visible to operators WITHOUT skewing the recall-hit-rate metric that the
  // agent-behavior `invalidate` feeds.
  emitToolChoiceEvent(opts.automatic ? 'auto_invalidate' : 'invalidate', intent, invalidatedIdentifier);
  return updated;
}

/**
 * Non-emitting read of a tool-choice record (no recall telemetry). For internal
 * callers (e.g. additive auto-commit) that must check whether an active choice
 * already exists WITHOUT firing a recall_hit/recall_miss event and skewing the
 * north-star recall-hit-rate metric.
 */
export function peekToolChoice(intent: string): ToolChoiceRecord | null {
  ensureCanonicalMigration();
  return parseRecord(filePathFor(intent));
}

/**
 * HARD-delete a tool-choice record (unlink the markdown file) — a TRUE clear.
 *
 * Unlike `invalidateToolChoice` (which keeps the file with choice=null, so it
 * is still fuzzy-matchable by recall and can be silently re-poisoned by
 * auto-remember filling the null slot), this removes the record entirely so the
 * next request re-discovers from scratch. Returns true if a file was removed.
 * (v0.5.64 — gives the agent/user a real "forget what you learned" affordance
 * so a poisoned choice no longer requires hand-deleting files.)
 */
export function deleteToolChoice(intent: string): boolean {
  try {
    ensureCanonicalMigration();
    const fp = filePathFor(intent);
    const raw = parseRecordRaw(fp);
    let procedureId = raw?.procedureId;
    let removed = false;
    if (existsSync(fp)) {
      unlinkSync(fp);
      removed = true;
    }
    if (!procedureId) {
      const procedure = listToolProcedures().find((candidate) => candidate.aliases.some(
        (alias) => slugifyIntent(alias.intent) === slugifyIntent(intent),
      ));
      procedureId = procedure?.procedureId;
    }
    if (procedureId) {
      const procedure = parseProcedure(procedureFilePath(procedureId));
      if (procedure) {
        const aliases = procedure.aliases.filter((alias) => slugifyIntent(alias.intent) !== slugifyIntent(intent));
        const hasRoutableAlias = aliases.some((alias) => alias.status === 'active' && alias.source !== 'native_mcp');
        if (!hasRoutableAlias) {
          if (existsSync(procedure.filePath)) unlinkSync(procedure.filePath);
        } else {
          writeProcedure({ ...procedure, aliases, updatedAt: new Date().toISOString() });
        }
        removed = true;
      }
    }
    if (!removed) return false;
    emitToolChoiceEvent('forget', intent);
    return true;
  } catch {
    return false; // best-effort — a forget failure must never throw to a tool call
  }
}

/**
 * Forget every tool-choice whose intent matches `pattern` (case-insensitive
 * substring on the raw intent OR its slug). Returns the forgotten intents.
 * Used to clear a poisoned CLUSTER in one call (e.g. every `outlook send` /
 * `mark read` choice) instead of one intent at a time.
 */
export function forgetMatching(pattern: string): string[] {
  const needle = pattern.trim().toLowerCase();
  if (!needle) return [];
  const needleSlug = slugifyIntent(needle);
  const forgotten: string[] = [];
  const intents = new Set<string>();
  for (const rec of listToolChoiceAliases()) intents.add(rec.intent);
  for (const procedure of listToolProcedures()) for (const alias of procedure.aliases) intents.add(alias.intent);
  for (const intent of intents) {
    const matches = intent.toLowerCase().includes(needle)
      || (needleSlug.length > 0 && slugifyIntent(intent).includes(needleSlug));
    if (matches && deleteToolChoice(intent)) forgotten.push(intent);
  }
  return forgotten;
}

/** Every historical intent-alias file, including duplicates and inactive rows.
 * Most production consumers should use listToolChoices(), which projects one
 * record per canonical procedure. */
export function listToolChoiceAliases(): ToolChoiceRecord[] {
  ensureCanonicalMigration();
  const dir = machineDir();
  if (!existsSync(dir)) return [];
  const out: ToolChoiceRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const rec = parseRecord(path.join(dir, f));
    if (rec) out.push(rec);
  }
  return out;
}

export function listToolProcedures(): ToolProcedureRecord[] {
  ensureCanonicalMigration();
  const dir = procedureMachineDir();
  if (!existsSync(dir)) return [];
  const out: ToolProcedureRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const procedure = parseProcedure(path.join(dir, name));
    if (procedure) out.push(procedure);
  }
  return out;
}

function preferredProcedureAlias(procedure: ToolProcedureRecord): ToolProcedureAlias | undefined {
  const rank: Record<ToolProcedureAliasSource, number> = {
    manual: 0,
    composio_search: 1,
    synthetic: 2,
    migration: 3,
    native_mcp: 4,
  };
  const active = procedure.aliases.filter((alias) => alias.status === 'active');
  const nonWorkflow = active.filter((alias) => !alias.intent.startsWith(WORKFLOW_PIN_INTENT_PREFIX));
  return [...(nonWorkflow.length > 0 ? nonWorkflow : active)]
    .sort((a, b) => rank[a.source] - rank[b.source] || b.lastSeenAt.localeCompare(a.lastSeenAt))[0]
    ?? procedure.aliases[0];
}

function projectProcedure(procedure: ToolProcedureRecord): ToolChoiceRecord {
  const alias = preferredProcedureAlias(procedure);
  const intent = alias?.intent ?? `${procedure.provider}.${procedure.operationHash}`;
  const hasActiveAlias = procedure.aliases.some((candidate) => candidate.status === 'active');
  return {
    intent,
    description: alias?.description,
    // A superseded-only procedure remains inspectable as history but is not an
    // active retrieval/ranking candidate.
    choice: hasActiveAlias ? procedure.choice : null,
    fallbacks: procedure.fallbacks,
    body: `# Canonical procedure — \`${intent}\`\n`,
    filePath: procedure.filePath,
    procedureId: procedure.procedureId,
    procedureKey: procedure.procedureKey,
    aliasStatus: alias?.status,
    aliases: procedure.aliases,
  };
}

/** Semantic list: one row per reusable procedure, plus truly inactive legacy
 * records that have no procedure yet. This is the default for recall, prompts,
 * graph projection, curation, and workflow binding, so aliases do not inflate
 * rankings, counts, or prompt space. */
export function listToolChoices(): ToolChoiceRecord[] {
  const procedures = listToolProcedures().map(projectProcedure);
  const linked = new Set(procedures.map((record) => record.procedureId));
  const inactiveOrphans = listToolChoiceAliases()
    .filter((record) => !record.procedureId || !linked.has(record.procedureId))
    .map((record) => (
      record.aliasStatus === 'quarantined' || record.aliasStatus === 'superseded'
        ? { ...record, choice: null }
        : record
    ));
  return [...procedures, ...inactiveOrphans];
}

// ─────────────────────────────────────────────────────────────────
// Author-time binding — match a workflow STEP PROMPT to the proven
// tool-choices the user has already taught Clem, so authoring bakes the
// concrete command into the step instead of leaving it generic (which lets
// the runtime agent re-decide and drift onto a stale/expired path).
//
// Scoring note: `jaccardOverlap` (used by recallToolChoice) compares two
// SLUGS of similar size. A step prompt is a long sentence and a choice's
// distinctive tokens are few — jaccard would score that near zero. So we use
// CONTAINMENT: of the choice's distinctive tokens, what fraction appear in the
// prompt. We also require at least one matched token to come from the choice's
// CORE identity (intent slug / identifier), not just its description, so an
// incidental description word can't trigger a bind.
// ─────────────────────────────────────────────────────────────────

/** Generic verbs/nouns that must never, on their own, anchor a step→choice
 *  match. Service/tool names (salesforce, airtable, firecrawl, sf, …) are NOT
 *  here — those are exactly the distinctive tokens we want to match on. */
// Two filter sets, applied differently:
//  - CORE (intent slug + identifier) keeps OPERATION tokens (query, list, soql,
//    update, …) because in a slug like `salesforce.cli.query` the operation IS
//    part of the tool's identity. It drops only true stopwords + tool-TYPE words
//    (cli/mcp/api) that never appear in a step prompt. A match then needs ≥2 of
//    these identity tokens (service + operation), so a lone service mention
//    ("the salesforce dashboard") never binds.
//  - CONTEXT (the free-text description) drops the broad generic set too, since
//    in prose those words are noise, not identity.
const STEP_MATCH_STOPWORDS = new Set<string>([
  'the', 'for', 'and', 'via', 'using', 'use', 'from', 'into', 'with', 'all', 'then',
  'this', 'that', 'each', 'about', 'your', 'their', 'a', 'an', 'of', 'to', 'in', 'on',
  'at', 'by', 'or', 'as', 'is', 'it', 'new', 'step', 'workflow',
  // tool-TYPE tokens describe HOW, not WHAT.
  'cli', 'mcp', 'composio', 'api', 'sdk', 'rest', 'graphql', 'tool', 'tools',
]);
const STEP_MATCH_GENERIC_TOKENS = new Set<string>([
  ...STEP_MATCH_STOPWORDS,
  // generic verbs/objects: noise inside a free-text DESCRIPTION (kept in CORE).
  'query', 'get', 'list', 'fetch', 'read', 'write', 'create', 'update', 'delete',
  'run', 'call', 'data', 'records', 'record', 'find', 'search', 'pull', 'fetching',
]);
const STEP_MATCH_WEAK_IDENTITY_TOKENS = new Set<string>([
  ...STEP_MATCH_GENERIC_TOKENS,
  // Common deliverable/prose nouns that show up in old auto-remembered
  // objectives. They can raise score, but must not be the only tool identity
  // anchor ("draft a summary" is not a DataForSEO backlinks-summary bind).
  'summary', 'summarize', 'digest', 'report', 'brief', 'audit', 'email', 'emails',
  'draft', 'drafts', 'message', 'messages', 'file', 'files', 'path', 'page',
  'content', 'parsing', 'native', 'server',
]);
const SHORT_TOOL_ALIASES: Record<string, string[]> = {
  sf: ['salesforce'],
  gh: ['github'],
};

/** Word-tokenize free text (a step prompt) into a lowercase set, dropping
 *  punctuation and very short tokens. (recall's `tokenize` only splits slugs
 *  on `._-/`, so it can't tokenize a sentence — this is the prose counterpart.) */
function wordTokens(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2),
  );
}

/** The IDENTITY portion of a CLI command — the program + subcommands BEFORE
 *  the first flag (`-x`/`--x`) or quoted/`=` argument. A tool's identity is
 *  `sf data query`, NOT its query string: ingesting argument VALUES let generic
 *  words leak into "core identity" (e.g. `LAST_N_DAYS:15` → "last"/"days"),
 *  which false-matched unrelated step prompts ("scrape posts from the last 14
 *  days" → the Salesforce SOQL choice). Non-CLI identifiers (composio/mcp) are
 *  bare identity slugs already, so they're used whole. */
function cliCommandHead(command: string): string {
  const parts = command.trim().split(/\s+/);
  const keep: string[] = [];
  for (const raw of parts) {
    const token = raw.trim();
    if (!token) continue;
    if (/^(?:&&|\|\||\||;)$/.test(token)) break;
    if (/^-/.test(token)) break;
    if (/^["'`]/.test(token) || token.includes('=') || token.includes('{{') || token.includes('$(')) break;
    if (/^(?:\/|\.\/|\.\.\/)/.test(token)) break;
    keep.push(token);
  }
  return keep.join(' ');
}

function addExpandedToken(out: Set<string>, token: string): void {
  if (!token) return;
  out.add(token);
  for (const alias of SHORT_TOOL_ALIASES[token] ?? []) out.add(alias);
}

function validCallableMcpIdentifier(identifier: string): boolean {
  // Native MCP tools are callable names like `dataforseo__on_page_content_parsing`.
  // A few old memories accidentally stored prose/action sequences as kind:mcp
  // (`write_file(path=...) then browser_harness_run(...)`). Those are not valid
  // allowedTools entries and must never drive workflow binding/advisories.
  return /^[A-Za-z][A-Za-z0-9_-]*__[A-Za-z0-9][A-Za-z0-9_-]*$/.test(identifier.trim());
}

function mcpNamespaceTokens(identifier: string): Set<string> {
  const namespace = identifier.trim().split('__')[0] ?? '';
  return wordTokens(namespace);
}

function choiceIdentityText(rec: ToolChoiceRecord): string {
  const choice = rec.choice;
  if (!choice) return '';
  if (choice.kind === 'cli') {
    const template = choice.invocationTemplate && !placeholderChoiceString(choice.invocationTemplate)
      ? choice.invocationTemplate
      : choice.identifier;
    return `${choice.identifier} ${cliCommandHead(template)}`;
  }
  return choice.identifier;
}

function cliHeadTokens(rec: ToolChoiceRecord): string[] {
  if (rec.choice?.kind !== 'cli') return [];
  const template = rec.choice.invocationTemplate && !placeholderChoiceString(rec.choice.invocationTemplate)
    ? rec.choice.invocationTemplate
    : rec.choice.identifier;
  return [...wordTokens(cliCommandHead(template))];
}

function cliProgramTokens(rec: ToolChoiceRecord): Set<string> {
  const [program] = cliHeadTokens(rec);
  const out = new Set<string>();
  if (program) addExpandedToken(out, program);
  return out;
}

const CLI_IGNORED_OPERATION_TOKENS = new Set<string>(['data']);
const CLI_OPERATION_SYNONYMS: Record<string, string[]> = {
  query: ['query', 'queries', 'pull', 'pulls', 'fetch', 'fetches', 'list', 'lists', 'find', 'finds', 'search', 'searches', 'get', 'gets', 'retrieve', 'retrieves', 'lookup', 'lookups'],
  create: ['create', 'creates', 'add', 'adds', 'insert', 'inserts', 'upsert', 'upserts'],
  update: ['update', 'updates', 'upsert', 'upserts', 'patch', 'patches', 'set', 'sets'],
  deploy: ['deploy', 'deploys', 'publish', 'publishes', 'release', 'releases'],
  read: ['read', 'reads', 'inspect', 'inspects', 'check', 'checks', 'get', 'gets'],
  display: ['display', 'displays', 'show', 'shows', 'get', 'gets', 'read', 'reads'],
};

function cliOperationTokens(rec: ToolChoiceRecord): Set<string> {
  const tokens = cliHeadTokens(rec).slice(1);
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.length < 3 || STEP_MATCH_STOPWORDS.has(t) || CLI_IGNORED_OPERATION_TOKENS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function promptMatchesCliOperation(prompt: Set<string>, promptText: string, rec: ToolChoiceRecord): boolean {
  const ops = cliOperationTokens(rec);
  if (ops.size === 0) return true;
  for (const op of ops) {
    if (op === 'query') {
      if (cliChoiceLooksCountQuery(rec) && promptLooksCountQuery(promptText)) return true;
      if (prompt.has('query') || prompt.has('queries') || prompt.has('soql')) return true;
      // Broad words like "find" and "list" are common in planning prose. Accept
      // them for a query command only when the step also explicitly scopes the
      // action to a CLI, e.g. "using the Salesforce CLI, fetch...".
      if (prompt.has('cli')) {
        for (const synonym of CLI_OPERATION_SYNONYMS.query ?? []) {
          if (synonym !== 'query' && synonym !== 'queries' && prompt.has(synonym)) return true;
        }
      }
      continue;
    }
    if (prompt.has(op)) return true;
    for (const synonym of CLI_OPERATION_SYNONYMS[op] ?? []) {
      if (prompt.has(synonym)) return true;
    }
  }
  return false;
}

function cliChoiceLooksCountQuery(rec: ToolChoiceRecord): boolean {
  if (rec.choice?.kind !== 'cli') return false;
  const text = `${rec.intent}\n${rec.choice.invocationTemplate ?? ''}`;
  return /\bcount(?:_|\b)|\bcount\s*\(/i.test(text);
}

function promptLooksCountQuery(promptText: string): boolean {
  const text = promptText.toLowerCase();
  return (
    /\b(?:count|total)\s+(?:the\s+)?(?:salesforce\s+)?(?:accounts?|records?|prospects?|contacts?|opportunities?)\b/.test(text)
    || /\bhow many\s+(?:salesforce\s+)?(?:accounts?|records?|prospects?|contacts?|opportunities?)\b/.test(text)
    || /\bselect\s+count\s*\(/.test(text)
  );
}

function identityChoiceTokens(rec: ToolChoiceRecord): Set<string> {
  const raw = wordTokens(choiceIdentityText(rec));
  const out = new Set<string>();
  for (const t of raw) {
    if (t.length < 2 || STEP_MATCH_STOPWORDS.has(t)) continue;
    if (t.length >= 3 || SHORT_TOOL_ALIASES[t]) addExpandedToken(out, t);
  }
  return out;
}

function intentChoiceTokens(rec: ToolChoiceRecord): Set<string> {
  const out = new Set<string>();
  const intents = rec.aliases?.length
    ? rec.aliases
      .filter((alias) => alias.status === 'active'
        && alias.source !== 'native_mcp'
        && !alias.intent.startsWith(WORKFLOW_PIN_INTENT_PREFIX))
      .map((alias) => alias.intent)
    : [rec.intent];
  for (const intent of intents) {
    for (const t of tokenize(slugifyIntent(intent))) {
      if (t.length >= 3 && !STEP_MATCH_STOPWORDS.has(t)) out.add(t);
    }
  }
  return out;
}

/** CORE identity tokens of a choice: its intent slug + the command-HEAD of its
 *  identifier (program + subcommands only — NOT argument values), keeping
 *  operation tokens (query/list/soql/…) and dropping only stopwords + tool-type
 *  words. A match needs ≥2 of these (service + operation), so a lone service
 *  mention — or an incidental shared argument-value word — can't bind. */
function coreChoiceTokens(rec: ToolChoiceRecord): Set<string> {
  return new Set<string>([
    ...intentChoiceTokens(rec),
    ...identityChoiceTokens(rec),
  ]);
}

/** CONTEXT tokens of a choice: its description words, minus generics. Used to
 *  raise confidence but never sufficient alone to anchor a match. */
function contextChoiceTokens(rec: ToolChoiceRecord): Set<string> {
  const aliasContext = rec.aliases
    ?.filter((alias) => alias.status === 'active' && alias.source === 'native_mcp')
    .map((alias) => alias.intent)
    .join(' ') ?? '';
  const raw = wordTokens(`${rec.description ?? ''} ${aliasContext}`);
  const out = new Set<string>();
  for (const t of raw) if (t.length >= 3 && !STEP_MATCH_GENERIC_TOKENS.has(t)) out.add(t);
  return out;
}

export type StepToolChoiceTier = 'high' | 'medium';

export interface StepToolChoiceMatch {
  intent: string;
  procedureId?: string;
  kind: ToolChoiceKind;
  identifier: string;
  invocationTemplate?: string;
  /** Containment score in [0,1]: distinctive choice tokens present in the prompt. */
  score: number;
  tier: StepToolChoiceTier;
  /** Distinctive tokens of the choice that were found in the step prompt. */
  matched: string[];
  /** The step prompt already embeds this choice's identifier/command — never re-bind. */
  alreadyBound: boolean;
  /** Whether this choice may be AUTO-bound (deterministic) vs ADVISE-only.
   *  Only proven `cli`/`mcp` choices auto-bind; `composio` (identifier/connection
   *  rot-prone, see stripBakedConnectionId) is always advise-only. */
  autoBindable: boolean;
  /** The `allowedTools` family this step should be locked to when bound. */
  family: string[];
  /** The concrete command/tool to bake into the bound step prompt. */
  command: string;
}

export interface MatchToolChoicesOptions {
  limit?: number;
  /** Override the store read (tests). */
  choices?: ToolChoiceRecord[];
}

/** Rank: lower = preferred. On a near-tie prefer cli/mcp over composio — routes
 *  around a poisoned/mislabeled composio choice when a clean cli/mcp one exists. */
function choiceKindRank(kind: ToolChoiceKind): number {
  return kind === 'cli' ? 0 : kind === 'mcp' ? 1 : 2;
}

/** Does the prompt already embed this choice's concrete path? Uses whole-word
 *  matching for short identifiers so a 2-char command like `sf` is NOT counted
 *  as bound merely because it's a substring of "sale**sf**orce". */
function promptAlreadyBinds(promptText: string, choice: ToolChoiceRecordChoice): boolean {
  const lower = promptText.toLowerCase();
  const words = wordTokens(promptText);
  const id = (choice.identifier ?? '').toLowerCase();
  // A distinctive identifier (≥5 chars, e.g. an mcp tool name) can match as a
  // substring; a short one (sf, gh) must appear as a STANDALONE word.
  if (id.length >= 5 && lower.includes(id)) return true;
  if (id && words.has(id)) return true;
  const tmpl = choice.invocationTemplate?.trim();
  if (tmpl) {
    const head = tmpl.split(/\s+/)[0]?.toLowerCase();
    if (head && words.has(head)) return true; // command head as a standalone word
    const slice = tmpl.slice(0, 24).toLowerCase();
    if (slice.length >= 8 && lower.includes(slice)) return true; // embedded command
  }
  return false;
}

/**
 * Match a workflow step prompt against the user's active remembered tool-choices.
 * Returns the strongest matches (capped), each tagged with a confidence tier and
 * whether it may be auto-bound. Pure apart from reading the tool-choice store.
 */
export function matchToolChoicesForStep(
  promptText: string,
  opts: MatchToolChoicesOptions = {},
): StepToolChoiceMatch[] {
  const limit = opts.limit ?? 3;
  const prompt = wordTokens(promptText);
  if (prompt.size === 0) return [];

  let records: ToolChoiceRecord[];
  try {
    records = (opts.choices ?? listToolChoices()).filter((r) => !r.intent.startsWith(WORKFLOW_PIN_INTENT_PREFIX));
  } catch {
    return [];
  }

  // Don't auto-bind/advise a NET-NEGATIVE remembered choice onto a step — a broken-
  // but-not-yet-streak-invalidated tool (e.g. 2 failures / 0 wins, score < floor, but
  // < the 3-loss auto-invalidate streak) would otherwise keep resurfacing here. The
  // advertised context block already drops these (renderToolChoicesForContext); recall
  // and step-match did not, so a shaky tool kept getting bound. Same empty-pool guard:
  // if filtering leaves no active choice, keep the unfiltered set (rediscovery still
  // works via the token gates below, just without the score veto).
  if (isProceduralOutcomesEnabled()) {
    const filtered = records.filter((r) => !r.choice || computeChoiceScore(r.choice) >= TOOL_CHOICE_SCORE_FLOOR);
    if (filtered.some((r) => r.choice)) records = filtered;
  }

  const out: StepToolChoiceMatch[] = [];
  for (const rec of records) {
    if (!rec.choice) continue; // inactive (invalidated, not yet rediscovered)
    if (placeholderChoiceString(rec.choice.identifier)) continue;
    if (rec.choice.kind === 'mcp' && !validCallableMcpIdentifier(rec.choice.identifier)) continue;
    const identity = identityChoiceTokens(rec);
    if (identity.size === 0) continue;
    const core = coreChoiceTokens(rec);
    if (core.size === 0) continue;
    const matchedIdentity = [...identity].filter((t) => prompt.has(t));
    const hasStrongIdentity = matchedIdentity.some((t) => !STEP_MATCH_WEAK_IDENTITY_TOKENS.has(t));
    const matchedMcpNamespace = rec.choice.kind === 'mcp'
      ? [...mcpNamespaceTokens(rec.choice.identifier)].filter((t) => prompt.has(t))
      : [];
    const matchedCore = [...core].filter((t) => prompt.has(t));
    const alreadyBound = promptAlreadyBinds(promptText, rec.choice);

    // Precision: an embedded command is the strongest possible signal → always a
    // match (the consumer skips it as already-bound). Otherwise require at least
    // TWO CORE identity tokens (typically service + operation, e.g. "salesforce"
    // AND "query") and a concrete tool-identity anchor — so broad old objective
    // prose ("email audit", "summary") cannot bind unrelated tools.
    if (!alreadyBound) {
      if (matchedIdentity.length === 0) continue;
      if (!hasStrongIdentity) continue;
      if (rec.choice.kind === 'mcp' && matchedMcpNamespace.length === 0) continue;
      if (rec.choice.kind === 'cli') {
        const matchedProgram = [...cliProgramTokens(rec)].some((t) => prompt.has(t));
        if (!matchedProgram) continue;
        if (!promptMatchesCliOperation(prompt, promptText, rec)) continue;
        if (cliChoiceLooksCountQuery(rec) && !promptLooksCountQuery(promptText)) continue;
      }
      if (matchedCore.length < 2) continue;
      if (!matchedCore.some((t) => t.length >= 4)) continue;
    }
    // Containment score (for ranking only): how much of the choice's identity +
    // description the prompt names. Description tokens only raise/lower the
    // score; they never gate a match (that's the core-count rule above).
    const distinctive = new Set<string>([...core, ...contextChoiceTokens(rec)]);
    const matchedDistinctive = [...distinctive].filter((t) => prompt.has(t));
    const score = alreadyBound ? 1 : matchedDistinctive.length / distinctive.size;

    out.push({
      intent: rec.intent,
      procedureId: rec.procedureId,
      kind: rec.choice.kind,
      identifier: rec.choice.identifier,
      invocationTemplate: rec.choice.invocationTemplate,
      score,
      // HIGH (auto-bind candidate) = ≥2 core identity tokens named (or an
      // already-embedded command). cli/mcp at HIGH auto-bind; composio advises.
      tier: alreadyBound || matchedCore.length >= 2 ? 'high' : 'medium',
      matched: matchedDistinctive,
      alreadyBound,
      autoBindable: rec.choice.kind === 'cli' || rec.choice.kind === 'mcp',
      family: toolFamilyForChoice(rec.choice),
      command: boundCommandForChoice(rec.choice),
    });
  }

  out.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.08) return b.score - a.score;
    return choiceKindRank(a.kind) - choiceKindRank(b.kind);
  });
  return out.slice(0, limit);
}

export interface RememberedComposioMatch {
  /** The remembered Composio slug (e.g. APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS). */
  slug: string;
  /** The stored intent whose tokens matched (the strongest representative). */
  intent: string;
  invocationTemplate?: string;
  /** Aggregate success count across EVERY stored intent that maps to this slug. */
  successCount: number;
  /** Distinctive choice tokens found in the search query. */
  matched: string[];
  /** The mailbox identity (email) this slug last used, when EVERY stored
   *  fragment for the slug agrees. Dropped (undefined) on disagreement so the
   *  consumer treats it as ambiguous → ASK rather than picking a stale mailbox. */
  accountIdentity?: string;
  /** Exact canonical procedure selected by memory. */
  procedureId?: string;
}

/**
 * The DISCOVERY-TAX killer: given a natural-language composio_search_tools query,
 * return the CONFIDENT remembered Composio slug(s) so the search can short-circuit
 * instead of re-running a 4-5-call API discovery loop for a task family that has
 * run many times before.
 *
 * Why a dedicated matcher (not recallToolChoice or matchToolChoicesForStep):
 *  - recallToolChoice uses jaccard over SLUGS with a 0.5 floor + strictly-beat-the-
 *    runner-up guard. Auto-remember keys each record by the SEARCH QUERY, so one
 *    slug fragments across many near-duplicate intents ("apify run actor facebook
 *    page posts scraper …" × 4). A prose query jaccards below 0.5 AND the fragments
 *    tie → recall MISSES. (Live 2026-07-08: recall was called, still missed.)
 *  - matchToolChoicesForStep gates on the choice's IDENTITY tokens = the SLUG
 *    (APIFY_RUN_ACTOR_…), which never contains the domain words ("facebook") → also
 *    misses for composio.
 * This matcher scores the query against each choice's INTENT tokens (which DO carry
 * the domain words), AGGREGATES by slug (fragments reinforce instead of tie), and
 * excludes net-negative procedures. Confidence: ≥2 distinctive tokens incl. a strong
 * (non-weak) anchor, OR the query names the slug's toolkit prefix. Pure apart from
 * reading the store.
 */
export function recallComposioForSearch(
  query: string,
  opts: { choices?: ToolChoiceRecord[]; limit?: number } = {},
): RememberedComposioMatch[] {
  const q = wordTokens(query);
  if (q.size === 0) return [];
  let records: ToolChoiceRecord[];
  try {
    records = (opts.choices ?? listToolChoices()).filter((r) => !r.intent.startsWith(WORKFLOW_PIN_INTENT_PREFIX));
  } catch {
    return [];
  }
  const outcomesOn = isProceduralOutcomesEnabled();

  type Agg = {
    best: RememberedComposioMatch;
    totalSuccess: number;
    bestMatched: number;
    identities: Set<string>;
    procedureIds: Set<string>;
  };
  const bySlug = new Map<string, Agg>();
  for (const rec of records) {
    const c = rec.choice;
    if (!c || c.kind !== 'composio') continue;
    if (placeholderChoiceString(c.identifier)) continue;
    // Never short-circuit onto a net-negative (broken) remembered path.
    if (outcomesOn && computeChoiceScore(c) < TOOL_CHOICE_SCORE_FLOOR) continue;

    // Distinctive tokens live in intent ALIASES (the search phrasings), not the
    // slug. Score every alias but count the canonical procedure only once.
    const aliasIntents = rec.aliases?.length
      ? rec.aliases
        .filter((alias) => alias.status === 'active' && !alias.intent.startsWith(WORKFLOW_PIN_INTENT_PREFIX))
        .map((alias) => alias.intent)
      : [rec.intent];
    let bestAliasIntent = rec.intent;
    let matched: string[] = [];
    for (const aliasIntent of aliasIntents) {
      const choiceTokens = new Set<string>();
      for (const t of wordTokens(aliasIntent)) {
        if (t.length >= 3 && !STEP_MATCH_GENERIC_TOKENS.has(t)) choiceTokens.add(t);
      }
      const aliasMatched = [...choiceTokens].filter((t) => q.has(t));
      if (aliasMatched.length > matched.length) {
        matched = aliasMatched;
        bestAliasIntent = aliasIntent;
      }
    }
    if (matched.length === 0) continue;
    const hasStrong = matched.some((t) => !STEP_MATCH_WEAK_IDENTITY_TOKENS.has(t));
    const toolkit = c.identifier.split('_')[0]?.toLowerCase() ?? '';
    const namesToolkit = toolkit.length >= 4 && q.has(toolkit);
    // Confident enough to SKIP live discovery: two distinctive domain tokens with a
    // strong anchor, or the query explicitly names the slug's toolkit.
    if (!((matched.length >= 2 && hasStrong) || namesToolkit)) continue;

    const successCount = (c.successCount ?? 0);
    const cand: RememberedComposioMatch = {
      slug: c.identifier,
      intent: bestAliasIntent,
      invocationTemplate: c.invocationTemplate,
      successCount,
      matched,
      procedureId: rec.procedureId,
    };
    const prev = bySlug.get(c.identifier);
    if (!prev) {
      bySlug.set(c.identifier, {
        best: cand,
        totalSuccess: successCount,
        bestMatched: matched.length,
        identities: new Set(c.accountIdentity ? [c.accountIdentity] : []),
        procedureIds: new Set(rec.procedureId ? [rec.procedureId] : []),
      });
    } else {
      prev.totalSuccess += successCount;
      if (matched.length > prev.bestMatched) { prev.best = cand; prev.bestMatched = matched.length; }
      if (c.accountIdentity) prev.identities.add(c.accountIdentity);
      if (rec.procedureId) prev.procedureIds.add(rec.procedureId);
    }
  }

  // Carry the mailbox identity ONLY when every stored fragment for the slug
  // agrees (one distinct email); disagreement → undefined → consumer must ASK.
  const results = [...bySlug.values()].map((a) => ({
    ...a.best,
    successCount: a.totalSuccess,
    accountIdentity: a.identities.size === 1 ? [...a.identities][0] : undefined,
    procedureId: a.procedureIds.size === 1 ? [...a.procedureIds][0] : undefined,
  }));
  results.sort((x, y) => (y.matched.length - x.matched.length) || (y.successCount - x.successCount));
  return results.slice(0, opts.limit ?? 3);
}

/**
 * Slug-keyed mailbox recall: the STABLE email identity every remembered choice
 * for this exact composio slug agrees on, else undefined (no memory, or the
 * mailboxes disagree → the consumer must ASK). Used at execute time to route a
 * multi-account toolkit to the mailbox this slug last used. Zero network.
 */
export function recallComposioAccountIdentity(slug: string): string | undefined {
  if (!slug) return undefined;
  let records: ToolChoiceRecord[];
  try { records = listToolChoices(); } catch { return undefined; }
  const identities = new Set<string>();
  for (const rec of records) {
    const c = rec.choice;
    if (!c || c.kind !== 'composio' || c.identifier !== slug) continue;
    if (c.accountIdentity) identities.add(c.accountIdentity);
  }
  return identities.size === 1 ? [...identities][0] : undefined;
}

/** The `allowedTools` family a step should be locked to when bound to a choice.
 *  cli → run_shell_command; mcp → the mcp tool name; composio → the slug. */
export function toolFamilyForChoice(choice: ToolChoiceRecordChoice): string[] {
  switch (choice.kind) {
    case 'cli':
      return ['run_shell_command'];
    case 'mcp':
      return [choice.identifier];
    case 'composio':
      return ['composio_execute_tool'];
    default:
      return [];
  }
}

/** The concrete, human-readable command/tool to bake into a bound step prompt. */
export function boundCommandForChoice(choice: ToolChoiceRecordChoice): string {
  if (choice.kind === 'mcp') {
    return placeholderChoiceString(choice.identifier) ? '' : choice.identifier;
  }
  if (choice.invocationTemplate && !placeholderChoiceString(choice.invocationTemplate)) {
    return choice.invocationTemplate.trim();
  }
  return placeholderChoiceString(choice.identifier) ? '' : choice.identifier;
}

// ─────────────────────────────────────────────────────────────────
// P2 — measured learning loop
// ─────────────────────────────────────────────────────────────────

/**
 * Emit a synthetic `tool_choice` telemetry event so the observatory can
 * compute a recall hit-rate over time (proving the north-star claim that
 * Clem "gets measurably better at your work"). Mirrors the `reflection`
 * synthetic-event pattern (observatory computeBrainHealth): toolName is a
 * stable label, the action + intent live in argsSummary for the reader to
 * parse. Always-on + best-effort: it's the measurement, and it must never
 * perturb a recall/remember path. The CONTEXT INJECTION (behavior change)
 * is what's flag-gated, not this measurement.
 */
type ToolChoiceAction = 'recall_hit' | 'recall_hit_fuzzy' | 'recall_miss' | 'remember' | 'remember_rejected_failed' | 'invalidate' | 'auto_invalidate' | 'forget' | 'outcome_pos' | 'outcome_neg';
function emitToolChoiceEvent(action: ToolChoiceAction, intent: string, identifier?: string): void {
  try {
    recordToolEvent({
      at: new Date().toISOString(),
      toolName: 'tool_choice',
      kind: 'read',
      phase: 'end',
      outcome: action === 'recall_miss' ? 'cancelled' : 'success',
      argsSummary: `action=${action} intent=${slugifyIntent(intent)}${identifier ? ` id=${identifier}` : ''}`,
    });
  } catch {
    /* telemetry is best-effort — never break a tool-choice operation */
  }
}

// ─────────────────────────────────────────────────────────────────
// Thread 2 — outcome-driven procedural memory
// ─────────────────────────────────────────────────────────────────

/** Outcome-driven procedural memory: record how a remembered tool path FARES
 *  (success/failure/approve/reject) and prefer proven paths over merely-recent
 *  ones, auto-retiring repeat failures. DEFAULT-ON (validated behavior → default,
 *  per the no-rollout-flags rule); set CLEMMY_PROCEDURAL_OUTCOMES=off to disable
 *  (kill-switch retained → byte-identical pre-outcome recency ordering + no-op
 *  recording). This is the learning loop's teeth: "route by learned success."
 *  Composio + approval outcomes already feed it (composio-tools.ts,
 *  approval-registry.ts); turning it on lights up both recording and ranking. */
export function isProceduralOutcomesEnabled(): boolean {
  return (process.env.CLEMMY_PROCEDURAL_OUTCOMES ?? 'on').toLowerCase() !== 'off';
}

export type ProceduralOutcome = 'success' | 'failure' | 'approved' | 'rejected';

/** A choice whose injected confidence is at/below this is net-negative — it has
 *  failed at least as often as it has worked — so it's dropped from injection
 *  (still on disk + recallable; the model can retry, but we stop advertising a
 *  broken procedure as "previously worked"). */
export const TOOL_CHOICE_SCORE_FLOOR = 0.34;
/** Auto-invalidate (→ rediscovery) after this many failures with no later win. */
const AUTO_INVALIDATE_FAILURE_STREAK = 3;

/** WS5 — confidence half-life (days). An unrevalidated choice's score decays
 *  toward the neutral prior over time, so a path that worked 8 months ago and
 *  was never re-exercised stops being injected as authoritatively "previously
 *  worked" and prompts a cheap re-probe. Default OFF until dev-smoke validates
 *  (per the no-rollout-flags discipline); flip CLEMMY_TOOL_CHOICE_DECAY=on. */
const TOOL_CHOICE_HALF_LIFE_DAYS = 90;
function toolChoiceDecayEnabled(): boolean {
  return (process.env.CLEMMY_TOOL_CHOICE_DECAY ?? 'off').trim().toLowerCase() === 'on';
}

/**
 * Laplace-smoothed success rate in (0,1). positives = success + approval;
 * negatives = failure + rejection. Prior 0.5 (one phantom win + one loss) so a
 * single observation can't peg the score to 0 or 1 — a freshly-learned choice
 * sits at the neutral prior until evidence accrues. When the (gated) age decay
 * is on, the score is additionally pulled toward 0.5 by time since last
 * validation, so stale confidence fades instead of persisting forever.
 */
export function computeChoiceScore(choice: ToolChoiceRecordChoice | null | undefined): number {
  if (!choice) return 0.5;
  const pos = (choice.successCount ?? 0) + (choice.approvalCount ?? 0);
  const neg = (choice.failureCount ?? 0) + (choice.rejectionCount ?? 0);
  const raw = (pos + 1) / (pos + neg + 2);
  if (!toolChoiceDecayEnabled()) return raw;
  const anchor = choice.lastSuccessAt || choice.testedAt;
  const anchorMs = anchor ? Date.parse(anchor) : NaN;
  if (!Number.isFinite(anchorMs)) return raw;
  const ageDays = (Date.now() - anchorMs) / 86_400_000;
  if (ageDays <= 0) return raw;
  const keep = Math.pow(0.5, ageDays / TOOL_CHOICE_HALF_LIFE_DAYS); // 1 → 0 with age
  return 0.5 + (raw - 0.5) * keep; // decays toward the neutral prior
}

function applyOutcome(choice: ToolChoiceRecordChoice, outcome: ProceduralOutcome, nowIso: string): ToolChoiceRecordChoice {
  const next = { ...choice };
  switch (outcome) {
    case 'success': next.successCount = (next.successCount ?? 0) + 1; next.lastSuccessAt = nowIso; break;
    case 'failure': next.failureCount = (next.failureCount ?? 0) + 1; next.lastFailureAt = nowIso; break;
    case 'approved': next.approvalCount = (next.approvalCount ?? 0) + 1; break;
    case 'rejected': next.rejectionCount = (next.rejectionCount ?? 0) + 1; break;
  }
  return next;
}

function mirrorProcedureToLegacyAliases(procedure: ToolProcedureRecord): void {
  const dir = machineDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const raw = parseRecordRaw(path.join(dir, name));
    if (!raw || raw.procedureId !== procedure.procedureId) continue;
    writeRecord({
      ...raw,
      choice: procedure.choice,
      fallbacks: mergeFallbacks(raw.fallbacks, procedure.fallbacks),
      filePath: raw.filePath,
    });
  }
}

function recordOutcomeOnProcedure(
  procedure: ToolProcedureRecord,
  outcome: ProceduralOutcome,
  intent?: string,
): ToolProcedureRecord | null {
  if (!procedure.choice) return null;
  const now = new Date().toISOString();
  const nextChoice = applyOutcome(procedure.choice, outcome, now);
  const saved = writeProcedure({
    ...procedure,
    choice: nextChoice,
    evidence: mergeProcedureEvidence(procedure.evidence, [{
      evidenceId: `ev_${randomUUID()}`,
      at: now,
      type: 'outcome',
      intent,
      text: outcome,
    }]),
    updatedAt: now,
  });
  mirrorProcedureToLegacyAliases(saved);
  const eventIntent = intent ?? preferredProcedureAlias(saved)?.intent ?? saved.procedureId;
  emitToolChoiceEvent(outcome === 'failure' || outcome === 'rejected' ? 'outcome_neg' : 'outcome_pos', eventIntent, nextChoice.identifier);

  // Auto-invalidate a path that's failing repeatedly with no later win, so the
  // next run rediscovers instead of re-treading a broken procedure.
  if (outcome === 'failure') {
    const failures = nextChoice.failureCount ?? 0;
    const winAfterLoss = nextChoice.lastSuccessAt && nextChoice.lastFailureAt
      ? nextChoice.lastSuccessAt > nextChoice.lastFailureAt
      : Boolean(nextChoice.lastSuccessAt);
    if (failures >= AUTO_INVALIDATE_FAILURE_STREAK && !winAfterLoss) {
      const aliasIntent = preferredProcedureAlias(saved)?.intent;
      const reason = `auto-invalidated after ${failures} failures with no later success`;
      const invalidated = aliasIntent ? invalidateToolChoice(
        aliasIntent,
        reason,
        { automatic: true },
      ) : null;
      if (invalidated) return parseProcedure(saved.filePath) ?? saved;
      // Synthetic-only canonical aliases have no legacy file to invalidate by
      // intent. Retire the physical procedure directly and retain the fallback.
      const fallback: ToolChoiceRecordFallback = {
        kind: nextChoice.kind,
        identifier: nextChoice.identifier,
        failedAt: now,
        reason,
      };
      const retired = writeProcedure({
        ...saved,
        choice: null,
        fallbacks: mergeFallbacks(saved.fallbacks, [fallback]),
        updatedAt: now,
      });
      mirrorProcedureToLegacyAliases(retired);
      emitToolChoiceEvent('auto_invalidate', eventIntent, nextChoice.identifier);
      return retired;
    }
  }
  return saved;
}

export function updateToolProcedureOutcome(
  procedureId: string,
  outcome: ProceduralOutcome,
  intent?: string,
): ToolProcedureRecord | null {
  if (!isProceduralOutcomesEnabled() || !procedureId) return null;
  ensureCanonicalMigration();
  const procedure = parseProcedure(procedureFilePath(procedureId));
  if (!procedure?.choice) return null;
  return recordOutcomeOnProcedure(procedure, outcome, intent);
}

/** Record exposure separately from usefulness. This field is intentionally not
 * consumed by computeChoiceScore or any ranking path. */
export function recordToolProcedureImpression(procedureId: string): ToolProcedureRecord | null {
  if (!procedureId) return null;
  ensureCanonicalMigration();
  const procedure = parseProcedure(procedureFilePath(procedureId));
  if (!procedure) return null;
  const now = new Date().toISOString();
  return writeProcedure({
    ...procedure,
    impressionCount: procedure.impressionCount + 1,
    lastImpressedAt: now,
    updatedAt: now,
  });
}

interface PendingToolProcedureUse {
  useId: string;
  procedureId: string;
  intent: string;
  sessionId?: string;
  createdAtMs: number;
}

const pendingProcedureUses = new Map<string, PendingToolProcedureUse>();
const PROCEDURE_USE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PROCEDURE_USES = 1_000;

function pruneProcedureUses(nowMs = Date.now()): void {
  for (const [useId, use] of pendingProcedureUses) {
    if (nowMs - use.createdAtMs > PROCEDURE_USE_TTL_MS) pendingProcedureUses.delete(useId);
  }
  while (pendingProcedureUses.size > MAX_PENDING_PROCEDURE_USES) {
    const oldest = pendingProcedureUses.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingProcedureUses.delete(oldest);
  }
}

/** Create a one-shot attribution handle for the exact procedure selected by
 * recall. Completing the handle credits only that procedure. */
export function beginToolProcedureUse(
  intent: string,
  sessionId?: string,
): { useId: string; procedureId: string } | null {
  ensureCanonicalMigration();
  const record = peekToolChoice(intent) ?? recallToolChoice(intent);
  if (!record?.choice || !record.procedureId) return null;
  return beginToolProcedureUseById(record.procedureId, record.intent, sessionId);
}

export function beginToolProcedureUseById(
  procedureId: string,
  intent: string,
  sessionId?: string,
): { useId: string; procedureId: string } | null {
  ensureCanonicalMigration();
  const procedure = parseProcedure(procedureFilePath(procedureId));
  if (!procedure?.choice) return null;
  pruneProcedureUses();
  const use: PendingToolProcedureUse = {
    useId: `tpu_${randomUUID()}`,
    procedureId,
    intent,
    sessionId,
    createdAtMs: Date.now(),
  };
  pendingProcedureUses.set(use.useId, use);
  return { useId: use.useId, procedureId: use.procedureId };
}

export function completeToolProcedureUse(
  useId: string,
  outcome: ProceduralOutcome,
): ToolProcedureRecord | null {
  pruneProcedureUses();
  const use = pendingProcedureUses.get(useId);
  if (!use) return null;
  pendingProcedureUses.delete(useId);
  return updateToolProcedureOutcome(use.procedureId, outcome, use.intent);
}

export function cancelToolProcedureUse(useId: string): boolean {
  return pendingProcedureUses.delete(useId);
}

export function _resetToolProcedureUsesForTests(): void {
  pendingProcedureUses.clear();
}

/**
 * Record an outcome for the active choice of an intent. No-op (returns null)
 * when the flag is off, the record is missing, or the choice is inactive.
 */
export function updateToolChoiceOutcome(intent: string, outcome: ProceduralOutcome): ToolChoiceRecord | null {
  if (!isProceduralOutcomesEnabled()) return null;
  ensureCanonicalMigration();
  const existing = parseRecord(filePathFor(intent));
  if (!existing || !existing.choice) return null;
  if (existing.procedureId) {
    const updated = updateToolProcedureOutcome(existing.procedureId, outcome, existing.intent);
    return updated ? projectProcedure(updated) : null;
  }
  return null;
}

/**
 * Resolve an execution identifier only when it maps to ONE canonical procedure.
 * Account/operation ambiguity returns null rather than broadcasting credit.
 */
export function resolveToolProcedureForIdentifier(
  identifier: string,
  opts: { kind?: ToolChoiceKind; accountIdentity?: string } = {},
): ToolProcedureRecord | null {
  if (!identifier) return null;
  const account = parseAccountIdentity(opts.accountIdentity);
  const candidates = listToolProcedures().filter((procedure) => {
    const choice = procedure.choice;
    if (!choice || choice.identifier !== identifier) return false;
    if (opts.kind && choice.kind !== opts.kind) return false;
    if (account && choice.accountIdentity !== account) return false;
    return procedure.aliases.some((alias) => alias.status === 'active');
  });
  return candidates.length === 1 ? candidates[0] : null;
}

/** Compatibility seam for callers that only know an identifier. It now credits
 * at most one unambiguous canonical procedure instead of every intent alias. */
export function updateToolChoiceOutcomeForIdentifier(identifier: string, outcome: ProceduralOutcome): number {
  if (!isProceduralOutcomesEnabled()) return 0;
  const procedure = resolveToolProcedureForIdentifier(identifier);
  if (!procedure) return 0;
  return recordOutcomeOnProcedure(procedure, outcome) ? 1 : 0;
}

/**
 * P2: inject remembered tool choices into the persistent context
 * block so the agent recalls a proven tool by READING, not only by
 * calling tool_choice_recall (which the prompt teaches but cannot
 * guarantee). Default ON with an escape hatch because this is now
 * budget-capped and per-machine.
 */
function contextInjectEnabled(): boolean {
  return (process.env.TOOL_CHOICE_CONTEXT_INJECT ?? 'on').toLowerCase() !== 'off';
}

/**
 * Render the most-relevant remembered tool choices as a compact context
 * block. Active choices only (an invalidated, not-yet-rediscovered choice
 * is noise here), most-recently-tested first, capped at `limit`. Returns
 * '' when the flag is off or nothing is remembered → no context change.
 *
 * Token-efficiency (north star): one tight line per choice, hard cap.
 */
// Per-line + whole-block caps so enabling context injection can't bloat the
// persistent prefix on every turn (the renderFactsForInstructions discipline:
// an explicit budget, not just a count). A long invocationTemplate is clipped,
// not dropped — the agent still sees the intent→tool mapping.
const TOOL_CHOICE_LINE_MAX = 160;
const TOOL_CHOICE_BLOCK_MAX = 1400;

export function renderToolChoicesForContext(limit = 12, maxChars = TOOL_CHOICE_BLOCK_MAX, objective?: string): string {
  if (!contextInjectEnabled()) return '';
  let records: ToolChoiceRecord[];
  try {
    records = listToolChoices().filter((r) => !r.intent.startsWith(WORKFLOW_PIN_INTENT_PREFIX));
  } catch {
    return '';
  }
  let activeRecords = records.filter((r) => r.choice);
  if (activeRecords.length === 0) return '';

  // Thread 2 / P3 — outcome weighting (flag-gated; off = byte-identical below).
  // Drop net-negative procedures from the ADVERTISED set (they remain on disk
  // and recallable — we just stop telling the model a broken path "worked").
  // If filtering would empty the pool, keep the unfiltered set rather than
  // advertise nothing.
  const outcomesOn = isProceduralOutcomesEnabled();
  if (outcomesOn) {
    const filtered = activeRecords.filter((r) => computeChoiceScore(r.choice) >= TOOL_CHOICE_SCORE_FLOOR);
    if (filtered.length > 0) activeRecords = filtered;
  }

  // Default ordering: most-recently-tested first (byte-identical to before).
  // With outcomes on, higher-confidence choices sort ahead of fresher-but-
  // unproven ones (recency breaks near-ties).
  const byRecency = [...activeRecords].sort((a, b) => {
    if (outcomesOn) {
      const sd = computeChoiceScore(b.choice) - computeChoiceScore(a.choice);
      if (Math.abs(sd) > 0.05) return sd;
    }
    return (b.choice!.testedAt ?? '').localeCompare(a.choice!.testedAt ?? '');
  });

  // P1-E — when the active objective is known, promote the choices RELEVANT to
  // it above pure recency so the model reuses the right remembered tool (e.g.
  // SALESFORCE_QUERY_RECORDS for a Salesforce-query task) instead of
  // re-discovering. Relevance uses the same matcher workflows use (≥2 core
  // identity tokens), so a lone service mention can't promote an unrelated
  // choice. The no-objective path is unchanged.
  let ordered = byRecency;
  const relevantIntents = new Set<string>();
  const trimmedObjective = objective?.trim();
  if (trimmedObjective) {
    try {
      const matches = matchToolChoicesForStep(trimmedObjective, {
        choices: byRecency,
        limit: byRecency.length,
      });
      for (const m of matches) relevantIntents.add(m.intent);
      if (relevantIntents.size > 0) {
        const relevant = byRecency.filter((r) => relevantIntents.has(r.intent));
        const rest = byRecency.filter((r) => !relevantIntents.has(r.intent));
        ordered = [...relevant, ...rest];
      }
    } catch {
      /* relevance ranking is best-effort; fall back to recency */
    }
  }

  const active = ordered.slice(0, limit);
  // FIT-VALIDATED reuse (2026-07-09): the store mixes tools from MANY past tasks
  // (an email task can surface an SEO tool that once ranked high on a different
  // job). A remembered tool is a HINT to verify, never a blind directive — so the
  // header tells the model to reuse only a line whose intent AND target resource
  // match the CURRENT task, and to ignore/rediscover otherwise. Reusing a tool
  // bound to a different job is worse than a quick rediscovery.
  const header = relevantIntents.size > 0
    ? 'PAST-task tools (★ = fits your task; intent shown per line). Reuse a ★ line ONLY if its intent+resource match what you\'re doing NOW — else ignore it and rediscover. A tool from a different job (e.g. an SEO tool for an email task) is the wrong tool.'
    : 'PAST-task tools (intent shown per line; NOT filtered to your task). Reuse a line ONLY if its intent+resource match what you\'re doing NOW — else ignore it and discover fresh. A tool from a different job (e.g. an SEO tool for an email task) is the wrong tool.';
  const clip = (s: string): string => (s.length <= TOOL_CHOICE_LINE_MAX ? s : `${s.slice(0, TOOL_CHOICE_LINE_MAX - 1)}…`);
  // Accumulate lines until the block budget is hit (header counts toward it),
  // so the highest-ranked choices win the space.
  const lines: string[] = [];
  let used = header.length;
  for (const r of active) {
    const c = r.choice!;
    const star = relevantIntents.has(r.intent) ? '★ ' : '';
    const how = c.invocationTemplate ? ` → \`${c.invocationTemplate}\`` : '';
    // With outcomes on, show the track record so the model can gauge confidence.
    const neg = (c.failureCount ?? 0) + (c.rejectionCount ?? 0);
    const pos = (c.successCount ?? 0) + (c.approvalCount ?? 0);
    const track = outcomesOn && pos + neg > 0 ? ` (✓${pos}${neg ? `/✗${neg}` : ''})` : '';
    // C6: surface WHICH account a remembered choice is bound to, so the model
    // never reuses a line against the wrong mailbox.
    const identity = c.accountIdentity ? ` @${c.accountIdentity}` : '';
    const line = clip(`- ${star}${r.intent}: ${c.kind}:${c.identifier}${identity}${how}${track}`);
    if (used + 1 + line.length > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
  }
  if (lines.length === 0) return '';
  return [header, ...lines].join('\n');
}
