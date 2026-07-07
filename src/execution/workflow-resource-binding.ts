import type {
  WorkflowDefinition,
  WorkflowResourceBinding,
  WorkflowResourceKind,
} from '../memory/workflow-store.js';
import {
  CURATED_TOOLKITS,
  displayNameFor,
  getComposioCredentialStatus,
  listCachedToolkits,
  listUsableConnectedToolkits,
  type CatalogToolkit,
  type ConnectedToolkit,
} from '../integrations/composio/client.js';
import {
  readConnectedClis,
  type ConnectedCliRecord,
} from '../integrations/cli-catalog/catalog.js';
import { getSavedClis } from '../runtime/saved-clis.js';

export type WorkflowResourceCandidateKind = 'composio' | 'cli' | 'url' | 'project';
export type WorkflowResourceCandidateStatus = 'ready' | 'available' | 'missing' | 'unknown';
export type WorkflowResourceProposalStatus =
  | 'bound'
  | 'needs_surface'
  | 'needs_selector'
  | 'needs_connection'
  | 'optional'
  | 'unsupported';

export interface WorkflowResourceCandidate {
  id: string;
  kind: WorkflowResourceCandidateKind;
  label: string;
  status: WorkflowResourceCandidateStatus;
  score: number;
  toolkit?: string;
  command?: string;
  connectionId?: string;
  accountLabel?: string;
  reason: string;
  nextAction?: string;
}

export interface WorkflowResourceBindingProposal {
  resourceId: string;
  kind: WorkflowResourceKind;
  label: string;
  required: boolean;
  status: WorkflowResourceProposalStatus;
  summary: string;
  binding: WorkflowResourceBinding;
  candidates: WorkflowResourceCandidate[];
  recommended?: WorkflowResourceCandidate;
  gaps: string[];
  nextActions: string[];
}

export interface WorkflowResourceBindingInventory {
  composio?: {
    apiKeyPresent: boolean;
    connected: ConnectedToolkit[];
    catalog: CatalogToolkit[];
    error?: string;
  };
  clis?: {
    connected: ConnectedCliRecord[];
    savedCommands: string[];
  };
}

export interface WorkflowResourceBindingReport {
  workflow: string;
  generatedAt: string;
  resourceCount: number;
  boundCount: number;
  needsBindingCount: number;
  capabilityCounts: {
    composioConnected: number;
    cliConnected: number;
  };
  proposals: WorkflowResourceBindingProposal[];
}

const KIND_TOOLKIT_HINTS: Partial<Record<WorkflowResourceKind, string[]>> = {
  sheet: ['googlesheets'],
  document: ['googledocs', 'googledrive'],
  folder: ['googledrive'],
  channel: ['slack', 'discord'],
  campaign: ['googleads', 'metaads'],
  analytics_property: ['google_analytics', 'googleanalytics'],
  database: ['airtable', 'supabase'],
  table: ['airtable', 'googlesheets', 'supabase'],
  repository: ['github'],
  calendar: ['googlecalendar', 'outlook'],
  email_account: ['gmail', 'outlook'],
};

const TEXT_TOOLKIT_HINTS: Array<{ pattern: RegExp; slugs: string[] }> = [
  { pattern: /\bgoogle\s*ads?\b|\badwords\b/i, slugs: ['googleads'] },
  { pattern: /\bmeta\s*ads?\b|\bfacebook\s*ads?\b/i, slugs: ['metaads'] },
  { pattern: /\bgoogle\s*analytics\b|\bga4\b/i, slugs: ['google_analytics', 'googleanalytics'] },
  { pattern: /\bgoogle\s*sheets?\b|\bspreadsheet\b/i, slugs: ['googlesheets'] },
  { pattern: /\bgoogle\s*docs?\b/i, slugs: ['googledocs'] },
  { pattern: /\bgoogle\s*drive\b|\bdrive\s*folder\b/i, slugs: ['googledrive'] },
  { pattern: /\bgmail\b/i, slugs: ['gmail'] },
  { pattern: /\boutlook\b|\bmicrosoft\s*365\b/i, slugs: ['outlook'] },
  { pattern: /\bslack\b/i, slugs: ['slack'] },
  { pattern: /\bdiscord\b/i, slugs: ['discord'] },
  { pattern: /\bsalesforce\b|\bsf\b/i, slugs: ['salesforce'] },
  { pattern: /\bairtable\b/i, slugs: ['airtable'] },
  { pattern: /\bgithub\b|\brepo(?:sitory)?\b/i, slugs: ['github'] },
  { pattern: /\bhubspot\b/i, slugs: ['hubspot'] },
  { pattern: /\bnotion\b/i, slugs: ['notion'] },
];

