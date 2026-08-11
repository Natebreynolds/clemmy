/**
 * Side-effect registration of the local schema provider for the callable
 * surface oracle. Importing this module makes `resolveCallable` able to serve
 * exact local tool schemas without network or budget — each lane's entry
 * imports it, and a wiring pin per lane asserts the registration is active
 * (an unregistered lane degrades to mandating NOTHING, never a phantom).
 *
 * Kept as its own module so callable-surface (harness) and
 * local-runtime-tools (tools) never import each other.
 */
import { z } from 'zod';
import { registerLocalSchemaProvider } from '../runtime/harness/callable-surface.js';
import { getLocalToolSchemas } from './local-runtime-tools.js';

let cachedProjection: ReadonlyMap<string, Record<string, unknown>> | null = null;

registerLocalSchemaProvider(() => {
  if (!cachedProjection) {
    const map = new Map<string, Record<string, unknown>>();
    for (const [name, schema] of getLocalToolSchemas()) {
      try {
        map.set(name, z.toJSONSchema(schema) as Record<string, unknown>);
      } catch {
        // A single unprojectable schema must not silence the rest.
      }
    }
    cachedProjection = map;
  }
  return cachedProjection;
});

/** Test seam: force re-projection after local tool registration changes. */
export function _clearLocalSchemaProjectionForTests(): void {
  cachedProjection = null;
}
