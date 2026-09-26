/**
 * The floating ask capsule — the app's one persistent control on Home,
 * Needs you and the Chats list. It is the shared Composer in its compact
 * placement: what you type (and attach) opens a new conversation and sends
 * itself. Dictation is offered only where the platform provides it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChatAttachment } from '@clem/chat-engine';
import { Composer } from './Composer';
import { uploadChatAttachment } from '../lib/api';
import { useKeyboardInset } from '../lib/use-keyboard-inset';

interface Props {
  onAsk: (text: string, attachments?: ChatAttachment[]) => void;
}

export function AskCapsule({ onAsk }: Props) {
  const [draft, setDraft] = useState('');
  // iOS Safari keeps a fixed element behind the keyboard; the visual
  // viewport says exactly how much of the layout viewport is covered.
  const keyboardInset = useKeyboardInset();
  // The page reserves exactly the capsule's height below its content, so the
  // last row is never hidden behind the card (live 09-26: Needs you's first
  // card sat under the composer on Home).
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = () => document.documentElement.style.setProperty('--capsule-h', `${el.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--capsule-h'); };
  }, []);
  return (
    <>
      <div class="ask-capsule-fade" aria-hidden="true" style={keyboardInset ? { bottom: `${keyboardInset}px` } : undefined} />
      <div ref={wrap} class="ask-capsule" style={keyboardInset ? { '--kb-inset': `${keyboardInset}px` } : undefined}>
        <Composer
          compact
          value={draft}
          onChange={setDraft}
          placeholder="Ask Clementine…"
          ariaLabel="Ask Clementine"
          upload={uploadChatAttachment}
          onSend={(text, attachments) => onAsk(text, attachments)}
        />
      </div>
    </>
  );
}