const TEXT_CLI_HINTS: Array<{ pattern: RegExp; ids: string[] }> = [
  { pattern: /\bsalesforce\b|\bsf\b|\bsoql\b/i, ids: ['salesforce'] },
  { pattern: /\bgithub\b|\bgh\b|\bpull request\b|\brepo(?:sitory)?\b/i, ids: ['github'] },
  { pattern: /\brailway\b/i, ids: ['railway'] },
  { pattern: /\bgcloud\b|\bgoogle cloud\b|\bgcp\b/i, ids: ['gcloud'] },
  { pattern: /\bnetlify\b/i, ids: ['netlify'] },
  { pattern: /\bngrok\b|\bwebhook\b/i, ids: ['ngrok'] },
  { pattern: /\bhiggsfield\b/i, ids: ['higgsfield'] },
];

export async function buildWorkflowResourceBindingReportFromRuntime(
  def: WorkflowDefinition,
  now = new Date(),
): Promise<WorkflowResourceBindingReport> {
  const credentials = getComposioCredentialStatus();
  let connected: ConnectedToolkit[] = [];
  let composioError: string | undefined;
  try {
    connected = await listUsableConnectedToolkits();
  } catch (err) {
    composioError = err instanceof Error ? err.message : String(err);
  }
  const catalog = mergeCatalog([
    ...CURATED_TOOLKITS.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.displayName,
      authMode: toolkit.authMode,
      categories: [],
    })),
    ...listCachedToolkits(),
  ]);
  return buildWorkflowResourceBindingReport(def, {
    composio: {
      apiKeyPresent: credentials.apiKeyPresent,
      connected,
      catalog,
      ...(composioError ? { error: composioError } : {}),
    },
    clis: {
      connected: Object.values(readConnectedClis()),
      savedCommands: getSavedClis(),
    },
  }, now);
}

export function buildWorkflowResourceBindingReport(
  def: WorkflowDefinition,
  inventory: WorkflowResourceBindingInventory = {},
  now = new Date(),
): WorkflowResourceBindingReport {
  const resources = Object.values(def.resources ?? {});
  const proposals = resources.map((resource) => proposeResourceBinding(def, resource, inventory));
  return {
    workflow: def.name,
    generatedAt: now.toISOString(),
    resourceCount: proposals.length,
    boundCount: proposals.filter((proposal) => proposal.status === 'bound' || proposal.status === 'optional').length,
    needsBindingCount: proposals.filter((proposal) => proposal.required && proposal.status !== 'bound').length,
    capabilityCounts: {
      composioConnected: inventory.composio?.connected.length ?? 0,
      cliConnected: (inventory.clis?.connected.length ?? 0) + (inventory.clis?.savedCommands.length ?? 0),
    },
    proposals,
  };
}

