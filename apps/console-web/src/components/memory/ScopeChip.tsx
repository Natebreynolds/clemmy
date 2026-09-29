/**
 * Where a fact applies, as a small chip beside its origin: "Everywhere",
 * "Weekly Sales", "Sales Assistant", "Sales Assistant in Weekly Sales".
 * A category, not a state, so it is neutral and carries its own icon.
 */
import { FolderKanban, Globe, Users } from 'lucide-react';
import { memoryScopeHint, memoryScopeLabel, type MemoryScope } from '@clem/chat-engine';
import { cn } from '@/lib/cn';

export function ScopeChip({ scope, className }: { scope?: MemoryScope | null; className?: string }) {
  const Icon = !scope || scope.kind === 'user' ? Globe : scope.kind === 'agent' ? Users : FolderKanban;
  return (
    <span
      title={memoryScopeHint(scope)}
      className={cn('inline-flex max-w-full items-center gap-1 rounded-sm bg-subtle px-2 py-0.5 text-caption font-semibold text-muted', className)}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only">Applies to: </span>
      <span className="truncate">{memoryScopeLabel(scope)}</span>
    </span>
  );
}
