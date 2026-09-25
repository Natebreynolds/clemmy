import { useEffect, useRef, useState } from 'preact/hooks';
import type { CompletionReviewSnapshot } from '@clem/chat-engine';
import {
  setModelRole,
  type ApiError,
  type ModelRoleName,
  type ModelSettings,
} from '../lib/api';
import { ROLE_COPY, inactiveNote, isChosen, modelName, sameFamilyWarning } from '../lib/model-roles';
import { haptic } from '../lib/native-bridge';

/**
 * Picks the model for one part of a request: who writes the final answer, who
 * checks the work, who helps in parallel. A routing choice among models already
 * connected on the Mac, never a credential ceremony. Every row comes from the
 * daemon catalog, and a pick is saved through the same owner desktop Settings
 * uses, so the two can never disagree.
 */
export function RoleSheet({ role, settings, review, reviewBusy, reviewError, onToggleReview, onClose, onChanged }: {
  /** The role being picked; null when closed. */
  role: ModelRoleName | null;
  settings: ModelSettings | null;
  /** Checks the work only: whether finished work is reviewed at all. */
  review?: CompletionReviewSnapshot | null;
  reviewBusy?: boolean;
  reviewError?: string | null;
  onToggleReview?: (enabled: boolean) => void;
  onClose: () => void;
  /** The daemon's answer to a saved pick, in the shape Settings loaded. */
  onChanged: (next: ModelSettings) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const open = role !== null;

  useEffect(() => {
    setSaved(false);
    setError(null);
  }, [role]);

  // Same dialog contract as the brain sheet: Escape closes, focus lands inside
  // on open and is trapped while open.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab' || !sheetRef.current) return;
      const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!role || !settings) return null;

  const copy = ROLE_COPY[role];
  const resolved = settings.roles?.[role];
  const chosen = isChosen(resolved);
  const groups = settings.roleOptions?.[role] ?? [];
  const inactive = inactiveNote(resolved, settings);
  const warning = role === 'worker' ? null : sameFamilyWarning(settings);

  const pick = async (key: string, modelId: string | null) => {
    setBusyKey(key);
    setSaved(false);
    setError(null);
    try {
      const next = await setModelRole(role, modelId);
      haptic('light');
      setSaved(true);
      onChanged(next);
    } catch (err) {
      const apiErr = err as ApiError;
      const body = apiErr.body as { message?: string } | null;
      setError(body?.message || apiErr.message || 'Could not save that choice');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div class="brain-layer" role="dialog" aria-modal="true" aria-labelledby="role-sheet-title">
      <button class="brain-scrim" type="button" aria-label="Close" onClick={onClose} />
      <section ref={sheetRef} class="brain-sheet">
        <header class="brain-sheet-head">
          <button ref={closeRef} type="button" class="brain-sheet-close" aria-label="Close" onClick={onClose}>×</button>
          <h2 id="role-sheet-title">{copy.title}</h2>
          <span aria-hidden="true" />
        </header>
        <p class="role-explain">{copy.explain}</p>

        {role === 'judge' && review ? (
          <button
            type="button"
            class="settings-row settings-toggle-row role-review"
            role="switch"
            aria-checked={review.enabled}
            disabled={reviewBusy}
            onClick={() => onToggleReview?.(!review.enabled)}
          >
            <span class="settings-row-main">
              <span class="settings-row-label">Review finished work{reviewBusy ? ' · Saving…' : ''}</span>
              <span class="settings-row-note">
                {review.enabled
                  ? 'On. Applies to new requests.'
                  : 'Off. Permissions and checks on saved results still apply.'}
              </span>
            </span>
            <span class={`settings-switch${review.enabled ? ' on' : ''}`} aria-hidden="true"><i /></span>
          </button>
        ) : null}
        {role === 'judge' && reviewError ? <p class="error brain-note">{reviewError}</p> : null}
        {inactive ? <p class="warning brain-honesty">{inactive}</p> : null}
        {warning ? <p class="warning brain-honesty">{warning}</p> : null}

        <div class="brain-roster" role="list">
          <button
            type="button"
            role="listitem"
            class={`brain-row${chosen ? '' : ' current'}`}
            disabled={busyKey !== null || !chosen}
            aria-current={chosen ? undefined : 'true'}
            onClick={() => void pick('automatic', null)}
          >
            <span class="brain-dot ok" aria-hidden="true" />
            <span class="role-row-main">
              <span class="brain-row-label">Automatic</span>
              <span class="role-row-note">{copy.automatic}</span>
            </span>
            <span class="brain-row-note">{busyKey === 'automatic' ? 'Saving…' : chosen ? '' : 'Current'}</span>
          </button>
          {groups.map((group) => (
            <div key={`${group.provider}:${group.providerId ?? ''}`} class="role-group" role="presentation">
              <div class="role-group-label">{group.label}</div>
              {group.models.map((model) => {
                const key = `${group.provider}:${group.providerId ?? ''}:${model.id}`;
                const current = chosen && resolved?.modelId === model.id;
                return (
                  <button
                    key={key}
                    type="button"
                    role="listitem"
                    class={`brain-row${current ? ' current' : ''}`}
                    disabled={busyKey !== null || current}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => void pick(key, model.id)}
                  >
                    <span class="brain-dot ok" aria-hidden="true" />
                    <span class="brain-row-label truncate">{modelName(model.label, group.label)}</span>
                    <span class="brain-row-note">{busyKey === key ? 'Saving…' : current ? 'Current' : ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {groups.length === 0 ? (
          <p class="brain-note muted">No connected model can do this yet. Connect one on your Mac.</p>
        ) : null}
        {saved ? <p class="brain-note switched">Saved. Applies to your next message.</p> : null}
        {error ? <p class="error brain-note">{error}</p> : null}
      </section>
    </div>
  );
}