export function renderWorkflowResourceBindingReport(report: WorkflowResourceBindingReport): string {
  const lines = [
    `Workflow resource binding: ${report.workflow}`,
    `${report.boundCount}/${report.resourceCount} resource${report.resourceCount === 1 ? '' : 's'} bound; ${report.needsBindingCount} need action.`,
    `Capabilities visible: ${report.capabilityCounts.composioConnected} Composio connection${report.capabilityCounts.composioConnected === 1 ? '' : 's'}, ${report.capabilityCounts.cliConnected} CLI surface${report.capabilityCounts.cliConnected === 1 ? '' : 's'}.`,
  ];
  for (const proposal of report.proposals) {
    lines.push('', `${proposal.label} (${proposal.kind}) — ${proposal.status}`, proposal.summary);
    if (proposal.gaps.length > 0) lines.push(...proposal.gaps.map((gap) => `- ${gap}`));
    if (proposal.recommended) {
      lines.push(`Recommended: ${proposal.recommended.label} (${proposal.recommended.status}) — ${proposal.recommended.reason}`);
    }
    if (proposal.nextActions.length > 0) lines.push(...proposal.nextActions.map((action) => `Next: ${action}`));
  }
  if (report.proposals.length === 0) {
    lines.push('', 'No durable resources declared yet. Use workflow_update resources=... to bind sheets, accounts, folders, channels, campaigns, repositories, CLIs, or APIs.');
  }
  return lines.join('\n');
}

function proposeResourceBinding(
  def: WorkflowDefinition,
  resource: WorkflowResourceBinding,
  inventory: WorkflowResourceBindingInventory,
): WorkflowResourceBindingProposal {
  const required = resource.required !== false;
  const label = resource.label?.trim() || resource.id;
  const candidates = resourceCandidates(def, resource, inventory);
  const recommended = candidates[0];
  const hasSurface = resourceHasSurface(resource, def);
  const hasSelector = resourceHasSelector(resource, def);
  const selectedCandidate = selectedSurfaceCandidate(resource, def, inventory);
  const gaps: string[] = [];
  const nextActions: string[] = [];

  if (!required && !hasSurface && !hasSelector) {
    return {
      resourceId: resource.id,
      kind: resource.kind,
      label,
      required,
      status: 'optional',
      summary: 'Optional resource is not required for this workflow to run.',
      binding: resource,
      candidates,
      ...(recommended ? { recommended } : {}),
      gaps,
      nextActions,
    };
  }

  if (!hasSurface) {
    gaps.push(`${label}: no connector, CLI, MCP server, URL, or project surface is selected.`);
    if (recommended) {
      nextActions.push(bindingAction(resource, recommended));
    } else {
      nextActions.push(`Ask which tool/account should own ${label}.`);
    }
    return proposal(resource, label, required, 'needs_surface', 'Choose the capability surface that owns this resource.', candidates, recommended, gaps, nextActions);
  }

  if (selectedCandidate && selectedCandidate.status === 'missing') {
    gaps.push(`${label}: ${selectedCandidate.label} is selected but not connected.`);
    nextActions.push(selectedCandidate.nextAction ?? `Connect ${selectedCandidate.label}.`);
    return proposal(resource, label, required, 'needs_connection', 'Connect the selected capability before this workflow can run unattended.', candidates, selectedCandidate, gaps, nextActions);
  }

  if (!hasSelector) {
    gaps.push(`${label}: selected surface is present, but the concrete object/account/scope is missing.`);
    nextActions.push(selectorAction(resource));
    return proposal(resource, label, required, 'needs_selector', 'Bind the exact object this workflow should reuse across runs.', candidates, selectedCandidate ?? recommended, gaps, nextActions);
  }

  if (selectedCandidate && selectedCandidate.status === 'unknown') {
    nextActions.push(selectedCandidate.nextAction ?? `Verify ${selectedCandidate.label} before enabling unattended runs.`);
    return proposal(resource, label, required, 'needs_connection', 'The selected capability exists, but its connection could not be confirmed.', candidates, selectedCandidate, gaps, nextActions);
  }

  return proposal(resource, label, required, 'bound', 'Resource has a durable surface and selector.', candidates, selectedCandidate ?? recommended, gaps, nextActions);
}

function proposal(
  resource: WorkflowResourceBinding,
  label: string,
  required: boolean,
  status: WorkflowResourceProposalStatus,
  summary: string,
  candidates: WorkflowResourceCandidate[],
  recommended: WorkflowResourceCandidate | undefined,
  gaps: string[],
  nextActions: string[],
): WorkflowResourceBindingProposal {
  return {
    resourceId: resource.id,
    kind: resource.kind,
    label,
    required,
    status,
    summary,
    binding: resource,
    candidates,
    ...(recommended ? { recommended } : {}),
    gaps,
    nextActions,
  };
}

