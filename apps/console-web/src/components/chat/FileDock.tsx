/** Chat keeps its Files toolbar while sharing the artifact viewer with other work. */
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ArtifactWorkspace } from '@/components/artifacts/ArtifactWorkspace';
import { newComposerDraftKey } from '@/lib/composer-drafts';

export { useFileDock, type DockedItem, type FilesControl } from '@/components/artifacts/ArtifactWorkspace';

export function FileDockWorkspace({ conversationId, children, inHeader = false }: { conversationId?: string; children: ReactNode; inHeader?: boolean }) {
  const location = useLocation();
  const scope = conversationId ?? newComposerDraftKey(location.pathname, location.key, (location.state as { newChat?: number } | null)?.newChat);
  return <ArtifactWorkspace scopeKey={`chat:${scope}`} returnLabel="conversation" scrollContent={false} filesSessionId={conversationId} showFilesBar filesInHeader={inHeader}>{children}</ArtifactWorkspace>;
}
