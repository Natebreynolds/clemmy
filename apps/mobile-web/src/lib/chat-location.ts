export interface NewChatLocation {
  kind: 'new';
  scope: string;
  agentId?: string;
  agentName?: string;
  projectId?: string;
  projectName?: string;
}
export type ChatLocation = NewChatLocation | { kind: 'chat'; sessionId: string; title?: string } | null;

/** Window-local navigation only. Draft content lives in its existing scoped store.
 * Initial handoff instructions (especially autoSend) are never replayable state. */
export class MobileChatLocationStore {
  private location: ChatLocation = null;
  private created = new Map<string, string>();

  save(location: ChatLocation): void {
    this.location = !location ? null : location.kind === 'chat'
      ? { kind: 'chat', sessionId: location.sessionId, title: location.title }
      : { kind: 'new', scope: location.scope, agentId: location.agentId, agentName: location.agentName,
        projectId: location.projectId, projectName: location.projectName };
  }
  resume(): ChatLocation {
    const saved = this.location;
    if (!saved) return null;
    const sessionId = saved.kind === 'new' ? this.created.get(saved.scope) : undefined;
    return sessionId ? { kind: 'chat', sessionId } : { ...saved };
  }
  promote(scope: string, sessionId: string): void {
    if (scope && sessionId) this.created.set(scope, sessionId);
  }
  clear(): void { this.location = null; this.created.clear(); }
}

export const mobileChatLocation = new MobileChatLocationStore();