function resourceCandidates(
  def: WorkflowDefinition,
  resource: WorkflowResourceBinding,
  inventory: WorkflowResourceBindingInventory,
): WorkflowResourceCandidate[] {
  const candidates: WorkflowResourceCandidate[] = [];
  const selected = selectedSurfaceCandidate(resource, def, inventory);
  if (selected) candidates.push({ ...selected, score: 1 });
  for (const slug of candidateToolkitSlugs(resource, inventory)) {
    if (resource.toolkit && normalizeKey(slug) === normalizeKey(resource.toolkit)) continue;
    candidates.push(composioCandidate(slug, inventory, 0.82, 'Suggested by resource type/name.'));
  }
  for (const cli of candidateCliRecords(resource, inventory)) {
    if (resource.cli && normalizeKey(cli.command) === normalizeKey(resource.cli)) continue;
    candidates.push(cliCandidate(cli, inventory, 0.78, 'Suggested by resource type/name.'));
  }
  if ((resource.kind === 'api' || resource.kind === 'webhook') && resource.url) {
    candidates.push({
      id: `url:${resource.url}`,
      kind: 'url',
      label: resource.url,
      status: 'ready',
      score: 0.75,
      reason: 'Resource declares a URL.',
    });
  }
  if (resource.kind === 'project' && (resource.name || resource.resourceId || def.project)) {
    candidates.push({
      id: `project:${resource.name || resource.resourceId || def.project}`,
      kind: 'project',
      label: resource.name || resource.resourceId || def.project || 'project',
      status: 'ready',
      score: 0.75,
      reason: 'Resource declares a local project binding.',
    });
  }
  return dedupeCandidates(candidates).sort((a, b) => {
    const statusDelta = candidateStatusRank(b.status) - candidateStatusRank(a.status);
    return statusDelta || b.score - a.score || a.label.localeCompare(b.label);
  });
}

function selectedSurfaceCandidate(
  resource: WorkflowResourceBinding,
  def: WorkflowDefinition,
  inventory: WorkflowResourceBindingInventory,
): WorkflowResourceCandidate | undefined {
  if (resource.toolkit) return composioCandidate(resource.toolkit, inventory, 1, 'Selected toolkit on the workflow resource.');
  if (resource.cli) {
    const record = candidateCliRecords(resource, inventory).find((candidate) => candidate.command === resource.cli || candidate.id === resource.cli)
      ?? { id: resource.cli, command: resource.cli, name: resource.cli, vendor: 'CLI', installedAt: '', authDocsUrl: '' };
    return cliCandidate(record, inventory, 1, 'Selected CLI on the workflow resource.');
  }
  if (resource.url && (resource.kind === 'api' || resource.kind === 'webhook')) {
    return {
      id: `url:${resource.url}`,
      kind: 'url',
      label: resource.url,
      status: 'ready',
      score: 1,
      reason: 'Selected URL-backed resource.',
    };
  }
  if (resource.kind === 'project' && (resource.name || resource.resourceId || def.project)) {
    return {
      id: `project:${resource.name || resource.resourceId || def.project}`,
      kind: 'project',
      label: resource.name || resource.resourceId || def.project || 'project',
      status: 'ready',
      score: 1,
      reason: 'Selected local project resource.',
    };
  }
  return undefined;
}

