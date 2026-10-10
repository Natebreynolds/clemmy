export type ChatRailLayout =
  | 'desktop'
  | 'mobile-closed'
  | 'mobile-overlay';

/** Desktop uses the shell's one navigator. Narrow history is temporary. */
export function chatRailLayout(
  narrow: boolean,
  mobileOpen: boolean,
): ChatRailLayout {
  if (narrow) return mobileOpen ? 'mobile-overlay' : 'mobile-closed';
  return 'desktop';
}
