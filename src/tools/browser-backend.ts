/** One browser per machine: the one the owner chose on the Connect screen.
 * Clem's own computer driver, once turned on and connected, is the browser as
 * well as the desktop, and neither the cloud browser nor this computer's
 * Chrome harness is offered. Otherwise a chosen cloud provider that is set up
 * is the browser; this computer's Chrome is the browser when the owner chose
 * it, or while no cloud provider is set up. A tool declares which backend it
 * drives (`browserBackend` in the registry); every other tool is unaffected. */
import { cloudBrowserSelection } from '../integrations/browserbase-setup.js';
import { computerDriverIsTheBrowser } from '../integrations/computer-driver.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { TOOL_REGISTRY, type BrowserBackend } from './tool-registry.js';

/** Whether Clem's computer driver is the browser now. Overridable for pins. */
export function computerIsTheBrowser(): boolean {
  if (process.env.CLEMMY_COMPUTER_IS_THE_BROWSER === '1') return true;
  if (process.env.CLEMMY_COMPUTER_IS_THE_BROWSER === '0') return false;
  try { return computerDriverIsTheBrowser(discoverMcpServers()); } catch { return false; }
}

export function browserBackendOffered(backend: BrowserBackend | undefined): boolean {
  if (!backend) return true;
  if (computerIsTheBrowser()) return false;
  return (backend === 'cloud') === (cloudBrowserSelection().provider !== null);
}

export const LOCAL_BROWSER_NOT_OFFERED = 'A cloud browser is the browser on this machine (the owner chose it on the Connect screen): '
  + 'start or rejoin one with cloud_browser_start, then open and navigate pages in it. Nothing was changed. '
  + 'Local Chrome is used only when the owner chooses it, or while no cloud browser is set up.';

export const COMPUTER_IS_THE_BROWSER = 'Your computer is the browser on this machine (the owner turned it on under Connect → Your computer): '
  + 'use the computer driver\'s tools, browser_prepare then browser_navigate, browser_click and browser_type for pages, and its window tools for any app. Nothing was changed.';

/** The words for a browser tool that is not offered now. */
export function browserNotOfferedText(backend: BrowserBackend | undefined): string {
  return computerIsTheBrowser() ? COMPUTER_IS_THE_BROWSER : backend === 'local' ? LOCAL_BROWSER_NOT_OFFERED : 'The browser tool named is not the browser on this machine now. Nothing was changed.';
}

/** Whether a registry tool, by name, is offered on this machine now. */
export function toolNameOffered(name: string): boolean {
  return browserBackendOffered(TOOL_REGISTRY.find((tool) => tool.name === name)?.browserBackend);
}
