/**
 * The title is the navigator. Tapping the screen title opens this sheet:
 * the destinations the user chose for their switcher (HomePreferences.
 * phoneSwitcher), each with the count the app already keeps, plus "More"
 * for everything else, which opens the full section menu.
 */
import type { JSX } from 'preact';
import { Sheet } from './Sheet';
import { haptic } from '../lib/native-bridge';
import { SWITCHER_MORE } from '../lib/home-prefs';

export interface SwitcherEntry {
  id: string;
  label: string;
  icon: JSX.Element;
  badge?: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  current: string;
  entries: SwitcherEntry[];
  onSelect: (id: string) => void;
  onMore: () => void;
}

export function TitleSwitcher({ open, onClose, current, entries, onSelect, onMore }: Props) {
  return (
    <Sheet open={open} onClose={onClose} ariaLabel="Go to" class="sheet-compact">
      <nav class="switcher-list" aria-label="Go to">
        {entries.map((entry) => {
          const isCurrent = entry.id === current;
          const badge = entry.badge && entry.badge > 0 ? (entry.badge > 99 ? '99+' : String(entry.badge)) : null;
          return (
            <button
              key={entry.id}
              type="button"
              class="switcher-row"
              aria-current={isCurrent ? 'page' : undefined}
              onClick={() => {
                if (!isCurrent) haptic('light');
                onSelect(entry.id);
              }}
            >
              <span class="switcher-icon" aria-hidden="true">{entry.icon}</span>
              <span class="switcher-label">{entry.label}</span>
              {badge ? <span class="switcher-badge">{badge}</span> : null}
              {isCurrent ? (
                <svg class="switcher-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : null}
            </button>
          );
        })}
        <button
          key={SWITCHER_MORE}
          type="button"
          class="switcher-row switcher-more"
          onClick={() => { haptic('light'); onMore(); }}
        >
          <span class="switcher-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
            </svg>
          </span>
          <span class="switcher-label">More</span>
          <svg class="switcher-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </nav>
    </Sheet>
  );
}
