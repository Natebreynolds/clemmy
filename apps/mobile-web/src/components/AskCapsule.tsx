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
import { mobileDrafts } from '../lib/file-context';

// This window's floating draft is independent of every conversation draft.
const CAPSULE_DRAFT_SCOPE = 'capsule:ask';

interface Props {
  onAsk: (text: string, attachments?: ChatAttachment[]) => void;
}

export function AskCapsule({ onAsk }: Props) {
  const generation = useRef(mobileDrafts.generation);
  const [draft, setDraftState] = useState(() => mobileDrafts.read(CAPSULE_DRAFT_SCOPE).text);
  useEffect(() => {
    const sync = () => setDraftState(generation.current === mobileDrafts.generation ? mobileDrafts.read(CAPSULE_DRAFT_SCOPE).text : '');
    sync();
    return mobileDrafts.subscribe(sync);
  }, []);
  const setDraft = (text: string) => { mobileDrafts.patchInGeneration(CAPSULE_DRAFT_SCOPE, generation.current, { text }); };
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
      <div class="ask-capsule-fade" aria-hidden="true" />
      <div ref={wrap} class="ask-capsule">
        <Composer
          compact
          value={draft}
          attachmentScope={CAPSULE_DRAFT_SCOPE}
          onChange={setDraft}
          placeholder="Ask Clem…"
          ariaLabel="Ask Clem"
          upload={uploadChatAttachment}
          onSend={(text, attachments) => onAsk(text, attachments)}
        />
      </div>
    </>
  );
}
