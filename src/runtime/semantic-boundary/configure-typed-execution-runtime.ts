/**
 * One shared typed-execution initialization boundary.
 *
 * Daemon, chat, webhook, Discord, Slack, CLI, and resume all reach this
 * through configureHarnessRuntime. The semantic port and capability factory
 * are not daemon-only. The function is idempotent: every call recomputes
 * the same refusal/readiness state from the installed store and observers.
 */
import { installHostCompiledGroundingVerifier } from '../harness/physical-dispatch-grounding.js';
import { verifyHostCompiledRecord } from './host-deterministic-compile.js';
import { listEvents } from '../harness/eventlog.js';
import { installConfiguredBrainSemanticPort } from './configured-brain-semantic-port.js';
import { peekTurnSemanticModelPort } from './turn-semantic-port-registry.js';
import {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} from '../harness/host-capability-catalog-factory.js';
import {
  createCapabilityManifestStore,
  installCapabilityManifestStore,
  peekCapabilityManifestStore,
} from '../harness/capability-manifest-store.js';
import { currentCapabilityManifest } from '../harness/capability-manifest.js';
import {
  installProductionCatalogAdapter,
  peekProductionCapabilityAdapter,
} from '../harness/production-capability-adapter.js';
import {
  installProductionCapabilityCatalog,
  isPlaceholderBetaAccount,
  reconstructShippedPortsForDurableSuccessors,
} from '../harness/production-capability-catalog.js';
import {
  independentlyObserveCapability,
  observationIsFresh,
} from '../harness/independent-capability-observation.js';
import {
  peekProductionCapabilityPort,
  productionPortIdentityFromManifest,
} from '../harness/production-capability-ports.js';
import {
  installIsolatedVerticalFixtures,
  isolatedVerticalEnabled,
} from './isolated-vertical.js';
import { bindComposioAttestedTransportOnce } from '../harness/composio-attested-transport.js';

const BLOCKING_REFUSALS = new Set([
  'identity_mismatch',
  'placeholder_account',
  'port_missing',
  'observation_unavailable',
  'observation_mismatch',
  'production_catalog_disabled',
  'empty_catalog',
]);

let configured = false;
let catalogReady = false;
let lastCatalogRefusals: Array<{ manifestId: string; reason: string }> = [];

function relevantRefusals(
  refusals: readonly { manifestId: string; reason: string }[],
): Array<{ manifestId: string; reason: string }> {
  return refusals
    .filter((entry) => BLOCKING_REFUSALS.has(entry.reason))
    .sort((a, b) => `${a.manifestId}:${a.reason}`.localeCompare(`${b.manifestId}:${b.reason}`));
}

/**
 * `scope`, when given, is the exact set of manifestIds a call actually needs.
 * Omitting it means "every current manifest the store has ever held" — right
 * for the true global sweeps (boot, explicit reset) but wrong for a call that
 * only just touched one or two capabilities: a daemon accumulates manifests
 * across its whole lifetime, so an unscoped required-set eventually always
 * contains something whose independent observation has aged past
 * INDEPENDENT_OBSERVATION_FRESHNESS_MS, and unrelated staleness must never
 * gate (or evict) a capability nobody asked about this call.
 */
function requiredCurrentManifests(scope?: ReadonlySet<string>) {
  const store = peekCapabilityManifestStore();
  if (!store) return [];
  return store.list().filter((entry) => {
    if (scope && !scope.has(entry.manifest.manifestId)) return false;
    const current = currentCapabilityManifest(entry.manifest);
    if (!current) return false;
    if (isPlaceholderBetaAccount(current.accountId)) return false;
    return true;
  });
}

function observationMatchesRequired(manifest: ReturnType<typeof currentCapabilityManifest>): boolean {
  if (!manifest) return false;
  const observed = independentlyObserveCapability(manifest.operationId, manifest.accountId);
  return Boolean(
    observed
    && observed.origin === 'independent'
    && observationIsFresh(observed)
    && observed.definitionFingerprint === manifest.definitionFingerprint
    && observed.providerVersion === manifest.providerVersion
    && observed.operationVersion === manifest.operationVersion
    && observed.accountId === manifest.accountId,
  );
}

function exactPortsPresent(manifest: NonNullable<ReturnType<typeof currentCapabilityManifest>>): boolean {
  const port = peekProductionCapabilityPort(productionPortIdentityFromManifest(manifest));
  if (!port?.invoke) return false;
  if (port.implementationDigest === 'fixture') return false;
  const write = manifest.effect === 'external_write' || manifest.effect === 'local_write';
  if (write && manifest.reconciliation.supported && !port.reconcile) return false;
  return true;
}

function quarantineUnmanifestedAndStale(): void {
  const factory = peekHostCapabilityCatalogFactory();
  const store = peekCapabilityManifestStore();
  if (!factory) return;
  for (const entry of factory.snapshot()) {
    const stored = store?.get(entry.capabilityId);
    const current = stored ? currentCapabilityManifest(stored.manifest) : null;
    if (!current || isPlaceholderBetaAccount(current.accountId)) {
      factory.forget(entry.capabilityId);
    }
  }
}

