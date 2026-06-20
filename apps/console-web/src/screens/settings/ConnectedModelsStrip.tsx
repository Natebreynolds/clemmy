import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Trash2, KeyRound, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getSettings, addModelProvider, removeModelProvider } from '@/lib/settings';
import { PROVIDER_PRESETS } from './ModelBackendForm';

type RunAs = 'worker' | 'all_in';

/**
 * The connected API-key models, as a flat strip — add GLM/Z.ai, DeepSeek,
 * MiniMax, or any OpenAI-compatible endpoint and it instantly shows here with a
 * status pill AND appears in the brain/worker/judge pickers above. This is the
 * "source of truth" surface: each provider routes its own model ids to its own
 * key. (Codex/Claude subscription sign-in lives separately — those are OAuth.)
 */
export function ConnectedModelsStrip() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const providers = settings.data?.modelProviders ?? [];

  const [adding, setAdding] = useState(false);
  const [presetId, setPresetId] = useState(PROVIDER_PRESETS[0].id);
  const [label, setLabel] = useState(PROVIDER_PRESETS[0].label);
  const [baseURL, setBaseURL] = useState(PROVIDER_PRESETS[0].baseURL);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(PROVIDER_PRESETS[0].workerModel);
  const [runAs, setRunAs] = useState<RunAs>('worker');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState(false);

  if (settings.isLoading) return <Skeleton className="h-28 w-full" />;

  const refresh = () => void qc.invalidateQueries({ queryKey: ['settings'] });

  const applyPreset = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    setPresetId(id);
    if (p && p.id !== 'custom') { setLabel(p.label); setBaseURL(p.baseURL); setModels(p.workerModel); }
    else { setLabel(''); setBaseURL(''); setModels(''); }
    setError(null);
  };

  const openAdd = () => { setAdding(true); setJustConnected(false); applyPreset(PROVIDER_PRESETS[0].id); setApiKey(''); };

  const onAdd = async () => {
    const modelIds = models.split(',').map((s) => s.trim()).filter(Boolean);
    if (!baseURL.trim() || modelIds.length === 0 || !apiKey.trim()) {
      setError('Add a base URL, an API key, and at least one model id.');
      return;
    }
    setBusy(true); setError(null);
    try {
      await addModelProvider({ label: label.trim(), baseURL: baseURL.trim(), apiKey: apiKey.trim(), modelIds, mode: runAs });
      setApiKey(''); setAdding(false); setJustConnected(true);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const onRemove = async (id: string) => {
    setBusy(true); setError(null); setJustConnected(false);
    try { await removeModelProvider(id); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const currentHint = PROVIDER_PRESETS.find((p) => p.id === presetId)?.modelHint ?? '';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-label text-fg">Connected models (API key)</span>
        {!adding && (
          <Button size="sm" variant="secondary" onClick={openAdd}>
            <Plus className="h-4 w-4" aria-hidden /> Add a model
          </Button>
        )}
      </div>

      {providers.length === 0 && !adding && (
        <p className="text-small text-muted">
          None yet. Add GLM (Z.ai), DeepSeek, MiniMax, or any OpenAI-compatible endpoint — it shows up in the pickers above instantly.
        </p>
      )}

      {providers.length > 0 && (
        <ul className="space-y-1.5">
          {providers.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-lg border border-border bg-canvas px-3 py-2">
              <KeyRound className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-small">
                  <span className="truncate text-fg">{p.label || p.id}</span>
                  {p.isDefault && <span className="shrink-0 rounded bg-surface px-1 text-caption text-muted">default</span>}
                </div>
                <div className="truncate text-caption text-muted" title={p.modelIds.join(', ')}>{p.modelIds.join(' · ') || 'no models'}</div>
              </div>
              <span className={'inline-flex shrink-0 items-center gap-1 text-caption ' + (p.configured ? 'text-success' : 'text-warning')}>
                {p.configured
                  ? <><Check className="h-3.5 w-3.5" aria-hidden /> key saved</>
                  : <><AlertTriangle className="h-3.5 w-3.5" aria-hidden /> no key</>}
              </span>
              <button type="button"
                className="shrink-0 rounded p-1 text-muted hover:text-danger disabled:opacity-50"
                disabled={busy} onClick={() => onRemove(p.id)} aria-label={`Remove ${p.label || p.id}`}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mt-3 rounded-lg border border-border bg-canvas p-3">
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Provider" hint="Pre-fills the endpoint + a default model.">{(id) => (
              <Select id={id} value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            )}</Field>
            <Field label="Base URL">{(id) => (
              <Input id={id} value={baseURL} placeholder="https://api.z.ai/api/paas/v4" onChange={(e) => setBaseURL(e.target.value)} />
            )}</Field>
            <Field label="API key" hint="Stored locally on this machine.">{(id) => (
              <Input id={id} type="password" value={apiKey} placeholder="paste your API key" onChange={(e) => setApiKey(e.target.value)} />
            )}</Field>
            <Field label="Models" hint={currentHint || 'Comma-separated model ids this provider serves.'}>{(id) => (
              <Input id={id} value={models} placeholder="glm-5.2" onChange={(e) => setModels(e.target.value)} />
            )}</Field>
          </div>
          <div className="mt-1 sm:max-w-[18rem]">
            <Field label="Run it as">{(id) => (
              <Select id={id} value={runAs} onChange={(e) => setRunAs(e.target.value as RunAs)}>
                <option value="worker">Workers (Codex stays the brain)</option>
                <option value="all_in">Everything (brain + judge too)</option>
              </Select>
            )}</Field>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button onClick={onAdd} disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</Button>
            <Button variant="secondary" size="sm" onClick={() => { setAdding(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3">
        {justConnected && (
          <span className="inline-flex items-center gap-1 text-small text-success">
            <Check className="h-4 w-4" aria-hidden /> Connected — now selectable in the pickers above
          </span>
        )}
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </div>
  );
}
