import { CircleDot, User, SlidersHorizontal, FileText, ListChecks, Link2, Clock, ShieldCheck, File } from 'lucide-react';
import { cn } from '@/lib/cn';
import { KIND_LABEL, type MemoryKind } from '@/lib/memory-why';

const ICON: Record<MemoryKind, typeof User> = {
  fact: CircleDot, person: User, preference: SlidersHorizontal, note: FileText, howto: ListChecks, source: Link2, moment: Clock, rule: ShieldCheck, file: File,
};
const TINT: Record<MemoryKind, string> = {
  fact: 'bg-primary-tint text-primary', person: 'bg-info-tint text-info', preference: 'bg-success-tint text-success', note: 'bg-subtle text-muted',
  howto: 'bg-[color:var(--primary-tint)] text-primary', source: 'bg-subtle text-muted', moment: 'bg-subtle text-muted', rule: 'bg-warning-tint text-warning', file: 'bg-subtle text-muted',
};

/** The kind glyph every memory surface shares: a tinted square with a stroke icon, never a letter. */
export function MemoryKindIcon({ kind, size = 'md', className }: { kind: MemoryKind; size?: 'sm' | 'md'; className?: string }) {
  const Icon = ICON[kind];
  return (
    <span aria-label={KIND_LABEL[kind]} title={KIND_LABEL[kind]} className={cn('grid shrink-0 place-items-center rounded-md', size === 'md' ? 'h-8 w-8' : 'h-5 w-5 rounded', TINT[kind], className)}>
      <Icon className={size === 'md' ? 'h-4 w-4' : 'h-3 w-3'} aria-hidden />
    </span>
  );
}
