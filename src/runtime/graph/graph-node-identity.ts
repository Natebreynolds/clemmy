/**
 * Semantic execution identity (R1B/B1): what an admitted node IS, beyond its
 * structural id/kind/joinMode.
 *
 * Structural identity cannot carry production reuse: two nodes with the same
 * id and kind whose semantic configuration, runner contract, or authority
 * scope differ are different work. This module defines the canonical,
 * COMPILER-PRODUCED execution identity an admission may seal:
 *
 *   - per-node semantic definition/configuration digest and runner/adapter
 *     contract (name, version, implementation artifact digest);
 *   - tenant, workspace, and stable account/root scope;
 *   - authority, catalog/schema-universe, effect-ceiling, and capability
 *     binding-revision digests;
 *   - a finite budget version;
 *   - per-ROOT deterministic input/artifact manifest digests.
 *
 * Everything above EXCEPT the root input manifests folds into the identity
 * digest (and through it the admission digest): changing tenant, workspace,
 * account scope, authority, catalog, schema universe, effect ceiling, binding
 * revision, budget version, any node's semantic config, or any runner version
 * makes the old journal a DIFFERENT RUN that refuses wholesale. Root input
 * manifests deliberately bind at the INPUT-digest layer instead, so a changed
 * root input reruns exactly its dependency cone while unchanged roots reuse.
 *
 * Identity is data, never code: nothing here hashes JavaScript function text,
 * closures, prompt prose, or object insertion order (maps are canonicalized).
 * Identity must also exclude secrets — sealing refuses rotating `ca_...`
 * connection ids and credential-shaped keys outright.
 *
 * Pure: crypto digests and validation only.
 */
import { createHash } from 'node:crypto';

import { computeInputDigest, computeNodeDigest } from './graph-admission.js';
import type { GraphAdmission } from './graph-admission.js';
import type { ExecutableGraph, ExecutableNode, PredecessorRef } from './graph-executor.js';

export interface RunnerContract {
  /** Contract name of the runner/adapter this node dispatches through. */
  name: string;
  /** Contract version — bumping it is new work, never silent reuse. */
  version: string;
  /** Digest of the runner implementation artifact (build/bundle), so a
   *  changed implementation cannot masquerade as the same contract. */
  artifactDigest: string;
}

export interface NodeSemanticIdentity {
  /** Compiler-produced digest of the node's semantic definition/config. */
  semanticDigest: string;
  runner: RunnerContract;
  /**
   * The widest effect this node may perform. Replay policy depends on it:
   * only a `read` node may rerun to regenerate a missing artifact — a
   * missing artifact is never redispatch authority for an effectful node.
   */
  effectClass?: 'read' | 'write' | 'send';
  /**
   * ROOT nodes only: deterministic digest of the root's input/artifact
   * manifest. Sealed in the admission STRUCT but excluded from the identity
   * digest — it binds at the input-digest layer so a changed root input
   * reruns only its cone.
   */
  rootInputManifestDigest?: string;
}

export interface GraphExecutionIdentity {
  tenant: string;
  workspace: string;
  /** Digest over the stable logical account/root scope (never a rotating id). */
  accountScopeDigest: string;
  /** Immutable authority/policy decision digest for this run. */
  authorityDigest: string;
  /** Digest of the callable schema universe the run may see. */
  schemaUniverseDigest: string;
  effectCeiling: 'read' | 'write' | 'send';
  /** Digest of the exact capability binding revision the run starts from. */
  bindingRevisionDigest: string;
  /** Version of the finite budget contract the run is admitted under. */
  budgetVersion: string;
  /** Per-node semantic identity. Every admitted node must be covered. */
  nodes: Record<string, NodeSemanticIdentity>;
}

export interface AdmittedExecutionIdentity extends GraphExecutionIdentity {
  /** Digest over everything except per-root input manifests. */
  identityDigest: string;
}

export type IdentitySealResult =
  | { ok: true; identity: AdmittedExecutionIdentity }
  | { ok: false; errors: string[] };

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Canonical JSON: sorted keys, no undefined — construction order is not identity. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** Credential-shaped content that must never become identity. */
const ROTATING_ID = /(^|[^a-z0-9])ca_[a-z0-9]{4,}/i;
const CREDENTIAL_KEY = /(token|secret|password|api[-_]?key|authorization|bearer)/i;

function scanForSecrets(identity: GraphExecutionIdentity, errors: string[]): void {
  const serialized = stableJson(identity);
  if (ROTATING_ID.test(serialized)) {
    errors.push('identity contains a rotating "ca_..." connection id — bind the stable account scope, never the rotating connection');
  }
  const scanKeys = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(key)) {
        errors.push(`identity contains credential-shaped key "${key}" — secrets are never identity`);
      }
      scanKeys(inner);
    }
  };
  scanKeys(identity);
}

/**
 * Seal a compiler-produced execution identity for a specific graph. Refuses
 * incomplete coverage (a node the identity does not describe is unknown, and
 * unknown means unknown — not structural fallback), empty fields, and
 * secret-shaped content.
 */
