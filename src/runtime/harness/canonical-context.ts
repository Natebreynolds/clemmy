import { renderHarnessMemoryContext } from '../../agents/harness-context.js';
import {
  buildAgentContextPacket,
  type AgentContextPacket,
  type MemoryPrimerSummary,
} from './context-packet.js';

export const CANONICAL_CONTEXT_PACK_VERSION = '2026-07-01.report-only-curator';

export type CanonicalContextPartition = 'all' | 'stable' | 'volatile';

export interface CanonicalContextPack {
  version: string;
  source: 'canonical_context_pack';
  inputPreview: string;
  sessionId?: string;
  sessionKind?: string;
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
  memory: MemoryPrimerSummary;
  sessionId?: string;
  sessionKind?: string;
  includeMemoryDiagnostics?: boolean;
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

export function renderCanonicalMemoryContext(opts?: {
  sessionId?: string;
  query?: string;
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
