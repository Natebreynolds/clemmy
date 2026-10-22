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
import type { DictationPhase } from '../lib/browser-dictation';
import { appendDictationText, bindDictationForegroundCancellation, microphoneProblem, microphoneUnavailableReason } from '../lib/dictation-support';
import { attachmentKind, attachmentLabel, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '../lib/attachments';
import { mobileDrafts, type MobileStagedAttachment } from '../lib/file-context';

export interface UploadResult { id: string; name: string; ok: boolean; error: string | null }

export interface ComposerProps {
  value: string;
  onChange: (next: string) => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void | boolean | Promise<void | boolean>;
  /** Optional voice/mode controls share the bounded draft scroller. */
  leading?: ComponentChildren;
  /** Context is rendered above the words and never folded out of sight. */
  context?: ComponentChildren;
  contextKey?: string;
  sendBlocked?: string;
  reservedAttachments?: number;
  /** A retry in the transcript settled attachments still shown in this composer. */
  settledAttachmentIds?: readonly string[];
  /** Saved with the conversation, including uploads that finish after leaving. */
  attachmentScope?: string;
  placeholder: string;
  ariaLabel: string;
  /** Uploads one picked file and returns the daemon's id. Omit to hide "+". */
  upload?: (file: File) => Promise<UploadResult>;
  /** Optional secondary choices get their own wrapping row above the controls. */
  chips?: ComponentChildren;
  /** Spoken conversation and dictation must never own the microphone together. */
  voiceActive?: boolean;
  onDictationActiveChange?: (active: boolean) => void;
  onDictationStart?: () => void;
  disabled?: boolean;
  /** A turn is running: the arrow sends into it and a stop square appears. */
  canStop?: boolean;
  stopping?: boolean;
  onStop?: () => void;
  /** The capsule grows to four lines, a thread to seven. */
  compact?: boolean;
  textareaRef?: { current: HTMLTextAreaElement | null };
}

type Staged = MobileStagedAttachment;
const NO_ATTACHMENTS: Staged[] = [];

export function Composer(props: ComposerProps) {
  const { value, onChange, onSend, placeholder, ariaLabel, upload, chips, disabled, canStop, stopping, onStop, compact } = props;
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = props.textareaRef ?? localRef;
  const attachmentScope = props.attachmentScope;
  const draftGeneration = useRef(mobileDrafts.generation);
  const mounted = useRef(true);
  const [staged, setStagedState] = useState<Staged[]>(() => attachmentScope ? mobileDrafts.read(attachmentScope).stagedAttachments ?? NO_ATTACHMENTS : []);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const setStaged = (update: (previous: Staged[]) => Staged[]) => {
    // An upload completing after sign-out cannot revive the previous account's draft.
    if (attachmentScope && draftGeneration.current !== mobileDrafts.generation) return;
    const previous = attachmentScope ? mobileDrafts.read(attachmentScope).stagedAttachments ?? NO_ATTACHMENTS : stagedRef.current;
    const next = update(previous);
    if (attachmentScope) mobileDrafts.patchInGeneration(attachmentScope, draftGeneration.current, { stagedAttachments: next });
    else {
      const kept = new Set(next.map(file => file.previewUrl));
      for (const file of previous) if (file.previewUrl && !kept.has(file.previewUrl)) URL.revokeObjectURL(file.previewUrl);
    }
    stagedRef.current = next;
    if (mounted.current) setStagedState(next);
  };
  useEffect(() => {
    if (!attachmentScope) return;
    const sync = () => {
      const next = draftGeneration.current === mobileDrafts.generation
        ? mobileDrafts.read(attachmentScope).stagedAttachments ?? NO_ATTACHMENTS : NO_ATTACHMENTS;
      stagedRef.current = next; setStagedState(next);
    };
    sync();
    return mobileDrafts.subscribe(sync);
  }, [attachmentScope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!attachmentScope) for (const file of stagedRef.current) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    };
  }, [attachmentScope]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [sendProblem, setSendProblem] = useState('');
  useEffect(() => { setSendProblem(''); }, [props.contextKey]);
  useEffect(() => {
    if (!props.settledAttachmentIds?.length) return;
    const settled = new Set(props.settledAttachmentIds);
    setStaged(current => current.filter(file => !settled.has(file.id)));
    setSendProblem('');
  }, [props.settledAttachmentIds]);
  const [attachOpen, setAttachOpen] = useState(false);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const photosRef = useRef<HTMLInputElement | null>(null);
  const filesRef = useRef<HTMLInputElement | null>(null);
  const draftScopeRef = useRef(attachmentScope);
  draftScopeRef.current = attachmentScope;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const voiceActiveRef = useRef(props.voiceActive);
  voiceActiveRef.current = props.voiceActive;
  const ownsDictationDraft = () => mounted.current && document.visibilityState !== 'hidden' && draftGeneration.current === mobileDrafts.generation && draftScopeRef.current === attachmentScope && !voiceActiveRef.current;
  const { available: dictation, listening: dictating, starting: speechStarting, transcribing: speechTranscribing, error: speechError, toggle: toggleDictation, cancel: cancelSpeech } = useDictation(
    value,
    onChange,
    () => textareaRef.current?.focus(),
    ownsDictationDraft,
  );
  // The Mac capture path remains preferred. A capture failure never changes
  // the provider; platform speech keeps only its existing unsupported path.
  const holdable = holdToTalkAvailable();
  const talker = useRef<HoldToTalk | null>(null);
  const [capturePhase, setCapturePhaseState] = useState<DictationPhase>('idle');
  const capturePhaseRef = useRef<DictationPhase>('idle');
  const setCapturePhase = (phase: DictationPhase) => { capturePhaseRef.current = phase; if (mounted.current) setCapturePhaseState(phase); };
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const starting = capturePhase === 'starting' || speechStarting;
  const listening = capturePhase === 'recording' || dictating;
  const transcribing = capturePhase === 'transcribing' || speechTranscribing;
  const dictationActive = starting || listening || transcribing;
  const activeChangeRef = useRef(props.onDictationActiveChange);
  activeChangeRef.current = props.onDictationActiveChange;
  useEffect(() => { activeChangeRef.current?.(dictationActive); }, [dictationActive]);

  const cancelCapture = () => {
    talker.current?.cancel();
    talker.current = null;
    setCapturePhase('idle');
  };
  const cancelDictation = () => { cancelCapture(); cancelSpeech(); };
  useEffect(() => bindDictationForegroundCancellation(document, window, () => {
    cancelDictation();
    if (mounted.current) setVoiceNote(null);
  }), []);
  const beginCapture = async () => {
    if (disabled || submittingRef.current || talker.current || !ownsDictationDraft()) return;
    setVoiceNote(null);
    const t = new HoldToTalk();
    const scope = attachmentScope;
    const owns = () => ownsDictationDraft() && talker.current === t && draftScopeRef.current === scope;
    talker.current = t;
    setCapturePhase('starting');
    haptic('light');
    try {
      const ready = await t.start();
      if (owns() && ready) setCapturePhase('recording');
      else t.cancel();
    } catch (err) {
      if (!owns()) return;
      t.cancel();
      talker.current = null;
      setCapturePhase('idle');
      setVoiceNote(microphoneProblem(err));
    }
  };
  const finishCapture = async () => {
    const t = talker.current;
    if (!t) return;
    const scope = attachmentScope;
    const owns = () => ownsDictationDraft() && talker.current === t && draftScopeRef.current === scope;
    setCapturePhase('transcribing');
    try {
      const words = await t.stop();
      if (owns() && words) {
        haptic('medium');
        const current = scope ? mobileDrafts.read(scope).text : valueRef.current;
        changeRef.current(appendDictationText(current, words));
        textareaRef.current?.focus();
      }
    } catch (err) {
      if (owns()) setVoiceNote(microphoneProblem(err));
    } finally {
      if (owns()) { talker.current = null; setCapturePhase('idle'); }
    }
  };
  const toggleMicrophone = () => {
    if (props.voiceActive || disabled || submittingRef.current) return;
    if (!dictationActive) props.onDictationStart?.();
    if (holdable) {
      if (capturePhaseRef.current === 'recording') void finishCapture();
      else if (capturePhaseRef.current !== 'idle') cancelCapture();
      else void beginCapture();
    } else if (dictation) {
      setVoiceNote(null);
      if (speechStarting || speechTranscribing) cancelSpeech();
      else toggleDictation();
    } else setVoiceNote(microphoneUnavailableReason());
  };
  useEffect(() => { if (props.voiceActive || disabled) { cancelDictation(); setVoiceNote(null); } }, [props.voiceActive, disabled]);
  useEffect(() => () => { cancelDictation(); }, [attachmentScope]);
  useEffect(() => {
    const checkOwner = () => { if (draftGeneration.current !== mobileDrafts.generation) cancelDictation(); };
    return mobileDrafts.subscribe(checkOwner);
  }, []);
  useEffect(() => () => { talker.current?.cancel(); talker.current = null; cancelSpeech(); activeChangeRef.current?.(false); }, []);

  const autoresize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 100 : 172)}px`;
  };
  useEffect(() => { autoresize(textareaRef.current); }, [value]);
  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      autoresize(field);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [compact]);

  // Resting, empty and untouched, the card is one slim line: "+", the words,
  // the mic and send. Touching it opens the full card with its chips. Leaving
  // waits a beat before it folds, so a tap on a chip lands on the chip.
  const [focused, setFocused] = useState(false);
  const foldTimer = useRef<number | null>(null);
  const onFieldFocus = () => {
    if (foldTimer.current !== null) { window.clearTimeout(foldTimer.current); foldTimer.current = null; }
    setFocused(true);
  };
  const onFieldBlur = () => {
    if (foldTimer.current !== null) window.clearTimeout(foldTimer.current);
    foldTimer.current = window.setTimeout(() => { foldTimer.current = null; setFocused(false); }, 240);
  };
  useEffect(() => () => { if (foldTimer.current !== null) window.clearTimeout(foldTimer.current); }, []);

  const ready = staged.filter((s) => !s.uploading && !s.error);
  const attachmentLimit = Math.max(0, MAX_ATTACHMENTS - (props.reservedAttachments ?? 0));
  const uploading = staged.some((s) => s.uploading);
  const fileSteeringBlocked = Boolean(canStop && staged.length);
  const sendBlocked = props.sendBlocked || (staged.length > attachmentLimit ? 'Remove one attachment to include the selected file. A message can include up to 10 files.' : fileSteeringBlocked ? 'Files can be sent after Clem finishes this turn.' : '');
  const canSend = !disabled && !props.voiceActive && !dictationActive && !submitting && !sendBlocked && !uploading && (value.trim().length > 0 || ready.length > 0);
  const slim = !props.leading && !focused && !value.trim() && staged.length === 0 && !props.context && !dictationActive && !submitting && !sendBlocked && !sendProblem && !voiceNote && (!speechError || props.voiceActive);

  const submit = async (event?: Event) => {
    event?.preventDefault();
    if (!canSend || submittingRef.current || talker.current || props.voiceActive) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSendProblem('');
    haptic('medium');
    cancelDictation();
    const text = value.trim();
    const sending: ChatAttachment[] = ready.map(({ uploading: _u, error: _e, ...rest }) => rest);
    const original = value;
    try {
      const accepted = await onSend(text, sending);
      if (accepted === false) return;
      if (draftGeneration.current === mobileDrafts.generation) {
        const currentText = attachmentScope ? mobileDrafts.read(attachmentScope).text : valueRef.current;
        if (currentText === original) onChange('');
      }
      const sent = new Set(sending.map(file => file.id));
      setStaged(current => current.filter(file => !sent.has(file.id)));
    } catch (error) {
      setSendProblem(error instanceof Error ? error.message : 'Your message could not be sent. Try again.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const pick = async (files: FileList | null) => {
    setAttachOpen(false);
    if (!files || !upload) return;
    const chosen = Array.from(files).slice(0, Math.max(0, attachmentLimit - staged.length));
    for (const file of chosen) {
      if (draftGeneration.current !== mobileDrafts.generation || (!attachmentScope && !mounted.current)) break;
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
      return prev.filter((s) => s.id !== id);
    });
  };

  const onFiles = (event: Event) => { void pick((event.currentTarget as HTMLInputElement).files); (event.currentTarget as HTMLInputElement).value = ''; };

  return (
    <form class={`composer composer-layout${compact ? ' composer-compact' : ''}${slim ? ' composer-slim' : ''}${listening ? ' listening' : ''}`} onSubmit={event => { void submit(event); }}>
      <div class="composer-body">
        {props.leading}
        {props.context}
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
                <button type="button" class="composer-attachment-remove" disabled={submitting} aria-label={`Remove ${attachmentLabel(s)}`} onClick={() => remove(s.id)}>×</button>
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
          placeholder={starting ? 'Starting microphone…' : transcribing ? 'Writing down what you said…' : listening ? 'Listening… tap the mic to finish' : placeholder}
          enterkeyhint="send"
          autocomplete="off"
          disabled={disabled || props.voiceActive}
          onFocus={onFieldFocus}
          onBlur={onFieldBlur}
          onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.isComposing) return;
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
          }}
        />
        {chips ? <div class="composer-chips">{chips}</div> : null}
        {submitting ? <p class="composer-note" role="status">Preparing and sending…</p> : null}
        {sendBlocked ? <p class="composer-note" role="status">{sendBlocked}</p> : null}
        {sendProblem ? <p class="composer-note" role="alert">{sendProblem}</p> : null}
        {dictationActive ? <p class="composer-note" role="status">{starting ? 'Starting microphone… Allow access if asked. Tap the mic again to cancel.' : transcribing ? 'Transcribing… Tap the mic again to cancel.' : 'Listening. Tap the mic again to finish.'}</p> : null}
        {voiceNote || (!holdable && speechError) ? <p class="composer-note" role="alert">{voiceNote || speechError}</p> : null}
      </div>
      <div class="composer-row" role="group" aria-label="Message actions">
        {upload ? (
          <button type="button" class="composer-icon composer-attach" aria-label="Attach a photo or file" aria-haspopup="dialog" aria-expanded={attachOpen} disabled={disabled || props.voiceActive || submitting || staged.length >= attachmentLimit} onClick={() => { haptic('light'); setAttachOpen(true); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        ) : null}
        <span class="composer-spacer" aria-hidden="true" />
          <button
            type="button"
            class={`composer-icon chat-mic${listening ? ' holding' : ''}${transcribing || starting ? ' transcribing' : ''}`}
            aria-label={starting ? 'Cancel dictation' : transcribing ? 'Cancel transcription' : listening ? 'Finish dictation' : 'Dictate'}
            aria-pressed={dictationActive}
            disabled={disabled || props.voiceActive || submitting}
            onClick={toggleMicrophone}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
            </svg>
          </button>
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
