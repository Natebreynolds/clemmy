import { useMobileNavigation } from '../lib/mobile-navigation';
import { haptic } from '../lib/native-bridge';

export function NavigationMenuButton({ brand = false }: { brand?: boolean }) {
  const navigation = useMobileNavigation();
  if (!navigation) return null;
  return (
    <button
      type="button"
      class={brand ? 'menu-mark navigation-menu-button' : 'navigation-menu-button'}
      aria-label="Open navigation"
      aria-haspopup="dialog"
      aria-expanded={navigation.navigationOpen}
      onClick={(event) => { haptic('light'); navigation.openNavigation(event.currentTarget); }}
    >
      {brand ? <img class="brand-mark" src="/m/clemmy.png" alt="" width="28" height="28" /> : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      )}
    </button>
  );
}