function composioCandidate(
  slug: string,
  inventory: WorkflowResourceBindingInventory,
  score: number,
  reason: string,
): WorkflowResourceCandidate {
  const resolvedSlug = resolveToolkitSlug(slug, inventory);
  const connected = inventory.composio?.connected.find((connection) => normalizeKey(connection.slug) === normalizeKey(resolvedSlug));
  const active = connected && /active|enabled|initiat/i.test(connected.status);
  const known = (inventory.composio?.catalog ?? []).some((toolkit) => normalizeKey(toolkit.slug) === normalizeKey(resolvedSlug));
  const apiKeyPresent = inventory.composio?.apiKeyPresent === true;
  const label = toolkitDisplayName(resolvedSlug, inventory);
  return {
    id: `composio:${resolvedSlug}`,
    kind: 'composio',
    label,
    status: active ? 'ready' : !apiKeyPresent || known ? 'missing' : 'unknown',
    score,
    toolkit: resolvedSlug,
    ...(connected?.connectionId ? { connectionId: connected.connectionId } : {}),
    ...(connected ? { accountLabel: connected.accountLabel ?? connected.accountEmail ?? connected.accountName ?? connected.alias } : {}),
    reason: active ? `${label} has an active Composio connection.` : reason,
    nextAction: active ? undefined : `Connect ${label} in Integrations, then rerun resource proposals.`,
  };
}

function toolkitDisplayName(slug: string, inventory: WorkflowResourceBindingInventory): string {
  const toolkit = (inventory.composio?.catalog ?? []).find((candidate) => normalizeKey(candidate.slug) === normalizeKey(slug));
  return toolkit?.name || displayNameFor(slug);
}

function cliCandidate(
  record: Pick<ConnectedCliRecord, 'id' | 'command' | 'name'>,
  inventory: WorkflowResourceBindingInventory,
  score: number,
  reason: string,
): WorkflowResourceCandidate {
  const connected = (inventory.clis?.connected ?? []).some((entry) => entry.id === record.id || entry.command === record.command);
  const saved = (inventory.clis?.savedCommands ?? []).includes(record.command);
  return {
    id: `cli:${record.command}`,
    kind: 'cli',
    label: record.name || record.command,
    status: connected || saved ? 'ready' : 'missing',
    score,
    command: record.command,
    reason: connected || saved ? `${record.command} is saved as a connected local CLI.` : reason,
    nextAction: connected || saved ? undefined : `Install/authenticate ${record.command}, then save it as a connected CLI.`,
  };
}

function candidateToolkitSlugs(resource: WorkflowResourceBinding, inventory: WorkflowResourceBindingInventory): string[] {
  const hints = new Set<string>(KIND_TOOLKIT_HINTS[resource.kind] ?? []);
  const haystack = resourceText(resource);
  for (const hint of TEXT_TOOLKIT_HINTS) {
    if (hint.pattern.test(haystack)) hint.slugs.forEach((slug) => hints.add(slug));
  }
  return Array.from(hints)
    .map((slug) => resolveToolkitSlug(slug, inventory))
    .filter(Boolean);
}

function candidateCliRecords(resource: WorkflowResourceBinding, inventory: WorkflowResourceBindingInventory): Array<Pick<ConnectedCliRecord, 'id' | 'command' | 'name'>> {
  const out = new Map<string, Pick<ConnectedCliRecord, 'id' | 'command' | 'name'>>();
  for (const record of inventory.clis?.connected ?? []) out.set(record.command, record);
  for (const command of inventory.clis?.savedCommands ?? []) out.set(command, { id: command, command, name: command });
  const haystack = resourceText(resource);
  for (const hint of TEXT_CLI_HINTS) {
    if (!hint.pattern.test(haystack)) continue;
    for (const id of hint.ids) {
      const connected = (inventory.clis?.connected ?? []).find((record) => record.id === id || normalizeKey(record.command) === normalizeKey(id));
      if (connected) out.set(connected.command, connected);
    }
  }
  return Array.from(out.values());
}

function resolveToolkitSlug(slug: string, inventory: WorkflowResourceBindingInventory): string {
  const wanted = normalizeKey(slug);
  const slugs = [
    ...(inventory.composio?.connected ?? []).map((connection) => connection.slug),
    ...(inventory.composio?.catalog ?? []).map((toolkit) => toolkit.slug),
  ];
  return slugs.find((candidate) => normalizeKey(candidate) === wanted) ?? slug;
}

