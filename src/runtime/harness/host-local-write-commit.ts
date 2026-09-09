/**
 * Canonical host-owned proof carried by successful local authoring writes.
 *
 * The authoring implementation supplies only the stable created identity and
 * the committed file path. This leaf reopens that path beneath Clementine's
 * local root, derives the relative handle, hashes the bytes that are actually
 * on disk, and stamps those exact facts as the first result line. Consumers
 * still have to prove registered local-write effect and host execution; the
 * marker by itself grants no authority.
 */
import { createHash } from 'node:crypto';
import { withWorkspaceSnapshotHandle } from '../../spaces/workspace-snapshot.js';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { isLocalFileRevisionHandle, readLocalFileRevisionContent } from './local-file-revision.js';

export const HOST_LOCAL_WRITE_COMMIT_PREFIX = '[clementine:host-local-write-commit:v1]' as const;
export const HOST_LOCAL_WORKSPACE_COMMIT_BASENAME = '.clementine-workspace-commit.json' as const;

interface HostLocalWorkspaceCommitComponent {
  role: 'manifest' | 'view' | 'data';
  handle: string;
  contentDigest: string;
  bytes: number;
}

type HostLocalWorkspaceCommitDocument = {
  version: 1;
  kind: 'workspace_bundle_v1';
  createdId: string;
  components: HostLocalWorkspaceCommitComponent[];
} | {
  version: 2;
  kind: 'workspace_bundle_v2';
  createdId: string;
  components: HostLocalWorkspaceCommitComponent[];
  /** A missing data file is an observed fact, never an invented empty JSON document. */
  dataAbsent: true;
};

export interface HostLocalWorkspaceCompoundCommitFacts extends HostLocalWriteCommitFacts {
  components: readonly HostLocalWorkspaceCommitComponent[];
}

export interface HostLocalWorkspaceStructuredCollectionProof {
  pointer: string;
  visibleMirrorPointer: string;
  calendarPointer: string;
  count: number;
  requiredFields: readonly string[];
  collectionDigest: string;
  visibleMirrorDigest: string;
  calendarDigest: string;
  desktopViewDigest: string;
}