export function sealExecutionIdentity(
  graph: ExecutableGraph,
  identity: GraphExecutionIdentity,
): IdentitySealResult {
  const errors: string[] = [];
  for (const [field, value] of Object.entries({
    tenant: identity.tenant,
    workspace: identity.workspace,
    accountScopeDigest: identity.accountScopeDigest,
    authorityDigest: identity.authorityDigest,
    schemaUniverseDigest: identity.schemaUniverseDigest,
    bindingRevisionDigest: identity.bindingRevisionDigest,
    budgetVersion: identity.budgetVersion,
  })) {
    if (!String(value ?? '').trim()) errors.push(`identity.${field} is required — unknown means unknown, not unlimited`);
  }
  if (!['read', 'write', 'send'].includes(identity.effectCeiling)) {
    errors.push(`identity.effectCeiling "${String(identity.effectCeiling)}" is not a known effect class`);
  }
  for (const node of graph.nodes) {
    const semantic = identity.nodes[node.id];
    if (!semantic) {
      errors.push(`node "${node.id}" has no semantic identity — an undescribed node cannot be admitted`);
      continue;
    }
    if (!semantic.semanticDigest.trim()) errors.push(`node "${node.id}" has an empty semantic digest`);
    if (!semantic.runner.name.trim() || !semantic.runner.version.trim() || !semantic.runner.artifactDigest.trim()) {
      errors.push(`node "${node.id}" has an incomplete runner contract — name, version, and artifact digest are all identity`);
    }
    const structuralIncoming = graph.edges.some((edge) => edge.target === node.id);
    if (semantic.rootInputManifestDigest !== undefined && structuralIncoming) {
      errors.push(`node "${node.id}" declares a root input manifest but has incoming edges — root manifests belong to roots`);
    }
  }
  for (const nodeId of Object.keys(identity.nodes)) {
    if (!graph.nodes.some((node) => node.id === nodeId)) {
      errors.push(`identity describes "${nodeId}", which the graph does not contain`);
    }
  }
  scanForSecrets(identity, errors);
  if (errors.length > 0) return { ok: false, errors };

  // The digest excludes per-root input manifests deliberately (see header).
  const digestNodes = Object.fromEntries(
    Object.entries(identity.nodes).map(([nodeId, semantic]) => [nodeId, {
      semanticDigest: semantic.semanticDigest,
      runner: { ...semantic.runner },
      effectClass: semantic.effectClass ?? null,
    }]),
  );
  const identityDigest = sha256(stableJson({
    tenant: identity.tenant,
    workspace: identity.workspace,
    accountScopeDigest: identity.accountScopeDigest,
    authorityDigest: identity.authorityDigest,
    schemaUniverseDigest: identity.schemaUniverseDigest,
    effectCeiling: identity.effectCeiling,
    bindingRevisionDigest: identity.bindingRevisionDigest,
    budgetVersion: identity.budgetVersion,
    nodes: digestNodes,
  }));
  // Deep-copy THEN deep-freeze: no caller-owned nested reference survives
  // sealing, so a later caller-side mutation can neither drift digests nor
  // mutate the admission's view (F6).
  const frozenNodes: Record<string, NodeSemanticIdentity> = {};
  for (const [nodeId, semantic] of Object.entries(identity.nodes)) {
    frozenNodes[nodeId] = Object.freeze({
      ...semantic,
      runner: Object.freeze({ ...semantic.runner }),
    });
  }
  return {
    ok: true,
    identity: Object.freeze({
      ...identity,
      nodes: Object.freeze(frozenNodes),
      identityDigest,
    }),
  };
}

/** Semantic digest for a PATCH-added node whose identity travels with the
 *  patch (production mode). Same shape as nodeDigestFor's semantic branch. */
export function semanticNodeDigest(node: ExecutableNode, semantic: NodeSemanticIdentity): string {
  return sha256(stableJson({
    structural: computeNodeDigest(node),
    semantic: semantic.semanticDigest,
    runner: semantic.runner,
  }));
}

/**
 * The node digest an admitted run journals and replays. Under a semantic
 * admission it binds structure AND semantics AND the runner contract; a
 * pure-structural admission (or the pure walker) uses structural identity
 * alone. A patch-added node has no pre-admitted semantic row and uses
 * structural identity — its authority flows through the emitter attempt and
 * the patch admitter, and widening that is R2+ work, recorded, not implied.
 */
export function nodeDigestFor(admission: GraphAdmission | undefined, node: ExecutableNode): string {
  const semantic = admission?.identity?.nodes[node.id];
  if (!semantic) return computeNodeDigest(node);
  return sha256(stableJson({
    structural: computeNodeDigest(node),
    semantic: semantic.semanticDigest,
    runner: semantic.runner,
  }));
}

/**
 * The input digest an admitted run journals and compares at readiness. A
 * non-root's inputs are its fired predecessors' artifacts. A ROOT's inputs
 * are its admitted input manifest — so a changed root manifest is a changed
 * input digest, and exactly that root's dependency cone reruns.
 */
export function inputDigestFor(
  admission: GraphAdmission | undefined,
  nodeId: string,
  predecessors: readonly PredecessorRef[],
): string {
  if (predecessors.length > 0) return computeInputDigest(predecessors);
  const manifest = admission?.identity?.nodes[nodeId]?.rootInputManifestDigest;
  if (manifest === undefined) return computeInputDigest([]);
  return sha256(stableJson({ rootInputManifest: manifest }));
}
