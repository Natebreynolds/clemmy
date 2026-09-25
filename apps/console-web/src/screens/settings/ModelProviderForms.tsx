import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Trash2 } from 'lucide-react';
import type { ModelProvider } from '@/lib/settings';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { addModelProvider, removeModelProvider, listProviderModels, type DiscoveredModel } from '@/lib/settings';
import { PROVIDER_PRESETS } from '@/lib/model-provider-presets';
import { keyUrlHost } from '@/lib/connect';
import { useModelRoles } from '@/lib/model-roles';

/**
 * The forms behind Settings › Models › Accounts for API-key models: add a
 * provider (GLM/Z.ai, DeepSeek, MiniMax, Together, any OpenAI-compatible
 * endpoint), choose its models from the live catalog, give a new model a job,
 * and later edit, re-key or remove it. Each provider routes its own model ids
 * to its own key. Codex/Claude/xAI sign-ins are OAuth and live in their own
 * forms.
 */

const parseIds = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function refreshModelQueries(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['settings'] });
  void qc.invalidateQueries({ queryKey: ['model-status'] });
}

/** The live-catalog checklist, shared by the add form and the editor. The
 *  typed list stays the source of truth (toggling a row rewrites it), so it
 *  remains the fallback when the catalog cannot be fetched. Searchable
 *  because providers like Together AI return hundreds of models. */
function useCatalogPicker(initial: string) {
  const [models, setModels] = useState(initial);
  const [catalog, setCatalog] = useState<DiscoveredModel[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(parseIds(initial)));
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const reset = () => { setCatalog(null); setPicked(new Set()); setError(null); setQuery(''); };

  // Pass a saved provider's `providerId` (key read from the vault) OR an
  // unsaved baseURL+apiKey. Selected ids the catalog omits stay checkable.
  const load = async (req: { baseURL?: string; apiKey?: string; providerId?: string }) => {
    const currentIds = parseIds(models);
    setPicked(new Set(currentIds));
    setFetching(true); setError(null);
    try {
      const { models: found } = await listProviderModels(req);
      const ids = new Set(found.map((m) => m.id));
      const extra = currentIds.filter((id) => !ids.has(id)).map((id) => ({ id } as DiscoveredModel));
      setCatalog([...extra, ...found]);
      if (found.length === 0 && extra.length === 0) setError('No models returned — enter ids manually.');
    } catch (err) {
      setCatalog(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally { setFetching(false); }
  };

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
    setModels(Array.from(next).join(', '));
  };

  const checklist = () => {
    if (!catalog || catalog.length === 0) {
      return (
        <>
          {fetching && <p className="mt-1 text-caption text-muted">Loading catalog…</p>}
          {error && <p className="mt-1 text-small text-warning">{error}</p>}
        </>
      );
    }
    const q = query.trim().toLowerCase();
    const filtered = q ? catalog.filter((m) => `${m.id} ${m.label ?? ''}`.toLowerCase().includes(q)) : catalog;
    return (
      <div className="mt-2">
        <div className="mb-1 flex items-center gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${catalog.length} models…`} aria-label="Search models" className="flex-1" />
          <span className="shrink-0 text-caption text-muted">{picked.size} selected</span>
        </div>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-caption text-muted">No models match “{query}”.</div>
          ) : filtered.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-small hover:bg-surface">
              <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
              <span className="truncate text-fg" title={m.id}>{m.label ?? m.id}</span>
            </label>
          ))}
        </div>
        {q && <div className="mt-1 text-caption text-muted">{filtered.length} of {catalog.length} shown</div>}
        {error && <p className="mt-1 text-small text-warning">{error}</p>}
      </div>
    );
  };

  return { models, setModels, fetching, load, reset, checklist };
}

