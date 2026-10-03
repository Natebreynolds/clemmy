import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CLOUD_BROWSER_PARAMETERS, parseCloudBrowserArguments, type CloudBrowserOperationName } from './cloud-browser-contract.js';
import { textResult, nonWriteTextResult } from './shared.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { currentToolAbortSignal } from '../runtime/tool-abort-context.js';
import { getBrowserbaseService, BrowserbaseServiceError, browserbaseErrorText, type BrowserbaseResource } from '../integrations/browserbase.js';
import { hostPreDispatchRefusal } from '../runtime/harness/host-pre-dispatch-refusal.js';

/** UI metadata belongs in the dock. Do not repeat every retained page beside
 * each bounded read or inflate a resource-list discovery response. Actual page
 * evidence and exact handles remain in the requested operation's result. */
function resourceForTool(resource: BrowserbaseResource): Omit<BrowserbaseResource, 'pages'> & { pageCount: number; pagesOmitted: true } {
  const { pages, ...identity } = resource;
  return { ...identity, pageCount: pages.length, pagesOmitted: true };
}

/** Task identity comes from the authenticated host invocation, never a model field. */
export async function executeCloudBrowserTool(name: CloudBrowserOperationName, raw: unknown, service = getBrowserbaseService()): Promise<unknown> {
  let args: Record<string, unknown>;
  try { args = parseCloudBrowserArguments(name, raw); }
  catch { throw hostPreDispatchRefusal('Arguments exceed this fixed cloud browser operation.'); }
  const tool = getToolOutputContext();
  const run = harnessRunContextStorage.getStore();
  const conversationId = tool?.sessionId ?? run?.sessionId;
  if (!conversationId) throw hostPreDispatchRefusal('A cloud browser requires an authenticated task context.');
  try {
    if (name === 'cloud_browser_resources') {
      const resources = await service.list(conversationId);
      return { resources: resources.slice(-20).map(resourceForTool),
        truncated: resources.length > 20 };
    }
    if (name === 'cloud_browser_start') {
      const source = tool?.sourceUserSeq ?? run?.sourceUserSeq;
      if (!source || !Number.isSafeInteger(source)) throw hostPreDispatchRefusal('A cloud browser requires an accepted task source.');
      // One start per accepted source; a repaired/repeated tool call rejoins the
      // reserved resource instead of paying for another session.
      const requestId = createHash('sha256').update(`${conversationId}:${source}:cloud-browser`).digest('hex');
      // This chat's open browser is rejoined, never bought twice.
      const open = (await service.list(conversationId)).find((item) => item.providerSessionId && (item.state === 'active' || item.state === 'starting'));
      const resource = open ?? await service.create({ conversationId, requestId, recording: false });
      if (resource.state !== 'active' || resource.controller !== 'agent' || resource.returnPending) {
        return { resource: resourceForTool(resource), ...(open ? { rejoined: true } : {}),
          ...(resource.controller === 'human' ? { note: 'The owner has control of this browser. Wait until they return it to Clem.' } : {}) };
      }
      // The page handle comes back with the browser, so the next step can act
      // on it directly; a url opens there in the same call.
      const tabs = await service.agentOperation(resource.id, conversationId, { operation: 'tabs', args: {}, expectedVersion: resource.controlVersion }, currentToolAbortSignal());
      const pages = tabs.resource.pages;
      const page = pages.find((item) => item.targetId === tabs.resource.focusTargetId) ?? pages[0];
      const handles = { resource: resourceForTool(tabs.resource), ...(open ? { rejoined: true } : {}),
        pages: pages.slice(0, 10).map((item) => ({ target_id: item.targetId, title: item.title, url: item.url })) };
      if (!args.url || !page) return handles;
      try {
        const navigated = await service.agentOperation(resource.id, conversationId, { operation: 'navigate', args: { targetId: page.targetId, url: args.url },
          expectedVersion: tabs.resource.controlVersion }, currentToolAbortSignal());
        return { ...handles, resource: resourceForTool(navigated.resource),
          pages: navigated.resource.pages.slice(0, 10).map((item) => ({ target_id: item.targetId, title: item.title, url: item.url })),
          navigated: { target_id: page.targetId, result: navigated.result, receipt: navigated.receipt } };
      } catch (error) {
        // The browser started either way; the navigation's own outcome is reported, not hidden.
        const failure = error instanceof BrowserbaseServiceError ? error : null;
        return { ...handles, navigated: { target_id: page.targetId, ok: false, effect: failure?.effect ?? 'uncertain',
          error: failure && failure.effect === 'none' ? browserbaseErrorText(failure.code) : 'The navigation did not settle. Check the page with cloud_browser_tabs before trying again.' } };
      }
    }
    if (name === 'cloud_browser_status') return { resource: resourceForTool(await service.get(String(args.resource_id), conversationId)) };
    const operation = name.slice('cloud_browser_'.length) as 'tabs' | 'read' | 'open' | 'navigate';
    const response = await service.agentOperation(String(args.resource_id), conversationId, {
      operation, expectedVersion: Number(args.expected_version),
      args: { ...(args.target_id ? { targetId: args.target_id } : {}), ...(args.url ? { url: args.url } : {}),
        ...(args.max_chars != null ? { maxChars: args.max_chars } : {}) },
    }, currentToolAbortSignal());
    return { ...response, resource: resourceForTool(response.resource) };
  } catch (error) {
    if (error instanceof BrowserbaseServiceError && error.effect === 'none') throw hostPreDispatchRefusal(browserbaseErrorText(error.code));
    throw error;
  }
}

