/** Whether the sidebar shows as the collapsed rail: a per-window convenience
 * in localStorage, best-effort (private window, cleared site data). */
const COLLAPSED_PREF_KEY = 'clem.sidebar.collapsed';

export function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_PREF_KEY) === 'collapsed'; } catch { return false; }
}

/** A narrow window always shows the collapsed rail; otherwise the owner's
 *  last explicit choice wins (open when they never chose). */
export function sidebarCollapsedFor(narrow: boolean): boolean {
  return narrow || readSidebarCollapsed();
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(COLLAPSED_PREF_KEY, collapsed ? 'collapsed' : 'open'); } catch { /* preference only */ }
}
