import type { JSX } from 'preact';
import { haptic } from '../lib/native-bridge';

export interface TabBarPlace<Id extends string> {
  id: Id;
  label: string;
  icon: JSX.Element;
}

interface Props<Id extends string> {
  places: ReadonlyArray<TabBarPlace<Id>>;
  current: Id;
  /** The open screen lives behind More (the menu), so More reads as current. */
  currentInMenu: boolean;
  menuOpen: boolean;
  badge: { place: Id; text: string; label: string; stale: boolean } | null;
  onSelect: (id: Id) => void;
  onReselect: (id: Id) => void;
  onMenu: (opener: HTMLElement) => void;
}

/**
 * The phone's places (owner 10-23): the four used most, and More for the
 * menu that holds everything else. It floats above the page like the ask
 * capsule and leaves with the keyboard and inside a conversation.
 */
export function TabBar<Id extends string>({ places, current, currentInMenu, menuOpen, badge, onSelect, onReselect, onMenu }: Props<Id>) {
  return (
    <nav class="tab-bar" aria-label="Places" inert={menuOpen ? true : undefined}>
      {places.map((place) => {
        const here = place.id === current && !currentInMenu;
        const count = badge?.place === place.id ? badge : null;
        return (
          <button
            key={place.id}
            type="button"
            class="tab-bar-item"
            aria-current={here ? 'page' : undefined}
            aria-label={count ? `${place.label}, ${count.label}` : undefined}
            onClick={() => {
              haptic('light');
              if (here) onReselect(place.id);
              else onSelect(place.id);
            }}
          >
            <span class="tab-bar-icon">
              {place.icon}
              {count ? <span class={`tab-bar-badge${count.stale ? ' badge-stale' : ''}`} aria-hidden="true">{count.text}</span> : null}
            </span>
            <span class="tab-bar-label">{place.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        class={`tab-bar-item${currentInMenu ? ' tab-bar-item-holds' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={(event) => { haptic('light'); onMenu(event.currentTarget); }}
      >
        <span class="tab-bar-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <span class="tab-bar-label">More</span>
      </button>
    </nav>
  );
}
