/** A saved Space read is a source of metadata discovery, not a chat message
 * or permission to write. Reopen its exact declaration at every publication
 * boundary; edits, archive and removal invalidate the pending preparation. */
import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, createSession, getSession, listEvents } from '../runtime/harness/eventlog.js';
import { spaceStore, type SpaceDataSource } from './store.js';
import { canonicalWorkspaceJson } from './workspace-set-data-contract.js';

const EVENT = 'workspace_read_preparation_started' as const;
const hash = (value: unknown) => createHash('sha256').update(canonicalWorkspaceJson(value)).digest('hex');
export interface SpaceReadPreparationSource {
  sessionId: string;
  sourceUserSeq: number;
  acceptedInput: string;
}

function currentDeclaration(slug: string, sourceId: string, cause: string) {
  const space = spaceStore.get(slug);
  if (!space || space.status === 'archived' || (cause === 'scheduled' && space.status !== 'active')
    || space.manifestErrors?.length) return null;
  const source = space.dataSources.find(row => row.id === sourceId);
  if (!source?.composioSlug?.trim() || source.runner?.trim() || source.cliArgv?.length) return null;
  return source;
}

function textFor(slug: string, source: SpaceDataSource): string {
  // Structural saved fields only. No model-written prose becomes an account
  // nomination, and provider arguments are not account-routing instructions.
  return canonicalWorkspaceJson({ kind: 'workspace_read', workspace: slug, source: source.id,
    operation: source.composioSlug!.trim().toUpperCase(), account: source.composioAccountId?.trim() || null });
}

export function beginSpaceReadPreparation(input: {
  slug: string; sourceId: string; toolSlug: string; accountId?: string;
  args: Record<string, unknown>; cause: string;
}): SpaceReadPreparationSource {
  const source = currentDeclaration(input.slug, input.sourceId, input.cause);
  if (!source || source.composioSlug!.trim().toUpperCase() !== input.toolSlug.trim().toUpperCase()
    || (source.composioAccountId?.trim() || '') !== (input.accountId?.trim() || '')
    || hash(source.composioArgs ?? {}) !== hash(input.args)) {
    throw new Error('workspace read declaration changed before preparation');
  }
  const sessionId = `workspace:${input.slug}`;
  if (!getSession(sessionId)) createSession({ id: sessionId, kind: 'workflow', title: `Workspace ${input.slug} durable reads` });
  const acceptedInput = textFor(input.slug, source);
  const event = appendEvent({ sessionId, turn: 0, role: 'system', type: EVENT, data: {
    version: 1, workspaceId: input.slug, sourceId: input.sourceId,
    occurrenceId: randomUUID(), declarationDigest: hash(source), acceptedInput, cause: input.cause,
  } });
  return { sessionId, sourceUserSeq: event.seq, acceptedInput };
}

export function readSpaceReadPreparation(sessionId: string, sourceUserSeq: number) {
  try {
    const event = listEvents(sessionId, { sinceSeq: sourceUserSeq - 1, throughSeq: sourceUserSeq,
      types: [EVENT], limit: 1 })[0];
    if (!event || event.seq !== sourceUserSeq || event.role !== 'system' || event.data.version !== 1
      || typeof event.data.workspaceId !== 'string' || typeof event.data.sourceId !== 'string'
      || typeof event.data.occurrenceId !== 'string' || !event.data.occurrenceId
      || typeof event.data.cause !== 'string'
      || sessionId !== `workspace:${event.data.workspaceId}`) return null;
    const source = currentDeclaration(event.data.workspaceId, event.data.sourceId, event.data.cause);
    if (!source || event.data.declarationDigest !== hash(source)
      || event.data.acceptedInput !== textFor(event.data.workspaceId, source)) return null;
    return { sessionId, sourceUserSeq, acceptedInput: textFor(event.data.workspaceId, source),
      operationId: source.composioSlug!.trim().toUpperCase(), accountId: source.composioAccountId?.trim() || null,
      occurrenceId: event.data.occurrenceId };
  } catch { return null; }
}
