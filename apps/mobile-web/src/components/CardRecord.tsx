import './card-record.css';
import { cardRecordHeadline, cardStepLabel, type CardRecord as Record } from '../lib/card-records';

/** What Clem is doing about what the owner asked on this item: their words,
 *  her steps as they happen, then her answer, or what she still needs. Shown
 *  on the item itself, the same record the desktop shows. */
export function CardRecord({ record, showTitle = false, onOpenThread, onOpenInbox }: {
  record: Record;
  showTitle?: boolean;
  onOpenThread: (sessionId?: string) => void;
  /** Opens one decision in Inbox: the approval card with the exact content. */
  onOpenInbox?: (decisionKey?: string) => void;
}) {
  const outcome = record.outcome;
  const headline = cardRecordHeadline(outcome);
  const steps = ('steps' in outcome && outcome.steps ? outcome.steps : []).filter((step) => cardStepLabel(step));
  const words = 'text' in outcome ? outcome.text : '';
  const sessionId = 'sessionId' in outcome ? outcome.sessionId : undefined;
  return (
    <div class="card-record" aria-live="polite">
      {showTitle && <p class="card-record-title">{record.title}</p>}
      <p class="card-record-you"><strong>You: </strong>{record.reply}</p>
      {steps.length > 0 && (
        <ol class="card-record-steps" aria-label="What Clem did">
          {steps.map((step, index) => (
            <li key={`${step.tool}-${index}`} class={step.done ? 'is-done' : 'is-running'}>
              <span class="card-record-mark" aria-hidden="true">{step.done ? '✓' : '•'}</span>
              <span>{cardStepLabel(step)}</span>
            </li>
          ))}
        </ol>
      )}
      <p class={`card-record-headline tone-${headline.tone}`}>{headline.text}</p>
      {words && <p class="card-record-words">{words}</p>}
      {outcome.state === 'needs_you' && outcome.approvalId && onOpenInbox ? (
        <button type="button" class="home-link-btn" onClick={() => onOpenInbox(`approval:${outcome.approvalId}`)}>Review and approve</button>
      ) : sessionId && outcome.state !== 'done' && (
        <button type="button" class="home-link-btn" onClick={() => onOpenThread(sessionId)}>
          {outcome.state === 'needs_you' ? (outcome.asks === 'approval' ? 'Review and approve' : 'Answer Clem') : 'Open the conversation'}
        </button>
      )}
    </div>
  );
}
