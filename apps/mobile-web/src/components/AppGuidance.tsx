import type { AppGuidance as Guidance } from '@clem/chat-engine';
import { useEffect, useRef, useState } from 'preact/hooks';
import { guidanceTargetEligible, watchGuidanceTarget, type GuidanceTargetState } from '../lib/guidance-target';

export function AppGuidance({ guidance, onBack, onClose, returnLabel = 'Open chats' }: { guidance: Guidance; onBack: () => void; onClose: () => void; returnLabel?: string }) {
  const [state, setState] = useState<GuidanceTargetState>('checking');
  const [attempt, setAttempt] = useState(0);
  const highlight = useRef<{ node: HTMLElement; addedTabIndex: boolean; previousFocus: HTMLElement | null } | null>(null);
  const find = () => [...document.querySelectorAll<HTMLElement>(guidance.target)].find(node => {
    if (!guidanceTargetEligible(node)) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }) ?? null;
  const clearHighlight = (restoreFocus = false) => {
    const saved = highlight.current;
    if (!saved) return;
    saved.node.classList.remove('clem-guide-target');
    if (saved.addedTabIndex && saved.node.getAttribute('tabindex') === '-1') saved.node.removeAttribute('tabindex');
    if (restoreFocus && document.activeElement === saved.node && saved.previousFocus?.isConnected) saved.previousFocus.focus({ preventScroll: true });
    highlight.current = null;
  };
  useEffect(() => {
    clearHighlight();
    const stop = watchGuidanceTarget({
      find: () => {
        const target = find();
        if (highlight.current && highlight.current.node !== target) clearHighlight(true);
        return Boolean(target);
      },
      observe: check => { const observer = new MutationObserver(check); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'disabled', 'aria-hidden', 'aria-disabled', 'inert'] }); return () => observer.disconnect(); },
      later: (check, milliseconds) => { const timer = window.setTimeout(check, milliseconds); return () => window.clearTimeout(timer); },
    }, next => { if (next !== 'ready') clearHighlight(true); setState(next); });
    return () => { stop(); clearHighlight(true); };
  }, [guidance.id, guidance.target, attempt]);
  const show = () => {
    const target = find();
    if (!target) { setAttempt(value => value + 1); return; }
    clearHighlight();
    const addedTabIndex = !target.matches('button,a[href],input,textarea,select,[tabindex]');
    highlight.current = { node: target, addedTabIndex, previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    target.classList.add('clem-guide-target');
    if (addedTabIndex) target.setAttribute('tabindex', '-1');
    target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
  };
  return <aside class="clem-guidance" aria-label="Guidance from Clem">
    <div><strong>{guidance.title}</strong><p>{guidance.instruction}</p></div>
    {state !== 'ready' ? <p role="status">{state === 'checking' ? 'Finding the control on this page…' : 'This control isn’t available on this page right now.'}</p> : null}
    <div class="clem-guidance-actions">
      {state === 'unavailable' ? <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry guidance</button> : <button type="button" disabled={state === 'checking'} onClick={show}>{state === 'checking' ? 'Checking…' : 'Show me'}</button>}
      <button type="button" onClick={onBack}>{returnLabel}</button>
      <button type="button" onClick={onClose} aria-label="Close guidance">Close</button>
    </div>
  </aside>;
}
