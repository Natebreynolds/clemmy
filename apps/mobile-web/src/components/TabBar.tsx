import type { JSX } from 'preact';
import { haptic } from '../lib/native-bridge';

export interface TabBarPlace<Id extends string> {
  id: Id;
  label: string;
  /** Compact visual wording; the accessible destination keeps its full name. */
  shortLabel?: string;
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
}

/**
 * The five everyday destinations; More stays in the screen header. It floats above the page like the ask
 * capsule and leaves with the keyboard and inside a conversation.
 */
export function TabBar<Id extends string>({ places, current, currentInMenu, menuOpen, badge, onSelect, onReselect }: Props<Id>) {
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
            aria-label={count ? `${place.label}, ${count.label}` : place.label}
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
            <span class="tab-bar-label">{place.shortLabel ?? place.label}</span>
          </button>
        );
      })}

    </nav>
  );
}
