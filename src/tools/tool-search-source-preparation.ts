/** Selected-page definition reads are independent across source adapters.
 * Catalog disclosure remains a separate, ordered mutation boundary. */
import type { ToolSearchBrokerCandidate, ToolSearchCandidateSource } from './tool-search-tool.js';

export interface SelectedSourcePreparation {
  source: ToolSearchCandidateSource;
  candidates: readonly ToolSearchBrokerCandidate[];
}

export interface SelectedSourcePreparationOutcome {
  source: ToolSearchCandidateSource;
  prepared: ToolSearchBrokerCandidate[];
  expired: boolean;
}

/** One shared preparation deadline, bounded by the broker's existing clock.
 * Promise.all preserves source order regardless of which definition read ends
 * first. Every adapter keeps its own cancellation guard, including after a
 * timeout returns a partial page while its underlying read finishes late. */
export async function prepareSelectedToolSearchSources(input: {
  selections: readonly SelectedSourcePreparation[];
  query: string;
  reuseSearchPreparation: boolean;
  brokerDeadlineAt: number;
  preparationBudgetMs: number;
  signal?: AbortSignal;
}): Promise<SelectedSourcePreparationOutcome[]> {
  const deadlineAt = Math.min(input.brokerDeadlineAt, Date.now() + input.preparationBudgetMs);
  const prepare = async ({ source, candidates }: SelectedSourcePreparation): Promise<SelectedSourcePreparationOutcome> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expire!: () => void;
    const expired = new Promise<ToolSearchBrokerCandidate[]>(resolve => {
      expire = () => { controller.abort(input.signal?.reason); resolve([]); };
    });
    input.signal?.addEventListener('abort', expire, { once: true });
    try {
      if (input.signal?.aborted || Date.now() >= deadlineAt) {
        expire();
        return { source, prepared: [], expired: true };
      }
      timer = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
      const prepared = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted || Date.now() >= deadlineAt) return [];
          return source.prepareCandidates!({
            candidates,
            query: input.query,
            reuseSearchPreparation: input.reuseSearchPreparation,
            signal: controller.signal,
            deadlineAt,
          });
        }).catch(() => []),
        expired,
      ]);
      const ended = controller.signal.aborted || Date.now() >= deadlineAt;
      return { source, prepared: ended ? [] : prepared, expired: ended };
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', expire);
      // The adapter may not publish from a detached read after its owner ends.
      controller.abort();
    }
  };
  // Production adapters have distinct source kinds. Preserve ordered execution
  // for a custom broker that supplies multiple adapters for one kind; those
  // share the candidate namespace and are not independent preparation owners.
  const precedingByKind = new Map<ToolSearchCandidateSource['kind'], Promise<SelectedSourcePreparationOutcome>>();
  return Promise.all(input.selections.map(selection => {
    const preceding = precedingByKind.get(selection.source.kind);
    const pending = preceding ? preceding.then(() => prepare(selection)) : prepare(selection);
    precedingByKind.set(selection.source.kind, pending);
    return pending;
  }));
}
