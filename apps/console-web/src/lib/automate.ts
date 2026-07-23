import { apiGet, apiPost, api } from './api';

export type WorkflowCertificationState =
  | 'blocked'
  | 'needs_resource_binding'
  | 'needs_info'
  | 'needs_creation_inputs'
  | 'needs_creation_test'
  | 'ready_to_enable'
  | 'needs_run_inputs'
  | 'ready_to_run';

export type WorkflowCertificationAction =
  | 'fix_blockers'
  | 'bind_resources'
  | 'answer_readiness_questions'
  | 'provide_test_inputs'
  | 'start_creation_test'
  | 'enable_workflow'
  | 'provide_run_inputs'
  | 'run_workflow'
  | 'review_contract_advisories';

export type WorkflowExecutionMode = 'agentless' | 'hybrid' | 'agent' | 'empty';

export interface WorkflowCertification {
  workflow: string;
  enabled: boolean;
  state: WorkflowCertificationState;
  /** How much runs as code vs an agent: agentless (pure code) → agent (all LLM). */
  executionMode?: WorkflowExecutionMode;
  /** Token-savings nudge: LLM steps that look mechanical enough to run as free
   *  `call` code. Advisory only. */
  codifyCandidateCount?: number;
  codifyCandidates?: Array<{ stepId: string; reason: string; tool?: string }>;
  label: string;
  summary: string;
  canRun: boolean;
  canEnableDirectly: boolean;
  canQueueCreationTest: boolean;
  needsCreationTest: boolean;
  missingRunInputs: string[];
  missingTestInputs: string[];
  resourceGaps?: string[];
  resourceGapCount?: number;
  readinessGapCount?: number;
  blockerCount?: number;
  contractAdvisoryCount?: number;
  readinessGaps?: Array<{ severity?: string; stepId?: string; question: string; why?: string }>;
  blockingReasons?: string[];
  contractAdvisories?: string[];
  nextActions: WorkflowCertificationAction[];
  dryRun?: {
    verdict?: 'ready' | 'needs_inputs' | 'blocked';
    runnable?: boolean;
    summary?: string;
    waveCount?: number;
    parallelWaveCount?: number;
    criticalPathLength?: number;
    /** Execution economics: code steps (calls + deterministic scripts) run
     *  token-free every run; llm steps (model + skill) carry the reasoning cost. */
    stepCount?: number;
    codeSteps?: number;
    llmSteps?: number;
    effectCounts?: { sends: number; writes: number; readSteps: number; approvals: number };
    toolsTouched?: string[];
    waves?: Array<{ index: number; stepIds: string[]; parallel: boolean }>;
    criticalPath?: string[];
    steps?: Array<{
      stepId: string;
      label?: string;
      wave?: number;
      executor?: string;
      effect?: string;
      reads?: string[];
      emits?: string | null;
      gated?: boolean;
      touches?: { tools?: string[]; skills?: string[]; scripts?: string[]; project?: string | null };
      fanout?: { source: string; newOnly: boolean } | null;
      /** The model this step actually runs on (pinned/intent-routed/default); null for non-LLM. */
      model?: string | null;
    }>;
    effects?: {
      sends: Array<{ stepId: string; detail: string }>;
      writes: Array<{ stepId: string; detail: string }>;
      readSteps: number;
      toolsTouched: string[];
      approvals: string[];
    };
    missingInputs?: string[];
    blockingReasons?: string[];
    qualityCriteria?: string[];
  };
}

export interface WorkflowResourceBinding {
  id: string;
  kind: string;
  label?: string;
  description?: string;
  toolkit?: string;
  tool?: string;
  cli?: string;
  mcpServer?: string;
  connectionId?: string;
  account?: string;
  resourceId?: string;
  url?: string;
  name?: string;
  scope?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
  trigger?: Record<string, unknown>;
  required?: boolean;
}

export type WorkflowResourceProposalStatus =
  | 'bound'
  | 'needs_surface'
  | 'needs_selector'
  | 'needs_connection'
  | 'optional'
  | 'unsupported';

