/** One browser per machine. Clem's own computer driver, once turned on and
 * connected, is the browser as well as the desktop. On macOS and Linux it is
 * the only browser: the cloud browser and this computer's Chrome harness are
 * retired there, and until the owner turns the driver on Clem offers that one
 * tap instead. On Windows, where the driver is still the vendor's preview,
 * the older choice stands until it is proven: a chosen cloud provider that is
 * set up is the browser; this computer's Chrome is the browser when the owner
 * chose it, or while no cloud provider is set up. A tool declares which
 * backend it drives (`browserBackend` in the registry); every other tool is
 * unaffected. */
import { cloudBrowserSelection } from '../integrations/browserbase-setup.js';
import { computerDriverIsTheBrowserNow } from '../integrations/computer-driver-presence.js';
import { TOOL_REGISTRY, type BrowserBackend } from './tool-registry.js';

/** Whether Clem's computer driver is the browser now. Overridable for pins. */
export function computerIsTheBrowser(): boolean {
  try { return computerDriverIsTheBrowserNow(); } catch { return false; }
}

let platformForPins: NodeJS.Platform | null = null;
/** Pins that drive the older browsers run them as on Windows, where they stand. */
export function _testOnly_setBrowserPlatform(platform: NodeJS.Platform | null): void { platformForPins = platform; }

/** The cloud browser and the Chrome harness are retired on this system. */
export function olderBrowsersRetired(platform: NodeJS.Platform = platformForPins ?? process.platform): boolean {
  return platform !== 'win32';
}

export function browserBackendOffered(backend: BrowserBackend | undefined): boolean {
  if (!backend) return true;
  if (computerIsTheBrowser() || olderBrowsersRetired()) return false;
  return (backend === 'cloud') === (cloudBrowserSelection().provider !== null);
}

/** Which browser a page can be opened in now: the computer's, the computer's
 *  once the owner turns it on, or the older choice where it still stands. */
export type BrowserDoor = 'computer' | 'computer_off' | 'older';

export function browserDoor(): BrowserDoor {
  if (computerIsTheBrowser()) return 'computer';
  return olderBrowsersRetired() ? 'computer_off' : 'older';
}

export const LOCAL_BROWSER_NOT_OFFERED = 'A cloud browser is the browser on this machine (the owner chose it on the Connect screen): '
  + 'start or rejoin one with cloud_browser_start, then open and navigate pages in it. Nothing was changed. '
  + 'Local Chrome is used only when the owner chooses it, or while no cloud browser is set up.';

export const COMPUTER_IS_THE_BROWSER = 'Your computer is the browser on this machine (the owner turned it on under Connect → Your computer): '
  + 'use the computer driver\'s tools, browser_prepare then browser_navigate, browser_click and browser_type for pages, and its window tools for any app. Nothing was changed.';

/** What setting up a retired browser answers, in the owner's words. */
export const OLDER_BROWSER_SETUP_RETIRED = 'On this computer Clem\'s browser is your computer (Connect → Your computer). '
  + 'The cloud browser and this computer\'s Chrome are not used here, so nothing was set up.';

export const COMPUTER_NOT_ON = 'The browser on this computer is Clem\'s computer driver, and the owner has not turned it on yet. Nothing was changed. '
  + 'If the task needs a browser (a page a web read cannot reach, a sign-in, a form), ask the owner in your own words whether to turn it on: '
  + 'one tap at Connect → Your computer, then you can do this. A page that only needs reading can still be read with the web read tools.';

/** The words for a browser tool that is not offered now. */
export function browserNotOfferedText(backend: BrowserBackend | undefined): string {
  const door = browserDoor();
  return door === 'computer' ? COMPUTER_IS_THE_BROWSER : door === 'computer_off' ? COMPUTER_NOT_ON
    : backend === 'local' ? LOCAL_BROWSER_NOT_OFFERED : 'The browser tool named is not the browser on this machine now. Nothing was changed.';
}

/** Whether a registry tool, by name, is offered on this machine now. */
export function toolNameOffered(name: string): boolean {
  return browserBackendOffered(TOOL_REGISTRY.find((tool) => tool.name === name)?.browserBackend);
}
