import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, KeyRound, Loader2, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { connectJev, disconnectJev, type JevStatus } from '@/lib/settings';

const KEY_URL = 'https://console.typesafe.ai/keys';

export function JevConnectForm({ status, onDone }: { status?: JevStatus; onDone: () => void }) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = Boolean(status?.configured);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['settings'] });
    void qc.invalidateQueries({ queryKey: ['jev'] });
    onDone();
  };

  const onConnect = async () => {
    if (!apiKey.trim()) { setError('Paste a TypeSafe API key.'); return; }
    setBusy(true); setError(null);
    try {
      await connectJev(apiKey.trim());
      setApiKey('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const onDisconnect = async () => {
    setBusy(true); setError(null);
    try {
      await disconnectJev();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-border bg-canvas p-4">
      <div className="mb-2 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted" aria-hidden />
        <h4 className="text-label text-fg">Jev (TypeSafe)</h4>
      </div>
      <p className="mb-3 text-small text-muted">
        Jev answers Clem’s yes/no and pick-one checks in under half a second so ranking, memory primer, and write-boundary reviews don’t wait on a chat model.
      </p>
      {connected
        ? <p className="mb-3 inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Connected · {status?.model} · fast decisions {status?.enabled ? 'on' : 'paused'}</p>
        : <p className="mb-3 text-small text-muted">Not connected. Paste a key to turn Jev on for the next turn.</p>}
      <a href={KEY_URL} target="_blank" rel="noopener noreferrer" className="mb-3 inline-flex items-center gap-1 text-small text-primary hover:underline">
        Get a TypeSafe API key <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
      {!connected && (
        <Field label="API key" hint="The key stays on this machine. Ranking, primer, and write checks send a short request plus session snippets to api.typesafe.ai.">{(id) => (
          <Input id={id} type="password" value={apiKey} placeholder="paste your API key" autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onConnect(); }} />
        )}</Field>
      )}
      <div className="flex items-center gap-2">
        {connected
          ? <Button variant="secondary" size="sm" onClick={() => void onDisconnect()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Unplug className="h-4 w-4" aria-hidden />} Disconnect
            </Button>
          : <Button onClick={() => void onConnect()} disabled={busy || !apiKey.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
              {busy ? 'Connecting…' : 'Connect'}
            </Button>}
      </div>
      {status?.warning && <p className="mt-2 text-small text-warning">{status.warning}</p>}
      {error && <p className="mt-2 text-small text-danger">{error}</p>}
    </div>
  );
}
