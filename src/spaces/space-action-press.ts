/** Exact one-click authority between the trusted Workspace parent and the
 * existing approval executor. Authored iframe RPC has no issuance operation.
 * This proves an admitted parent gesture, not physical input against a fully
 * credentialed owner HTTP client capable of impersonating that trusted UI. */
import { get as getApproval, withApprovalControlCommit } from '../runtime/harness/approval-registry.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { actionApprovalSnapshot, actionApprovalSnapshotsEqual, parseActionApprovalSnapshot } from './space-action-authority.js';
import { SPACE_ACTION_V3_AUTHORIZATION_FIELD, prepareSpaceActionV3Approval } from './space-action-v3-authority.js';
import { enqueueSpaceActionApproval, executeApprovedSpaceAction, readSpaceActionPressResult,
  SPACE_ACTION_TOOL, SPACE_BUTTON_PRESS_RESOLVER, spaceActionNeedsApproval } from './space-action-gate.js';
import { spaceStore } from './store.js';
import { listNotes } from './data-store.js';
import { newSpaceActionPressBinding, parseSpaceActionPressToken, readSpaceActionPressBinding,
  spaceActionPressDigest, spaceActionPressInputSchema, spaceActionPressSecretMatches,
  workspacePressViewRevision } from './space-action-press-binding.js';

type PressInput = import('zod').infer<typeof spaceActionPressInputSchema>;
export class SpaceActionPressError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 = 409,
    public readonly effectState: 'not_started' | 'uncertain' = 'not_started') { super(message); }
}
function boundedInput(input: unknown): PressInput {
  const parsed = spaceActionPressInputSchema.safeParse(input);
  if (!parsed.success) throw new SpaceActionPressError('This button request could not be read.', 400);
  if (Buffer.byteLength(JSON.stringify(parsed.data.args), 'utf8') > 64 * 1024) {
    throw new SpaceActionPressError('This button request is too large.', 400);
  }
  return parsed.data;
}

/** Same intended effect across documents. A cosmetic page revision or reload
 * cannot turn an unconfirmed send into permission to send it again. */
function assertNoUnresolvedPress(slug: string, actionId: string, intentDigest: string, exceptApprovalId?: string): void {
  const outcomes = new Map<string, string>();
  for (const note of listNotes(slug, Number.MAX_SAFE_INTEGER)) {
    if (typeof note.meta?.approvalId === 'string' && ['executed', 'failed', 'uncertain'].includes(String(note.meta?.status))) {
      outcomes.set(note.meta.approvalId, String(note.meta.status));
    }
  }
  const rows = openEventLog().prepare(`SELECT approval_id FROM pending_approvals
    WHERE session_id = ? AND tool = ? AND json_valid(args_json)
      AND json_extract(args_json, '$.actionId') = ?
      AND (status = 'pending' OR (status = 'resolved' AND resolution = 'approved'))`)
    .iterate(`space-${slug}`, SPACE_ACTION_TOOL, actionId) as Iterable<{ approval_id: string }>;
  for (const item of rows) {
    if (item.approval_id === exceptApprovalId) continue;
    const row = getApproval(item.approval_id);
    if (!row) continue;
    const binding = readSpaceActionPressBinding(row.args);
    if (binding && binding.intentDigest !== intentDigest) continue;
    if (!binding) {
      const snapshot = parseActionApprovalSnapshot(row.args?.actionSnapshot);
      const caller = row.args?.callerArgs;
      if (snapshot && caller && typeof caller === 'object' && !Array.isArray(caller)) {
        const legacyIntent = spaceActionPressDigest({ workspaceId: slug, actionId: snapshot.id,
          operation: snapshot.composioSlug, effectiveArgs: { ...(snapshot.argsTemplate ?? {}), ...caller } });
        if (legacyIntent !== intentDigest) continue;
      }
      // A same-action historical row without enough retained target evidence
      // cannot be treated as a safely completed or unrelated effect.
    }
    if (row.status === 'pending' && Date.parse(row.expiresAt) <= Date.now()) continue;
    const outcome = row.status === 'resolved' ? outcomes.get(row.approvalId) : undefined;
    if (!outcome || outcome === 'uncertain') {
      throw new SpaceActionPressError('This exact button action is already pending or has an unconfirmed effect. Check its original result before pressing again.', 409, 'uncertain');
    }
  }
}

