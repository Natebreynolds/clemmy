import { useRef, useState, useCallback, type KeyboardEvent, type ChangeEvent } from 'react';
import { Paperclip, ArrowUp, Square, X, Loader2, FileText, SendToBack } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { uploadAttachment } from '@/lib/chat';
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
  onSend,
  onStop,
  onBackground,
  placeholder = 'Ask Clementine anything…',
}: {
  busy: boolean;
  onSend: (input: { text: string; attachmentIds: string[]; attachmentNames: string[] }) => void;
  onStop: () => void;
  /** Detach the running turn to a durable background task (keeps the chat free). */
  onBackground?: () => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

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
  const canSend = !busy && !uploading && (value.trim().length > 0 || readyIds.length > 0);

  const submit = () => {
    if (!canSend) return;
    onSend({
      text: value.trim(),
      attachmentIds: readyIds,
      attachmentNames: attachments.filter((a) => a.status === 'ready').map((a) => a.name),
    });
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

  return (
    <div
      className={cn(
        'rounded-lg border bg-surface shadow-sm transition-colors',
        dragOver ? 'border-primary ring-2 ring-primary/30' : 'border-border',
      )}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-border p-2.5">
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

      <div className="flex items-end gap-2 p-2.5">
        <input ref={fileInput} type="file" multiple hidden onChange={onFilePick} aria-hidden />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => fileInput.current?.click()}
          aria-label="Attach a file"
          title="Attach a file"
        >
          <Paperclip className="h-5 w-5" aria-hidden />
        </Button>

        <textarea
          ref={textarea}
          value={value}
          onChange={(e) => { setValue(e.target.value); autoGrow(); }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          aria-label="Message Clementine"
          className="max-h-[220px] min-h-[24px] flex-1 resize-none bg-transparent py-2 text-body-lg text-fg outline-none placeholder:text-faint"
        />

        {busy ? (
          <>
            {onBackground && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onBackground}
                aria-label="Continue in background"
                title="Continue in background — keeps working, reports back here, frees the chat"
              >
                <SendToBack className="h-4 w-4" aria-hidden />
              </Button>
            )}
            <Button variant="secondary" size="icon" onClick={onStop} aria-label="Stop" title="Stop">
              <Square className="h-4 w-4" aria-hidden />
            </Button>
          </>
        ) : (
          <Button size="icon" onClick={submit} disabled={!canSend} aria-label="Send" title="Send">
            <ArrowUp className="h-5 w-5" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}
