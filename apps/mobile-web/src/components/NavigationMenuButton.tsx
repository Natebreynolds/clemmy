import { useMobileNavigation } from '../lib/mobile-navigation';
import { haptic } from '../lib/native-bridge';

/** The Clemmy mark in the screen header: a second handle for the menu behind More. */
export function NavigationMenuButton() {
  const navigation = useMobileNavigation();
  if (!navigation) return null;
  return (
    <button
      type="button"
      class="menu-mark navigation-menu-button"
      aria-label="More places and settings"
      aria-haspopup="dialog"
      aria-expanded={navigation.navigationOpen}
      onClick={(event) => { haptic('light'); navigation.openNavigation(event.currentTarget); }}
    >
      <img class="brand-mark" src="/m/clemmy.png" alt="" width="28" height="28" />
      <span class="navigation-menu-label">More</span>
    </button>
  );
}
