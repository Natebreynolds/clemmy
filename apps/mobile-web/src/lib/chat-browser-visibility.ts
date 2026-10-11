import type { CloudBrowserResource } from '@clem/chat-engine';

/** A chat shortcut represents this conversation's unfinished browser work.
 * Historical sessions and browsers in other chats remain in Browser tools. */
export function conversationBrowsersInUse<T extends Pick<CloudBrowserResource, 'state' | 'returnPending'>>(resources: readonly T[]): T[] {
  return resources.filter(resource => resource.returnPending || (resource.state !== 'stopped' && resource.state !== 'expired'));
}
