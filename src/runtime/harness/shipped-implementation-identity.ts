/**
 * Host-owned implementation identity. Production executes digest-addressed
 * artifact bytes bound to a pinned process generation and a private
 * provenance map. Disk replacement cannot silently swap executing code.
 */
import { createRequire } from 'node:module';
import { createHash as shaCreateHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphNodeCapabilityInvoke, GraphNodeCapabilityReconcile } from './graph-node-capability.js';
import type { IndependentCapabilityObservation } from './independent-capability-observation.js';
import { isolatedTestContractActive } from './isolated-test-contract.js';
import type {
  AttestedTransport,
  AttestedTransportCall,
} from './implementation-artifacts/attested-transport.js';
import {
  forwardingHostLocalWriteCarrier,
  peekHostLocalWriteCarrier,
  type HostLocalWriteCarrier,
} from './implementation-artifacts/host-local-write-carrier.js';

export type ShippedImplementationKind = 'invoke' | 'reconcile' | 'observer' | 'transport' | 'transportIsolated';

export interface ShippedImplementationManifestV3 {
  version: 3;
  manifestDigest: string;
  artifacts: Record<ShippedImplementationKind, {
    file: string;
    sha256: string;
    inputs?: Record<string, { bytes: number }>;
  }>;
}

export interface ShippedFunctionProvenance {
  kind: 'invoke' | 'reconcile' | 'observer' | 'transport';
  artifactDigest: string;
  transportDigest: string;
  loadGeneration: string;
  artifactPath: string;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ARTIFACT_ROOT = path.join(MODULE_DIR, 'implementation-artifacts', 'emitted');
const requireFromHere = createRequire(import.meta.url);
const provenance = new WeakMap<object, ShippedFunctionProvenance>();

interface ShippedImplementations {
  invokeForSealedManifest: (manifest: unknown) => GraphNodeCapabilityInvoke;
  reconcileForSealedManifest: (manifest: unknown) => GraphNodeCapabilityReconcile;
  applyIndependentObserver: (
    live: Omit<IndependentCapabilityObservation, 'origin' | 'observationId' | 'observerImplementationId' | 'observedBytesDigest'>,
    expected: Pick<IndependentCapabilityObservation, 'operationId' | 'accountId' | 'definitionFingerprint' | 'providerVersion' | 'operationVersion'>,
    observerImplementationId: string,
  ) => IndependentCapabilityObservation | null;
  observeIndependently: (
    expected: Pick<IndependentCapabilityObservation, 'operationId' | 'accountId' | 'definitionFingerprint' | 'providerVersion' | 'operationVersion'>,
    observerImplementationId: string,
  ) => IndependentCapabilityObservation | null;
  bindIsolatedTransport: (handler: ((call: AttestedTransportCall) => Promise<unknown>) | null) => void;
  registerIsolatedObservation: (observation: {
    operationId: string;
    accountId: string;
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
    observedAt: number;
  }) => void;
  prepareComposioDispatch: (input: {
    operationId: string;
    accountId: string;
  }) => Promise<void>;
  refreshTransportObservation: (input: { operationId: string; accountId: string }) => Promise<{
    operationId: string;
    accountId: string;
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
    observedAt: number;
  } | null>;
  transportDigest: string;
  loadGeneration: string;
}

let artifactRootOverride: string | null = null;
let loaded: ShippedImplementations | null = null;
let pinnedGeneration: { manifestDigest: string; root: string } | null = null;

export function installImplementationArtifactRoot(root: string | null): void {
  if (pinnedGeneration) {
    throw new Error('implementation artifact generation is pinned for this process');
  }
  artifactRootOverride = root;
  loaded = null;
}

export function implementationArtifactRoot(): string {
  if (process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT) {
    return path.resolve(process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT);
  }
  if (artifactRootOverride) return artifactRootOverride;
  return SRC_ARTIFACT_ROOT;
}

export function implementationManifestPath(root = implementationArtifactRoot()): string {
  return path.join(root, 'manifest.json');
}

function sha256Bytes(bytes: Buffer | string): string {
  return shaCreateHash('sha256').update(bytes).digest('hex');
}

function manifestBodyDigest(manifest: Pick<ShippedImplementationManifestV3, 'version' | 'artifacts'>): string {
  return sha256Bytes(JSON.stringify({
    version: manifest.version,
    artifacts: Object.fromEntries(
      Object.entries(manifest.artifacts).map(([kind, entry]) => [kind, { file: entry.file, sha256: entry.sha256 }]),
    ),
  }));
}

export function emitShippedImplementationArtifacts(root = implementationArtifactRoot()): ShippedImplementationManifestV3 {
  if (pinnedGeneration && path.resolve(root) === pinnedGeneration.root) {
    throw new Error('implementation artifact generation is pinned for this process');
  }
  const script = path.resolve(MODULE_DIR, '../../../scripts/emit-implementation-artifacts.mjs');
  const result = spawnSync(process.execPath, [script, root], {
    encoding: 'utf8',
    cwd: path.resolve(MODULE_DIR, '../../..'),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'failed to emit implementation artifacts');
  }
  loaded = null;
  return JSON.parse(readFileSync(implementationManifestPath(root), 'utf8')) as ShippedImplementationManifestV3;
}

export function implementationArtifactPath(kind: ShippedImplementationKind, root = implementationArtifactRoot()): string {
  const verified = readManifest(root);
  if (!verified.ok) {
    throw new Error(verified.reason);
  }
  return path.join(root, verified.manifest.artifacts[kind].file);
}

export function implementationArtifactDigest(kind: ShippedImplementationKind, root = implementationArtifactRoot()): string {
  const artifactPath = implementationArtifactPath(kind, root);
  return sha256Bytes(readFileSync(artifactPath));
}

function readManifest(root: string): { ok: true; manifest: ShippedImplementationManifestV3 } | { ok: false; reason: string } {
  const manifestFile = implementationManifestPath(root);
  if (!existsSync(manifestFile)) {
    return { ok: false, reason: 'implementation manifest is missing' };
  }
  let manifest: ShippedImplementationManifestV3;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as ShippedImplementationManifestV3;
  } catch {
    return { ok: false, reason: 'implementation manifest is not reconstructable' };
  }
  if (manifest.version !== 3 || !manifest.artifacts || !/^[a-f0-9]{64}$/i.test(manifest.manifestDigest ?? '')) {
    return { ok: false, reason: 'implementation manifest is malformed' };
  }
  if (manifestBodyDigest(manifest) !== manifest.manifestDigest.toLowerCase()) {
    return { ok: false, reason: 'implementation manifest digest does not match the artifact set' };
  }
  return { ok: true, manifest };
}

