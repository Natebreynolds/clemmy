import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  approvalResultRelationKey, sameApprovalResultRelation, mergeApprovalResultBinding, mergeApprovalResultRecord, normalizeApprovalResultResponse,
  normalizePendingActionResultRecord, pendingActionPresentationCopy, pendingActionRecordPresentation, retainPendingActionPresentation, renderMarkdown,
  type PendingActionResultLookup, type PendingActionResultRecord, type PendingActionExecutionPresentation,
} from '@clem/chat-engine';
import { api } from '@/lib/api';
import type { ChatMessage } from '@/lib/useChat';

interface ReadState { key: string; record?: PendingActionResultRecord; binding: PendingActionResultLookup | null; reading: boolean; error?: string }

/** A closed question and its action's outcome are separate facts. Reading this
 * card cannot approve, resume or dispatch the action. */
export function ApprovalResult({ approval, observed }: { approval: NonNullable<ChatMessage['approval']>; observed?: PendingActionExecutionPresentation }) {
  const navigate = useNavigate();
  const fromRecord = normalizePendingActionResultRecord(approval.pendingAction);
  const retained = normalizePendingActionResultRecord(approval.resultRecord);
  const candidate = retained && fromRecord ? mergeApprovalResultRecord(retained, fromRecord) ?? retained : retained ?? fromRecord;
  const initial: PendingActionResultRecord | undefined = candidate && candidate.approvalId === approval.approvalId
    && (!approval.pendingActionId || candidate.id === approval.pendingActionId)
    && (!approval.payloadHash || candidate.payloadHash === approval.payloadHash) ? candidate : undefined;
  const lookup: PendingActionResultLookup | null = approval.ownerSessionId && approval.approvalId ? {
    sessionId: approval.ownerSessionId, approvalId: approval.approvalId,
    ...(approval.pendingActionId ?? initial?.id ? { pendingActionId: approval.pendingActionId ?? initial?.id } : {}),
    ...(approval.payloadHash ?? initial?.payloadHash ? { payloadHash: approval.payloadHash ?? initial?.payloadHash } : {}),
    ...(approval.recordUpdatedAt ?? initial?.updatedAt ? { recordUpdatedAt: approval.recordUpdatedAt ?? initial?.updatedAt } : {}),
  } : null;
  const key = lookup ? approvalResultRelationKey(lookup) : JSON.stringify([approval.approvalId, initial?.id, initial?.payloadHash]);
  const initialKey = JSON.stringify(initial);
  const currentKey = useRef(key); currentKey.current = key;
  const request = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const [state, setState] = useState<ReadState>({ key, record: initial, binding: lookup, reading: false });
  const compatible = state.key === key || sameApprovalResultRelation(state.binding, lookup);
  const visible: ReadState = compatible ? state : { key, record: initial, binding: lookup, reading: false };
  useEffect(() => {
    setState(current => {
      const same = current.key === key || sameApprovalResultRelation(current.binding, lookup);
      const record = same && current.record ? (initial ? mergeApprovalResultRecord(current.record, initial) ?? current.record : current.record) : initial;
      const binding = same ? mergeApprovalResultBinding(current.binding, lookup, record) : lookup;
      const revised = current.key !== key || binding?.recordUpdatedAt !== current.binding?.recordUpdatedAt;
      if (revised) { requestSequence.current++; request.current?.abort(); request.current = null; }
      return { key, record, binding, reading: revised ? false : current.reading,
        ...(same && current.error ? { error: current.error } : {}) };
    });
  }, [key, initialKey, lookup?.recordUpdatedAt]);
  useEffect(() => () => { requestSequence.current++; request.current?.abort(); request.current = null; }, []);
  const refresh = async () => {
    if (!visible.binding || request.current) return;
    const controller = new AbortController(); request.current = controller;
    const sequence = ++requestSequence.current;
    const ownsRead = () => currentKey.current === key && requestSequence.current === sequence;
    const expected = visible.binding;
    setState(current => ownsRead() ? { ...current, reading: true, error: undefined } : current);
    const timeout = setTimeout(() => {
      controller.abort();
      if (ownsRead() && request.current === controller) {
        request.current = null;
        setState(current => ownsRead() ? { ...current, reading: false, error: 'Couldn’t refresh this result. Try again.' } : current);
      }
    }, 15_000);
    try {
      const query = new URLSearchParams({ sessionId: expected.sessionId });
      if (expected.pendingActionId) query.set('pendingActionId', expected.pendingActionId);
      if (expected.payloadHash) query.set('payloadHash', expected.payloadHash);
      if (expected.recordUpdatedAt) query.set('recordUpdatedAt', expected.recordUpdatedAt);
      const raw = await api<unknown>(`/api/console/approvals/${encodeURIComponent(expected.approvalId)}/result?${query}`, {
        signal: controller.signal, cache: 'no-store',
      });
      if (controller.signal.aborted || !ownsRead()) return;
      setState(current => {
        if (!ownsRead()) return current;
        const admitted = normalizeApprovalResultResponse(raw, current.binding ?? expected);
        const record = admitted && mergeApprovalResultRecord(current.record, admitted.record);
        if (!admitted || !record) return { ...current, reading: false, error: 'Couldn’t refresh this result. Try again.' };
        return { key: current.key, record, binding: admitted.binding, reading: false };
      });
    } catch {
      if (ownsRead()) setState(current => ownsRead() ? { ...current, reading: false,
        error: 'Couldn’t refresh this result. Try again.' } : current);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) request.current = null;
    }
  };
  const presentation = retainPendingActionPresentation(observed, visible.record ? pendingActionRecordPresentation(visible.record) : null);
  const copy = presentation ? pendingActionPresentationCopy(presentation) : {};
  const labels = { approved: 'Approved', declined: 'Declined', changed: 'Change requested', expired: 'Expired', cancelled: 'Approval closed' };
  const phases = { queued: 'Waiting to run', running: 'Running', executed: 'Action completed', failed: 'Needs a look',
    rejected: 'Action declined', expired: 'Action expired', cancelled: 'Action cancelled', uncertain: 'Outcome not confirmed' };
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="break-words text-body text-fg">{approval.subject}</span>
        <span className="text-caption text-muted">{approval.resolution ? labels[approval.resolution] : 'Approval recorded'}</span>
      </div>
      {presentation?.mode === 'durable' && <div className="mt-2 min-w-0" role="status">
        <p className="text-caption font-semibold text-muted">{phases[presentation.phase]}</p>
        {copy.note && <div className="chat-prose mt-1 min-w-0 text-body text-fg" onClick={event => {
          const link = (event.target as Element).closest?.('a[data-app-place]');
          const href = link?.getAttribute('href');
          if (href) { event.preventDefault(); navigate(href); }
        }} dangerouslySetInnerHTML={{ __html: renderMarkdown(copy.note, { workspaceLinks: false, appPlaceLinks: 'desktop' }) }} />}
        {copy.details && <details className="mt-2 min-w-0 text-caption text-muted">
          <summary className="cursor-pointer">Execution details</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-caption text-fg">{copy.details}</pre>
        </details>}
      </div>}
      {lookup && <button type="button" className="mt-2 text-caption font-medium text-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-60"
        disabled={visible.reading} onClick={() => { void refresh(); }}>{visible.reading ? 'Reading result…' : 'Refresh result'}</button>}
      {visible.error && <p className="mt-1 text-caption text-muted" role="status">{visible.error}</p>}
    </div>
  );
}
