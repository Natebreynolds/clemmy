import { resolveAppLink } from '@clem/chat-engine';

interface Click { button: number; defaultPrevented?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }
interface Link { href?: string | null; place?: string | null; item?: string | null; target?: string | null; download?: boolean }
const CHAT_ROUTE = /^(?:\/chat\/[^/?#\\]+|\/agents\/[^/?#\\]+\/t\/[^/?#\\]+)$/;

/** A guide returns to the conversation that opened it, including an agent's thread. */
export function guidanceOriginPath(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const origin = (state as { clemGuidanceOrigin?: unknown }).clemGuidanceOrigin;
  return typeof origin === 'string' && (origin === '/help' || CHAT_ROUTE.test(origin)) && !/[\u0000-\u0020]/.test(origin) ? origin : null;
}

export function desktopAppLinkNavigation(link: Link, click: Click, pathname: string): { href: string; state?: { clemGuidanceOrigin: string } } | null {
  if (click.button !== 0 || click.defaultPrevented || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey
    || link.download || link.target && link.target !== '_self') return null;
  const destination = resolveAppLink(link, 'desktop');
  if (!destination) return null;
  const origin = guidanceOriginPath({ clemGuidanceOrigin: pathname });
  return { href: destination.href, ...(destination.kind === 'guide' && origin ? { state: { clemGuidanceOrigin: origin } } : {}) };
}