interface BuildStamp {
  sourceFingerprint?: string;
  implementationManifestDigest?: string;
  artifacts?: Partial<Record<ShippedImplementationKind, string>>;
}

function parseBuildStamp(file: string): BuildStamp | null | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BuildStamp;
  } catch {
    return null;
  }
}

/**
 * Every stamp that describes this artifact root.
 *
 * The stamp emitted beside a set always describes that exact set. The ambient
 * build stamp only describes the default root, so consulting it for a
 * disposable root would judge one artifact set by another's identity — which is
 * a false failure, not a safety check. Where both apply, both must agree.
 *
 * An ambient stamp qualifies only when it sits BESIDE THE RUNNING MODULE. In a
 * packaged app that is the packaged stamp, and checking it is the whole point:
 * the code being executed and the artifacts it loads must come from one build.
 * A stamp reached by walking OUT of the running tree and into a sibling build
 * describes a different artifact set, and the rule above already says judging
 * one set by another's identity is a false failure. Running from source used to
 * reach `<repo>/dist/runtime/build-stamp.json` that way, so any developer tree
 * whose `dist` was older than its emitted artifacts failed identity everywhere —
 * and in the typed-execution modules it threw at import, taking whole files
 * down before a single test ran. Measured 2026-08-22: one stale ignored file
 * accounted for ~125 of 163 suite failures.
 */