export interface HostLocalWorkspaceStructuredCollectionLocator {
  contract: 'workspace_social_posts_v1';
  collectionPointer: '/posts';
  visibleMirrorPointer: '/_mobile/records/items';
  calendarPointer: '/calendar';
  calendarRequiredFields: ['date', 'channel', 'theme'];
  sourceEvidence: {
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
}

export type HostLocalWorkspaceStructuredCreateArgsValidation =
  | { ok: true; proof: HostLocalWorkspaceStructuredCollectionProof }
  | { ok: false; reason: string };

export interface HostLocalWriteCommitIdentity {
  createdId: string;
  handle: string;
  contentDigest: string;
}

export interface HostLocalWriteCommitFacts extends HostLocalWriteCommitIdentity {
  receipt: string;
}

function canonicalIdentity(input: HostLocalWriteCommitIdentity): string {
  return JSON.stringify({
    version: 1 as const,
    createdId: input.createdId,
    handle: input.handle,
    contentDigest: input.contentDigest,
  });
}

function validCreatedId(createdId: string): boolean {
  return createdId.length > 0
    && createdId.length <= 512
    && createdId === createdId.trim()
    && !/[\u0000-\u001f\u007f]/.test(createdId);
}

function validRelativeHandle(handle: string): boolean {
  return handle.length > 0
    && handle.length <= 1_024
    && handle === handle.trim()
    && !path.posix.isAbsolute(handle)
    && !handle.includes('\\')
    && handle.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** Pure parser used at durable redemption. It accepts only one canonical JSON
 * spelling so alternate encodings cannot create multiple receipt identities. */
export function parseHostLocalWriteCommitFacts(result: unknown): HostLocalWriteCommitFacts | null {
  if (typeof result !== 'string') return null;
  const newline = result.indexOf('\n');
  if (newline < 0) return null;
  const receipt = result.slice(0, newline);
  if (!receipt.startsWith(`${HOST_LOCAL_WRITE_COMMIT_PREFIX} `) || receipt.length > 2_500) return null;
  const encoded = receipt.slice(HOST_LOCAL_WRITE_COMMIT_PREFIX.length + 1);
  try {
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    const createdId = typeof parsed.createdId === 'string' ? parsed.createdId : '';
    const handle = typeof parsed.handle === 'string' ? parsed.handle : '';
    const contentDigest = typeof parsed.contentDigest === 'string' ? parsed.contentDigest : '';
    const identity = { createdId, handle, contentDigest };
    if (
      parsed.version !== 1
      || encoded !== canonicalIdentity(identity)
      || !validCreatedId(createdId)
      || !validRelativeHandle(handle)
      || !/^[a-f0-9]{64}$/.test(contentDigest)
    ) return null;
    return { ...identity, receipt };
  } catch {
    return null;
  }
}

export function hostLocalWriteCommitResultIsProven(result: unknown): boolean {
  const facts = parseHostLocalWriteCommitFacts(result);
  if (!facts) return false;
  if (isLocalFileRevisionHandle(facts.handle)) return readCommittedArtifactContent(facts).verified;
  if (!facts.handle.endsWith(`/${HOST_LOCAL_WORKSPACE_COMMIT_BASENAME}`)) return true;
  return workspaceCompoundReadbackIsProven(facts);
}

/**
 * Pre-dispatch half of the narrow Workspace compound-commit contract.
 *
 * `space_save(initial_data_json)` is one create-only local mutation whose
 * successful result is required to reopen a canonical descriptor plus the
 * exact manifest, view, and data bytes. That descriptor is the operation's
 * intrinsic readback; requiring a second graph read would duplicate the local
 * I/O and contradict the tool's one-call handoff contract. This predicate does
 * not prove success and grants no terminal evidence: after execution,
 * `hostLocalWriteCommitResultIsProven` still has to validate all four files.
 * Every other local tool and every external write remains ineligible.
 */
export function expectsHostLocalWorkspaceCompoundCommit(input: {
  toolName: string;
  args: unknown;
}): boolean {
  if (input.toolName !== 'space_save') return false;
  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) return false;
  const args = input.args as Record<string, unknown>;
  if (
    typeof args.slug !== 'string'
    || !args.slug.trim()
    || typeof args.title !== 'string'
    || !args.title.trim()
    || typeof args.initial_data_json !== 'string'
    || !args.initial_data_json.trim()
    || (args.data_sources !== null && args.data_sources !== undefined)
    || (args.actions !== null && args.actions !== undefined)
    || (args.reengage_triggers !== null && args.reengage_triggers !== undefined)
  ) return false;
  const hasInlineView = typeof args.view_html === 'string' && args.view_html.trim().length > 0;
  const hasPathView = typeof args.view_path === 'string' && args.view_path.trim().length > 0;
  // A path is mutable indirection and cannot bind accepted model bytes to the
  // committed view. The intrinsic synthesis proof is inline-only.
  if (!hasInlineView || hasPathView) return false;
  try {
    const data = JSON.parse(args.initial_data_json) as unknown;
    return Boolean(data && typeof data === 'object' && !Array.isArray(data));
  } catch {
    return false;
  }
}

function safeCommittedFile(root: string, filePath: string): {
  path: string;
  handle: string;
  bytes: Buffer;
} {
  const nominated = path.resolve(filePath);
  const before = lstatSync(nominated);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Local authoring commit target is not a direct regular file.');
  }
  const fd = openSync(nominated, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Local authoring commit target changed before open.');
    }
    const committed = realpathSync(nominated);
    const rel = path.relative(root, committed);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Local authoring commit path is outside the Clementine root.');
    }
    const handle = rel.split(path.sep).join('/');
    if (!validRelativeHandle(handle)) {
      throw new Error('Local authoring commit produced an invalid relative handle.');
    }
    const bytes = readFileSync(fd);
    const afterFd = fstatSync(fd);
    const afterPath = lstatSync(nominated);
    if (
      !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || afterFd.dev !== opened.dev
      || afterFd.ino !== opened.ino
      || afterFd.size !== opened.size
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
      || bytes.byteLength !== afterFd.size
    ) throw new Error('Local authoring commit target changed during read.');
    return { path: committed, handle, bytes };
  } finally {
    closeSync(fd);
  }
}

function safeTargetHandle(root: string, filePath: string): string {
  const resolved = path.resolve(filePath);
  // The manifest is intentionally addressed before it exists so it can remain
  // the Workspace visibility barrier. Canonicalize its existing parent to keep
  // macOS' /var -> /private/var alias from making an in-root target look external.
  let target: string;
  try {
    target = realpathSync(resolved);
  } catch {
    target = path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
  }
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Local authoring commit path is outside the Clementine root.');
  }
  const handle = rel.split(path.sep).join('/');
  if (!validRelativeHandle(handle)) {
    throw new Error('Local authoring commit produced an invalid relative handle.');
  }
  return handle;
}

function reopenWorkspaceCompoundCommit(facts: HostLocalWriteCommitFacts): HostLocalWorkspaceCompoundCommitFacts | null {
  try { return withWorkspaceSnapshotHandle(facts.handle, () => reopenWorkspaceCompoundCommitUnlocked(facts)); } catch { return null; }
}

