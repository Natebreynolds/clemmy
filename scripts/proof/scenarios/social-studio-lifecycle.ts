/**
 * Premium Workspace proof: a live brain builds a useful social studio over a
 * proof-local Composio shim, compose stays grounded, and publish remains behind
 * the durable approval boundary.
 *
 * The model authors HTML only. It never authors or executes a runner script.
 * Both declared operations terminate in the disposable proof CLI created by
 * provision.ts, so no real Composio account, service, or user data is reachable.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  narrationCheck,
  openHarnessDb,
  reportBackCheck,
  sessionMetrics,
  stormCheck,
} from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from '../timeouts.js';

const SLUG = 'proof-social-studio';
const SOURCE_ID = 'content-plan';
const ACTION_ID = 'publish-approved';
const DATA_TOOL = 'PROOF_SOCIAL_GET_CONTENT_PLAN';
const PUBLISH_TOOL = 'INSTAGRAM_CREATE_POST';
const PROOF_IMAGE_URL = 'https://proof.invalid/social-studio.jpg';

const CAMPAIGN = {
  sourceMarker: 'SOCIAL_SOURCE:PROOF_ONLY',
  brand: 'Juniper Vale Coffee',
  handle: '@junipervale',
  campaign: 'Rainy Day Roast',
  offer: 'Complimentary oat-milk upgrade on August 14',
  hashtag: '#RainyDayRoast',
} as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface SpaceContract {
  objective?: string;
  successCriteria?: string[];
  invariants?: string[];
}

interface SpaceRecord {
  id?: string;
  status?: string;
  contract?: SpaceContract;
  dataSources?: Array<{
    id?: string;
    runner?: string;
    composioSlug?: string;
  }>;
  actions?: Array<{
    id?: string;
    runner?: string;
    composioSlug?: string;
    confirm?: boolean;
  }>;
}

interface ApprovalAuditRow {
  approval_id: string;
  status: string;
  resolution: string | null;
  tool: string | null;
}

interface WorkspaceAuditEntry {
  method?: string;
  path?: string;
  outcome?: string;
  note?: string;
}

interface WorkspaceNote {
  meta?: Record<string, unknown>;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try { return [JSON.parse(line) as T]; } catch { return []; }
    });
}

function allDispatches(daemon: DaemonHandle): string[] {
  const file = path.join(daemon.home, 'proof-composio-dispatches.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function dispatches(daemon: DaemonHandle, tool = PUBLISH_TOOL): string[] {
  return allDispatches(daemon).filter((line) => line === tool);
}

export function socialStudioProviderDispatchesValid(slugs: readonly string[]): boolean {
  return slugs.filter((slug) => slug === PUBLISH_TOOL).length === 1
    && slugs.every((slug) => slug === DATA_TOOL || slug === PUBLISH_TOOL);
}

export function socialStudioComposeInstructions(draftMarker: string): string {
  return [
    'Return exactly eight plain-text lines and nothing else.',
    'Read every campaign value from the supplied context object; do not use placeholders or outside knowledge.',
    `Line 1 must be exactly: ${draftMarker}`,
    'Line 2 must be the literal prefix "Brand: " followed by the exact context.brand value.',
    'Line 3 must be the literal prefix "Handle: " followed by the exact context.handle value.',
    'Line 4 must be the literal prefix "Campaign: " followed by the exact context.campaign value.',
    'Line 5 must be the literal prefix "Offer: " followed by the exact context.offer value.',
    'Line 6 must be the literal prefix "Hashtag: " followed by the exact context.hashtag value.',
    'Line 7 must be the literal prefix "Source: " followed by the exact context.sourceMarker value.',
    'Line 8 must be exactly: APPROVAL_REQUIRED',
    'Do not add Markdown fences, commentary, punctuation, or any other claim.',
  ].join('\n');
}

function mutationPhaseCounts(
  daemon: DaemonHandle,
  approvalId: string,
): {
  receipts: number;
  commits: number;
  calls: Array<{ tool?: string; args?: Record<string, unknown> }>;
} {
  const root = path.join(
    daemon.home,
    'vault',
    '00-System',
    'workflows',
    '__clementine-space-actions',
    'runs',
    approvalId,
    'call-mutations',
  );
  if (!existsSync(root)) return { receipts: 0, commits: 0, calls: [] };
  const operations = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => path.join(root, entry.name));
  return {
    receipts: operations.filter((dir) => existsSync(path.join(dir, 'receipt.json'))).length,
    commits: operations.filter((dir) => existsSync(path.join(dir, 'commit.json'))).length,
    calls: operations.flatMap((dir) => {
      const intent = readJson<{ call?: { tool?: string; args?: Record<string, unknown> } }>(
        path.join(dir, 'intent.json'),
      );
      return intent?.call ? [intent.call] : [];
    }),
  };
}

function findCampaign(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCampaign(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (obj.sourceMarker === CAMPAIGN.sourceMarker && obj.brand === CAMPAIGN.brand) return obj;
  for (const child of Object.values(obj)) {
    const found = findCampaign(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function recordFromResponse(json: unknown): SpaceRecord {
  if (!json || typeof json !== 'object') return {};
  const body = json as { space?: unknown };
  return (body.space && typeof body.space === 'object' ? body.space : body) as SpaceRecord;
}

function approvalRows(daemon: DaemonHandle, ids: string[]): ApprovalAuditRow[] {
  if (ids.length === 0) return [];
  const db = openHarnessDb(daemon.home);
  try {
    return db.prepare(
      `SELECT approval_id, status, resolution, tool
         FROM pending_approvals
        WHERE approval_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY requested_at ASC`,
    ).all(...ids) as ApprovalAuditRow[];
  } finally {
    db.close();
  }
}

async function waitForPublish(daemon: DaemonHandle, auditFile: string, approvalId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const audit = readJsonLines<WorkspaceAuditEntry>(auditFile);
    if (
      dispatches(daemon).length >= 1
      && audit.some((entry) => (
        entry.method === 'ACTION'
        && entry.path === `/action/${ACTION_ID}`
        && entry.outcome === 'ok'
        && entry.note === approvalId
      ))
    ) return;
    await sleep(100);
  }
}

export const socialStudioLifecycle: ScenarioDef = {
  name: 'social-studio-lifecycle',
  summary: 'proof-local data → social studio → grounded draft → reject → approve exactly once',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const nonce = Date.now().toString(36);
    const sessionId = `proof-social-studio-${nonce}`;
    const draftMarker = `DRAFT_MARKER:${nonce}`;
    const expectedDraft = [
      draftMarker,
      `Brand: ${CAMPAIGN.brand}`,
      `Handle: ${CAMPAIGN.handle}`,
      `Campaign: ${CAMPAIGN.campaign}`,
      `Offer: ${CAMPAIGN.offer}`,
      `Hashtag: ${CAMPAIGN.hashtag}`,
      `Source: ${CAMPAIGN.sourceMarker}`,
      'APPROVAL_REQUIRED',
    ].join('\n');
    const contractMarker = `CONTRACT_MARKER:${nonce}`;
    const proofDir = path.join(daemon.home, 'proof', `social-studio-${nonce}`);
    const viewSourcePath = path.join(proofDir, 'social-studio.html');
    const spaceDir = path.join(daemon.home, 'spaces', SLUG);
    const manifestFile = path.join(spaceDir, 'space.json');
    const dataFile = path.join(spaceDir, 'data.json');
    const auditFile = path.join(spaceDir, 'audit.jsonl');
    const notesFile = path.join(spaceDir, 'notes.jsonl');
    const viewFile = path.join(spaceDir, 'view', 'index.html');
    const objective = 'Prepare grounded social content from the supplied proof-only campaign source.';
    const invariant = `Never publish without approval. ${contractMarker}`;

    mkdirSync(proofDir, { recursive: true });
    // This marker activates only the disposable Composio CLI shim installed in
    // the isolated proof HOME. No real Composio token, account, or service exists.
    writeFileSync(path.join(daemon.home, 'proof-composio-connected'), 'connected\n', 'utf-8');

    const checks: Check[] = [];
    const refreshed = await daemon.request('POST', '/api/composio/refresh', {});
    checks.push({
      name: 'proof-local Composio capability is active',
      pass: refreshed.status === 200,
      detail: `status ${refreshed.status}`,
    });
    const startedAt = Date.now();
    const buildTurn = await daemon.chat(
      [
        `Build an ACTIVE dynamic Workspace now with the EXACT slug ${JSON.stringify(SLUG)} and title "Proof Social Studio".`,
        'This is an isolated proof. Do not use shell, a runner, runner_path, MCP, a network request, or any real service.',
        `Write one self-contained HTML view to ${JSON.stringify(viewSourcePath)}. It must call clem.data(), unwrap the ${JSON.stringify(SOURCE_ID)} result, display its campaign fields, call clem.compose() to draft from that selected campaign, retain the returned draft text, and call clem.action(${JSON.stringify(ACTION_ID)}, {caption: draft}) only from a user-controlled Publish button. Pending state must visibly say it is waiting for approval.`,
        'Then call space_save exactly once with:',
        `- objective exactly ${JSON.stringify(objective)}`,
        '- success criteria including "Drafts use only content-plan facts." and "Approved simulation dispatches once."',
        `- invariant exactly ${JSON.stringify(invariant)}`,
        `- data source id ${JSON.stringify(SOURCE_ID)}, composio_slug ${JSON.stringify(DATA_TOOL)}, composio_args_json ${JSON.stringify(JSON.stringify({ scope: 'isolated-proof' }))}`,
        `- action id ${JSON.stringify(ACTION_ID)}, label "Publish approved draft", composio_slug ${JSON.stringify(PUBLISH_TOOL)}, composio_args_json ${JSON.stringify(JSON.stringify({ image_url: PROOF_IMAGE_URL }))}, and confirm true`,
        `- view_path ${JSON.stringify(viewSourcePath)}`,
        'Build and validate it in this turn. Do not ask a question first and do not invoke the action.',
      ].join('\n'),
      sessionId,
      PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    );

    checks.push({ name: 'workspace build returned HTTP 200', pass: buildTurn.httpStatus === 200, detail: `status ${buildTurn.httpStatus}` });
    checks.push(reportBackCheck(buildTurn.text));
    checks.push(narrationCheck(buildTurn.text));

    const getBefore = await daemon.request('GET', `/api/console/spaces/${SLUG}`);
    const apiBefore = recordFromResponse(getBefore.json);
    const fileBefore = readJson<SpaceRecord>(manifestFile);
    const source = apiBefore.dataSources?.find((item) => item.id === SOURCE_ID);
    const action = apiBefore.actions?.find((item) => item.id === ACTION_ID);
    checks.push({
      name: 'live brain saved one ACTIVE Workspace',
      pass: getBefore.status === 200
        && apiBefore.id === SLUG
        && apiBefore.status === 'active'
        && fileBefore?.id === SLUG
        && fileBefore.status === 'active',
      detail: `GET ${getBefore.status}; API ${apiBefore.id ?? 'missing'}/${apiBefore.status ?? 'missing'}`,
    });
    checks.push({
      name: 'Workspace preserved its outcome contract and approval invariant',
      pass: apiBefore.contract?.objective === objective
        && apiBefore.contract?.invariants?.includes(invariant) === true
        && fileBefore?.contract?.objective === objective
        && fileBefore.contract.invariants?.includes(invariant) === true,
      detail: JSON.stringify(apiBefore.contract ?? {}),
    });
    checks.push({
      name: 'manifest uses only proof-local Composio operations and no executable runners',
      pass: source?.composioSlug === DATA_TOOL
        && !source.runner
        && action?.composioSlug === PUBLISH_TOOL
        && !action.runner
        && action.confirm === true,
      detail: `source=${JSON.stringify(source ?? null)}; action=${JSON.stringify(action ?? null)}`,
    });

    let html = '';
    try { html = readFileSync(viewFile, 'utf-8'); } catch { /* check reports miss */ }
    checks.push({
      name: 'view is a real two-way data/compose/action surface with no external URL',
      pass: html.length > 300
        && /\bclem\s*\.\s*data\s*\(/.test(html)
        && /\bclem\s*\.\s*compose\s*\(/.test(html)
        && /\bclem\s*\.\s*action\s*\(/.test(html)
        && html.includes(SOURCE_ID)
        && html.includes(ACTION_ID)
        && !/https?:\/\//i.test(html),
      detail: `view ${html.length} bytes`,
    });

    const workspaceData = readJson<Record<string, unknown>>(dataFile);
    const campaign = findCampaign(workspaceData?.[SOURCE_ID]);
    checks.push({
      name: 'creation smoke persisted the exact proof-only campaign',
      pass: campaign != null
        && Object.entries(CAMPAIGN).every(([key, value]) => campaign[key] === value),
      detail: JSON.stringify(campaign),
    });
    checks.push({
      name: 'workspace build never dispatched publish',
      pass: dispatches(daemon).length === 0,
      detail: JSON.stringify(dispatches(daemon)),
    });

    const composeStartedAt = Date.now();
    const compose = await daemon.request('POST', `/api/console/spaces/${SLUG}/compose`, {
      instructions: socialStudioComposeInstructions(draftMarker),
      context: campaign,
      maxChars: 1200,
    });
    const composeWallMs = Date.now() - composeStartedAt;
    const composedText = (
      compose.json && typeof compose.json === 'object'
        ? String((compose.json as { text?: unknown }).text ?? '')
        : ''
    ).replace(/\r\n/g, '\n').trim();
    checks.push({
      name: 'compose produced the exact grounded draft with no invented claim',
      pass: compose.status === 200
        && composedText === expectedDraft,
      detail: `status ${compose.status}; ${JSON.stringify(composedText).slice(0, 900)}`,
    });

    const first = await daemon.request('POST', `/api/console/spaces/${SLUG}/action`, {
      actionId: ACTION_ID,
      args: { caption: composedText },
    });
    const rejectedId = String((first.json as { approvalId?: unknown } | null)?.approvalId ?? '');
    checks.push({
      name: 'first publish parked on approval with zero dispatch',
      pass: first.status === 202 && /^apr-/.test(rejectedId) && dispatches(daemon).length === 0,
      detail: `status ${first.status}; approval ${rejectedId || 'missing'}`,
    });
    const rejectStatus = rejectedId ? await daemon.approve(rejectedId, 'reject') : 0;
    await sleep(50);
    checks.push({
      name: 'rejection stayed zero-write',
      pass: rejectStatus > 0 && rejectStatus < 300 && dispatches(daemon).length === 0,
      detail: `status ${rejectStatus}; dispatches ${JSON.stringify(dispatches(daemon))}`,
    });

    const second = await daemon.request('POST', `/api/console/spaces/${SLUG}/action`, {
      actionId: ACTION_ID,
      args: { caption: composedText },
    });
    const approvedId = String((second.json as { approvalId?: unknown } | null)?.approvalId ?? '');
    checks.push({
      name: 'fresh click minted a distinct approval after rejection',
      pass: second.status === 202 && /^apr-/.test(approvedId) && approvedId !== rejectedId,
      detail: `status ${second.status}; rejected ${rejectedId || 'missing'}; approved ${approvedId || 'missing'}`,
    });

    const racedStatuses = approvedId
      ? await Promise.all([
          daemon.approve(approvedId, 'approve'),
          daemon.approve(approvedId, 'approve'),
        ])
      : [];
    await waitForPublish(daemon, auditFile, approvedId);
    checks.push({
      name: 'racing duplicate approval had exactly one winner',
      pass: racedStatuses.filter((status) => status >= 200 && status < 300).length === 1
        && racedStatuses.filter((status) => status === 409).length === 1,
      detail: `statuses [${racedStatuses.join(', ')}]`,
    });
    checks.push({
      name: 'approved publish dispatched exactly once through the proof shim',
      pass: socialStudioProviderDispatchesValid(allDispatches(daemon)),
      detail: JSON.stringify(allDispatches(daemon)),
    });
    const mutationPhases = mutationPhaseCounts(daemon, approvedId);
    const committedCall = mutationPhases.calls[0];
    checks.push({
      name: 'approved publish durably bound the exact draft payload before one receipt and commit',
      pass: mutationPhases.receipts === 1
        && mutationPhases.commits === 1
        && mutationPhases.calls.length === 1
        && committedCall?.tool === PUBLISH_TOOL
        && committedCall.args?.image_url === PROOF_IMAGE_URL
        && committedCall.args?.caption === expectedDraft,
      detail: JSON.stringify(mutationPhases),
    });

    const approvals = approvalRows(daemon, [rejectedId, approvedId].filter(Boolean));
    const rejected = approvals.find((row) => row.approval_id === rejectedId);
    const approved = approvals.find((row) => row.approval_id === approvedId);
    checks.push({
      name: 'approval DB preserves exact reject then approve truth',
      pass: approvals.length === 2
        && rejected?.status === 'resolved'
        && rejected.resolution === 'rejected'
        && approved?.status === 'resolved'
        && approved.resolution === 'approved'
        && rejected.tool === 'space_execute_action'
        && approved.tool === 'space_execute_action',
      detail: JSON.stringify(approvals),
    });

    const actionAudit = readJsonLines<WorkspaceAuditEntry>(auditFile).filter((entry) => (
      entry.path === `/action/${ACTION_ID}`
    ));
    checks.push({
      name: 'workspace audit records one rejection and one successful publish',
      pass: actionAudit.filter((entry) => entry.method === 'ACTION_REJECTED' && entry.note === rejectedId).length === 1
        && actionAudit.filter((entry) => entry.method === 'ACTION' && entry.outcome === 'ok' && entry.note === approvedId).length === 1
        && actionAudit.filter((entry) => entry.method === 'ACTION' && entry.outcome === 'error').length === 0,
      detail: JSON.stringify(actionAudit),
    });

    const notes = readJsonLines<WorkspaceNote>(notesFile);
    checks.push({
      name: 'workspace activity remains visibly truthful after both decisions',
      pass: notes.some((note) => note.meta?.approvalId === rejectedId && note.meta?.status === 'rejected')
        && notes.some((note) => note.meta?.approvalId === approvedId && note.meta?.ok === true),
      detail: JSON.stringify(notes.filter((note) => (
        note.meta?.approvalId === rejectedId || note.meta?.approvalId === approvedId
      ))),
    });

    const getAfter = await daemon.request('GET', `/api/console/spaces/${SLUG}`);
    const apiAfter = recordFromResponse(getAfter.json);
    const servedView = await fetch(`${daemon.baseUrl}/console/spaces/${SLUG}/view`, {
      headers: { authorization: `Bearer ${daemon.secret}` },
    });
    const servedHtml = servedView.ok ? await servedView.text() : '';
    checks.push({
      name: 'workspace survives active, contracted, and data-connected',
      pass: getAfter.status === 200
        && apiAfter.status === 'active'
        && apiAfter.contract?.invariants?.includes(invariant) === true
        && apiAfter.dataSources?.some((item) => item.id === SOURCE_ID) === true
        && findCampaign(readJson<Record<string, unknown>>(dataFile)?.[SOURCE_ID]) != null
        && servedView.ok
        && servedHtml.length > 300,
      detail: `GET ${getAfter.status}; status ${apiAfter.status ?? 'missing'}; view ${servedView.status}/${servedHtml.length}`,
    });
    checks.push(stormCheck(daemon.log()));

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, buildTurn.sessionId);
      db.close();
    } catch {
      /* fail closed below */
    }
    checks.push({
      name: 'authoring metrics are present and within a bounded tool budget',
      pass: metrics != null && metrics.toolCallTotal <= 30,
      detail: metrics ? `${metrics.toolCallTotal} tool calls (limit 30)` : 'metrics unavailable',
    });

    return {
      checks,
      // Exact route scoring covers the live authoring turn. Workspace compose
      // has its own cross-provider unit gate; its wall time remains in metrics.
      latency: [{
        wallMs: buildTurn.wallMs,
        ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null,
      }],
      sessionId: buildTurn.sessionId,
      metrics: {
        turns: metrics?.turns ?? null,
        toolCallTotal: metrics?.toolCallTotal ?? null,
        buildWallMs: buildTurn.wallMs,
        composeWallMs,
        scenarioWallMs: Date.now() - startedAt,
        approvals: approvals.length,
      },
    };
  },
};
