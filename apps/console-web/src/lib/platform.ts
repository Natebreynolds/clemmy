/** Best-effort macOS detection for the hiddenInset titlebar layout. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac/i.test(navigator.platform) || /mac os x/i.test(navigator.userAgent);
}
