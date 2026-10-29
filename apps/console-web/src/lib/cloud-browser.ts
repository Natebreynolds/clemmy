import { createCloudBrowserClient, type CloudBrowserResource } from '@clem/chat-engine';
import { api } from './api';
export const cloudBrowser = createCloudBrowserClient(api, '/api/console/cloud-browser');

/** Keep session controls reachable without advertising an idle cloud browser. */
export function hasCloudBrowserSession(resources: Pick<CloudBrowserResource, 'state' | 'returnPending'>[], openCount: number, panelOpen = false): boolean {
  return panelOpen || openCount > 0 || resources.some(resource => resource.returnPending || (resource.state !== 'stopped' && resource.state !== 'expired'));
}
