/**
 * Composio's adapter-owned implementation of the production port preparation
 * contract.
 *
 * The shipped transport is a digest-addressed CommonJS artifact. In a source
 * daemon it deliberately loads the packaged Composio client, so its
 * process-local connected-account snapshot is distinct from the source ESM
 * client's snapshot. Preparing through the shipped transport is therefore not
 * redundant: it refreshes and revalidates the exact account in the same module
 * instance that will mint the following one-shot dispatch.
 *
 * Shared dispatch code sees only the generic three-part port contract. Provider
 * identity and refresh mechanics stay in this adapter.
 */
import { capabilityManifestDigest, type CapabilityManifestV1 } from './capability-manifest.js';
import type { ProductionCapabilityPort } from './production-capability-ports.js';
import { loadShippedImplementations } from './shipped-implementation-identity.js';

type PreparationPort = Required<Pick<
  ProductionCapabilityPort,
  'admitPreparation' | 'prepareInvocation' | 'invokeWithPreparation'
>>;

const preparationByManifest = new Map<string, PreparationPort>();
const preparedProofs = new WeakMap<object, string>();

function preparationKey(manifest: CapabilityManifestV1): string {
  return JSON.stringify({
    manifestId: manifest.manifestId,
    manifestDigest: capabilityManifestDigest(manifest),
    operationId: manifest.operationId,
    accountId: manifest.accountId,
  });
}

/**
 * Return adapter preparation hooks only for a Composio manifest. The returned
 * function identities are stable for one exact manifest identity so repeated
 * publication cannot conflict with an already-registered production port.
 */
export function composioPreparationForManifest(
  manifest: CapabilityManifestV1,
): Partial<PreparationPort> {
  if (manifest.providerKind !== 'composio') return {};
  const key = preparationKey(manifest);
  const prior = preparationByManifest.get(key);
  if (prior) return prior;

  const hooks: PreparationPort = {
    // Synchronous admission is intentionally value-free. The exact manifest,
    // account and operation are captured by this closure; the async edge below
    // performs their live revalidation before any business physical row.
    admitPreparation() {},
    async prepareInvocation() {
      await loadShippedImplementations().prepareComposioDispatch({
        operationId: manifest.operationId,
        accountId: manifest.accountId,
      });
      const proof = Object.freeze(Object.create(null)) as object;
      preparedProofs.set(proof, key);
      return proof;
    },
    async invokeWithPreparation<T>(proof: unknown, work: () => Promise<T>): Promise<T> {
      if (
        !proof
        || typeof proof !== 'object'
        || preparedProofs.get(proof as object) !== key
      ) {
        throw new Error('Composio invocation lacks its exact current preparation proof');
      }
      // Consume before entering the provider body. Neither failure nor caller
      // reuse can turn one account observation into a second dispatch grant.
      preparedProofs.delete(proof as object);
      return work();
    },
  };
  preparationByManifest.set(key, hooks);
  return hooks;
}
