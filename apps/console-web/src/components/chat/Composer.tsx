import type { ComposerMode, TaskMode } from '@/lib/task-mode';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { useRef, useState, useCallback, type KeyboardEvent, type ChangeEvent, type RefObject } from 'react';
import { Paperclip, ArrowUp, Square, X, Loader2, FileText, SendToBack, Mic } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { uploadAttachment } from '@/lib/chat';
import { useDictation } from '@/lib/use-dictation';
import { cn } from '@/lib/cn';

const MAX_BYTES = 30 * 1024 * 1024;

interface Attachment {
  localId: string;
  name: string;
  status: 'uploading' | 'ready' | 'error';
  id?: string;
  error?: string;
}

let localSeq = 0;

export function Composer({
  busy,
  mode: controlledMode,
  onModeChange,
  activeTaskMode,
  pendingPost,
  onRetryPending,
  onCancelPending,
  onSend,
  onStop,
  onBackground,
  inputRef,
  placeholder = 'Ask Clementine anything…',
  sessionId,
}: {
  busy: boolean;
  mode?: ComposerMode;
  onModeChange?: (mode: ComposerMode) => void;
  /** The conversation this composer feeds — a brain switch from the chip re-pins it. */
  sessionId?: string;
  activeTaskMode?: TaskMode;
  pendingPost?: { input: string; taskMode?: TaskMode } | null;
  onRetryPending?: () => Promise<void>;
  onCancelPending?: () => Promise<void>;
  onSend: (input: { text: string; attachmentIds: string[]; attachmentNames: string[]; taskMode?: TaskMode }) => Promise<void> | void;
  onStop: () => void;
  /** Detach the running turn to a durable background task (keeps the chat free). */
  onBackground?: () => void;
  /** Explicit adjacent-composer focus target for transient foreground controls. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');
  const [deliveryError, setDeliveryError] = useState('');
  const recover = (action?: () => Promise<void>) => { setDeliveryError(''); void action?.().catch(error => setDeliveryError(error instanceof Error ? error.message : 'Request could not be confirmed.')); };
  const [localMode, setLocalMode] = useState<ComposerMode>('normal');
  const mode = controlledMode ?? localMode;
  const planning = busy ? activeTaskMode?.kind === 'plan' : mode === 'plan';
  const changeMode = (next: ComposerMode) => { setLocalMode(next); onModeChange?.(next); };
  const { available: dictation, listening, toggle: toggleDictation, stop: stopDictation } = useDictation(
    value,
    (next) => { setValue(next); autoGrow(); },
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const localTextarea = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? localTextarea;

  const autoGrow = () => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const localId = `f${++localSeq}`;
      if (file.size > MAX_BYTES) {
        setAttachments((p) => [...p, { localId, name: file.name, status: 'error', error: 'Over 30 MB' }]);
        continue;
      }
      setAttachments((p) => [...p, { localId, name: file.name, status: 'uploading' }]);
      void uploadAttachment(file)
        .then((res) => {
          setAttachments((p) => p.map((a) => a.localId === localId
            ? (res.ok ? { ...a, status: 'ready', id: res.id } : { ...a, status: 'error', error: res.error })
            : a));
        })
        .catch(() => {
          // A network-level reject (offline, dropped socket) otherwise leaves the
          // chip spinning forever and blocks Send. Mark it errored so it can be
          // removed via its X and no longer counts as an in-flight upload.
          setAttachments((p) => p.map((a) => a.localId === localId
            ? { ...a, status: 'error', error: 'Upload failed' }
            : a));
        });
    }
  }, []);

  const onFilePick = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  };

  const removeAttachment = (localId: string) =>
    setAttachments((p) => p.filter((a) => a.localId !== localId));

  const uploading = attachments.some((a) => a.status === 'uploading');
  const readyIds = attachments.filter((a) => a.status === 'ready' && a.id).map((a) => a.id!);
  // Mid-run steering: TEXT can be sent while Clem is working — it reaches her
  // at the next step without stopping the run. Attachments still wait for the
  // turn to finish (a file mid-run would have to start a new turn).
  const canSend = !uploading
    && !(pendingPost && !busy)
    && (value.trim().length > 0 || readyIds.length > 0)
    && !(busy && readyIds.length > 0)
    && !(busy && activeTaskMode?.kind === 'execute');

  const submit = () => {
    if (!canSend) return;
    // Sending ends the utterance: otherwise recognition keeps running and
    // appends the next thing said into an already-cleared composer.
    stopDictation();
    setDeliveryError('');
    void Promise.resolve(onSend({
      text: value.trim(),
      taskMode: busy ? activeTaskMode : { version: 1, kind: mode },
      attachmentIds: readyIds,
      attachmentNames: attachments.filter((a) => a.status === 'ready').map((a) => a.name),
    })).catch(error => setDeliveryError(error instanceof Error ? error.message : 'Could not send.'));
    setValue('');
    setAttachments([]);
    requestAnimationFrame(autoGrow);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't send while an IME composition is active (Japanese/Chinese/Korean) —
    // the Enter that commits candidates would otherwise fire the message.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const hint = busy && activeTaskMode?.kind === 'execute'
    ? 'Executing the reviewed plan'
    : planning
      ? (busy ? 'Planning · investigating with read-only tools' : 'Plan shows you the steps first, then you say go.')
      : busy ? 'Anything you send now reaches her at her next step.' : 'Act does it now. Plan shows you the steps first.';

  return (
    <div>
    <div
      // One capsule floats over the thread: the box, its mode and model, and
      // its send. The focus ring lives HERE, on the wrapper: the textarea sets
      // outline-none (an outline inside the box reads as a second border), so
      // without this replacement ring a keyboard user could not see where they
      // were.
      //
      // It keys off the TEXTAREA's :focus-visible, not the box's :focus-within,
      // for two reasons. :focus-within matches :focus, so a mouse click painted
      // a 2px outline that stayed for the whole typing session — the one site
      // in the console breaking the :focus-visible-only policy that styles.css
      // sets out and explains. And :focus-within also fires for the buttons
      // inside this box, which have their own base ring, so tabbing to Send
      // drew two concentric outlines.
      className={cn(
        'composer-capsule overflow-hidden rounded-[22px] border bg-surface transition-colors duration-fast',
        'has-[textarea:focus-visible]:outline has-[textarea:focus-visible]:outline-2',
        'has-[textarea:focus-visible]:-outline-offset-2 has-[textarea:focus-visible]:[outline-color:var(--clem-focus)]',
        dragOver ? 'border-primary bg-primary-tint' : 'border-border',
      )}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
    >
      {pendingPost && !busy && <div className="border-b border-border p-3 text-small" role="status">
        <p>Delivery was not confirmed. Retry preserves the exact {pendingPost.taskMode?.kind ?? 'normal'} request.</p>
        <details><summary>View pending request</summary><p className="whitespace-pre-wrap break-words">{pendingPost.input}</p></details>
        <button type="button" onClick={() => recover(onRetryPending)} className="mr-3 underline">Retry exact request</button>
        <button type="button" onClick={() => recover(onCancelPending)} className="underline">Cancel request</button>
      </div>}
      {deliveryError && <p role="alert" className="p-3 text-small text-danger">{deliveryError}</p>}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <span
              key={a.localId}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-caption',
                a.status === 'error' ? 'border-danger/40 bg-danger-tint text-danger' : 'border-border bg-subtle text-muted',
              )}
            >
              {a.status === 'uploading'
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                : <FileText className="h-3.5 w-3.5" aria-hidden />}
              <span className="max-w-40 truncate">{a.name}</span>
              {a.status === 'error' && a.error && <span>· {a.error}</span>}
              <button type="button" onClick={() => removeAttachment(a.localId)} aria-label={`Remove ${a.name}`} className="cursor-pointer hover:text-fg">
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      <input ref={fileInput} type="file" multiple hidden onChange={onFilePick} aria-hidden />
      <textarea
        ref={textarea}
        value={value}
        onChange={(e) => { setValue(e.target.value); autoGrow(); }}
        onPaste={(e) => {
          // Paste an image (screenshot, copied picture) straight into the
          // chat — it rides the same upload pipeline as drag-drop, and Clem
          // can look at it natively via view_image.
          const images = Array.from(e.clipboardData?.items ?? [])
            .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null)
            .map((file, index) => (file.name && !/^image\.\w+$/.test(file.name)
              ? file
              : new File([file], `pasted-image-${Date.now()}-${index + 1}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: file.type })));
          if (images.length === 0) return;
          e.preventDefault();
          addFiles(images);
        }}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={busy ? 'Add to what she’s doing…' : planning ? 'What should Clem investigate and plan?' : placeholder}
        aria-label="Message Clementine"
        className="block max-h-[220px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-body-lg text-fg outline-none placeholder:text-faint"
      />

      <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => fileInput.current?.click()}
          aria-label="Attach a file"
          title="Attach a file"
          className="h-8 w-8 rounded-full"
        >
          <Paperclip className="h-[18px] w-[18px]" aria-hidden />
        </Button>

        <div role="group" aria-label="Mode" className="inline-flex rounded-full bg-subtle p-0.5">
          <button type="button" aria-pressed={!planning} disabled={busy}
            onClick={() => changeMode('normal')}
            className={cn('rounded-full px-3 py-1 text-small font-semibold transition-colors disabled:opacity-60', !planning ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(31,27,22,.08)]' : 'text-muted hover:text-fg')}>
            Act
          </button>
          <button type="button" aria-pressed={planning} disabled={busy}
            onClick={() => changeMode('plan')}
            className={cn('rounded-full px-3 py-1 text-small font-semibold transition-colors disabled:opacity-60', planning ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(31,27,22,.08)]' : 'text-muted hover:text-fg')}>
            Plan
          </button>
        </div>

        <ModelPicker sessionId={sessionId} className="ml-auto" />

        {/* Offered only where the browser actually provides speech recognition —
            a microphone button that does nothing is a lie. The phone has had
            this since it shipped; the desktop's only mic lived in the notch. */}
        {dictation && (
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleDictation}
            aria-label={listening ? 'Stop dictation' : 'Dictate'}
            aria-pressed={listening}
            title={listening ? 'Stop dictation' : 'Dictate'}
            className="h-8 w-8 rounded-full"
          >
            <Mic className={cn('h-[18px] w-[18px]', listening && 'animate-breathe text-primary')} aria-hidden />
          </Button>
        )}

        {busy ? (
          <>
            {onBackground && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onBackground}
                aria-label="Continue in background"
                title="Continue in background — keeps working, reports back here, frees the chat"
                className="h-8 w-8 rounded-full"
              >
                <SendToBack className="h-4 w-4" aria-hidden />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send while she works"
              title="Send while she works — reaches Clem at her next step without stopping the run"
              className="h-8 w-8 rounded-full"
            >
              <ArrowUp className="h-[18px] w-[18px]" aria-hidden />
            </Button>
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className="grid h-9 w-9 place-items-center rounded-full bg-fg text-canvas transition-transform duration-fast hover:opacity-90 active:scale-press"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send"
            title="Send"
            className="grid h-9 w-9 place-items-center rounded-full bg-primary text-primary-fg transition-[transform,background-color,opacity] duration-fast hover:bg-primary-hover active:scale-press disabled:opacity-40"
          >
            <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.25} aria-hidden />
          </button>
        )}
      </div>
    </div>
    <p className="mt-2 text-center text-caption text-faint" role="status">{hint}</p>
    </div>
  );
}
