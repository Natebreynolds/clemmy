import type { Tone } from '@/components/ui/StatusPill';
import type { SessionOrigin } from '../types';

/** Display label + pill tone for a session origin. */
export function originMeta(origin: SessionOrigin): { label: string; tone: Tone } {
  switch (origin) {
    case 'discord': return { label: 'Discord', tone: 'info' };
    case 'workflow': return { label: 'Workflow', tone: 'warning' };
    case 'agent': return { label: 'Agent', tone: 'neutral' };
    case 'cli': return { label: 'Terminal', tone: 'neutral' };
    default: return { label: 'Chat', tone: 'live' };
  }
}
