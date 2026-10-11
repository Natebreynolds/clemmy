import type { ChatAttachment, ComposerMode } from '@clem/chat-engine';
import { api, type ApiError } from './api';
import type { SessionFile, SessionFileRef } from './session-files';

/** A deliberate selection of the bytes the owner previewed, never a live path. */
export interface SelectedFileContext { ref: SessionFileRef; revision: string }
export interface FailedFileRequest {
  messageId: string;
  text: string;
  attachmentIds: string[];
  context?: SelectedFileContext | null;
  contextAttachment?: ChatAttachment;
}
export interface MobileDraft {
  text: string;
  context: SelectedFileContext | null;
  prepared?: { key: string; attachment: ChatAttachment };
  failed?: FailedFileRequest;
  stagedAttachments?: MobileStagedAttachment[];
  agentChoice?: MobileDraftChoice;
  projectChoice?: MobileDraftChoice;
  composerMode?: ComposerMode;
}
export interface MobileStagedAttachment extends ChatAttachment { uploading?: boolean; error?: string }
export type MobileChatChoice = { id: string; name: string } | null;
export interface MobileDraftChoice { value: MobileChatChoice; pending: boolean }

/** Unsent choices (including Clem / no project) take precedence on reopening. */
export function reconcileDraftChoice(saved: MobileDraftChoice | undefined, server: MobileChatChoice): MobileDraftChoice {
  return saved?.pending && (saved.value?.id ?? null) !== (server?.id ?? null) ? saved : { value: server, pending: false };
}
/** A slow switch cannot erase a newer choice made while it was being applied. */
export function settleDraftChoice(saved: MobileDraftChoice | undefined, requestedId: string | null, server: MobileChatChoice): MobileDraftChoice {
  return saved?.pending && (saved.value?.id ?? null) !== requestedId ? saved : { value: server, pending: false };
}

export function fileContextKey(context: SelectedFileContext): string {
  return JSON.stringify([context.ref.sessionId, context.ref.fileId, context.revision]);
}

export function selectedFileContext(sessionId: string, file: SessionFile): SelectedFileContext | null {
  if (!file.fileId || !/^sha256:[a-f0-9]{64}$/.test(file.revision ?? '')) return null;
  return { ref: { sessionId, fileId: file.fileId, name: file.name, folder: file.folder }, revision: file.revision! };
}

