/**
 * Trusted host boundary for the one genuinely human choice in automatic pilot
 * advancement: which existing Workspace receives a dataset, or whether a new
 * Workspace creation card should be staged.
 *
 * The model never sees a callable decision tool. Desktop/mobile hosts render
 * the opaque choice ids returned here and submit the clicked id directly. A
 * content-addressed receipt is retained before the advancement saga consumes
 * it, so a crash at either side of that handoff converges without replaying a
 * different choice.
 */
import { createHash } from 'node:crypto';

import { openEventLog } from '../runtime/harness/eventlog.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  canonicalEntityWorkspaceCreationContractDigest,
  canonicalEntityWorkspaceSelectionDigest,
} from '../spaces/canonical-entity-workspace-binding-contract.js';
import { spaceStore } from '../spaces/store.js';
import {
  loadAutomationPilotAdvancement,
  recordAutomationPilotWorkspaceDestination,
  type AutomationPilotAdvancementProjectionV1,
  type AutomationPilotWorkspaceDecisionAuthorityV1,
  type AutomationPilotWorkspaceDestinationDecisionReceiptV1,
  type AutomationPilotWorkspaceOptionV1,
} from './automation-pilot-advancement-control-plane.js';

const VERSION = 1 as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 512_000;

export type AutomationPilotWorkspaceChooserStatus =
  | 'pending'
  | 'resolving'
  | 'resolved'
  | 'blocked';

export type AutomationPilotWorkspaceChooserChoiceV1 =
  | {
      version: 1;
      choiceId: string;
      kind: 'existing';
      label: string;
      workspace: AutomationPilotWorkspaceOptionV1;
    }
  | {
      version: 1;
      choiceId: string;
      kind: 'create_new';
      label: string;
      workspaceId: string;
      creationContractDigest: string;
    };

interface AutomationPilotWorkspaceChooserStateV1 {
  version: 1;
  chooserId: string;
  advancementId: string;
  ownerSessionId: string;
  expectedAdvancementRevision: number;
  expectedAdvancementDigest: string;
  expectedChoicesDigest: string;
  choices: AutomationPilotWorkspaceChooserChoiceV1[];
  choicesDigest: string;
  status: AutomationPilotWorkspaceChooserStatus;
  selectedChoiceId?: string;
  receipt?: AutomationPilotWorkspaceDestinationDecisionReceiptV1;
  receiptDigest?: string;
  blocked?: { code: string; detail: string };
}

