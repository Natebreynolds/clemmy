/**
 * The floating ask capsule — the app's one persistent control.
 *
 * It floats above the safe area on Home, Needs you, and the Chats list and
 * sends through the same path Home's ask box always used: the text opens a
 * new conversation and sends itself. Dictation is offered only where the
 * platform actually provides it; a microphone that does nothing is a lie.
 */
import { useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/native-bridge';
import { useDictation } from '../lib/use-dictation';
import { useKeyboardInset } from '../lib/use-keyboard-inset';

interface Props {
  onAsk: (text: string) => void;
}

export function AskCapsule({ onAsk }: Props) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { available: dictation, listening, toggle: toggleDictation, stop: stopDictation } = useDictation(
    draft,
    setDraft,
    () => inputRef.current?.focus(),
  );
  // iOS Safari keeps a fixed element behind the keyboard; the visual
  // viewport says exactly how much of the layout viewport is covered.
  const keyboardInset = useKeyboardInset();

  const submit = (event?: Event) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    haptic('medium');
    stopDictation();
    setDraft('');
    onAsk(text);
  };

  return (
    <>
      <div class="ask-capsule-fade" aria-hidden="true" style={keyboardInset ? { bottom: `${keyboardInset}px` } : undefined} />
      <form
        class={`ask-capsule${listening ? ' listening' : ''}`}
        style={keyboardInset ? { '--kb-inset': `${keyboardInset}px` } : undefined}
        onSubmit={submit}
      >
        {dictation ? (
          <button
            type="button"
            class="ask-capsule-mic"
            aria-label={listening ? 'Stop dictation' : 'Dictate'}
            aria-pressed={listening}
            onClick={toggleDictation}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
            </svg>
          </button>
        ) : null}
        <input
          ref={inputRef}
          class="ask-capsule-input"
          value={draft}
          onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
          placeholder={listening ? 'Listening…' : 'Ask Clementine…'}
          aria-label="Ask Clementine"
          enterkeyhint="send"
          autocomplete="off"
        />
        <button class="ask-capsule-send" type="submit" disabled={!draft.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
    </>
  );
}
