/**
 * Clem thinking — what the Noticing heartbeat read, weighed, proposed and set
 * aside on each of its recent ticks, with the owner's controls beside it:
 * how many proposals a day, and what they have said never to suggest. Rides
 * under the Noticing card on the Heartbeats screen.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Tag } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { DECISION_WORDS, OUTCOME_WORDS, getNoticing, patchNoticing, type NoticingProposal, type NoticingThinking as Thinking } from '@/lib/noticing';

function ago(iso?: string): string {
  if (!iso) return '';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min)) return '';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function readWords(read: Thinking['read']): string {
  const parts = [
    [read.goals, 'goal'], [read.runs, 'run'], [read.waits, 'wait'], [read.drafts, 'draft'],
    [read.calendar, 'calendar item'], [read.conversations, 'conversation'], [read.memories, 'memory'],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? '' : (w === 'memory' ? 'ies' : 's')}`);
  return said.length ? `Read ${said.join(', ').replace('memoryies', 'memories')}` : 'Read nothing new';
}

function ProposalRow({ p }: { p: NoticingProposal }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-border bg-surface px-3 py-2 text-small">
      <button type="button" className="flex w-full items-start gap-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-fg">{p.title}</span>
          <span className="block text-caption text-faint">
            {ago(p.createdAt)} · {p.answer ? DECISION_WORDS[p.answer.decision] : p.status === 'open' ? 'Waiting for your answer' : p.retiredReason ?? p.status}
            {p.answer?.text ? ` — “${p.answer.text}”` : ''}
          </span>
        </span>
        <Tag>{Math.round(p.confidence * 100)}% sure</Tag>
      </button>
      {open ? (
        <div className="mt-2 space-y-1 text-caption text-muted">
          <p><span className="text-fg">Why:</span> {p.why}</p>
          <p><span className="text-fg">What she would do:</span> {p.action}</p>
          <p><span className="text-fg">Based on:</span> {p.evidence.join('; ')}</p>
        </div>
      ) : null}
    </li>
  );
}

export function NoticingThinking() {
  const qc = useQueryClient();
  const q = usePoll(['noticing'], getNoticing, 30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = q.data?.noticing;
  if (!n) return null;
  const setCap = async (dailyCap: number) => {
    setBusy(true); setError(null);
    try { await patchNoticing({ dailyCap }); void qc.invalidateQueries({ queryKey: ['noticing'] }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const proposals = [...n.openItems, ...n.recentlyRetired].slice(0, 10);
  return (
    <div className="grid gap-5 border-t border-border px-5 py-4 lg:grid-cols-[minmax(0,1fr)_320px]" data-testid="noticing-thinking">
      <div className="min-w-0 space-y-4">
        <div>
          <div className="mb-1.5 text-label text-fg">Clem thinking</div>
          {n.thinking.length === 0 ? (
            <p className="text-small text-muted">She has not thought yet. “Check now” runs one round.</p>
          ) : (
            <ol className="space-y-2">
              {n.thinking.slice(0, 6).map((t) => (
                <li key={t.tickId} className="rounded-md border border-border bg-subtle px-3 py-2 text-small">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{t.summary}</span>
                    <span className="text-caption text-faint">{ago(t.at)} · {readWords(t.read)}{t.model ? ` · ${t.model}` : ''} · {(t.durationMs / 1000).toFixed(1)} s</span>
                  </div>
                  {t.error ? <p className="mt-1 text-caption text-danger">{t.error}</p> : null}
                  {t.considered.length ? (
                    <ul className="mt-1.5 space-y-1">
                      {t.considered.map((c, i) => (
                        <li key={`${t.tickId}-${i}`} className="flex items-start gap-2 text-caption">
                          <Tag>{OUTCOME_WORDS[c.outcome]}</Tag>
                          <span className="min-w-0 flex-1"><span className="text-fg">{c.subject}</span><span className="text-muted"> — {c.why}</span></span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div>
          <div className="mb-1.5 text-label text-fg">Her proposals</div>
          {proposals.length === 0 ? <p className="text-small text-muted">None yet.</p> : (
            <ul className="space-y-1.5">{proposals.map((p) => <ProposalRow key={p.id} p={p} />)}</ul>
          )}
        </div>
      </div>
      <aside className="min-w-0 space-y-4">
        <div>
          <div className="mb-1.5 text-label text-fg">How much she may ask</div>
          <label className="inline-flex items-center gap-2 text-small text-muted">
            At most
            <select
              aria-label="Proposals per day"
              className="rounded-md border border-border bg-canvas px-2 py-1 text-small text-fg"
              value={n.dailyCap}
              disabled={busy}
              onChange={(e) => { void setCap(Number(e.target.value)); }}
            >
              {[1, 2, 3, 5, 10].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            proposal{n.dailyCap === 1 ? '' : 's'} a day
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
          </label>
          <p className="mt-1 text-caption text-faint">{n.metrics.itemsProduced} proposed · {n.metrics.doIt} you said do it · {n.metrics.notNow} not now · {n.metrics.never} never · {n.metrics.modelCalls} rounds of thinking</p>
          {error ? <p className="text-caption text-danger">{error}</p> : null}
        </div>
        <div>
          <div className="mb-1.5 text-label text-fg">What you said never to suggest</div>
          {n.standingAnswers.length === 0 ? (
            <p className="text-small text-muted">Nothing yet. Answer a proposal with “never…” and it lands here.</p>
          ) : (
            <ul className="space-y-1.5">
              {n.standingAnswers.slice(0, 8).map((a, i) => (
                <li key={`${a.at}-${i}`} className="rounded-md border border-border bg-surface px-3 py-2 text-small">
                  <span className="text-fg">“{a.text}”</span>
                  <span className="block text-caption text-faint">about “{a.about}” · {ago(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
