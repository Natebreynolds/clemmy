import type { LucideIcon } from 'lucide-react';
import { CheckCircle2, Info, AlertTriangle, AlertCircle, Circle, Radio } from 'lucide-react';
import { cn } from '@/lib/cn';

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'live';

const toneIcon: Record<Tone, LucideIcon> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  danger: AlertCircle,
  neutral: Circle,
  live: Radio,
};

// Always pair color WITH an icon + text — never color alone (a11y).
const toneClass: Record<Tone, string> = {
  success: 'text-success bg-success-tint',
  info: 'text-info bg-info-tint',
  warning: 'text-warning bg-warning-tint',
  danger: 'text-danger bg-danger-tint',
  neutral: 'text-muted bg-subtle',
  live: 'text-primary bg-primary-tint',
};

export function StatusPill({
  tone,
  children,
  icon,
  className,
  title,
}: {
  tone: Tone;
  children: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
  title?: string;
}) {
  const Icon = icon ?? toneIcon[tone];
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-caption font-semibold',
        toneClass[tone],
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}

/** A category, not a state: where a conversation came from, what kind of
 *  thing a row is. Neutral and icon-free, so warning amber and the live
 *  orange only ever mean something about the work itself. */
export function Tag({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center rounded-sm bg-subtle px-2 py-0.5 text-caption font-semibold text-muted', className)}
    >
      {children}
    </span>
  );
}
