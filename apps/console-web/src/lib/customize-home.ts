/** Keep this event independent of the optional appearance editor. */
export const CUSTOMIZE_HOME_EVENT = 'clem:customize-home';
export function openCustomizeHome() {
  window.dispatchEvent(new Event(CUSTOMIZE_HOME_EVENT));
}
