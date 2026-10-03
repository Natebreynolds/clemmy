import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { browserbaseStoreFile } from './browserbase-setup.js';
import { readSecret, writeSecret } from '../runtime/secrets/index.js';
import { BrowserbaseApiClient, BrowserbaseClientError, type BrowserbaseSession } from './browserbase-client.js';
import { BrowserbaseCdpClient, BrowserbaseCdpError, parseBrowserbaseOperation, type BrowserbaseOperation, type BrowserbasePage, type BrowserbaseCdpResult } from './browserbase-cdp.js';

export interface BrowserbaseResource {
  id: string; conversationId: string; provider: 'browserbase'; providerSessionId: string | null; projectId: string;
  state: 'starting' | 'active' | 'stopped' | 'expired' | 'uncertain'; controller: 'agent' | 'human'; controlVersion: number;
  createdAt: string; updatedAt: string; recording: boolean; elapsedSeconds: number; pages: BrowserbasePage[]; errorCode?: string;
  returnPending?: boolean;
}
export interface BrowserbaseOperationReceipt {
  version: 1; kind: 'browserbase_dispatch_receipt'; resourceId: string; provider: 'browserbase'; providerSessionId: string;
  projectId: string; operation: string; targetId: string | null; controlVersion: number; effect: 'none' | 'confirmed'; at: string;
}
export interface BrowserbaseOperationResponse { resource: BrowserbaseResource; result: Record<string, unknown>; receipt: BrowserbaseOperationReceipt; }
/** Nominal error identity, never a provider/caller JSON assertion of no effect. */
export class BrowserbaseServiceError extends Error {
  constructor(public readonly code: string, public readonly effect: 'none' | 'uncertain' = 'none') { super(code); this.name = 'BrowserbaseServiceError'; }
}
const ERROR_TEXT: Record<string, string> = {
  credential_rejected: "Browserbase didn't accept the saved API key, so no browser was started. Copy the API key from Browserbase (Settings → API Keys) and save it again in Clem's Browserbase connection.",
  project_not_found: "Browserbase couldn't find that project for this API key. Check the project ID in Clem's Browserbase connection.",
  provider_limit: 'Browserbase refused because of a plan or concurrency limit, so no browser was started. Check the Browserbase account, or close another browser, then try again.',
  credential_missing: "No Browserbase API key is saved. Add it in Clem's Browserbase connection.",
  configuration_missing: "Browserbase isn't set up. Add the project and API key in Clem's Browserbase connection.",
  provider_refused: 'Browserbase refused the request, so nothing was started.',
};
/** What the owner and the model read for a refusal that changed nothing. */
export function browserbaseErrorText(code: string): string {
  return ERROR_TEXT[code] ?? `The cloud browser could not do that (${code}). Nothing was changed.`;
}
interface Policy { projectId: string; idleSeconds: number; sessionTimeoutSeconds: number; }
interface PendingOperation { id: string; operation: string; targetId: string | null; controlVersion: number; startedAt: number; }
interface PrivateResource extends Omit<BrowserbaseResource, 'elapsedSeconds'> {
  requestKey: string; credentialIdentity: string; lastActivityAt: number; expiresAt: number; pending?: PendingOperation;
  lastEffect?: { operation: string; effect: 'confirmed' | 'uncertain'; targetId: string | null; at: number };
  viewerLeases?: Array<{ id: string; targetId: string | null; controlVersion: number; expiresAt: number; mode: 'human' | 'watch'; detached: boolean }>;
  ownerResolution?: { kind: 'owner_adopted_session'; providerSessionId: string; at: number; originalCreateProof: 'unknown' };
}
interface Store { version: 1; revision: number; policy: Policy | null; resources: PrivateResource[]; }
interface Api {
  create: BrowserbaseApiClient['create']; retrieve: BrowserbaseApiClient['retrieve']; release: BrowserbaseApiClient['release']; liveView: BrowserbaseApiClient['liveView'];
  verifyProject?: BrowserbaseApiClient['verifyProject'];
}
interface Cdp { execute: BrowserbaseCdpClient['execute']; humanText: BrowserbaseCdpClient['humanText']; }
export interface BrowserbaseDependencies {
  baseDir?: string; now?: () => number; uuid?: () => string; getApiKey?: () => Promise<string | undefined>; setApiKey?: (value: string) => Promise<void>;
  api?: Api; cdp?: Cdp; autoMaintenance?: boolean;
  credentialTimeoutMs?: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nonterminal = (value: PrivateResource) => value.state !== 'stopped' && value.state !== 'expired';
// A record with no provider session has nothing a credential change could strand.
const holdsProviderSession = (value: PrivateResource) => nonterminal(value) && value.providerSessionId !== null;

/** One owner task, one provider session. Durable reservations prevent unknown
 * create outcomes from silently producing a second paid browser. Pages are
 * bounded display metadata; no transcript, CDP URL, viewer URL or key is saved. */
export class BrowserbaseService {
  private readonly directory: string;
  private readonly file: string;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly getKey: () => Promise<string | undefined>;
  private readonly setKey: (value: string) => Promise<void>;
  private readonly cdp: Cdp;
  private store: Store;
  private readonly queues = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private storeUnavailable = false;
  private keyRead?: Promise<string | undefined>;
  private readonly credentialTimeoutMs: number;
  constructor(private readonly dependencies: BrowserbaseDependencies = {}) {
    this.file = browserbaseStoreFile(dependencies.baseDir ?? BASE_DIR); this.directory = path.dirname(this.file);
    this.now = dependencies.now ?? Date.now; this.uuid = dependencies.uuid ?? randomUUID;
    this.getKey = dependencies.getApiKey ?? (() => readSecret('browserbase_api_key'));
    this.setKey = dependencies.setApiKey ?? (value => writeSecret('browserbase_api_key', value));
    this.credentialTimeoutMs = dependencies.credentialTimeoutMs ?? 5000;
    if (!Number.isInteger(this.credentialTimeoutMs) || this.credentialTimeoutMs < 1 || this.credentialTimeoutMs > 15000) throw new BrowserbaseServiceError('invalid_credential_deadline');
    this.cdp = dependencies.cdp ?? new BrowserbaseCdpClient();
    this.store = this.load();
    let recovered = false;
    for (const resource of this.store.resources.filter(nonterminal)) {
      resource.controlVersion++; resource.updatedAt = this.iso();
      if (resource.pending || !resource.providerSessionId) { resource.state = 'uncertain'; resource.errorCode = resource.pending?.operation === 'stop' ? 'release_pending' : 'interrupted_operation'; }
      if (resource.controller === 'agent' && resource.viewerLeases?.some(lease => lease.mode === 'human' && !lease.detached)) { resource.controller = 'human'; resource.returnPending = true; }
      recovered = true;
    }
    if (recovered) this.persist();
    if (dependencies.autoMaintenance !== false) { this.timer = setInterval(() => { void this.maintenance().catch(() => {}); }, 30000); this.timer.unref(); }
  }
  dispose(): void { if (this.timer) clearInterval(this.timer); }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private load(): Store {
    if (!existsSync(this.file)) return { version: 1, revision: 0, policy: null, resources: [] };
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Store;
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.resources)
        || (value.policy !== null && (!value.policy || !UUID.test(value.policy.projectId) || !Number.isInteger(value.policy.idleSeconds)
          || !Number.isInteger(value.policy.sessionTimeoutSeconds) || value.policy.idleSeconds < 60 || value.policy.sessionTimeoutSeconds > 21600 || value.policy.idleSeconds > value.policy.sessionTimeoutSeconds))
        || value.resources.some(resource => !resource || !UUID.test(resource.id) || typeof resource.conversationId !== 'string' || resource.provider !== 'browserbase'
          || !UUID.test(resource.projectId) || (resource.providerSessionId !== null && !UUID.test(resource.providerSessionId))
          || !Number.isSafeInteger(resource.controlVersion) || resource.controlVersion < 1 || !/^[a-f0-9]{64}$/.test(resource.requestKey)
          || !/^[a-f0-9]{64}$/.test(resource.credentialIdentity) || !['starting','active','stopped','expired','uncertain'].includes(resource.state)
          || !['agent','human'].includes(resource.controller) || !Number.isFinite(resource.lastActivityAt) || !Number.isFinite(resource.expiresAt)
          || typeof resource.recording !== 'boolean' || !Number.isFinite(Date.parse(resource.createdAt)) || !Number.isFinite(Date.parse(resource.updatedAt))
          || (resource.pages !== undefined && (!Array.isArray(resource.pages) || resource.pages.length > 100 || resource.pages.some(page => typeof page.targetId !== 'string' || !page.targetId || page.targetId.length > 128 || typeof page.title !== 'string' || page.title.length > 1000 || typeof page.url !== 'string' || page.url.length > 2000)))
          || (resource.returnPending !== undefined && typeof resource.returnPending !== 'boolean')
          || (resource.viewerLeases !== undefined && (!Array.isArray(resource.viewerLeases) || resource.viewerLeases.some(lease => !UUID.test(lease.id) || !Number.isSafeInteger(lease.controlVersion) || lease.controlVersion < 1 || !Number.isFinite(lease.expiresAt) || !['watch','human'].includes(lease.mode) || typeof lease.detached !== 'boolean' || (lease.targetId !== null && (typeof lease.targetId !== 'string' || !lease.targetId || lease.targetId.length > 128))))))) throw new Error();
      return value;
    } catch { throw new BrowserbaseServiceError('resource_store_invalid'); }
  }
  private persist(effect: 'none' | 'uncertain' = 'none'): void {
    if (this.storeUnavailable) throw new BrowserbaseServiceError('resource_store_unavailable', effect);
    // SQLite's OS-owned writer lock releases on process death. A mkdir lock
    // would strand cleanup after a crash, and stealing it by age/PID can race
    // a new writer. This tiny private lock DB contains no resource or secret.
    let lock: Database.Database | undefined, temp: string | undefined;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
      const lockPath = path.join(this.directory, 'writer-lock.sqlite');
      lock = new Database(lockPath, { timeout: 1000 }); chmodSync(lockPath, 0o600); lock.exec('BEGIN IMMEDIATE');
      const disk = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as Store : { revision: 0 };
      if (disk.revision !== this.store.revision) throw new BrowserbaseServiceError('resource_store_conflict');
      const next = { ...this.store, revision: this.store.revision + 1 };
      temp = path.join(this.directory, `.resources-${this.uuid()}.tmp`);
      writeFileSync(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file); temp = undefined; this.store.revision = next.revision;
      try { const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* Some platforms cannot fsync directories. */ }
      lock.exec('COMMIT');
    } catch (error) { this.storeUnavailable = true; throw new BrowserbaseServiceError(error instanceof BrowserbaseServiceError ? error.code : 'resource_store_unavailable', effect); }
    finally { if (temp) { try { unlinkSync(temp); } catch {} } if (lock) { try { lock.close(); } catch {} } }
  }
  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => { if (this.storeUnavailable) throw new BrowserbaseServiceError('resource_store_unavailable'); return work(); }); this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  private resource(id: string, conversationId: string): PrivateResource {
    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200) throw new BrowserbaseServiceError('invalid_conversation');
    const resource = this.store.resources.find(value => value.id === id && value.conversationId === conversationId);
    if (!resource) throw new BrowserbaseServiceError('resource_not_found'); return resource;
  }
  private version(resource: PrivateResource, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected !== resource.controlVersion) throw new BrowserbaseServiceError('control_version_changed');
  }
  private public(resource: PrivateResource): BrowserbaseResource {
    // Deliberate projection: private reservation/account identity never rides in a tool receipt.
    return { id: resource.id, conversationId: resource.conversationId, provider: 'browserbase', providerSessionId: resource.providerSessionId,
      projectId: resource.projectId, state: resource.state, controller: resource.controller, controlVersion: resource.controlVersion,
      createdAt: resource.createdAt, updatedAt: resource.updatedAt, recording: resource.recording,
      elapsedSeconds: Math.max(0, Math.floor(((nonterminal(resource) ? this.now() : Date.parse(resource.updatedAt)) - Date.parse(resource.createdAt)) / 1000)),
      pages: (resource.pages ?? []).map(page => ({ ...page })), returnPending: Boolean(resource.returnPending), ...(resource.errorCode ? { errorCode: resource.errorCode } : {}) };
  }
  private async api(resource?: PrivateResource): Promise<{ api: Api; credentialIdentity: string }> {
    let key: string | undefined;
    try { key = (await this.readKey())?.trim(); } catch { throw new BrowserbaseServiceError('credential_unavailable'); }
    if (!key?.trim()) throw new BrowserbaseServiceError('credential_missing');
    const credentialIdentity = hash(key);
    if (resource && credentialIdentity !== resource.credentialIdentity) throw new BrowserbaseServiceError('credential_changed');
    return { api: this.dependencies.api ?? new BrowserbaseApiClient({ getApiKey: async () => key }), credentialIdentity };
  }
  private async readKey(): Promise<string | undefined> {
    if (!this.keyRead) {
      const current = Promise.resolve().then(this.getKey); this.keyRead = current;
      // A timed-out lookup stays deduplicated until it actually settles. This
      // never piles up additional Keychain reads behind one blocked backend.
      void current.then(() => { if (this.keyRead === current) this.keyRead = undefined; }, () => { if (this.keyRead === current) this.keyRead = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.keyRead, new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(new BrowserbaseServiceError('credential_unavailable')), this.credentialTimeoutMs); })]);
    } catch { throw new BrowserbaseServiceError('credential_unavailable'); }
    finally { if (timer) clearTimeout(timer); }
  }
  private live(resource: PrivateResource): void {
    if (!nonterminal(resource) || !resource.providerSessionId) throw new BrowserbaseServiceError('resource_unavailable');
    if (resource.pending?.operation === 'stop') throw new BrowserbaseServiceError('release_pending');
  }
  private assertSession(resource: PrivateResource, value: BrowserbaseSession): void {
    if (value.sessionId !== resource.providerSessionId || value.projectId !== resource.projectId) throw new BrowserbaseServiceError('provider_identity_changed');
  }
  private settleProvider(resource: PrivateResource, value: BrowserbaseSession): void {
    this.assertSession(resource, value);
    if (['COMPLETED','ERROR','TIMED_OUT'].includes(value.status)) {
      resource.state = value.status === 'TIMED_OUT' ? 'expired' : 'stopped'; resource.controller = 'human'; resource.pending = undefined;
      resource.returnPending = false; resource.viewerLeases = [];
      resource.errorCode = value.status === 'ERROR' ? 'provider_session_error' : undefined;
    } else if (!resource.pending && resource.lastEffect?.effect !== 'uncertain') { resource.state = value.status === 'RUNNING' ? 'active' : 'starting'; resource.errorCode = undefined; }
    resource.updatedAt = this.iso();
  }
  private serviceError(error: unknown, effect: 'none' | 'uncertain' = 'none'): BrowserbaseServiceError {
    if (error instanceof BrowserbaseServiceError) return new BrowserbaseServiceError(error.code, effect === 'uncertain' ? effect : error.effect);
    if (error instanceof BrowserbaseCdpError) return new BrowserbaseServiceError(error.code, error.effect);
    if (error instanceof BrowserbaseClientError) return new BrowserbaseServiceError(error.code, error.dispatched && effect === 'uncertain' ? 'uncertain' : 'none');
    return new BrowserbaseServiceError('browser_service_unavailable', effect);
  }
  async status(): Promise<{ configured: boolean; credentialConfigured: boolean; credentialStatus: 'available' | 'missing' | 'unavailable' | 'not_checked'; projectId: string | null; idleSeconds: number; sessionTimeoutSeconds: number; activeResources: number; privacy: { logSession: false; recordSession: false } }> {
    // Chat docks poll this passive health surface. An unconfigured integration
    // must not touch Keychain merely because an ordinary conversation is open.
    if (!this.store.policy) return { configured: false, credentialConfigured: false, credentialStatus: 'not_checked', projectId: null,
      idleSeconds: 300, sessionTimeoutSeconds: 1800, activeResources: this.store.resources.filter(nonterminal).length,
      privacy: { logSession: false, recordSession: false } };
    let credentialConfigured = false, credentialStatus: 'available' | 'missing' | 'unavailable' = 'missing';
    try { credentialConfigured = Boolean((await this.readKey())?.trim()); credentialStatus = credentialConfigured ? 'available' : 'missing'; } catch { credentialStatus = 'unavailable'; }
    return { configured: Boolean(this.store.policy && credentialConfigured), credentialConfigured, credentialStatus, projectId: this.store.policy?.projectId ?? null,
      idleSeconds: this.store.policy?.idleSeconds ?? 300, sessionTimeoutSeconds: this.store.policy?.sessionTimeoutSeconds ?? 1800,
      activeResources: this.store.resources.filter(nonterminal).length, privacy: { logSession: false, recordSession: false } };
  }
  async configure(input: { apiKey?: string; projectId: string; idleSeconds?: number; sessionTimeoutSeconds?: number }): Promise<Awaited<ReturnType<BrowserbaseService['status']>>> {
    return this.serial('configuration', async () => {
      if (!UUID.test(input.projectId)) throw new BrowserbaseServiceError('invalid_project');
      const idleSeconds = input.idleSeconds ?? this.store.policy?.idleSeconds ?? 300, sessionTimeoutSeconds = input.sessionTimeoutSeconds ?? this.store.policy?.sessionTimeoutSeconds ?? 1800;
      if (!Number.isInteger(idleSeconds) || !Number.isInteger(sessionTimeoutSeconds) || idleSeconds < 60 || sessionTimeoutSeconds > 21600 || idleSeconds > sessionTimeoutSeconds) throw new BrowserbaseServiceError('invalid_lifetime_policy');
      if (this.store.resources.some(holdsProviderSession)) throw new BrowserbaseServiceError('configuration_has_live_resources');
      if (input.apiKey !== undefined && (!input.apiKey.trim() || input.apiKey.length > 2000)) throw new BrowserbaseServiceError('invalid_credential');
      await this.verifyBeforeSave(input.apiKey?.trim(), input.projectId);
      if (input.apiKey !== undefined) { try { await this.setKey(input.apiKey.trim()); this.keyRead = undefined; } catch { throw new BrowserbaseServiceError('credential_save_failed'); } }
      this.store.policy = { projectId: input.projectId, idleSeconds, sessionTimeoutSeconds }; this.persist(); return this.status();
    });
  }
  /** A key or project Browserbase itself refuses is never saved. When
   *  Browserbase cannot be reached the save goes ahead unverified, and the
   *  first browser start reports the provider's answer. */
  private async verifyBeforeSave(candidateKey: string | undefined, projectId: string): Promise<void> {
    let key = candidateKey;
    if (key === undefined) { try { key = (await this.readKey())?.trim(); } catch { return; } }
    if (!key) return;
    const verifyKey = key;
    const api = this.dependencies.api ?? new BrowserbaseApiClient({ getApiKey: async () => verifyKey });
    if (!api.verifyProject) return;
    try { await api.verifyProject(projectId); }
    catch (error) {
      if (error instanceof BrowserbaseClientError && (error.code === 'credential_rejected' || error.code === 'project_not_found')) throw new BrowserbaseServiceError(error.code);
    }
  }
  async list(conversationId: string): Promise<BrowserbaseResource[]> {
    if (!conversationId || conversationId.length > 200) throw new BrowserbaseServiceError('invalid_conversation');
    return this.store.resources.filter(value => value.conversationId === conversationId).map(value => this.public(value));
  }
  async create(input: { conversationId: string; requestId: string; recording?: boolean }): Promise<BrowserbaseResource> {
    return this.serial('configuration', async () => {
      if (!input.conversationId || input.conversationId.length > 200 || !input.requestId || input.requestId.length > 500 || (input.recording !== undefined && typeof input.recording !== 'boolean')) throw new BrowserbaseServiceError('invalid_arguments');
      const requestKey = hash(JSON.stringify([input.conversationId, input.requestId]));
      const prior = this.store.resources.find(value => value.requestKey === requestKey);
      if (prior) { if (prior.recording !== Boolean(input.recording)) throw new BrowserbaseServiceError('request_conflict'); return this.public(prior); }
      const policy = this.store.policy; if (!policy) throw new BrowserbaseServiceError('configuration_missing');
      const { api, credentialIdentity } = await this.api();
      const resource: PrivateResource = { id: this.uuid(), conversationId: input.conversationId, provider: 'browserbase', providerSessionId: null,
        projectId: policy.projectId, state: 'starting', controller: 'agent', controlVersion: 1, createdAt: this.iso(), updatedAt: this.iso(),
        recording: Boolean(input.recording), pages: [], requestKey, credentialIdentity, lastActivityAt: this.now(), expiresAt: this.now() + policy.sessionTimeoutSeconds * 1000,
        pending: { id: this.uuid(), operation: 'create', targetId: null, controlVersion: 1, startedAt: this.now() } };
      this.store.resources.push(resource); this.persist(); // Must land before POST.
      try {
        const created = await api.create({ projectId: resource.projectId, recording: resource.recording, timeoutSeconds: policy.sessionTimeoutSeconds });
        if (!UUID.test(created.sessionId) || created.projectId !== resource.projectId) throw new BrowserbaseServiceError('provider_identity_changed', 'uncertain');
        resource.providerSessionId = created.sessionId; resource.pending = undefined; this.settleProvider(resource, created); this.persist('uncertain'); return this.public(resource);
      } catch (error) {
        const failed = this.serviceError(error, 'uncertain');
        resource.state = failed.effect === 'none' ? 'stopped' : 'uncertain'; resource.errorCode = failed.code; resource.updatedAt = this.iso();
        if (failed.effect === 'none') resource.pending = undefined;
        this.persist(failed.effect); throw failed;
      }
    });
  }
  async get(id: string, conversationId: string): Promise<BrowserbaseResource> {
    return this.serial(id, async () => {
      const resource = this.resource(id, conversationId);
      if (nonterminal(resource) && resource.providerSessionId) {
        try {
          const { api } = await this.api(resource); this.settleProvider(resource, await api.retrieve(resource.providerSessionId, resource.projectId)); this.persist();
          if (nonterminal(resource) && resource.returnPending && !resource.viewerLeases?.some(lease => lease.mode === 'human' && !lease.detached)) await this.finishReturn(resource);
        } catch (error) {
          if (nonterminal(resource)) resource.errorCode = resource.returnPending && !resource.viewerLeases?.some(lease => lease.mode === 'human' && !lease.detached) ? 'control_return_observation_pending' : this.serviceError(error).code;
          resource.updatedAt = this.iso(); this.persist();
        }
      }
      return this.public(resource);
    });
  }
  /** Explicit authenticated-owner recovery, after identifying the outstanding
   * session in the provider console. This adopts that exact identity; it does
   * not guess by timestamp, retry POST, or certify the lost create receipt. */
  async resolveUnknownCreate(id: string, conversationId: string, input: { expectedVersion: number; providerSessionId: string }): Promise<BrowserbaseResource> {
    return this.serial(id, async () => {
      const resource = this.resource(id, conversationId); this.version(resource, input.expectedVersion);
      if (resource.providerSessionId || resource.pending?.operation !== 'create' || !UUID.test(input.providerSessionId)) throw new BrowserbaseServiceError('invalid_recovery');
      if (this.store.resources.some(value => value.id !== id && value.providerSessionId === input.providerSessionId)) throw new BrowserbaseServiceError('session_already_owned');
      const { api } = await this.api(resource); const observed = await api.retrieve(input.providerSessionId, resource.projectId);
      if (observed.sessionId !== input.providerSessionId || observed.projectId !== resource.projectId) throw new BrowserbaseServiceError('provider_identity_changed');
      resource.providerSessionId = input.providerSessionId; resource.pending = undefined; resource.controller = 'human'; resource.controlVersion++;
      resource.ownerResolution = { kind: 'owner_adopted_session', providerSessionId: input.providerSessionId, at: this.now(), originalCreateProof: 'unknown' };
      this.settleProvider(resource, observed); resource.errorCode = nonterminal(resource) ? 'recovered_by_owner' : resource.errorCode;
      this.persist(); return this.public(resource);
    }).catch(error => { throw this.serviceError(error); });
  }
  /** Only authenticated owner routes may expose this bearer viewer URL. Never
   * put it in tool output, public resources, eventlogs or prompts. */
  async view(id: string, conversationId: string, input: { expectedVersion: number; viewerLeaseId: string; targetId?: string }): Promise<{ url: string; expiresAt: string; targetId?: string; controlVersion: number; controller: 'agent' | 'human'; viewerLeaseId: string }> {
    return this.serial(id, async () => {
      const resource = this.resource(id, conversationId); this.version(resource, input.expectedVersion); this.live(resource);
      if (resource.returnPending) throw new BrowserbaseServiceError('control_return_pending');
      if (!UUID.test(input.viewerLeaseId)) throw new BrowserbaseServiceError('invalid_viewer_lease');
      if (input.targetId !== undefined && (typeof input.targetId !== 'string' || !input.targetId || input.targetId.length > 128)) throw new BrowserbaseServiceError('invalid_viewer_target');
      const mode = resource.controller === 'human' ? 'human' : 'watch';
      let lease = resource.viewerLeases?.find(lease => lease.id === input.viewerLeaseId);
      if (lease?.detached) throw new BrowserbaseServiceError('viewer_lease_detached');
      if (lease && (lease.controlVersion !== resource.controlVersion || lease.targetId !== (input.targetId ?? null) || lease.mode !== mode)) throw new BrowserbaseServiceError('viewer_request_conflict');
      if (!lease) {
        if (this.store.resources.some(value => value.id !== resource.id && value.viewerLeases?.some(other => other.id === input.viewerLeaseId))) throw new BrowserbaseServiceError('viewer_request_conflict');
        lease = { id: input.viewerLeaseId, targetId: input.targetId ?? null, controlVersion: resource.controlVersion, mode, expiresAt: 0, detached: false };
        resource.viewerLeases = [...(resource.viewerLeases ?? []), lease]; this.persist(); // Caller knows the id even if this HTTP response is lost.
      }
      const { api } = await this.api(resource); const observed = await api.retrieve(resource.providerSessionId!, resource.projectId); this.settleProvider(resource, observed);
      if (!nonterminal(resource)) { this.persist(); throw new BrowserbaseServiceError('resource_unavailable'); }
      if (input.targetId !== undefined) {
        if (typeof input.targetId !== 'string' || !input.targetId || input.targetId.length > 128 || !observed.connectUrl) throw new BrowserbaseServiceError('invalid_viewer_target');
        const tabs = await this.cdp.execute(observed.connectUrl, resource.providerSessionId!, 'tabs', {});
        if (!tabs.pages?.some(page => page.targetId === input.targetId)) throw new BrowserbaseServiceError('viewer_target_unavailable');
        resource.pages = tabs.pages ?? [];
      }
      const view = await api.liveView(resource.providerSessionId!, { expiresIn: 60, ...(input.targetId ? { targetId: input.targetId } : {}) });
      if (input.targetId && view.targetId !== input.targetId) throw new BrowserbaseServiceError('viewer_target_unavailable');
      // URL expiry does not prove an already-connected iframe detached.
      lease.expiresAt = Date.parse(view.expiresAt);
      resource.lastActivityAt = this.now(); resource.updatedAt = this.iso(); this.persist(); return { ...view, controlVersion: resource.controlVersion, controller: resource.controller, viewerLeaseId: lease.id };
    }).catch(error => { throw this.serviceError(error); });
  }
  async touch(id: string, conversationId: string, input: { expectedVersion: number }): Promise<BrowserbaseResource> {
    return this.serial(id, async () => { const resource = this.resource(id, conversationId); this.version(resource, input.expectedVersion); this.live(resource); resource.lastActivityAt = this.now(); resource.updatedAt = this.iso(); this.persist(); return this.public(resource); });
  }
  async control(id: string, conversationId: string, input: { expectedVersion: number; controller: 'human' | 'agent' }): Promise<BrowserbaseResource> {
    return this.serial(id, async () => {
      const resource = this.resource(id, conversationId); this.version(resource, input.expectedVersion); this.live(resource);
      if (!['human','agent'].includes(input.controller)) throw new BrowserbaseServiceError('invalid_controller');
      if (resource.returnPending) { if (input.controller !== 'agent') throw new BrowserbaseServiceError('control_return_pending'); return this.finishReturn(resource); }
      if (input.controller === resource.controller) return this.public(resource);
      if (input.controller === 'agent' && resource.viewerLeases?.some(lease => lease.mode === 'human' && !lease.detached)) {
        resource.returnPending = true; resource.controlVersion++; resource.updatedAt = this.iso(); this.persist(); return this.public(resource);
      }
      const { api } = await this.api(resource); const observed = await api.retrieve(resource.providerSessionId!, resource.projectId); this.assertSession(resource, observed);
      if (observed.status !== 'RUNNING') { this.settleProvider(resource, observed); this.persist(); throw new BrowserbaseServiceError('resource_not_ready'); }
      if (!observed.connectUrl) throw new BrowserbaseServiceError('connection_unavailable');
      const tabs = await this.cdp.execute(observed.connectUrl, resource.providerSessionId!, 'tabs', {});
      resource.pages = tabs.pages ?? [];
      if (input.controller === 'agent') {
        resource.pending = undefined; resource.state = 'active';
        // This fresh observation grants a new control epoch, never resolves or
        // replays the prior mutation. Its uncertain effect remains lastEffect.
        resource.errorCode = resource.lastEffect?.effect === 'uncertain' ? 'previous_effect_unconfirmed' : undefined;
      }
      resource.controller = input.controller; resource.controlVersion++; resource.lastActivityAt = this.now(); resource.updatedAt = this.iso(); this.persist(); return this.public(resource);
    }).catch(error => { throw this.serviceError(error); });
  }
  async detach(id: string, conversationId: string, input: { viewerLeaseId: string }): Promise<BrowserbaseResource> {
    return this.serial(id, async () => {
      const resource = this.resource(id, conversationId);
      if (!UUID.test(input.viewerLeaseId)) throw new BrowserbaseServiceError('invalid_viewer_lease');
      let lease = resource.viewerLeases?.find(lease => lease.id === input.viewerLeaseId);
      if (!lease) {
        if (!nonterminal(resource)) return this.public(resource);
        // Cleanup can overtake a queued/cancelled mint. Tombstone the known
        // client id so a late request cannot recreate its interactive lease.
        lease = { id: input.viewerLeaseId, targetId: null, controlVersion: resource.controlVersion, expiresAt: 0, mode: 'watch', detached: true };
        resource.viewerLeases = [...(resource.viewerLeases ?? []), lease];
      }
      lease.detached = true; resource.updatedAt = this.iso(); this.persist();
      return resource.returnPending ? this.finishReturn(resource) : this.public(resource);
    }).catch(error => { throw this.serviceError(error); });
  }
  private async finishReturn(resource: PrivateResource): Promise<BrowserbaseResource> {
    if (resource.viewerLeases?.some(lease => lease.mode === 'human' && !lease.detached)) return this.public(resource);
    resource.errorCode = 'control_return_observation_pending'; resource.updatedAt = this.iso(); this.persist();
    this.live(resource); const { api } = await this.api(resource); const observed = await api.retrieve(resource.providerSessionId!, resource.projectId); this.assertSession(resource, observed);
    if (observed.status !== 'RUNNING' || !observed.connectUrl) { this.settleProvider(resource, observed); this.persist(); throw new BrowserbaseServiceError('resource_not_ready'); }
    const tabs = await this.cdp.execute(observed.connectUrl, resource.providerSessionId!, 'tabs', {});
    resource.pages = tabs.pages ?? []; resource.pending = undefined; resource.state = 'active'; resource.returnPending = false; resource.controller = 'agent'; resource.controlVersion++;
    resource.errorCode = resource.lastEffect?.effect === 'uncertain' ? 'previous_effect_unconfirmed' : undefined;
    resource.lastActivityAt = this.now(); resource.updatedAt = this.iso(); this.persist(); return this.public(resource);
  }
  async stop(id: string, conversationId: string, input: { expectedVersion: number }): Promise<BrowserbaseResource> {
    return this.serial(id, async () => { const resource = this.resource(id, conversationId); this.version(resource, input.expectedVersion); return this.release(resource); });
  }
  private async release(resource: PrivateResource): Promise<BrowserbaseResource> {
    if (!nonterminal(resource)) return this.public(resource);
    if (!resource.providerSessionId) throw new BrowserbaseServiceError('create_outcome_unknown', 'uncertain');
    const { api } = await this.api(resource);
    if (resource.pending?.operation === 'stop') { this.settleProvider(resource, await api.retrieve(resource.providerSessionId, resource.projectId)); this.persist(); return this.public(resource); }
    // Publish revoked agent control before requesting release. Acknowledgment
    // is not proof billing/browser lifetime ended: only exact terminal GET is.
    const before = { state: resource.state, pending: resource.pending, errorCode: resource.errorCode };
    resource.returnPending = false; resource.controller = 'human'; resource.controlVersion++; resource.state = 'uncertain'; resource.errorCode = 'release_pending'; resource.updatedAt = this.iso();
    resource.pending = { id: this.uuid(), operation: 'stop', targetId: null, controlVersion: resource.controlVersion, startedAt: this.now() }; this.persist();
    let releaseAcknowledged = false;
    try {
      await api.release(resource.providerSessionId, resource.projectId);
      releaseAcknowledged = true;
      this.settleProvider(resource, await api.retrieve(resource.providerSessionId, resource.projectId)); this.persist('uncertain'); return this.public(resource);
    } catch (error) {
      const classified = this.serviceError(error, 'uncertain');
      const failed = releaseAcknowledged ? new BrowserbaseServiceError(classified.code, 'uncertain') : classified;
      if (failed.effect === 'none') { resource.pending = before.pending; resource.state = before.state; }
      resource.errorCode = failed.code; resource.updatedAt = this.iso(); this.persist(failed.effect); throw failed;
    }
  }
  async agentOperation(id: string, conversationId: string, input: { operation: BrowserbaseOperation; args: unknown; expectedVersion: number }, signal?: AbortSignal): Promise<BrowserbaseOperationResponse> {
    return this.serial(id, async () => {
      const resource = this.resource(id, conversationId); this.version(resource, input.expectedVersion); this.live(resource);
      if (resource.returnPending) throw new BrowserbaseServiceError('control_return_pending');
      if (resource.controller !== 'agent') throw new BrowserbaseServiceError('human_controls_browser');
      const args = parseBrowserbaseOperation(input.operation, input.args);
      if (resource.state === 'uncertain' && !['tabs','read'].includes(input.operation)) throw new BrowserbaseServiceError('resource_effect_uncertain', 'uncertain');
      return this.perform(resource, input.operation, args, signal);
    }).catch(error => { throw this.serviceError(error); });
  }
  async humanInput(id: string, conversationId: string, input: { expectedVersion: number; viewerLeaseId: string; targetId: string; text?: string; key?: string }): Promise<BrowserbaseOperationResponse> {
    return this.serial(id, async () => {
      const resource = this.resource(id, conversationId); this.version(resource, input.expectedVersion); this.live(resource);
      if (resource.returnPending) throw new BrowserbaseServiceError('control_return_pending');
      if (resource.controller !== 'human') throw new BrowserbaseServiceError('agent_controls_browser');
      if (resource.state === 'uncertain' || resource.pending) throw new BrowserbaseServiceError('resource_effect_uncertain', 'uncertain');
      const viewer = resource.viewerLeases?.find(lease => lease.id === input.viewerLeaseId);
      if (!viewer || viewer.mode !== 'human' || viewer.detached || viewer.controlVersion !== resource.controlVersion || viewer.targetId !== input.targetId || viewer.expiresAt <= this.now()) throw new BrowserbaseServiceError('viewer_binding_required');
      if ((input.text === undefined) === (input.key === undefined)) throw new BrowserbaseServiceError('invalid_arguments');
      const args = parseBrowserbaseOperation(input.text !== undefined ? 'insert_text' : 'key', { targetId: input.targetId, ...(input.text !== undefined ? { text: input.text } : { key: input.key }) });
      return this.perform(resource, input.text !== undefined ? 'human_text' : 'key', args);
    }).catch(error => { throw this.serviceError(error); });
  }
  private async perform(resource: PrivateResource, operation: BrowserbaseOperation | 'human_text', args: Record<string, unknown>, signal?: AbortSignal): Promise<BrowserbaseOperationResponse> {
    if (signal?.aborted) throw new BrowserbaseServiceError('cancelled');
    const { api } = await this.api(resource); const observed = await api.retrieve(resource.providerSessionId!, resource.projectId); this.assertSession(resource, observed);
    if (observed.status !== 'RUNNING') { this.settleProvider(resource, observed); this.persist(); throw new BrowserbaseServiceError('resource_not_ready'); }
    if (!observed.connectUrl) throw new BrowserbaseServiceError('connection_unavailable');
    const targetId = typeof args.targetId === 'string' ? args.targetId : null;
    let crossed = false;
    const beforeMutation = async () => {
      resource.pending = { id: this.uuid(), operation, targetId, controlVersion: resource.controlVersion, startedAt: this.now() };
      resource.state = 'uncertain'; resource.errorCode = 'operation_in_flight'; resource.updatedAt = this.iso(); this.persist(); crossed = true;
    };
    try {
      const options = { signal, beforeMutation };
      const value: BrowserbaseCdpResult = operation === 'human_text'
        ? await this.cdp.humanText(observed.connectUrl, resource.providerSessionId!, String(args.targetId), String(args.text), options)
        : await this.cdp.execute(observed.connectUrl, resource.providerSessionId!, operation, args, options);
      if (value.targetId !== null && targetId !== null && value.targetId !== targetId) throw new BrowserbaseServiceError('target_identity_changed', crossed ? 'uncertain' : 'none');
      resource.lastActivityAt = this.now(); resource.updatedAt = this.iso();
      if (value.pages) { const retained = new Map((resource.pages ?? []).map(page => [page.targetId, page])); for (const page of value.pages) retained.set(page.targetId, page); resource.pages = operation === 'tabs' ? value.pages : Array.from(retained.values()).slice(0,100); }
      if (crossed) { resource.pending = undefined; resource.state = 'active'; resource.errorCode = undefined; resource.lastEffect = { operation, effect: 'confirmed', targetId: value.targetId, at: this.now() }; }
      this.persist(crossed ? 'uncertain' : 'none');
      return { resource: this.public(resource), result: value.result, receipt: { version: 1, kind: 'browserbase_dispatch_receipt', resourceId: resource.id, provider: 'browserbase',
        providerSessionId: resource.providerSessionId!, projectId: resource.projectId, operation, targetId: value.targetId, controlVersion: resource.controlVersion, effect: value.effect, at: this.iso() } };
    } catch (error) {
      const failed = this.serviceError(error, crossed ? 'uncertain' : 'none');
      if (failed.effect === 'uncertain') { resource.state = 'uncertain'; resource.errorCode = failed.code; resource.lastEffect = { operation, effect: 'uncertain', targetId, at: this.now() }; }
      else if (crossed) { resource.pending = undefined; resource.state = 'active'; resource.errorCode = failed.code; }
      resource.updatedAt = this.iso(); this.persist(failed.effect); throw failed;
    }
  }
  async maintenance(): Promise<void> {
    const policy = this.store.policy; if (!policy) return;
    for (const candidate of this.store.resources.filter(nonterminal)) {
      await this.serial(candidate.id, async () => {
        const resource = this.resource(candidate.id, candidate.conversationId);
        if (!nonterminal(resource)) return;
        if (!resource.providerSessionId) {
          // Nothing to observe without a session id; the provider's own
          // session timeout bounds any session an unanswered create started.
          if (this.now() >= resource.expiresAt) { resource.state = 'expired'; resource.pending = undefined; resource.updatedAt = this.iso(); this.persist(); }
          return;
        }
        if (resource.pending?.operation === 'stop') { try { const { api } = await this.api(resource); this.settleProvider(resource, await api.retrieve(resource.providerSessionId, resource.projectId)); this.persist(); } catch {} return; }
        if (this.now() - resource.lastActivityAt >= policy.idleSeconds * 1000 || this.now() >= resource.expiresAt) { try { await this.release(resource); } catch {} }
      });
    }
  }
}
let singleton: BrowserbaseService | undefined;
export function getBrowserbaseService(): BrowserbaseService { return singleton ??= new BrowserbaseService(); }
/** Daemon bootstrap calls this even before any browser UI is opened, so idle
 * cleanup is not dependent on a viewer request. Corruption must not prevent
 * unrelated Clem capabilities from starting. Returns only a sanitized code. */
export function startBrowserbaseMaintenance(): { started: true } | { started: false; code: string } {
  try { getBrowserbaseService(); return { started: true }; }
  catch (error) { return { started: false, code: error instanceof BrowserbaseServiceError ? error.code : 'browser_service_unavailable' }; }
}
