import { useRef, useState } from 'preact/hooks';
import { presentInboxAttention, type AttentionItem, type AttentionPresentationReceipt } from '../lib/api';

/** These controls change attention only; the owning work keeps its authority. */
export function AttentionActions({ item, onPresented, onChanged }: {
  item: Pick<AttentionItem, 'key' | 'lifecycle'> | null | undefined;
  onPresented: (receipt: AttentionPresentationReceipt) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'dismiss' | 'defer' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const current = useRef(item);
  current.current = item;
  if (!item?.lifecycle.generation || item.lifecycle.effect !== 'hide_only') return null;
  const present = async (action: 'dismiss' | 'defer') => {
    if (lock.current) return;
    lock.current = true; setBusy(action); setError(null);
    try {
      const receipt = await presentInboxAttention(item.key, action, item.lifecycle.generation);
      if (current.current?.key === item.key && current.current.lifecycle.generation === item.lifecycle.generation) onPresented(receipt);
      else { setError('That version was set aside. The item has since changed; review the current version.'); onChanged(); }
    } catch (cause) {
      setError((cause as { status?: number }).status === 409 ? 'This item changed. Check the refreshed version before trying again.'
        : cause instanceof Error ? cause.message : 'Could not confirm the change. Your item stays here.');
      onChanged();
    } finally { lock.current = false; setBusy(null); }
  };
  return <div class="question-presentation">
    <p class="card-note">Later brings this back tomorrow. Dismiss keeps it in Set aside.</p>
    <div class="inbox-card-actions">
      {item.lifecycle.canDefer ? <button type="button" class="btn-reply" disabled={busy !== null} onClick={() => void present('defer')}>{busy === 'defer' ? 'Saving…' : 'Later'}</button> : null}
      {item.lifecycle.canDismiss ? <button type="button" class="btn-reply" disabled={busy !== null} onClick={() => void present('dismiss')}>{busy === 'dismiss' ? 'Saving…' : 'Dismiss'}</button> : null}
    </div>
    {error ? <p class="inbox-inline-error" role="alert">{error}</p> : null}
  </div>;
}
