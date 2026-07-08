import { Fragment, useState, type ReactNode } from 'react';
import { Check, Send, X } from 'lucide-react';
import { DogMark } from '@/components/DogMark';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { TurnActivity } from '@/components/chat/TurnActivity';
import { cn } from '@/lib/cn';
import { linkify } from '@/lib/linkify';
import type { ChatMessage } from '@/lib/useChat';

/** Inline spans within a line: **bold** and `code`; everything else is linkified
 *  plain text. No dangerouslySetInnerHTML — React escapes all text children. */
function renderInline(text: string, keyBase: string): ReactNode {
  const RE = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={`${keyBase}-t${i}`}>{linkify(text.slice(last, m.index))}</Fragment>);
    if (m[1] != null) nodes.push(<strong key={`${keyBase}-b${i}`} className="font-semibold">{m[1]}</strong>);
    else if (m[2] != null) nodes.push(<code key={`${keyBase}-c${i}`} className="rounded bg-subtle px-1 py-0.5 font-mono text-[0.9em]">{m[2]}</code>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(<Fragment key={`${keyBase}-t${i}`}>{linkify(text.slice(last))}</Fragment>);
  return nodes;
}

/** Minimal, dependency-free markdown for assistant replies: ##/### headings,
 *  bold, inline code, fenced code blocks, and bullet/numbered lists. Plain
 *  paragraphs keep whitespace-pre-wrap. Unhandled text falls through linkified. */