function reopenWorkspaceCompoundCommitUnlocked(
  facts: HostLocalWriteCommitFacts,
): HostLocalWorkspaceCompoundCommitFacts | null {
  try {
    const root = realpathSync(path.resolve(BASE_DIR));
    const receipt = safeCommittedFile(root, path.resolve(root, facts.handle));
    if (createHash('sha256').update(receipt.bytes).digest('hex') !== facts.contentDigest) return null;
    if (receipt.bytes.byteLength > 16_384) return null;
    const parsed = JSON.parse(receipt.bytes.toString('utf8')) as HostLocalWorkspaceCommitDocument;
    const dataAbsent = parsed.version === 2
      && parsed.kind === 'workspace_bundle_v2'
      && parsed.dataAbsent === true;
    if (
      (!(parsed.version === 1 && parsed.kind === 'workspace_bundle_v1') && !dataAbsent)
      || parsed.createdId !== facts.createdId
      || !Array.isArray(parsed.components)
      || parsed.components.length !== (dataAbsent ? 2 : 3)
    ) return null;
    const workspacePrefix = `spaces/${facts.createdId}/`;
    if (facts.handle !== `${workspacePrefix}${HOST_LOCAL_WORKSPACE_COMMIT_BASENAME}`) return null;
    const expectedRoles = dataAbsent ? ['manifest', 'view'] as const : ['manifest', 'view', 'data'] as const;
    for (let index = 0; index < expectedRoles.length; index += 1) {
      const component = parsed.components[index];
      if (
        component?.role !== expectedRoles[index]
        || !validRelativeHandle(component.handle)
        || !component.handle.startsWith(workspacePrefix)
        || !/^[a-f0-9]{64}$/.test(component.contentDigest)
        || !Number.isSafeInteger(component.bytes)
        || component.bytes < 0
      ) return null;
      if (component.role === 'manifest' && component.handle !== `${workspacePrefix}space.json`) return null;
      if (component.role === 'view' && !component.handle.startsWith(`${workspacePrefix}view/`)) return null;
      if (component.role === 'data' && component.handle !== `${workspacePrefix}data.json`) return null;
      const reopened = safeCommittedFile(root, path.resolve(root, component.handle));
      if (
        reopened.handle !== component.handle
        || reopened.path !== path.resolve(root, component.handle)
        || reopened.bytes.byteLength !== component.bytes
        || createHash('sha256').update(reopened.bytes).digest('hex') !== component.contentDigest
      ) return null;
    }
    if (dataAbsent) {
      // Only this closed descriptor variant can omit data. Recheck absence
      // on every redemption: a newly appearing file invalidates the receipt.
      if (!committedFileIsAbsent(path.resolve(root, `${workspacePrefix}data.json`))) return null;
      const manifest = safeCommittedFile(root, path.resolve(root, `${workspacePrefix}space.json`));
      if ((JSON.parse(manifest.bytes.toString('utf8')) as Record<string, unknown>).contentMode === 'static_snapshot') return null;
      if (JSON.stringify({
        version: 2, kind: 'workspace_bundle_v2', createdId: parsed.createdId,
        components: parsed.components, dataAbsent: true,
      }) !== receipt.bytes.toString('utf8')) return null;
    }
    if (JSON.stringify(parsed) !== receipt.bytes.toString('utf8')) return null;
    return { ...facts, components: parsed.components };
  } catch {
    return null;
  }
}

function committedFileIsAbsent(filePath: string): boolean {
  try { lstatSync(filePath); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function workspaceCompoundReadbackIsProven(facts: HostLocalWriteCommitFacts): boolean {
  return reopenWorkspaceCompoundCommit(facts) !== null;
}

function substantiveStructuredField(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function exactCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString().slice(0, 10) === value;
}

const HOST_RECOGNIZED_SOCIAL_CHANNELS = new Set([
  'LinkedIn', 'LinkedIn Company Page',
  'X',
  'Facebook', 'Facebook Page',
  'Instagram', 'Instagram Reels',
  'Threads', 'TikTok', 'YouTube', 'YouTube Shorts',
  'Reddit', 'Bluesky', 'Mastodon', 'Pinterest', 'Snapchat',
]);

function exactSocialChannel(value: unknown): value is string {
  return typeof value === 'string' && HOST_RECOGNIZED_SOCIAL_CHANNELS.has(value);
}

function substantiveCalendarTheme(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 6
    || value.length > 160
  ) return false;
  const identityChars = value.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu, '');
  return identityChars.length >= 4 && new Set(identityChars).size >= 3;
}

