import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/Switch';
import { getCompletionReview, setCompletionReview } from '@/lib/completion-review';
import { usePoll } from '@/lib/poll';

const QUERY_KEY = ['completion-review'] as const;

export function CompletionReviewControl() {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const setting = usePoll(QUERY_KEY, getCompletionReview, 5_000, { enabled: !saving });
  const snapshot = setting.data;
  const error = saveError || (setting.error ? 'Could not refresh completion review.' : null);
  const reload = async () => {
    const result = await setting.refetch();
    if (!result.error) setSaveError(null);
  };
  const change = async (enabled: boolean) => {
    if (savingRef.current || !snapshot || error) return;
    savingRef.current = true;
    setSaving(true); setSaveError(null);
    try {
      // An older GET must not replace the PATCH's confirmed response.
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      qc.setQueryData(QUERY_KEY, await setCompletionReview(enabled));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'The change was not confirmed. Reload before trying again.');
    } finally { savingRef.current = false; setSaving(false); }
  };
  return <section aria-label="Completion review" className="rounded-lg border border-border bg-canvas p-3">
    <div className="flex flex-wrap items-center gap-2 text-label text-fg">
      {snapshot
        ? <Switch checked={snapshot.enabled} disabled={saving || Boolean(error)} onChange={(enabled) => void change(enabled)} label="Completion review" />
        : <span role="status">{setting.isLoading ? 'Loading completion review…' : 'Completion review unavailable'}</span>}
      {snapshot && <span>Completion review · {snapshot.enabled ? 'On' : 'Off'}{saving ? ' · Saving…' : ''}</span>}
    </div>
    <p className="mt-1.5 text-caption text-muted">An optional model checks Clem’s completed work. Changes to this switch apply to new tasks. Permissions and checks on saved results still apply.</p>
    {snapshot && <p className="mt-1 text-caption text-muted">Judge: <span className="text-fg">{snapshot.judge}</span> · {snapshot.judgeSource}{!snapshot.enabled ? ' · not used for completion review while off' : ''}</p>}
    {error && <p role="alert" className="mt-2 text-small text-danger">{error} {snapshot ? 'Showing the last confirmed setting. ' : ''}<button type="button" disabled={saving} className="underline" onClick={() => void reload()}>Reload</button></p>}
  </section>;
}
