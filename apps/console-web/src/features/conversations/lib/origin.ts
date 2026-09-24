import type { SessionOrigin } from '../types';

/** Display label for a session origin. An origin is a category, not a
 *  state, so it renders as a neutral Tag — it used to paint every workflow
 *  thread with the warning pill and every chat with the live one. */
export function originMeta(origin: SessionOrigin): { label: string } {
  switch (origin) {
    case 'discord': return { label: 'Discord' };
    case 'workflow': return { label: 'Workflow' };
    case 'agent': return { label: 'Agent' };
    case 'cli': return { label: 'Terminal' };
    default: return { label: 'Chat' };
  }
}