function Markdown({ text }: { text: string }): ReactNode {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let key = 0;
  const flushPara = () => {
    if (para.length === 0) return;
    const body = para.join('\n');
    blocks.push(<p key={`p${key++}`} className="whitespace-pre-wrap">{renderInline(body, `p${key}`)}</p>);
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      flushPara();
      const fence: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { fence.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume closing fence
      blocks.push(<pre key={`f${key++}`} className="overflow-x-auto rounded-md bg-subtle p-3 font-mono text-caption">{fence.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const cls = h[1].length === 2 ? 'text-h3 font-semibold' : 'text-body-lg font-semibold';
      blocks.push(<div key={`h${key++}`} className={cls}>{renderInline(h[2], `h${key}`)}</div>);
      i++;
      continue;
    }
    const ordered = /^\s*\d+\.\s+/.test(line);
    const unordered = /^\s*[-*]\s+/.test(line);
    if (ordered || unordered) {
      flushPara();
      const marker = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const items: string[] = [];
      const listKey = key++;
      while (i < lines.length && marker.test(lines[i])) { items.push(lines[i].replace(marker, '')); i++; }
      const lis = items.map((it, idx) => <li key={idx}>{renderInline(it, `li${listKey}-${idx}`)}</li>);
      blocks.push(ordered
        ? <ol key={`l${listKey}`} className="list-decimal space-y-0.5 pl-5">{lis}</ol>
        : <ul key={`l${listKey}`} className="list-disc space-y-0.5 pl-5">{lis}</ul>);
      continue;
    }
    if (line.trim() === '') { flushPara(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara();
  return <div className="space-y-2">{blocks}</div>;
}

function PayloadPreview({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-caption font-semibold text-muted">Exact queued payload</summary>
      <pre className="mt-1 max-h-44 overflow-auto rounded-md bg-subtle p-2 font-mono text-caption text-muted">{text}</pre>
    </details>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Clementine is working">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-primary"
          style={{ animation: 'dot-pulse 1.2s ease-in-out infinite', animationDelay: `${i * 180}ms` }}
        />
      ))}
    </span>
  );
}

export function ChatBubble({
  message,
  onApprove,
  onReject,
  onBackground,
}: {
  message: ChatMessage;
  onApprove: () => void;
  onReject: () => void;
  /** Detach THIS running turn to a durable background task (shown while thinking). */
  onBackground?: () => void;
}) {
  const isUser = message.role === 'user';
  // Approve/Reject fire a follow-up turn but never patch THIS bubble's status, so
  // without a local latch the buttons stay live forever. Latch on first click.
  const [resolved, setResolved] = useState(false);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-tr-sm bg-primary-tint px-4 py-2.5">
          <p className="whitespace-pre-wrap text-body-lg text-fg">{message.text}</p>
          {message.attachmentNames && message.attachmentNames.length > 0 && (
            <p className="mt-1 text-caption text-muted">📎 {message.attachmentNames.join(', ')}</p>
          )}
        </div>
      </div>
    );
  }

  const thinking = message.status === 'thinking';
  const pendingAction = message.approval?.pendingAction;
  return (
    <div className="flex gap-3">
      <DogMark size={28} className="mt-0.5 self-start" />
      <div className="min-w-0 max-w-[80%] flex-1">
        <div className="rounded-lg rounded-tl-sm border border-border bg-surface px-4 py-3 shadow-xs">
          {thinking && !message.text ? (
            <div className="flex items-center gap-2 text-body text-muted">
              <ThinkingDots />
              <span className="min-w-0 flex-1">{message.progress ?? 'Thinking…'}</span>
              {onBackground && (
                <button
                  type="button"
                  onClick={onBackground}
                  title="Continue in background — keeps working, reports back here, frees the chat"
                  className="shrink-0 rounded border border-border px-2 py-0.5 text-caption text-muted transition-colors hover:border-primary/40 hover:text-fg cursor-pointer"
                >
                  ⇥ background
                </button>
              )}
            </div>
          ) : thinking && message.text ? (
            // Mid-stream: render plain (linkified) text + a live caret. Full
            // markdown formatting is applied once the reply lands (below).
            // The background control stays available HERE too — brains that
            // stream text immediately (Claude) skip the pre-text state, which
            // made the bubble button vanish for them (live 2026-07-08).
            <div>
              <p className="whitespace-pre-wrap text-body-lg leading-relaxed text-fg">
                {linkify(message.text)}
                <span
                  aria-hidden
                  className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.2em] rounded-full bg-primary"
                  style={{ animation: 'dot-pulse 1.2s ease-in-out infinite' }}
                />
              </p>
              {onBackground && (
                <div className="mt-1.5 flex justify-end">
                  <button
                    type="button"
                    onClick={onBackground}
                    title="Continue in background — keeps working, reports back here, frees the chat"
                    className="shrink-0 rounded border border-border px-2 py-0.5 text-caption text-muted transition-colors hover:border-primary/40 hover:text-fg cursor-pointer"
                  >
                    ⇥ background
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className={cn('text-body-lg leading-relaxed', message.status === 'failed' ? 'text-danger' : 'text-fg')}>
              <Markdown text={message.text} />
            </div>
          )}

          {/* Premium activity strip: live tool calls + parallel agents (Claude/Codex/
              GLM) with status — shown while working AND kept (collapsed) after. Falls
              back to the single rolling line only before any activity has arrived. */}
          {message.activity && message.activity.length > 0 ? (
            <TurnActivity items={message.activity} live={thinking} />
          ) : (
            thinking && message.text && message.progress && (
              <div className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2 text-caption text-faint">
                <ThinkingDots />
                <span>{message.progress}</span>
              </div>
            )
          )}

          {(message.status === 'awaiting-approval' || message.status === 'awaiting-plan') && (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning-tint p-3">
              <p className="text-small font-semibold text-fg">
                {message.status === 'awaiting-plan'
                  ? 'Approve this plan to continue?'
                  : pendingAction
                    ? `Ready to execute: ${pendingAction.title}`
                    : `Approve: ${message.approval?.subject ?? 'this action'}`}
              </p>
              {pendingAction && (
                <div className="mt-1 space-y-0.5 text-caption text-muted">
                  <div>Tool: <span className="font-mono">{pendingAction.toolName}</span></div>
                  {pendingAction.targetSummary && <div>Target: {pendingAction.targetSummary}</div>}
                  {pendingAction.preview && <div className="whitespace-pre-wrap">Preview: {pendingAction.preview}</div>}
                  {pendingAction.payloadHash && <div>Payload hash: <span className="font-mono">{pendingAction.payloadHash}</span></div>}
                </div>
              )}
              {message.approval?.reason && <p className="mt-0.5 text-caption text-muted">{message.approval.reason}</p>}
              {pendingAction && <PayloadPreview value={pendingAction.payload} />}
              <div className="mt-2.5 flex items-center gap-2">
                <Button size="sm" disabled={resolved} onClick={() => { setResolved(true); onApprove(); }}>
                  {pendingAction ? <Send className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                  {pendingAction ? 'Execute queued action' : 'Approve'}
                </Button>
                <Button size="sm" variant="secondary" disabled={resolved} onClick={() => { setResolved(true); onReject(); }}><X className="h-4 w-4" aria-hidden /> Not now</Button>
                {resolved && <span className="text-caption text-muted">Submitted</span>}
              </div>
            </div>
          )}
        </div>

        {(message.status === 'awaiting-reply' || message.status === 'stopped' || message.status === 'failed') && (
          <div className="mt-1.5">
            {message.status === 'awaiting-reply' && <StatusPill tone="info">Reply below to continue</StatusPill>}
            {message.status === 'stopped' && <StatusPill tone="neutral">Stopped</StatusPill>}
            {message.status === 'failed' && <StatusPill tone="danger">Didn't finish</StatusPill>}
          </div>
        )}
      </div>
    </div>
  );
}
