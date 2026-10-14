/** One browser per machine: the one the owner chose on the Connect screen.
 * A chosen cloud provider that is set up is the browser; this computer's
 * Chrome is the browser when the owner chose it, or while no cloud provider
 * is set up. A tool declares which backend it drives (`browserBackend` in
 * the registry); every other tool is unaffected. */
import { cloudBrowserSelection } from '../integrations/browserbase-setup.js';
import { TOOL_REGISTRY, type BrowserBackend } from './tool-registry.js';

export function browserBackendOffered(backend: BrowserBackend | undefined): boolean {
  if (!backend) return true;
  return (backend === 'cloud') === (cloudBrowserSelection().provider !== null);
}

export const LOCAL_BROWSER_NOT_OFFERED = 'A cloud browser is the browser on this machine (the owner chose it on the Connect screen): '
  + 'start or rejoin one with cloud_browser_start, then open and navigate pages in it. Nothing was changed. '
  + 'Local Chrome is used only when the owner chooses it, or while no cloud browser is set up.';

/** Whether a registry tool, by name, is offered on this machine now. */
export function toolNameOffered(name: string): boolean {
  return browserBackendOffered(TOOL_REGISTRY.find((tool) => tool.name === name)?.browserBackend);
}