export function readBuildStampsForTest(root: string, moduleDir: string): Array<BuildStamp | null> {
  return readBuildStamps(root, moduleDir);
}

export const SRC_ARTIFACT_ROOT_FOR_TEST = SRC_ARTIFACT_ROOT;

function readBuildStamps(root: string, moduleDir = MODULE_DIR): Array<BuildStamp | null> {
  const stamps: Array<BuildStamp | null> = [];
  const colocated = parseBuildStamp(path.join(root, 'build-stamp.json'));
  if (colocated !== undefined) stamps.push(colocated);
  if (path.resolve(root) === path.resolve(SRC_ARTIFACT_ROOT)) {
    for (const file of [
      path.join(moduleDir, '../build-stamp.json'),
      path.join(moduleDir, 'build-stamp.json'),
    ]) {
      const ambient = parseBuildStamp(file);
      if (ambient !== undefined) {
        stamps.push(ambient);
        break;
      }
    }
  }
  return stamps;
}

export function verifyShippedImplementationIdentity(
  root = implementationArtifactRoot(),
): { ok: true; digests: Record<ShippedImplementationKind, string>; manifestDigest: string } | { ok: false; reason: string } {
  const parsed = readManifest(root);
  if (!parsed.ok) return parsed;
  const { manifest } = parsed;
  if (pinnedGeneration && (pinnedGeneration.manifestDigest !== manifest.manifestDigest || pinnedGeneration.root !== path.resolve(root))) {
    return { ok: false, reason: 'implementation artifact generation changed; restart required' };
  }
  const stamps = readBuildStamps(root);
  for (const candidate of stamps) {
    if (candidate?.implementationManifestDigest
      && candidate.implementationManifestDigest !== manifest.manifestDigest) {
      return { ok: false, reason: 'implementation manifest does not match the build stamp' };
    }
  }
  const digests = {} as Record<ShippedImplementationKind, string>;
  for (const kind of ['invoke', 'reconcile', 'observer', 'transport', 'transportIsolated'] as const) {
    const expected = manifest.artifacts[kind];
    if (!expected || !expected.file.startsWith(`${kind}-`) || !expected.file.endsWith('.cjs') || !/^[a-f0-9]{64}$/i.test(expected.sha256)) {
      return { ok: false, reason: `implementation manifest ${kind} entry is malformed` };
    }
    if (!expected.file.includes(expected.sha256)) {
      return { ok: false, reason: `implementation manifest ${kind} file is not digest-addressed` };
    }
    const artifactPath = path.join(root, expected.file);
    if (!existsSync(artifactPath)) {
      return { ok: false, reason: `shipped ${kind} artifact is missing` };
    }
    const artifactDigest = sha256Bytes(readFileSync(artifactPath));
    if (artifactDigest !== expected.sha256.toLowerCase()) {
      return { ok: false, reason: `shipped ${kind} artifact does not match the implementation manifest` };
    }
    for (const candidate of stamps) {
      if (candidate?.artifacts?.[kind] && candidate.artifacts[kind] !== artifactDigest) {
        return { ok: false, reason: `shipped ${kind} artifact does not match the build stamp` };
      }
    }
    digests[kind] = artifactDigest;
  }
  if (new Set(Object.values(digests)).size !== 5) {
    return { ok: false, reason: 'implementation identities must be distinct' };
  }
  return { ok: true, digests, manifestDigest: manifest.manifestDigest };
}

export function shippedImplementationDigest(kind: ShippedImplementationKind): string {
  const verified = verifyShippedImplementationIdentity();
  if (!verified.ok) {
    throw new Error(verified.reason);
  }
  return verified.digests[kind];
}

