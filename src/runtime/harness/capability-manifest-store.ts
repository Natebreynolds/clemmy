/**
 * Host-owned trusted capability-manifest store.
 *
 * Only explicit install/revoke/supersede mutate this set. Search, memory,
 * and model-facing tool lists cannot write here. Production bootstrap
 * hydrates from the durable capability_manifests table.
 */
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
  type ManifestValidationRefusal,
} from './capability-manifest.js';
import { openEventLog } from './eventlog.js';

export interface InstalledCapabilityManifest {
  digest: string;
  manifest: CapabilityManifestV1;
}

export interface CapabilityManifestStore {
  install(manifest: CapabilityManifestV1): { ok: true; digest: string } | { ok: false; reason: ManifestValidationRefusal | 'identity_mismatch' };
  revoke(manifestId: string): boolean;
  supersede(manifestId: string, next: CapabilityManifestV1): { ok: true; digest: string } | { ok: false; reason: ManifestValidationRefusal | 'unknown' | 'identity_mismatch' };
  get(manifestId: string): InstalledCapabilityManifest | undefined;
  byDigest(digest: string): InstalledCapabilityManifest | undefined;
  list(): readonly InstalledCapabilityManifest[];
  clear(): void;
}

let installed: CapabilityManifestStore | null = null;

