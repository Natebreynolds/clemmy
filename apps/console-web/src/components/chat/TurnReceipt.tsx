/**
 * The last lines under an answer: what she made and changed, whether it was
 * checked, which models did the work and the checking, and what the turn
 * touched.
 *
 * Every fact here is read from the turn's own events. "Checked" appears only
 * when a review passed; a turn whose reviewer never ran says so, because an
 * unchecked answer must not borrow a pass. A card for work outside Clem
 * appears only for writes the provider confirmed.
 */
import { useState } from 'react';
import { AlertCircle, Check, CheckCircle2, Copy, FileText, Mail, PenLine, Send } from 'lucide-react';
import { outsideWorkCards, turnByline, turnReview, type OutsideWorkCard } from '@clem/chat-engine';
import type { ActivityItem } from '@/lib/useChat';
import type { TerminalFacts } from '@clem/chat-engine';
import { openFile, resolveDeliverablePath } from '@/lib/files';
import { TurnEvidenceLine } from '@/components/chat/TurnEvidenceLine';

/** A file she saved this turn, as something you can open. The harness names
 *  the latest file by basename; the path is resolved on demand and the button
 *  disappears when no single file matches. */
function DeliverableCard({ row }: { row: ActivityItem }) {
  const file = row.deliverable;
  const [state, setState] = useState<'idle' | 'working' | 'unavailable'>('idle');
  const [problem, setProblem] = useState('');
  if (!file) return null;
  const count = row.count ?? 1;
  const open = () => {
    setState('working');
    setProblem('');
    void resolveDeliverablePath(file.name, file.dir)
      .then(async (resolved) => {
        if (!resolved) { setState('unavailable'); return; }
        const result = await openFile(resolved);
        setState('idle');
        if (!result.ok) setProblem(result.reason);
      })
      .catch(() => setState('unavailable'));
  };
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-success-tint text-success">
        <FileText className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-small font-semibold text-fg" title={file.name}>{file.name}</span>
        <span className="truncate text-caption text-faint">
          {problem || (count > 1 ? `Latest of ${count} files saved` : 'Saved to your files')}
        </span>
      </span>
      {state !== 'unavailable' && (
        <button
          type="button"
          onClick={open}
          disabled={state === 'working'}
          className="shrink-0 rounded-sm border border-border-strong px-3 py-1 text-caption font-semibold text-fg transition-colors hover:bg-subtle disabled:opacity-60 active:scale-press"
        >
          {state === 'working' ? 'Opening…' : 'Open'}
        </button>
      )}
    </div>
  );
}

/** Something the turn changed in another app, confirmed by that app. Open
 *  goes to the app itself: the provider returns no link to the exact item. */
function OutsideWorkCardView({ card }: { card: OutsideWorkCard }) {
  const Icon = card.kind.startsWith('draft') ? PenLine : card.kind === 'message_sent' ? Mail : Send;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-info-tint text-info">
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-small font-semibold text-fg" title={card.title}>{card.title}</span>
        <span className="truncate text-caption text-faint" title={card.subtitle}>{card.subtitle}</span>
      </span>
      {card.appUrl && (
        <a
          href={card.appUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${card.app ?? 'the app'}`}
          className="shrink-0 rounded-sm border border-border-strong px-3 py-1 text-caption font-semibold text-fg transition-colors hover:bg-subtle active:scale-press"
        >
          Open
        </a>
      )}
    </div>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => { /* the answer stays selectable on the page */ });
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : 'Copy answer'}
      title={copied ? 'Copied' : 'Copy answer'}
      className="grid h-7 w-7 place-items-center rounded-sm text-faint transition-colors hover:bg-subtle hover:text-fg"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

export function TurnReceipt({
  activity,
  terminal,
  text,
}: {
  activity?: ActivityItem[];
  terminal?: TerminalFacts;
  text: string;
}) {
  const review = turnReview(activity);
  const byline = turnByline(activity);
  const saved = activity?.find((row) => row.id === 'deliverables' && row.deliverable);
  const outside = outsideWorkCards(activity);
  return (
    <>
      {(saved || outside.length > 0) && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {outside.map((card) => <OutsideWorkCardView key={card.key} card={card} />)}
          {saved && <DeliverableCard row={saved} />}
        </div>
      )}
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
        {review === 'checked' && (
          <span className="inline-flex items-center gap-1 font-semibold text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Checked
          </span>
        )}
        {review === 'unchecked' && (
          <span className="inline-flex items-center gap-1 font-medium text-warning" title="The reviewer was unavailable, so this answer was not checked.">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Not checked
          </span>
        )}
        {review === 'rejected' && (
          <span className="inline-flex items-center gap-1 font-medium text-warning" title="The last review did not accept this answer.">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Didn’t pass review
          </span>
        )}
        {byline && <span className="text-muted">{byline}</span>}
        <TurnEvidenceLine terminal={terminal} activity={activity} inline />
        <span className="ml-auto flex items-center gap-2 opacity-0 transition-opacity duration-base group-hover/turn:opacity-100 group-focus-within/turn:opacity-100">
          <CopyAnswer text={text} />
        </span>
      </div>
    </>
  );
}
