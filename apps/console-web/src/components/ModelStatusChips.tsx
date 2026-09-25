import { ExternalLink } from 'lucide-react';
import { CREDIT_REFUSAL_WORDS, creditRefusalSentence, formatTokenCount, meterTone, presentUsageMeters, resetsInText, usageChipText, type UsageMeter, type UsageTone } from '@clem/chat-engine';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { getModelStatus, type ModelStatus } from '@/lib/model-status';

/**
 * Usage meters for every connected model account. The same presenter feeds
 * the compact chips in the top bar and the account rows in Settings › Models,
 * so the two can never disagree. Only connected accounts render; an account
 * whose provider publishes no window still shows today's spend.
 */

const TONE_TEXT: Record<UsageTone, string> = { ok: 'text-fg', warning: 'text-warning', danger: 'text-danger' };
const TONE_BAR: Record<UsageTone, string> = { ok: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' };

function agoLabel(ts: number | undefined, now: number): string {
  if (!ts) return '';
  const m = Math.floor((now - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function meterTooltip(meter: UsageMeter, now: number): string {
  const lines: string[] = [];
  const refusal = creditRefusalSentence(meter, (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  if (refusal) lines.push(refusal);
  for (const w of meter.windows) {
    const reset = resetsInText(w.resetAt, now);
    lines.push(`${w.label}: ${w.usedPercent}% used${reset ? ` · ${reset}` : ''}${w.detail ? ` · ${w.detail}` : ''}`);
  }
  if (meter.spend) lines.push(`today: ${formatTokenCount(meter.spend.tokens)} tokens over ${meter.spend.calls} call${meter.spend.calls === 1 ? '' : 's'}`);
  if (meter.note && !meter.outOfCredit) lines.push(meter.note);
  const ago = agoLabel(meter.capturedAt, now);
  if (ago && !meter.outOfCredit) lines.push(`as of ${ago}`);
  if (meter.outOfCredit && meter.billing) lines.push(`Click to ${meter.billing.action.toLowerCase()} on the provider's billing page.`);
  return lines.join('\n');
}

export function useUsageMeters(): { meters: UsageMeter[]; now: number; ready: boolean } {
  const q = usePoll(['model-status'], () => getModelStatus(), 15_000);
  const data = q.data as ModelStatus | undefined;
  return { meters: presentUsageMeters(data), now: Date.now(), ready: Boolean(data) };
}

const CHIP = 'app-no-drag inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-caption';

function MeterChip({ meter, now }: { meter: UsageMeter; now: number }) {
  const chip = usageChipText(meter, now);
  // An old reading is context, not a warning: it keeps its words and age but
  // drops the amber/red it earned when it was current.
  const tone = chip.stale ? 'ok' : meterTone(meter);
  return (
    <span
      title={meterTooltip(meter, now)}
      aria-label={`${meter.label} usage: ${meterTooltip(meter, now).replace(/\n/g, '; ')}`}
      className={cn(CHIP, 'border-border bg-canvas text-muted')}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', chip.stale ? 'bg-border-strong' : TONE_BAR[tone])} aria-hidden />
      <span className="font-medium text-fg">{meter.label}</span>
      <span className={cn('tabular-nums', chip.stale ? 'text-faint' : TONE_TEXT[tone])}>{chip.text}</span>
    </span>
  );
}

/** An account whose provider is turning down requests for lack of credit:
 *  the chip IS the way to fix it, so it opens the provider's billing page. */
function OutOfCreditChip({ meter, now }: { meter: UsageMeter; now: number }) {
  const body = (
    <>
      <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden />
      <span className="font-medium text-fg">{meter.label}</span>
      <span className="text-danger">{CREDIT_REFUSAL_WORDS}</span>
      {meter.billing && <ExternalLink className="h-3 w-3 text-danger" aria-hidden />}
    </>
  );
  const className = cn(CHIP, 'border-danger/50 bg-danger-tint text-danger');
  return meter.billing
    ? <a href={meter.billing.url} target="_blank" rel="noopener noreferrer" title={meterTooltip(meter, now)}
        aria-label={`${meter.label} is ${CREDIT_REFUSAL_WORDS} for lack of credit. ${meter.billing.action} on the provider's billing page.`}
        className={cn(className, 'hover:border-danger')}>{body}</a>
    : <span title={meterTooltip(meter, now)} className={className}>{body}</span>;
}

/** Compact chips for the top bar: accounts that publish a limit window — a
 *  subscription is what can run out mid-day — plus any account refusing work
 *  for lack of credit, which shows at every width because it needs its owner.
 *  Everything else is metered in Settings › Models. Chosen by what the meter
 *  reports, never by a list of provider names. */
export function ModelStatusChips() {
  const { meters, now } = useUsageMeters();
  const out = meters.filter((meter) => meter.outOfCredit);
  const windowed = meters.filter((meter) => !meter.outOfCredit && meter.windows.length > 0);
  if (out.length === 0 && windowed.length === 0) return null;
  return (
    <div className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden whitespace-nowrap" data-testid="usage-chips">
      {out.map((meter) => <OutOfCreditChip key={meter.id} meter={meter} now={now} />)}
      {/* xl and up: at narrower windows the bar clipped a chip mid-word; the
          meters stay complete in Settings › Models. An out-of-credit chip
          takes the room first, so the usage chips then wait for 2xl. */}
      {windowed.length > 0 && (
        <div className={cn('hidden min-w-0 shrink items-center gap-1.5 overflow-hidden', out.length > 0 ? '2xl:flex' : 'xl:flex')}>
          {windowed.map((meter) => <MeterChip key={meter.id} meter={meter} now={now} />)}
        </div>
      )}
    </div>
  );
}