export interface AutomationPilotWorkspaceChooserProjectionV1
  extends AutomationPilotWorkspaceChooserStateV1 {
  chooserRevision: number;
  chooserDigest: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface AutomationPilotWorkspaceChooserSurfaceV1 {
  version: 1;
  chooserId: string;
  advancementId: string;
  chooserRevision: number;
  chooserDigest: string;
  createdAt: string;
  choices: Array<{
    choiceId: string;
    kind: 'existing' | 'create_new';
    label: string;
    workspaceId: string;
  }>;
}

export type EnsureAutomationPilotWorkspaceChooserResult =
  | {
      ok: true;
      projection: AutomationPilotWorkspaceChooserProjectionV1;
      created: boolean;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      projection?: AutomationPilotWorkspaceChooserProjectionV1;
    };

export type ResolveAutomationPilotWorkspaceChooserResult =
  | {
      ok: true;
      projection: AutomationPilotWorkspaceChooserProjectionV1;
      alreadyResolved: boolean;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      projection?: AutomationPilotWorkspaceChooserProjectionV1;
    };

export interface ReconcileAutomationPilotWorkspaceChoosersResult {
  scanned: number;
  resolved: number;
  blocked: number;
  failed: number;
}

interface ChooserSqlRow {
  chooser_id: string;
  advancement_id: string;
  owner_session_id: string;
  status: AutomationPilotWorkspaceChooserStatus;
  chooser_revision: number;
  state_json: string;
  state_digest: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_pilot_workspace_chooser_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_pilot_workspace_choosers (
  chooser_id TEXT PRIMARY KEY,
  advancement_id TEXT NOT NULL UNIQUE,
  owner_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','resolving','resolved','blocked')),
  chooser_revision INTEGER NOT NULL CHECK (chooser_revision >= 1),
  state_json TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS automation_pilot_workspace_chooser_pending
  ON automation_pilot_workspace_choosers(status, updated_at, chooser_id);
CREATE INDEX IF NOT EXISTS automation_pilot_workspace_chooser_session
  ON automation_pilot_workspace_choosers(owner_session_id, status, updated_at);
`;

const EXPECTED_COLUMNS = new Set([
  'chooser_id', 'advancement_id', 'owner_session_id', 'status',
  'chooser_revision', 'state_json', 'state_digest', 'created_at', 'updated_at',
  'resolved_at',
]);

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 32,
    maxNodes: 50_000,
    maxStringBytes: 128_000,
    maxTotalBytes: MAX_BYTES,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function chooserStateDigest(state: AutomationPilotWorkspaceChooserStateV1): string {
  return sha256(canonicalJson({
    domain: 'automation-pilot-workspace-chooser-state',
    version: VERSION,
    state,
  }));
}

function chooserChoicesDigest(choices: readonly AutomationPilotWorkspaceChooserChoiceV1[]): string {
  return sha256(canonicalJson({
    domain: 'automation-pilot-workspace-chooser-choices',
    version: VERSION,
    choices,
  }));
}

function advancementChoicesDigest(input: {
  options: readonly AutomationPilotWorkspaceOptionV1[];
  creationContractDigest: string;
}): string {
  return sha256(canonicalJson({
    domain: 'automation-pilot-workspace-destination-choices',
    version: VERSION,
    options: input.options,
    createNew: { creationContractDigest: input.creationContractDigest },
  }));
}

function receiptDigest(receipt: AutomationPilotWorkspaceDestinationDecisionReceiptV1): string {
  return sha256(canonicalJson({
    domain: 'automation-pilot-workspace-destination-receipt',
    version: VERSION,
    receipt,
  }));
}

function database() {
  const db = openEventLog();
  const migration = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.prepare(`
      INSERT OR IGNORE INTO automation_pilot_workspace_chooser_migrations
        (version, applied_at) VALUES (1, ?)
    `).run(new Date().toISOString());
  });
  migration.immediate();
  const versions = db.prepare(`
    SELECT version FROM automation_pilot_workspace_chooser_migrations
    ORDER BY version ASC
  `).all() as Array<{ version: number }>;
  if (versions.length !== 1 || versions[0]?.version !== VERSION) {
    throw new Error('automation pilot Workspace chooser schema version is unknown');
  }
  const columns = new Set((db.prepare(
    'PRAGMA table_info(automation_pilot_workspace_choosers)',
  ).all() as Array<{ name: string }>).map((column) => column.name));
  if ([...EXPECTED_COLUMNS].some((column) => !columns.has(column))) {
    throw new Error('automation pilot Workspace chooser schema is incomplete');
  }
  return db;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

function validChoice(choice: AutomationPilotWorkspaceChooserChoiceV1): boolean {
  if (
    choice.version !== VERSION
    || !ID_RE.test(choice.choiceId)
    || typeof choice.label !== 'string'
    || choice.label.length < 1
    || choice.label.length > 500
  ) return false;
  if (choice.kind === 'existing') {
    return choice.workspace.version === VERSION
      && ID_RE.test(choice.workspace.workspaceId)
      && Number.isSafeInteger(choice.workspace.expectedWorkspaceRevision)
      && choice.workspace.expectedWorkspaceRevision >= 1
      && DIGEST_RE.test(choice.workspace.expectedWorkspaceDigest);
  }
  return ID_RE.test(choice.workspaceId)
    && DIGEST_RE.test(choice.creationContractDigest);
}

function validState(state: AutomationPilotWorkspaceChooserStateV1): boolean {
  if (
    state.version !== VERSION
    || !ID_RE.test(state.chooserId)
    || !ID_RE.test(state.advancementId)
    || !ID_RE.test(state.ownerSessionId)
    || !Number.isSafeInteger(state.expectedAdvancementRevision)
    || state.expectedAdvancementRevision < 1
    || !DIGEST_RE.test(state.expectedAdvancementDigest)
    || !DIGEST_RE.test(state.expectedChoicesDigest)
    || !Array.isArray(state.choices)
    || state.choices.length < 2
    || state.choices.length > 1_001
    || state.choices.some((choice) => !validChoice(choice))
    || new Set(state.choices.map((choice) => choice.choiceId)).size !== state.choices.length
    || chooserChoicesDigest(state.choices) !== state.choicesDigest
  ) return false;
  if (state.status === 'pending') {
    return state.selectedChoiceId === undefined
      && state.receipt === undefined
      && state.receiptDigest === undefined
      && state.blocked === undefined;
  }
  if (state.status === 'resolving' || state.status === 'resolved') {
    return typeof state.selectedChoiceId === 'string'
      && state.choices.some((choice) => choice.choiceId === state.selectedChoiceId)
      && state.receipt !== undefined
      && state.receiptDigest !== undefined
      && receiptDigest(state.receipt) === state.receiptDigest
      && state.blocked === undefined;
  }
  return state.blocked !== undefined
    && ID_RE.test(state.blocked.code)
    && typeof state.blocked.detail === 'string'
    && state.blocked.detail.length > 0
    && state.blocked.detail.length <= 8_192;
}

function decodeRow(row: ChooserSqlRow): AutomationPilotWorkspaceChooserProjectionV1 | null {
  try {
    const state = JSON.parse(row.state_json) as AutomationPilotWorkspaceChooserStateV1;
    if (
      canonicalJson(state) !== row.state_json
      || !validState(state)
      || chooserStateDigest(state) !== row.state_digest
      || state.chooserId !== row.chooser_id
      || state.advancementId !== row.advancement_id
      || state.ownerSessionId !== row.owner_session_id
      || state.status !== row.status
      || !Number.isSafeInteger(row.chooser_revision)
      || row.chooser_revision < 1
      || !DIGEST_RE.test(row.state_digest)
      || !validIso(row.created_at)
      || !validIso(row.updated_at)
      || !(row.resolved_at === null || validIso(row.resolved_at))
      || (state.status === 'resolved') !== (row.resolved_at !== null)
    ) return null;
    return {
      ...structuredClone(state),
      chooserRevision: row.chooser_revision,
      chooserDigest: row.state_digest,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    };
  } catch {
    return null;
  }
}

function rowFor(chooserId: string): ChooserSqlRow | undefined {
  if (!ID_RE.test(chooserId)) return undefined;
  return database().prepare(`
    SELECT * FROM automation_pilot_workspace_choosers WHERE chooser_id = ?
  `).get(chooserId) as ChooserSqlRow | undefined;
}

function rowForAdvancement(advancementId: string): ChooserSqlRow | undefined {
  if (!ID_RE.test(advancementId)) return undefined;
  return database().prepare(`
    SELECT * FROM automation_pilot_workspace_choosers WHERE advancement_id = ?
  `).get(advancementId) as ChooserSqlRow | undefined;
}

export function loadAutomationPilotWorkspaceChooser(
  chooserId: string,
): AutomationPilotWorkspaceChooserProjectionV1 | undefined {
  const row = rowFor(chooserId);
  return row ? decodeRow(row) ?? undefined : undefined;
}

export function loadAutomationPilotWorkspaceChooserForAdvancement(
  advancementId: string,
): AutomationPilotWorkspaceChooserProjectionV1 | undefined {
  const row = rowForAdvancement(advancementId);
  return row ? decodeRow(row) ?? undefined : undefined;
}

export function listAutomationPilotWorkspaceChoosers(input: {
  status?: AutomationPilotWorkspaceChooserStatus;
  ownerSessionId?: string;
  limit?: number;
} = {}): AutomationPilotWorkspaceChooserProjectionV1[] {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Workspace chooser list limit must be from 1 through 1000');
  }
  if (input.ownerSessionId !== undefined && !ID_RE.test(input.ownerSessionId)) {
    throw new TypeError('Workspace chooser owner session is invalid');
  }
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (input.status) {
    clauses.push('status = ?');
    values.push(input.status);
  }
  if (input.ownerSessionId) {
    clauses.push('owner_session_id = ?');
    values.push(input.ownerSessionId);
  }
  values.push(limit);
  const rows = database().prepare(`
    SELECT * FROM automation_pilot_workspace_choosers
    ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY updated_at ASC, chooser_id ASC LIMIT ?
  `).all(...values) as ChooserSqlRow[];
  return rows.flatMap((row) => {
    const projection = decodeRow(row);
    return projection ? [projection] : [];
  });
}

export function automationPilotWorkspaceChooserSurface(
  projection: AutomationPilotWorkspaceChooserProjectionV1,
): AutomationPilotWorkspaceChooserSurfaceV1 {
  return {
    version: VERSION,
    chooserId: projection.chooserId,
    advancementId: projection.advancementId,
    chooserRevision: projection.chooserRevision,
    chooserDigest: projection.chooserDigest,
    createdAt: projection.createdAt,
    choices: projection.choices.map((choice) => ({
      choiceId: choice.choiceId,
      kind: choice.kind,
      label: choice.label,
      workspaceId: choice.kind === 'existing' ? choice.workspace.workspaceId : choice.workspaceId,
    })),
  };
}

function stateFromProjection(
  projection: AutomationPilotWorkspaceChooserProjectionV1,
): AutomationPilotWorkspaceChooserStateV1 {
  const {
    chooserRevision: _chooserRevision,
    chooserDigest: _chooserDigest,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    resolvedAt: _resolvedAt,
    ...state
  } = projection;
  return state;
}

function transitionChooser(input: {
  current: AutomationPilotWorkspaceChooserProjectionV1;
  next: AutomationPilotWorkspaceChooserStateV1;
  now?: string;
}): AutomationPilotWorkspaceChooserProjectionV1 | null {
  if (
    !validState(input.next)
    || input.next.chooserId !== input.current.chooserId
    || input.next.advancementId !== input.current.advancementId
    || input.next.ownerSessionId !== input.current.ownerSessionId
    || input.next.expectedAdvancementRevision !== input.current.expectedAdvancementRevision
    || input.next.expectedAdvancementDigest !== input.current.expectedAdvancementDigest
    || input.next.expectedChoicesDigest !== input.current.expectedChoicesDigest
    || input.next.choicesDigest !== input.current.choicesDigest
  ) return null;
  const now = input.now ?? new Date().toISOString();
  if (!validIso(now)) return null;
  const stateJson = canonicalJson(input.next);
  const stateDigest = chooserStateDigest(input.next);
  const changed = database().prepare(`
    UPDATE automation_pilot_workspace_choosers
       SET status = ?, chooser_revision = ?, state_json = ?, state_digest = ?,
           updated_at = ?, resolved_at = ?
     WHERE chooser_id = ? AND chooser_revision = ? AND state_digest = ?
  `).run(
    input.next.status,
    input.current.chooserRevision + 1,
    stateJson,
    stateDigest,
    now,
    input.next.status === 'resolved' ? now : null,
    input.current.chooserId,
    input.current.chooserRevision,
    input.current.chooserDigest,
  );
  if (changed.changes !== 1) return null;
  return loadAutomationPilotWorkspaceChooser(input.current.chooserId) ?? null;
}

function choiceId(input: {
  advancementId: string;
  expectedAdvancementDigest: string;
  choice: { kind: 'existing'; workspace: AutomationPilotWorkspaceOptionV1 }
    | { kind: 'create_new'; creationContractDigest: string };
}): string {
  return `workspace-choice:${sha256(canonicalJson({
    domain: 'automation-pilot-workspace-choice',
    version: VERSION,
    ...input,
  }))}`;
}

function choicesForAdvancement(
  advancement: AutomationPilotAdvancementProjectionV1,
): { ok: true; choices: AutomationPilotWorkspaceChooserChoiceV1[] } | {
  ok: false;
  code: string;
  reason: string;
} {
  const contract = advancement.workspaceCreationContract;
  const options = advancement.workspaceOptions;
  if (
    advancement.stage !== 'workspace_destination_required'
    || !contract
    || !options
    || options.length < 1
    || !advancement.workspaceChoicesDigest
  ) {
    return { ok: false, code: 'workspace_destination_not_required', reason: 'The advancement is not awaiting an exact Workspace destination.' };
  }
  let creationContractDigest: string;
  try {
    creationContractDigest = canonicalEntityWorkspaceCreationContractDigest(contract);
  } catch (error) {
    return {
      ok: false,
      code: 'workspace_creation_contract_invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (advancementChoicesDigest({ options, creationContractDigest }) !== advancement.workspaceChoicesDigest) {
    return { ok: false, code: 'workspace_choices_integrity_failure', reason: 'The staged Workspace inventory failed its exact digest.' };
  }
  const choices: AutomationPilotWorkspaceChooserChoiceV1[] = [];
  for (const option of options) {
    const workspace = spaceStore.get(option.workspaceId);
    if (
      !workspace
      || workspace.status === 'archived'
      || workspace.version !== option.expectedWorkspaceRevision
      || canonicalEntityWorkspaceSelectionDigest(workspace) !== option.expectedWorkspaceDigest
      || typeof workspace.title !== 'string'
      || workspace.title.length < 1
      || workspace.title.length > 500
    ) {
      return {
        ok: false,
        code: 'workspace_inventory_drift',
        reason: `Workspace ${option.workspaceId} changed before the chooser could be rendered.`,
      };
    }
    const authoritativeChoice = { kind: 'existing' as const, workspace: structuredClone(option) };
    choices.push({
      version: VERSION,
      choiceId: choiceId({
        advancementId: advancement.advancementId,
        expectedAdvancementDigest: advancement.stateDigest,
        choice: authoritativeChoice,
      }),
      kind: 'existing',
      label: workspace.title,
      workspace: authoritativeChoice.workspace,
    });
  }
  choices.push({
    version: VERSION,
    choiceId: choiceId({
      advancementId: advancement.advancementId,
      expectedAdvancementDigest: advancement.stateDigest,
      choice: { kind: 'create_new', creationContractDigest },
    }),
    kind: 'create_new',
    label: `Create new Workspace: ${contract.title}`.slice(0, 500),
    workspaceId: contract.workspaceId,
    creationContractDigest,
  });
  return { ok: true, choices };
}

export function ensureAutomationPilotWorkspaceChooser(input: {
  advancementId: string;
}): EnsureAutomationPilotWorkspaceChooserResult {
  if (!ID_RE.test(input.advancementId)) {
    return { ok: false, code: 'advancement_id_invalid', reason: 'The advancement identity is malformed.' };
  }
  const replay = loadAutomationPilotWorkspaceChooserForAdvancement(input.advancementId);
  if (replay) return { ok: true, projection: replay, created: false };
  const advancement = loadAutomationPilotAdvancement(input.advancementId);
  if (!advancement) {
    return { ok: false, code: 'advancement_missing', reason: 'The exact advancement was not found.' };
  }
  const prepared = choicesForAdvancement(advancement);
  if (!prepared.ok) return prepared;
  const choices = prepared.choices;
  const chooserId = `automation-pilot-workspace-chooser:${sha256(canonicalJson({
    domain: 'automation-pilot-workspace-chooser',
    version: VERSION,
    advancementId: advancement.advancementId,
    expectedAdvancementRevision: advancement.stateRevision,
    expectedAdvancementDigest: advancement.stateDigest,
    expectedChoicesDigest: advancement.workspaceChoicesDigest,
  }))}`;
  const state: AutomationPilotWorkspaceChooserStateV1 = {
    version: VERSION,
    chooserId,
    advancementId: advancement.advancementId,
    ownerSessionId: advancement.ownerSessionId,
    expectedAdvancementRevision: advancement.stateRevision,
    expectedAdvancementDigest: advancement.stateDigest,
    expectedChoicesDigest: advancement.workspaceChoicesDigest!,
    choices,
    choicesDigest: chooserChoicesDigest(choices),
    status: 'pending',
  };
  const stateJson = canonicalJson(state);
  const digest = chooserStateDigest(state);
  const now = new Date().toISOString();
  database().prepare(`
    INSERT OR IGNORE INTO automation_pilot_workspace_choosers (
      chooser_id, advancement_id, owner_session_id, status, chooser_revision,
      state_json, state_digest, created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, 'pending', 1, ?, ?, ?, ?, NULL)
  `).run(
    state.chooserId,
    state.advancementId,
    state.ownerSessionId,
    stateJson,
    digest,
    now,
    now,
  );
  const retained = loadAutomationPilotWorkspaceChooserForAdvancement(input.advancementId);
  if (!retained) {
    return { ok: false, code: 'workspace_chooser_store_failed', reason: 'The durable Workspace chooser did not round-trip.' };
  }
  if (
    retained.chooserId !== chooserId
    || retained.expectedAdvancementRevision !== advancement.stateRevision
    || retained.expectedAdvancementDigest !== advancement.stateDigest
    || retained.expectedChoicesDigest !== advancement.workspaceChoicesDigest
    || retained.choicesDigest !== state.choicesDigest
  ) {
    return {
      ok: false,
      code: 'workspace_chooser_identity_conflict',
      reason: 'The advancement already names a different Workspace chooser contract.',
      projection: retained,
    };
  }
  return { ok: true, projection: retained, created: true };
}

function sameReceipt(
  left: AutomationPilotWorkspaceDestinationDecisionReceiptV1 | undefined,
  right: AutomationPilotWorkspaceDestinationDecisionReceiptV1,
): boolean {
  if (!left) return false;
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function blockChooser(
  current: AutomationPilotWorkspaceChooserProjectionV1,
  code: string,
  detail: string,
): AutomationPilotWorkspaceChooserProjectionV1 | null {
  return transitionChooser({
    current,
    next: {
      ...stateFromProjection(current),
      status: 'blocked',
      blocked: { code, detail: detail.slice(0, 8_192) || code },
    },
  });
}

const durableChooserAuthority: AutomationPilotWorkspaceDecisionAuthorityV1 = {
  verify(input) {
    const chooser = loadAutomationPilotWorkspaceChooserForAdvancement(input.receipt.advancementId);
    if (
      !chooser
      || chooser.status !== 'resolving'
      || chooser.expectedChoicesDigest !== input.expectedChoicesDigest
      || chooser.expectedAdvancementRevision !== input.receipt.expectedStateRevision
      || chooser.expectedAdvancementDigest !== input.receipt.expectedStateDigest
      || chooser.receiptDigest !== receiptDigest(input.receipt)
      || !sameReceipt(chooser.receipt, input.receipt)
    ) {
      return { ok: false, reason: 'No exact unresolved host Workspace chooser receipt exists.' };
    }
    return { ok: true };
  },
};

let afterAdvancementDecisionForTest: (() => void) | undefined;

function applyResolvingChooser(
  current: AutomationPilotWorkspaceChooserProjectionV1,
): ResolveAutomationPilotWorkspaceChooserResult {
  if (
    current.status !== 'resolving'
    || !current.receipt
    || !current.receiptDigest
    || !current.selectedChoiceId
  ) {
    return { ok: false, code: 'workspace_chooser_not_resolving', reason: 'The chooser has no exact retained decision to apply.', projection: current };
  }
  const advancement = loadAutomationPilotAdvancement(current.advancementId);
  if (!advancement) {
    const blocked = blockChooser(current, 'advancement_missing', 'The exact advancement disappeared before the Workspace decision was applied.');
    return blocked
      ? { ok: false, code: 'advancement_missing', reason: blocked.blocked!.detail, projection: blocked }
      : { ok: false, code: 'workspace_chooser_cas_lost', reason: 'Another host changed the chooser.' };
  }
  if (sameReceipt(advancement.workspaceDecision, current.receipt)) {
    const resolved = transitionChooser({
      current,
      next: { ...stateFromProjection(current), status: 'resolved' },
    });
    if (!resolved) {
      const replay = loadAutomationPilotWorkspaceChooser(current.chooserId);
      if (replay?.status === 'resolved') {
        return { ok: true, projection: replay, alreadyResolved: true };
      }
      return { ok: false, code: 'workspace_chooser_cas_lost', reason: 'Another host changed the chooser.' };
    }
    return { ok: true, projection: resolved, alreadyResolved: true };
  }
  if (
    advancement.stage !== 'workspace_destination_required'
    || advancement.stateRevision !== current.expectedAdvancementRevision
    || advancement.stateDigest !== current.expectedAdvancementDigest
    || advancement.workspaceChoicesDigest !== current.expectedChoicesDigest
  ) {
    const blocked = blockChooser(current, 'advancement_drift', 'The advancement changed before the exact Workspace choice could be applied.');
    return blocked
      ? { ok: false, code: 'advancement_drift', reason: blocked.blocked!.detail, projection: blocked }
      : { ok: false, code: 'workspace_chooser_cas_lost', reason: 'Another host changed the chooser.' };
  }
  const applied = recordAutomationPilotWorkspaceDestination({
    advancementId: current.advancementId,
    receipt: structuredClone(current.receipt),
    authority: durableChooserAuthority,
  });
  if (applied.ok) {
    afterAdvancementDecisionForTest?.();
    const latest = loadAutomationPilotWorkspaceChooser(current.chooserId);
    if (!latest) {
      return { ok: false, code: 'workspace_chooser_missing', reason: 'The exact chooser disappeared after its decision was applied.' };
    }
    if (latest.status === 'resolved') {
      return { ok: true, projection: latest, alreadyResolved: true };
    }
    if (latest.status !== 'resolving' || !sameReceipt(latest.receipt, current.receipt)) {
      return { ok: false, code: 'workspace_chooser_cas_lost', reason: 'Another host changed the chooser.', projection: latest };
    }
    const resolved = transitionChooser({
      current: latest,
      next: { ...stateFromProjection(latest), status: 'resolved' },
    });
    return resolved
      ? { ok: true, projection: resolved, alreadyResolved: false }
      : { ok: false, code: 'workspace_chooser_cas_lost', reason: 'Another host changed the chooser.' };
  }
  const latestAdvancement = loadAutomationPilotAdvancement(current.advancementId);
  if (sameReceipt(latestAdvancement?.workspaceDecision, current.receipt)) {
    return applyResolvingChooser(
      loadAutomationPilotWorkspaceChooser(current.chooserId) ?? current,
    );
  }
  const latest = loadAutomationPilotWorkspaceChooser(current.chooserId) ?? current;
  const blocked = latest.status === 'resolving'
    ? blockChooser(latest, applied.code, applied.reason)
    : latest;
  return {
    ok: false,
    code: applied.code,
    reason: applied.reason,
    ...(blocked ? { projection: blocked } : {}),
  };
}

export function resolveAutomationPilotWorkspaceChooser(input: {
  chooserId: string;
  expectedChooserRevision: number;
  expectedChooserDigest: string;
  choiceId: string;
  actorRef: string;
  now?: string;
}): ResolveAutomationPilotWorkspaceChooserResult {
  if (
    !ID_RE.test(input.chooserId)
    || !Number.isSafeInteger(input.expectedChooserRevision)
    || input.expectedChooserRevision < 1
    || !DIGEST_RE.test(input.expectedChooserDigest)
    || !ID_RE.test(input.choiceId)
    || !ID_RE.test(input.actorRef)
    || (input.now !== undefined && !validIso(input.now))
  ) {
    return { ok: false, code: 'workspace_chooser_request_invalid', reason: 'The Workspace chooser request is malformed.' };
  }
  const current = loadAutomationPilotWorkspaceChooser(input.chooserId);
  if (!current) return { ok: false, code: 'workspace_chooser_missing', reason: 'The exact Workspace chooser was not found.' };
  if (current.status === 'resolved') {
    return current.selectedChoiceId === input.choiceId
      ? { ok: true, projection: current, alreadyResolved: true }
      : { ok: false, code: 'workspace_chooser_already_resolved', reason: 'A different Workspace choice is already final.', projection: current };
  }
  if (current.status === 'blocked') {
    return { ok: false, code: current.blocked?.code ?? 'workspace_chooser_blocked', reason: current.blocked?.detail ?? 'The Workspace chooser is blocked.', projection: current };
  }
  if (current.status === 'resolving') {
    if (current.selectedChoiceId !== input.choiceId) {
      return { ok: false, code: 'workspace_chooser_resolution_conflict', reason: 'A different Workspace choice is already being applied.', projection: current };
    }
    return applyResolvingChooser(current);
  }
  if (
    current.chooserRevision !== input.expectedChooserRevision
    || current.chooserDigest !== input.expectedChooserDigest
  ) {
    return { ok: false, code: 'workspace_chooser_stale', reason: 'The Workspace chooser changed before this decision.', projection: current };
  }
  const choice = current.choices.find((candidate) => candidate.choiceId === input.choiceId);
  if (!choice) {
    return { ok: false, code: 'workspace_choice_not_offered', reason: 'The submitted choice was not present on the exact chooser.', projection: current };
  }
  const decidedAt = input.now ?? new Date().toISOString();
  const receipt: AutomationPilotWorkspaceDestinationDecisionReceiptV1 = {
    version: VERSION,
    advancementId: current.advancementId,
    expectedStateRevision: current.expectedAdvancementRevision,
    expectedStateDigest: current.expectedAdvancementDigest,
    choice: choice.kind === 'existing'
      ? { kind: 'existing', workspace: structuredClone(choice.workspace) }
      : { kind: 'create_new', creationContractDigest: choice.creationContractDigest },
    actorRef: input.actorRef,
    decidedAt,
    nonce: `workspace-choice:${sha256(canonicalJson({
      domain: 'automation-pilot-workspace-choice-receipt-nonce',
      version: VERSION,
      chooserId: current.chooserId,
      chooserRevision: current.chooserRevision,
      chooserDigest: current.chooserDigest,
      choiceId: choice.choiceId,
      actorRef: input.actorRef,
      decidedAt,
    }))}`,
  };
  const resolving = transitionChooser({
    current,
    next: {
      ...stateFromProjection(current),
      status: 'resolving',
      selectedChoiceId: choice.choiceId,
      receipt,
      receiptDigest: receiptDigest(receipt),
    },
    now: decidedAt,
  });
  if (!resolving) {
    return { ok: false, code: 'workspace_chooser_cas_lost', reason: 'Another host submitted a Workspace choice first.' };
  }
  return applyResolvingChooser(resolving);
}

export function reconcileAutomationPilotWorkspaceChoosers(input: {
  limit?: number;
} = {}): ReconcileAutomationPilotWorkspaceChoosersResult {
  const limit = input.limit ?? 100;
  const result: ReconcileAutomationPilotWorkspaceChoosersResult = {
    scanned: 0,
    resolved: 0,
    blocked: 0,
    failed: 0,
  };
  for (const chooser of listAutomationPilotWorkspaceChoosers({ status: 'resolving', limit })) {
    result.scanned += 1;
    try {
      const reconciled = applyResolvingChooser(chooser);
      if (reconciled.ok) result.resolved += 1;
      else if (reconciled.projection?.status === 'blocked') result.blocked += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export const automationPilotWorkspaceChooserInternalsForTest = {
  setAfterAdvancementDecisionHook(hook?: () => void): void {
    afterAdvancementDecisionForTest = hook;
  },
};
