import { formatTokenCount, meterTone, presentUsageMeters, resetsInText, usageChipText, type UsageMeter, type UsageTone } from '@clem/chat-engine';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { getModelStatus, type ModelStatus } from '@/lib/model-status';

/**
 * Usage meters for every connected model account. The same presenter feeds
 * the compact chips in the top bar and the detailed panel in Settings, so
 * the two can never disagree. Only connected accounts render; an account
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
  for (const w of meter.windows) {
    const reset = resetsInText(w.resetAt, now);
    lines.push(`${w.label}: ${w.usedPercent}% used${reset ? ` · ${reset}` : ''}${w.detail ? ` · ${w.detail}` : ''}`);
  }
  if (meter.spend) lines.push(`today: ${formatTokenCount(meter.spend.tokens)} tokens over ${meter.spend.calls} call${meter.spend.calls === 1 ? '' : 's'}`);
  if (meter.note) lines.push(meter.note);
  const ago = agoLabel(meter.capturedAt, now);
  if (ago) lines.push(`as of ${ago}`);
  return lines.join('\n');
}

export function useUsageMeters(): { meters: UsageMeter[]; now: number; ready: boolean } {
  const q = usePoll(['model-status'], () => getModelStatus(), 15_000);
  const data = q.data as ModelStatus | undefined;
  return { meters: presentUsageMeters(data), now: Date.now(), ready: Boolean(data) };
}

function MeterChip({ meter, now }: { meter: UsageMeter; now: number }) {
  const chip = usageChipText(meter, now);
  // An old reading is context, not a warning: it keeps its words and age but
  // drops the amber/red it earned when it was current.
  const tone = chip.stale ? 'ok' : meterTone(meter);
  return (
    <span
      title={meterTooltip(meter, now)}
      aria-label={`${meter.label} usage: ${meterTooltip(meter, now).replace(/\n/g, '; ')}`}
      className="app-no-drag inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-canvas px-2 py-1 text-caption text-muted"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', chip.stale ? 'bg-border-strong' : TONE_BAR[tone])} aria-hidden />
      <span className="font-medium text-fg">{meter.label}</span>
      <span className={cn('tabular-nums', chip.stale ? 'text-faint' : TONE_TEXT[tone])}>{chip.text}</span>
    </span>
  );
}

/** Compact chips for the top bar: accounts that publish a limit window — a
 *  subscription is what can run out mid-day. Accounts without a window are
 *  metered in Settings › Connected. Chosen by what the meter reports, never
 *  by a list of provider names. */
export function ModelStatusChips() {
  const { meters, now } = useUsageMeters();
  const shown = meters.filter((meter) => meter.windows.length > 0);
  if (shown.length === 0) return null;
  return (
    // xl and up: at narrower windows the bar clipped a chip mid-word; the
    // meters stay complete in Settings › Connected.
    <div className="hidden min-w-0 shrink items-center gap-1.5 overflow-hidden whitespace-nowrap xl:flex" data-testid="usage-chips">
      {shown.map((meter) => <MeterChip key={meter.id} meter={meter} now={now} />)}
    </div>
  );
}

/** The full meters, with bars, for Settings › Connected. */
export function UsageMetersPanel() {
  const { meters, now, ready } = useUsageMeters();
  if (!ready) return null;
  if (meters.length === 0) {
    return <p className="text-small text-muted">No model account is connected yet, so there is nothing to meter.</p>;
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Usage meters">
      {meters.map((meter) => {
        const ago = agoLabel(meter.capturedAt, now);
        return (
          <li key={meter.id} className="rounded-lg border border-border bg-canvas p-4">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-fg">{meter.label}</span>
              {ago ? <span className="text-caption text-faint">as of {ago}</span> : null}
            </div>
            {meter.windows.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {meter.windows.map((w) => {
                  const reset = resetsInText(w.resetAt, now);
                  return (
                    <li key={w.id}>
                      <div className="flex justify-between text-caption text-muted">
                        <span>{w.label}</span>
                        <span className={cn('tabular-nums font-semibold', TONE_TEXT[w.tone])}>{w.usedPercent}%{reset ? ` · ${reset}` : ''}</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.usedPercent} aria-label={`${meter.label} ${w.label}`}>
                        <div className={cn('h-full rounded-full', TONE_BAR[w.tone])} style={{ width: `${w.usedPercent}%` }} />
                      </div>
                      {w.detail ? <div className="mt-0.5 text-caption text-faint">{w.detail}</div> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-caption text-muted">{meter.note}</p>
            )}
            <p className="mt-3 text-caption text-muted">
              {meter.spend
                ? `Today: ${formatTokenCount(meter.spend.tokens)} tokens · ${meter.spend.calls} call${meter.spend.calls === 1 ? '' : 's'}`
                : 'Today: nothing yet'}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
