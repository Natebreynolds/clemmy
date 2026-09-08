import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { CompletionReviewSnapshot } from '@clem/chat-engine';
import { getCompletionReview, setCompletionReview } from '../lib/api';

export function CompletionReviewCard() {
  const [snapshot, setSnapshot] = useState<CompletionReviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const savingRef = useRef(false);
  const reload = useCallback(async () => {
    if (savingRef.current) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await getCompletionReview();
      if (mounted.current && request === generation.current) { setSnapshot(result); setError(null); }
    } catch (err) {
      if (mounted.current && request === generation.current) setError(err instanceof Error ? err.message : 'Could not refresh completion review.');
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const wake = () => { void reload(); };
    const visible = () => { if (document.visibilityState === 'visible') void reload(); };
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false; generation.current += 1;
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [reload]);
  const change = async (enabled: boolean) => {
    if (savingRef.current || !snapshot || error || loading) return;
    savingRef.current = true;
    const request = ++generation.current;
    setSaving(true);
    try {
      const result = await setCompletionReview(enabled);
      if (mounted.current && request === generation.current) { setSnapshot(result); setError(null); }
    } catch (err) {
      if (mounted.current && request === generation.current) setError(err instanceof Error ? err.message : 'The change was not confirmed. Reload before trying again.');
    } finally {
      savingRef.current = false;
      if (mounted.current && request === generation.current) setSaving(false);
    }
  };
  return <section class="card settings-card" aria-label="Completion review">
    <h2 class="settings-card-title">Completion review</h2>
    {snapshot ? <button type="button" class="settings-row settings-toggle-row"
      role="switch" aria-label="Completion review" aria-checked={snapshot.enabled}
      disabled={saving || loading || Boolean(error)} onClick={() => void change(!snapshot.enabled)}>
      <span class="settings-row-main">
        <span class="settings-row-label">{snapshot.enabled ? 'On' : 'Off'}{saving ? ' · Saving…' : ''}</span>
        <span class="settings-row-note">Judge: {snapshot.judge} · {snapshot.judgeSource}</span>
      </span>
      <span class={`settings-switch${snapshot.enabled ? ' on' : ''}`} aria-hidden="true"><i /></span>
    </button> : <p role="status">{loading ? 'Loading completion review…' : 'Completion review unavailable'}</p>}
    <p class="settings-row-note">An optional model checks Clem’s completed work. Changes to this switch apply to new tasks. Permissions and checks on saved results still apply.</p>
    {snapshot && !snapshot.enabled && <p class="settings-row-note">The selected judge is not used for completion review while off.</p>}
    {error && <p role="alert">{error} {snapshot ? 'Showing the last confirmed setting. ' : ''}<button type="button" disabled={saving || loading} onClick={() => void reload()}>Reload</button></p>}
  </section>;
}
