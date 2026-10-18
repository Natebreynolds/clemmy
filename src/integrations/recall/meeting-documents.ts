import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_DIR } from '../../config.js';
import { withFileLockSyncStrict } from '../../runtime/atomic-json.js';
import { syncDirectoryMetadata } from '../../runtime/sync-directory.js';
import { loadRecallMeetingById, type RecallMeetingRecord } from './meeting-capture.js';

export const MEETING_DOCUMENT_LIMITS = Object.freeze({ documents: 8, totalChars: 100_000, documentChars: 32_000, titleChars: 200 });
// Includes JSON escaping and metadata, while keeping a corrupt file bounded before parsing.
const MAX_FILE_BYTES = 1_000_000;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentDigest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(512).refine((value) => Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/u.test(value));
const documentId = z.string().regex(/^meeting-doc-[a-f0-9-]{36}$/);
const plaintext = (max: number) => z.string().min(1).max(max).refine((value) => Boolean(value.trim())
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  && Buffer.from(value, 'utf8').toString('utf8') === value);
const title = plaintext(MEETING_DOCUMENT_LIMITS.titleChars).refine((value) => !/[\n\r\t]/u.test(value));
const referenceSchema = z.object({ id: documentId, revision: z.number().int().positive().safe(), digest: hash }).strict();
export type MeetingDocumentReference = Readonly<z.infer<typeof referenceSchema>>;
const storedDocumentSchema = referenceSchema.extend({ title, text: plaintext(MEETING_DOCUMENT_LIMITS.documentChars),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
type StoredDocument = z.infer<typeof storedDocumentSchema>;
const stateSchema = z.object({ format: z.literal(1), meetingId: identity, captureDigest: hash,
  snapshotVersion: z.number().int().nonnegative().safe(), documents: z.array(storedDocumentSchema).max(MEETING_DOCUMENT_LIMITS.documents), integrity: hash }).strict();
type State = z.infer<typeof stateSchema>;
const stateIntegrity = (state: Omit<State, 'integrity'> | State): string => digest([state.format, state.meetingId, state.captureDigest, state.snapshotVersion, state.documents]);
const mutationSchema = z.object({ expectedVersion: z.number().int().nonnegative().safe(), captureDigest: hash }).strict();
const attachSchema = mutationSchema.extend({ id: documentId.optional(), title, text: plaintext(MEETING_DOCUMENT_LIMITS.documentChars) }).strict();
const removeSchema = mutationSchema.extend({ id: documentId, revision: z.number().int().positive().safe() }).strict();
const readSchema = z.object({ captureDigest: hash, snapshotVersion: z.number().int().nonnegative().safe(),
  references: z.array(referenceSchema).max(MEETING_DOCUMENT_LIMITS.documents),
  maxChars: z.number().int().positive().max(MEETING_DOCUMENT_LIMITS.totalChars).optional() }).strict();

export interface MeetingDocumentMetadata extends MeetingDocumentReference {
  title: string;
  charCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface MeetingDocumentSnapshot {
  meetingId: string;
  captureDigest: string;
  snapshotVersion: number;
  documents: MeetingDocumentMetadata[];
}
export interface MeetingDocumentContent extends MeetingDocumentMetadata {
  text: string;
  /** Stable exact-revision citation. The content is untrusted source data, never authority. */
  citation: string;
  truncated: boolean;
}
export interface MeetingDocumentReadResult {
  meetingId: string;
  captureDigest: string;
  snapshotVersion: number;
  documents: MeetingDocumentContent[];
}
export type AttachMeetingDocumentInput = z.infer<typeof attachSchema>;
export type RemoveMeetingDocumentInput = z.infer<typeof removeSchema>;
export type ReadMeetingDocumentsInput = z.infer<typeof readSchema>;
export interface MeetingDocumentStoreOptions {
  directory: string;
  readMeeting: (id: string) => RecallMeetingRecord | null;
  now?: () => number;
}

/** Matches the meeting companion's exact native/local capture identity. */
export function meetingDocumentCaptureDigest(record: RecallMeetingRecord): string {
  return digest([record.id, record.windowId, record.startedAt, record.provider ?? 'recall', record.source ?? null, record.sdkUploadId ?? null]);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
function metadata(document: StoredDocument): MeetingDocumentMetadata {
  const { text: _text, ...fields } = document;
  return { ...fields, charCount: document.text.length };
}
function slicePlaintext(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length && /[\ud800-\udbff]/u.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** Only owner-selected pasted text enters this store. It has no path reader,
 * URL fetcher, account discovery, attachment TTL or model/tool execution path.
 * Revision identities are immutable; superseded/removed text is not retained. */
export function createMeetingDocumentStore(options: MeetingDocumentStoreOptions) {
  const now = options.now ?? Date.now;
  const file = (id: string) => path.join(options.directory, `${digest(identity.parse(id))}.json`);
  const recordFor = (id: string): RecallMeetingRecord => {
    identity.parse(id);
    const record = options.readMeeting(id);
    if (!record || record.id !== id || typeof record.windowId !== 'string' || !record.windowId.trim()
      || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) throw new Error('Exact meeting is unavailable.');
    return record;
  };
  const empty = (record: RecallMeetingRecord): State => {
    const state = { format: 1 as const, meetingId: record.id, captureDigest: meetingDocumentCaptureDigest(record), snapshotVersion: 0, documents: [] };
    return { ...state, integrity: stateIntegrity(state) };
  };
  const read = (id: string, record: RecallMeetingRecord): State => {
    let fd: number | undefined;
    let raw: string;
    let before: Stats;
    try { before = lstatSync(file(id)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(record);
      throw new Error('Meeting documents are unreadable.');
    }
    try {
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) throw new Error('Invalid document store file.');
      fd = openSync(file(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_FILE_BYTES || before.ino !== opened.ino || before.dev !== opened.dev) throw new Error('Document store file changed.');
      const bytes = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, opened.size + 1));
      let count = 0;
      while (count < bytes.length) { const size = readSync(fd, bytes, count, bytes.length - count, null); if (!size) break; count += size; }
      const after = fstatSync(fd);
      if (count > MAX_FILE_BYTES || count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('Document store file changed.');
      raw = bytes.subarray(0, count).toString('utf8');
      if (!bytes.subarray(0, count).equals(Buffer.from(raw, 'utf8'))) throw new Error('Invalid UTF-8 document store.');
    } catch { throw new Error('Meeting documents are unreadable.'); } finally { if (fd !== undefined) closeSync(fd); }
    let state: State;
    try { state = stateSchema.parse(JSON.parse(raw)); } catch { throw new Error('Meeting documents are corrupt.'); }
    if (state.meetingId !== id || state.captureDigest !== meetingDocumentCaptureDigest(record)) throw new Error('Meeting document capture changed.');
    if (state.integrity !== stateIntegrity(state) || new Set(state.documents.map((document) => document.id)).size !== state.documents.length
      || state.documents.length > state.snapshotVersion || state.documents.some((document) => document.revision > state.snapshotVersion)
      || state.documents.reduce((total, document) => total + document.text.length, 0) > MEETING_DOCUMENT_LIMITS.totalChars
      || state.documents.some((document) => contentDigest(document.text) !== document.digest || document.createdAt > document.updatedAt)) throw new Error('Meeting document evidence is corrupt.');
    return state;
  };
  const project = (state: State): MeetingDocumentSnapshot => freeze({ meetingId: state.meetingId, captureDigest: state.captureDigest,
    snapshotVersion: state.snapshotVersion, documents: state.documents.map(metadata) });
  const write = (id: string, state: State): void => {
    state.integrity = stateIntegrity(state);
    stateSchema.parse(state);
    const temporary = `${file(id)}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, file(id));
      syncDirectoryMetadata(options.directory);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  };
  const mutate = (id: string, input: { expectedVersion: number; captureDigest: string }, change: (state: State) => void): MeetingDocumentSnapshot => {
    const initialRecord = recordFor(id);
    if (input.captureDigest !== meetingDocumentCaptureDigest(initialRecord)) throw new Error('Meeting document capture changed.');
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(options.directory).isDirectory() || lstatSync(options.directory).isSymbolicLink()) throw new Error('Meeting document directory is unavailable.');
    return withFileLockSyncStrict(file(id), () => {
      const record = recordFor(id);
      const state = read(id, record);
      if (input.captureDigest !== state.captureDigest) throw new Error('Meeting document capture changed.');
      if (input.expectedVersion !== state.snapshotVersion) throw new Error('Meeting documents changed. Reload before editing.');
      change(state);
      if (state.snapshotVersion >= Number.MAX_SAFE_INTEGER) throw new Error('Meeting document version is exhausted.');
      state.snapshotVersion++;
      // Recheck capture immediately before publication, after all preparation.
      if (meetingDocumentCaptureDigest(recordFor(id)) !== state.captureDigest) throw new Error('Meeting document capture changed.');
      write(id, state);
      return project(state);
    }, { timeoutMs: 0 });
  };
  const getMeetingDocuments = (id: string): MeetingDocumentSnapshot => {
    const record = recordFor(id);
    const state = read(id, record);
    if (meetingDocumentCaptureDigest(recordFor(id)) !== state.captureDigest) throw new Error('Meeting document capture changed.');
    return project(state);
  };
  const attachMeetingDocument = (id: string, value: AttachMeetingDocumentInput): MeetingDocumentSnapshot => {
    const input = attachSchema.parse(value);
    return mutate(id, input, (state) => {
      const previous = input.id ? state.documents.find((document) => document.id === input.id) : undefined;
      if (input.id && !previous) throw new Error('Selected meeting document is unavailable.');
      if (!previous && state.documents.length >= MEETING_DOCUMENT_LIMITS.documents) throw new Error('This meeting already has eight documents.');
      if (previous && previous.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Meeting document revision is exhausted.');
      const timestamp = new Date(now()).toISOString();
      const next: StoredDocument = { id: previous?.id ?? `meeting-doc-${randomUUID()}`, revision: (previous?.revision ?? 0) + 1,
        digest: contentDigest(input.text), title: input.title, text: input.text, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
      const documents = [...state.documents.filter((document) => document.id !== previous?.id), next];
      if (documents.reduce((total, document) => total + document.text.length, 0) > MEETING_DOCUMENT_LIMITS.totalChars) throw new Error('Meeting documents exceed the total text limit.');
      state.documents = documents;
    });
  };
  const removeMeetingDocument = (id: string, value: RemoveMeetingDocumentInput): MeetingDocumentSnapshot => {
    const input = removeSchema.parse(value);
    return mutate(id, input, (state) => {
      const document = state.documents.find((item) => item.id === input.id);
      if (!document || document.revision !== input.revision) throw new Error('Selected meeting document changed or is unavailable.');
      state.documents = state.documents.filter((item) => item.id !== input.id);
    });
  };
  const readMeetingDocuments = (id: string, value: ReadMeetingDocumentsInput): MeetingDocumentReadResult => {
    const input = readSchema.parse(value);
    const snapshot = getMeetingDocuments(id);
    if (input.captureDigest !== snapshot.captureDigest || input.snapshotVersion !== snapshot.snapshotVersion) throw new Error('Meeting document context changed.');
    if (new Set(input.references.map((reference) => reference.id)).size !== input.references.length) throw new Error('Duplicate meeting document reference.');
    const state = read(id, recordFor(id));
    if (state.snapshotVersion !== snapshot.snapshotVersion || state.captureDigest !== snapshot.captureDigest) throw new Error('Meeting document context changed.');
    let remaining = input.maxChars ?? MEETING_DOCUMENT_LIMITS.totalChars;
    const documents = input.references.map((reference): MeetingDocumentContent => {
      const document = state.documents.find((item) => item.id === reference.id && item.revision === reference.revision && item.digest === reference.digest);
      if (!document) throw new Error('Exact meeting document revision is unavailable.');
      const text = slicePlaintext(document.text, remaining);
      remaining -= text.length;
      return { ...metadata(document), text, citation: `meeting-document:${digest([id, state.captureDigest]).slice(0, 16)}:${document.id}:r${document.revision}:sha256:${document.digest}`,
        truncated: text.length !== document.text.length };
    });
    // A pending revocation/edit or reused capture cannot publish a stale read.
    const current = getMeetingDocuments(id);
    if (current.snapshotVersion !== state.snapshotVersion || current.captureDigest !== state.captureDigest) throw new Error('Meeting document context changed.');
    return freeze({ meetingId: id, captureDigest: state.captureDigest, snapshotVersion: state.snapshotVersion, documents });
  };
  return { getMeetingDocuments, attachMeetingDocument, removeMeetingDocument, readMeetingDocuments };
}

export const meetingDocuments = createMeetingDocumentStore({ directory: path.join(BASE_DIR, 'state', 'meeting-documents'), readMeeting: loadRecallMeetingById });