/** Memory belongs to this window. It is not persisted or shared with another device. */
export class MobileDraftStore {
  private drafts = new Map<string, MobileDraft>();
  private aliases = new Map<string, string>();
  private listeners = new Set<() => void>();
  private epoch = 0;
  constructor(private readonly releasePreview = (url: string) => URL.revokeObjectURL(url)) {}
  get generation(): number { return this.epoch; }
  /** Async owners keep this token across navigation, but never across sign-out. */
  patchInGeneration(scope: string, generation: number, patch: Partial<MobileDraft>): MobileDraft | null {
    return generation === this.epoch ? this.patch(scope, patch) : null;
  }
  private resolve(scope: string): string {
    const path = new Set<string>();
    let owner = scope;
    while (this.aliases.has(owner) && !path.has(owner)) {
      path.add(owner);
      owner = this.aliases.get(owner)!;
    }
    for (const previous of path) this.aliases.set(previous, owner);
    return owner;
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private releaseRemoved(previous: MobileDraft | undefined, next?: MobileDraft): void {
    const kept = new Set(next?.stagedAttachments?.map(file => file.previewUrl));
    for (const url of new Set(previous?.stagedAttachments?.map(file => file.previewUrl))) {
      if (url && !kept.has(url)) this.releasePreview(url);
    }
  }
  read(scope: string, initialText = ''): MobileDraft {
    scope = this.resolve(scope);
    const saved = this.drafts.get(scope);
    if (saved) {
      if (!saved.text && initialText && !saved.failed) { const next = { ...saved, text: initialText }; this.drafts.set(scope, next); return next; }
      return saved;
    }
    const draft = { text: initialText, context: null };
    this.drafts.set(scope, draft);
    return draft;
  }
  patch(scope: string, patch: Partial<MobileDraft>): MobileDraft {
    const previous = this.read(scope);
    const next = { ...previous, ...patch };
    this.releaseRemoved(previous, next);
    this.drafts.set(this.resolve(scope), next);
    this.changed();
    return next;
  }
  select(scope: string, context: SelectedFileContext): MobileDraft {
    const current = this.read(scope);
    return this.patch(scope, { context, ...(current.context && fileContextKey(current.context) === fileContextKey(context) ? {} : { prepared: undefined }) });
  }
  move(from: string, to: string): void {
    if (from === to || this.aliases.has(from)) return;
    to = this.resolve(to);
    if (from === to) return;
    const draft = this.drafts.get(from);
    if (draft) { this.releaseRemoved(this.drafts.get(to), draft); this.drafts.set(to, draft); }
    this.drafts.delete(from);
    this.aliases.set(from, to);
    this.changed();
  }
  clear(): void {
    for (const draft of this.drafts.values()) this.releaseRemoved(draft);
    this.drafts.clear(); this.aliases.clear(); this.epoch += 1; this.changed();
  }
}
export const mobileDrafts = new MobileDraftStore();
let draftSequence = 0;
export const newMobileDraftScope = () => `new:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${++draftSequence}`}`;

/** Promote a new draft once. Later Stop/Continue heads retain its root owner. */
export function mobileConversationDraftOwner(conversationId: string | null, executionSessionId: string): { conversationId: string; scope: string } {
  const root = conversationId ?? executionSessionId;
  return { conversationId: root, scope: `chat:${root}` };
}

export async function prepareSelectedFile(context: SelectedFileContext): Promise<ChatAttachment> {
  const result = await api<{ ok: true; id: string; name: string }>(`/m/api/chat/sessions/${encodeURIComponent(context.ref.sessionId)}/file/context`, {
    method: 'POST', body: JSON.stringify({ fileId: context.ref.fileId, expectedRevision: context.revision }),
  });
  if (!result.ok || !result.id) throw new Error('The selected file could not be prepared. Try again.');
  return { id: result.id, name: result.name || context.ref.name, kind: 'file' };
}

export function fileContextProblem(error: unknown): string {
  const failure = error as ApiError;
  const code = (failure?.body as { error?: string } | undefined)?.error;
  if (code === 'FILE_CHANGED') return 'This file changed after you opened it. Remove this context and reopen the file to choose the new version.';
  if (failure?.status === 404) return 'The selected file is no longer available. Remove it or reopen the file and try again.';
  if (failure?.status === 413) return 'This file is too large to attach. Remove it to send your message without it.';
  if (failure?.status === 422) return 'Clem could not read this file. Your message and selected context are still here.';
  if (failure?.offline) return 'Your computer is unreachable. Reconnect, then send again. Your message and file context are still here.';
  return error instanceof Error ? error.message : 'The file could not be prepared. Your message is still here. Try again.';
}

export interface DraftSendResult { accepted: boolean; failedMessageId?: string; notAdmitted?: boolean }
export function fileSendWasNotAdmitted(error: unknown): boolean {
  const failure = error as ApiError;
  return failure?.status === 409 && (failure.body as { error?: string } | undefined)?.error === 'ATTACHMENTS_REQUIRE_IDLE_CHAT';
}

/** Settling an older request never removes a different, newer selection. */
export function settledFileRequest(current: MobileDraft, request: FailedFileRequest): Partial<MobileDraft> {
  if (current.failed?.messageId !== request.messageId) return {};
  const patch: Partial<MobileDraft> = { failed: undefined };
  if (current.stagedAttachments) {
    const sent = new Set(request.attachmentIds);
    patch.stagedAttachments = current.stagedAttachments.filter(file => !sent.has(file.id));
  }
  const sameContext = Boolean(current.context && request.context && fileContextKey(current.context) === fileContextKey(request.context)
    && current.prepared?.attachment.id === request.contextAttachment?.id);
  if (sameContext) {
    patch.context = null;
    patch.prepared = undefined;
  }
  if ((sameContext || (!current.context && !request.context)) && current.text.trim() === request.text) patch.text = '';
  return patch;
}
export function assertDraftCurrent(current: () => boolean): void {
  if (!current()) throw new Error('The conversation or selected file changed. Your draft is still saved here.');
}

/** A late agent/project response cannot update or send through a newer owner. */
export async function currentDraftStep<T>(current: () => boolean, step: () => Promise<T>): Promise<T> {
  assertDraftCurrent(current);
  const result = await step();
  assertDraftCurrent(current);
  return result;
}
/** A failed request keeps its exact attachment and retry identity. Preparation
 * may finish after navigation; that must never post into the next screen. */
export async function submitFileDraft(input: {
  draft: MobileDraft;
  text: string;
  attachments: ChatAttachment[];
  busy: () => boolean;
  current: () => boolean;
  /** The same window/account owner, even when its screen has unmounted. */
  latest?: () => MobileDraft | null;
  prepare: (context: SelectedFileContext) => Promise<ChatAttachment>;
  remember: (patch: Partial<MobileDraft>) => void;
  send: (text: string, attachments: ChatAttachment[]) => Promise<DraftSendResult>;
  retry: (messageId: string) => Promise<DraftSendResult>;
  discard?: (messageId: string) => void;
}): Promise<boolean> {
  const { draft } = input;
  if (!input.current()) return false;
  if (input.attachments.length + (draft.context ? 1 : 0) > 10) throw new Error('A message can include up to 10 files. Remove one attachment before sending this selected file.');
  if (input.busy() && (draft.context || input.attachments.length)) throw new Error('Files can be sent with the next message after Clem finishes. Your draft is still here.');
  let files = [...input.attachments];
  let contextAttachment: ChatAttachment | undefined;
  if (draft.failed) {
    const selected = draft.context && draft.prepared?.key === fileContextKey(draft.context) ? draft.prepared.attachment : null;
    const retryIds = [...files.filter(file => file.id !== selected?.id).map(file => file.id), ...(selected ? [selected.id] : [])];
    if (draft.failed.text !== input.text || JSON.stringify(draft.failed.attachmentIds) !== JSON.stringify(retryIds)
      || (draft.context && !selected)) {
      throw new Error('The earlier message was not confirmed. Retry it or discard its failed message before sending an edited request.');
    }
  }
  if (draft.context) {
    const key = fileContextKey(draft.context);
    // Only the exact uncertain request reuses its immutable attachment. A new
    // admission rechecks the original revision even after a local busy race.
    const attachment = draft.failed && draft.prepared?.key === key ? draft.prepared.attachment : await input.prepare(draft.context);
    if (!input.current()) return false;
    input.remember({ prepared: { key, attachment } });
    files = [...files.filter(file => file.id !== attachment.id), attachment];
    contextAttachment = attachment;
  }
  if (input.busy() && files.length) throw new Error('Clem started working while the file was prepared. Send it when this turn finishes.');
  const ids = files.map(file => file.id);
  if (draft.failed && (draft.failed.text !== input.text || JSON.stringify(draft.failed.attachmentIds) !== JSON.stringify(ids))) {
    throw new Error('The earlier message was not confirmed. Retry it or discard its failed message before sending an edited request.');
  }
  const result = draft.failed ? await input.retry(draft.failed.messageId) : await input.send(input.text, files);
  if (!result.accepted) {
    if (result.notAdmitted) {
      // This typed refusal proves there is no uncertain admission to replay.
      // Keep the draft, remove the refused echo, and revalidate on next Send.
      if (result.failedMessageId) input.discard?.(result.failedMessageId);
      input.remember({ failed: undefined });
      throw new Error('Clem started working before this message was accepted. Your draft and file context are still here. Send again after this turn finishes.');
    }
    if (result.failedMessageId) input.remember({ failed: { messageId: result.failedMessageId, text: input.text, attachmentIds: ids,
      context: draft.context, contextAttachment } });
    throw new Error('Your message was not confirmed. Send again to retry the same request; your draft and file context are still here.');
  }
  if (input.latest) {
    const latest = input.latest();
    // A deliberate reselect of the same file creates another context object.
    // Do not clear it just because its recorded file/revision key is equal.
    if (latest && latest.context === draft.context && (!draft.context || latest.prepared?.attachment.id === contextAttachment?.id)) {
      input.remember({ context: null, prepared: undefined,
        ...(latest.failed?.messageId === draft.failed?.messageId ? { failed: undefined } : {}) });
    }
  } else if (input.current()) input.remember({ context: null, prepared: undefined, failed: undefined });
  return true;
}
