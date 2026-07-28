import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { clemmy } from '@/lib/clemmy';
import {
  addSpaceNote,
  composeSpace,
  executeSpaceAction,
  getSpaceData,
  refreshSpace,
  spaceViewUrl,
} from '@/lib/spaces';
import {
  parseWorkspaceRpcBootstrapEvent,
  parseWorkspaceRpcRequest,
  workspaceRpcCorrelation,
  workspaceRpcFailure,
  workspaceRpcOpAllowed,
  workspaceRpcSuccess,
  WORKSPACE_IFRAME_SANDBOX,
  WORKSPACE_RPC_CHANNEL,
  type WorkspaceRpcFailure,
  type WorkspaceRpcRequest,
} from '@/lib/workspace-rpc';

interface WorkspaceFrameProps {
  id: string;
  title: string;
  className?: string;
  style?: CSSProperties;
  tabIndex?: number;
  ariaHidden?: boolean;
  readOnly?: boolean;
  onMutation?: () => void;
}

const MAX_IN_FLIGHT = 16;
const MAX_REMEMBERED_REQUESTS = 256;
const MAX_DOWNLOAD_BYTES = 100_000;

async function openWorkspaceExternal(url: string): Promise<{ opened: true }> {
  const desktop = clemmy();
  if (desktop?.workspaceOpenExternal) {
    await desktop.workspaceOpenExternal(url);
    return { opened: true };
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) throw new Error('Your browser blocked the new tab. Allow popups for Clementine and try again.');
  return { opened: true };
}

async function downloadWorkspaceData(dataUrl: string, filename: string): Promise<{ downloaded: true }> {
  if (dataUrl.length > MAX_DOWNLOAD_BYTES) throw new Error('Workspace download is too large');
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (blob.size > MAX_DOWNLOAD_BYTES) throw new Error('Workspace download is too large');
  const href = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  }
  return { downloaded: true };
}

async function runWorkspaceOperation(id: string, request: WorkspaceRpcRequest): Promise<unknown> {
  const payload = request.payload;
  switch (request.op) {
    case 'data':
      return getSpaceData(id);
    case 'refresh':
      return refreshSpace(id, typeof payload.sourceId === 'string' ? payload.sourceId : undefined);
    case 'note': {
      const note = await addSpaceNote(id, {
        text: payload.text as string,
        ...(typeof payload.kind === 'string' ? { kind: payload.kind } : {}),
        ...(payload.meta && typeof payload.meta === 'object'
          ? { meta: payload.meta as Record<string, unknown> }
          : {}),
      });
      return { note };
    }
    case 'compose':
      return composeSpace(id, {
        instructions: payload.instructions as string,
        ...(payload.context !== undefined ? { context: payload.context } : {}),
        ...(typeof payload.maxChars === 'number' ? { maxChars: payload.maxChars } : {}),
      });
    case 'action':
      return executeSpaceAction(id, {
        actionId: payload.actionId as string,
        args: payload.args as Record<string, unknown>,
      });
    case 'open_external':
      return openWorkspaceExternal(payload.url as string);
    case 'download':
      return downloadWorkspaceData(payload.dataUrl as string, payload.filename as string);
  }
}

/**
 * The only trusted host for authored Workspace HTML. `sandbox="allow-scripts"`
 * intentionally omits allow-same-origin, forms, popups and top navigation.
 * Gallery previews reuse the same boundary in read-only mode.
 */
