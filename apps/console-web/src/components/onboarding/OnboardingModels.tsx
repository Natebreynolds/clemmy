import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { usePoll } from '@/lib/poll';
import { getSettings, patchBrainBackups, setActiveBrain } from '@/lib/settings';
import { onboardingBackupChoices, onboardingBackupSelection, onboardingBrainChoices,
  onboardingPrimarySelection, selectedOnboardingBrain } from '@/lib/onboarding-models';
import { CodexLoginForm } from '@/screens/settings/CodexLoginForm';
import { ClaudeLoginForm } from '@/screens/settings/ClaudeLoginForm';
import { XaiLoginForm } from '@/screens/settings/XaiLoginForm';
import { AddModelForm } from '@/screens/settings/ModelProviderForms';

type Connection = '' | 'codex' | 'claude' | 'xai' | 'api-key';

export interface OnboardingModelsProps {
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  discardRequest?: number;
}

export function OnboardingModels({ onBusyChange, onDirtyChange, discardRequest = 0 }: OnboardingModelsProps) {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 5_000);
  const snapshot = settings.data;
  const choices = onboardingBrainChoices(snapshot);
  const saved = selectedOnboardingBrain(snapshot);
  const backupChoices = onboardingBackupChoices(snapshot);
  const retainedBackups = snapshot?.modelRoles?.brainBackups;
  const [connection, setConnection] = useState<Connection>('');
  const [primaryDraft, setPrimaryDraft] = useState<string | null>(null);
  const [backupDraft, setBackupDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<'primary' | 'backups' | null>(null);
  const [connectionBusy, setConnectionBusy] = useState({ codex: false, claude: false, xai: false, api: false });
  const [providerDirty, setProviderDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const primaryValue = primaryDraft ?? saved?.value ?? '';
  const backups = backupDraft ?? retainedBackups?.modelIds ?? [];
  const choicesUnavailable = settings.isLoading || Boolean(settings.error) || !snapshot?.modelRoles;
  const pendingConnection = Object.values(connectionBusy).some(Boolean);
  const blocked = busy !== null || pendingConnection;
  const dirty = providerDirty || primaryDraft !== null && primaryDraft !== (saved?.value ?? '')
    || backupDraft !== null && JSON.stringify(backupDraft) !== JSON.stringify(retainedBackups?.modelIds ?? []);
  const discardSeen = useRef(discardRequest);
  const connectionCallbacks = useMemo(() => {
    const report = (kind: keyof typeof connectionBusy) => (pending: boolean) =>
      setConnectionBusy(current => current[kind] === pending ? current : { ...current, [kind]: pending });
    return { codex: report('codex'), claude: report('claude'), xai: report('xai'), api: report('api') };
  }, []);
  const reportProviderDirty = useCallback((value: boolean) => setProviderDirty(value), []);

  useEffect(() => { onBusyChange?.(blocked); }, [blocked, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (blocked || discardSeen.current === discardRequest) return;
    discardSeen.current = discardRequest;
    setPrimaryDraft(null); setBackupDraft(null);
  }, [discardRequest, blocked]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['settings'] });
    await qc.invalidateQueries({ queryKey: ['model-status'] });
  };
  const savePrimary = async () => {
    const selection = onboardingPrimarySelection(snapshot, primaryValue);
    if (!selection || choicesUnavailable || blocked || saving.current) return;
    saving.current = true; setBusy('primary'); setError(null); setMessage(null);
    try {
      await setActiveBrain(selection.brain, selection.modelId);
      await refresh();
      setPrimaryDraft(null);
      setMessage('Main model saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The model could not be selected. Reload the model list and try again.');
      // The requested value stays a draft. Only the next server snapshot can
      // name the saved route, including when a provider rejects selection.
      await refresh();
    } finally { saving.current = false; setBusy(null); }
  };
  const saveBackups = async () => {
    const selection = onboardingBackupSelection(snapshot, backups);
    if (!selection || choicesUnavailable || blocked || saving.current) return;
    saving.current = true; setBusy('backups'); setError(null); setMessage(null);
    try {
      await patchBrainBackups(selection);
      await refresh();
      setBackupDraft(null);
      setMessage(selection.length ? 'Backup order saved.' : 'No backups selected.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The backup order was not saved. Try again.');
    } finally { saving.current = false; setBusy(null); }
  };

  return <div className="space-y-8">
    <section aria-labelledby="onboarding-connect-model">
      <h2 id="onboarding-connect-model" className="text-h3 text-fg">Connect a model</h2>
      <p className="mt-2 max-w-prose text-body text-muted">Start with one account you already use. Different models bring different strengths; a second connection also gives Clem a backup. You can add it later.</p>
      <div className="mt-5">
        <Field label="How would you like to connect?">{(id) => <Select id={id} value={connection} disabled={blocked}
          onChange={(event) => setConnection(event.target.value as Connection)}>
          <option value="">Choose a sign-in or API key</option>
          <option value="codex">ChatGPT / Codex subscription</option>
          <option value="claude">Claude subscription</option>
          <option value="xai">Grok / xAI sign-in</option>
          <option value="api-key">An API-key model</option>
        </Select>}</Field>
        {/* Keep the forms mounted: switching methods or wizard steps must not
            discard a code, key draft, or in-flight sign-in. */}
        <fieldset disabled={busy !== null} className="min-w-0">
          <div hidden={connection !== 'codex'}><CodexLoginForm embedded onboarding onBusyChange={connectionCallbacks.codex} /></div>
          <div hidden={connection !== 'claude'}><ClaudeLoginForm embedded onboarding onBusyChange={connectionCallbacks.claude} /></div>
          <div hidden={connection !== 'xai'}><XaiLoginForm embedded onboarding onBusyChange={connectionCallbacks.xai} /></div>
          <div hidden={connection !== 'api-key'}><AddModelForm presentation="onboarding" onClose={() => setConnection('')}
            onBusyChange={connectionCallbacks.api} onDirtyChange={reportProviderDirty} discardRequest={discardRequest} /></div>
        </fieldset>
      </div>
    </section>

    <section aria-labelledby="onboarding-main-model" className="border-t border-border pt-6">
      <h2 id="onboarding-main-model" className="text-h3 text-fg">Choose your main model</h2>
      <p className="mt-2 max-w-prose text-small text-muted">This model reads your requests and does the work. Check the saved choice below, or choose another connected model.</p>
      {settings.isLoading ? <p className="mt-4 text-small text-muted" role="status">Loading your models…</p>
        : settings.error || !snapshot?.modelRoles ? <div className="mt-4 text-small text-danger" role="alert">
            Could not load your current model choices. <Button variant="link" size="sm" onClick={() => void settings.refetch()}>Try again</Button>
          </div>
          : <>
              <p className="mt-4 text-small text-fg">{saved ? <>Saved main model: <strong>{saved.label}</strong>.</> : 'Choose a connected model to get started.'}</p>
              {choices.some((choice) => choice.available) ? <div className="mt-4 flex flex-col items-start gap-2 sm:flex-row sm:items-end">
                <div className="w-full min-w-0 flex-1"><Field label="Main model">{(id) => <Select id={id} value={primaryValue}
                  disabled={blocked} onChange={(event) => { setPrimaryDraft(event.target.value); setMessage(null); setError(null); }}>
                  <option value="">Choose a connected model</option>
                  {primaryValue && !choices.some((choice) => choice.value === primaryValue)
                    && <option value={primaryValue} disabled>Previous choice is no longer available</option>}
                  {choices.map((choice, index) => <option key={`${choice.value}:${index}`} value={choice.value} disabled={!choice.available}>
                    {choice.label}{!choice.available ? ' (not connected)' : ''}
                  </option>)}
                </Select>}</Field></div>
                <Button className="mb-4" disabled={blocked || !onboardingPrimarySelection(snapshot, primaryValue) || primaryValue === saved?.value}
                  onClick={() => void savePrimary()}>{busy === 'primary' ? 'Saving…' : 'Use this model'}</Button>
              </div> : <p className="mt-3 text-small text-muted">Once you connect an account above, its available models appear here. If they haven’t appeared yet, reload the list.</p>}
              {primaryDraft !== null && primaryDraft !== saved?.value && <p className="text-caption text-muted">Your selection is not saved until you choose “Use this model”.</p>}
              {snapshot.modelRoles.discovery?.refreshing && <p className="mt-2 text-caption text-muted" role="status">Refreshing the available models…</p>}
              <Button variant="link" size="sm" disabled={blocked || settings.isFetching} onClick={() => void settings.refetch()}>Reload model list</Button>
            </>}
    </section>

    {retainedBackups && <details className="border-t border-border pt-6">
      <summary className="min-h-11 cursor-pointer py-2.5 text-label text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        onClick={(event) => { if (busy === 'backups') event.preventDefault(); }}>
        Backup models <span className="font-normal text-muted">· optional{retainedBackups.modelIds.length ? ` · ${retainedBackups.modelIds.length} saved` : ''}</span>
        {busy === 'backups' && <span role="status" className="ml-2 font-normal text-muted">Saving…</span>}
      </summary>
      <div className="mt-4">
      <p className="mt-2 max-w-prose text-small text-muted">If your main model stops answering, Clem can try these models in order. Connect another account above, then choose it here. You decide which accounts may be used.</p>
      <div className="mt-4 space-y-3">
        {Array.from({ length: Math.min(3, backups.length + 1) }, (_, slot) => <Field key={slot} label={`Backup ${slot + 1}`}>{(id) => <Select id={id}
          value={backups[slot] ?? ''} disabled={blocked || choicesUnavailable || !saved} onChange={(event) => {
            const value = event.target.value;
            setBackupDraft(value ? [...backups.slice(0, slot), value, ...backups.slice(slot + 1)] : backups.slice(0, slot));
            setMessage(null); setError(null);
          }}>
          <option value="">{slot === 0 ? 'No backup' : 'No more backups'}</option>
          {backups[slot] && !backupChoices.some((choice) => choice.modelId === backups[slot])
            && <option value={backups[slot]} disabled>{backups[slot]} (not available as a backup)</option>}
          {backupChoices.map((choice) => <option key={choice.value} value={choice.modelId}
            disabled={backups.includes(choice.modelId) && backups[slot] !== choice.modelId}>{choice.label}</option>)}
        </Select>}</Field>)}
      </div>
      {!saved && <p className="text-caption text-muted">Save your main model before choosing backups.</p>}
      {backupDraft !== null && <>
        <p className="mb-3 text-caption text-muted">Save this order before continuing. Removing a backup here does not disconnect its account.</p>
        <Button disabled={blocked || choicesUnavailable || !onboardingBackupSelection(snapshot, backups)} onClick={() => void saveBackups()}>
          {busy === 'backups' ? 'Saving…' : 'Save backups'}
        </Button>
      </>}
      </div>
    </details>}
    {message && <p role="status" className="text-small text-success">{message}</p>}
    {error && <p role="alert" className="text-small text-danger">{error}</p>}
  </div>;
}
