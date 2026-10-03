/** One browser per machine. A set-up cloud browser is the browser; local
 * Chrome is the fallback, offered only while no cloud browser is set up. A
 * tool declares which backend it drives (`browserBackend` in the registry);
 * every other tool is unaffected. */
import { browserbaseProjectSetUp } from '../integrations/browserbase-setup.js';
import { TOOL_REGISTRY, type BrowserBackend } from './tool-registry.js';

export function browserBackendOffered(backend: BrowserBackend | undefined): boolean {
  if (!backend) return true;
  return (backend === 'cloud') === browserbaseProjectSetUp();
}

export const LOCAL_BROWSER_NOT_OFFERED = 'A cloud browser is set up on this machine, so it is the browser here: '
  + 'start or rejoin one with cloud_browser_start, then open and navigate pages in it. Nothing was changed. '
  + 'Local Chrome is used only when no cloud browser is set up.';

/** Whether a registry tool, by name, is offered on this machine now. */
export function toolNameOffered(name: string): boolean {
  return browserBackendOffered(TOOL_REGISTRY.find((tool) => tool.name === name)?.browserBackend);
}
