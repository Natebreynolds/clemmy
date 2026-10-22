/** A quiet, read-only explanation beneath one settled reply. Records load
 * only when opened; no polling, model calls, or memory mutations. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Brain, ChevronDown, Cpu, Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  getTaskDetails, plainRecordName, recordedCount, recordedDuration, taskAuxiliaryIdentity, taskAuxiliaryPurpose, taskAuxiliaryStatus, taskModelIdentity, taskModelProvider, taskModelRole,
  taskMemorySections, taskProvidedMemoryLinks, taskModelStatus, taskToolEvidence, taskToolName, taskToolReason, taskToolStatus, taskUsageNotes, taskUsageRoles,
  type TaskHandlingDetails,
} from '@/lib/task-details';
import { cn } from '@/lib/cn';
import { memoryFactHref } from '@/lib/memory-fact-links';

type LoadState = { kind: 'idle' | 'loading' | 'error' } | { kind: 'ready'; detail: TaskHandlingDetails };

export function TaskDetails({ sessionId, sourceUserSeq }: { sessionId: string; sourceUserSeq: number }) {
  if (!sessionId.trim() || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return null;
  return <TaskDetailsForSource key={JSON.stringify([sessionId, sourceUserSeq])} sessionId={sessionId} sourceUserSeq={sourceUserSeq} />;
}

function TaskDetailsForSource({ sessionId, sourceUserSeq }: { sessionId: string; sourceUserSeq: number }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const pending = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => () => {
    if (pending.current) {
      clearTimeout(pending.current.timer);
      pending.current.controller.abort();
    }
  }, []);

  const load = () => {
    if (pending.current) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      pending.current = null;
      setState({ kind: 'error' });
    }, 20_000);
    pending.current = { controller, timer };
    setState({ kind: 'loading' });
    void getTaskDetails(sessionId, sourceUserSeq, controller.signal)
      .then((detail) => { if (!controller.signal.aborted) setState({ kind: 'ready', detail }); })
      .catch(() => { if (!controller.signal.aborted) setState({ kind: 'error' }); })
      .finally(() => {
        clearTimeout(timer);
        if (pending.current?.controller === controller) pending.current = null;
      });
  };

  return (
    <div className="mt-2 min-w-0 max-w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => { setOpen(!open); if (!open && state.kind === 'idle') load(); }}
        className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-sm px-1 text-left text-small font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0', !open && '-rotate-90')} aria-hidden />
        <span>How Clem handled this</span>
      </button>
      {open && (
        <div id={panelId} className="min-w-0 max-w-full border-t border-border pt-4" aria-busy={state.kind === 'loading'}>
          {(state.kind === 'idle' || state.kind === 'loading') && (
            <div role="status" className="space-y-2 pb-3">
              <span className="sr-only">Reading this reply’s records…</span>
              <div className="skeleton h-4 w-40 rounded-sm" aria-hidden />
              <div className="skeleton h-3 w-3/4 max-w-80 rounded-sm" aria-hidden />
            </div>
          )}
          {state.kind === 'error' && (
            <div className="pb-3 text-small">
              <p role="status" className="text-muted">Couldn’t read this reply’s details. Older replies may not have these records.</p>
              <button type="button" onClick={load} className="mt-2 min-h-9 rounded-sm px-1 font-semibold text-primary-ink underline underline-offset-4 hover:text-primary-ink-hover">Try reading again</button>
            </div>
          )}
          {state.kind === 'ready' && <TaskDetailsContent detail={state.detail} />}
        </div>
      )}
    </div>
  );
}

function DetailSection({ title, icon: Icon, children }: { title: string; icon: typeof Brain; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="flex items-center gap-2 text-small font-semibold text-fg"><Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />{title}</h3>
      {children}
    </section>
  );
}

/** Exported separately so a controlled UI fixture can render retained
 * evidence without contacting any live session. */
