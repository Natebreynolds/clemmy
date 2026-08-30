import type { OriginHandoffLeaseMessage } from './native-bridge.js';

/**
 * Serializes handoff minting within the PWA realm.
 *
 * The server intentionally retires a device's prior handoff whenever it mints
 * a new one. Two overlapping requests can therefore return out of order and
 * leave the native shell holding the retired token. Sharing one promise makes
 * that response ordering impossible; the server-authored generation remains
 * the cross-process/order backstop in native storage.
 */
export class OriginHandoffMintCoordinator {
  private inFlight: Promise<boolean> | null = null;

  ensure(
    mint: () => Promise<OriginHandoffLeaseMessage>,
    park: (lease: OriginHandoffLeaseMessage) => boolean,
  ): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const operation = mint()
      .then((lease) => park(lease))
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      });
    this.inFlight = operation;
    return operation;
  }
}

export const originHandoffMintCoordinator = new OriginHandoffMintCoordinator();
