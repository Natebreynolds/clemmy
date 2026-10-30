import { useMobileNavigation } from '../lib/mobile-navigation';

interface Props {
  onClick: () => void;
  showChats?: boolean;
  opensChats?: boolean;
}

/** Same 44px circle as before — drawn, not a unicode arrow. */
export function ChatBackButton({ onClick, showChats = true, opensChats = false }: Props) {
  const navigation = useMobileNavigation();
  return (
    <><button class="chat-back" type="button" onClick={opensChats ? navigation?.openChats ?? onClick : onClick} aria-label={opensChats ? 'Open chats' : 'Back'}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
      {opensChats ? <span class="chat-back-label">Chats</span> : null}
    </button>
    {showChats && navigation ? <button class="chat-list-shortcut" type="button" onClick={navigation.openChats} aria-label="Open chats">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /><path d="M6 7h10M6 11h7" /></svg>
      <span>Chats</span>
    </button> : null}</>
  );
}
