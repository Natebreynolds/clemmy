export type ChatRailLayout =
  | 'desktop-open'
  | 'desktop-collapsed'
  | 'mobile-closed'
  | 'mobile-overlay';

/** Narrow windows never spend horizontal layout width on the history rail.
 * History is closed by default and, when requested, overlays the conversation. */
export function chatRailLayout(
  narrow: boolean,
  desktopCollapsed: boolean,
  mobileOpen: boolean,
): ChatRailLayout {
  if (narrow) return mobileOpen ? 'mobile-overlay' : 'mobile-closed';
  return desktopCollapsed ? 'desktop-collapsed' : 'desktop-open';
}