export function prepareSpaceActionPress(slug: string, input: unknown):
  | { kind: 'direct' }
  | { kind: 'prepared'; pressToken: string; expiresAt: number } {
  const parsed = boundedInput(input);
  const rec = spaceStore.get(slug);
  if (!rec) throw new SpaceActionPressError('Workspace not found.', 404);
  if (rec.status !== 'active' || rec.manifestErrors?.length) throw new SpaceActionPressError('Review the current Workspace before using its button.');
  if (workspacePressViewRevision(rec) !== parsed.expectedViewRevision) throw new SpaceActionPressError('The page changed. Review its current button before trying again.');
  const action = rec.actions.find(entry => entry.id === parsed.actionId);
  if (!action) throw new SpaceActionPressError('This button action no longer exists.', 404);
  // These operations keep their established authorization and workflow rules.
  // Legacy arbitrary runner code cannot gain a new approval bypass here.
  if (!spaceActionNeedsApproval(action) || !action.composioSlug?.trim() || action.runner?.trim()) return { kind: 'direct' };
  const intentDigest = spaceActionPressDigest({ workspaceId: slug, actionId: action.id,
    operation: action.composioSlug, effectiveArgs: { ...(action.argsTemplate ?? {}), ...parsed.args } });
  const { secret, binding } = newSpaceActionPressBinding(parsed.documentId, parsed.expectedViewRevision, intentDigest);
  const registered = withApprovalControlCommit(() => {
    assertNoUnresolvedPress(slug, action.id, intentDigest);
    return enqueueSpaceActionApproval(rec, action, parsed.args, { presented: false, pressBinding: binding });
  });
  const row = getApproval(registered.approvalId);
  if (!row || !readSpaceActionPressBinding(row.args)) throw new SpaceActionPressError('This button could not prepare its exact action.');
  return { kind: 'prepared', pressToken: `${row.approvalId}.${secret}`, expiresAt: Date.parse(row.expiresAt) };
}

export async function consumeSpaceActionPress(slug: string, input: unknown, pressToken: unknown) {
  const parsed = boundedInput(input);
  const token = parseSpaceActionPressToken(pressToken);
  if (!token) throw new SpaceActionPressError('This button approval is missing or invalid.');
  const accepted = withApprovalControlCommit(resolveDecision => {
    const row = getApproval(token.approvalId);
    const binding = row ? readSpaceActionPressBinding(row.args) : null;
    if (!row || row.tool !== SPACE_ACTION_TOOL || row.sessionId !== `space-${slug}` || !binding
      || !spaceActionPressSecretMatches(binding, token.secret)
      || binding.documentId !== parsed.documentId || binding.viewRevision !== parsed.expectedViewRevision
      || row.args?.spaceSlug !== slug || row.args?.actionId !== parsed.actionId
      || spaceActionPressDigest(row.args?.callerArgs) !== spaceActionPressDigest(parsed.args)) {
      throw new SpaceActionPressError('This button approval does not match the requested action.');
    }
    // Replays address the original approved occurrence and cannot create one.
    if (row.status === 'resolved' && row.resolution === 'approved' && row.resolver === SPACE_BUTTON_PRESS_RESOLVER) return { row, newlyAccepted: false };
    if (row.status !== 'pending' || Date.parse(row.expiresAt) <= Date.now()) {
      throw new SpaceActionPressError('This button approval expired or was already decided. Press its current button again.');
    }
    const rec = spaceStore.get(slug);
    const action = rec?.actions.find(entry => entry.id === parsed.actionId);
    const savedAction = parseActionApprovalSnapshot(row.args?.actionSnapshot);
    if (!rec || rec.status !== 'active' || rec.manifestErrors?.length || !action || !savedAction
      || workspacePressViewRevision(rec) !== binding.viewRevision
      || !actionApprovalSnapshotsEqual(actionApprovalSnapshot(rec, action), savedAction)) {
      throw new SpaceActionPressError('The page or button changed. Review its current action before trying again.');
    }
    const exact = prepareSpaceActionV3Approval({ slug, action, callerArgs: parsed.args });
    if (!exact.ok || !exact.value.contract
      || spaceActionPressDigest(exact.value.contract) !== spaceActionPressDigest(row.args?.[SPACE_ACTION_V3_AUTHORIZATION_FIELD])) {
      throw new SpaceActionPressError('This button’s connection or tool changed. Review the current action before trying again.');
    }
    assertNoUnresolvedPress(slug, action.id, binding.intentDigest, row.approvalId);
    const decided = resolveDecision(row.approvalId, 'approved', SPACE_BUTTON_PRESS_RESOLVER);
    if (!decided.ok || !decided.row) throw new SpaceActionPressError('This button approval is no longer available.');
    return { row: decided.row, newlyAccepted: true };
  });
  const previous = readSpaceActionPressResult(accepted.row);
  if (previous.recorded || !accepted.newlyAccepted) return previous;
  // Existing execution claims own retries, cross-process recovery and uncertain
  // effects. The press token is not a second dispatch or replacement slot.
  await executeApprovedSpaceAction(accepted.row);
  return readSpaceActionPressResult(accepted.row);
}
