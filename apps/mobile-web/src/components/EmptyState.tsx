import { haptic } from '../lib/native-bridge';

interface Props {
  title: string;
  guide?: string;
  body: string;
  /** The one next step, so an empty screen is never a dead end. */
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ title, body, action, guide }: Props) {
  return (
    <div class="empty">
      <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
      <p class="empty-title">{title}</p>
      <p class="empty-body">{body}</p>
      {action ? (
        <button type="button" class="empty-action" data-clem-guide={guide} onClick={() => { haptic('light'); action.onClick(); }}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
