import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { getCredentials, setCredential } from '@/lib/connect';
import { connectJev, getJevStatus } from '@/lib/settings';
import { usePoll } from '@/lib/poll';
import { JEV_KEY_URL } from '@/screens/settings/JevConnectForm';

type Props = { onBusyChange: (busy: boolean) => void };
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not save the key. Please try again.';

export function OnboardingJev({ onBusyChange }: Props) {
  const qc = useQueryClient();
  const status = usePoll(['jev'], getJevStatus, 0);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (busy || !key.trim()) return;
    setBusy(true); onBusyChange(true); setError(null);
    try {
      const result = await connectJev(key.trim());
      if (!result.configured) throw new Error('Jev did not confirm a saved key. Try again, or skip for now.');
      qc.setQueryData(['jev'], result);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      setKey('');
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); onBusyChange(false); }
  };
  return <div className="clem-setup-extra">
    <p className="clem-setup-lead">Your model does the thinking. Jev helps Clem make focused checks along the way—like choosing relevant information and checking an action before it happens.</p>
    <p className="text-body text-muted">It’s an optional service from TypeSafe. Adding it gives Clem another tool for checking her work; you can connect it later in Settings.</p>
    {status.isLoading ? <p role="status">Checking Jev setup…</p>
      : status.error ? <p role="alert" className="text-warning">Could not read Jev’s status. <Button variant="link" onClick={() => void status.refetch()}>Try again</Button></p>
        : status.data?.configured ? <p role="status" className="clem-setup-saved"><Check size={18} aria-hidden />Key saved · checks {status.data.enabled ? 'enabled' : 'paused'}</p>
          : <>
              <a className="clem-setup-link" href={JEV_KEY_URL} target="_blank" rel="noopener noreferrer">Create a TypeSafe API key <ExternalLink size={15} aria-hidden /></a>
              <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
                <Field label="TypeSafe API key" hint="An API key connects your account. Keep it private.">{(id) => <Input id={id} type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} disabled={busy} />}</Field>
                <Button type="submit" disabled={busy || !key.trim()}>{busy ? 'Connecting Jev…' : 'Connect Jev'}</Button>
              </form>
            </>}
    {status.data?.warning && <p role="status" className="text-warning">{status.data.warning} The key is saved; availability is not confirmed.</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    <p className="text-small text-muted">The key is stored in Clem’s local credential vault. Checks send task details and relevant conversation snippets to TypeSafe. Its usage terms apply.</p>
  </div>;
}

export function OnboardingVoice({ onBusyChange }: Props) {
  const qc = useQueryClient();
  const credentials = usePoll(['credentials'], getCredentials, 0);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const connected = credentials.data?.auth?.openaiApiKeyPresent === true;
  const save = async () => {
    if (busy || !key.trim()) return;
    setBusy(true); onBusyChange(true); setError(null); setSaved(false);
    try {
      await setCredential('openai_api_key', key.trim());
      const fresh = await credentials.refetch();
      if (fresh.error || fresh.data?.auth?.openaiApiKeyPresent !== true) throw new Error('Could not confirm the saved voice key. Try again, or skip for now.');
      setKey(''); setSaved(true);
      await qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); onBusyChange(false); }
  };
  return <div className="clem-setup-extra">
    <p className="clem-setup-lead">Prefer a conversation out loud? An OpenAI API key adds live voice conversations.</p>
    <p className="text-body text-muted">You can skip this. Typing, local dictation, computer speech, and Clem’s memory don’t require this key. Microphone access is requested when you use voice.</p>
    {credentials.isLoading ? <p role="status">Checking voice setup…</p>
      : credentials.error ? <p role="alert" className="text-warning">Could not read voice setup. <Button variant="link" onClick={() => void credentials.refetch()}>Try again</Button></p>
        : connected ? <p role="status" className="clem-setup-saved"><Check size={18} aria-hidden />Voice key saved{saved ? ' just now' : ''} · no voice test run</p>
          : <>
              <a className="clem-setup-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Create an OpenAI API key <ExternalLink size={15} aria-hidden /></a>
              <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
                <Field label="OpenAI API key for live voice" hint="Optional. This does not choose or connect Clem’s main model.">{(id) => <Input id={id} type="password" autoComplete="off" spellCheck={false} disabled={busy} value={key} onChange={event => setKey(event.target.value)} />}</Field>
                <Button type="submit" disabled={busy || !key.trim()}>{busy ? 'Saving voice key…' : 'Save voice key'}</Button>
              </form>
            </>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    <p className="text-small text-muted">OpenAI bills API usage separately from a ChatGPT subscription. Live voice sends audio to OpenAI. Your key stays in Clem’s local credential vault.</p>
  </div>;
}
