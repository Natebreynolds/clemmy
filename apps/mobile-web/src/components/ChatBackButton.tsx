interface Props {
  onClick: () => void;
}

/** Same 44px circle as before — drawn, not a unicode arrow. */
export function ChatBackButton({ onClick }: Props) {
  return (
    <button class="chat-back" type="button" onClick={onClick} aria-label="Back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
    </button>
  );
}
