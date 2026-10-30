import { useState, type FormEvent } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { keyRequestSavedReply, type KeyRequest } from '@clem/chat-engine';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';

/** Clem's question needs a key only the owner has. Each goes in a hidden
 *  field straight to the server's credential route (the one Connect → MCP
 *  servers uses), never into the chat, the model or memory. Once every key is
 *  saved, the reply names the server and the key names, never a value. */
export function KeyRequestCard({ request, onAnswer }: {
  request: KeyRequest;
  onAnswer: (text: string) => Promise<void> | void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = request.keys.every((key) => (values[key] ?? '').trim().length > 0);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      for (const key of request.keys) {
        await api(`/api/console/mcp-servers/${encodeURIComponent(request.server)}/credential`, {
          method: 'POST', body: JSON.stringify({ key, value: values[key]!.trim() }),
        });
      }
      setValues({});
      await onAnswer(keyRequestSavedReply(request));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'The key could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-3"
      aria-label={`Key for ${request.server}`}>
      <p className="flex items-start gap-2 text-small text-muted">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>Goes straight to {request.server} on this Mac. It never appears in this chat, and Clem never sees it.</span>
      </p>
      {request.keys.map((key, index) => (
        <label key={key} className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg">{key}</span>
          <Input type="password" autoComplete="off" spellCheck={false} autoFocus={index === 0}
            value={values[key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
        </label>
      ))}
      {error ? <p role="alert" className="text-small text-danger">{error}</p> : null}
      <div>
        <Button type="submit" size="sm" disabled={!ready || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {request.keys.length === 1 ? 'Save key' : 'Save keys'}
        </Button>
      </div>
    </form>
  );
}
