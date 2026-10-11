/** Chat keeps its Files toolbar while sharing the artifact viewer with other work. */
import type { ReactNode } from 'react';
import { ArtifactWorkspace } from '@/components/artifacts/ArtifactWorkspace';

export { useFileDock, type DockedItem } from '@/components/artifacts/ArtifactWorkspace';

export function FileDockWorkspace({ conversationId, children }: { conversationId?: string; children: ReactNode }) {
  return <ArtifactWorkspace scopeKey={`chat:${conversationId ?? 'new'}`} returnLabel="conversation" scrollContent={false} filesSessionId={conversationId} showFilesBar>{children}</ArtifactWorkspace>;
}
