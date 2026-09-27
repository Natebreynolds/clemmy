import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { modelDisplayName } from '@clem/chat-engine';
import { usePoll } from '@/lib/poll';
import { getSettings } from '@/lib/settings';
import { roleLabel, shortModelLabel } from '@/lib/model-roles';
import { PROVIDER_DOT } from '@/components/chat/ActivityFeed';

/**
 * Which model does the work right now, in the header on every route, with a
 * warning when it is a stand-in for the owner's pick (the owner switched the
 * brain from the phone at 19:39 today and the desktop showed nothing of it).
 * Reads the same settings poll the composer's picker reads; adds no call.
 * Opens Who does what.
 */
export function BrainChip() {
  const navigate = useNavigate();
  const settings = usePoll(['settings'], getSettings, 0);
  const mr = settings.data?.modelRoles;
  if (!mr) return null;
  const brain = mr.roles.brain;
  const label = shortModelLabel(roleLabel(mr, 'brain'));
  const swapped = brain.inactiveBinding && brain.inactiveBinding.modelId !== brain.modelId ? brain.inactiveBinding : null;
  const color = (PROVIDER_DOT as Record<string, string>)[brain.provider] ?? PROVIDER_DOT.unknown;
  const title = swapped
    ? `Your pick, ${modelDisplayName(swapped.modelId)}, isn’t available, so ${label} does the work. Open Who does what.`
    : `${label} does the work. Open Who does what.`;
  return (
    <button
      type="button"
      onClick={() => navigate('/settings#who-does-what')}
      title={title}
      aria-label={title}
      className="hidden h-9 items-center gap-2 rounded-md border border-border bg-surface px-3 text-small text-fg transition-colors hover:bg-canvas md:inline-flex"
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      <span className="max-w-[10rem] truncate">{label}</span>
      {swapped && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />}
    </button>
  );
}
