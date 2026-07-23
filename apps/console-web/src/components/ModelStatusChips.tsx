import type { ReactNode } from 'react';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { getModelStatus, type ModelStatus, type QuotaWindow } from '@/lib/model-status';

/**
 * Compact live chips in the top bar: Codex + Claude 5h/weekly quota (the same
 * windows Codex CLI `/status` and Claude Code show, captured from provider
 * rate-limit headers), plus connection dots for OpenAI and connected BYO
 * providers (GLM, DeepSeek, MiniMax, Together, etc.). Each value fades in on update — a
 * subtle pulse that's automatically suppressed under prefers-reduced-motion
 * (handled globally in styles.css). Only connected providers render.
 */

// Used-percent → headroom tone. High usage (near the cap) is the thing to notice.
function pctTone(pct: number): string {
  if (pct >= 90) return 'text-danger';
  if (pct >= 70) return 'text-warning';
  return 'text-fg';
}

function resetIn(resetAt?: number): string {
  if (!resetAt) return '';
  const ms = resetAt - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function agoLabel(ts?: number): string {
  if (!ts) return 'unknown';
  const ms = Date.now() - ts;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** A single percentage that re-fades whenever its value changes (the pulse). */
function Pct({ window: w }: { window?: QuotaWindow }) {
  if (!w) return <span className="text-faint">—</span>;
  return (
    <span key={w.usedPercent} className={cn('animate-fade-in font-semibold tabular-nums', pctTone(w.usedPercent))}>
      {w.usedPercent}%
    </span>
  );
}

function QuotaChip({
  label,
  five,
  week,
  capturedAt,
  extraTooltip,
}: {
  label: string;
  five?: QuotaWindow;
  week?: QuotaWindow;
  capturedAt?: number;
  extraTooltip?: string;
}) {
  const tip = [
    `${label} usage`,
    five ? `5h: ${five.usedPercent}% used${five.resetAt ? ` · resets in ${resetIn(five.resetAt)}` : ''}` : null,
    week ? `weekly: ${week.usedPercent}% used${week.resetAt ? ` · resets in ${resetIn(week.resetAt)}` : ''}` : null,
    extraTooltip ?? null,
    `as of ${agoLabel(capturedAt)}`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span
      title={tip}
      className="app-no-drag inline-flex items-center gap-1 rounded-md border border-border bg-canvas px-2 py-1 text-caption text-muted"
    >
      <span className="font-medium text-fg">{label}</span>
      <span className="text-faint">5h</span>
      <Pct window={five} />
      <span className="text-faint">·</span>
      <span className="text-faint">wk</span>
      <Pct window={week} />
    </span>
  );
}

function ConnectedChip({ label, title }: { label: string; title?: string }) {
  return (
    <span
      title={title ?? `${label} connected`}
      className="app-no-drag inline-flex items-center gap-1.5 rounded-md border border-border bg-canvas px-2 py-1 text-caption text-muted"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
      <span className="max-w-[7rem] truncate font-medium text-fg">{label}</span>
    </span>
  );
}

export function ModelStatusChips() {
  const q = usePoll(['model-status'], () => getModelStatus(), 15_000);
  const data = q.data as ModelStatus | undefined;
  if (!data) return null;

  const chips: ReactNode[] = [];
  if (data.codex?.connected) {
    chips.push(
      <QuotaChip
        key="codex"
        label="Codex"
        five={data.codex.primary}
        week={data.codex.secondary}
        capturedAt={data.codex.capturedAt}
      />,
    );
  }
  if (data.claude?.connected) {
    chips.push(
      <QuotaChip
        key="claude"
        label="Claude"
        five={data.claude.fiveHour}
        week={data.claude.weekly}
        capturedAt={data.claude.capturedAt}
        extraTooltip={data.claude.status ? `status: ${data.claude.status}` : undefined}
      />,
    );
  }
  // Every extra API key used to add its own chip until Search/Run/Talk clipped
  // off the bar. The quota chips carry real signal; plain "connected" providers
  // collapse into ONE summary chip whose tooltip lists them all.
  const simple: Array<{ label: string; detail?: string }> = [];
  if (data.openai?.connected) simple.push({ label: 'OpenAI' });
  const byoProviders = (data.byoProviders ?? []).filter((p) => p.connected);
  if (byoProviders.length > 0) {
    for (const provider of byoProviders) {
      simple.push({
        label: provider.label || provider.id,
        detail: provider.modelIds.length ? provider.modelIds.join(', ') : undefined,
      });
    }
  } else if (data.together?.connected) {
    simple.push({ label: 'Together' });
  }
  if (simple.length === 1) {
    chips.push(<ConnectedChip key="provider" label={simple[0].label} title={`${simple[0].label} connected${simple[0].detail ? `\n${simple[0].detail}` : ''}`} />);
  } else if (simple.length > 1) {
    chips.push(
      <ConnectedChip
        key="providers"
        label={`${simple.length} providers`}
        title={simple.map((p) => `${p.label} connected${p.detail ? ` · ${p.detail}` : ''}`).join('\n')}
      />,
    );
  }

  if (chips.length === 0) return null;
  return <div className="hidden min-w-0 shrink items-center gap-1.5 overflow-hidden lg:flex">{chips}</div>;
}