export function registerCloudBrowserTools(server: McpServer): void {
  const descriptions: Record<CloudBrowserOperationName, string> = {
    cloud_browser_start: 'Start the cloud browser for this chat, or rejoin the one already open here (including one the owner opened or handed over). Pass url to open a website in its first page in the same call. Returns the resource id, controlVersion and page handles (target_id) to read or navigate directly. This operation already finds the existing browser; no preliminary resources call or separate open call is needed. Respects human control. Cloud usage is billed by the connected provider; recording stays off.',
    cloud_browser_resources: 'List the recent cloud browser resources already owned by this task, including one the user started in the UI. Use this to inspect or select an existing resource and its exact controlVersion. cloud_browser_start already resolves and rejoins this chat\'s browser; a preliminary list is unnecessary.',
    cloud_browser_status: 'Observe this exact task-owned cloud browser and its current controlVersion. Use after a handoff or a stale-version refusal. Reports pending or uncertain effects honestly; does not replay actions or grant control. Page metadata is omitted here; cloud_browser_tabs provides fresh exact handles.',
    cloud_browser_tabs: 'Freshly observe pages in this exact task-owned cloud browser. Returns current targetId handles. Refuses while the user has control or the controlVersion changed; never substitutes another session.',
    cloud_browser_read: 'Read bounded visible text from the exact task-owned cloud browser page. Uses a fixed observation, no caller script. Requires its current controlVersion and targetId. Refuses during human control.',
    cloud_browser_open: 'Open an additional blank page in this chat\'s cloud browser and return its targetId. cloud_browser_start already returns a first page; use this only when a second tab is needed. Uses the current controlVersion; refuses during human control. Does not click, submit or send.',
    cloud_browser_navigate: 'Navigate this exact task-owned cloud browser target to an http(s) URL without embedded credentials. Returns observed page and effect receipt; never retries an uncertain navigation. Does not click, fill, submit or send.',
  };
  for (const name of Object.keys(CLOUD_BROWSER_PARAMETERS) as CloudBrowserOperationName[]) {
    server.tool(name, descriptions[name], CLOUD_BROWSER_PARAMETERS[name], async (args: Record<string, unknown>) => {
      try { return textResult(JSON.stringify(await executeCloudBrowserTool(name, args))); }
      catch (error) {
        const { isHostPreDispatchRefusal } = await import('../runtime/harness/host-pre-dispatch-refusal.js');
        if (isHostPreDispatchRefusal(error) && error instanceof Error) return nonWriteTextResult('cloud_browser_not_dispatched', error.message);
        return textResult('Cloud browser operation did not settle. Inspect its status; do not repeat a possible write.', { isError: true });
      }
    });
  }
  server.tool('cloud_browser_stop', 'Request release of this exact task-owned cloud browser and observe its provider status. Only stopped or expired proves the session ended. Closing does not complete the task or prove its external effects.', {
    resource_id: z.string().min(1).max(128), expected_version: z.number().int().min(0),
  }, async ({ resource_id, expected_version }) => {
    const conversationId = getToolOutputContext()?.sessionId ?? harnessRunContextStorage.getStore()?.sessionId;
    if (!conversationId) return nonWriteTextResult('cloud_browser_not_dispatched', 'A cloud browser requires its owning task.');
    try { return textResult(JSON.stringify({ resource: resourceForTool(await getBrowserbaseService().stop(resource_id, conversationId, { expectedVersion: expected_version })) })); }
    catch { return textResult('Could not confirm that this cloud browser stopped. Refresh its task status.', { isError: true }); }
  });
}