interface CatalogReadinessVerdict {
  ready: boolean;
  refusals: Array<{ manifestId: string; reason: string }>;
  /** Entries the caller should drop; returning them keeps evaluation pure. */
  forget: string[];
}

/**
 * THE readiness predicate. Both the refreshing writer and the live accessor
 * decide here, so they cannot disagree.
 *
 * They used to be two separate computations: the accessor never saw the
 * install/adapter refusals, so it could report ready while the catalog held
 * blocking refusals. `carried` is how those side-effect refusals reach the one
 * decision. Evaluation performs no mutation; the caller applies `forget`.
 *
 * `scope` narrows "required" to the manifestIds one call actually needs (see
 * requiredCurrentManifests). Live 2026-08-26: a foreground plan_task turn
 * that freshly registered and selected one Google Sheets write still refused
 * "no longer matches the frozen host catalog" with an EMPTY frozen snapshot,
 * because the unscoped evaluation swept in ~38 unrelated composio manifests
 * this same long-running daemon had accumulated from earlier sessions and
 * forgot whichever of them had gone stale — collateral damage this call never
 * asked for. Unscoped evaluation stays available for the true global sweeps.
 */
function evaluateCatalogReadiness(
  carried: readonly { manifestId: string; reason: string }[] = [],
  scope?: ReadonlySet<string>,
): CatalogReadinessVerdict {
  if (process.env.CLEMENTINE_PRODUCTION_CATALOG === '0') {
    return {
      ready: false,
      refusals: [{ manifestId: '*', reason: 'production_catalog_disabled' }],
      forget: [],
    };
  }
  const refusals = [...carried];
  const forget: string[] = [];
  const required = requiredCurrentManifests(scope);
  if (required.length === 0) {
    refusals.push({ manifestId: '*', reason: 'empty_catalog' });
  } else {
    for (const entry of required) {
      const manifest = currentCapabilityManifest(entry.manifest);
      if (!manifest) {
        refusals.push({ manifestId: entry.manifest.manifestId, reason: 'identity_mismatch' });
        forget.push(entry.manifest.manifestId);
        continue;
      }
      if (isPlaceholderBetaAccount(manifest.accountId)) {
        refusals.push({ manifestId: manifest.manifestId, reason: 'placeholder_account' });
        forget.push(manifest.manifestId);
        continue;
      }
      if (!observationMatchesRequired(manifest)) {
        const observed = independentlyObserveCapability(manifest.operationId, manifest.accountId);
        refusals.push({
          manifestId: manifest.manifestId,
          reason: !observed || observed.origin !== 'independent'
            ? 'observation_unavailable'
            : 'observation_mismatch',
        });
        forget.push(manifest.manifestId);
        continue;
      }
      if (!exactPortsPresent(manifest)) {
        refusals.push({ manifestId: manifest.manifestId, reason: 'port_missing' });
        forget.push(manifest.manifestId);
      }
    }
  }
  const blocking = relevantRefusals(refusals);
  // Ready requires real membership AND zero blocking refusals, so
  // ready-with-an-empty-catalog and ready-with-refusals are both unreachable.
  return { ready: required.length > 0 && blocking.length === 0, refusals: blocking, forget };
}

/** Refusals produced by installing/refreshing, carried into every later verdict. */
let lastInstallRefusals: Array<{ manifestId: string; reason: string }> = [];

/** Only the eviction side-effect; never touches the global refusal/ready cache. */
function applyForget(verdict: CatalogReadinessVerdict): void {
  const factory = peekHostCapabilityCatalogFactory();
  for (const manifestId of verdict.forget) factory?.forget(manifestId);
}

function applyVerdict(verdict: CatalogReadinessVerdict): void {
  applyForget(verdict);
  lastCatalogRefusals = verdict.refusals;
  catalogReady = verdict.ready;
}

/**
 * Reinstall/refresh from durable state, then evict whatever the readiness
 * verdict says must go.
 *
 * `requiredManifestIds`, when given, scopes BOTH the verdict and the forget
 * to exactly those manifests — the ones a specific call just registered or is
 * about to dispatch. A scoped refresh never touches, never evicts, and never
 * overwrites the global refusal/ready cache for anything outside that set:
 * registering one capability must not mutate the live availability of an
 * unrelated one. Call with no argument for the true global sweep (daemon
 * boot, explicit reset), which still walks every current manifest in the
 * store and still updates the shared cache exactly as before.
 */