export function shippedTransportDigest(): string {
  const verified = verifyShippedImplementationIdentity();
  if (!verified.ok) throw new Error(verified.reason);
  return isolatedTestContractActive() ? verified.digests.transportIsolated : verified.digests.transport;
}

export function shippedManifestDigest(): string {
  const verified = verifyShippedImplementationIdentity();
  if (!verified.ok) throw new Error(verified.reason);
  return verified.manifestDigest;
}

function requireArtifact<T>(kind: ShippedImplementationKind, digest: string, root: string): T {
  const filename = `${kind}-${digest}.cjs`;
  const artifactPath = path.join(root, filename);
  const bytes = readFileSync(artifactPath);
  if (sha256Bytes(bytes) !== digest) {
    throw new Error(`shipped ${kind} artifact bytes diverged from the content address`);
  }
  return requireFromHere(artifactPath) as T;
}

function recordProvenance<T extends object>(fn: T, record: ShippedFunctionProvenance): T {
  provenance.set(fn, record);
  return fn;
}

/**
 * Diagnostic view only. The caller receives a frozen copy, never the stored
 * record: a held reference must not be able to relabel a reconcile as an
 * invoke or swap the digest production registration checks.
 */
export function peekShippedProvenance(fn: unknown): Readonly<ShippedFunctionProvenance> | null {
  if (!fn || (typeof fn !== 'function' && typeof fn !== 'object')) return null;
  const record = provenance.get(fn);
  if (!record) return null;
  return Object.freeze({
    kind: record.kind,
    artifactDigest: record.artifactDigest,
    transportDigest: record.transportDigest,
    loadGeneration: record.loadGeneration,
    artifactPath: record.artifactPath,
  });
}