function calendarDayWithinHorizon(value: unknown, asOf: string): value is string {
  if (!exactCalendarDay(value)) return false;
  const anchor = new Date(asOf);
  if (Number.isNaN(anchor.valueOf())) return false;
  const anchorDay = Date.parse(`${anchor.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const calendarDay = Date.parse(`${value}T00:00:00.000Z`);
  const offsetDays = Math.floor((calendarDay - anchorDay) / 86_400_000);
  return offsetDays >= 0 && offsetDays <= 366;
}

function mobileCalendarFieldsMatch(
  value: unknown,
  channel: string,
  theme: string,
): boolean {
  return JSON.stringify(value) === JSON.stringify([
    { label: 'Channel', value: channel },
    { label: 'Theme', value: theme },
  ]);
}

function resolveExactJsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/') || pointer.length > 512 || /~(?![01])/u.test(pointer)) {
    return undefined;
  }
  const tokens = pointer.slice(1).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (tokens.length > 32) return undefined;
  let value = root;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= value.length) return undefined;
      value = value[index];
      continue;
    }
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, token)) return undefined;
    value = (value as Record<string, unknown>)[token];
  }
  return value;
}

function exactHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.href === value
      ? value
      : null;
  } catch {
    return null;
  }
}

function citationUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) return null;
  const urls: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const url = exactHttpUrl((entry as Record<string, unknown>).url);
    if (!url) return null;
    urls.push(url);
  }
  return [...new Set(urls)].sort();
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Dedicated static-view half of `workspace_social_posts_v1`.
 *
 * This is intentionally a narrow authored-view contract, not a claim that
 * regex can prove arbitrary JavaScript safe. The exact committed module must
 * read the scoped Workspace dataset, consume both frozen collections, name
 * their visible DOM targets, and contain a DOM mutation sink. The causal
 * browser journey remains the executable/rendering proof; this wall prevents
 * data-rich but blank/disconnected HTML from terminalizing on byte receipts
 * alone. */
function socialWorkspaceDesktopViewDigest(bytes: Buffer): string | null {
  if (bytes.byteLength < 128 || bytes.byteLength > 1_000_000) return null;
  const html = bytes.toString('utf8');
  if (html.includes('\0')) return null;
  if (
    !/\bid\s*=\s*['"]calendar['"]/iu.test(html)
    || !/\bid\s*=\s*['"]posts['"]/iu.test(html)
  ) return null;
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)]
    .map((match) => match[1] ?? '');
  for (const script of scripts) {
    const binding = script.match(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:window\s*\.\s*)?clem\s*\.\s*data\s*\(\s*\)/u,
    );
    if (!binding?.[1]) continue;
    const variable = escapedRegex(binding[1]);
    const collection = (name: 'calendar' | 'posts'): boolean => {
      const property = `(?:\\.\\s*${name}\\b|\\[\\s*['\"]${name}['\"]\\s*\\])`;
      return new RegExp(
        `(?:for\\s*\\([^)]*\\bof\\s+${variable}\\s*${property}\\s*\\)|${variable}\\s*${property}\\s*\\.\\s*(?:forEach|map)\\s*\\()`,
        'u',
      ).test(script);
    };
    if (!collection('calendar') || !collection('posts')) continue;
    if (
      !/(?:querySelector\s*\(\s*['"]#calendar['"]|getElementById\s*\(\s*['"]calendar['"])/u.test(script)
      || !/(?:querySelector\s*\(\s*['"]#posts['"]|getElementById\s*\(\s*['"]posts['"])/u.test(script)
      || !/\.\s*(?:append|appendChild|replaceChildren|textContent|innerText)\b/u.test(script)
    ) continue;
    return createHash('sha256').update(bytes).digest('hex');
  }
  return null;
}

function proveHostLocalWorkspaceStructuredPayload(input: {
  root: unknown;
  viewBytes: Buffer;
  count: number;
  requiredFields: readonly string[];
  locator: HostLocalWorkspaceStructuredCollectionLocator | null | undefined;
}): HostLocalWorkspaceStructuredCollectionProof | null {
  if (
    !Number.isSafeInteger(input.count)
    || input.count < 1
    || input.count > 10_000
    || input.requiredFields.length < 1
    || input.requiredFields.length > 32
    || input.requiredFields.some((field) => (
      typeof field !== 'string'
      || !field.trim()
      || field !== field.trim()
      || field.length > 128
    ))
    || new Set(input.requiredFields).size !== input.requiredFields.length
    || input.locator?.contract !== 'workspace_social_posts_v1'
    || input.locator.collectionPointer !== '/posts'
    || input.locator.visibleMirrorPointer !== '/_mobile/records/items'
    || input.locator.calendarPointer !== '/calendar'
    || JSON.stringify(input.locator.calendarRequiredFields) !== JSON.stringify(['date', 'channel', 'theme'])
  ) return null;
  const desktopViewDigest = socialWorkspaceDesktopViewDigest(input.viewBytes);
  if (!desktopViewDigest) return null;
  const collection = resolveExactJsonPointer(input.root, input.locator.collectionPointer);
  const visibleMirror = resolveExactJsonPointer(input.root, input.locator.visibleMirrorPointer);
  const calendar = resolveExactJsonPointer(input.root, input.locator.calendarPointer);
  const visibleTotal = resolveExactJsonPointer(input.root, '/_mobile/records/total');
  if (
    !Array.isArray(collection)
    || collection.length !== input.count
    || !Array.isArray(visibleMirror)
    || visibleMirror.length !== input.count
    || !Array.isArray(calendar)
    || calendar.length !== input.count
    || visibleTotal !== input.count
  ) return null;
  const seenBodies = new Set<string>();
  const seenKeys = new Set<string>();
  for (let index = 0; index < collection.length; index += 1) {
    const entry = collection[index];
    const mirror = visibleMirror[index];
    const calendarEntry = calendar[index];
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !mirror
      || typeof mirror !== 'object'
      || Array.isArray(mirror)
      || !calendarEntry
      || typeof calendarEntry !== 'object'
      || Array.isArray(calendarEntry)
      || !input.requiredFields.every((field) => (
        Object.hasOwn(entry, field)
        && substantiveStructuredField((entry as Record<string, unknown>)[field])
      ))
    ) return null;
    const record = entry as Record<string, unknown>;
    const mobile = mirror as Record<string, unknown>;
    const calendarRecord = calendarEntry as Record<string, unknown>;
    const sources = citationUrls(record.citations);
    const links = citationUrls(mobile.links);
    const body = typeof record.body === 'string' ? record.body.trim() : '';
    const bodyTokens = body.split(/\s+/u).filter(Boolean);
    const bodyIdentity = body.replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
    const mobileKey = typeof mobile.key === 'string' ? mobile.key.trim() : '';
    const date = record.date;
    const channel = record.channel;
    const theme = record.theme;
    if (
      typeof record.body !== 'string'
      || record.body !== body
      || body.length < 80
      || bodyTokens.length < 12
      || new Set(bodyTokens.map((token) => token.toLocaleLowerCase('en-US'))).size < 6
      || seenBodies.has(bodyIdentity)
      || mobile.body !== record.body
      || !mobileKey
      || seenKeys.has(mobileKey)
      || typeof record.id !== 'string'
      || record.id.trim() !== record.id
      || !record.id
      || mobileKey !== record.id
      || !calendarDayWithinHorizon(date, input.locator.sourceEvidence.asOf)
      || !exactSocialChannel(channel)
      || !substantiveCalendarTheme(theme)
      || mobile.primary !== `${date} · ${theme}`
      || !mobileCalendarFieldsMatch(mobile.fields, channel, theme)
      || !input.locator.calendarRequiredFields.every((field) => (
        substantiveStructuredField(calendarRecord[field])
        && calendarRecord[field] === record[field]
      ))
      || calendarRecord.id !== record.id
      || !sources
      || !links
      || !(mobile.links as unknown[]).every((link) => (
        Boolean(link)
        && typeof link === 'object'
        && !Array.isArray(link)
        && typeof (link as Record<string, unknown>).label === 'string'
        && Boolean(((link as Record<string, unknown>).label as string).trim())
      ))
      || JSON.stringify(sources) !== JSON.stringify(links)
    ) return null;
    seenBodies.add(bodyIdentity);
    seenKeys.add(mobileKey);
  }
  return {
    pointer: input.locator.collectionPointer,
    visibleMirrorPointer: input.locator.visibleMirrorPointer,
    calendarPointer: input.locator.calendarPointer,
    count: input.count,
    requiredFields: [...input.requiredFields],
    collectionDigest: createHash('sha256').update(JSON.stringify(collection), 'utf8').digest('hex'),
    visibleMirrorDigest: createHash('sha256').update(JSON.stringify(visibleMirror), 'utf8').digest('hex'),
    calendarDigest: createHash('sha256').update(JSON.stringify(calendar), 'utf8').digest('hex'),
    desktopViewDigest,
  };
}

/**
 * Pure pre-dispatch half of the structured Workspace contract. The exact
 * accepted `initial_data_json` and inline view must already satisfy the same
 * count, calendar, desktop, and phone contract later re-proved from committed
 * bytes. This prevents a create-only slug from being poisoned by an artifact
 * that can never earn its terminal receipt.
 */
export function validateHostLocalWorkspaceStructuredCreateArgs(input: {
  args: unknown;
  count: number;
  requiredFields: readonly string[];
  locator: HostLocalWorkspaceStructuredCollectionLocator | null | undefined;
}): HostLocalWorkspaceStructuredCreateArgsValidation {
  if (!expectsHostLocalWorkspaceCompoundCommit({ toolName: 'space_save', args: input.args })) {
    return { ok: false, reason: 'structured Workspace create is not one exact inline compound commit' };
  }
  const args = input.args as Record<string, unknown>;
  let root: unknown;
  try {
    root = JSON.parse(args.initial_data_json as string) as unknown;
  } catch {
    return { ok: false, reason: 'structured Workspace initial data is not valid JSON' };
  }
  const proof = proveHostLocalWorkspaceStructuredPayload({
    root,
    viewBytes: Buffer.from(args.view_html as string, 'utf8'),
    count: input.count,
    requiredFields: input.requiredFields,
    locator: input.locator,
  });
  return proof
    ? { ok: true, proof }
    : { ok: false, reason: 'structured Workspace create does not satisfy its frozen desktop, calendar, posts, and phone contract' };
}

/**
 * Reopen one exact structured collection from a compound Workspace commit.
 *
 * This is deliberately schema-shaped, not prose-shaped: the accepted graph
 * supplies an exact count, item field set, and host-recognized locator, while
 * the descriptor supplies the exact committed data bytes. Arbitrary arrays
 * elsewhere in the document are irrelevant: the primary `/posts` collection
 * and its user-visible mobile mirror must both redeem the frozen contract.
 */
export function proveHostLocalWorkspaceStructuredCollection(input: Parameters<typeof proveHostLocalWorkspaceStructuredCollectionUnlocked>[0]): ReturnType<typeof proveHostLocalWorkspaceStructuredCollectionUnlocked> {
  const facts = parseHostLocalWriteCommitFacts(input.result);
  if (!facts) return null;
  try { return withWorkspaceSnapshotHandle(facts.handle, () => proveHostLocalWorkspaceStructuredCollectionUnlocked(input)); } catch { return null; }
}

function proveHostLocalWorkspaceStructuredCollectionUnlocked(input: {
  result: unknown;
  count: number;
  requiredFields: readonly string[];
  locator: HostLocalWorkspaceStructuredCollectionLocator | null | undefined;
}): HostLocalWorkspaceStructuredCollectionProof | null {
  const facts = parseHostLocalWriteCommitFacts(input.result);
  if (!facts || !facts.handle.endsWith(`/${HOST_LOCAL_WORKSPACE_COMMIT_BASENAME}`)) return null;
  const reopened = reopenWorkspaceCompoundCommit(facts);
  const dataComponent = reopened?.components.find((component) => component.role === 'data');
  const viewComponent = reopened?.components.find((component) => component.role === 'view');
  if (!reopened || !dataComponent || !viewComponent) return null;
  try {
    const base = realpathSync(path.resolve(BASE_DIR));
    const data = safeCommittedFile(base, path.resolve(base, dataComponent.handle));
    const view = safeCommittedFile(base, path.resolve(base, viewComponent.handle));
    if (
      data.handle !== dataComponent.handle
      || data.bytes.byteLength !== dataComponent.bytes
      || createHash('sha256').update(data.bytes).digest('hex') !== dataComponent.contentDigest
      || view.handle !== viewComponent.handle
      || view.bytes.byteLength !== viewComponent.bytes
      || createHash('sha256').update(view.bytes).digest('hex') !== viewComponent.contentDigest
    ) return null;
    return proveHostLocalWorkspaceStructuredPayload({
      root: JSON.parse(data.bytes.toString('utf8')) as unknown,
      viewBytes: view.bytes,
      count: input.count,
      requiredFields: input.requiredFields,
      locator: input.locator,
    });
  } catch {
    return null;
  }
}

/**
 * Re-prove that the exact model-authored inline Workspace content is the same
 * content reopened by the compound commit descriptor. This binds the accepted
 * `space_save` argument bytes to the manifest/view/data generation without
 * treating an arbitrary local receipt marker as derivation authority.
 */
export function hostLocalWorkspaceCompoundCommitMatchesArgs(input: Parameters<typeof hostLocalWorkspaceCompoundCommitMatchesArgsUnlocked>[0]): ReturnType<typeof hostLocalWorkspaceCompoundCommitMatchesArgsUnlocked> {
  const facts = parseHostLocalWriteCommitFacts(input.result);
  if (!facts) return null;
  try { return withWorkspaceSnapshotHandle(facts.handle, () => hostLocalWorkspaceCompoundCommitMatchesArgsUnlocked(input)); } catch { return null; }
}

function hostLocalWorkspaceCompoundCommitMatchesArgsUnlocked(input: {
  result: unknown;
  args: unknown;
}): HostLocalWorkspaceCompoundCommitFacts | null {
  if (!expectsHostLocalWorkspaceCompoundCommit({ toolName: 'space_save', args: input.args })) {
    return null;
  }
  const facts = parseHostLocalWriteCommitFacts(input.result);
  if (!facts || !facts.handle.endsWith(`/${HOST_LOCAL_WORKSPACE_COMMIT_BASENAME}`)) return null;
  const reopened = reopenWorkspaceCompoundCommit(facts);
  if (!reopened) return null;
  const args = input.args as Record<string, unknown>;
  let canonicalData: string;
  try {
    canonicalData = JSON.stringify(JSON.parse(args.initial_data_json as string));
  } catch {
    return null;
  }
  const expected = new Map<HostLocalWorkspaceCommitComponent['role'], string>([
    ['view', createHash('sha256').update(args.view_html as string, 'utf8').digest('hex')],
    ['data', createHash('sha256').update(canonicalData, 'utf8').digest('hex')],
  ]);
  for (const [role, digest] of expected) {
    const component = reopened.components.filter((candidate) => candidate.role === role);
    if (component.length !== 1 || component[0]!.contentDigest !== digest) return null;
  }
  const manifestComponent = reopened.components.find((candidate) => candidate.role === 'manifest');
  if (!manifestComponent) return null;
  let manifest: Record<string, unknown>;
  try {
    const root = realpathSync(path.resolve(BASE_DIR));
    const committed = safeCommittedFile(root, path.resolve(root, manifestComponent.handle));
    manifest = JSON.parse(committed.bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const normalizedText = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/\s+/g, ' ').trim().slice(0, max);
    return text || undefined;
  };
  const normalizedList = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of value) {
      const text = normalizedText(entry, 500);
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push(text);
      if (out.length >= 12) break;
    }
    return out;
  };
  const objective = normalizedText(args.objective, 1_200);
  const contract = manifest.contract && typeof manifest.contract === 'object' && !Array.isArray(manifest.contract)
    ? manifest.contract as Record<string, unknown>
    : null;
  const expectedContract = objective
    ? {
        objective,
        successCriteria: normalizedList(args.success_criteria) ?? [],
        invariants: normalizedList(args.invariants) ?? [],
      }
    : null;
  if (
    manifest.id !== args.slug
    || manifest.title !== (String(args.title).trim().slice(0, 200) || args.slug)
    || manifest.status !== 'active'
    || manifest.viewEntry !== 'view/index.html'
    || manifest.contentMode !== 'static_snapshot'
    || manifest.version !== 1
    || !Array.isArray(manifest.revisions)
    || manifest.revisions.length !== 0
    || !Array.isArray(manifest.dataSources)
    || manifest.dataSources.length !== 0
    || !Array.isArray(manifest.actions)
    || manifest.actions.length !== 0
    || JSON.stringify(contract) !== JSON.stringify(expectedContract)
    || (typeof args.origin_session_id === 'string'
      && args.origin_session_id.trim()
      && manifest.originSessionId !== args.origin_session_id.trim())
  ) return null;
  return reopened;
}

/**
 * Stamp a successful result from bytes reopened after the local commit.
 * `rootDir` is a test seam; production uses Clementine's single BASE_DIR so
 * every handle has one provider-neutral namespace across Workspaces,
 * workflows, and future local authoring capabilities.
 */
export function withHostLocalWriteCommitFromFile(input: Parameters<typeof withHostLocalWriteCommitFromFileUnlocked>[0]): string {
  const root = path.resolve(input.rootDir ?? BASE_DIR);
  const handle = path.relative(root, path.resolve(input.committedPath)).split(path.sep).join('/');
  return root === path.resolve(BASE_DIR)
    ? withWorkspaceSnapshotHandle(handle, () => withHostLocalWriteCommitFromFileUnlocked(input))
    : withHostLocalWriteCommitFromFileUnlocked(input);
}

function withHostLocalWriteCommitFromFileUnlocked(input: {
  createdId: string;
  committedPath: string;
  result: string;
  rootDir?: string;
}): string {
  if (!validCreatedId(input.createdId)) {
    throw new Error('Local authoring commit supplied an invalid created id.');
  }
  const root = realpathSync(path.resolve(input.rootDir ?? BASE_DIR));
  const committed = safeCommittedFile(root, input.committedPath);
  const identity: HostLocalWriteCommitIdentity = {
    createdId: input.createdId,
    handle: committed.handle,
    contentDigest: createHash('sha256').update(committed.bytes).digest('hex'),
  };
  return `${HOST_LOCAL_WRITE_COMMIT_PREFIX} ${canonicalIdentity(identity)}\n${input.result}`;
}

/**
 * Write the immutable compound descriptor from caller-owned exact bytes. The
 * manifest path may be the not-yet-visible commit target; this lets the
 * Workspace store publish descriptor + data + view before the manifest
 * visibility barrier while it still holds the slug mutation lock.
 */
export interface HostLocalWorkspaceCommitDocumentInput {
  createdId: string;
  receiptPath: string;
  manifest: { path: string; bytes: Buffer | string };
  view: { path: string; bytes: Buffer | string };
  data: { path: string; bytes: Buffer | string } | null;
  rootDir?: string;
}

export function serializeHostLocalWorkspaceCommitDocument(input: HostLocalWorkspaceCommitDocumentInput): string {
  if (!validCreatedId(input.createdId)) {
    throw new Error('Local Workspace commit supplied an invalid created id.');
  }
  const root = realpathSync(path.resolve(input.rootDir ?? BASE_DIR));
  const component = (
    role: HostLocalWorkspaceCommitComponent['role'],
    source: { path: string; bytes: Buffer | string },
  ): HostLocalWorkspaceCommitComponent => {
    const bytes = Buffer.isBuffer(source.bytes) ? source.bytes : Buffer.from(source.bytes, 'utf8');
    return {
      role,
      handle: safeTargetHandle(root, source.path),
      contentDigest: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    };
  };
  const components = [component('manifest', input.manifest), component('view', input.view)];
  const document: HostLocalWorkspaceCommitDocument = input.data
    ? {
        version: 1, kind: 'workspace_bundle_v1', createdId: input.createdId,
        components: [...components, component('data', input.data)],
      }
    : {
        version: 2, kind: 'workspace_bundle_v2', createdId: input.createdId,
        components, dataAbsent: true,
      };
  const receiptHandle = safeTargetHandle(root, input.receiptPath);
  if (receiptHandle !== `spaces/${input.createdId}/${HOST_LOCAL_WORKSPACE_COMMIT_BASENAME}`) {
    throw new Error('Local Workspace compound receipt path is not canonical.');
  }
  return JSON.stringify(document);
}

export function writeHostLocalWorkspaceCommitDocument(input: HostLocalWorkspaceCommitDocumentInput): string {
  const document = serializeHostLocalWorkspaceCommitDocument(input);
  const tempPath = `${input.receiptPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, document, 'utf8');
  renameSync(tempPath, input.receiptPath);
  return input.receiptPath;
}

/** Stamp a final ordinary save from one locked, safely reopened snapshot.
 * The caller must validate its saved authoring fields before the descriptor is
 * written. Data here is current observed content, not a claim of acquisition.
 * Initial static creates keep their stricter save-time generation descriptor. */
export function withHostLocalWorkspaceCommitFromCurrentFiles(input: {
  createdId: string;
  viewEntry: string;
  result: string;
  validate: (parts: { manifest: Buffer; view: Buffer; data: Buffer | null }) => void;
}): string {
  const handle = `spaces/${input.createdId}/${HOST_LOCAL_WORKSPACE_COMMIT_BASENAME}`;
  return withWorkspaceSnapshotHandle(handle, () => {
    const root = realpathSync(path.resolve(BASE_DIR));
    const prefix = `spaces/${input.createdId}/`;
    if (!validCreatedId(input.createdId) || !validRelativeHandle(input.viewEntry)
      || !input.viewEntry.startsWith('view/')) throw new Error('Invalid Workspace save commit target');
    const manifest = safeCommittedFile(root, path.resolve(root, prefix, 'space.json'));
    const view = safeCommittedFile(root, path.resolve(root, prefix, input.viewEntry));
    const dataPath = path.resolve(root, prefix, 'data.json');
    const data = committedFileIsAbsent(dataPath) ? null : safeCommittedFile(root, dataPath);
    if (manifest.handle !== `${prefix}space.json` || view.handle !== `${prefix}${input.viewEntry}`
      || (data && data.handle !== `${prefix}data.json`)) throw new Error('Workspace save component path changed');
    input.validate({ manifest: manifest.bytes, view: view.bytes, data: data?.bytes ?? null });
    const receiptPath = path.resolve(root, handle);
    writeHostLocalWorkspaceCommitDocument({
      createdId: input.createdId, receiptPath,
      manifest: { path: manifest.path, bytes: manifest.bytes },
      view: { path: view.path, bytes: view.bytes },
      data: data ? { path: data.path, bytes: data.bytes } : null,
    });
    const result = withHostLocalWriteCommitFromFile({ createdId: input.createdId, committedPath: receiptPath, result: input.result });
    if (!hostLocalWriteCommitResultIsProven(result)) throw new Error('Workspace save components changed before delivery proof');
    return result;
  });
}

/** Test-only fixture constructor for transport tests that do not own a real
 * artifact. Production authoring code must use withHostLocalWriteCommitFromFile. */
export function _withHostLocalWriteCommitFactsForTest(
  input: HostLocalWriteCommitIdentity & { result: string },
): string {
  const line = `${HOST_LOCAL_WRITE_COMMIT_PREFIX} ${canonicalIdentity(input)}`;
  const stamped = `${line}\n${input.result}`;
  if (!parseHostLocalWriteCommitFacts(stamped)) {
    throw new Error('Invalid local-write commit test fixture.');
  }
  return stamped;
}

/**
 * Verified current content behind a committed artifact, for completion review.
 *
 * A Space is a BUNDLE. Hashing only its descriptor made a real component change
 * invisible, and reading it through a lexical containment check left both a
 * symlink and a check/open swap window. This reuses the module's own
 * `safeCommittedFile` (lstat + O_NOFOLLOW open + fstat) and
 * `reopenWorkspaceCompoundCommit`, so containment and component verification are
 * decided by the same code that wrote the commit.
 *
 * Digests are over RAW BYTES, never decoded text, and byte counts are reported
 * so a caller can disclose exact coverage instead of guessing at characters.
 */
export interface CommittedArtifactContent {
  parts: ReadonlyArray<{ handle: string; bytes: Buffer; role: string }>;
  totalBytes: number;
  /** True when every part verified against its recorded digest. */
  verified: boolean;
  /** Set when the artifact could not be resolved at all (distinct from a mismatch). */
  unresolvedReason?: string;
}

export function readCommittedArtifactContent(facts: HostLocalWriteCommitFacts): CommittedArtifactContent {
  try { return withWorkspaceSnapshotHandle(facts.handle, () => readCommittedArtifactContentUnlocked(facts)); }
  catch (error) { return { parts: [], totalBytes: 0, verified: false, unresolvedReason: `unreadable:${error instanceof Error ? error.name : 'error'}` }; }
}

function readCommittedArtifactContentUnlocked(
  facts: HostLocalWriteCommitFacts,
): CommittedArtifactContent {
  const isBundle = facts.handle.endsWith(`/${HOST_LOCAL_WORKSPACE_COMMIT_BASENAME}`);
  try {
    const root = realpathSync(path.resolve(BASE_DIR));
    if (isBundle) {
      const reopened = reopenWorkspaceCompoundCommit(facts);
      if (!reopened) {
        // A component changed or the descriptor no longer verifies. This is a
        // real outcome to report, never an artifact that quietly vanishes.
        return { parts: [], totalBytes: 0, verified: false, unresolvedReason: 'workspace_bundle_unverified' };
      }
      const parts: Array<{ handle: string; bytes: Buffer; role: string }> = [];
      for (const component of reopened.components) {
        const file = safeCommittedFile(root, path.resolve(root, component.handle));
        if (createHash('sha256').update(file.bytes).digest('hex') !== component.contentDigest) {
          return { parts: [], totalBytes: 0, verified: false, unresolvedReason: 'workspace_component_digest_mismatch' };
        }
        parts.push({ handle: component.handle, bytes: file.bytes, role: component.role });
      }
      return { parts, totalBytes: parts.reduce((sum, part) => sum + part.bytes.byteLength, 0), verified: true };
    }
    const file = safeCommittedFile(root, path.resolve(root, facts.handle));
    const verified = createHash('sha256').update(file.bytes).digest('hex') === facts.contentDigest;
    if (isLocalFileRevisionHandle(facts.handle)) {
      return readLocalFileRevisionContent(facts, file.bytes);
    }
    return {
      parts: [{ handle: facts.handle, bytes: file.bytes, role: 'file' }],
      totalBytes: file.bytes.byteLength,
      verified,
      ...(verified ? {} : { unresolvedReason: 'content_digest_mismatch' }),
    };
  } catch (error) {
    return {
      parts: [], totalBytes: 0, verified: false,
      unresolvedReason: `unreadable:${error instanceof Error ? error.name : 'error'}`,
    };
  }
}
