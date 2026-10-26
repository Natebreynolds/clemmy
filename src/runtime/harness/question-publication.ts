import { AsyncLocalStorage } from 'node:async_hooks';

export interface PreparedQuestionPublication {
  readonly question: string;
  readonly options: readonly string[] | null;
  /** False when the host replaced the proposed wording with its own control. */
  readonly modelAuthored: boolean;
  /** Synchronous final ownership check and post; never executes twice. */
  publish(): boolean;
}

const publicationCapture = new AsyncLocalStorage<(publication: PreparedQuestionPublication) => void>();

/** The caller owns review and lifetime. Nothing is retained outside this scope. */
export function withQuestionPublicationCapture<T>(
  capture: (publication: PreparedQuestionPublication) => void,
  invoke: () => T,
): T {
  return publicationCapture.run(capture, invoke);
}

/** Prepare the exact public projection without changing the synchronous SDK
 * behavior outside a host-owned capture scope. This supplies no review verdict,
 * task completion, execution authority or durable state. */
export function publishOrDeferQuestionPublication(
  input: Pick<PreparedQuestionPublication, 'question' | 'options' | 'modelAuthored'>,
  publish: () => boolean,
): boolean {
  let attempted = false;
  let published = false;
  const publication: PreparedQuestionPublication = Object.freeze({
    question: input.question,
    options: input.options === null ? null : Object.freeze([...input.options]),
    modelAuthored: input.modelAuthored,
    publish: () => {
      if (attempted) return published;
      // A thrown/failed ownership check cannot be retried under a later owner.
      attempted = true;
      published = publish();
      return published;
    },
  });
  const capture = publicationCapture.getStore();
  if (capture) {
    capture(publication);
    return true;
  }
  return publication.publish();
}