export interface WorkflowResourceCandidate {
  id: string;
  kind: 'composio' | 'cli' | 'url' | 'project';
  label: string;
  status: 'ready' | 'available' | 'missing' | 'unknown';
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
  kind: string;
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

export interface WorkflowResourceBindingReport {
  workflow: string;
  generatedAt: string;
  resourceCount: number;
  boundCount: number;
  needsBindingCount: number;
  capabilityCounts: { composioConnected: number; cliConnected: number };
  proposals: WorkflowResourceBindingProposal[];
}

export interface WorkflowHealth {
  status: 'ok' | 'broken' | 'unknown';
  issues: Array<{ stepId: string; kind: string; detail: string }>;
}

export interface WorkflowRow {
  name: string;
  description?: string;
  enabled?: boolean;
  health?: WorkflowHealth;
  triggerSchedule?: string | null;
  trigger?: { schedule?: string; timezone?: string; manual?: boolean };
  stepCount?: number;
  resourceCount?: number;
  lastRunStatus?: string | null;
  lastRunNeedsAttention?: boolean;
  lastRunId?: string | null;
  lastRunFailedItemCount?: number;
  lastRunFailedItemStepIds?: string[];
  lastRunAt?: string | null;
  certification?: WorkflowCertification;
  resources?: Record<string, WorkflowResourceBinding>;
}

export interface WorkflowStep {
  id?: string;
  name?: string;
  prompt?: string;
  dependsOn?: string[];
  [k: string]: unknown;
}
export interface WorkflowDetail {
  name: string;
  description?: string;
  enabled?: boolean;
  trigger?: { schedule?: string; timezone?: string; manual?: boolean };
  steps?: WorkflowStep[];
  resources?: Record<string, WorkflowResourceBinding>;
  resourceBinding?: WorkflowResourceBindingReport;
  inputs?: Record<string, unknown>;
  certification?: WorkflowCertification;
}

export const getWorkflow = (name: string) =>
  apiGet<WorkflowDetail>(`/api/console/workflows/${encodeURIComponent(name)}`);
export const patchWorkflow = (name: string, body: { description?: string; enabled?: boolean; triggerSchedule?: string; clearTriggerSchedule?: boolean; timezone?: string }) =>
  api(`/api/console/workflows/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteWorkflow = (name: string) =>
  api(`/api/console/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' });

export interface CronRow {
  name: string;
  schedule?: string;
  enabled?: boolean;
  description?: string;
  prompt?: string;
}

export interface SkillRow {
  name: string;
  displayName?: string;
  description?: string;
  bodyPreview?: string;
  tier?: 'draft' | 'approved';
  disabled?: boolean;
  supersededBy?: string | null;
  supersededAt?: string | null;
  hasScripts?: boolean;
  hasReferences?: boolean;
  hasSrc?: boolean;
  source?: { repo?: string; updateAvailable?: boolean; installedAt?: string; lastCheckedAt?: string } | null;
}

export interface SkillDetail {
  name: string;
  displayName?: string;
  description?: string;
  body: string;
  tier?: 'draft' | 'approved';
  disabled?: boolean;
  supersededBy?: string | null;
  supersededAt?: string | null;
  source?: { repo?: string; updateAvailable?: boolean } | null;
  hasScripts?: boolean;
  hasReferences?: boolean;
  hasSrc?: boolean;
}

export const getSkill = (name: string) => apiGet<SkillDetail>(`/api/console/skills/${encodeURIComponent(name)}`);
export const deleteSkill = (name: string) => api(`/api/console/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
export const updateSkill = (name: string) => apiPost(`/api/console/skills/${encodeURIComponent(name)}/update`, {});

export const listWorkflows = () => apiGet<{ workflows: WorkflowRow[] }>('/api/console/workflows');
export const runWorkflow = (name: string) => apiPost(`/api/console/workflows/${encodeURIComponent(name)}/run`, {});

// ── Runs & the run workspace (the "file system" of workflow work) ──────────
export interface WorkflowRunRecord {
  id: string;
  workflow: string;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  source?: string;
  targetStepId?: string | null;
  needsAttention?: boolean;
  error?: string | null;
}

export interface RunWorkspaceArtifact {
  path: string;
  tool: string;
  agent: string;
  bytes: number;
  summary: string;
  producedAt: string;
}

export interface RunCheckerReport {
  pass: boolean;
  summary: string;
  metCount: number;
  unmetCount: number;
  evidenceSteps: string[];
  perCriterion: Array<{ criterion: string; pass: boolean; detail?: string }>;
  checkedAt?: string;
}

export interface RunWorkspace {
  runId: string;
  goal: string | null;
  artifacts: RunWorkspaceArtifact[];
  totalBytes: number;
  checker: RunCheckerReport | null;
}

export const listWorkflowRuns = (name: string, limit = 30) =>
  apiGet<{ runs: WorkflowRunRecord[] }>(`/api/console/workflows/${encodeURIComponent(name)}/runs?limit=${limit}`);

export const getRunWorkspace = (name: string, runId: string) =>
  apiGet<RunWorkspace>(`/api/console/workflows/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/workspace`);

export const checkRunAgainstGoal = (name: string, runId: string) =>
  apiPost<RunCheckerReport>(`/api/console/workflows/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/check`, {});
export interface FailedItemRetryResult {
  ok: boolean;
  status: 'queued' | 'duplicate' | 'not_found' | 'no_failed_items' | 'ambiguous';
  id?: string;
  message: string;
  failedItems: Array<{ stepId: string; itemKey: string; error: string }>;
}
export const retryWorkflowFailedItems = (name: string, runId: string, stepId?: string) =>
  apiPost<FailedItemRetryResult>(
    `/api/console/workflows/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/retry-failed-items`,
    stepId ? { stepId } : {},
  );
export const setWorkflowEnabled = (name: string, enabled: boolean) =>
  apiPost(`/api/console/workflows/${encodeURIComponent(name)}/set-enabled`, { enabled });

export const listCrons = () => apiGet<{ crons: CronRow[] }>('/api/console/crons');
export const triggerCron = (jobName: string) =>
  apiPost(`/api/console/crons/${encodeURIComponent(jobName)}/trigger`, {});

export const listSkills = () => apiGet<{ skills: SkillRow[]; count: number }>('/api/console/skills');
export const installSkill = (url: string) => apiPost('/api/console/skills/install', { url });
export const checkSkillUpdates = () => apiPost('/api/console/skills/check-updates');
