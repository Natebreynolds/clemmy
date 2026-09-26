/**
 * The floating ask capsule — the app's one persistent control on Home,
 * Needs you and the Chats list. It is the shared Composer in its compact
 * placement: what you type (and attach) opens a new conversation and sends
 * itself. Dictation is offered only where the platform provides it.
 */
import { useState } from 'preact/hooks';
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
  return (
    <>
      <div class="ask-capsule-fade" aria-hidden="true" style={keyboardInset ? { bottom: `${keyboardInset}px` } : undefined} />
      <div class="ask-capsule" style={keyboardInset ? { '--kb-inset': `${keyboardInset}px` } : undefined}>
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