export function loadShippedImplementations(): ShippedImplementations {
  if (loaded) return loaded;
  const root = implementationArtifactRoot();
  const verified = verifyShippedImplementationIdentity(root);
  if (!verified.ok) {
    throw new Error(verified.reason);
  }
  pinnedGeneration = { manifestDigest: verified.manifestDigest, root: path.resolve(root) };
  const isolated = isolatedTestContractActive();
  const transportKind: ShippedImplementationKind = isolated ? 'transportIsolated' : 'transport';
  const transportDigest = verified.digests[transportKind];
  const transportModule = requireArtifact<{
    createAttestedTransport: (digest: string) => AttestedTransport;
    bindIsolatedTransportHandler?: (handler: ((call: AttestedTransportCall) => Promise<unknown>) | null) => void;
    prepareAttestedComposioDispatch?: (input: {
      operationId: string;
      accountId: string;
    }) => Promise<void>;
    registerIsolatedObservation?: (observation: {
      operationId: string;
      accountId: string;
      definitionFingerprint: string;
      providerVersion: string;
      operationVersion: string;
      observedAt: number;
    }) => void;
  }>(transportKind, transportDigest, root);
  const transport = transportModule.createAttestedTransport(transportDigest);
  const invoke = requireArtifact<{
    invokeForSealedManifest: ShippedImplementations['invokeForSealedManifest'];
    bindAttestedTransport: (transport: AttestedTransport) => void;
    bindHostLocalWriteCarrier?: (carrier: HostLocalWriteCarrier | null) => void;
  }>('invoke', verified.digests.invoke, root);
  const reconcile = requireArtifact<{
    reconcileForSealedManifest: ShippedImplementations['reconcileForSealedManifest'];
    bindAttestedTransport: (transport: AttestedTransport) => void;
    bindHostLocalWriteCarrier?: (carrier: HostLocalWriteCarrier | null) => void;
  }>('reconcile', verified.digests.reconcile, root);
  const observer = requireArtifact<{
    applyIndependentObserver: ShippedImplementations['applyIndependentObserver'];
    observeIndependently: ShippedImplementations['observeIndependently'];
    bindAttestedTransport: (transport: AttestedTransport) => void;
  }>('observer', verified.digests.observer, root);
  invoke.bindAttestedTransport(transport);
  reconcile.bindAttestedTransport(transport);
  observer.bindAttestedTransport(transport);
  if (typeof invoke.invokeForSealedManifest !== 'function'
    || typeof reconcile.reconcileForSealedManifest !== 'function'
    || typeof observer.applyIndependentObserver !== 'function'
    || typeof observer.observeIndependently !== 'function') {
    throw new Error('shipped implementation artifacts are not executable');
  }
  // Reviewed local writes whose storage the host owns reach it through this
  // seam, never through an import: the artifacts are separate module
  // instances, and a bundled copy of the host's storage graph would be a
  // second event-log/database instance. The forwarder resolves the host's
  // binding at call time, so the artifact always sees the current carrier.
  if (typeof invoke.bindHostLocalWriteCarrier !== 'function'
    || typeof reconcile.bindHostLocalWriteCarrier !== 'function') {
    throw new Error('shipped invoke/reconcile artifacts lack the host local-write carrier seam');
  }
  const hostLocalWriteCarrier = forwardingHostLocalWriteCarrier(peekHostLocalWriteCarrier);
  invoke.bindHostLocalWriteCarrier(hostLocalWriteCarrier);
  reconcile.bindHostLocalWriteCarrier(hostLocalWriteCarrier);
  const generation = verified.manifestDigest;
  const invokeFactory = invoke.invokeForSealedManifest;
  const reconcileFactory = reconcile.reconcileForSealedManifest;
  loaded = {
    invokeForSealedManifest: (manifest) => recordProvenance(invokeFactory(manifest), {
      kind: 'invoke',
      artifactDigest: verified.digests.invoke,
      transportDigest,
      loadGeneration: generation,
      artifactPath: path.join(root, `invoke-${verified.digests.invoke}.cjs`),
    }),
    reconcileForSealedManifest: (manifest) => recordProvenance(reconcileFactory(manifest), {
      kind: 'reconcile',
      artifactDigest: verified.digests.reconcile,
      transportDigest,
      loadGeneration: generation,
      artifactPath: path.join(root, `reconcile-${verified.digests.reconcile}.cjs`),
    }),
    applyIndependentObserver: observer.applyIndependentObserver,
    observeIndependently: observer.observeIndependently,
    bindIsolatedTransport: (handler) => {
      if (!isolatedTestContractActive()) {
        throw new Error('isolated transport bind is not production authority');
      }
      transportModule.bindIsolatedTransportHandler?.(handler);
    },
    registerIsolatedObservation: (observation) => {
      transportModule.registerIsolatedObservation?.(observation);
    },
    prepareComposioDispatch: async (input) => {
      if (typeof transportModule.prepareAttestedComposioDispatch !== 'function') {
        throw new Error('shipped transport lacks exact Composio dispatch preparation');
      }
      await transportModule.prepareAttestedComposioDispatch(input);
    },
    refreshTransportObservation: async (input) => (
      transport.refreshObservation ? transport.refreshObservation(input) : null
    ),
    transportDigest,
    loadGeneration: generation,
  };
  recordProvenance(observer.observeIndependently, {
    kind: 'observer',
    artifactDigest: verified.digests.observer,
    transportDigest,
    loadGeneration: generation,
    artifactPath: path.join(root, `observer-${verified.digests.observer}.cjs`),
  });
  recordProvenance(transport.execute, {
    kind: 'transport',
    artifactDigest: transportDigest,
    transportDigest,
    loadGeneration: generation,
    artifactPath: path.join(root, `${transportKind}-${transportDigest}.cjs`),
  });
  return loaded;
}

export function isShippedInvoke(fn: unknown): boolean {
  return peekShippedProvenance(fn)?.kind === 'invoke';
}

export function isShippedReconcile(fn: unknown): boolean {
  return peekShippedProvenance(fn)?.kind === 'reconcile';
}

export function isShippedObserver(fn: unknown): boolean {
  return peekShippedProvenance(fn)?.kind === 'observer';
}