/** Add an API-key provider, then offer the new model a job. */
export function AddModelForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const first = PROVIDER_PRESETS[0];
  const [presetId, setPresetId] = useState(first.id);
  const [label, setLabel] = useState(first.label);
  const [baseURL, setBaseURL] = useState(first.baseURL);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<{ label: string; modelIds: string[] } | null>(null);
  const picker = useCatalogPicker(first.workerModel);

  const applyPreset = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    setPresetId(id);
    if (p && p.id !== 'custom') { setLabel(p.label); setBaseURL(p.baseURL); picker.setModels(p.workerModel); }
    else { setLabel(''); setBaseURL(''); picker.setModels(''); }
    setError(null);
    picker.reset();
  };

  const onBrowse = () => {
    if (!baseURL.trim() || !apiKey.trim()) { setError('Add a base URL and API key first.'); return; }
    void picker.load({ baseURL: baseURL.trim(), apiKey: apiKey.trim() });
  };

  const onAdd = async () => {
    const modelIds = parseIds(picker.models);
    if (!baseURL.trim() || modelIds.length === 0 || !apiKey.trim()) {
      setError('Add a base URL, an API key, and at least one model id.');
      return;
    }
    setBusy(true); setError(null);
    try {
      // No `mode`: a connected model is eligible for any role. The route keeps
      // current routing and never reassigns the brain; the next step asks.
      await addModelProvider({ label: label.trim(), baseURL: baseURL.trim(), apiKey: apiKey.trim(), modelIds });
      setApiKey('');
      setConnected({ label: label.trim() || 'the new provider', modelIds });
      refreshModelQueries(qc);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  if (connected) return <UseItFor connected={connected} onDone={onClose} />;

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  return (
    <div className="rounded-lg border border-border bg-canvas p-4">
      <div className="mb-2 text-label text-fg">Add a model</div>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Provider" hint="Pre-fills the endpoint + a default model.">{(id) => (
          <Select id={id} value={presetId} onChange={(e) => applyPreset(e.target.value)}>
            {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        )}</Field>
        <Field label="Base URL">{(id) => (
          <Input id={id} value={baseURL} placeholder="https://api.z.ai/api/paas/v4" onChange={(e) => setBaseURL(e.target.value)} />
        )}</Field>
        <Field label="API key">{(id) => (
          <>
            <Input id={id} type="password" value={apiKey} placeholder="paste your API key" onChange={(e) => setApiKey(e.target.value)} />
            <p className="mt-1 text-caption text-muted">
              Stored locally on this machine.
              {preset?.keyUrl && <>{' '}<a href={preset.keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                Get a key at {keyUrlHost(preset.keyUrl)} <ExternalLink className="h-3 w-3" aria-hidden />
              </a></>}
            </p>
          </>
        )}</Field>
        <Field label="Models" hint={preset?.modelHint || 'Comma-separated model ids this provider serves.'}>{(id) => (
          <div className="flex gap-2">
            <Input id={id} className="min-w-0 flex-1" value={picker.models} placeholder="glm-5.2" onChange={(e) => picker.setModels(e.target.value)} />
            <Button className="shrink-0 self-center" variant="secondary" size="sm" onClick={onBrowse}
              disabled={picker.fetching || !baseURL.trim() || !apiKey.trim()}>
              {picker.fetching ? 'Loading…' : 'Browse models'}
            </Button>
          </div>
        )}</Field>
      </div>
      {picker.checklist()}
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={() => void onAdd()} disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</Button>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </div>
  );
}

const JOBS: Array<{ key: 'brain' | 'writer' | 'judge' | 'worker'; label: string }> = [
  { key: 'brain', label: 'Does the work' },
  { key: 'writer', label: 'Writes the final answer' },
  { key: 'judge', label: 'Checks the work' },
  { key: 'worker', label: 'Helps in parallel' },
];

/** Right after connecting: give the new model a job without leaving the page. */
function UseItFor({ connected, onDone }: { connected: { label: string; modelIds: string[] }; onDone: () => void }) {
  const r = useModelRoles();
  const [modelId, setModelId] = useState(connected.modelIds[0] ?? '');
  const [given, setGiven] = useState<string[]>([]);
  // A job counts as given only once the save lands (`saved` names it).
  useEffect(() => {
    const job = r.saved;
    if (job && JOBS.some((j) => j.key === job)) setGiven((g) => (g.includes(job) ? g : [...g, job]));
  }, [r.saved]);

  const give = (job: typeof JOBS[number]['key']) => {
    if (!modelId) return;
    if (job === 'brain') void r.onBrain(`api_key:${modelId}`);
    else void r.onRole(job, modelId);
  };

  return (
    <div className="rounded-lg border border-border bg-canvas p-4">
      <p className="inline-flex items-center gap-1 text-small text-success">
        <Check className="h-4 w-4" aria-hidden /> Connected {connected.label}.
      </p>
      <p className="mt-2 text-small text-fg">What should {connected.modelIds.length > 1 ? 'one of its models' : modelId} do?</p>
      {connected.modelIds.length > 1 && (
        <Select aria-label="Model" className="mt-2 max-w-xs" value={modelId} onChange={(e) => setModelId(e.target.value)}>
          {connected.modelIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </Select>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {JOBS.map((job) => (
          <Button key={job.key} size="sm" variant={given.includes(job.key) ? 'primary' : 'secondary'}
            disabled={Boolean(r.busy) || !modelId} onClick={() => give(job.key)}>
            {given.includes(job.key) && <Check className="h-4 w-4" aria-hidden />} {job.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={onDone}>{given.length ? 'Done' : 'Not now'}</Button>
      </div>
      {r.error && <p className="mt-2 text-small text-danger">{r.error}</p>}
      <p className="mt-2 text-caption text-muted">You can change any job later under Who does what.</p>
    </div>
  );
}

/** Edit a connected provider's models, replace its key, or remove it. The
 *  saved key is reused for the catalog, so the browser never resends it. */
export function ProviderManagePanel({ provider }: { provider: ModelProvider }) {
  const qc = useQueryClient();
  const picker = useCatalogPicker(provider.modelIds.join(', '));
  const [newKey, setNewKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const save = async (withKey: boolean) => {
    const modelIds = parseIds(picker.models);
    if (modelIds.length === 0) { setError('Pick at least one model, or remove the provider.'); return; }
    setBusy(true); setError(null); setSaved(null);
    try {
      // No apiKey → the route keeps the saved key. Same id → replaces this
      // provider's model list (the default provider updates its legacy slot).
      await addModelProvider({ id: provider.id, label: provider.label, baseURL: provider.baseURL, modelIds, ...(withKey ? { apiKey: newKey.trim() } : {}) });
      if (withKey) setNewKey('');
      setSaved(withKey ? 'Key replaced.' : 'Models saved.');
      refreshModelQueries(qc);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try { await removeModelProvider(provider.id); refreshModelQueries(qc); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <Field label="Models" hint="Check models from the catalog, or edit the list directly. The first model is this provider's primary.">{(id) => (
        <div className="flex gap-2">
          <Input id={id} className="min-w-0 flex-1" value={picker.models} placeholder="model-id, another-id" onChange={(e) => picker.setModels(e.target.value)} />
          <Button className="shrink-0 self-center" variant="secondary" size="sm"
            onClick={() => void picker.load({ providerId: provider.id })} disabled={picker.fetching}>
            {picker.fetching ? 'Loading…' : 'Browse models'}
          </Button>
        </div>
      )}</Field>
      {picker.checklist()}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save(false)} disabled={busy}>{busy ? 'Saving…' : 'Save models'}</Button>
      </div>
      <Field label="Replace the API key" hint={provider.configured ? 'The saved key stays until you replace it.' : 'No key is saved for this provider.'}>{(id) => (
        <div className="flex gap-2">
          <Input id={id} type="password" className="min-w-0 flex-1" value={newKey} placeholder="paste a new API key" autoComplete="off" onChange={(e) => setNewKey(e.target.value)} />
          <Button className="shrink-0" size="sm" variant="secondary" onClick={() => void save(true)} disabled={busy || !newKey.trim()}>Replace</Button>
        </div>
      )}</Field>
      <div className="flex items-center gap-3 border-t border-border pt-3">
        <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={busy} aria-label={`Remove ${provider.label || provider.id}`}>
          <Trash2 className="h-4 w-4" aria-hidden /> Remove {provider.label || provider.id}
        </Button>
        {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> {saved}</span>}
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </div>
  );
}
