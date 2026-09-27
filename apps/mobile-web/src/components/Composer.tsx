/**
 * The one composer: a floating card with the words on top and the controls
 * in a quiet row beneath (attach, who answers with what, mic, send). It is
 * the capsule on Home, Needs you and the Chats list, and the docked composer
 * in a thread; the two differ only in what the row carries and where the
 * card sits. No focus ring: the card darkens its own edge when it has focus,
 * the way a native field does. Attachments come from the "+" sheet (camera,
 * photo library, Files) and upload as they are picked, so the send is instant.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChatAttachment } from '@clem/chat-engine';
import { Sheet } from './Sheet';
import { haptic } from '../lib/native-bridge';
import { useDictation } from '../lib/use-dictation';
import { HoldToTalk, holdToTalkAvailable } from '../lib/hold-to-talk';
import { attachmentKind, attachmentLabel, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '../lib/attachments';

export interface UploadResult { id: string; name: string; ok: boolean; error: string | null }

export interface ComposerProps {
  value: string;
  onChange: (next: string) => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  placeholder: string;
  ariaLabel: string;
  /** Uploads one picked file and returns the daemon's id. Omit to hide "+". */
  upload?: (file: File) => Promise<UploadResult>;
  /** Chips between "+" and the mic: who answers, in what mode. */
  chips?: ComponentChildren;
  disabled?: boolean;
  /** A turn is running: the arrow sends into it and a stop square appears. */
  canStop?: boolean;
  stopping?: boolean;
  onStop?: () => void;
  /** The capsule grows to four lines, a thread to seven. */
  compact?: boolean;
  textareaRef?: { current: HTMLTextAreaElement | null };
}

interface Staged extends ChatAttachment {
  uploading?: boolean;
  error?: string;
}

