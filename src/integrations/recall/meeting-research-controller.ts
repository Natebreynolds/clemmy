import type { MeetingAssistanceSnapshot } from './meeting-assistance.js';
import type { createMeetingResearchCoordinator } from './meeting-research.js';

export interface MeetingResearchControllerOptions {
  research: Pick<ReturnType<typeof createMeetingResearchCoordinator>, 'get' | 'enqueue' | 'drain' | 'stop'>;
  assistance: {
    get(id: string): MeetingAssistanceSnapshot;
    markQueued(id: string, offerId: string, offerDigest: string): unknown;
    set(id: string, value: { enabled: false }): unknown;
  };
  /** Tests control only wake delivery. Production never waits in transcript ingress. */
  schedule?: (callback: () => void) => void;
}

/** The bridge owns wake coalescing, not permission or execution. The durable
 * coordinator still validates exact evidence and reserves its budget before an
 * offer is marked. Reads/polls never call request implicitly. */
export function createMeetingResearchController(options: MeetingResearchControllerOptions) {
  const pending = new Set<string>();
  const schedule = options.schedule ?? queueMicrotask;
  // A saved permission admits at most eight lookups. One ingress wake must
  // never create an unbounded microtask chain, even with inconsistent ports.
  const requestWithinBudget = (id: string, remainingCycles: number): void => {
    if (pending.has(id)) return;
    pending.add(id);
    try {
      schedule(() => { void (async () => {
        let consumed: { id: string; digest: string } | undefined;
        let settledAdmitted = false;
        let queuedProgress = false;
        try {
          const state = options.research.get(id);
          if (!state.enabled) return;
          const assistance = options.assistance.get(id);
          if (!assistance.enabled || assistance.status === 'completed') { options.research.stop(id); return; }
          const queued = state.jobs.some(job => job.status === 'queued');
          if (state.status === 'exhausted' && !queued) { options.assistance.set(id, { enabled: false }); return; }
          if (assistance.offer && state.status !== 'exhausted') {
            const offer = assistance.offer;
            options.research.enqueue(id, { offerId: offer.id, offerDigest: offer.digest, sourceDigest: offer.sourceDigest,
              question: offer.question, quote: offer.quote, segmentIds: [...offer.segmentIds] });
            options.assistance.markQueued(id, offer.id, offer.digest);
            consumed = { id: offer.id, digest: offer.digest };
          }
          const settled = await options.research.drain(id);
          settledAdmitted = settled.status === 'ready' || settled.status === 'exhausted';
          queuedProgress = settledAdmitted && settled.jobs.some(job => job.status === 'queued')
            && state.jobs.some(prior => (prior.status === 'queued' || prior.status === 'running')
              && settled.jobs.some(current => current.id === prior.id && current.status !== prior.status));
          // Spending the final allowance also ends automatic Quick scans.
          if (settled.status === 'exhausted' && !settled.jobs.some(job => job.status === 'queued' || job.status === 'running')) options.assistance.set(id, { enabled: false });
        } catch { /* Durable state explains the gap; an error never buys an automatic retry. */ }
        finally {
          pending.delete(id);
          try {
            if (remainingCycles > 1 && settledAdmitted && (consumed || queuedProgress)) {
              const current = options.research.get(id);
              if (current.status !== 'ready' && current.status !== 'exhausted') return;
              const next = options.assistance.get(id);
              const newOffer = Boolean(current.status === 'ready' && consumed && next.offer
                && (next.offer.id !== consumed.id || next.offer.digest !== consumed.digest));
              const retainedQueue = queuedProgress && current.jobs.some(job => job.status === 'queued');
              if (next.enabled && next.status !== 'completed' && (newOffer || retainedQueue)) requestWithinBudget(id, remainingCycles - 1);
            }
          } catch { /* No wake without current authority and a new offer or observed queue progress. */ }
        }
      })(); });
    } catch { pending.delete(id); }
  };
  return { request: (id: string): void => requestWithinBudget(id, 8) };
}