export function refreshTypedExecutionReadiness(requiredManifestIds?: readonly string[]): void {
  const scope = requiredManifestIds?.length ? new Set(requiredManifestIds) : undefined;
  if (!scope) {
    lastCatalogRefusals = [];
    catalogReady = false;
  }
  lastInstallRefusals = [];
  if (process.env.CLEMENTINE_PRODUCTION_CATALOG === '0') {
    lastCatalogRefusals = [{ manifestId: '*', reason: 'production_catalog_disabled' }];
    peekHostCapabilityCatalogFactory()?.clear();
    return;
  }
  const installed = installProductionCapabilityCatalog();
  const adapter = peekProductionCapabilityAdapter() ?? installProductionCatalogAdapter();
  // adapter.refresh() runs its OWN independent per-manifest observation check
  // and its OWN factory.forget on failure (production-capability-adapter.ts);
  // it must see the same scope evaluateCatalogReadiness uses below, or a
  // scoped call here still collaterally forgets unrelated stale manifests
  // through this second, separate mechanism.
  lastInstallRefusals = [...installed.refused, ...adapter.refresh(scope).refused];
  reconstructShippedPortsForDurableSuccessors();
  // Quarantine is existence-based (does a current, non-placeholder manifest
  // still back this factory entry at all?), never freshness-based, so running
  // it unscoped cannot collaterally evict a merely-stale, still-current entry.
  quarantineUnmanifestedAndStale();
  const verdict = evaluateCatalogReadiness(lastInstallRefusals, scope);
  if (scope) {
    applyForget(verdict);
  } else {
    applyVerdict(verdict);
  }
}

function recomputeReadiness(): void {
  refreshTypedExecutionReadiness();
}

export function configureTypedExecutionRuntime(): void {
  // The provider transport is part of the typed runtime: without one bound,
  // proof-provisioned capabilities never register and every admitted act
  // construct compiles unbound. Tests that bind their own transport first
  // (bindAttestedTransport / installProductionTransport) are left untouched.
  try { bindComposioAttestedTransportOnce(); } catch { /* readiness stays refusal-driven */ }
  if (!peekTurnSemanticModelPort()) {
    installConfiguredBrainSemanticPort();
  }
  if (!peekHostCapabilityCatalogFactory()) {
    installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
  }
  if (!peekCapabilityManifestStore()) {
    installCapabilityManifestStore(createCapabilityManifestStore([], { durable: true }));
  }
  if (!peekProductionCapabilityAdapter()) {
    installProductionCatalogAdapter();
  }
  if (isolatedVerticalEnabled()) {
    installIsolatedVerticalFixtures();
  }
  // Host deterministic-compile authority is accepted ONLY via recompute:
  // the verifier rebuilds the plan from durable inputs the model cannot
  // write and demands byte-identical digests. Installing it here (not at
  // module load) keeps the guard's default REFUSAL for any process that
  // never configured the typed runtime.
  installHostCompiledGroundingVerifier((input) => verifyHostCompiledRecord({
    record: input.record,
    identity: input.identity,
    loadAcceptedText: (identity) => {
      const accepted = listEvents(identity.sessionId, {
        sinceSeq: identity.sourceUserSeq - 1,
        types: ['user_input_received'],
        limit: 1,
      }).find((event) => event.seq === identity.sourceUserSeq);
      const displayText = typeof accepted?.data.displayText === 'string' ? accepted.data.displayText.trim() : '';
      const eventText = typeof accepted?.data.text === 'string' ? accepted.data.text.trim() : '';
      return displayText || eventText || null;
    },
  }));
  recomputeReadiness();
  configured = true;
}

export function typedExecutionRuntimeConfigured(): boolean {
  return Boolean(
    configured
    && peekTurnSemanticModelPort()
    && peekHostCapabilityCatalogFactory()
    && peekCapabilityManifestStore()
    && peekProductionCapabilityAdapter()
  );
}

/**
 * `requiredManifestIds`, when given, answers readiness for exactly the
 * operations one call needs (e.g. the single manifest a physical dispatch is
 * about to cross) instead of every manifest the process has ever seen — a
 * long-running daemon can accumulate dozens of composio operations across
 * unrelated sessions, and requiring every one of them fresh would mean the
 * catalog can in practice never be globally ready again. A scoped read never
 * updates the shared refusal/ready cache (that cache describes the last
 * unscoped/global picture); an unscoped call keeps its original meaning.
 */
export function typedExecutionCatalogReady(requiredManifestIds?: readonly string[]): boolean {
  if (!configured) return false;
  const scope = requiredManifestIds?.length ? new Set(requiredManifestIds) : undefined;
  // Same predicate as the refresh writer, carrying the same install/adapter
  // refusals, so readiness and refusals can never contradict each other.
  // Reading records the verdict but does not evict: dropping catalog entries is
  // the refreshing writer's job, not a side effect of asking a question.
  const verdict = evaluateCatalogReadiness(lastInstallRefusals, scope);
  if (!scope) {
    lastCatalogRefusals = verdict.refusals;
    catalogReady = verdict.ready;
  }
  return verdict.ready;
}

export function typedExecutionCatalogRefusals(): readonly { manifestId: string; reason: string }[] {
  return lastCatalogRefusals;
}

export function isProductionPackCapabilityId(capabilityId: string): boolean {
  return capabilityId.startsWith('cap:host_');
}
