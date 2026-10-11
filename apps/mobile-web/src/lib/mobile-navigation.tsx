import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'preact/hooks';

interface MobileNavigation {
  openNavigation: (opener?: HTMLElement) => void;
  navigationOpen: boolean;
  ownDetailHeader: () => () => void;
}

const NavigationContext = createContext<MobileNavigation | null>(null);

/** One drawer belongs to the shell; inner screens supply only its trigger. */
export function MobileNavigationProvider({ openNavigation, navigationOpen, onDetailHeaderChange, children }: {
  openNavigation: MobileNavigation['openNavigation'];
  navigationOpen: boolean;
  onDetailHeaderChange: (owned: boolean) => void;
  children: ComponentChildren;
}) {
  const owners = useRef(new Set<symbol>());
  const changed = useRef(onDetailHeaderChange);
  changed.current = onDetailHeaderChange;
  const ownDetailHeader = useCallback(() => {
    const owner = Symbol('detail header');
    owners.current.add(owner);
    changed.current(true);
    return () => {
      owners.current.delete(owner);
      changed.current(owners.current.size > 0);
    };
  }, []);
  const value = useMemo(() => ({ openNavigation, navigationOpen, ownDetailHeader }), [openNavigation, navigationOpen, ownDetailHeader]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useMobileNavigation(): MobileNavigation | null {
  return useContext(NavigationContext);
}

/** Hide the outer header only while a mounted screen owns a replacement. */
export function useMobileDetailHeader(active = true): void {
  const own = useMobileNavigation()?.ownDetailHeader;
  useLayoutEffect(() => active ? own?.() : undefined, [active, own]);
}