function mergeCatalog(catalog: CatalogToolkit[]): CatalogToolkit[] {
  const out = new Map<string, CatalogToolkit>();
  for (const toolkit of catalog) out.set(normalizeKey(toolkit.slug), toolkit);
  return Array.from(out.values());
}

function dedupeCandidates(candidates: WorkflowResourceCandidate[]): WorkflowResourceCandidate[] {
  const out = new Map<string, WorkflowResourceCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.toolkit ?? candidate.command ?? candidate.id}`;
    const prior = out.get(key);
    if (!prior || candidate.score > prior.score || candidateStatusRank(candidate.status) > candidateStatusRank(prior.status)) {
      out.set(key, candidate);
    }
  }
  return Array.from(out.values());
}

function candidateStatusRank(status: WorkflowResourceCandidateStatus): number {
  switch (status) {
    case 'ready': return 3;
    case 'available': return 2;
    case 'unknown': return 1;
    case 'missing': return 0;
  }
}

/**
 * Does this resource name a capability surface (connector/CLI/MCP/URL/project)?
 * The single, pure, inventory-free predicate — shared with certification so
 * "what makes a resource bound" is defined once. See [[workflow-certification]].
 */
export function resourceHasSurface(resource: WorkflowResourceBinding, def: WorkflowDefinition): boolean {
  if (resource.toolkit || resource.tool || resource.cli || resource.mcpServer) return true;
  if (resource.kind === 'api' || resource.kind === 'webhook') return Boolean(resource.url);
  if (resource.kind === 'project') return Boolean(resource.resourceId || resource.name || resource.url || def.project);
  return false;
}

/** Does this resource bind a concrete object/account/scope? Pure, inventory-free. */
export function resourceHasSelector(resource: WorkflowResourceBinding, def: WorkflowDefinition): boolean {
  if (resource.resourceId || resource.url || resource.name || resource.account || resource.connectionId) return true;
  if (resource.scope && Object.keys(resource.scope).length > 0) return true;
  if (resource.kind === 'cli') return Boolean(resource.cli);
  if (resource.kind === 'project') return Boolean(def.project);
  return false;
}

function resourceText(resource: WorkflowResourceBinding): string {
  return [
    resource.id,
    resource.kind,
    resource.label,
    resource.description,
    resource.toolkit,
    resource.tool,
    resource.cli,
    resource.account,
    resource.name,
    resource.url,
  ].filter(Boolean).join(' ');
}

function bindingAction(resource: WorkflowResourceBinding, candidate: WorkflowResourceCandidate): string {
  if (candidate.kind === 'composio' && candidate.toolkit) {
    return `workflow_update name=<workflow> resources='{"${resource.id}":{"kind":"${resource.kind}","toolkit":"${candidate.toolkit}","resourceId":"<id/name/url>"}}'`;
  }
  if (candidate.kind === 'cli' && candidate.command) {
    return `workflow_update name=<workflow> resources='{"${resource.id}":{"kind":"${resource.kind}","cli":"${candidate.command}","name":"<profile or target>"}}'`;
  }
  return `workflow_update name=<workflow> resources='{"${resource.id}":{"kind":"${resource.kind}","resourceId":"<id/name/url>"}}'`;
}

function selectorAction(resource: WorkflowResourceBinding): string {
  if (resource.toolkit) return `Select the exact ${selectorName(resource.kind)} for ${resource.id} and save it as resourceId, name, url, account, or scope.`;
  if (resource.cli) return `Select the CLI profile/target for ${resource.id} and save it as name, account, or scope.`;
  return `Select the exact ${selectorName(resource.kind)} for ${resource.id}.`;
}

function selectorName(kind: WorkflowResourceKind): string {
  switch (kind) {
    case 'sheet': return 'spreadsheet or tab';
    case 'campaign': return 'ad account/campaign';
    case 'analytics_property': return 'analytics property';
    case 'channel': return 'channel';
    case 'folder': return 'folder';
    case 'repository': return 'repository';
    case 'email_account':
    case 'account': return 'account';
    default: return 'resource';
  }
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
