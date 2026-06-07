import { Lock } from 'lucide-react';

/**
 * Shown instead of the composer when a session can't be continued from the
 * desktop (workflow / execution / agent runs). Viewing the transcript is
 * fine; sending a new turn into a finished run is not.
 */
export function ReadOnlyNotice({ kind }: { kind: string }) {
  const what =
    kind === 'workflow' ? 'workflow run'
    : kind === 'execution' ? 'background task'
    : kind === 'agent' ? 'agent run'
    : 'run';
  return (
    <div className="border-t border-border bg-subtle px-4 py-3">
      <div className="flex items-center gap-2 text-small text-muted">
        <Lock className="h-4 w-4 shrink-0" aria-hidden />
        <span>This {what} is read-only. Start a new chat to take an action based on it.</span>
      </div>
    </div>
  );
}
