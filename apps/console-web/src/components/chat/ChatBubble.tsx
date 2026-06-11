import { Check, X } from 'lucide-react';
import { DogMark } from '@/components/DogMark';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn } from '@/lib/cn';
import type { ChatMessage } from '@/lib/useChat';

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Clementine is working">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-primary/70"
          style={{ animation: 'breathe 1s ease-in-out infinite', animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

export function ChatBubble({
  message,
  onApprove,
  onReject,
}: {
  message: ChatMessage;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isUser = message.role === 'user';

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
  return (
    <div className="flex gap-3">
      <DogMark size={28} className="mt-0.5 self-start" />
      <div className="min-w-0 max-w-[80%] flex-1">
        <div className="rounded-lg rounded-tl-sm border border-border bg-surface px-4 py-3 shadow-xs">
          {thinking && !message.text ? (
            <div className="flex items-center gap-2 text-body text-muted">
              <ThinkingDots />
              <span>{message.progress ?? 'Thinking…'}</span>
            </div>
          ) : (
            <p className={cn('whitespace-pre-wrap text-body-lg leading-relaxed', message.status === 'failed' ? 'text-danger' : 'text-fg')}>
              {message.text}
              {thinking && message.text && (
                <span
                  aria-hidden
                  className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.2em] rounded-full bg-primary/80"
                  style={{ animation: 'breathe 1s ease-in-out infinite' }}
                />
              )}
            </p>
          )}

          {thinking && message.text && message.progress && (
            <div className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2 text-caption text-faint">
              <ThinkingDots />
              <span>{message.progress}</span>
            </div>
          )}

          {(message.status === 'awaiting-approval' || message.status === 'awaiting-plan') && (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning-tint p-3">
              <p className="text-small font-semibold text-fg">
                {message.status === 'awaiting-plan' ? 'Approve this plan to continue?' : `Approve: ${message.approval?.subject ?? 'this action'}`}
              </p>
              {message.approval?.reason && <p className="mt-0.5 text-caption text-muted">{message.approval.reason}</p>}
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" onClick={onApprove}><Check className="h-4 w-4" aria-hidden /> Approve</Button>
                <Button size="sm" variant="secondary" onClick={onReject}><X className="h-4 w-4" aria-hidden /> Not now</Button>
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
