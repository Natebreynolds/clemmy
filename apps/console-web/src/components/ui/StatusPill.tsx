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
}: {
  tone: Tone;
  children: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  const Icon = icon ?? toneIcon[tone];
  return (
    <span
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