export function Composer(props: ComposerProps) {
  const { value, onChange, onSend, placeholder, ariaLabel, upload, chips, disabled, canStop, stopping, onStop, compact } = props;
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = props.textareaRef ?? localRef;
  const [staged, setStaged] = useState<Staged[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const photosRef = useRef<HTMLInputElement | null>(null);
  const filesRef = useRef<HTMLInputElement | null>(null);
  const { available: dictation, listening: dictating, toggle: toggleDictation, stop: stopDictation } = useDictation(
    value,
    onChange,
    () => textareaRef.current?.focus(),
  );
  // Hold to talk: the words are transcribed on the Mac. Web Speech remains
  // the fallback where no microphone stream is available to the page.
  const holdable = holdToTalkAvailable();
  const talker = useRef<HoldToTalk | null>(null);
  const [holding, setHolding] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const listening = holding || dictating;
  const beginHold = async (event: Event) => {
    event.preventDefault();
    if (disabled || holding || transcribing) return;
    setVoiceNote(null);
    const t = new HoldToTalk();
    talker.current = t;
    setHolding(true);
    haptic('light');
    try { await t.start(); } catch (err) {
      setHolding(false);
      talker.current = null;
      setVoiceNote(err instanceof Error ? err.message : 'The microphone is not available.');
    }
  };
  const endHold = async () => {
    const t = talker.current;
    if (!t) return;
    talker.current = null;
    setHolding(false);
    setTranscribing(true);
    try {
      const words = await t.stop();
      if (words) {
        haptic('medium');
        const joined = value.trim() ? `${value.replace(/\s+$/, '')} ${words}` : words;
        onChange(joined);
        textareaRef.current?.focus();
      }
    } catch (err) {
      setVoiceNote(err instanceof Error ? err.message : 'Could not transcribe that.');
    } finally {
      setTranscribing(false);
    }
  };
  useEffect(() => () => { talker.current?.cancel(); }, []);

  const autoresize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 100 : 172)}px`;
  };
  useEffect(() => { autoresize(textareaRef.current); }, [value]);
  useEffect(() => () => { for (const s of staged) if (s.previewUrl) URL.revokeObjectURL(s.previewUrl); }, []);

  const ready = staged.filter((s) => !s.uploading && !s.error);
  const uploading = staged.some((s) => s.uploading);
  const canSend = !disabled && !uploading && (value.trim().length > 0 || ready.length > 0);

  const submit = (event?: Event) => {
    event?.preventDefault();
    if (!canSend) return;
    haptic('medium');
    stopDictation();
    const text = value.trim();
    const sending: ChatAttachment[] = ready.map(({ uploading: _u, error: _e, ...rest }) => rest);
    onChange('');
    setStaged([]);
    if (textareaRef.current) { textareaRef.current.value = ''; autoresize(textareaRef.current); }
    onSend(text, sending);
  };

  const pick = async (files: FileList | null) => {
    setAttachOpen(false);
    if (!files || !upload) return;
    const chosen = Array.from(files).slice(0, Math.max(0, MAX_ATTACHMENTS - staged.length));
    for (const file of chosen) {
      const kind = attachmentKind(file.name, file.type);
      const localId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const previewUrl = kind === 'image' ? URL.createObjectURL(file) : undefined;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setStaged((prev) => [...prev, { id: localId, name: file.name, kind, previewUrl, error: 'Too large (25 MB max)' }]);
        continue;
      }
      setStaged((prev) => [...prev, { id: localId, name: file.name, kind, previewUrl, uploading: true }]);
      try {
        const result = await upload(file);
        setStaged((prev) => prev.map((s) => (s.id === localId
          ? { ...s, id: result.ok && result.id ? result.id : s.id, name: result.name || s.name, uploading: false, ...(result.ok ? {} : { error: result.error || 'Could not read this file' }) }
          : s)));
      } catch (err) {
        setStaged((prev) => prev.map((s) => (s.id === localId ? { ...s, uploading: false, error: err instanceof Error ? err.message : 'Upload failed' } : s)));
      }
    }
    haptic('light');
    textareaRef.current?.focus();
  };

  const remove = (id: string) => {
    setStaged((prev) => {
      const gone = prev.find((s) => s.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  };

  const onFiles = (event: Event) => { void pick((event.currentTarget as HTMLInputElement).files); (event.currentTarget as HTMLInputElement).value = ''; };

  return (
    <form class={`composer${compact ? ' composer-compact' : ''}${listening ? ' listening' : ''}`} onSubmit={submit}>
      {staged.length > 0 ? (
        <div class="composer-attachments" aria-label="Attachments">
          {staged.map((s) => (
            <div key={s.id} class={`composer-attachment${s.error ? ' has-error' : ''}${s.uploading ? ' uploading' : ''}`} title={s.error ?? s.name}>
              {s.kind === 'image' && s.previewUrl ? (
                <img src={s.previewUrl} alt="" />
              ) : (
                <span class="composer-attachment-doc" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
                </span>
              )}
              <span class="composer-attachment-name">{s.error ? s.error : attachmentLabel(s)}</span>
              {s.uploading ? <span class="composer-attachment-spin" role="status" aria-label="Uploading" /> : null}
              <button type="button" class="composer-attachment-remove" aria-label={`Remove ${attachmentLabel(s)}`} onClick={() => remove(s.id)}>×</button>
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        class="composer-input chat-input"
        rows={1}
        value={value}
        aria-label={ariaLabel}
        placeholder={holding ? 'Listening… let go to finish' : transcribing ? 'Writing down what you said…' : dictating ? 'Listening…' : placeholder}
        enterkeyhint="send"
        autocomplete="off"
        disabled={disabled}
        onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          if (event.isComposing) return;
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
        }}
      />
      <div class="composer-row">
        {upload ? (
          <button type="button" class="composer-icon composer-attach" aria-label="Attach a photo or file" aria-haspopup="dialog" aria-expanded={attachOpen} disabled={disabled || staged.length >= MAX_ATTACHMENTS} onClick={() => { haptic('light'); setAttachOpen(true); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        ) : null}
        {chips ? <div class="composer-chips">{chips}</div> : null}
        <span class="composer-spacer" aria-hidden="true" />
        {holdable ? (
          <button
            type="button"
            class={`composer-icon chat-mic${holding ? ' holding' : ''}${transcribing ? ' transcribing' : ''}`}
            aria-label={holding ? 'Let go to finish' : 'Hold to talk'}
            aria-pressed={holding}
            disabled={disabled || transcribing}
            onPointerDown={(e) => { void beginHold(e); }}
            onPointerUp={() => { void endHold(); }}
            onPointerCancel={() => { void endHold(); }}
            onPointerLeave={() => { if (holding) void endHold(); }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
            </svg>
          </button>
        ) : dictation ? (
          <button type="button" class="composer-icon chat-mic" aria-label={dictating ? 'Stop dictation' : 'Dictate'} aria-pressed={dictating} disabled={disabled} onClick={toggleDictation}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
            </svg>
          </button>
        ) : null}
        {canStop ? (
          <button class="chat-stop" type="button" onClick={onStop} disabled={stopping} aria-label="Stop">
            {stopping ? <span class="chat-stop-busy" aria-hidden="true" /> : (
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
            )}
          </button>
        ) : null}
        <button class="chat-send" type="submit" disabled={!canSend} aria-label={canStop ? 'Send while she works' : 'Send'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
      {voiceNote ? <p class="composer-note" role="alert">{voiceNote}</p> : null}
      {upload ? (
        <>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFiles} />
          <input ref={photosRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
          <input ref={filesRef} type="file" multiple hidden onChange={onFiles} />
          <Sheet open={attachOpen} onClose={() => setAttachOpen(false)} ariaLabel="Attach" class="sheet-compact">
            <nav class="switcher-list" aria-label="Attach">
              <button type="button" class="switcher-row" onClick={() => { haptic('light'); cameraRef.current?.click(); }}>
                <span class="switcher-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg></span>
                <span class="switcher-label">Take a photo</span>
              </button>
              <button type="button" class="switcher-row" onClick={() => { haptic('light'); photosRef.current?.click(); }}>
                <span class="switcher-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-9 8" /></svg></span>
                <span class="switcher-label">Photo library</span>
              </button>
              <button type="button" class="switcher-row" onClick={() => { haptic('light'); filesRef.current?.click(); }}>
                <span class="switcher-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg></span>
                <span class="switcher-label">Files</span>
              </button>
            </nav>
          </Sheet>
        </>
      ) : null}
    </form>
  );
}