export function TaskDetailsContent({ detail }: { detail: TaskHandlingDetails }) {
  const { tools, models, memory, usage } = detail;
  const sections = taskMemorySections(detail);
  const providedLinks = taskProvidedMemoryLinks(detail);
  const usageRoles = taskUsageRoles(detail);
  const hasMemory = Boolean(memory.provided?.manifest.length || memory.recall.some((run) => run.refs.length));
  return (
    <div className="min-w-0 space-y-5 pb-2 text-small">
      <DetailSection title="Model route details" icon={Cpu}>
        <p className="text-caption text-muted">These are recorded model selections. Some helper requests have separate records, and not every call has route details.</p>
        {models.length === 0 ? <p className="text-muted">No model route details were retained for this reply.</p> : (
          <ul className="divide-y divide-border">
            {models.map((row, index) => {
              const model = taskModelIdentity(row);
              const provider = taskModelProvider(row);
              const duration = recordedDuration(row.durationMs);
              return (
                <li key={`${row.callId}:${index}`} className="min-w-0 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                    <span className="min-w-0 break-words font-medium text-fg [overflow-wrap:anywhere]">{model.name}</span>
                    <span className={row.status === 'failed' ? 'text-caption text-danger' : 'text-caption text-muted'}>{taskModelStatus(row)}</span>
                  </div>
                  <p className="break-words text-caption text-muted [overflow-wrap:anywhere]">{taskModelRole(row.role)} · {provider.label}{duration ? ` · ${duration} call time` : ''}</p>
                  {!model.confirmed && <p className="text-caption text-muted">{model.note}</p>}
                  {provider.note && <p className="text-caption text-muted">{provider.note}</p>}
                  {row.fallbackToModel && <p className="break-words text-caption text-muted [overflow-wrap:anywhere]">Backup route: {row.fallbackToModel}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {detail.limits.modelsTruncated && <p className="text-caption text-muted">Showing part of the retained model route details.</p>}
      </DetailSection>

      {detail.auxiliaryModels !== undefined && <DetailSection title="Other recorded model requests" icon={Cpu}>
        <p className="text-caption text-muted">These request records are separate from model selections. A parsed result does not mean a review passed. Call totals come from the usage record below.</p>
        {detail.auxiliaryModels.length === 0 ? <p className="text-muted">No additional model request details were retained.</p> : <ul className="divide-y divide-border">
          {detail.auxiliaryModels.map((row) => {
            const model = taskAuxiliaryIdentity(row);
            const duration = recordedDuration(row.durationMs);
            return <li key={JSON.stringify([row.callId, row.attemptId, row.physicalAttempt])} className="min-w-0 py-2 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <span className="min-w-0 break-words font-medium text-fg [overflow-wrap:anywhere]">{model.name}</span>
                <span className={row.status === 'failed' ? 'text-caption text-danger' : 'text-caption text-muted'}>{taskAuxiliaryStatus(row)}</span>
              </div>
              <p className="break-words text-caption text-muted [overflow-wrap:anywhere]">{taskAuxiliaryPurpose(row)}</p>
              <p className="break-words text-caption text-muted [overflow-wrap:anywhere]">Through Jev · {model.note}{duration ? ` · ${duration} request time` : ''}</p>
              {model.requested && <p className="break-words text-caption text-muted [overflow-wrap:anywhere]">Requested model: {model.requested}</p>}
              <p className="text-caption text-muted">{row.usage === 'reported' ? 'Response included usage. The request meter is separate.' : 'Response usage wasn’t confirmed.'}</p>
            </li>;
          })}
        </ul>}
        {detail.limits.auxiliaryModelsTruncated && <p className="text-caption text-muted">Showing part of the retained helper request records.</p>}
      </DetailSection>}

      <DetailSection title="Recorded tool activity" icon={Wrench}>
        {tools.length === 0 ? <p className="text-muted">No tool calls were retained for this reply.</p> : (
          <ul className="divide-y divide-border">
            {tools.map((row, index) => {
              const reason = taskToolReason(row);
              const preferenceHref = row.selection?.kind === 'owner_preference' ? memoryFactHref(row.selection.factId) : null;
              return (
                <li key={`${row.callId}:${index}`} className="min-w-0 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                    <span className="min-w-0 break-words font-medium text-fg [overflow-wrap:anywhere]">{taskToolName(row)}</span>
                    <span className={row.status === 'failed' ? 'text-caption text-danger' : 'text-caption text-muted'}>{taskToolStatus(row)}</span>
                  </div>
                  <p className="break-words text-caption text-muted [overflow-wrap:anywhere]">{reason || 'Choice reason not recorded'}</p>
                  {preferenceHref && <Link to={preferenceHref} className="inline-flex min-h-9 items-center rounded-sm text-caption font-medium text-primary-ink underline underline-offset-4 hover:text-primary-ink-hover">View this preference</Link>}
                  <p className="text-caption text-muted">{taskToolEvidence(row)}</p>
                  {row.effect && <p className="break-words text-caption text-muted [overflow-wrap:anywhere]">Effect: {plainRecordName(row.effect)}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {detail.limits.toolsTruncated && <p className="text-caption text-muted">Showing part of the retained tool activity.</p>}
      </DetailSection>

      <DetailSection title="Memory made available" icon={Brain}>
        {!hasMemory ? <p className="text-muted">No memory details were retained for this reply.</p> : (
          <>
            <p className="text-caption text-muted">This is what Clem was given. It does not, by itself, show what influenced her choices.</p>
            {sections.length > 0 && (
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-fg" aria-label="Memory context provided">
                {sections.map((section) => <li key={section} className="max-w-full break-words [overflow-wrap:anywhere]">{section}</li>)}
              </ul>
            )}
            {providedLinks.length > 0 && <div>
              <p className="text-caption text-muted">Saved memories made available</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {providedLinks.map(({ id, href }, index) => <Link key={id} to={href} className="inline-flex min-h-9 items-center rounded-sm text-caption font-medium text-primary-ink underline underline-offset-4 hover:text-primary-ink-hover">{providedLinks.length === 1 ? 'View saved memory' : `View saved memory ${index + 1}`}</Link>)}
              </div>
            </div>}
            {memory.recall.map((run) => (
              <ul key={run.id} className="space-y-2" aria-label="Recorded memory recall">
                {run.refs.map((ref, index) => (
                  <li key={`${ref.type}:${ref.id}:${index}`} className="min-w-0">
                    <p className="break-words text-fg [overflow-wrap:anywhere]">{ref.text || `${plainRecordName(ref.type)} · content not retained`}</p>
                    <p className="text-caption text-muted">{ref.outcome === 'used' ? 'Recorded as used' : ref.outcome === 'not_useful' ? 'Recorded as not useful' : 'Offered to Clem'}</p>
                    {ref.type === 'fact' && memoryFactHref(ref.id) && <Link to={memoryFactHref(ref.id)!} className="inline-flex min-h-9 items-center rounded-sm text-caption font-medium text-primary-ink underline underline-offset-4 hover:text-primary-ink-hover">View this memory</Link>}
                  </li>
                ))}
              </ul>
            ))}
          </>
        )}
        {detail.limits.memoryTruncated && <p className="text-caption text-muted">Showing part of the retained memory record.</p>}
      </DetailSection>

      <section className="min-w-0 space-y-2" aria-label="Recorded usage for this request">
        <h3 className="text-small font-semibold text-fg">Recorded usage for this request</h3>
        {usage && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            {[
              ['Model calls', usage.totals.calls], ['Input tokens', usage.totals.promptTokens],
              ['Output tokens', usage.totals.outputTokens], ['Input from cache', usage.totals.cachedReadTokens],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-caption text-muted">{label}</dt>
                <dd className="break-words font-medium tabular-nums text-fg">{recordedCount(value as number)}</dd>
              </div>
            ))}
          </dl>
        )}
        {usageRoles.length > 0 && <div className="space-y-1.5 pt-1">
          <p className="text-caption font-medium text-fg">Recorded work by role</p>
          <ul className="space-y-1 text-caption" aria-label="Recorded model calls by role">
            {usageRoles.map((row, index) => <li key={`${row.label}:${index}`} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <span className="min-w-0 break-words text-muted [overflow-wrap:anywhere]">{row.label}</span>
              <span className="font-medium tabular-nums text-fg">{recordedCount(row.calls)} {row.calls === 1 ? 'call' : 'calls'}
                {row.tokens > 0 && <span className="text-muted"> · {row.tokens >= 1000 ? `${(row.tokens / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : row.tokens} tokens</span>}
                {row.modelMs > 0 && <span className="text-muted"> · {recordedDuration(row.modelMs)}</span>}</span>
            </li>)}
          </ul>
          <p className="text-caption text-muted">Roles describe the type of work, not its result. A routing role doesn’t identify the exact purpose of a request.</p>
        </div>}
        {usage && usage.totals.failedCalls > 0 && <p className="text-caption text-muted">Includes {recordedCount(usage.totals.failedCalls)} failed {usage.totals.failedCalls === 1 ? 'call' : 'calls'}.</p>}
        <div className="space-y-1 text-caption text-muted">{taskUsageNotes(detail).map((note) => <p key={note}>{note}</p>)}</div>
      </section>
      {detail.limitations.length > 0 && (
        <div className="space-y-1 border-t border-border pt-3 text-caption text-muted" role="note">
          {detail.limitations.map((note, index) => <p key={index} className="break-words [overflow-wrap:anywhere]">{note}</p>)}
        </div>
      )}
      <nav aria-label="Related settings" className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 text-caption font-medium text-primary-ink">
        <Link to="/memory?tab=tools" className="inline-flex min-h-9 items-center rounded-sm underline underline-offset-4 hover:text-primary-ink-hover">Learned tools</Link>
        <Link to="/settings#who-does-what" className="inline-flex min-h-9 items-center rounded-sm underline underline-offset-4 hover:text-primary-ink-hover">Model preferences</Link>
        <Link to="/advanced/usage" className="inline-flex min-h-9 items-center rounded-sm underline underline-offset-4 hover:text-primary-ink-hover">Usage</Link>
      </nav>
    </div>
  );
}