function writeManifestRow(
  db: ReturnType<typeof openEventLog>,
  entry: InstalledCapabilityManifest,
  mode: 'insert' | 'lifecycle',
): void {
  if (mode === 'insert') {
    db.prepare(
      `INSERT INTO capability_manifests
        (manifest_id, digest, manifest_json, lifecycle, installed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      entry.manifest.manifestId,
      entry.digest,
      JSON.stringify(entry.manifest),
      entry.manifest.lifecycle.state,
      entry.manifest.provenance.issuedAt,
    );
    return;
  }
  const updated = db.prepare(
    `UPDATE capability_manifests
        SET digest = ?, manifest_json = ?, lifecycle = ?
      WHERE manifest_id = ?`,
  ).run(
    entry.digest,
    JSON.stringify(entry.manifest),
    entry.manifest.lifecycle.state,
    entry.manifest.manifestId,
  );
  if (updated.changes !== 1) {
    throw new Error(`capability manifest lifecycle write missed ${entry.manifest.manifestId}`);
  }
}

function persistManifestRow(entry: InstalledCapabilityManifest, mode: 'insert' | 'lifecycle'): void {
  const db = openEventLog();
  db.transaction(() => writeManifestRow(db, entry, mode))();
}

function hydrateDurableManifests(): InstalledCapabilityManifest[] {
  const rows = openEventLog().prepare(
    `SELECT digest, manifest_json FROM capability_manifests`,
  ).all() as Array<{ digest: string; manifest_json: string }>;
  return rows.flatMap((row) => {
    try {
      const manifest = JSON.parse(row.manifest_json) as CapabilityManifestV1;
      if (!manifest?.manifestId) return [];
      const digest = capabilityManifestDigest(manifest);
      if (digest !== row.digest) {
        return [{
          digest: row.digest,
          manifest: {
            ...manifest,
            lifecycle: manifest.lifecycle ?? { state: 'revoked' as const },
          },
        }];
      }
      return [{ digest, manifest }];
    } catch {
      return [];
    }
  });
}

export function createCapabilityManifestStore(
  initial: readonly CapabilityManifestV1[] = [],
  options: { durable?: boolean } = {},
): CapabilityManifestStore {
  const byId = new Map<string, InstalledCapabilityManifest>();
  if (options.durable) {
    for (const entry of hydrateDurableManifests()) {
      byId.set(entry.manifest.manifestId, entry);
    }
  }
  const store: CapabilityManifestStore = {
    install(manifest) {
      const checked = currentCapabilityManifest(manifest);
      if (!checked) {
        const state = manifest?.lifecycle?.state;
        if (state === 'revoked') return { ok: false, reason: 'revoked' };
        if (state === 'superseded') return { ok: false, reason: 'superseded' };
        if (manifest?.provenance?.trusted !== true) return { ok: false, reason: 'untrusted_provenance' };
        return { ok: false, reason: 'incomplete' };
      }
      const digest = capabilityManifestDigest(checked);
      const prior = byId.get(checked.manifestId);
      if (prior) {
        if (prior.digest !== digest) return { ok: false, reason: 'identity_mismatch' };
        return { ok: true, digest };
      }
      const installed = { digest, manifest: checked };
      if (options.durable) persistManifestRow(installed, 'insert');
      byId.set(checked.manifestId, installed);
      return { ok: true, digest };
    },
    revoke(manifestId) {
      const existing = byId.get(manifestId);
      if (!existing) return false;
      const manifest = {
        ...existing.manifest,
        lifecycle: { state: 'revoked' as const },
      };
      const revoked = {
        digest: capabilityManifestDigest(manifest),
        manifest,
      };
      if (options.durable) persistManifestRow(revoked, 'lifecycle');
      byId.set(manifestId, revoked);
      return true;
    },
    supersede(manifestId, next) {
      const existing = byId.get(manifestId);
      if (!existing) return { ok: false, reason: 'unknown' };
      if (next.manifestId === manifestId) return { ok: false, reason: 'identity_mismatch' };
      const already = byId.get(next.manifestId);
      if (existing.manifest.lifecycle.state === 'superseded') {
        if (
          already
          && existing.manifest.lifecycle.supersededBy === next.manifestId
          && already.digest === capabilityManifestDigest(next)
        ) {
          return { ok: true, digest: already.digest };
        }
        return { ok: false, reason: 'identity_mismatch' };
      }
      const checked = currentCapabilityManifest(next);
      if (!checked) {
        const state = next?.lifecycle?.state;
        if (state === 'revoked') return { ok: false, reason: 'revoked' };
        if (state === 'superseded') return { ok: false, reason: 'superseded' };
        if (next?.provenance?.trusted !== true) return { ok: false, reason: 'untrusted_provenance' };
        return { ok: false, reason: 'incomplete' };
      }
      if (already && already.digest !== capabilityManifestDigest(checked)) {
        return { ok: false, reason: 'identity_mismatch' };
      }
      const successor = { digest: capabilityManifestDigest(checked), manifest: checked };
      const predecessor = {
        digest: capabilityManifestDigest({
          ...existing.manifest,
          lifecycle: { state: 'superseded' as const, supersededBy: next.manifestId },
        }),
        manifest: {
          ...existing.manifest,
          lifecycle: { state: 'superseded' as const, supersededBy: next.manifestId },
        },
      };
      if (options.durable) {
        const db = openEventLog();
        try {
          db.transaction(() => {
            const cas = db.prepare(
              `UPDATE capability_manifests
                  SET digest = ?, manifest_json = ?, lifecycle = ?
                WHERE manifest_id = ? AND digest = ? AND lifecycle = 'current'`,
            ).run(
              predecessor.digest,
              JSON.stringify(predecessor.manifest),
              'superseded',
              manifestId,
              existing.digest,
            );
            if (cas.changes !== 1) throw new Error('supersession_cas_conflict');
            if (already) writeManifestRow(db, successor, 'lifecycle');
            else writeManifestRow(db, successor, 'insert');
          })();
        } catch {
          return { ok: false, reason: 'identity_mismatch' };
        }
      }
      byId.set(next.manifestId, successor);
      byId.set(manifestId, predecessor);
      return { ok: true, digest: successor.digest };
    },
    get(manifestId) {
      const entry = byId.get(manifestId);
      if (!entry) return undefined;
      try {
        if (capabilityManifestDigest(entry.manifest) !== entry.digest) return undefined;
      } catch {
        return undefined;
      }
      return entry;
    },
    byDigest(digest) {
      return [...byId.values()].find((entry) => entry.digest === digest);
    },
    list() { return [...byId.values()]; },
    clear() { byId.clear(); },
  };
  for (const manifest of initial) store.install(manifest);
  return store;
}

export function installCapabilityManifestStore(store: CapabilityManifestStore | null): void {
  installed = store;
}

export function peekCapabilityManifestStore(): CapabilityManifestStore | null {
  return installed;
}

export function resolveCapabilityManifestStore(): CapabilityManifestStore {
  if (!installed) installed = createCapabilityManifestStore([], { durable: true });
  return installed;
}

export function resolveCurrentSuccessorManifest(
  store: CapabilityManifestStore,
  capabilityId: string,
): InstalledCapabilityManifest | undefined {
  const seen = new Set<string>();
  let currentId = capabilityId;
  while (!seen.has(currentId)) {
    seen.add(currentId);
    const entry = store.get(currentId);
    if (entry?.manifest.lifecycle.state === 'superseded' && entry.manifest.lifecycle.supersededBy) {
      currentId = entry.manifest.lifecycle.supersededBy;
      continue;
    }
    if (entry && currentCapabilityManifest(entry.manifest)) return entry;
    const prefixed = store.list().find((item) => (
      item.manifest.lifecycle.state === 'current'
      && Boolean(currentCapabilityManifest(item.manifest))
      && (
        item.manifest.manifestId.startsWith(`${capabilityId}:v`)
        || item.manifest.manifestId.startsWith(`${capabilityId}:`)
      )
    ));
    return prefixed;
  }
  return undefined;
}

export function successorManifestIdFor(templateId: string, version = 2): string {
  return `${templateId}:v${version}`;
}

export function provisionVersionedCapabilityManifest(
  store: CapabilityManifestStore,
  input: {
    predecessorId: string;
    next: CapabilityManifestV1;
  },
): { ok: true; digest: string } | { ok: false; reason: string } {
  if (input.next.manifestId === input.predecessorId) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  const predecessor = store.get(input.predecessorId);
  if (!predecessor) {
    const existing = store.get(input.next.manifestId);
    if (existing) {
      if (existing.digest === capabilityManifestDigest(input.next)) {
        return { ok: true, digest: existing.digest };
      }
      return { ok: false, reason: 'identity_mismatch' };
    }
    return store.install(input.next);
  }
  return store.supersede(input.predecessorId, input.next);
}

/** Restart repair for a named predecessor/successor pair. Official supersede
 *  is already one transaction; this only closes a simulated mid-write. */
export function repairInterruptedManifestSupersession(
  store: CapabilityManifestStore,
  input: { predecessorId: string; successorId: string },
): { currentIds: string[] } {
  const predecessor = store.get(input.predecessorId);
  const successor = store.get(input.successorId);
  if (
    predecessor
    && successor
    && predecessor.manifest.lifecycle.state === 'current'
    && successor.manifest.lifecycle.state === 'current'
    && input.predecessorId !== input.successorId
  ) {
    store.supersede(input.predecessorId, successor.manifest);
  }
  return {
    currentIds: store.list()
      .filter((entry) => entry.manifest.lifecycle.state === 'current')
      .map((entry) => entry.manifest.manifestId)
      .sort(),
  };
}
