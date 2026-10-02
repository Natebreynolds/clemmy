import { useEffect, useRef, useState } from 'preact/hooks';
import {
  getModelSettings,
  setBrain,
  type ApiError,
  type ModelSettings,
} from '../lib/api';
import { ROLE_COPY } from '../lib/model-roles';
import { haptic } from '../lib/native-bridge';

/**
 * The brain switcher sheet — a ROUTING choice, never a credential ceremony.
 *
 * Every row comes from the daemon's live catalog (the same brainOptions the
 * desktop console renders), so the phone can never offer a model the Mac
 * does not have. Unavailable rows render disabled with the honest reason;
 * connecting a new brain is the Mac's job. Mirrors the console's no-restart
 * contract: a switch applies to your next message.
 */
export function BrainSheet({ open, onClose, onChanged, sessionId, answeringAgent, beforeChange }: {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful switch so hosts can refresh their own view. */
  onChanged?: () => void;
  /** The conversation this sheet was opened FROM (the chat header passes it;
   *  Settings has none). With it, the daemon re-pins that conversation so the
   *  switch really applies to its next message; without it the switch is
   *  global-only and steers new conversations. */
  sessionId?: string;
  /** An agent's own model answers the next message (owner, 10-02); a pick
   *  here in the conversation answers it instead. */
  answeringAgent?: { modelId: string; agentName: string } | null;
  /** Apply the chat's pending agent choice first, so the pick is the later one. */
  beforeChange?: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyValue, setBusyValue] = useState<string | null>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setSwitched(null);
    setSwitchError(null);
    let cancelled = false;
    setLoadError(null);
    getModelSettings()
      .then((data) => { if (!cancelled) setSettings(data); })
      .catch((err) => { if (!cancelled) setLoadError((err as Error).message ?? 'Could not load the model catalog'); });
    return () => { cancelled = true; };
  }, [open]);

  // Same dialog contract as the running-tasks sheet: Escape closes, focus
  // lands inside on open and is trapped while open.
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

  if (!open) return null;

  const pick = async (value: string, label: string) => {
    setBusyValue(value);
    setSwitchError(null);
    setSwitched(null);
    try {
      if (sessionId) await beforeChange?.().catch(() => undefined);
      await setBrain(value, sessionId);
      haptic('light');
      setSwitched(label);
      setSettings(await getModelSettings().catch(() => settings));
      onChanged?.();
    } catch (err) {
      const apiErr = err as ApiError;
      const body = apiErr.body as { message?: string } | null;
      setSwitchError(body?.message || apiErr.message || 'Could not switch brains');
    } finally {
      setBusyValue(null);
    }
  };

  // The agent's own model, when it answers, is the current one here.
  const agentOption = answeringAgent ? settings?.options.find((o) => o.value.endsWith(`:${answeringAgent.modelId}`)) : undefined;
  const currentValue = answeringAgent ? agentOption?.value ?? '' : settings?.effectiveValue;
  const current = settings?.options.find((o) => o.value === currentValue);
  const currentLabel = answeringAgent ? agentOption?.label ?? answeringAgent.modelId : current?.label ?? settings?.brain.modelId ?? '';

  return (
    <div class="brain-layer" role="dialog" aria-modal="true" aria-labelledby="brain-sheet-title">
      <button class="brain-scrim" type="button" aria-label="Close" onClick={onClose} />
      <section ref={sheetRef} class="brain-sheet">
        <header class="brain-sheet-head">
          <button ref={closeRef} type="button" class="brain-sheet-close" aria-label="Close" onClick={onClose}>×</button>
          <h2 id="brain-sheet-title">{ROLE_COPY.brain.title}</h2>
          <span aria-hidden="true" />
        </header>

        {loadError ? <p class="error">{loadError}</p> : null}
        {!settings && !loadError ? (
          <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
        ) : null}

        {settings ? (
          <>
            <div class="brain-current">
              <span class="brain-dot ok" aria-hidden="true" />
              <div class="min-w-0">
                <div class="brain-current-name truncate">{currentLabel}</div>
                <div class="brain-current-meta">{answeringAgent ? `${answeringAgent.agentName}’s own model` : sessionId ? 'Answers your next message' : 'Answers new conversations'}</div>
              </div>
            </div>
            {settings.brain.inactiveBinding && settings.brain.inactiveBinding.modelId !== settings.brain.modelId ? (
              <p class="warning brain-honesty">
                Saved {settings.brain.inactiveBinding.modelId} is unavailable — {settings.brain.modelId} answers instead.
              </p>
            ) : null}

            <div class="brain-roster" role="list">
              {settings.options.map((option) => {
                const isCurrent = option.value === currentValue;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="listitem"
                    class={`brain-row${isCurrent ? ' current' : ''}`}
                    disabled={!option.available || busyValue !== null || isCurrent}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => void pick(option.value, option.label)}
                  >
                    <span class={`brain-dot ${option.available ? 'ok' : 'off'}`} aria-hidden="true" />
                    <span class="brain-row-label truncate">{option.label}</span>
                    <span class="brain-row-note">
                      {busyValue === option.value ? 'Switching…'
                        : isCurrent ? 'Current'
                          : option.available ? '' : 'Connect on your Mac'}
                    </span>
                  </button>
                );
              })}
            </div>

            {switched ? (
              <p class="brain-note switched">
                Switched to {switched}. {sessionId ? 'Applies to your next message.'
                  : answeringAgent ? `Applies to new conversations; ${answeringAgent.agentName} answers this one on its own model.`
                  : 'Applies to new conversations.'}
              </p>
            ) : null}
            {switchError ? <p class="error brain-note">{switchError}</p> : null}
            {!switched && !switchError ? (
              <p class="brain-note muted">
                {answeringAgent
                  ? (sessionId
                    ? `${answeringAgent.agentName} answers on its own model. Pick another to use it in this conversation.`
                    : `${answeringAgent.agentName} answers on its own model. Once the conversation starts, you can pick another for it here.`)
                  : sessionId
                  ? 'Switching applies to your next message. No restart needed.'
                  : 'Switching applies to new conversations. A conversation already underway keeps its model unless you switch from inside it.'}
              </p>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