export function WorkspaceFrame({
  id,
  title,
  className,
  style,
  tabIndex,
  ariaHidden,
  readOnly = false,
  onMutation,
}: WorkspaceFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onMutationRef = useRef(onMutation);
  onMutationRef.current = onMutation;

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const seen = new Set<string>();
    const seenOrder: string[] = [];
    let inFlight = 0;
    let pinnedDocumentId: string | null = null;
    let port: MessagePort | null = null;
    let loadCount = 0;
    let revoked = false;

    const remember = (requestId: string): boolean => {
      if (seen.has(requestId)) return false;
      seen.add(requestId);
      seenOrder.push(requestId);
      if (seenOrder.length > MAX_REMEMBERED_REQUESTS) {
        const oldest = seenOrder.shift();
        if (oldest) seen.delete(oldest);
      }
      return true;
    };

    const reply = (response: ReturnType<typeof workspaceRpcSuccess> | WorkspaceRpcFailure) => {
      if (!revoked && port) port.postMessage(response);
    };

    const receivePort = (event: MessageEvent<unknown>) => {
      if (revoked || !port) return;
      const parsed = parseWorkspaceRpcRequest(event.data, id);
      if (!parsed.ok) {
        const correlation = workspaceRpcCorrelation(event.data, id);
        if (correlation) {
          reply({
            channel: WORKSPACE_RPC_CHANNEL,
            version: 1,
            kind: 'response',
            workspaceId: correlation.workspaceId,
            id: correlation.id,
            ok: false,
            error: `Invalid Workspace request (${parsed.reason})`,
          });
        }
        return;
      }
      const request = parsed.request;
      if (!remember(request.id)) {
        reply(workspaceRpcFailure(request, 'Duplicate Workspace request'));
        return;
      }
      if (!workspaceRpcOpAllowed(request.op, readOnly)) {
        reply(workspaceRpcFailure(request, 'Workspace preview is read-only'));
        return;
      }
      if (inFlight >= MAX_IN_FLIGHT) {
        reply(workspaceRpcFailure(request, 'Workspace is busy; try again'));
        return;
      }
      inFlight += 1;
      void runWorkspaceOperation(id, request)
        .then((result) => {
          reply(workspaceRpcSuccess(request, result));
          if (request.op === 'refresh' || request.op === 'note' || request.op === 'action') {
            onMutationRef.current?.();
          }
        })
        .catch((error: unknown) => {
          reply(workspaceRpcFailure(
            request,
            error instanceof Error ? error.message : 'Workspace request failed',
          ));
        })
        .finally(() => { inFlight -= 1; });
    };

    const receiveBootstrap = (event: MessageEvent<unknown>) => {
      const source = frame.contentWindow;
      if (!source || revoked) return;
      const parsed = parseWorkspaceRpcBootstrapEvent(event, source, id);
      if (!parsed.ok) return;
      // A WindowProxy survives iframe navigations. Pin the first document id
      // and never transfer authority to a replacement document in that proxy.
      if (pinnedDocumentId) return;
      pinnedDocumentId = parsed.bootstrap.documentId;
      const channel = new MessageChannel();
      port = channel.port1;
      port.addEventListener('message', receivePort);
      port.start();
      source.postMessage({
        channel: WORKSPACE_RPC_CHANNEL,
        version: 1,
        kind: 'bootstrap_ack',
        workspaceId: id,
        documentId: pinnedDocumentId,
      }, '*', [channel.port2]);
    };

    const onLoad = () => {
      loadCount += 1;
      if (loadCount <= 1) return;
      // Defense in depth for hosts without Electron's will-frame-navigate
      // guard. The injected Navigation listener blocks before commit; if a
      // document nevertheless changes, revoke its port permanently.
      revoked = true;
      port?.close();
      port = null;
    };

    frame.addEventListener('load', onLoad);
    window.addEventListener('message', receiveBootstrap);
    return () => {
      revoked = true;
      frame.removeEventListener('load', onLoad);
      window.removeEventListener('message', receiveBootstrap);
      if (port) {
        port.removeEventListener('message', receivePort);
        port.close();
      }
    };
  }, [id, readOnly]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      src={spaceViewUrl(id)}
      sandbox={WORKSPACE_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className={className}
      style={style}
      tabIndex={tabIndex}
      aria-hidden={ariaHidden}
    />
  );
}
