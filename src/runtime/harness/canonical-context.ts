import { renderHarnessMemoryContext } from '../../agents/harness-context.js';
import {
  buildAgentContextPacket,
  type AgentContextPacket,
  type MemoryPrimerSummary,
} from './context-packet.js';
import type { TurnSourceStrategyBindingV1 } from './turn-control.js';

export const CANONICAL_CONTEXT_PACK_VERSION = '2026-07-01.report-only-curator';

export type CanonicalContextPartition = 'all' | 'stable' | 'volatile';

export interface CanonicalContextPack {
  version: string;
  source: 'canonical_context_pack';
  inputPreview: string;
  sessionId?: string;
  sessionKind?: string;
  sourceUserSeq?: number;
  memory: MemoryPrimerSummary;
  turn: AgentContextPacket;
  diagnostics: {
    stableMemoryAvailable: boolean;
    volatileMemoryAvailable: boolean;
    turnContextBytes: number;
  };
}

export interface BuildCanonicalContextPackOptions {
  input: string;
  /** Exact current input used for preflight/tool authority. `input` may be a
   * richer private retrieval query for a verified continuation. */
  authorityInput?: string;
  memory: MemoryPrimerSummary;
  sessionId?: string;
  sessionKind?: string;
  sourceUserSeq?: number;
  /** True for synthetic continuation/retry inputs — the alignment beat must
   *  only ever evaluate a REAL user message. */
  suppressConfirmBeat?: boolean;
  /** A typed decline still needs the ordinary conversational/history surface,
   *  but not semantic recall, ranking, capability resolution, or schema warm. */
  suppressSemanticEnrichment?: boolean;
  /** The exact accepted turn declined its parent and supplied an independent
   * fresh clause. This is a policy cue only; provider-visible wording stays
   * byte-exact elsewhere. */
  declinedParentWithNewTask?: boolean;
  /** Compiled direct_reply: skip capability hunt only. */
  skipCapabilityHunt?: boolean;
  sourceStrategyBinding?: TurnSourceStrategyBindingV1;
  includeMemoryDiagnostics?: boolean;
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

export function renderCanonicalMemoryContext(opts?: {
  sessionId?: string;
  query?: string;
  focusInput?: string;
  partition?: CanonicalContextPartition;
  includeRememberedToolChoices?: boolean;
  includeSessionActions?: boolean;
}): string {
  return renderHarnessMemoryContext(opts);
}

export function buildCanonicalContextPack(opts: BuildCanonicalContextPackOptions): CanonicalContextPack {
  const turn = buildAgentContextPacket(opts.input, opts.memory, {
    sessionId: opts.sessionId,
    sessionKind: opts.sessionKind,
    sourceUserSeq: opts.sourceUserSeq,
    suppressConfirmBeat: opts.suppressConfirmBeat,
    suppressSemanticEnrichment: opts.suppressSemanticEnrichment,
    authorityInput: opts.authorityInput,
    declinedParentWithNewTask: opts.declinedParentWithNewTask,
    skipCapabilityHunt: opts.skipCapabilityHunt,
    sourceStrategyBinding: opts.sourceStrategyBinding,
  });

  let stableMemoryAvailable = false;
  let volatileMemoryAvailable = false;
  if (opts.includeMemoryDiagnostics) {
    try {
      stableMemoryAvailable = Boolean(renderCanonicalMemoryContext({
        sessionId: opts.sessionId,
        partition: 'stable',
        includeSessionActions: false,
      }).trim());
    } catch {
      stableMemoryAvailable = false;
    }
    try {
      volatileMemoryAvailable = Boolean(renderCanonicalMemoryContext({
        sessionId: opts.sessionId,
        partition: 'volatile',
        includeSessionActions: false,
      }).trim());
    } catch {
      volatileMemoryAvailable = false;
    }
  }

  return {
    version: CANONICAL_CONTEXT_PACK_VERSION,
    source: 'canonical_context_pack',
    inputPreview: clip(opts.input, 200),
    sessionId: opts.sessionId,
    sessionKind: opts.sessionKind,
    memory: opts.memory,
    turn,
    diagnostics: {
      stableMemoryAvailable,
      volatileMemoryAvailable,
      turnContextBytes: Buffer.byteLength(turn.text, 'utf-8'),
    },
  };
}
