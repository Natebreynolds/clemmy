/**
 * The exact next edge when a parked-output reader is asked for an id that is
 * not a result.
 *
 * Live 2026-09-21, source 277962: the brain was handed a proven calendar
 * operation as `cap:resolved:outlook_get_calendar_view:…`, sent that
 * CAPABILITY reference to `tool_output_query` as a `call_id`, and got back
 * "No tool output found … in this session." Thirteen identical attempts
 * later the turn ended as an internal failure with no calendar call made.
 * The reply was true and useless: a capability reference is not a result
 * handle, nothing had been called, and the one sentence that would have
 * repaired the next frame — invoke it first, like this — was never said.
 *
 * This module answers a miss with (1) what the id actually is, (2) the exact
 * carrier invocation when the host can name it, and (3) the results this turn
 * HAS retained, so the model can address real data instead of guessing ids.
 * It grants nothing: the invocation example is the same disclosure the
 * proven-operation guidance already rendered.
 */
import { renderCarrierInvocationExample } from '../../tools/tool-search-tool.js';
import { toolReadsRetainedOutput } from '../../tools/tool-registry.js';
import { peekHostCapabilityCatalogFactory } from './host-capability-catalog-factory.js';
import { listRetainedToolOutputs, type RetainedToolOutputSummary } from './eventlog.js';

export interface RetainedOutputRedirectCatalogEntry {
  capabilityId: string;
  toolName: string;
  providerKind?: string;
  operationId?: string;
}

export interface RetainedOutputRedirectInput {
  requestedId: string;
  readerTool: 'tool_output_query' | 'recall_tool_result';
  retained: readonly RetainedToolOutputSummary[];
  /** Resolves a `cap:` reference to its registered carrier facts, or null. */
  lookupCapability: (capabilityId: string) => RetainedOutputRedirectCatalogEntry | null;
}

export function isCapabilityReference(id: string): boolean {
  return /^cap:[a-z_]+:/i.test(id.trim());
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${bytes} B`;
}

/** Results the model can actually query: business outputs, never a reader's
 * own miss text (which is retained too, and would otherwise be listed back as
 * if it were data). */
export function queryableRetainedOutputs(
  retained: readonly RetainedToolOutputSummary[],
): RetainedToolOutputSummary[] {
  return retained.filter((row) => !(row.tool && toolReadsRetainedOutput(row.tool)));
}

function carrierSentence(entry: RetainedOutputRedirectCatalogEntry, capabilityId: string): string {
  const operation = (entry.operationId ?? entry.toolName ?? '').trim();
  if (entry.providerKind === 'composio' && operation) {
    const example = renderCarrierInvocationExample(
      'work_call',
      { name: 'composio_execute_tool', fixedArgs: { tool_slug: operation.toUpperCase() }, payloadField: 'arguments' },
      capabilityId,
    );
    return `Invoke it first: ${JSON.stringify(example)} — then query the call_id that call returns.`;
  }
  if (entry.providerKind === 'local_registry' && operation) {
    return `Invoke it first by calling ${operation} directly with its own arguments — then query the call_id that call returns.`;
  }
  if (operation) {
    return `Invoke it first through work_call with requirement_id "${capabilityId}" and the carrier tool_search disclosed for ${operation} — then query the call_id that call returns.`;
  }
  return `Invoke it first through the carrier tool_search discloses for it — then query the call_id that call returns.`;
}

function retainedSentence(retained: readonly RetainedToolOutputSummary[]): string {
  const rows = queryableRetainedOutputs(retained);
  if (rows.length === 0) {
    return 'Nothing has been retrieved in this turn yet, so there is no result to query; make the call first.';
  }
  const listed = rows.slice(0, 8).map((row) => (
    `${row.callId}${row.tool ? ` (${row.tool}, ${formatBytes(row.contentBytes)})` : ` (${formatBytes(row.contentBytes)})`}`
  ));
  return `Results retained in this turn, newest first: ${listed.join('; ')}. Query one of these exact call_ids.`;
}

/**
 * Compose the miss reply. Pure: every fact comes from the input so the exact
 * wording can be pinned without a live catalog.
 */
export function describeMissingRetainedOutput(input: RetainedOutputRedirectInput): string {
  const id = input.requestedId.trim();
  const reader = input.readerTool;
  if (isCapabilityReference(id)) {
    const entry = input.lookupCapability(id);
    const carrier = entry
      ? carrierSentence(entry, id)
      : `It is not currently registered on this process; call tool_search to disclose the operation and its carrier, invoke that, then query the call_id it returns.`;
    return [
      `"${id}" is a CAPABILITY reference, not a result handle: no call has been made with it in this turn, so ${reader} has nothing to read.`,
      carrier,
      retainedSentence(input.retained),
    ].join(' ');
  }
  return [
    `No tool output found for call_id "${id}" in this session.`,
    retainedSentence(input.retained),
    'If the data you need has not been retrieved, make the provider call (or call tool_search to find the operation) rather than querying again.',
  ].join(' ');
}

/** Host-wired variant: reads the catalog and the retained ledger. */
export function describeMissingRetainedOutputForSession(input: {
  sessionId: string;
  sourceUserSeq?: number;
  requestedId: string;
  readerTool: 'tool_output_query' | 'recall_tool_result';
}): string {
  let retained: RetainedToolOutputSummary[] = [];
  try {
    retained = listRetainedToolOutputs(input.sessionId, { sourceUserSeq: input.sourceUserSeq, limit: 12 });
  } catch { /* the redirect never fails the read */ }
  return describeMissingRetainedOutput({
    requestedId: input.requestedId,
    readerTool: input.readerTool,
    retained,
    lookupCapability: (capabilityId) => {
      try {
        const entry = peekHostCapabilityCatalogFactory()?.get(capabilityId);
        if (!entry) return null;
        return {
          capabilityId: entry.capabilityId,
          toolName: entry.toolName,
          ...(entry.providerKind ? { providerKind: entry.providerKind } : {}),
          ...(entry.manifest?.operationId ? { operationId: entry.manifest.operationId } : {}),
        };
      } catch {
        return null;
      }
    },
  });
}
