import type { Express, Request, Response } from 'express';
import express from 'express';
import * as fs from 'node:fs';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as childProcess from 'node:child_process';
import matter from 'gray-matter';
import { registerConsoleAgentsRoutes } from './console-agents-routes.js';
import {
  BASE_DIR,
  DEFAULT_MODELS,
  LOCAL_MCP_ENABLED,
  MODEL_ENV_KEYS,
  getModelSettingsSnapshot,
  getOpenAiApiKey,
  getRuntimeEnv,
  normalizeModelId,
  getByoBackendConfig,
  getByoProviderApiKey,
  getModelRoutingMode,
  getActiveAuthMode,
  DEFAULT_CODEX_MODEL,
  type ModelTier,
  type ModelRoutingMode,
} from '../config.js';
import {
  COMPOSIO_AUTH_CONFIGS_URL,
  CURATED_TOOLKITS,
  displayNameFor,
  getComposioCredentialStatus,
  getComposioRuntimeStatus,
  listCachedToolkits,
  listUsableConnectedToolkits,
} from '../integrations/composio/client.js';
import { getGitHubCliStatus } from '../integrations/github-cli.js';
import { recallHybrid, getRecallStats } from '../memory/recall.js';
import { readEmbeddingStats, getEmbeddingHealth } from '../memory/embeddings.js';
import { FACT_KINDS, forgetFact, getFact, listActiveFacts, listAllFacts, reactivateFact, rememberFact, searchFacts, setFactPinned, updateFact } from '../memory/facts.js';
import { listResourcePointers, countResourcePointers, isSourceMapEnabled } from '../memory/source-map.js';
import { readHygieneAudit } from '../memory/hygiene-audit.js';
import { openMemoryDb } from '../memory/db.js';
import { buildMemoryGraph } from './memory-graph.js';
import {
  getFocusSnapshot,
  activateFocus as activateFocusRow,
  parkFocus as parkFocusRow,
  clearFocus as clearFocusRow,
  checkResourceMatchesFocus,
  extractResourceIdFromApprovalArgs,
} from '../memory/focus.js';
import { readMemoryIndexStatus, reindexVault } from '../memory/indexer.js';
import { IDENTITY_FILE, MEMORY_FILE, SOUL_FILE, VAULT_DIR, WORKFLOWS_DIR, WORKING_MEMORY_FILE } from '../memory/vault.js';
import { CRON_TRIGGERS_DIR, ensureDir, getWorkspaceDirs, listWorkspaceProjects, parseTasks, readBaseEnv, updateEnvKey, removeEnvKey, GOALS_DIR, TASKS_FILE, WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import {
  listWorkflows,
  readWorkflow,
  clampGoalMaxAttempts,
  type WorkflowDefinition,
  type WorkflowGoal,
} from '../memory/workflow-store.js';
import { subscribeWorkflowChanges } from '../memory/workflow-change-bus.js';
import { extractArchitectDiff } from './architect-diff.js';
import { appendWorkflowEvent, listFinalFailedItems, listPendingRuns, readWorkflowEvents, reconstructWorkflowRunQueue } from '../execution/workflow-events.js';
import { normalizeWorkflowRunInputs } from '../execution/workflow-inputs.js';
import {
  validateWorkflowDefinition as runValidator,
  type WorkflowValidation,
} from '../execution/workflow-validator.js';
import {
  applyWorkflowTriggerPatch,
  buildWorkflowTrigger,
  deleteWorkflowAndSyncTriggers,
  normalizeWorkflowInputs,
  normalizeWorkflowResources,
  normalizeWorkflowSteps,
  prepareWorkflowCreateForWrite,
  prepareWorkflowEnableForWrite,
  prepareWorkflowUpdateForWrite,
  prepareWorkflowVerification,
  renderMissingSmokeInputs,
  validateWorkflowStepGraph,
  workflowReadinessGapPayload,
  workflowModelPortabilityFromUnknown,
  workflowSlugFromName,
  workflowTriggerCreateInputFromUnknown,
  workflowUpdateNeedsVerification,
  writeWorkflowAndSyncTriggers,
} from '../execution/workflow-authoring.js';
import { extractYouTubeUrls, foldAttachmentsIntoMessage, ingestAttachment, loadInboxAttachment, saveIngestedToInbox, type IngestedAttachment } from '../runtime/attachments.js';
import { describeWorkflowPlainEnglish } from '../execution/workflow-describe.js';
import { buildWorkflowExecutionPlanWithReadiness, listWorkflowScriptNames, type WorkflowRunReadinessCheck } from '../execution/workflow-run-readiness.js';
import { certifyWorkflow, type WorkflowCertification } from '../execution/workflow-certification.js';
import { buildWorkflowResourceBindingReportFromRuntime } from '../execution/workflow-resource-binding.js';
import { applyLearnedQualityCriteria, workflowQualityCriteria } from '../execution/workflow-quality-contract.js';
import { readRunGoal, readWorkspaceManifest, workspaceArtifactBytes, readWorkspaceCheckerReport, writeWorkspaceCheckerReport } from '../execution/workflow-run-workspace.js';
import { listSubagentRuns, readSubagentOutput } from '../agents/subagent-runs.js';
import { checkRunAgainstGoal } from '../execution/workflow-run-checker.js';
import { buildWorkflowGraph } from './workflow-graph.js';
import {
  applyWorkflowVisualContractFixes,
  type WorkflowVisualContractFixKind,
} from '../execution/workflow-visual-contract-fixes.js';
import {
  buildWorkflowRunGraphOverlay,
  type WorkflowRunLaunchReadinessOverlay,
  type WorkflowRunRecoveryIntentOverlay,
} from './workflow-run-overlay.js';
import type {
  WorkflowToolReadiness,
  WorkflowToolReadinessEvidence,
  WorkflowToolReadinessItem,
  WorkflowToolReadinessKind,
  WorkflowToolReadinessStatus,
} from './workflow-execution-plan.js';
import { buildWorkflowGoalLineage } from './workflow-goal-lineage.js';
import { buildWorkflowRecoveryLineage } from './workflow-recovery-lineage.js';
import { buildWorkflowProof, type WorkflowProofRun } from './workflow-proof.js';
import { promoteWorkflowFromSession } from '../tools/orchestration-tools.js';
import { resolveRealtimeVad, buildRealtimeSessionConfig, VOICE_DELIVERY_INSTRUCTIONS } from './realtime-session-config.js';
import { ExecutionStore } from '../execution/store.js';
import { listOpenCheckIns, closeCheckIn } from '../agents/check-ins.js';
import type { ClementineAssistant } from '../assistant/core.js';
import type { AssistantRequest, PendingApproval } from '../types.js';
import { buildRealtimeVoiceInstructions } from '../assistant/voice-context.js';
import { LOCAL_MCP_TOOL_NAMES } from '../tools/catalog.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import {
  getBrowserHarnessStatus,
  getInstallJob,
  openChromeRemoteDebuggingSetup,
  runBrowserHarnessDoctor,
  runBrowserHarnessSmokeTest,
  startApprovedInstallCommand,
  startBrowserHarnessInstall,
} from '../integrations/browser-harness.js';
import {
  cancelLogin as mobileCancelLogin,
  configureTunnel as mobileConfigureTunnel,
  fetchAvailableTunnels as mobileListTunnels,
  generateQrSvg as mobileGenerateQrSvg,
  getInstallJob as getMobileInstallJob,
  getMobileAccessStatusPayload,
  MobileQrNotReadyError,
  rotatePin as mobileRotatePin,
  startInstallJob as startMobileInstallJob,
  startLogin as startMobileLogin,
  startQuickTunnel as startMobileQuickTunnel,
  startTunnel as startMobileTunnel,
  stopTunnel as stopMobileTunnel,
} from '../integrations/mobile-access.js';
import {
  revokeAllSessions as revokeAllMobileSessions,
  revokeSession as revokeMobileSession,
  revokeSessionByDeviceId as revokeMobileSessionByDeviceId,
} from '../runtime/mobile-sessions.js';
import { getManagedCliJob, startManagedCliJob, type ManagedCliAction, type ManagedCliKind } from '../runtime/managed-cli-jobs.js';
import { discoverMcpServers, loadUserMcpServers, saveUserMcpServers } from '../runtime/mcp-config.js';
import { buildDevFlagsSnapshot, setDevFlag, clearDevFlag, setDevMode, isDevModeEnabled } from '../runtime/dev-flags.js';
import { invalidateConfiguredMcpServers } from '../runtime/mcp-servers.js';
import {
  getWorkflowImportJob,
  listRecentWorkflowImportJobs,
  startWorkflowFrameworkImport,
} from '../runtime/workflow-installer.js';
import { clearAutonomyAgentCache } from '../agents/autonomy-v2.js';
import { classifyTool } from '../agents/tool-taxonomy.js';
import { loadPlugins, PLUGINS_DIR } from '../plugins/loader.js';
import { loadUserProfile, saveUserProfile } from '../runtime/user-profile.js';
import { getOrRefreshScan, probe, readCachedScan } from '../runtime/cli-discovery.js';
import { getSavedClis, addSavedCli, removeSavedCli } from '../runtime/saved-clis.js';
import { SKILLS_DIR, listSkills, loadSkill, uninstallSkill } from '../memory/skill-store.js';
import { checkAllSkillUpdates, getSkillInstallJob, startSkillInstall, startSkillUpdate } from '../runtime/skill-installer.js';
import { getProactivityPolicySnapshot, loadProactivityPolicy, saveProactivityPolicy } from '../agents/proactivity-policy.js';
import { getAuthStatus, loginWithNativeOAuth, beginCodexDeviceLogin, pollCodexDeviceLogin } from '../runtime/auth-store.js';
import { beginClaudeLogin, completeClaudeLogin } from '../runtime/claude-native-oauth.js';
import { saveClaudeTokens, getClaudeAuthSnapshot, loadFreshClaudeAccessToken, ClaudeAuthError } from '../runtime/claude-oauth.js';
import { resetClaudeModelCache } from '../runtime/harness/claude-model.js';
import { getSecretStore, listSecretDescriptors, type SecretName } from '../runtime/secrets/index.js';
import {
  createCheckInTemplate,
  deleteCheckInTemplate,
  ensureSeedTemplates,
  getCheckInTemplate,
  getTemplateState,
  listCheckInTemplates,
  testFireTemplate,
  updateCheckInTemplate,
  type TriggerKind,
} from '../agents/check-in-templates.js';
import {
  approveProposal,
  deleteProposal,
  getProposal,
  listProposals,
  rejectProposal,
} from '../agents/check-in-proposals.js';
import {
  createGoalContract,
  deletePlanProposal,
  disableGoalSelfDrive,
  enableGoalSelfDrive,
  expireGoal,
  getCurrentGoalStage,
  getPlanProposal,
  listPlanProposals,
  parkGoal,
  planProposalNeedsUserInput,
  rejectPlanProposal,
  satisfyGoal,
  supersedePlanProposal,
  unparkGoal,
  type PlanProposal,
} from '../agents/plan-proposals.js';
import { draftGoalFromNotes } from '../agents/goal-intake.js';
import {
  createGoalFromDraft,
  dismissGoalDraft,
  getGoalDraft,
  listGoalDrafts,
  surfaceGoalDraftFromNotes,
} from '../agents/goal-drafts.js';
import { approvePlanAndQueueBackgroundTask } from '../execution/approved-plan-tasks.js';
import {
  parseGoalCommand,
  handleGoalContractCommand,
} from '../agents/goal-commands.js';
import { createJsonFieldStreamer } from '../runtime/harness/stream-reply.js';
import { PlanSchema } from '../agents/planner.js';
import {
  closePlanScope, listActiveScopes, listAllScopes,
  grantStandingApproval, revokeStandingApproval, listStandingGrants,
} from '../agents/plan-scope.js';
import type { CheckInUrgency } from '../agents/check-ins.js';
import {
  archiveBackgroundTask,
  backgroundTaskNotificationMetadata,
  cancelBackgroundTask,
  createBackgroundTask,
  type BackgroundReportBackTarget,
  findSoleAwaitingContinueTaskForOrigin,
  findSoleAwaitingInputTaskForOrigin,
  getBackgroundTask,
  listBackgroundTasks,
  markBackgroundTaskDone,
  markBackgroundTaskRunning,
  processBackgroundTasks,
  queueBackgroundTaskApprovalResolution,
  queueBackgroundTaskContinue,
  queueBackgroundTaskInputResolution,
  restoreBackgroundTask,
  resumeBackgroundTask,
  setBackgroundTaskReportBackTarget,
  staleTaskKind,
  truncateResultBody,
} from '../execution/background-tasks.js';
import { enqueueDurableChatTask, renderDurableTaskQueued, shouldPromoteToDurable, detectBackgroundItIntent, detachRunningTurnToBackground } from '../execution/background-promote.js';
import { getBackgroundTaskStatus } from '../execution/background-task-status.js';
import { finishRun, getRun, listRuns } from '../runtime/run-events.js';
import { addNotification, isNeedsAttentionNotification, listNotifications, markNotificationGroupRead, markStaleApprovalNotificationsRead } from '../runtime/notifications.js';
import { actionBus, type ActionEvent } from '../runtime/action-bus.js';
import { buildWorkspaceContextPrimer } from '../spaces/workspace-context.js';
import {
  appendEvent as appendHarnessEvent,
  createSession as createHarnessSession,
  getLatestEventSeq as getLatestHarnessEventSeq,
  getSession as getHarnessSession,
  requestKill as requestHarnessKill,
  listEvents as listHarnessEvents,
  listSessions as listHarnessSessions,
  summarizeSessionForSignal,
  type EventType,
  type EventRow as HarnessEventRow,
  type SessionRow as HarnessSessionRow,
} from '../runtime/harness/eventlog.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { isHarnessSessionCurrentlyWorking } from '../shared/activity-snapshot.js';
import { runConversation, runConversationFromResume } from '../runtime/harness/loop.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import { routeDiagnosticsFromResponse } from '../runtime/harness/response-route.js';
import { claudeAgentSdkBrainEnabled, respondViaClaudeAgentSdkBrain } from '../runtime/harness/claude-agent-brain.js';
import { runPlanFirstPreflight, shouldUsePlanFirst } from '../runtime/harness/plan-first.js';
import { routeOpenQuestionPlan } from '../runtime/harness/plan-continuity.js';
import { getHarnessBudgetSnapshot, saveHarnessBudgetSettings } from '../runtime/harness/budget-settings.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { isIgnorableActiveWorkSession } from '../runtime/harness/session-reconcile.js';
import { parseApprovalIntent, parseHarnessCommand } from '../channels/discord-harness.js';
import { getSlackRuntimeStatus } from '../channels/slack.js';
import { SLACK_APP_MANIFEST_YAML } from '../channels/slack-manifest.js';
import { buildOrchestratorAgent } from '../agents/orchestrator.js';
import { configureHarnessRuntime, resetHarnessRuntimeConfig } from '../runtime/harness/codex-client.js';
import { resetByoModelCache } from '../runtime/harness/byo-model.js';
import {
  getByoProviders,
  getByoProviderSnapshots,
  byoProviderKeyEnvKey,
  slugifyProviderId,
  serializeExtraProviders,
  discoverProviderModels,
  type ByoProvider,
} from '../runtime/harness/byo-providers.js';
import { resolveRoleModel, readDurableBindings, type ModelRole, type RoleBinding } from '../runtime/harness/model-roles.js';
import { slugifyIntent, listToolChoices, computeChoiceScore } from '../memory/tool-choice-store.js';
import { resolveProvider } from '../runtime/harness/model-wire-registry.js';
import { connectedModelGroups, connectedModelGroupsForRole, validateRoleModelBinding, brainOptions, effectiveBrain, effectiveBrainValue, codexModelsAvailable, claudeModelsAvailable } from '../runtime/harness/model-role-options.js';
import { getRateLimitSnapshot } from '../runtime/harness/rate-limit-store.js';
import { getClaudeUsageSnapshot } from '../runtime/harness/claude-usage.js';
import { debateMode, judgeChoice, fusionStrategy, debateBrainsAvailable, verifyJudgeAvailable, readRecentDebateTraces } from '../runtime/harness/debate-model.js';
import { getJudgeMetricsSnapshot } from '../runtime/harness/judge-family.js';
import { summarizeApprovalAction, extractApprovalContentPreview, type ApprovalContentPreview } from '../runtime/approval-summary.js';
import {
  pendingActionApprovalViewFromArgs,
  type PendingActionApprovalView,
} from '../runtime/harness/pending-action-view.js';
import {
  listOperationalEvents,
  isOperationalEventType,
  type ListOperationalEventsOptions,
  type OperationalEventSource,
} from '../runtime/operational-telemetry.js';
import {
  appendRecallTranscriptSegment,
  buildAnalyzerPrompt,
  buildMeetingChatPrompt,
  createRecallSdkUpload,
  finalizeRecallMeeting,
  listRecentRecallMeetingSummaries,
  loadRecallMeetingAnalysis,
  loadRecallMeetingById,
  loadRecallMeetingSettings,
  noteRecallMeetingDetected,
  renameMeeting,
  RECALL_REGIONS,
  saveRecallMeetingSettings,
  type RecallMeetingSettings,
  type RecallRegion,
} from '../integrations/recall/meeting-capture.js';
import { startCanonicalTranscriptBackfill } from '../integrations/recall/backfill.js';
import { listMcpServerHealth, slugifyServerName } from '../runtime/mcp-namespace-shim.js';
import { serverEnvStatus } from '../tools/mcp-server-tools.js';
import { collectDiagnostics } from './diagnostics.js';
import { collectHarnessAudit } from './harness-audit.js';
import { collectAgentSystemMetrics } from './agent-system-metrics.js';
import {
  queueWorkflowCreationTest,
  queueWorkflowDryRun,
  queueWorkflowRun,
  requeueWorkflowFailedItemsFromRun,
  requeueWorkflowFromRun,
  resumeWorkflowRun,
  type QueueWorkflowRunRecoveryIntentInput,
} from '../tools/workflow-run-queue.js';
import { clearWorkflowFailures } from '../execution/workflow-failure-ledger.js';
import {
  findCatalogEntry,
  forgetConnectedCli,
  readConnectedClis,
  recordConnectedCli,
  statusForSearchResults,
} from '../integrations/cli-catalog/catalog.js';
import { isInternalSessionId } from '../execution/scope.js';
import {
  buildUnifiedSessionList,
  getUnifiedSessionDetail,
  patchUnifiedSession,
  deleteUnifiedSession,
} from './sessions-api.js';
import {
  buildTraceDetail,
  buildTraceReplayPreview,
  listTraceSummaries,
  type ListTraceOptions,
} from '../runtime/harness/trace-lab.js';
import { buildStartupDoctor } from '../runtime/startup-doctor.js';

function toolEventsDir(): string {
  return path.join(process.env.CLEMENTINE_HOME || BASE_DIR, 'state', 'tool-events');
}

/**
 * Mounts the Clementine Console dashboard at /console.
 *
 * /console is the primary Electron surface for managing the agent,
 * workflows, skills, memory, and local/external tools. Older /dashboard
 * links redirect here from webhook.ts.
 *
 * Auth piggy-backs on the same isAuthorized check the rest of the
 * dashboard routes use. Future console-specific endpoints (workflow
 * studio chat, project picker actions, etc.) register here too.
 */
interface WorkflowStepShape {
  id: string;
  prompt: string;
  project?: string;
  dependsOn?: string[];
  model?: string;
  intent?: string;
  tier?: number;
  maxTurns?: number;
  forEach?: string;
  forEachNewOnly?: boolean;
  deterministic?: { runner: string };
  call?: { tool: string; args?: Record<string, unknown> };
  allowedTools?: string[];
  usesSkill?: string;
  sideEffect?: 'read' | 'write' | 'send';
  requiresApproval?: boolean;
  approvalPreview?: string;
  inputs?: Record<string, unknown>;
  output?: Record<string, unknown>;
}
interface WorkflowFrontmatter {
  name?: string;
  description?: string;
  enabled?: boolean;
  trigger?: { schedule?: string; manual?: boolean };
  steps?: WorkflowStepShape[];
  inputs?: Record<string, { type?: string; default?: string; description?: string }>;
  resources?: Record<string, unknown>;
  synthesis?: { prompt?: string };
  goal?: {
    objective?: string;
    successCriteria?: string[];
    success_criteria?: string[];
    maxAttempts?: number;
    max_attempts?: number;
  };
}

interface ContextFileDefinition {
  key: string;
  title: string;
  description: string;
  filePath: string;
  minUsefulChars: number;
  /**
   * Optional starter templates the dashboard surfaces in a dropdown
   * next to the editor. Picking one populates the textarea (the user
   * still has to click SAVE). Lets first-time users go from blank
   * file to working personality in one click. See renderContextFiles
   * in console.ts for the UI.
   */
  presets?: Array<{ label: string; body: string }>;
}

const SOUL_PRESETS = [
  {
    label: 'Terse + proactive — offer the next action',
    body: `# Soul

Clementine is sharp, practical, and aligned to me.

## How to reply

- After listing items needing action, end with ONE concrete offer for the most urgent one. "Want me to draft a reply to Gina?" beats "let me know if you want help."
- Bullet points are fine for surveying items, but the bullets are the warm-up — the follow-up offer is the close.
- When the next action is obvious (email → reply, meeting → schedule, doc → review), propose the specific action. Don't ask "what would you like me to do."
- One offer per reply. Pick the most urgent.
- Match my terseness in the OFFER. "Draft a reply to Gina?" not "Would you like me to compose a thoughtful response to Gina regarding her recent email?"
`,
  },
  {
    label: 'Warm + explanatory — walk me through your reasoning',
    body: `# Soul

Clementine is thoughtful, conversational, and aligned to me.

## How to reply

- When making a non-trivial decision, briefly explain WHY before showing the result. Two sentences max. "I checked X first because Y — here's what I found."
- Acknowledge context: if I'm asking about a project, reference the relevant fact you remember. Don't repeat back at length — just signal continuity ("from the Scorpion thread —").
- Tone is professional-warm. Not casual, not robotic.
- When you're unsure between two paths, surface the tradeoff briefly and ask, instead of guessing.
`,
  },
  {
    label: 'Quiet executor — output only the result',
    body: `# Soul

Clementine is precise and quiet.

## How to reply

- Skip preambles. Skip "Sure" / "I'll get on that" / "Here's what I found." Output only the result or the next required question.
- No bullet lists unless I asked for a list.
- No "let me know if you need anything else" closers.
- When something fails, one line: what failed and why. No apology, no padding.
- When approval is needed, the question is the entire reply.
`,
  },
];

const IDENTITY_PRESETS = [
  {
    label: 'Personal productivity assistant',
    body: `# Identity

Clementine is my personal productivity assistant. She knows my work context, takes initiative on routine ops, and surfaces what matters before I have to ask.

She does not pretend to know things she doesn't — she searches memory, checks tools, or asks. She acts on my behalf within the boundaries of the approval policy.
`,
  },
  {
    label: 'Senior executive partner',
    body: `# Identity

Clementine acts as a senior executive partner — proactive, candid, with strong opinions about priorities. She doesn't just complete tasks; she questions whether the task is the right one.

She tells me when something doesn't add up, when a workflow is fragile, or when I'm about to repeat a pattern that didn't work last time.
`,
  },
];

const CONTEXT_FILES: ContextFileDefinition[] = [
  {
    key: 'identity',
    title: 'Identity',
    description: 'Who the user is, what Clementine should know about them, and the durable north-star context.',
    filePath: IDENTITY_FILE,
    minUsefulChars: 80,
    presets: IDENTITY_PRESETS,
  },
  {
    key: 'soul',
    title: 'Personality',
    description: 'How Clementine talks to you: tone, reply shape, when to offer next actions. Loaded fresh on every turn — edits take effect on your next message.',
    filePath: SOUL_FILE,
    minUsefulChars: 120,
    presets: SOUL_PRESETS,
  },
  {
    key: 'memory',
    title: 'Long-Term Memory',
    description: 'Standing context Clementine should keep visible across chat, Discord, voice, and autonomous runs.',
    filePath: MEMORY_FILE,
    minUsefulChars: 120,
  },
  {
    key: 'working_memory',
    title: 'Working Memory',
    description: 'Current session focus and recent continuity. Usually managed automatically, but editable when needed.',
    filePath: WORKING_MEMORY_FILE,
    minUsefulChars: 80,
  },
];

// Knowledge-graph construction (fact/kind/file/entity nodes, semantic edges,
// PCA 3D positions) lives in ./memory-graph.ts so the route, the offline
// snapshot dumper, and tests all share one tested builder.

function contextFileForKey(key: string): ContextFileDefinition | undefined {
  return CONTEXT_FILES.find((file) => file.key === key);
}

function trimConsoleTitle(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, Math.max(0, max - 1)) + '…' : clean;
}

/** Strip internal id tokens (bg-…, run-bg-…, recall-…, sess-…, UUIDs) from
 *  a user-facing string so the Home cards read cleanly instead of dumping
 *  raw task/run ids. */
function stripConsoleIds(text: string): string {
  return (text || '')
    .replace(/\b(?:run-bg|run|bg|recall|sess|apr|sched|task|exec)[-_][A-Za-z0-9][A-Za-z0-9_-]{3,}/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\s*[:·|-]\s*$/g, '')
    .replace(/^\s*[:·|-]\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Short relative age ("just now", "12m ago", "3h ago") from an ISO time. */
function relAge(iso?: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface ApprovalPreviewSample {
  label?: string;
  value?: string;
  secondary?: string;
}

interface ApprovalPreviewPayload {
  count?: number;
  samples?: ApprovalPreviewSample[];
  inferred?: boolean;
}

function pickApprovalString(record: Record<string, unknown> | undefined | null, keys: string[]): string {
  if (!record) return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeApprovalPreview(raw: unknown): ApprovalPreviewPayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  const samples = Array.isArray(input.samples)
    ? input.samples
      .filter((sample): sample is Record<string, unknown> => Boolean(sample) && typeof sample === 'object')
      .slice(0, 5)
      .map((sample) => ({
        label: typeof sample.label === 'string' ? trimConsoleTitle(sample.label, 40) : undefined,
        value: typeof sample.value === 'string' ? trimConsoleTitle(sample.value, 180) : undefined,
        secondary: typeof sample.secondary === 'string' ? trimConsoleTitle(sample.secondary, 140) : undefined,
      }))
      .filter((sample) => sample.label || sample.value || sample.secondary)
    : undefined;
  const count = typeof input.count === 'number' && Number.isFinite(input.count) ? input.count : undefined;
  const inferred = input.inferred === true;
  if (count === undefined && (!samples || samples.length === 0) && !inferred) return undefined;
  return { count, samples, inferred };
}

function extractRuntimeApprovalArgs(approval: PendingApproval): Record<string, unknown> | undefined {
  if (!approval.state) return undefined;
  try {
    const parsed = JSON.parse(approval.state) as { toolCall?: { arguments?: string | Record<string, unknown> } };
    const args = parsed.toolCall?.arguments;
    if (typeof args === 'string') {
      try {
        return JSON.parse(args) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
    if (args && typeof args === 'object') return args as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

function approvalSummaryFromArgs(args: Record<string, unknown> | undefined, fallback: string): string {
  const subject = pickApprovalString(args, ['subject', 'title', 'name']);
  return trimConsoleTitle(subject || fallback || 'Approval required', 180);
}

function approvalReasonFromArgs(args: Record<string, unknown> | undefined): string {
  return trimConsoleTitle(pickApprovalString(args, ['reason', 'why', 'description']), 260);
}

function compactBoardStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => trimConsoleTitle(item, 180))
    .slice(0, limit);
}

function boardArtifactSummaryFrom(value: unknown): BoardArtifactSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const summary = {
    files: compactBoardStrings(raw.files, 6),
    urls: compactBoardStrings(raw.urls, 6),
    counts: compactBoardStrings(raw.counts, 8),
  };
  return summary.files.length || summary.urls.length || summary.counts.length ? summary : undefined;
}

function workflowRunSummary(workflowSlug: string, runId: string): {
  artifactSummary?: BoardArtifactSummary;
  because?: string;
  needsAttention?: boolean;
} {
  const summaries = readWorkflowEvents(workflowSlug, runId)
    .filter((ev) => ev.kind === 'run_summary' && ev.meta);
  const latest = summaries[summaries.length - 1];
  const meta = latest?.meta;
  if (!meta) return {};
  return {
    artifactSummary: boardArtifactSummaryFrom(meta.artifacts),
    because: typeof meta.because === 'string' ? trimConsoleTitle(meta.because, 180) : undefined,
    needsAttention: meta.needsAttention === true,
  };
}

function workflowExecutionPlanOptions() {
  return {
    stepConcurrency: positiveEnvInt('CLEMENTINE_WORKFLOW_CONCURRENCY', 5),
    runConcurrency: positiveEnvInt('CLEMENTINE_WORKFLOW_RUN_CONCURRENCY', 1),
    forEachBatchSize: positiveEnvInt('CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS', 200),
  };
}

function workflowExecutionPlanFor(def: WorkflowDefinition, workflowSlug?: string) {
  return buildWorkflowExecutionPlanWithReadiness(def, workflowSlug, workflowExecutionPlanOptions());
}

function workflowCertificationFor(def: WorkflowDefinition, workflowSlug: string) {
  return certifyWorkflow(def, {
    workflowSlug,
    planOptions: workflowExecutionPlanOptions(),
  });
}

function workflowCertificationSummary(cert: WorkflowCertification) {
  const dryRun = cert.dryRun;
  const codeSteps = dryRun.steps.filter((s) => s.executor === 'call' || s.executor === 'deterministic').length;
  const llmSteps = dryRun.steps.filter((s) => s.executor === 'model' || s.executor === 'skill').length;
  return {
    workflow: cert.workflow,
    enabled: cert.enabled,
    state: cert.state,
    executionMode: cert.executionMode,
    label: cert.label,
    summary: cert.summary,
    canRun: cert.canRun,
    canEnableDirectly: cert.canEnableDirectly,
    canQueueCreationTest: cert.canQueueCreationTest,
    needsCreationTest: cert.needsCreationTest,
    missingRunInputs: cert.missingRunInputs,
    missingTestInputs: cert.missingTestInputs,
    resourceGaps: cert.resourceGaps.slice(0, 5),
    resourceGapCount: cert.resourceGaps.length,
    readinessGapCount: cert.readinessGaps.length,
    blockerCount: cert.blockingReasons.length,
    contractAdvisoryCount: cert.contractAdvisories.length,
    nextActions: cert.nextActions,
    dryRun: {
      verdict: dryRun.verdict,
      runnable: dryRun.runnable,
      summary: dryRun.summary,
      waveCount: dryRun.waves.length,
      parallelWaveCount: dryRun.waves.filter((wave) => wave.parallel).length,
      criticalPathLength: dryRun.criticalPath.length,
      // Execution economics — the "why Clem, not Claude Code" signal. `code`
      // steps (direct tool calls + deterministic scripts) run token-free every
      // run; `llm` steps (model reasoning + skill execution) are where the
      // once-authored reasoning cost lives. A cheap workflow is mostly code.
      stepCount: dryRun.steps.length,
      codeSteps,
      llmSteps,
      effectCounts: {
        sends: dryRun.effects.sends.length,
        writes: dryRun.effects.writes.length,
        readSteps: dryRun.effects.readSteps,
        approvals: dryRun.effects.approvals.length,
      },
      toolsTouched: dryRun.effects.toolsTouched.slice(0, 8),
    },
  };
}

function workflowCertificationSummaryFor(def: WorkflowDefinition, workflowSlug: string) {
  return workflowCertificationSummary(workflowCertificationFor(def, workflowSlug));
}

function workflowConsoleStatePayload(def: WorkflowDefinition, workflowSlug: string) {
  const certification = workflowCertificationFor(def, workflowSlug);
  const executionPlan = certification.dryRun.plan;
  const proof = buildWorkflowProof(def, readWorkflowRunRecords(), [workflowSlug]);
  return {
    name: def.name,
    enabled: def.enabled,
    certification,
    readinessGaps: workflowReadinessGapPayload(def),
    proof,
    executionPlan,
    graph: buildWorkflowGraph(def.steps, {
      readinessItems: executionPlan.toolReadiness.items,
      workflowProject: def.project,
      executionPlan,
    }),
    steps: def.steps,
    goal: def.goal ?? null,
    resources: def.resources ?? {},
    inputs: def.inputs ?? {},
    synthesis: def.synthesis ?? null,
    project: def.project ?? null,
  };
}

const WORKFLOW_VISUAL_CONTRACT_FIX_KINDS: ReadonlySet<WorkflowVisualContractFixKind> = new Set([
  'fix_graph_structure',
  'increase_concurrency',
  'make_fanout_resumable',
  'add_judge_gate',
  'confirm_tool_connection',
  'install_skill',
  'add_workflow_script',
  'select_local_project',
  'make_models_portable',
]);

function parseWorkflowVisualContractFixes(raw: unknown): { ok: true; fixes?: WorkflowVisualContractFixKind[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'fixes must be an array of visual-contract remediation kinds' };
  const fixes: WorkflowVisualContractFixKind[] = [];
  for (const value of raw) {
    const kind = typeof value === 'string' ? value.trim() : '';
    if (!WORKFLOW_VISUAL_CONTRACT_FIX_KINDS.has(kind as WorkflowVisualContractFixKind)) {
      return { ok: false, error: `unknown visual-contract fix: ${kind || String(value)}` };
    }
    fixes.push(kind as WorkflowVisualContractFixKind);
  }
  return { ok: true, fixes: [...new Set(fixes)] };
}

function parseWorkflowFixStepIds(body: Record<string, unknown>): string[] | undefined {
  const raw = body.stepIds ?? body.step_ids;
  if (!Array.isArray(raw)) return undefined;
  return [...new Set(raw
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean))];
}

type WorkflowContractActionKind = 'select_local_project' | 'add_workflow_script' | 'confirm_tool_connection';
const WORKFLOW_CONTRACT_ACTION_KINDS: ReadonlySet<WorkflowContractActionKind> = new Set([
  'select_local_project',
  'add_workflow_script',
  'confirm_tool_connection',
]);

function parseWorkflowContractActionKind(raw: unknown): { ok: true; kind: WorkflowContractActionKind } | { ok: false; error: string } {
  const kind = typeof raw === 'string' ? raw.trim() : '';
  if (!WORKFLOW_CONTRACT_ACTION_KINDS.has(kind as WorkflowContractActionKind)) {
    return { ok: false, error: `unknown workflow contract action: ${kind || String(raw)}` };
  }
  return { ok: true, kind: kind as WorkflowContractActionKind };
}

function normalizeWorkflowContractProjectRef(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizeWorkflowContractCliCommand(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  const prefixed = value.match(/^(?:cli|local_cli):([A-Za-z0-9._+-]{1,60})$/);
  if (prefixed?.[1]) return prefixed[1];
  const which = value.match(/^which\s+([A-Za-z0-9._+-]{1,60})$/);
  if (which?.[1]) return which[1];
  return value;
}

function workflowCliCommandFromReadinessItem(item: WorkflowToolReadinessItem): string {
  if (item.kind !== 'cli') return '';
  const explicit = item.name.match(/^(?:cli|local_cli):([A-Za-z0-9._+-]{1,60})$/)?.[1];
  if (explicit) return explicit;
  const evidence = (item.evidence ?? [])
    .find((entry) => entry.kind === 'cli_command' && /^[A-Za-z0-9._+-]{1,60}$/.test(entry.name));
  return evidence?.name ?? '';
}

function scopedWorkflowReadinessItems(
  items: WorkflowToolReadinessItem[],
  stepIds: string[] | undefined,
): WorkflowToolReadinessItem[] {
  const scoped = new Set(stepIds ?? []);
	  return items
	    .filter((item) => item.status !== 'ready')
	    .filter((item) => scoped.size === 0 || item.stepIds.some((stepId) => scoped.has(stepId)));
	}

function parseWorkflowRuntimeToolNames(body: Record<string, unknown>): string[] {
  const raw = body.tools ?? body.toolNames ?? body.tool_names ?? body.failedTools ?? body.failed_tools;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter((value) => value.length > 0 && value.length <= 160))]
    .slice(0, 20);
}

function isWorkflowRuntimeMcpTool(tool: string): boolean {
  return /^mcp/i.test(tool)
    || tool.includes('__mcp')
    || tool.includes('mcp__')
    || /^[a-z0-9][a-z0-9_.-]*__[A-Za-z0-9_.-]+/.test(tool);
}

function isWorkflowRuntimeComposioTool(tool: string): boolean {
  return /^composio/i.test(tool) || /^[A-Z0-9]+_[A-Z0-9_]+$/.test(tool);
}

function isWorkflowRuntimeCliTool(tool: string): boolean {
  return tool === 'run_shell_command'
    || tool.startsWith('local_cli_')
    || tool.startsWith('cli:')
    || tool.startsWith('local_cli:')
    || tool.endsWith('_cli')
    || tool.includes('shell')
    || tool.includes('command');
}

function runtimeWorkflowReadinessKindForTool(tool: string): WorkflowToolReadinessKind {
  if (isWorkflowRuntimeMcpTool(tool)) return 'mcp';
  if (isWorkflowRuntimeComposioTool(tool)) return 'composio';
  if (isWorkflowRuntimeCliTool(tool)) return 'cli';
  if (tool === 'read_file' || tool === 'write_file' || tool === 'list_files' || tool.startsWith('local_')) return 'local';
  return 'tool';
}

function runtimeWorkflowReadinessItems(
  toolNames: string[],
  stepIds: string[] | undefined,
): WorkflowToolReadinessItem[] {
  const scopedStepIds = stepIds && stepIds.length ? stepIds : [];
  return toolNames.map((name) => ({
    kind: runtimeWorkflowReadinessKindForTool(name),
    name,
    status: 'unknown',
    reason: 'Runtime run evidence recorded this tool on a failed or attention-needed workflow node.',
    stepIds: scopedStepIds,
    sources: ['step_call'],
    evidence: [{
      kind: runtimeWorkflowReadinessKindForTool(name) === 'mcp' ? 'mcp_server'
        : runtimeWorkflowReadinessKindForTool(name) === 'composio' ? 'composio_broker'
          : runtimeWorkflowReadinessKindForTool(name) === 'cli' ? 'cli_command'
            : 'tool_catalog',
      name,
      status: 'unknown',
      detail: 'runtime failure evidence',
    }],
  }));
}

function mergeWorkflowReadinessItems(
  base: WorkflowToolReadinessItem[],
  runtime: WorkflowToolReadinessItem[],
): WorkflowToolReadinessItem[] {
  const seen = new Set<string>();
  const merged: WorkflowToolReadinessItem[] = [];
  for (const item of [...base, ...runtime]) {
    const key = `${item.kind}:${item.name}:${[...item.stepIds].sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function workflowReadinessItemSummary(item: WorkflowToolReadinessItem): string {
  return `${item.status}: ${item.kind} ${item.name} - ${item.reason}`;
}

type WorkflowToolConnectionCheckStatus = 'ready' | 'missing' | 'unknown';
interface WorkflowToolConnectionAction {
  kind: string;
  label: string;
  detail: string;
  method?: string;
  endpoint?: string;
  command?: string;
  href?: string;
}
interface WorkflowToolConnectionCheck {
  runtime: WorkflowToolReadinessItem['kind'];
  name: string;
  status: WorkflowToolConnectionCheckStatus;
  summary: string;
  toolkitSlug?: string;
  serverName?: string;
  serverSlug?: string;
  evidence: string[];
  nextActions: WorkflowToolConnectionAction[];
}

function normalizeWorkflowToolSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function composioToolkitSlugForWorkflowTool(toolName: string): string {
  const lower = toolName.trim().toLowerCase().replace(/^composio[_:-]/, '');
  const normalizedTool = normalizeWorkflowToolSlug(lower);
  const slugs = [...new Set([
    ...CURATED_TOOLKITS.map((toolkit) => toolkit.slug),
    ...listCachedToolkits().map((toolkit) => toolkit.slug),
  ])].sort((a, b) => b.length - a.length);
  for (const slug of slugs) {
    const normalizedSlug = normalizeWorkflowToolSlug(slug);
    if (normalizedTool === normalizedSlug || normalizedTool.startsWith(`${normalizedSlug}_`)) return slug;
  }
  const first = normalizedTool.split('_').find(Boolean);
  return first ?? '';
}

function workflowMcpServerIdFromReadinessItem(item: WorkflowToolReadinessItem): string {
  if (item.kind !== 'mcp') return '';
  const mcpPrefixed = item.name.match(/^mcp__(.+?)__/i)?.[1];
  if (mcpPrefixed) return mcpPrefixed;
  const namespace = item.name.match(/^([a-z0-9][a-z0-9_.-]*)__[A-Za-z0-9_.-]+/)?.[1];
  if (namespace) return namespace;
  const evidence = (item.evidence ?? []).find((entry) => entry.kind === 'mcp_server' && entry.name.trim());
  return evidence?.name ?? '';
}

function workflowConnectionCheckLine(check: WorkflowToolConnectionCheck): string {
  const action = check.nextActions[0];
  const next = action
    ? ` Next: ${action.command || [action.method, action.endpoint].filter(Boolean).join(' ') || action.href || action.label}.`
    : '';
  return `${check.status}: ${check.runtime} ${check.name} - ${check.summary}${next}`;
}

async function workflowComposioConnectionCheck(item: WorkflowToolReadinessItem): Promise<WorkflowToolConnectionCheck> {
  const credentials = getComposioCredentialStatus();
  const toolkitSlug = composioToolkitSlugForWorkflowTool(item.name);
  const evidence = [
    credentials.apiKeyPresent ? 'COMPOSIO_API_KEY is configured.' : 'COMPOSIO_API_KEY is not configured.',
    `execution backend: ${credentials.executionBackend}`,
  ];
  const nextActions: WorkflowToolConnectionAction[] = [
    {
      kind: 'search_composio_schema',
      label: 'Search Composio schema',
      detail: 'Fetch the exact action schema before unattended execution.',
      command: `composio_search_tools query="${item.name}"`,
    },
  ];
  if (!credentials.apiKeyPresent) {
    nextActions.unshift({
      kind: 'set_composio_api_key',
      label: 'Add Composio API key',
      detail: 'Save a Composio API key in Integrations before connecting app accounts.',
      method: 'POST',
      endpoint: '/api/composio/api-key',
    });
    return {
      runtime: 'composio',
      name: item.name,
      status: 'missing',
      summary: 'Composio is not configured for this Clementine runtime.',
      ...(toolkitSlug ? { toolkitSlug } : {}),
      evidence,
      nextActions,
    };
  }

  let connected: Awaited<ReturnType<typeof listUsableConnectedToolkits>> = [];
  try {
    connected = await listUsableConnectedToolkits();
    evidence.push(`${connected.length} usable Composio connection${connected.length === 1 ? '' : 's'} found.`);
  } catch (err) {
    evidence.push(`Could not refresh connected toolkits: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (toolkitSlug) {
    const toolkitName = displayNameFor(toolkitSlug);
    const matches = connected.filter((connection) => connection.slug.toLowerCase() === toolkitSlug.toLowerCase());
    const active = matches.filter((connection) => /active|enabled|initiat/i.test(connection.status));
    evidence.push(matches.length
      ? `${matches.length} ${toolkitName} connection${matches.length === 1 ? '' : 's'} found (${matches.map((connection) => connection.status).join(', ')}).`
      : `No usable ${toolkitName} connection is currently visible.`);
    nextActions.unshift(
      {
        kind: 'refresh_composio_connections',
        label: 'Refresh Composio connections',
        detail: 'Refresh connected toolkit/account inventory after connecting or repairing the account.',
        method: 'POST',
        endpoint: '/api/composio/refresh',
      },
      {
        kind: 'open_composio_toolkit_setup',
        label: `Review ${toolkitName} setup`,
        detail: 'Open toolkit setup metadata so the user can choose OAuth or API-key setup.',
        method: 'GET',
        endpoint: `/api/composio/toolkits/${encodeURIComponent(toolkitSlug)}/setup-meta`,
      },
      {
        kind: 'authorize_composio_toolkit',
        label: `Connect ${toolkitName}`,
        detail: 'Start the Composio connection flow for this toolkit after auth config exists.',
        method: 'POST',
        endpoint: `/api/composio/toolkits/${encodeURIComponent(toolkitSlug)}/authorize`,
      },
      {
        kind: 'setup_composio_oauth',
        label: `Prepare ${toolkitName} OAuth`,
        detail: 'Create a managed OAuth auth config when Composio supports it, then authorize the toolkit.',
        method: 'POST',
        endpoint: `/api/composio/toolkits/${encodeURIComponent(toolkitSlug)}/setup-oauth`,
      },
    );
    return {
      runtime: 'composio',
      name: item.name,
      status: active.length > 0 ? 'ready' : 'missing',
      summary: active.length > 0
        ? `${toolkitName} has an active Composio connection.`
        : `${toolkitName} is not connected through Composio yet.`,
      toolkitSlug,
      evidence,
      nextActions,
    };
  }

  nextActions.unshift({
    kind: 'open_composio_auth_configs',
    label: 'Open Composio auth configs',
    detail: 'The toolkit slug could not be inferred from this action name; review Composio auth configs and schema search results.',
    href: COMPOSIO_AUTH_CONFIGS_URL,
  });
  return {
    runtime: 'composio',
    name: item.name,
    status: 'unknown',
    summary: 'Composio is configured, but the required toolkit could not be inferred from this action name.',
    evidence,
    nextActions,
  };
}

function workflowMcpConnectionCheck(item: WorkflowToolReadinessItem): WorkflowToolConnectionCheck {
  const serverId = workflowMcpServerIdFromReadinessItem(item);
  const wantedSlug = serverId ? slugifyServerName(serverId) : '';
  const servers = discoverMcpServers();
  const server = wantedSlug
    ? servers.find((candidate) => slugifyServerName(candidate.name) === wantedSlug || candidate.name === serverId || candidate.name.toLowerCase() === serverId.toLowerCase())
    : undefined;
  const health = listMcpServerHealth();
  const serverHealth = wantedSlug
    ? health.find((candidate) => candidate.slug === wantedSlug || candidate.name === serverId || candidate.name === server?.name)
    : undefined;
  const evidence = [
    serverId ? `required server namespace: ${serverId}` : 'no server namespace could be inferred from the tool name.',
    `${servers.length} MCP server${servers.length === 1 ? '' : 's'} configured.`,
  ];
  const nextActions: WorkflowToolConnectionAction[] = [
    {
      kind: 'inspect_mcp_status',
      label: 'Inspect MCP status',
      detail: 'List configured MCP servers and credential key names.',
      command: serverId ? `mcp_status query="${serverId}"` : 'mcp_status',
    },
  ];
  if (!server) {
    nextActions.push({
      kind: 'add_mcp_server',
      label: 'Add MCP server',
      detail: 'Create a Clementine-managed MCP server config, then enter any required credentials in Settings.',
      command: serverId ? `mcp_add name="${serverId}" ...` : 'mcp_add ...',
    });
    return {
      runtime: 'mcp',
      name: item.name,
      status: 'missing',
      summary: serverId ? `No configured MCP server matched "${serverId}".` : 'No MCP server namespace could be matched.',
      ...(serverId ? { serverSlug: wantedSlug } : {}),
      evidence,
      nextActions,
    };
  }

  const envStatus = serverEnvStatus(server);
  evidence.push(`server "${server.name}" is ${server.enabled === false ? 'disabled' : 'enabled'}.`);
  evidence.push(`connection state: ${serverHealth?.state ?? 'unknown'}.`);
  if (serverHealth?.lastError) evidence.push(`last error: ${serverHealth.lastError}`);
  if (envStatus.declaredEnvKeys.length) evidence.push(`declared credential keys: ${envStatus.declaredEnvKeys.join(', ')}.`);
  if (envStatus.unsetEnvKeys.length) evidence.push(`unset credential keys: ${envStatus.unsetEnvKeys.join(', ')}.`);
  if (server.enabled === false) {
    nextActions.push({
      kind: 'enable_mcp_server',
      label: `Enable ${server.name}`,
      detail: 'Enable this MCP server in the Integrations hub.',
      method: 'PATCH',
      endpoint: `/api/console/mcp-servers/${encodeURIComponent(server.name)}`,
    });
  }
  if (envStatus.unsetEnvKeys.length) {
    nextActions.push({
      kind: 'set_mcp_credentials',
      label: `Enter ${server.name} credentials`,
      detail: `Enter values for: ${envStatus.unsetEnvKeys.join(', ')}.`,
      method: 'POST',
      endpoint: `/api/console/mcp-servers/${encodeURIComponent(server.name)}/credential`,
    });
  }
  if (serverHealth?.state === 'degraded' || serverHealth?.state === 'unavailable') {
    nextActions.push({
      kind: 'reconnect_mcp',
      label: `Reconnect ${server.name}`,
      detail: 'Clear MCP backoff/cache so the server reconnects on the next tool call.',
      method: 'POST',
      endpoint: `/api/console/mcp-servers/${encodeURIComponent(server.name)}/reconnect`,
      command: `mcp_reconnect server_name="${server.name}"`,
    });
  }
  const connected = server.enabled !== false && envStatus.unsetEnvKeys.length === 0 && serverHealth?.state === 'connected';
  const missing = server.enabled === false || envStatus.unsetEnvKeys.length > 0 || serverHealth?.state === 'unavailable';
  return {
    runtime: 'mcp',
    name: item.name,
    status: connected ? 'ready' : missing ? 'missing' : 'unknown',
    summary: connected
      ? `MCP server "${server.name}" is connected.`
      : server.enabled === false
        ? `MCP server "${server.name}" is disabled.`
        : envStatus.unsetEnvKeys.length
          ? `MCP server "${server.name}" needs credential values before it can connect.`
          : `MCP server "${server.name}" is ${serverHealth?.state ?? 'not health-checked yet'}.`,
    serverName: server.name,
    serverSlug: slugifyServerName(server.name),
    evidence,
    nextActions,
  };
}

async function workflowConnectionCheckForItem(item: WorkflowToolReadinessItem): Promise<WorkflowToolConnectionCheck> {
  if (item.kind === 'composio') return workflowComposioConnectionCheck(item);
  if (item.kind === 'mcp') return workflowMcpConnectionCheck(item);
  return {
    runtime: item.kind,
    name: item.name,
    status: item.status === 'ready' ? 'ready' : item.status === 'missing' ? 'missing' : 'unknown',
    summary: item.reason || 'Runtime tool availability is not confirmed.',
    evidence: (item.evidence ?? []).map((entry) => `${entry.kind}:${entry.name}=${entry.status}${entry.detail ? ` (${entry.detail})` : ''}`),
    nextActions: [{
      kind: 'inspect_runtime_tool',
      label: 'Inspect runtime tool',
      detail: 'Verify this tool exists in the active Clementine runtime catalog.',
    }],
  };
}

function resolveWorkspaceProjectForContractAction(ref: string): { ok: true; project: { name: string; path: string; type?: string } } | { ok: false; error: string; projects: Array<{ name: string; path: string; type?: string }> } {
  const projects = listWorkspaceProjects().map((project) => ({
    name: project.name,
    path: project.path,
    ...(project.type ? { type: project.type } : {}),
  }));
  const wanted = ref.trim().toLowerCase();
  const wantedSlug = wanted.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const project = projects.find((candidate) => {
    const aliases = [candidate.name, candidate.path, path.basename(candidate.path)]
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    return aliases.some((alias) => alias === wanted || alias.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') === wantedSlug);
  });
  return project ? { ok: true, project } : { ok: false, error: `workspace project not found: ${ref}`, projects };
}

function normalizeWorkflowScriptRunner(raw: unknown): { ok: true; runner: string; relativePath: string } | { ok: false; error: string } {
  const value = typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : '';
  if (!value) return { ok: false, error: 'runner required' };
  if (value.length > 180) return { ok: false, error: 'runner is too long' };
  if (/\s/.test(value)) return { ok: false, error: 'runner must be a scripts/ path without inline arguments' };
  if (path.posix.isAbsolute(value)) return { ok: false, error: 'runner must be relative to the workflow scripts directory' };
  const stripped = value.startsWith('scripts/') ? value.slice('scripts/'.length) : value;
  const normalized = path.posix.normalize(stripped);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return { ok: false, error: 'runner must stay inside the workflow scripts directory' };
  }
  if (normalized.startsWith('.')) return { ok: false, error: 'runner must not be hidden or parent-relative' };
  return { ok: true, runner: normalized, relativePath: normalized };
}

function resolveWorkflowScriptFile(workflowSlug: string, runner: string): { ok: true; scriptsDir: string; filePath: string } | { ok: false; error: string } {
  if (!/^[A-Za-z0-9_.-]+$/.test(workflowSlug)) return { ok: false, error: 'invalid workflow slug' };
  const scriptsDir = path.resolve(WORKFLOWS_DIR, workflowSlug, 'scripts');
  const filePath = path.resolve(scriptsDir, runner);
  if (filePath !== scriptsDir && !filePath.startsWith(scriptsDir + path.sep)) {
    return { ok: false, error: 'runner resolved outside the workflow scripts directory' };
  }
  return { ok: true, scriptsDir, filePath };
}

function workflowStepScopeForAction(def: WorkflowDefinition, stepIds: string[] | undefined): Set<string> {
  const scoped = new Set((stepIds ?? []).filter(Boolean));
  if (scoped.size > 0) return scoped;
  const deterministicSteps = def.steps.filter((step) => step.deterministic?.runner).map((step) => step.id);
  return new Set(deterministicSteps.length === 1 ? deterministicSteps : []);
}

function workflowReadinessBlockedBody(
  message: string,
  readiness: WorkflowRunReadinessCheck | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    error: message,
    message,
    ...extra,
    ...(readiness ? {
      readiness: {
        ok: readiness.ok,
        blockers: readiness.blockers,
        warnings: readiness.warnings,
        toolReadiness: readiness.plan.toolReadiness,
      },
      executionPlan: readiness.plan,
    } : {}),
  };
}

function positiveEnvInt(key: string, fallback: number): number {
  const raw = getRuntimeEnv(key, String(fallback));
  const n = parseInt(raw || String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WORKFLOW_GRAPH_HARNESS_EVENT_TYPES: EventType[] = [
  'tool_called',
  'approval_requested',
  'approval_resolved',
  'external_write',
  'external_write_failed',
  'external_write_orphaned',
  'worker_result',
  'worker_capped',
  'worker_model_routed',
  'turn_model_routed',
  'brain_fallover',
  'goal_validation',
  'goal_alignment_judged',
  'output_grounding_judged',
  'guardrail_tripped',
  'stuck_detected',
];

function workflowGraphHarnessEvidence(runId: string): Array<{
  sessionId: string;
  stepId?: string;
  status?: string;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}> {
  if (!runId) return [];
  const out: Array<{
    sessionId: string;
    stepId?: string;
    status?: string;
    events: Array<{ type: string; data: Record<string, unknown> }>;
  }> = [];
  for (let offset = 0; ; offset += 500) {
    const page = listHarnessSessions({ kind: 'workflow', status: 'any', limit: 500, offset });
    for (const session of page) {
      if (session.metadata?.workflowRunId !== runId) continue;
      const stepId = typeof session.metadata.stepId === 'string' ? session.metadata.stepId : undefined;
      const events = listHarnessEvents(session.id, {
        types: WORKFLOW_GRAPH_HARNESS_EVENT_TYPES,
        limit: 2000,
      }).map((event) => ({ type: event.type, data: event.data }));
      out.push({ sessionId: session.id, stepId, status: session.status, events });
    }
    if (page.length < 500) break;
  }
  return out;
}

function workflowFailureSummary(workflowSlug: string, runId: string): BoardFailureSummary | undefined {
  const failed = listFinalFailedItems(workflowSlug, runId);
  if (failed.length === 0) return undefined;
  return {
    failedItems: failed.length,
    retryable: true,
    reason: `${failed.length} failed item${failed.length === 1 ? '' : 's'} can be retried without rerunning successful items.`,
  };
}

function workflowRunRecovery(workflowSlug: string, runId: string): {
  artifactSummary?: BoardArtifactSummary;
  failureSummary?: BoardFailureSummary;
  primaryAction: BoardPrimaryAction;
  continueMode: BoardContinueMode;
  nextSafeAction: string;
} {
  const summary = workflowRunSummary(workflowSlug, runId);
  const failureSummary = workflowFailureSummary(workflowSlug, runId);
  if (failureSummary?.retryable) {
    return {
      artifactSummary: summary.artifactSummary,
      failureSummary,
      primaryAction: 'retry_failed_items',
      continueMode: 'workflow_failed_items',
      nextSafeAction: 'Retry only the failed items; completed items stay cached.',
    };
  }
  if (summary.artifactSummary) {
    return {
      artifactSummary: summary.artifactSummary,
      primaryAction: 'open_result',
      continueMode: 'open_result',
      nextSafeAction: 'Review the produced files, URLs, and counts.',
    };
  }
  return {
    artifactSummary: undefined,
    failureSummary: undefined,
    primaryAction: 'none',
    continueMode: 'none',
    nextSafeAction: summary.because ? `Run summary: ${summary.because}` : 'Open the trace to review the run.',
  };
}

function boardActionForStatus(sourceKind: BoardCard['sourceKind'], status: string, hasApproval: boolean): {
  primaryAction: BoardPrimaryAction;
  continueMode: BoardContinueMode;
  nextSafeAction?: string;
} {
  if (hasApproval || status === 'awaiting_approval') {
    return {
      primaryAction: 'approve',
      continueMode: 'approval',
      nextSafeAction: sourceKind === 'workflow'
        ? 'Approve or reject; the workflow runner resumes the parked step.'
        : 'Approve or reject; Clementine continues from the paused tool call.',
    };
  }
  if (status === 'awaiting_continue' || status === 'paused'
    || (sourceKind === 'background' && (status === 'interrupted' || status === 'failed' || status === 'aborted'))) {
    return {
      primaryAction: 'continue',
      continueMode: sourceKind === 'background' ? 'background' : 'workflow_resume',
      nextSafeAction: 'Continue with a fresh budget from the last saved state.',
    };
  }
  return { primaryAction: 'none', continueMode: 'none' };
}

const CONSOLE_HARNESS_REPLAY_TYPES = new Set<HarnessEventRow['type']>([
  'turn_started',
  'tool_called',
  'tool_returned',
  'heartbeat',
  'handoff',
  'approval_requested',
  'approval_resolved',
  'run_completed',
  'conversation_completed',
  // Parse-exhaustion recovery marker — must replay so a reopened session's
  // transcript reconstruction can suppress the superseded apology turn and
  // render only the recovered reply (matches reconstructHarnessTranscript).
  'conversation_superseded',
  'run_failed',
  'guardrail_tripped',
  'stuck_detected',
]);

function isDiscordHarnessSession(session: HarnessSessionRow): boolean {
  return session.channel === 'discord'
    || session.channel === 'discord-dm'
    || session.metadata.source === 'discord';
}

function isConsoleVisibleHarnessSession(session: HarnessSessionRow): boolean {
  return session.kind === 'chat'
    || session.kind === 'workflow'
    || session.status === 'active'
    || session.status === 'paused'
    || isDiscordHarnessSession(session)
    || session.channel === 'workflow'
    || session.metadata.source === 'workflow'
    || session.metadata.source === 'desktop';
}

function harnessSessionSourceLabel(session: HarnessSessionRow): string {
  if (isDiscordHarnessSession(session)) return 'Discord';
  if (session.kind === 'workflow' || session.channel === 'workflow' || session.metadata.source === 'workflow') return 'Workflow';
  return session.channel || session.kind;
}

// isHarnessSessionCurrentlyWorking (+ its terminal-event helper) moved to
// src/shared/activity-snapshot.ts so the command center, Slack, and Discord
// share one definition of "mid-turn right now". Imported above; behavior is
// identical (status='active' + fresh non-terminal event within the window).

const ACTIVE_WORK_SESSION_PAGE_SIZE = 500;

function listVisibleActiveWorkHarnessSessions(pendingSessionIds: Set<string>): HarnessSessionRow[] {
  const out: HarnessSessionRow[] = [];
  for (let offset = 0; ; offset += ACTIVE_WORK_SESSION_PAGE_SIZE) {
    const page = listHarnessSessions({
      kind: ['workflow', 'execution', 'agent'],
      status: ['active', 'paused'],
      limit: ACTIVE_WORK_SESSION_PAGE_SIZE,
      offset,
    });
    for (const session of page) {
      if (!isIgnorableActiveWorkSession(session, { pendingSessionIds })) {
        out.push(session);
      }
    }
    if (page.length < ACTIVE_WORK_SESSION_PAGE_SIZE) break;
  }
  return out;
}

function actionEventTime(event: ActionEvent): string {
  if (event.kind === 'run.event') return event.event.createdAt;
  if (event.kind === 'harness.event') return event.event.createdAt;
  if (event.kind === 'notification.created') return event.notification.createdAt;
  if (event.kind === 'approval.created') return event.approval.createdAt;
  if (event.kind === 'approval.resolved') return event.approval.createdAt;
  return new Date().toISOString();
}

function readContextFile(def: ContextFileDefinition): Record<string, unknown> {
  const exists = fs.existsSync(def.filePath);
  const content = exists ? fs.readFileSync(def.filePath, 'utf-8') : '';
  const bytes = Buffer.byteLength(content, 'utf-8');
  const usefulChars = content.trim().length;
  return {
    key: def.key,
    title: def.title,
    description: def.description,
    path: def.filePath,
    exists,
    bytes,
    usefulChars,
    empty: usefulChars < def.minUsefulChars,
    content,
    // Surface presets to the dashboard so the editor can offer a
    // one-click starter dropdown. Empty array if the file has no
    // presets configured (working memory + long-term memory don't).
    presets: def.presets ?? [],
  };
}

function readContextGoals(): Array<Record<string, unknown>> {
  ensureDir(GOALS_DIR);
  return fs.readdirSync(GOALS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(GOALS_DIR, file), 'utf-8')) as Record<string, unknown>;
        return parsed;
      } catch {
        return null;
      }
    })
    .filter((goal): goal is Record<string, unknown> => goal !== null)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

function stringsFromBody(value: unknown, limit = 12): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, limit);
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, limit);
  }
  return [];
}

function numberFromBody(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function deadlineFromBody(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function isGoalContract(record: PlanProposal): boolean {
  if (record.status === 'active' || record.status === 'satisfied' || record.status === 'expired') return true;
  return Boolean(record.origin || record.evidence?.length || record.progressLedger?.length || record.selfDriving || record.parked);
}

function goalUpdatedAt(record: PlanProposal): string {
  return record.lastActivityAt ?? record.resolvedAt ?? record.proposedAt;
}

function goalActions(record: PlanProposal): string[] {
  if (record.status !== 'active') return [];
  return [
    record.selfDriving ? 'disable_self_drive' : 'enable_self_drive',
    record.parked ? 'unpark' : 'park',
    'satisfy',
    'expire',
  ];
}

function summarizeGoal(record: PlanProposal): Record<string, unknown> {
  const plan = record.approvedPlan ?? record.plan;
  const currentStage = getCurrentGoalStage(record);
  const stages = record.stages ?? [];
  const stageDone = stages.filter((stage) => stage.status === 'done').length;
  const evidence = record.evidence ?? [];
  const active = record.status === 'active';
  const selfDriving = active && record.selfDriving === true;
  return {
    id: record.id,
    status: record.status,
    objective: plan.objective,
    successCriteria: plan.successCriteria ?? [],
    steps: plan.steps ?? [],
    risks: plan.risks ?? [],
    origin: record.origin ?? null,
    sessionId: record.sessionId ?? null,
    channel: record.channel ?? null,
    createdAt: record.proposedAt,
    updatedAt: goalUpdatedAt(record),
    resolvedAt: record.resolvedAt ?? null,
    doneReason: record.doneReason ?? record.rejectionReason ?? null,
    selfDriving,
    nextResumeAt: selfDriving ? record.nextResumeAt ?? null : null,
    resumeEveryMs: selfDriving ? record.resumeEveryMs ?? null : null,
    resumeCount: record.resumeCount ?? 0,
    maxResumes: record.maxResumes ?? null,
    noProgressStreak: record.noProgressStreak ?? 0,
    deadlineAt: record.deadlineAt ?? null,
    parked: record.parked ?? null,
    attempt: record.attempt ?? 0,
    maxAttempts: record.maxAttempts ?? null,
    progressLedger: (record.progressLedger ?? []).slice(-8),
    stages,
    currentStage,
    stageProgress: stages.length > 0 ? { done: stageDone, total: stages.length } : null,
    evidenceSummary: {
      total: evidence.length,
      passed: evidence.filter((item) => item.pass).length,
      failed: evidence.filter((item) => !item.pass).length,
      latest: evidence.slice(-5),
    },
    actions: goalActions(record),
  };
}

function buildGoalsPayload(filter: string | undefined): Record<string, unknown> {
  const all = listPlanProposals({ status: 'all' })
    .filter(isGoalContract)
    .sort((a, b) => goalUpdatedAt(b).localeCompare(goalUpdatedAt(a)));
  const goals = all.filter((goal) => {
    if (filter === 'active') return goal.status === 'active' && !goal.parked;
    if (filter === 'parked') return goal.status === 'active' && Boolean(goal.parked);
    if (filter === 'terminal') return goal.status === 'satisfied' || goal.status === 'expired';
    if (filter === 'self_driving') return goal.status === 'active' && Boolean(goal.selfDriving);
    return true;
  });
  return {
    goals: goals.map(summarizeGoal),
    counts: {
      total: all.length,
      active: all.filter((goal) => goal.status === 'active' && !goal.parked).length,
      parked: all.filter((goal) => goal.status === 'active' && Boolean(goal.parked)).length,
      selfDriving: all.filter((goal) => goal.status === 'active' && Boolean(goal.selfDriving)).length,
      satisfied: all.filter((goal) => goal.status === 'satisfied').length,
      expired: all.filter((goal) => goal.status === 'expired').length,
    },
    generatedAt: new Date().toISOString(),
  };
}

function realtimeNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = getRuntimeEnv(name, String(fallback));
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}


/**
 * Tools the Workflow Architect chat is forbidden from calling. The
 * architect must propose changes as JSON diff ops the user applies
 * from the UI — never write to disk directly. This list is passed to
 * assistant.respond({ excludeToolNames }) so the runtime drops these
 * names from the tool surface before the model sees them, regardless
 * of what the prompt says.
 *
 * Keep in sync with src/tools/orchestration-tools.ts — any new
 * workflow_* mutation tool should be added here.
 */
const ARCHITECT_HIDDEN_TOOLS = [
  'workflow_create',
  'workflow_update',
  'workflow_apply_contract_fixes',
  'workflow_edit_step',
  'workflow_set_enabled',
  'workflow_delete',
  'workflow_run',
];

function validateWorkflowDefinition(data: WorkflowFrontmatter): WorkflowValidation {
  // Tool catalog lookup for slug checks: feed the validator the
  // canonical tool names so it can warn on hallucinated slugs in step
  // prompts (e.g. "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND" when the
  // real catalog has "GOOGLESHEETS_BATCH_UPDATE"). If the catalog
  // isn't reachable for any reason, the slug check is skipped — the
  // rest of the validator still runs.
  let knownToolNames: Set<string> | undefined;
  try {
    knownToolNames = new Set(LOCAL_MCP_TOOL_NAMES as readonly string[]);
  } catch {
    knownToolNames = undefined;
  }
  return runValidator(data, { knownToolNames });
}

function mergeWorkflowStepsForPatch(existingSteps: WorkflowDefinition['steps'], incomingSteps: unknown[]): WorkflowDefinition['steps'] {
  const existingById = new Map<string, WorkflowDefinition['steps'][number]>();
  for (const step of existingSteps) {
    if (step && typeof step.id === 'string') existingById.set(step.id, step);
  }
  return incomingSteps.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw as WorkflowDefinition['steps'][number];
    const incoming = raw as Partial<WorkflowDefinition['steps'][number]> & Record<string, unknown>;
    const prior = typeof incoming.id === 'string' ? existingById.get(incoming.id) : undefined;
    return (prior ? { ...prior, ...incoming } : { ...incoming }) as WorkflowDefinition['steps'][number];
  });
}

function dashboardWorkflowSmokeInputs(body: Record<string, unknown>): Record<string, string> {
  const raw = body.testInputs ?? body.test_inputs;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, value == null ? '' : String(value)]));
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value == null ? '' : String(value)]));
  }
  return {};
}

function workflowGoalFromDashboardBody(raw: unknown): WorkflowGoal | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
  if (objective.length < 4) return undefined;
  const rawCriteria = body.successCriteria ?? body.success_criteria;
  const successCriteria = Array.isArray(rawCriteria)
    ? rawCriteria.map((criterion) => String(criterion).trim()).filter(Boolean)
    : undefined;
  const out: WorkflowGoal = { objective };
  if (successCriteria && successCriteria.length > 0) out.successCriteria = successCriteria;
  const rawMax = body.maxAttempts ?? body.max_attempts;
  if (typeof rawMax === 'number' && Number.isFinite(rawMax)) out.maxAttempts = clampGoalMaxAttempts(rawMax);
  return out;
}

interface WorkflowRunRecordSummary extends WorkflowProofRun {
  recoveryIntent?: WorkflowRunRecoveryIntentOverlay | null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

const WORKFLOW_RUN_RECOVERY_BODY_KINDS = new Set([
  'step_try',
  'failed_items',
  'safe_rerun',
  'execution_optimize',
  'goal_rerun',
  'self_heal',
  'manual_requeue',
]);

function workflowRunRecoveryKindField(value: unknown): string | null {
  const kind = stringField(value);
  return kind && WORKFLOW_RUN_RECOVERY_BODY_KINDS.has(kind) ? kind : null;
}

function workflowRunRecoveryIntentFromBody(
  body: unknown,
  fallback: QueueWorkflowRunRecoveryIntentInput,
): QueueWorkflowRunRecoveryIntentInput {
  const row = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const raw = row.recoveryIntent && typeof row.recoveryIntent === 'object' && !Array.isArray(row.recoveryIntent)
    ? row.recoveryIntent as Record<string, unknown>
    : {};
  return {
    kind: workflowRunRecoveryKindField(raw.kind) ?? fallback.kind,
    sourceRunId: stringField(raw.sourceRunId) ?? fallback.sourceRunId,
    sourceStepId: stringField(raw.sourceStepId) ?? fallback.sourceStepId,
    requestedFrom: stringField(raw.requestedFrom) ?? stringField(row.recoveryRequestedFrom) ?? fallback.requestedFrom,
    reason: stringField(raw.reason) ?? stringField(row.recoveryReason) ?? fallback.reason,
  };
}

function normalizeWorkflowRunRecord(raw: Record<string, unknown>): WorkflowRunRecordSummary | null {
  const id = stringField(raw.id);
  const workflow = stringField(raw.workflow);
  if (!id || !workflow) return null;
  const recoveryIntent = normalizeWorkflowRunRecoveryIntent(raw.recoveryIntent);
  return {
    id,
    workflow,
    status: stringField(raw.status) ?? 'unknown',
    createdAt: stringField(raw.createdAt),
    startedAt: stringField(raw.startedAt),
    finishedAt: stringField(raw.finishedAt) ?? stringField(raw.completedAt),
    source: stringField(raw.source),
    error: stringField(raw.error),
    targetStepId: stringField(raw.targetStepId),
    needsAttention: raw.needsAttention === true,
    ...(recoveryIntent ? { recoveryIntent } : {}),
  };
}

const WORKFLOW_READINESS_KINDS = new Set<WorkflowToolReadinessKind>(['tool', 'composio', 'mcp', 'cli', 'local', 'skill', 'script', 'project']);
const WORKFLOW_READINESS_STATUSES = new Set<WorkflowToolReadinessStatus>(['ready', 'missing', 'unknown']);
const WORKFLOW_READINESS_EVIDENCE_KINDS = new Set<WorkflowToolReadinessEvidence['kind']>([
  'tool_catalog',
  'composio_broker',
  'mcp_server',
  'cli_command',
  'skill',
  'script',
  'project',
]);

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
    : [];
}

function normalizeWorkflowReadinessEvidence(value: unknown): WorkflowToolReadinessEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const evidence = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const row = entry as Record<string, unknown>;
      const kind = stringField(row.kind);
      const name = stringField(row.name);
      const status = stringField(row.status);
      if (!kind || !name || !status || !WORKFLOW_READINESS_STATUSES.has(status as WorkflowToolReadinessStatus)) return null;
      if (!WORKFLOW_READINESS_EVIDENCE_KINDS.has(kind as WorkflowToolReadinessEvidence['kind'])) return null;
      return {
        kind: kind as WorkflowToolReadinessEvidence['kind'],
        name,
        status: status as WorkflowToolReadinessStatus,
        ...(stringField(row.detail) ? { detail: stringField(row.detail)! } : {}),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  return evidence.length ? evidence : undefined;
}

function normalizeWorkflowReadinessItem(value: unknown): WorkflowToolReadinessItem | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const kind = stringField(row.kind);
  const name = stringField(row.name);
  const status = stringField(row.status);
  if (!kind || !name || !status) return null;
  if (!WORKFLOW_READINESS_KINDS.has(kind as WorkflowToolReadinessKind)) return null;
  if (!WORKFLOW_READINESS_STATUSES.has(status as WorkflowToolReadinessStatus)) return null;
  const stepIds = stringArrayField(row.stepIds);
  const sources = stringArrayField(row.sources);
  const evidence = normalizeWorkflowReadinessEvidence(row.evidence);
  return {
    kind: kind as WorkflowToolReadinessKind,
    name,
    status: status as WorkflowToolReadinessStatus,
    reason: stringField(row.reason) ?? '',
    stepIds,
    ...(sources.length ? { sources: sources as WorkflowToolReadinessItem['sources'] } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function normalizeWorkflowToolReadiness(value: unknown): WorkflowToolReadiness | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const items = Array.isArray(row.items)
    ? row.items.map(normalizeWorkflowReadinessItem).filter((item): item is WorkflowToolReadinessItem => Boolean(item))
    : [];
  const missingCount = Number.isFinite(Number(row.missingCount)) ? Number(row.missingCount) : items.filter((item) => item.status === 'missing').length;
  const unknownCount = Number.isFinite(Number(row.unknownCount)) ? Number(row.unknownCount) : items.filter((item) => item.status === 'unknown').length;
  const readyCount = Number.isFinite(Number(row.readyCount)) ? Number(row.readyCount) : items.filter((item) => item.status === 'ready').length;
  return {
    ready: typeof row.ready === 'boolean' ? row.ready : missingCount === 0 && unknownCount === 0,
    readyCount,
    missingCount,
    unknownCount,
    items,
  };
}

function normalizeWorkflowLaunchReadiness(value: unknown): WorkflowRunLaunchReadinessOverlay | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.ok !== 'boolean') return null;
  const scope = row.scope === 'run' || row.scope === 'step' ? row.scope : 'unknown';
  const blockers = Array.isArray(row.blockers)
    ? row.blockers.map(normalizeWorkflowReadinessItem).filter((item): item is WorkflowToolReadinessItem => Boolean(item))
    : [];
  const warnings = Array.isArray(row.warnings)
    ? row.warnings.map(normalizeWorkflowReadinessItem).filter((item): item is WorkflowToolReadinessItem => Boolean(item))
    : [];
  const toolReadiness = normalizeWorkflowToolReadiness(row.toolReadiness);
  return {
    ok: row.ok,
    scope,
    blockers,
    warnings,
    ...(stringField(row.checkedAt) ? { checkedAt: stringField(row.checkedAt)! } : {}),
    ...(stringField(row.targetStepId) ? { targetStepId: stringField(row.targetStepId)! } : {}),
    ...(toolReadiness ? { toolReadiness } : {}),
  };
}

function readWorkflowRunLaunchReadiness(runId: string, workflowNames: string[]): WorkflowRunLaunchReadinessOverlay | null {
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  if (!safe) return null;
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const workflow = stringField(raw.workflow);
    if (workflow && workflowNames.length && !workflowNames.includes(workflow)) return null;
    return normalizeWorkflowLaunchReadiness(raw.readiness);
  } catch {
    return null;
  }
}

function normalizeWorkflowRunRecoveryIntent(value: unknown): WorkflowRunRecoveryIntentOverlay | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const kind = stringField(row.kind);
  if (!kind) return null;
  return {
    kind,
    ...(stringField(row.createdAt) ? { createdAt: stringField(row.createdAt)! } : {}),
    ...(stringField(row.sourceRunId) ? { sourceRunId: stringField(row.sourceRunId)! } : {}),
    ...(stringField(row.sourceStepId) ? { sourceStepId: stringField(row.sourceStepId)! } : {}),
    ...(stringField(row.requestedFrom) ? { requestedFrom: stringField(row.requestedFrom)! } : {}),
    ...(stringField(row.reason) ? { reason: stringField(row.reason)! } : {}),
  };
}

function readWorkflowRunRecoveryIntent(runId: string, workflowNames: string[]): WorkflowRunRecoveryIntentOverlay | null {
  const safe = runId.replace(/[^a-zA-Z0-9_.:-]/g, '');
  if (!safe) return null;
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${safe}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const workflow = stringField(raw.workflow);
    if (workflow && workflowNames.length && !workflowNames.includes(workflow)) return null;
    return normalizeWorkflowRunRecoveryIntent(raw.recoveryIntent);
  } catch {
    return null;
  }
}

function readWorkflowRunRecords(): WorkflowRunRecordSummary[] {
  if (!fs.existsSync(WORKFLOW_RUNS_DIR)) return [];
  const records: WorkflowRunRecordSummary[] = [];
  for (const file of fs.readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
      const normalized = normalizeWorkflowRunRecord(raw);
      if (normalized) records.push(normalized);
    } catch {
      // Malformed run records should not break the Workflows home page.
    }
  }
  records.sort((a, b) => String(b.createdAt ?? b.startedAt ?? '').localeCompare(String(a.createdAt ?? a.startedAt ?? '')));
  return records;
}

function readWorkflowRunRecord(runId: string): WorkflowRunRecordSummary | null {
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  return normalizeWorkflowRunRecord(raw);
}

function expandCronField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  const addRange = (start: number, end: number, step = 1): boolean => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end || step < 1) return false;
    for (let n = start; n <= end; n += step) values.add(n);
    return true;
  };
  for (const part of field.split(',')) {
    if (!part) return null;
    if (part === '*') {
      if (!addRange(min, max)) return null;
      continue;
    }
    const stepMatch = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      const step = Number.parseInt(stepMatch[2], 10);
      if (stepMatch[1] === '*') {
        if (!addRange(min, max, step)) return null;
      } else {
        const [a, b] = stepMatch[1].split('-').map((x) => Number.parseInt(x, 10));
        if (!addRange(a, b, step)) return null;
      }
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      if (!addRange(Number.parseInt(rangeMatch[1], 10), Number.parseInt(rangeMatch[2], 10))) return null;
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = Number.parseInt(part, 10);
      if (n < min || n > max) return null;
      values.add(n);
      continue;
    }
    return null;
  }
  return Array.from(values).sort((a, b) => a - b);
}

function expandCronDow(field: string): number[] | null {
  const raw = expandCronField(field, 0, 7);
  if (!raw) return null;
  return Array.from(new Set(raw.map((n) => (n === 7 ? 0 : n)))).sort((a, b) => a - b);
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function upcomingWorkflowOccurrences(
  workflows: ReturnType<typeof listWorkflows>,
  now = new Date(),
  daysAhead = 7,
): Array<{ workflowName: string; at: string; day: string; time: string; schedule: string }> {
  const out: Array<{ workflowName: string; at: string; day: string; time: string; schedule: string }> = [];
  const start = new Date(now);
  start.setSeconds(0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + daysAhead + 1);
  end.setHours(23, 59, 59, 999);

  for (const entry of workflows) {
    const schedule = entry.data.trigger.schedule?.trim();
    if (!entry.data.enabled || !schedule) continue;
    const parts = schedule.split(/\s+/);
    if (parts.length !== 5) continue;
    const [minuteField, hourField, domField, monthField, dowField] = parts;
    if (domField !== '*' || monthField !== '*') continue;
    const minutes = expandCronField(minuteField, 0, 59);
    const hours = expandCronField(hourField, 0, 23);
    const dows = expandCronDow(dowField);
    if (!minutes || !hours || !dows) continue;

    for (let offset = 0; offset <= daysAhead; offset += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + offset);
      const dow = day.getDay();
      if (dowField !== '*' && !dows.includes(dow)) continue;
      for (const hour of hours) {
        for (const minute of minutes) {
          const at = new Date(day);
          at.setHours(hour, minute, 0, 0);
          if (at < start || at > end) continue;
          out.push({
            workflowName: entry.data.name,
            at: at.toISOString(),
            day: formatLocalDate(at),
            time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
            schedule,
          });
        }
      }
    }
  }

  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.slice(0, 100);
}


/**
 * Resolve a user-requested file path inside a linked project, with hard
 * containment. Pure + dependency-free so it can be unit-tested directly:
 * the Express routes pass in the live workspace dirs + homedir.
 *
 * Guarantees:
 *   - `root` must be a configured workspace dir or a directory under one
 *     (no reading arbitrary disk locations).
 *   - the resolved target can never escape `root` via `..` or symlink-y
 *     relative paths — only `root` itself or paths strictly beneath it.
 */
export type ProjectPathGuard =
  | { ok: true; root: string; target: string }
  | { ok: false; status: number; error: string };

export function resolveProjectFilePath(
  workspaceDirs: string[],
  homedir: string,
  rawRoot: string,
  rel: string,
): ProjectPathGuard {
  if (!rawRoot) return { ok: false, status: 400, error: 'root query param required' };
  const expanded = rawRoot.startsWith('~') ? path.join(homedir, rawRoot.slice(1)) : rawRoot;
  const absRoot = path.resolve(expanded);
  const allowed = workspaceDirs
    .map((d) => path.resolve(d))
    .some((d) => absRoot === d || absRoot.startsWith(d + path.sep));
  if (!allowed) return { ok: false, status: 403, error: 'root is not a linked workspace' };
  const target = path.resolve(absRoot, rel || '.');
  if (target !== absRoot && !target.startsWith(absRoot + path.sep)) {
    return { ok: false, status: 400, error: 'path escapes project root' };
  }
  return { ok: true, root: absRoot, target };
}

/**
 * Bounded content search inside a project root. Pure + synchronous so it
 * can be unit-tested. Skips heavy/irrelevant dirs, caps depth, files
 * scanned, file size, and total matches so a `grep` over a huge repo can
 * never hang the daemon event loop or return an unbounded payload.
 */
export interface GrepMatch { rel: string; line: number; text: string }
export interface GrepResult { matches: GrepMatch[]; filesScanned: number; truncated: boolean }

const GREP_SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.turbo', 'dist', 'build', '.venv', '.cache',
  '__pycache__', 'venv', 'env', 'coverage', '.idea', '.vscode', 'release',
]);

export function grepProjectFiles(
  root: string,
  query: string,
  opts: { maxDepth?: number; maxFiles?: number; maxMatches?: number; maxFileBytes?: number } = {},
): GrepResult {
  const needle = query.toLowerCase();
  const maxDepth = opts.maxDepth ?? 8;
  const maxFiles = opts.maxFiles ?? 2000;
  const maxMatches = opts.maxMatches ?? 200;
  const maxFileBytes = opts.maxFileBytes ?? 512 * 1024;
  const matches: GrepMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (truncated) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (GREP_SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (filesScanned >= maxFiles) { truncated = true; return; }
      const full = path.join(dir, e.name);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > maxFileBytes) continue;
      let buf: Buffer;
      try { buf = fs.readFileSync(full); } catch { continue; }
      if (buf.subarray(0, 8192).includes(0)) continue; // binary
      filesScanned++;
      const lines = buf.toString('utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ rel: path.relative(root, full), line: i + 1, text: lines[i].slice(0, 240) });
          if (matches.length >= maxMatches) { truncated = true; return; }
        }
      }
    }
  };
  walk(root, 0);
  return { matches, filesScanned, truncated };
}

/** The four columns of the unified background-work board. */
type BoardColumnId = 'queued' | 'running' | 'needs_you' | 'done';
type BoardPrimaryAction = 'approve' | 'continue' | 'retry_failed_items' | 'open_result' | 'none';
type BoardContinueMode = 'approval' | 'background' | 'workflow_failed_items' | 'workflow_resume' | 'open_result' | 'none';

interface BoardArtifactSummary {
  files: string[];
  urls: string[];
  counts: string[];
}

interface BoardFailureSummary {
  failedItems: number;
  retryable: boolean;
  reason: string;
}

/** One normalized card on the Tasks board (see GET /api/console/board). */
interface BoardCard {
  id: string;
  sourceKind: 'background' | 'run' | 'execution' | 'workflow' | 'approval';
  title: string;
  column: BoardColumnId;
  /** Raw source status, for the pill label / tooltip. */
  status: string;
  /** Short human progress line (last check-in, current step, blocker). */
  progressHint: string;
  /** Harness session id for the live-trace SSE; null for workflow cards. */
  sessionId: string | null;
  ageMs: number;
  updatedAt: string;
  /** Drag/button actions the card allows. Drag uses only cancel/resume/promote; buttons may use the rest. */
  actions: string[];
  primaryAction?: BoardPrimaryAction;
  continueMode?: BoardContinueMode;
  approvalId?: string;
  nextSafeAction?: string;
  /** Slice 2: the draft body + image of a CONTENT approval (a post/email), so it
   *  is reviewed in place in the Approvals card instead of a one-line summary. */
  contentPreview?: ApprovalContentPreview;
  pendingAction?: PendingActionApprovalView;
  artifactSummary?: BoardArtifactSummary;
  failureSummary?: BoardFailureSummary;
  /** A finished/parked task idle past the stale threshold (background only) — the
   *  board flags it and the heartbeat offers to archive it. */
  stale?: boolean;
  staleKind?: 'finished' | 'parked';
  /** Soft-deleted; only present when the board was asked for ?includeArchived=1. */
  archived?: boolean;
  raw: Record<string, unknown>;
}

function reportBackString(input: unknown, ...keys: string[]): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseBackgroundReportBackTarget(input: unknown): BackgroundReportBackTarget | null {
  const type = reportBackString(input, 'type');
  if (type === 'discord_user') {
    const userId = reportBackString(input, 'userId', 'user_id');
    return userId ? { type, userId } : null;
  }
  if (type === 'discord_channel') {
    const channelId = reportBackString(input, 'channelId', 'channel_id');
    return channelId ? { type, channelId } : null;
  }
  if (type === 'slack_user') {
    const userId = reportBackString(input, 'userId', 'user_id');
    return userId ? { type, userId } : null;
  }
  if (type === 'slack_channel') {
    const channelId = reportBackString(input, 'channelId', 'channel_id');
    const threadTs = reportBackString(input, 'threadTs', 'thread_ts');
    return channelId ? { type, channelId, ...(threadTs ? { threadTs } : {}) } : null;
  }
  return null;
}

export function registerConsoleRoutes(
  app: Express,
  isAuthorized: (req: Request) => boolean,
  assistant: ClementineAssistant,
  opts?: { serveLegacyAtRoot?: boolean },
): void {
  // Renders the legacy inlined-HTML console only when explicitly requested.
  // The renderer is intentionally lazy-loaded because it is a large inline
  // HTML module and should not sit on the normal React console startup path.
  const serveLegacyConsole = async (req: Request, res: Response): Promise<void> => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    try {
      const { renderConsoleHtml } = await import('./console.js');
      res.type('html').send(renderConsoleHtml(queryToken));
    } catch (err) {
      res.status(500).type('text').send(err instanceof Error ? err.message : String(err));
    }
  };
  app.get('/console-legacy', serveLegacyConsole);
  if (opts?.serveLegacyAtRoot ?? true) {
    app.get('/console', serveLegacyConsole);
  }

  // Read-only multi-agent workspace API (roster, canMessage graph, comms,
  // per-agent runs). Shares this function's auth gate.
  registerConsoleAgentsRoutes(app, isAuthorized);

  /**
   * Serve the Clementine icon for use in the dashboard / favicons.
   * Resolves from one of:
   *   - dev: clementine-next/apps/desktop/build/icon.png
   *   - packaged: process.resourcesPath/daemon/apps/desktop/build/icon.png
   *   - fallback: ~/Downloads/clementine.png
   * No auth — it's a public branding asset, not data.
   */
  /**
   * Vendor scripts — currently just Cytoscape for the memory graph.
   * Served from node_modules so the packaged app works offline.
   */
  app.get('/console/vendor/cytoscape.min.js', (_req, res) => {
    const candidates = [
      path.resolve(process.cwd(), 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js'),
      path.resolve(process.env.CLEMENTINE_RESOURCES_PATH ?? '', 'daemon', 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js'),
      path.resolve((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '', 'daemon', 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        res.type('application/javascript').sendFile(candidate);
        return;
      }
    }
    res.status(404).send('// cytoscape not bundled');
  });

  // 3d-force-graph (three.js + d3-force-3d, single self-contained UMD
  // bundle, global `ForceGraph3D`) — served offline exactly like cytoscape
  // above. Powers the interactive 3D knowledge graph. Lazy-loaded by the
  // console only when the 3D view is active, so the 1.3 MB is never paid
  // for by the 2D fallback path.
  app.get('/console/vendor/3d-force-graph.min.js', (_req, res) => {
    const candidates = [
      path.resolve(process.cwd(), 'node_modules', '3d-force-graph', 'dist', '3d-force-graph.min.js'),
      path.resolve(process.env.CLEMENTINE_RESOURCES_PATH ?? '', 'daemon', 'node_modules', '3d-force-graph', 'dist', '3d-force-graph.min.js'),
      path.resolve((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '', 'daemon', 'node_modules', '3d-force-graph', 'dist', '3d-force-graph.min.js'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        res.type('application/javascript').sendFile(candidate);
        return;
      }
    }
    res.status(404).send('// 3d-force-graph not bundled');
  });

  app.get('/console/icon.png', (_req, res) => {
    const candidates = [
      path.resolve(process.cwd(), 'apps', 'desktop', 'build', 'icon.png'),
      path.resolve(process.cwd(), '..', '..', 'apps', 'desktop', 'build', 'icon.png'),
      path.resolve(process.env.CLEMENTINE_RESOURCES_PATH ?? '', 'daemon', 'apps', 'desktop', 'build', 'icon.png'),
      path.resolve((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '', 'daemon', 'apps', 'desktop', 'build', 'icon.png'),
      path.resolve(os.homedir(), 'Downloads', 'clementine.png'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        res.type('png').sendFile(candidate);
        return;
      }
    }
    res.status(404).send('icon not bundled');
  });

  // ─── Console-specific API namespace ───────────────────────────────
  //
  // Routes under /api/console/* support the console panels. We avoid
  // touching the existing /api/* routes the dashboard already uses.

  /**
   * Search the vault via the existing recall layer (FTS + optional
   * embedding rerank). Returns hits in the same shape as MemorySearchHit
   * so the panel renderer stays simple.
   */
  app.get('/api/console/memory/search', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.max(1, Math.min(20, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '10', 10) || 10));
    if (!query) { res.json({ query: '', hits: [] }); return; }
    try {
      const hits = await recallHybrid(query, { limit });
      res.json({ query, hits });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * List durable facts. ?kind=user|project|feedback|reference filters.
   * Defaults to active only; ?includeInactive=1 includes soft-deleted.
   */
  app.get('/api/console/memory/facts', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const kindRaw = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const allowedKinds = new Set(['user', 'project', 'feedback', 'reference']);
    const kind = kindRaw && allowedKinds.has(kindRaw) ? kindRaw as 'user' | 'project' | 'feedback' | 'reference' : undefined;
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const limit = Math.max(1, Math.min(200, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '60', 10) || 60));
    try {
      const facts = includeInactive
        ? listAllFacts(limit).filter((f) => !kind || f.kind === kind)
        : listActiveFacts({ kind, limit });
      res.json({ facts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Data Map (source-map / landscape memory): the navigational layer —
  // WHERE the user's data lives. Read-only viewer feed for the Brain → Data Map
  // tab. `enabled` reflects CLEMMY_SOURCE_MAP so the panel can explain an empty
  // state ("layer is off" vs "nothing mapped yet").
  app.get('/api/console/memory/source-map', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const limit = Math.max(1, Math.min(500, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '300', 10) || 300));
    try {
      res.json({
        enabled: isSourceMapEnabled(),
        count: countResourcePointers(),
        pointers: listResourcePointers({ limit }),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Force MEMORY.md auto-regeneration on demand (mostly: a "regenerate
   * now" button in the Memory panel header). The maintenance tick
   * already runs every ~30min; this skips the wait. Returns the
   * builder's result metadata so the UI can show "0 → 25 facts
   * written" feedback.
   */
  app.post('/api/console/memory/md/regenerate', async (_req, res) => {
    if (!isAuthorized(_req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { regenerateMemoryMd } = await import('../memory/memory-md-builder.js');
      const result = regenerateMemoryMd();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Force IDENTITY.md "Working with" auto-section regeneration on
   * demand. Pulls from user_profile so the agent's per-turn prompt
   * reflects any profile edits immediately rather than waiting for
   * the 30-minute maintenance tick.
   */
  app.post('/api/console/memory/identity/regenerate', async (_req, res) => {
    if (!isAuthorized(_req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { regenerateIdentityMd } = await import('../memory/identity-md-builder.js');
      const result = regenerateIdentityMd();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Autoresearch — return the latest daily observatory report.
   * Foundation-only: this is pure read of the report file the
   * maintenance tick writes nightly. The EVOLUTION panel polls this.
   */
  app.get('/api/console/autoresearch/report', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { buildReport, findLatestReport, listReports } = await import('../autoresearch/observatory.js');
      const { computeMemoryRefinements } = await import('../autoresearch/memory-detectors.js');
      // `report` is a FRESH structured report (read-only compute over tool-events
      // + the memory DB) for the new console's live cards. `memoryRefinements`
      // are the read-only cleanup candidates (dups/noise/stale/recall-gaps).
      // `latest` is the nightly-written markdown the legacy console still renders.
      const report = buildReport();
      let memoryRefinements = null;
      try { memoryRefinements = computeMemoryRefinements(); } catch { /* detectors are best-effort */ }
      const latest = findLatestReport();
      const history = listReports().slice(0, 30);
      res.json({ report, memoryRefinements, latest, history });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Autoresearch — force-regenerate the report NOW (the "Run autoresearch
   * now" button on the EVOLUTION panel). Returns the rebuilt content +
   * a written: true|false flag so the UI can say "no-op, content unchanged."
   * Mirrors the nightly tick's improvement-proposer pass: drafts by default
   * (CLEMMY_IMPROVEMENT_PROPOSER default-on; =off no-op), and still only drafts
   * human-reviewed items — apply is always a separate explicit click.
   */
  app.post('/api/console/autoresearch/run', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { buildReport, writeReport, renderReportMarkdown } = await import('../autoresearch/observatory.js');
      const report = buildReport();
      const result = writeReport(report);
      let improvementProposals: { ran: boolean; added: number; total: number } | null = null;
      try {
        const { proposeFromReport } = await import('../autoresearch/improvement-proposer.js');
        improvementProposals = proposeFromReport(report);
      } catch { /* proposal drafting is best-effort and separately gated */ }
      res.json({
        ...result,
        report,
        content: renderReportMarkdown(report),
        improvementProposals,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Auto-research P1 — apply the provably-safe memory cleanup NOW (the
   * "Clean up safe junk" button on the Evolution page's Memory-refinements
   * card). Soft-deletes ONLY the synthetic smoke-test pollution class (exact
   * signature match), capped + audited + reversible. Pass ?dry=1 to preview
   * without mutating. Never touches user knowledge — that stays behind P2/P3.
   */
  app.post('/api/console/autoresearch/memory-cleanup', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { autoCleanSafeMemory } = await import('../autoresearch/memory-apply.js');
      const dryRun = req.query.dry === '1' || req.query.dry === 'true';
      const result = autoCleanSafeMemory({ dryRun });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Auto-research P2 — one-click human APPROVAL for the knowledge-touching
   * refinement classes. Unlike P1 (auto), NOTHING here runs unattended: each is
   * gated on an explicit Approve click on the Evolution page. All soft + capped
   * + audited + reversible; the batch routes re-derive their full target set
   * server-side, and the per-pair dedup route re-validates every pair at the
   * seam (never trusts client ids). ?dry=1 previews without mutating.
   */
  app.post('/api/console/autoresearch/memory-approve/duplicates', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { approveDuplicateMerges } = await import('../autoresearch/memory-approve.js');
      const body = (req.body ?? {}) as { pairs?: unknown };
      const rawPairs = Array.isArray(body.pairs) ? body.pairs : [];
      const pairs = rawPairs
        .filter((p): p is { keepId: number; dropId: number } => {
          const o = p as { keepId?: unknown; dropId?: unknown } | null;
          return !!o && typeof o.keepId === 'number' && typeof o.dropId === 'number'
            && Number.isFinite(o.keepId) && Number.isFinite(o.dropId)
            && o.keepId > 0 && o.dropId > 0 && o.keepId !== o.dropId;
        });
      const dryRun = req.query.dry === '1' || req.query.dry === 'true';
      res.json(approveDuplicateMerges({ pairs, dryRun }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/autoresearch/memory-approve/recall-gaps', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { liftRecallGaps } = await import('../autoresearch/memory-approve.js');
      const dryRun = req.query.dry === '1' || req.query.dry === 'true';
      res.json(liftRecallGaps({ dryRun }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/autoresearch/memory-approve/internal-noise', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { retireInternalNoise } = await import('../autoresearch/memory-approve.js');
      const dryRun = req.query.dry === '1' || req.query.dry === 'true';
      res.json(retireInternalNoise({ dryRun }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Phase C — improvement proposals. GET lists pending proposals (drafted nightly
   * by default; CLEMMY_IMPROVEMENT_PROPOSER=off disables); POST approve applies ONE proposal through
   * the same gated, journaled, reversible flow as the memory-approve actions.
   * ?dry=1 previews. Nothing here ever auto-mutates; apply is a human click.
   */
  app.get('/api/console/autoresearch/improvements', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { listPendingProposals, proposerEnabled } = await import('../autoresearch/improvement-proposer.js');
      res.json({ enabled: proposerEnabled(), proposals: listPendingProposals() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/autoresearch/improvements/approve', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { approveProposal } = await import('../autoresearch/improvement-proposer.js');
      const body = (req.body ?? {}) as { id?: unknown };
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      const dryRun = req.query.dry === '1' || req.query.dry === 'true';
      res.json(approveProposal(id, { dryRun }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/autoresearch/improvements/dismiss', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { dismissProposal } = await import('../autoresearch/improvement-proposer.js');
      const body = (req.body ?? {}) as { id?: unknown };
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      res.json(dismissProposal(id));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Soft-delete a fact (sets active=0). Used by the panel's forget button.
   * Hard delete intentionally not exposed here — that lives in MCP tools
   * for the agent itself.
   */
  app.post('/api/console/memory/facts/:id/forget', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const ok = forgetFact(id);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Restore a soft-deleted (forgotten / auto-decayed) fact. The reversibility
   * half of forget — soft-delete keeps the row, this brings it back. Idempotent
   * (a no-op on an already-active fact returns ok:false). Lets the owner undo
   * an automatic decay/dedup retirement or a mistaken forget. No hard-delete is
   * ever exposed in the console; that stays MCP-tool-only.
   */
  app.post('/api/console/memory/facts/:id/restore', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const ok = reactivateFact(id);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Reviewable audit of AUTOMATIC nightly hygiene (decay + dedup): what was
   * retired, when, and why. Read-only — the facts themselves stay visible via
   * ?includeInactive=1 and restorable via the route above.
   */
  app.get('/api/console/memory/hygiene-log', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const limit = Math.max(1, Math.min(1000, parseInt(String(req.query.limit ?? '200'), 10) || 200));
    try {
      res.json({ entries: readHygieneAudit(limit) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Tier D1 — edit/correct a fact's content (and optionally importance).
   * Lets the owner fix a wrong derivation in place instead of only being
   * able to soft-delete it. content_hash is recomputed by updateFact so
   * future dedup still works.
   */
  app.patch('/api/console/memory/facts/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    const body = (req.body ?? {}) as { content?: unknown; importance?: unknown };
    const patch: { content?: string; importance?: number } = {};
    if (typeof body.content === 'string' && body.content.trim()) patch.content = body.content.trim().slice(0, 800);
    if (typeof body.importance === 'number' && Number.isFinite(body.importance)) patch.importance = Math.max(0, Math.min(10, body.importance)); // clamp at the route (updateFact also clamps — defense-in-depth)
    if (patch.content === undefined && patch.importance === undefined) {
      res.status(400).json({ error: 'nothing to update (provide content and/or importance)' });
      return;
    }
    try {
      const updated = updateFact(id, patch);
      if (!updated) { res.status(404).json({ error: `no fact #${id}` }); return; }
      res.json({ ok: true, fact: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Tier D1 — pin / unpin a fact as a standing instruction (always
   * injected, exempt from the top-N cap + recency decay). Body: { pinned }.
   */
  app.post('/api/console/memory/facts/:id/pin', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    const pinned = ((req.body ?? {}) as { pinned?: unknown }).pinned !== false;
    try {
      const existing = getFact(id);
      if (!existing) { res.status(404).json({ error: `no fact #${id}` }); return; }
      const ok = setFactPinned(id, pinned);
      res.json({ ok, pinned });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Tier D3 — semantic search over the FACT store (distinct from
   * /memory/search, which searches vault chunks). Lets the Memory panel
   * answer "what does Clem know about X?" against consolidated_facts.
   */
  app.get('/api/console/memory/facts/search', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.max(1, Math.min(20, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '8', 10) || 8));
    if (!query) { res.json({ query: '', facts: [] }); return; }
    try {
      const facts = await searchFacts(query, { topK: limit });
      res.json({ query, facts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Tier D2 — memory health/observability: fact counts, embedding coverage
   * + freshness, recall hit-rate, and the hidden layers (pinned / episodic /
   * focus) that the fact-centric panel doesn't otherwise surface.
   */
  app.get('/api/console/memory/health', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const db = openMemoryDb();
      const one = (sql: string): number => (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
      const facts = one('SELECT COUNT(*) AS c FROM consolidated_facts WHERE active = 1');
      const factsInactive = one('SELECT COUNT(*) AS c FROM consolidated_facts WHERE active = 0');
      const factEmbeds = one('SELECT COUNT(*) AS c FROM fact_embeddings');
      const factsTotal = one('SELECT COUNT(*) AS c FROM consolidated_facts');
      const chunks = one('SELECT COUNT(*) AS c FROM vault_chunks');
      const chunkEmbeds = one('SELECT COUNT(*) AS c FROM embeddings');
      const pinned = one('SELECT COUNT(*) AS c FROM consolidated_facts WHERE active = 1 AND pinned = 1');
      const episodic = one('SELECT COUNT(*) AS c FROM episodic_pointers');
      const entities = one('SELECT COUNT(*) AS c FROM entities');
      const focusActive = one("SELECT COUNT(*) AS c FROM current_focus WHERE status = 'active'");
      const embStats = readEmbeddingStats();
      const embHealth = getEmbeddingHealth();
      res.json({
        facts: { active: facts, inactive: factsInactive, total: factsTotal, pinned },
        entities,
        episodicPointers: episodic,
        focusActive,
        embeddings: {
          // `enabled`/`breakerOpen` make the silent no-key / circuit-broken
          // degradation legible to the Memory screen — when false the whole
          // semantic layer (fact recall, dedup, 'similar' edges) is FTS/LIKE-only.
          enabled: embHealth.enabled,
          breakerOpen: embHealth.breakerOpen,
          lastErrorClass: embHealth.lastErrorClass,
          model: embStats.model,
          dim: embStats.dim,
          factCoverage: factsTotal > 0 ? factEmbeds / factsTotal : 0,
          vaultCoverage: chunks > 0 ? chunkEmbeds / chunks : 0,
          factEmbeds,
          chunkEmbeds,
        },
        recall: getRecallStats(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Tool-recall (procedural) memory — the per-machine store of which tool
   * proved out for a given intent. Until now this learned-procedure store was
   * inspectable only by hand-reading the `.md` files; the Memory screen renders
   * the list from here so the strongest ever-learning signal is auditable and
   * (eventually) correctable. Read-only: returns each record with its
   * Laplace-smoothed outcome score so the UI can sort by what's working.
   */
  app.get('/api/console/memory/tool-recall', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const records = listToolChoices().map((r) => ({
        intent: r.intent,
        description: r.description ?? null,
        choice: r.choice
          ? {
              kind: r.choice.kind,
              identifier: r.choice.identifier,
              testedAt: r.choice.testedAt,
              successCount: r.choice.successCount ?? 0,
              failureCount: r.choice.failureCount ?? 0,
              lastSuccessAt: r.choice.lastSuccessAt ?? null,
              lastFailureAt: r.choice.lastFailureAt ?? null,
              score: computeChoiceScore(r.choice),
            }
          : null,
        fallbacks: r.fallbacks.map((f) => ({ kind: f.kind, identifier: f.identifier, reason: f.reason, failedAt: f.failedAt })),
      }));
      // Strongest, most-recently-validated first; invalidated (no active choice) sink.
      records.sort((a, b) => (b.choice?.score ?? -1) - (a.choice?.score ?? -1));
      res.json({ count: records.length, records });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * List indexed vault files with chunk counts + last index time. The
   * panel renders this as a browsable file tree on the left side.
   */
  /**
   * Build a {nodes, edges, meta} graph payload for the Memory tab visualizer.
   * Thin wrapper over buildMemoryGraph (./memory-graph.ts).
   *
   * Nodes: fact · kind · file · entity.
   * Edges: kind (fact→kind) · mentions (fact→file) · entity (fact→entity) ·
   *        similar (fact↔fact semantic, opt-in via ?simEdges).
   *
   * Query params (all optional, clamped):
   *   facts (10–300, def 100) · files (10–200, def 60) · entities (0–150, def 80)
   *   layout=semantic            → attach PCA fx/fy/fz seed positions to facts
   *   simEdges=<K> (0–8, def 0)  → top-K semantic neighbours per fact; 0 = off
   *   simThreshold (0.40–0.95, def 0.70) · simCap (0–1500, def 300)
   *   cluster=kind|auto (def kind)
   *
   * The bare URL (no new params) is byte-compatible with the prior route.
   */
  app.get('/api/console/memory/graph', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const intParam = (v: unknown, def: number) =>
        typeof v === 'string' && v.trim() !== '' ? (parseInt(v, 10) || def) : def;
      const floatParam = (v: unknown, def: number) =>
        typeof v === 'string' && v.trim() !== '' ? (Number.parseFloat(v) || def) : def;
      const db = openMemoryDb();
      const result = buildMemoryGraph(db, {
        factsLimit: intParam(req.query.facts, 100),
        filesLimit: intParam(req.query.files, 60),
        entitiesLimit: intParam(req.query.entities, 80),
        semanticLayout: req.query.layout === 'semantic',
        simEdges: intParam(req.query.simEdges, 0),
        simThreshold: floatParam(req.query.simThreshold, 0.70),
        simCap: intParam(req.query.simCap, 300),
        clusterMode: req.query.cluster === 'auto' ? 'auto' : 'kind',
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/memory/files', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const db = openMemoryDb();
      const rows = db.prepare(`
        SELECT
          path,
          COUNT(*) AS chunks,
          MAX(mtime) AS mtime,
          MAX(byte_size) AS byteSize
        FROM vault_chunks
        GROUP BY path
        ORDER BY MAX(mtime) DESC
      `).all() as Array<{ path: string; chunks: number; mtime: number; byteSize: number }>;
      const status = readMemoryIndexStatus();
      res.json({ files: rows, status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Fetch the chunks for a single file, optionally with full content.
   * Used by the panel's file inspector.
   */
  app.get('/api/console/memory/file', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
    try {
      const db = openMemoryDb();
      const chunks = db.prepare(`
        SELECT id, chunk_index AS chunkIndex, title, content, mtime, byte_size AS byteSize
        FROM vault_chunks WHERE path = ?
        ORDER BY chunk_index ASC
      `).all(filePath) as Array<{ id: number; chunkIndex: number; title: string | null; content: string; mtime: number; byteSize: number }>;

      let rawContent: string | undefined;
      if (existsSync(filePath)) {
        try { rawContent = readFileSync(filePath, 'utf-8').slice(0, 50_000); }
        catch { rawContent = undefined; }
      }

      res.json({ path: filePath, chunks, rawContent });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Vault file browser (Memory tab → "FILES" section) ─────────
  //
  // The vault FTS indexer only picks up .md — so HTML reports, JSON
  // outputs, CSVs, and other deliverables Clementine produces are
  // invisible from "Search Memory." These endpoints surface the full
  // vault file system: list recently-touched files (any extension),
  // preview text content (size-capped), and open in the user's
  // default app for binary / rich formats. Read-only — write/delete
  // intentionally NOT exposed here; the agent's write_file tool
  // remains the only mutation path.

  /** Walk the vault, return the N most-recently-modified files (any
   *  extension). Used by the Memory tab's FILES section. Limit is
   *  capped server-side so a misconfigured client can't ask for 10k. */
  app.get('/api/console/files/recent', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!fs.existsSync(VAULT_DIR)) { res.json({ files: [] }); return; }
    const rawLimit = Number(req.query.limit ?? 30);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.trunc(rawLimit))) : 30;
    try {
      const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.DS_Store']);
      const collected: Array<{ path: string; relPath: string; name: string; ext: string; bytes: number; mtimeMs: number }> = [];
      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.isFile()) continue;
          try {
            const st = fs.statSync(full);
            collected.push({
              path: full,
              relPath: path.relative(VAULT_DIR, full),
              name: entry.name,
              ext: path.extname(entry.name).slice(1).toLowerCase(),
              bytes: st.size,
              mtimeMs: st.mtimeMs,
            });
          } catch { /* skip unreadable entries */ }
        }
      };
      walk(VAULT_DIR);
      collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
      res.json({ files: collected.slice(0, limit), total: collected.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Read a file's text content for inline preview. Path MUST resolve
   *  inside VAULT_DIR — anything outside is rejected. Binary-looking
   *  files return a hint instead of content; the dashboard then offers
   *  "Open in Finder" instead of trying to render bytes as text. */
  app.get('/api/console/files/preview', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const raw = typeof req.query.path === 'string' ? req.query.path : '';
    if (!raw) { res.status(400).json({ error: 'path required' }); return; }
    try {
      const resolved = path.resolve(raw);
      const relCheck = path.relative(VAULT_DIR, resolved);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.status(403).json({ error: 'path outside vault' });
        return;
      }
      if (!fs.existsSync(resolved)) { res.status(404).json({ error: 'not found' }); return; }
      const st = fs.statSync(resolved);
      if (st.isDirectory()) { res.status(400).json({ error: 'is a directory' }); return; }
      const MAX_PREVIEW = 200_000;
      const TEXT_EXT = new Set(['md', 'txt', 'json', 'csv', 'tsv', 'html', 'htm', 'log', 'yaml', 'yml', 'xml', 'js', 'ts', 'py', 'sh']);
      const ext = path.extname(resolved).slice(1).toLowerCase();
      if (!TEXT_EXT.has(ext)) {
        res.json({
          path: resolved,
          relPath: relCheck,
          ext,
          bytes: st.size,
          previewable: false,
          reason: `${ext || 'binary'} files preview in the default app — click Open in Finder`,
        });
        return;
      }
      const buf = fs.readFileSync(resolved);
      const truncated = buf.byteLength > MAX_PREVIEW;
      const content = (truncated ? buf.slice(0, MAX_PREVIEW) : buf).toString('utf-8');
      res.json({
        path: resolved,
        relPath: relCheck,
        ext,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        previewable: true,
        truncated,
        content,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Open a vault file in the user's default app (macOS `open`). Pure
   *  side effect — no body. Path safety identical to /preview. Used
   *  for HTML reports, PDFs, screenshots, anything that's better
   *  viewed in Finder/Preview/Safari than rendered inline. */
  app.post('/api/console/files/open', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const raw = typeof req.query.path === 'string' ? req.query.path : '';
    if (!raw) { res.status(400).json({ error: 'path required' }); return; }
    try {
      const resolved = path.resolve(raw);
      const relCheck = path.relative(VAULT_DIR, resolved);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.status(403).json({ error: 'path outside vault' });
        return;
      }
      if (!fs.existsSync(resolved)) { res.status(404).json({ error: 'not found' }); return; }
      if (process.platform !== 'darwin') {
        res.status(501).json({ error: 'open only implemented on macOS — use Finder/Explorer manually' });
        return;
      }
      // spawn is detached + unref'd so the spawn child doesn't block
      // the request response on slow `open` dispatching.
      const child = childProcess.spawn('open', [resolved], { detached: true, stdio: 'ignore' });
      child.unref?.();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Cron jobs (visibility into CRON.md) ───────────────────────
  //
  // Cron jobs live in vault/00-System/CRON.md frontmatter and are
  // executed by src/daemon/runner.ts:runCronJob. They are a separate
  // abstraction from workflows — single prompts that fire on a
  // schedule. The Workflows panel only enumerates workflow directories,
  // so historically cron jobs had no surface in the dashboard. The
  // user authored a cron and had to grep supervisor.log to know it was
  // running; that's the gap this endpoint closes.
  //
  // Returns each cron with its config + the last 10 runs from
  // ~/.clementine-next/cron/runs/<jobName>.jsonl (already maintained
  // by appendRunLog in the daemon).
  app.get('/api/console/crons', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const cronFile = path.join(BASE_DIR, 'vault', '00-System', 'CRON.md');
      const cronRunsDir = path.join(BASE_DIR, 'cron', 'runs');

      interface CronJobInput {
        name?: unknown;
        schedule?: unknown;
        prompt?: unknown;
        enabled?: unknown;
        tier?: unknown;
        mode?: unknown;
        max_hours?: unknown;
        work_dir?: unknown;
      }

      const jobs: CronJobInput[] = (() => {
        if (!existsSync(cronFile)) return [];
        try {
          const parsed = matter(readFileSync(cronFile, 'utf-8'));
          const list = (parsed.data as { jobs?: unknown }).jobs;
          return Array.isArray(list) ? (list as CronJobInput[]) : [];
        } catch {
          return [];
        }
      })();

      const result = jobs.map((job) => {
        const name = String(job.name ?? '');
        const schedule = String(job.schedule ?? '');
        const enabled = job.enabled !== false;
        const prompt = String(job.prompt ?? '');
        const tier = typeof job.tier === 'number' ? job.tier : null;
        const mode = typeof job.mode === 'string' ? job.mode : 'standard';
        const maxHours = typeof job.max_hours === 'number' ? job.max_hours : null;
        const workDir = typeof job.work_dir === 'string' && job.work_dir.length > 0 ? job.work_dir : null;

        // Read recent runs from the per-job JSONL log. Tail the last
        // 10 entries — older history stays in the file for grep but
        // doesn't need to round-trip on every dashboard refresh.
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const runsPath = path.join(cronRunsDir, `${safeName}.jsonl`);
        let recentRuns: Array<Record<string, unknown>> = [];
        if (existsSync(runsPath)) {
          try {
            const lines = readFileSync(runsPath, 'utf-8').trim().split('\n');
            const tail = lines.slice(-10);
            recentRuns = tail
              .map((line) => {
                try { return JSON.parse(line); } catch { return null; }
              })
              .filter((entry): entry is Record<string, unknown> => entry !== null);
          } catch {
            recentRuns = [];
          }
        }

        const lastRun = recentRuns.length > 0 ? recentRuns[recentRuns.length - 1] : null;
        const lastRunSummary = lastRun
          ? {
              status: String(lastRun.status ?? 'unknown'),
              startedAt: typeof lastRun.startedAt === 'string' ? lastRun.startedAt : null,
              finishedAt: typeof lastRun.finishedAt === 'string' ? lastRun.finishedAt : null,
              durationMs: typeof lastRun.durationMs === 'number' ? lastRun.durationMs : null,
              source: typeof lastRun.source === 'string' ? lastRun.source : null,
              // Excerpt the response/error to keep the payload tight;
              // full text is available via the per-run history endpoint
              // (future iteration).
              responseExcerpt: typeof lastRun.response === 'string'
                ? lastRun.response.slice(0, 240)
                : null,
              error: typeof lastRun.error === 'string' ? lastRun.error.slice(0, 240) : null,
            }
          : null;

        return {
          name,
          schedule,
          enabled,
          prompt,
          tier,
          mode,
          maxHours,
          workDir,
          lastRun: lastRunSummary,
          runCount: recentRuns.length,
          // Full recent runs (parsed) so the UI can render an
          // expandable list without another round-trip per job.
          recentRuns: recentRuns.map((run) => ({
            status: String(run.status ?? 'unknown'),
            startedAt: typeof run.startedAt === 'string' ? run.startedAt : null,
            finishedAt: typeof run.finishedAt === 'string' ? run.finishedAt : null,
            durationMs: typeof run.durationMs === 'number' ? run.durationMs : null,
            source: typeof run.source === 'string' ? run.source : null,
            responseExcerpt: typeof run.response === 'string' ? run.response.slice(0, 500) : null,
            error: typeof run.error === 'string' ? run.error.slice(0, 500) : null,
          })),
        };
      });

      res.json({ crons: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/crons/:name/trigger', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const jobName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const trimmed = typeof jobName === 'string' ? jobName.trim() : '';
    if (!trimmed) {
      res.status(400).json({ error: 'cron job name is required' });
      return;
    }
    try {
      ensureDir(CRON_TRIGGERS_DIR);
      const safeName = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_');
      const file = `${Date.now()}-${safeName}.json`;
      writeFileSync(
        path.join(CRON_TRIGGERS_DIR, file),
        JSON.stringify({ jobName: trimmed, triggeredAt: new Date().toISOString() }, null, 2),
        'utf-8',
      );
      res.json({ ok: true, jobName: trimmed, file });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Workflow Studio ──────────────────────────────────────────

  app.get('/api/console/workflows', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      // Latest run per workflow (records are newest-first) → a status dot
      // in the list so you can scan health at a glance.
      const runRecords = readWorkflowRunRecords();
      const latestRunByWorkflow = new Map<string, WorkflowRunRecordSummary>();
      for (const run of runRecords) {
        if (!latestRunByWorkflow.has(run.workflow)) latestRunByWorkflow.set(run.workflow, run);
      }
      const items = listWorkflows()
        .sort((a, b) => a.data.name.localeCompare(b.data.name))
        .map((entry) => {
          const lastRun = latestRunByWorkflow.get(entry.data.name) ?? latestRunByWorkflow.get(entry.name) ?? null;
          const lastRunFailedItems = lastRun ? listFinalFailedItems(entry.name, lastRun.id) : [];
          const lastRunFailedItemStepIds = Array.from(new Set(lastRunFailedItems.map((item) => item.stepId)));
          const proof = buildWorkflowProof(entry.data, runRecords, [entry.name]);
          const certification = workflowCertificationFor(entry.data, entry.name);
          return {
          name: entry.data.name,
          file: entry.layout === 'directory' ? `${entry.name}/SKILL.md` : `${entry.name}.md`,
          description: entry.data.description,
          project: entry.data.project ?? null,
          enabled: entry.data.enabled,
          triggerSchedule: entry.data.trigger.schedule ?? null,
          stepCount: entry.data.steps.length,
          trigger: entry.data.trigger,
          steps: entry.data.steps,
          resources: entry.data.resources ?? {},
          inputs: entry.data.inputs ?? {},
          synthesis: entry.data.synthesis ?? null,
          goal: entry.data.goal ?? null,
          allowedTools: entry.data.allowedTools ?? null,
          whenToUse: entry.data.whenToUse ?? null,
          lastRunStatus: lastRun ? (lastRun.needsAttention ? 'needs_attention' : lastRun.status) : null,
          lastRunNeedsAttention: lastRun?.needsAttention === true || undefined,
          lastRunId: lastRun?.id ?? null,
          lastRunFailedItemCount: lastRunFailedItems.length,
          lastRunFailedItemStepIds,
          lastRunAt: lastRun ? (lastRun.finishedAt ?? lastRun.startedAt ?? lastRun.createdAt) : null,
          proof,
          certification: workflowCertificationSummary(certification),
          executionPlan: certification.dryRun.plan,
          };
        });
      res.json({ workflows: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/workflows/home', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const workflows = listWorkflows().sort((a, b) => a.data.name.localeCompare(b.data.name));
      const runRecords = readWorkflowRunRecords();
      const pending = listPendingRuns();
      const workflowNameBySlug = new Map(workflows.map((entry) => [entry.name, entry.data.name]));
      const activeByRunId = new Map<string, {
        workflowName: string;
        workflowSlug: string | null;
        runId: string;
        status: string;
        lastEventAt: string | null;
        inFlightStepId: string | null;
      }>();

      for (const run of pending) {
        activeByRunId.set(run.runId, {
          workflowName: workflowNameBySlug.get(run.workflowName) ?? run.workflowName,
          workflowSlug: run.workflowName,
          runId: run.runId,
          status: 'running',
          lastEventAt: run.lastEventAt ?? null,
          inFlightStepId: run.inFlightStepId ?? null,
        });
      }
      for (const run of runRecords) {
        if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'parked') continue;
        if (activeByRunId.has(run.id)) continue;
        activeByRunId.set(run.id, {
          workflowName: run.workflow,
          workflowSlug: null,
          runId: run.id,
          status: run.status,
          lastEventAt: run.startedAt ?? run.createdAt,
          inFlightStepId: run.targetStepId,
        });
      }

      const activeRuns = Array.from(activeByRunId.values())
        .sort((a, b) => String(b.lastEventAt ?? '').localeCompare(String(a.lastEventAt ?? '')));
      const recentRuns = runRecords.slice(0, 20);
      const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const failedRecent = runRecords.filter((run) => {
        if (run.status !== 'error' && run.status !== 'failed') return false;
        const timestamp = Date.parse(run.finishedAt ?? run.startedAt ?? run.createdAt ?? '');
        return Number.isFinite(timestamp) ? timestamp >= recentCutoff : true;
      }).length;
      const upcoming = upcomingWorkflowOccurrences(workflows, new Date(), 7);

      const workflowSummaries = workflows.map((entry) => {
        const runs = runRecords.filter((run) => run.workflow === entry.data.name || run.workflow === entry.name);
        const activeRun = activeRuns.find((run) => run.workflowName === entry.data.name || run.workflowSlug === entry.name) ?? null;
        const proof = buildWorkflowProof(entry.data, runRecords, [entry.name]);
        const certification = workflowCertificationSummaryFor(entry.data, entry.name);
        return {
          name: entry.data.name,
          file: entry.layout === 'directory' ? `${entry.name}/SKILL.md` : `${entry.name}.md`,
          description: entry.data.description,
          enabled: entry.data.enabled,
          triggerSchedule: entry.data.trigger.schedule ?? null,
          stepCount: entry.data.steps.length,
          resourceCount: Object.keys(entry.data.resources ?? {}).length,
          inputCount: Object.keys(entry.data.inputs ?? {}).length,
          hasSynthesis: !!entry.data.synthesis?.prompt,
          activeRun,
          lastRun: runs[0] ?? null,
          proof,
          certification,
        };
      });

      res.json({
        generatedAt: new Date().toISOString(),
        counts: {
          workflows: workflows.length,
          enabled: workflows.filter((entry) => entry.data.enabled !== false).length,
          activeRuns: activeRuns.length,
          failedRecent,
          upcoming: upcoming.length,
        },
        workflows: workflowSummaries,
        activeRuns,
        upcoming,
        recentRuns,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/workflows/import', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    if (!source) {
      res.status(400).json({ error: 'source is required' });
      return;
    }
    try {
      const job = startWorkflowFrameworkImport(source, {
        dryRun: req.body?.dryRun !== false,
        overwrite: req.body?.overwrite === true,
      });
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/workflows/import/jobs', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.json({ jobs: listRecentWorkflowImportJobs().slice(0, 10) });
  });

  app.get('/api/console/workflows/import/jobs/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const job = getWorkflowImportJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'workflow import job not found' });
      return;
    }
    res.json({ job });
  });

  /**
   * SSE: pushes a `workflow_changed` event whenever any workflow file
   * is written, updated, or deleted (via writeWorkflow / deleteWorkflow
   * in memory/workflow-store.ts). Lets the dashboard refresh the list
   * the moment something changes on disk — fixes the "had to reload to
   * see the new workflow" bug for every write path, including the
   * architect's workflow_create calls.
   */
  app.get('/api/console/workflows/events', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    // Initial comment so the EventSource considers the connection
    // open before any real event arrives.
    res.write(': workflow change stream\n\n');

    const unsubscribe = subscribeWorkflowChanges((change) => {
      res.write(`event: workflow_changed\ndata: ${JSON.stringify(change)}\n\n`);
    });
    const keepalive = setInterval(() => {
      // SSE heartbeat — comment lines are ignored by EventSource but
      // keep intermediaries from killing the idle connection.
      res.write(': ping\n\n');
    }, 25_000);
    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.post('/api/console/workflows/from-session', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, 120) : '';
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    if (!sessionId) { res.status(400).json({ error: 'sessionId required' }); return; }

    try {
      const promoted = promoteWorkflowFromSession({ name, sessionId });
      if (!promoted.ok) {
        const status =
          promoted.status === 'duplicate' ? 409
          : promoted.status === 'session_not_found' ? 404
          : promoted.status === 'invalid_workflow' ? 422
          : 400;
        res.status(status).json({
          error: promoted.message,
          status: promoted.status,
          errors: promoted.errors ?? [],
          notes: promoted.draft?.notes ?? [],
        });
        return;
      }
      const savedDef = promoted.savedDef as WorkflowDefinition;
      const slug = promoted.slug ?? workflowSlugFromName(savedDef.name);
      const proof = buildWorkflowProof(savedDef, readWorkflowRunRecords(), [slug]);
      const certification = workflowCertificationFor(savedDef, slug);
      res.status(201).json({
        created: true,
        name: savedDef.name,
        file: `${slug}/SKILL.md`,
        enabled: savedDef.enabled !== false,
        sessionId: promoted.sessionId,
        toolCallCount: promoted.draft?.toolCallCount ?? 0,
        stepCount: savedDef.steps.length,
        summary: describeWorkflowPlainEnglish(savedDef),
        notes: promoted.draft?.notes ?? [],
        repairs: promoted.built?.repairs ?? [],
        warnings: promoted.built?.warnings ?? [],
        boundNotes: [
          ...(promoted.promoteBindNotes ?? []),
          ...(promoted.built?.boundNotes ?? []),
        ],
        advisories: promoted.built?.advisories ?? [],
        gaps: promoted.built?.gaps ?? [],
        preflight: promoted.preflight ?? null,
        proof,
        certification: workflowCertificationSummary(certification),
        executionPlan: certification.dryRun.plan,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/workflows/:name', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      // Accept lookup either by display name (data.name) or by directory
      // slug. Most callers use the display name (round-tripped from the
      // workflows list), but the Architect agent may pass the slug.
      const target = req.params.name;
      const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
      if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
      const proof = buildWorkflowProof(entry.data, readWorkflowRunRecords(), [entry.name]);
      const certification = workflowCertificationFor(entry.data, entry.name);
      const executionPlan = certification.dryRun.plan;
      const resourceBinding = await buildWorkflowResourceBindingReportFromRuntime(entry.data);
      res.json({
        name: entry.data.name,
        file: entry.layout === 'directory' ? `${entry.name}/SKILL.md` : `${entry.name}.md`,
        description: entry.data.description,
        project: entry.data.project ?? null,
        enabled: entry.data.enabled,
        trigger: entry.data.trigger,
        steps: entry.data.steps,
        resources: entry.data.resources ?? {},
        resourceBinding,
        inputs: entry.data.inputs ?? {},
        synthesis: entry.data.synthesis ?? null,
        goal: entry.data.goal ?? null,
        allowedTools: entry.data.allowedTools ?? null,
        whenToUse: entry.data.whenToUse ?? null,
        // Plain-English / printable rendering for the UI — "what this does, when
        // it runs, what it needs/produces, where it pauses" — so the dashboard
        // can show a readable summary instead of only raw step fields.
        summary: describeWorkflowPlainEnglish(entry.data),
        proof,
        certification,
        // Ready-to-draw flow graph (nodes = steps, edges = dependsOn) for the
        // visual workflow view. Built server-side from the pure, unit-tested
        // buildWorkflowGraph so the browser just hands it to Cytoscape.
        graph: buildWorkflowGraph(entry.data.steps, {
          readinessItems: executionPlan.toolReadiness.items,
          workflowProject: entry.data.project,
          executionPlan,
        }),
        executionPlan,
        // Provable dry-run preview: a side-effect-free trace of what this workflow
        // WOULD do (execution waves + every external write/send it would perform)
        // with no inputs supplied, so the UI can show "here is exactly what this
        // will touch and send" before anyone runs it.
        dryRunSimulation: certification.dryRun,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/workflows', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    const slug = workflowSlugFromName(name);
    if (!slug) { res.status(400).json({ error: 'name must contain at least one letter or number' }); return; }
    if (readWorkflow(slug)) { res.status(409).json({ error: 'workflow already exists' }); return; }
    const description = typeof body.description === 'string' ? body.description : '';
    const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : undefined;
    const steps = Array.isArray(body.steps) ? normalizeWorkflowSteps(body.steps) : [];
    const stepGraphError = validateWorkflowStepGraph(steps);
    if (stepGraphError) { res.status(400).json({ error: stepGraphError }); return; }
    const triggerInput = workflowTriggerCreateInputFromUnknown(body);
    if (!triggerInput.ok) { res.status(400).json({ error: triggerInput.error }); return; }
    const triggerResult = buildWorkflowTrigger(triggerInput.input);
    if (!triggerResult.ok) { res.status(400).json({ error: triggerResult.error }); return; }
    const synthesis = typeof body.synthesisPrompt === 'string' && body.synthesisPrompt.trim()
      ? { prompt: body.synthesisPrompt.trim() } : undefined;
    const inputs = normalizeWorkflowInputs(body.inputs);
    const resources = normalizeWorkflowResources(body.resources);
    const goal = workflowGoalFromDashboardBody(body.goal);

    const def: WorkflowDefinition = {
      name,
      description,
      project,
      enabled: body.enabled !== false,
      trigger: triggerResult.trigger,
      steps,
      resources: resources && Object.keys(resources).length > 0 ? resources : undefined,
      inputs: inputs && Object.keys(inputs).length > 0 ? inputs : undefined,
      synthesis,
      goal,
    };
    // Same author-time guard as workflow_create: auto-repair the fixable
    // binding gaps, then refuse only if an ENABLED workflow still can't flow
    // (so the dashboard isn't a back door around validation). Save disabled to
    // draft. A disabled workflow is still repaired so it saves runnable.
    const createPrep = prepareWorkflowCreateForWrite(def, {
      modelPortability: workflowModelPortabilityFromUnknown(body),
    });
    if (createPrep.status === 'invalid') {
      res.status(400).json({ error: 'workflow failed validation', errors: createPrep.errors }); return;
    }
    const createVerification = prepareWorkflowVerification(createPrep.def, dashboardWorkflowSmokeInputs(body));
    if (createVerification.needsTest) {
      const disabledDef = { ...createPrep.def, enabled: false };
      writeWorkflowAndSyncTriggers(slug, disabledDef);
      if (createVerification.missing.length > 0) {
        res.status(202).json({
          created: true,
          name,
          file: `${slug}/SKILL.md`,
          repairs: createPrep.repairs,
          enabled: false,
          readinessGaps: workflowReadinessGapPayload(disabledDef),
          missingSmokeInputs: createVerification.missing,
          message: renderMissingSmokeInputs(name, createVerification.missing),
        });
        return;
      }
      const queued = queueWorkflowCreationTest(name, createVerification.inputs);
      res.status(202).json({
        created: true,
        name,
        file: `${slug}/SKILL.md`,
        repairs: createPrep.repairs,
        enabled: false,
        readinessGaps: workflowReadinessGapPayload(disabledDef),
        verificationQueued: true,
        runId: queued.id,
        message: queued.message,
      });
      return;
    }
    writeWorkflowAndSyncTriggers(slug, createPrep.def);
    res.json({
      created: true,
      name,
      file: `${slug}/SKILL.md`,
      repairs: createPrep.repairs,
      enabled: createPrep.def.enabled,
      readinessGaps: workflowReadinessGapPayload(createPrep.def),
    });
  });

  app.patch('/api/console/workflows/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const body = req.body ?? {};
    const next: WorkflowDefinition = { ...entry.data };

    if (typeof body.description === 'string') next.description = body.description;
    if (typeof body.project === 'string') {
      const project = body.project.trim();
      if (project) next.project = project;
      else delete next.project;
    } else if (body.clearProject === true || body.clear_project === true) {
      delete next.project;
    }
    if (Array.isArray(body.steps)) next.steps = normalizeWorkflowSteps(mergeWorkflowStepsForPatch(entry.data.steps, body.steps));
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (body.synthesisPrompt !== undefined) {
      next.synthesis = typeof body.synthesisPrompt === 'string' && body.synthesisPrompt.trim()
        ? { prompt: body.synthesisPrompt.trim() } : undefined;
    }
    if (body.clearGoal === true || body.clear_goal === true) {
      delete next.goal;
    } else if (body.goal !== undefined) {
      const goal = workflowGoalFromDashboardBody(body.goal);
      if (goal) next.goal = goal;
      else delete next.goal;
    }
    const inputs = normalizeWorkflowInputs(body.inputs);
    if (inputs) next.inputs = inputs;
    if (body.clearResources === true || body.clear_resources === true) {
      delete next.resources;
    } else if (body.resources !== undefined) {
      const resources = normalizeWorkflowResources(body.resources);
      next.resources = resources && Object.keys(resources).length > 0 ? resources : undefined;
    }
    if (Array.isArray(body.steps)) {
      const stepGraphError = validateWorkflowStepGraph(next.steps);
      if (stepGraphError) { res.status(400).json({ error: stepGraphError }); return; }
    }
    const triggerPatch = applyWorkflowTriggerPatch(next.trigger, {
      triggerSchedule: typeof body.triggerSchedule === 'string' ? body.triggerSchedule : undefined,
      clearTriggerSchedule: body.clearTriggerSchedule === true,
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      triggerWebhookPath: typeof body.triggerWebhookPath === 'string' ? body.triggerWebhookPath : undefined,
      clearTriggerWebhookPath: body.clearTriggerWebhookPath === true,
      triggerEvents: Array.isArray(body.triggerEvents) ? body.triggerEvents : undefined,
      clearTriggerEvents: body.clearTriggerEvents === true,
    });
    if (!triggerPatch.ok) { res.status(400).json({ error: triggerPatch.error }); return; }
    if (triggerPatch.changed) next.trigger = triggerPatch.trigger;

    // PATCH can change steps AND flip enabled→true, so auto-repair + re-validate
    // before an enabled workflow is persisted (the set-enabled route already
    // does; this closes the parallel hole where PATCH enables without
    // re-validation).
    const patchPrep = prepareWorkflowUpdateForWrite(entry.data, next, {
      modelPortability: workflowModelPortabilityFromUnknown(body),
      codifyMechanicalSteps: Array.isArray(body.steps),
    });
    if (patchPrep.status === 'invalid') {
      res.status(400).json({ error: 'workflow failed validation', errors: patchPrep.errors }); return;
    }
    if (patchPrep.status === 'readiness_gaps') {
      writeWorkflowAndSyncTriggers(entry.name, patchPrep.def);
      res.json({
        updated: true,
        name: patchPrep.def.name,
        enabled: false,
        repairs: patchPrep.repairs,
        readinessGaps: workflowReadinessGapPayload(patchPrep.def),
      });
      return;
    }
    const activationRequested = entry.data.enabled !== true && patchPrep.def.enabled === true;
    const executionChangedWhileLive = workflowUpdateNeedsVerification(entry.data, patchPrep.def);
    if (patchPrep.def.enabled && (activationRequested || executionChangedWhileLive)) {
      const verification = prepareWorkflowVerification(patchPrep.def, dashboardWorkflowSmokeInputs(body));
      if (verification.needsTest) {
        const disabledDef = { ...patchPrep.def, enabled: false };
        writeWorkflowAndSyncTriggers(entry.name, disabledDef);
        clearWorkflowFailures(entry.name);
        if (verification.missing.length > 0) {
          res.status(409).json({
            error: 'workflow verification missing inputs',
            message: renderMissingSmokeInputs(entry.data.name, verification.missing),
            missingSmokeInputs: verification.missing,
            repairs: patchPrep.repairs,
            enabled: false,
          });
          return;
        }
        const queued = queueWorkflowCreationTest(entry.name, verification.inputs);
        res.status(202).json({
          updated: true,
          name: patchPrep.def.name,
          enabled: false,
          verificationQueued: true,
          runId: queued.id,
          message: queued.message,
          repairs: patchPrep.repairs,
        });
        return;
      }
    }

    writeWorkflowAndSyncTriggers(entry.name, patchPrep.def);
    res.json({ updated: true, name: patchPrep.def.name, repairs: patchPrep.repairs });
  });

  app.post('/api/console/workflows/:name/contract-fixes', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsedFixes = parseWorkflowVisualContractFixes(body.fixes);
    if (!parsedFixes.ok) { res.status(400).json({ error: parsedFixes.error }); return; }

    const fixed = applyWorkflowVisualContractFixes(entry.data, entry.name, {
      fixes: parsedFixes.fixes,
      stepIds: parseWorkflowFixStepIds(body),
      assumeStableItemKeys: body.assumeStableItemKeys === true || body.assume_stable_item_keys === true,
    });
    const dryRun = body.dryRun === true || body.dry_run === true;
    let finalDef = fixed.def;
    let prepRepairs: string[] = [];
    let persisted = false;
    if (fixed.changes.length > 0) {
      const prep = prepareWorkflowUpdateForWrite(entry.data, fixed.def);
      if (prep.status === 'invalid') {
        res.status(400).json({
          error: 'workflow failed validation after contract fixes',
          errors: prep.errors,
          changes: fixed.changes,
          skipped: fixed.skipped,
          beforeExecutionPlan: fixed.beforePlan,
          afterExecutionPlan: fixed.afterPlan,
        });
        return;
      }
      finalDef = prep.def;
      prepRepairs = prep.repairs;
      if (!dryRun) {
        writeWorkflowAndSyncTriggers(entry.name, finalDef);
        persisted = true;
      }
    }
    res.json({
      ok: true,
      updated: persisted,
      dryRun,
      changes: [...new Set([...fixed.changes, ...prepRepairs])],
      skipped: fixed.skipped,
      ...workflowConsoleStatePayload(finalDef, entry.name),
    });
  });

  app.post('/api/console/workflows/:name/contract-actions', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsedKind = parseWorkflowContractActionKind(body.kind ?? body.actionKind ?? body.action_kind);
    if (!parsedKind.ok) { res.status(400).json({ error: parsedKind.error }); return; }
    const stepIds = parseWorkflowFixStepIds(body);
    const dryRun = body.dryRun === true || body.dry_run === true;
    const changes: string[] = [];
    const skipped: string[] = [];
    const next = JSON.parse(JSON.stringify(entry.data)) as WorkflowDefinition;
    let pendingScriptWrite: { filePath: string; content: string } | null = null;

    if (parsedKind.kind === 'confirm_tool_connection') {
      const plan = workflowExecutionPlanFor(entry.data, entry.name);
      const runtimeToolNames = parseWorkflowRuntimeToolNames(body);
      const runtimeItems = runtimeWorkflowReadinessItems(runtimeToolNames, stepIds);
      const items = mergeWorkflowReadinessItems(
        scopedWorkflowReadinessItems(plan.toolReadiness.items, stepIds),
        runtimeItems,
      );
      const cliCommand = normalizeWorkflowContractCliCommand(body.command ?? body.cliCommand ?? body.cli_command);
      if (cliCommand) {
        const cliItems = items.filter((item) => item.kind === 'cli');
        if (cliItems.length === 0) {
          res.status(400).json({
            error: 'no CLI readiness item matched the selected workflow step(s)',
            checkedItems: items,
          });
          return;
        }
        const expected = [...new Set(cliItems.map(workflowCliCommandFromReadinessItem).filter(Boolean))];
        if (expected.length > 0 && !expected.includes(cliCommand)) {
          res.status(400).json({
            error: `CLI command "${cliCommand}" does not match the selected workflow CLI requirement${expected.length === 1 ? '' : 's'}: ${expected.join(', ')}`,
            checkedItems: cliItems,
          });
          return;
        }
        try {
          if (dryRun) {
            changes.push(`Would save CLI "${cliCommand}" to the local CLI inventory for this workflow.`);
          } else {
            addSavedCli(cliCommand);
            changes.push(`Saved CLI "${cliCommand}" to the local CLI inventory for this workflow.`);
          }
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err), checkedItems: cliItems });
          return;
        }
        const payload = workflowConsoleStatePayload(entry.data, entry.name);
        const remaining = scopedWorkflowReadinessItems(payload.executionPlan.toolReadiness.items, stepIds);
        res.json({
          ok: true,
          updated: !dryRun,
          dryRun,
          changes,
          skipped: remaining.length ? remaining.map(workflowReadinessItemSummary) : [],
          connectionReady: remaining.length === 0,
          checkedItems: remaining,
          savedCli: cliCommand,
          savedClis: getSavedClis(),
          ...payload,
        });
        return;
      }
      const toolConnectionChecks = await Promise.all(items.map(workflowConnectionCheckForItem));
      const connectionReady = items.length === 0 || toolConnectionChecks.every((check) => check.status === 'ready');
      res.json({
        ok: true,
        updated: false,
        dryRun,
        changes: [],
        skipped: items.length
          ? toolConnectionChecks.map(workflowConnectionCheckLine)
          : ['No unconfirmed tool connection matched the selected workflow step(s).'],
        connectionReady,
        checkedItems: items,
        toolConnectionChecks,
        ...workflowConsoleStatePayload(entry.data, entry.name),
      });
      return;
    }

    if (parsedKind.kind === 'select_local_project') {
      const projectRef = normalizeWorkflowContractProjectRef(body.project ?? body.projectName ?? body.project_name);
      if (!projectRef) { res.status(400).json({ error: 'project required' }); return; }
      const resolved = resolveWorkspaceProjectForContractAction(projectRef);
      if (!resolved.ok) {
        res.status(404).json({ error: resolved.error, projects: resolved.projects.slice(0, 50) });
        return;
      }
      const projectName = resolved.project.name;
      const scoped = new Set(stepIds ?? []);
      const applyWorkflowLevel = body.scope === 'workflow' || body.workflowLevel === true || body.workflow_level === true || scoped.size === 0;
      if (applyWorkflowLevel) {
        if (next.project !== projectName) {
          next.project = projectName;
          changes.push(`Bound workflow project to "${projectName}" (${resolved.project.path}).`);
        }
      } else {
        let touched = 0;
        next.steps = next.steps.map((step) => {
          if (!scoped.has(step.id)) return step;
          if (step.project === projectName) return step;
          touched += 1;
          return { ...step, project: projectName };
        });
        if (touched > 0) changes.push(`Bound ${touched} step${touched === 1 ? '' : 's'} to local project "${projectName}" (${resolved.project.path}).`);
      }
      if (changes.length === 0) skipped.push(`Selected workflow scope already uses local project "${projectName}".`);
    }

    if (parsedKind.kind === 'add_workflow_script') {
      const parsedRunner = normalizeWorkflowScriptRunner(body.runner ?? body.script ?? body.scriptName ?? body.script_name);
      if (!parsedRunner.ok) { res.status(400).json({ error: parsedRunner.error }); return; }
      const scriptFile = resolveWorkflowScriptFile(entry.name, parsedRunner.relativePath);
      if (!scriptFile.ok) { res.status(400).json({ error: scriptFile.error }); return; }
      const scriptContent = typeof body.scriptContent === 'string'
        ? body.scriptContent
        : typeof body.script_content === 'string'
          ? body.script_content
          : '';
      const overwrite = body.overwrite === true;
      if (scriptContent) {
        if (scriptContent.length > 200_000) { res.status(400).json({ error: 'script content is too large' }); return; }
        if (existsSync(scriptFile.filePath) && !overwrite) {
          res.status(409).json({
            error: 'workflow script already exists; pass overwrite=true to replace it',
            runner: parsedRunner.runner,
            workflowScriptsDir: scriptFile.scriptsDir,
          });
          return;
        }
        if (!dryRun) pendingScriptWrite = { filePath: scriptFile.filePath, content: scriptContent.trimEnd() + '\n' };
        changes.push(`${dryRun ? 'Would create' : 'Created'} workflow script "scripts/${parsedRunner.runner}".`);
      } else if (!existsSync(scriptFile.filePath)) {
        res.status(409).json({
          error: 'workflow script does not exist; add scriptContent or choose an existing runner',
          runner: parsedRunner.runner,
          workflowScriptsDir: scriptFile.scriptsDir,
          availableScripts: listWorkflowScriptNames(entry.name).slice(0, 50),
        });
        return;
      }

      const scoped = workflowStepScopeForAction(next, stepIds);
      if (scoped.size === 0) { res.status(400).json({ error: 'stepIds required when more than one deterministic step could be repaired' }); return; }
      let touched = 0;
      next.steps = next.steps.map((step) => {
        if (!scoped.has(step.id)) return step;
        if (!step.deterministic?.runner) return step;
        if (step.deterministic.runner === parsedRunner.runner) return step;
        touched += 1;
        return { ...step, deterministic: { runner: parsedRunner.runner } };
      });
      if (touched > 0) changes.push(`Bound ${touched} deterministic step${touched === 1 ? '' : 's'} to runner "${parsedRunner.runner}".`);
      if (touched === 0 && !scriptContent) skipped.push(`Selected deterministic step(s) already use runner "${parsedRunner.runner}".`);
    }

    const prep = prepareWorkflowUpdateForWrite(entry.data, next);
    if (prep.status === 'invalid') {
      res.status(400).json({ error: 'workflow failed validation after contract action', errors: prep.errors, changes, skipped });
      return;
    }
    const finalDef = prep.def;
    const allChanges = [...new Set([...changes, ...prep.repairs])];
    if (allChanges.length > 0 && !dryRun) {
      if (pendingScriptWrite) {
        fs.mkdirSync(path.dirname(pendingScriptWrite.filePath), { recursive: true });
        writeFileSync(pendingScriptWrite.filePath, pendingScriptWrite.content, 'utf-8');
      }
      writeWorkflowAndSyncTriggers(entry.name, finalDef);
    }
    res.json({
      ok: true,
      updated: allChanges.length > 0 && !dryRun,
      dryRun,
      changes: allChanges,
      skipped,
      ...workflowConsoleStatePayload(finalDef, entry.name),
    });
  });

  app.delete('/api/console/workflows/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    deleteWorkflowAndSyncTriggers(entry.name);
    res.json({ deleted: true });
  });

  app.post('/api/console/workflows/:name/set-enabled', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const body = req.body ?? {};
    if (typeof body.enabled !== 'boolean') { res.status(400).json({ error: 'enabled (boolean) required' }); return; }
    // A workflow whose data can't flow can't be ENABLED (disabling always
    // allowed). Auto-repair the fixable binding gaps so enabling an older
    // workflow fixes it in place instead of refusing.
    if (body.enabled) {
      const prep = prepareWorkflowEnableForWrite(entry.data);
      if (prep.status === 'invalid') {
        res.status(400).json({ error: 'workflow failed validation', errors: prep.errors });
        return;
      }
      if (prep.status === 'readiness_gaps') {
        writeWorkflowAndSyncTriggers(entry.name, prep.def);
        res.status(409).json({ error: 'workflow has unresolved readiness gaps', gaps: workflowReadinessGapPayload(prep.def), repairs: prep.repairs });
        return;
      }
      const verification = prepareWorkflowVerification(prep.def, dashboardWorkflowSmokeInputs(body));
      if (verification.needsTest) {
        writeWorkflowAndSyncTriggers(entry.name, { ...prep.def, enabled: false });
        clearWorkflowFailures(entry.name);
        if (verification.missing.length > 0) {
          res.status(409).json({
            error: 'workflow verification missing inputs',
            message: renderMissingSmokeInputs(entry.data.name, verification.missing),
            missingSmokeInputs: verification.missing,
            repairs: prep.repairs,
            enabled: false,
          });
          return;
        }
        const queued = queueWorkflowCreationTest(entry.name, verification.inputs);
        res.status(202).json({
          updated: true,
          enabled: false,
          verificationQueued: true,
          runId: queued.id,
          message: queued.message,
          repairs: prep.repairs,
        });
        return;
      }
      writeWorkflowAndSyncTriggers(entry.name, prep.def);
      clearWorkflowFailures(entry.name);
      res.json({ updated: true, enabled: true, repairs: prep.repairs });
      return;
    }
    writeWorkflowAndSyncTriggers(entry.name, { ...entry.data, enabled: false });
    res.json({ updated: true, enabled: false });
  });

  app.post('/api/console/workflows/:name/validate', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    // The validator was written against the legacy WorkflowFrontmatter
    // shape (loose fields, may be undefined). Convert from the typed
    // WorkflowDefinition by surfacing only the fields the validator
    // reads — keeps validation rules identical pre/post-migration.
    const data: WorkflowFrontmatter = {
      name: entry.data.name,
      description: entry.data.description,
      enabled: entry.data.enabled,
      trigger: entry.data.trigger,
      steps: entry.data.steps as unknown as WorkflowStepShape[],
      inputs: entry.data.inputs,
      resources: entry.data.resources,
      synthesis: entry.data.synthesis,
      goal: entry.data.goal,
    };
    res.json(validateWorkflowDefinition(data));
  });

  /**
   * Recent runs for a single workflow. Reads from
   * ~/.clementine-next/workflows/runs/ and filters by workflow name.
   * The runs dir holds one JSON per run with shape:
   *   { id, workflow, inputs, status, createdAt, source,
   *     completedAt?, output?, error? }
   */
  app.get('/api/console/workflows/:name/runs', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const workflowName = req.params.name;
    const limit = Math.max(1, Math.min(50, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '20', 10) || 20));
    try {
      if (!fs.existsSync(WORKFLOW_RUNS_DIR)) {
        res.json({ runs: [] });
        return;
      }
      const files = fs.readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json'));
      const runs: Array<Record<string, unknown>> = [];
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
          if (data.workflow === workflowName) runs.push(data);
        } catch { /* skip malformed */ }
      }
      runs.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      res.json({ runs: runs.slice(0, limit) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/workflows/:name/run', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const body = req.body ?? {};
    const inputs = body.inputs && typeof body.inputs === 'object' ? body.inputs : {};
    const dryRun = body.dryRun === true;
    // Single-step "try this" hint. When set, the runner executes only
    // the named step (no upstream chain, no synthesis) so the user can
    // see what one step does in isolation. Bypasses the enabled gate
    // because TRY is a deliberate user action on a draft.
    const targetStepId = typeof body.targetStepId === 'string' && body.targetStepId.trim() ? body.targetStepId.trim() : null;
    if (targetStepId && !entry.data.steps.some((s) => s.id === targetStepId)) {
      res.status(400).json({ error: `step "${targetStepId}" is not defined in this workflow` });
      return;
    }
    if (!dryRun && !targetStepId && entry.data.enabled === false) {
      res.status(409).json({ error: 'workflow is disabled — approve it first' }); return;
    }

    const normalizedInputs = normalizeWorkflowRunInputs(inputs as Record<string, string>);
    if (!dryRun) {
      const certification = workflowCertificationFor(entry.data, entry.name);
      if (certification.resourceGaps.length > 0) {
        res.status(409).json({
          error: 'workflow resource bindings incomplete',
          message: certification.summary,
          resourceGaps: certification.resourceGaps,
          certification: workflowCertificationSummary(certification),
        });
        return;
      }
    }
    if (dryRun) {
      const queued = queueWorkflowDryRun(entry.data.name, normalizedInputs, {
        source: 'console',
        ...(targetStepId ? { targetStepId } : {}),
      });
      res.json({ queued: false, dryRun, id: queued.id, targetStepId });
      return;
    }
    if (targetStepId) {
      const recoveryIntent = workflowRunRecoveryIntentFromBody(body, {
        kind: 'step_try',
        sourceStepId: targetStepId,
        requestedFrom: 'console',
        reason: 'single-step try run',
      });
      const queued = queueWorkflowRun(entry.data.name, normalizedInputs, {
        source: 'console',
        targetStepId,
        dedupe: false,
        recoveryIntent,
      });
      if (queued.status === 'blocked_readiness') {
        res.status(409).json(workflowReadinessBlockedBody(queued.message, queued.readiness, { status: queued.status, dryRun, targetStepId }));
        return;
      }
      res.json({ queued: true, dryRun, id: queued.id, targetStepId });
      return;
    }

    const queued = resumeWorkflowRun(entry.data.name, normalizedInputs, { source: 'console' });
    if (queued.status === 'missing_inputs') {
      res.status(400).json({
        error: `missing required workflow input${(queued.missing ?? []).length === 1 ? '' : 's'}: ${(queued.missing ?? []).join(', ')}`,
        missingInputs: queued.missing ?? [],
      });
      return;
    }
    if (queued.status === 'disabled') {
      res.status(409).json({ error: queued.message });
      return;
    }
    if (queued.status === 'not_found') {
      res.status(404).json({ error: queued.message });
      return;
    }
    if (queued.status === 'blocked_readiness') {
      res.status(409).json(workflowReadinessBlockedBody(queued.message, queued.readiness, { status: queued.status, dryRun, targetStepId }));
      return;
    }
    res.json({ queued: queued.status !== 'duplicate', duplicate: queued.status === 'duplicate', dryRun, id: queued.id, targetStepId });
  });

  // Ever-learning quality contract: turn "this run was wrong because X" into
  // durable, checkable success criteria the completion judge holds every FUTURE
  // run to. This is how output-quality trust compounds — the same mistake never
  // silently recurs once you've named it.
  app.post('/api/console/workflows/:name/quality-feedback', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim() : '';
    if (!feedback) { res.status(400).json({ error: 'feedback is required' }); return; }
    const result = applyLearnedQualityCriteria(entry.data, feedback);
    if (result.changed) writeWorkflowAndSyncTriggers(entry.name, result.def);
    res.json({
      changed: result.changed,
      added: result.added,
      criteria: result.criteria,
      message: result.changed
        ? `Learned ${result.added.length} new quality ${result.added.length === 1 ? 'criterion' : 'criteria'} — every future run of "${entry.data.name}" is now judged against ${result.criteria.length} criteria.`
        : `No new criteria — "${entry.data.name}" already holds runs to that bar.`,
    });
  });

  app.get('/api/console/workflows/:name/quality-contract', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const entry = listWorkflows().find((e) => e.data.name === req.params.name || e.name === req.params.name);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    res.json({ criteria: workflowQualityCriteria(entry.data), objective: entry.data.goal?.objective ?? null });
  });

  // The live "check in on your employees" window: the run's shared workspace —
  // its goal anchor + every step's persisted work product (the manifest). Reads
  // straight off disk; no run needs to be in memory.
  app.get('/api/console/workflows/:name/runs/:runId/workspace', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const entry = listWorkflows().find((e) => e.data.name === req.params.name || e.name === req.params.name);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const goal = readRunGoal(entry.name, req.params.runId);
    // Collapse to the latest artifact per producer, so a re-pursued step shows
    // its newest work rather than every historical write.
    const byAgent = new Map<string, import('../execution/workflow-run-workspace.js').WorkspaceArtifact>();
    for (const a of readWorkspaceManifest(entry.name, req.params.runId)) byAgent.set(`${a.agent}:${a.tool}`, a);
    const artifacts = Array.from(byAgent.values());
    res.json({
      runId: req.params.runId,
      goal,
      artifacts,
      totalBytes: workspaceArtifactBytes(entry.name, req.params.runId),
      checker: readWorkspaceCheckerReport(entry.name, req.params.runId),
    });
  });

  // Subagent visibility: every specialized agent this run spawned (Claude / Codex
  // / GLM-BYO fan-out), with role, provider, model, task, status — so opening a
  // workflow shows WHO worked. Full work-product via the /output route below.
  app.get('/api/console/workflows/:name/runs/:runId/agents', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const runs = listSubagentRuns(req.params.runId);
    res.json({
      runId: req.params.runId,
      agents: runs,
      byProvider: runs.reduce<Record<string, number>>((acc, r) => { acc[r.provider] = (acc[r.provider] ?? 0) + 1; return acc; }, {}),
    });
  });

  // One specialized agent's full persisted work-product ("the work they did").
  app.get('/api/console/workflows/:name/runs/:runId/agents/:agentId/output', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const output = readSubagentOutput(req.params.runId, req.params.agentId);
    if (output === null) { res.status(404).json({ error: 'no work-product for that agent' }); return; }
    res.json({ agentId: req.params.agentId, output });
  });

  // Run the CHECKER agent: a second agent reads the shared workspace (goal +
  // every step's work product) and judges it against the goal's criteria, then
  // persists the verdict so the window shows it. This is "agents checking each
  // other's work". Uses the real cross-family judge (default deps).
  app.post('/api/console/workflows/:name/runs/:runId/check', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const entry = listWorkflows().find((e) => e.data.name === req.params.name || e.name === req.params.name);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    try {
      const report = await checkRunAgainstGoal({
        workflowName: entry.name,
        runId: req.params.runId,
        objective: entry.data.goal?.objective?.trim() || entry.data.description?.trim() || `Deliver "${entry.data.name}"`,
        successCriteria: entry.data.goal?.successCriteria,
        checkedAt: new Date().toISOString(),
      });
      writeWorkspaceCheckerReport(entry.name, req.params.runId, report);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/workflows/:name/runs/:runId/failed-items', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const runId = req.params.runId;
    const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'workflow run not found' });
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      if (raw.workflow !== entry.data.name && raw.workflow !== entry.name) {
        res.status(404).json({ error: 'workflow run does not belong to this workflow' });
        return;
      }
      const failedItems = listFinalFailedItems(entry.name, runId);
      const stepIds = Array.from(new Set(failedItems.map((item) => item.stepId)));
      res.json({
        runId,
        workflow: entry.data.name,
        failedItems,
        count: failedItems.length,
        stepIds,
        ambiguous: stepIds.length > 1,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/workflows/:name/runs/:runId/retry-failed-items', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const runId = req.params.runId;
    const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'workflow run not found' });
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      if (raw.workflow !== entry.data.name && raw.workflow !== entry.name) {
        res.status(404).json({ error: 'workflow run does not belong to this workflow' });
        return;
      }
      const stepId = typeof req.body?.stepId === 'string' && req.body.stepId.trim()
        ? req.body.stepId.trim()
        : undefined;
      const result = requeueWorkflowFailedItemsFromRun(runId, {
        stepId,
        source: 'console',
        recoveryIntent: workflowRunRecoveryIntentFromBody(req.body, {
          kind: 'failed_items',
          sourceRunId: runId,
          sourceStepId: stepId,
          requestedFrom: 'console',
          reason: 'retry final failed forEach items',
        }),
      });
      res.status(result.status === 'blocked_readiness' ? 409 : 200).json({
        ok: result.status === 'queued' || result.status === 'duplicate',
        status: result.status,
        id: result.id,
        message: result.message,
        failedItems: result.failedItems ?? [],
        ...(result.status === 'blocked_readiness' ? workflowReadinessBlockedBody(result.message, result.readiness) : {}),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/workflows/:name/runs/:runId/cancel', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const runId = req.params.runId;
    const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'workflow run not found' });
      return;
    }
    try {
      const now = new Date().toISOString();
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      if (raw.workflow !== entry.data.name) {
        res.status(404).json({ error: 'workflow run does not belong to this workflow' });
        return;
      }
      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 500)
        : 'Cancelled from the desktop dashboard.';
      const events = readWorkflowEvents(entry.name, runId);
      const hasTerminal = events.some((ev) =>
        ev.kind === 'run_completed' || ev.kind === 'run_failed' || ev.kind === 'run_cancelled',
      );
      if (!hasTerminal) {
        appendWorkflowEvent(entry.name, runId, {
          kind: 'run_cancelled',
          error: reason,
          meta: { source: 'desktop-dashboard' },
        });
      }
      const next = {
        ...raw,
        status: 'cancelled',
        cancelledAt: typeof raw.cancelledAt === 'string' ? raw.cancelledAt : now,
        finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : now,
        error: typeof raw.error === 'string' && raw.error ? raw.error : reason,
      };
      fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
      res.json({ ok: true, run: next });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Replay a run's durable event log into the compact read model needed by the
   * workflow graph. This is deliberately derived on read from events.jsonl so
   * the visualizer never becomes a second workflow state machine.
   */
  app.get('/api/console/workflows/:name/runs/:runId/graph-overlay', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    try {
      const events = readWorkflowEvents(entry.name, req.params.runId);
      const executionPlan = workflowExecutionPlanFor(entry.data, entry.name);
      const overlay = buildWorkflowRunGraphOverlay(events, {
        stepIds: entry.data.steps.map((step) => step.id),
        harnessSessions: workflowGraphHarnessEvidence(req.params.runId),
        launchReadiness: readWorkflowRunLaunchReadiness(req.params.runId, [entry.data.name, entry.name]),
        executionPlan,
        recoveryIntent: readWorkflowRunRecoveryIntent(req.params.runId, [entry.data.name, entry.name]),
        recoveryLineage: buildWorkflowRecoveryLineage(entry.name, entry.data.name, req.params.runId),
      });
      const lineage = buildWorkflowGoalLineage(
        entry.name,
        entry.data.name,
        req.params.runId,
        entry.data.steps.map((step) => step.id),
      );
      if (lineage.length > 1) {
        if (overlay.goal) {
          overlay.goal.lineage = lineage;
        } else {
          overlay.goal = {
            status: 'unknown',
            failedCriteria: [],
            attempts: [],
            lineage,
            attentionLevel: 'none',
          };
        }
      }
      res.json({
        runId: req.params.runId,
        workflow: entry.data.name,
        overlay,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Live event stream for a workflow run. Reads the per-run
   * events.jsonl log written by the workflow runner. Used by the
   * dashboard's planned chat-first UI to render step status updates
   * (RUNNING / DONE / FAILED) and the live transcript as a workflow
   * progresses. JSON polling for now; SSE can layer on later.
   *
   * Query params:
   *   ?since=<timestamp> — return events strictly after this ISO time
   *                       (cheap incremental polling)
   *   ?limit=<n>         — cap at n events (newest-last); default 500
   */
  app.get('/api/console/workflows/:name/runs/:runId/events', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const limit = Math.max(1, Math.min(2000, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '500', 10) || 500));
    try {
      const all = readWorkflowEvents(entry.name, req.params.runId);
      const filtered = since ? all.filter((ev) => ev.t > since) : all;
      const tail = filtered.length > limit ? filtered.slice(-limit) : filtered;
      res.json({
        runId: req.params.runId,
        workflow: entry.data.name,
        events: tail,
        count: tail.length,
        truncated: filtered.length > tail.length,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Workflow architect chat — sends the user's message + the current
   * draft workflow JSON to the assistant with workflow-builder-specific
   * instructions, returns the response text. Stateless per call;
   * frontend manages the chat history client-side and replays it as
   * a single rolled-up prompt for context. Keeps the backend simple.
   */
  app.post('/api/console/workflows/architect/chat', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const userMessage = typeof body.message === 'string' ? body.message.trim() : '';
    if (!userMessage) { res.status(400).json({ error: 'message required' }); return; }
    const draft = body.draft && typeof body.draft === 'object' ? body.draft : null;
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];

    const transcript = history.map((m: { role?: string; text?: string }) => `${m.role === 'assistant' ? 'Architect' : 'User'}: ${m.text ?? ''}`).join('\n\n');
    const draftBlock = draft ? `Current workflow draft (JSON):\n\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\`` : 'No draft yet — agent is starting from scratch.';

    // Surface installed skills so the architect can compose them
    // (uses_skill on a step). Without this the model has no way to
    // know which skills the user has installed — and skills are the
    // most leverage primitive for re-using captured expertise.
    const installedSkills = listSkills();
    const skillsBlock = installedSkills.length > 0
      ? [
          'Installed skills (use them by setting `uses_skill: "<name>"` on a step — the runner injects the SKILL.md body before the step prompt):',
          ...installedSkills.map((s) => `- ${s.name}: ${s.frontmatter.description || '(no description)'}`),
        ].join('\n')
      : '';

    const prompt = [
      'You are the Clementine Workflow Architect — a focused sub-mode that helps the user design and edit multi-step workflows.',
      'Each workflow has: name, description, trigger, steps, workflow inputs, durable resources, optional goal, and optional synthesis prompt.',
      'Step shape: { id, prompt?, dependsOn?, allowed_tools?, call?, inputs?, output?, sideEffect?, forEach?, uses_skill?, requiresApproval?, approvalPreview? }.',
      'Use workflow inputs for per-run values. Use durable resources for fixed sheets/accounts/folders/channels/campaigns/repos/CLIs that the workflow should remember between runs.',
      'Be terse. No preamble. Lead with the answer. One short paragraph of prose at most.',
      '',
      'IMPORTANT — proposing changes:',
      '• Do NOT call workflow_create or any workflow_* tool. The user will apply your proposed changes from the UI.',
      '• If you are proposing ANY change to the draft, your reply MUST end with a single fenced ```json code block containing an object with shape { ops: [...], summary: "..." }.',
      '• Each op is one of:',
      '    { "type": "set_field",    "path": "name" | "description" | "triggerSchedule" | "enabled", "value": <value> }',
      '    { "type": "add_step",     "step": { "id": "<id>", "prompt"?: "<text>", "dependsOn"?: ["<id>", ...], "allowed_tools"?: ["<tool>", ...], "call"?: {"tool":"<direct-tool-slug>","args":{}}, "inputs"?: {"arg":{"from":"input.key"}}, "output"?: {"type":"object","required_keys":["..."]}, "sideEffect"?: "read|write|send", "uses_skill"?: "<skill-name>", "requiresApproval"?: true, "approvalPreview"?: "<text>" } }',
      '    { "type": "update_step",  "id": "<existing-id>", "patch": { "prompt"?: "...", "dependsOn"?: [...], "allowed_tools"?: [...], "call"?: {...} | null, "inputs"?: {...} | null, "output"?: {...} | null, "sideEffect"?: "read|write|send" | null, "uses_skill"?: "<skill-name> | null", "requiresApproval"?: true | false, "approvalPreview"?: "<text> | null" } }',
      '    { "type": "remove_step",  "id": "<existing-id>" }',
      '    { "type": "reorder_step", "id": "<existing-id>", "after": "<other-id> | null (null = move to first)" }',
      '    { "type": "rename_step",  "id": "<existing-id>", "newId": "<new-id>" }',
      '    { "type": "add_input",    "key": "<key>", "value": "<default-or-empty>" }',
      '    { "type": "remove_input", "key": "<key>" }',
      '    { "type": "add_resource", "key": "<id>", "value": { "kind": "sheet|account|folder|channel|campaign|repository|cli|api|other", "label"?: "<name>", "toolkit"?: "<toolkit>", "resourceId"?: "<id>", "url"?: "<url>", "name"?: "<name>", "required"?: true } }',
      '    { "type": "remove_resource", "key": "<id>" }',
      '    { "type": "set_synthesis","value": "<prompt-text> | null (null clears it)" }',
      '• Keep ops minimal. Use update_step (with only the fields you actually change) instead of remove + add.',
      '• For known exact tool calls, prefer `call` with templated args. For mechanical single-tool prompt steps, set one direct `allowed_tools` slug plus step `inputs` and `output` so the compiler can codify it.',
      '• When the exact direct call is not known, populate allowed_tools with the minimum runtime surface needed (e.g. ["composio_execute_tool"]) and keep the step as an adaptive prompt step.',
      '• Declare sideEffect on every external step: read, write, or send. Set requiresApproval on irreversible sends/publishes unless the user explicitly wants autonomous sends.',
      '• When an installed skill already captures the expertise a step needs, set uses_skill instead of re-prompting that expertise inline. The runner injects the skill body automatically.',
      '• If you have nothing to propose (pure question, validation, advice), omit the JSON block entirely.',
      '',
      skillsBlock,
      '',
      draftBlock,
      '',
      transcript ? `Conversation so far:\n${transcript}\n` : '',
      `User: ${userMessage}`,
    ].filter(Boolean).join('\n\n');

    try {
      // FORK collapse (staged): route through the GATED harness loop, which now
      // enforces the workflow_* exclusion (the architect's diff-card backstop).
      // Gated by the default-OFF `dashboard` staging surface → byte-identical to
      // the legacy path until CLEMMY_HARNESS_DASHBOARD=on, then live-verified +
      // baked in. The 5 gates the legacy core lacks come for free on the loop.
      const architectReq = {
        message: prompt,
        sessionId: `console:workflow-architect:${body.draftName ?? 'new'}`,
        channel: 'cli',
        userId: 'console',
        // Code-level backstop for the prompt instruction above. The
        // architect's reply MUST take the form of diff ops the user
        // applies via the UI — hiding the workflow_* tools means the
        // model cannot bypass the diff-card flow even if the prompt is
        // ignored. See RunRequest.excludeToolNames.
        excludeToolNames: ARCHITECT_HIDDEN_TOOLS,
      };
      const response = await respondPreferHarness('dashboard', architectReq, (req) => assistant.respond(req));
      const { text, diff } = extractArchitectDiff(response.text ?? '');
      res.json({ text, diff });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Tools catalog ────────────────────────────────────────────

  /** Map a tool name to a UI-friendly category. Mirrors the runtime
   *  categories used by autonomy-v2's policy filter + the dashboard
   *  state's toolCategory. Kept here so the console doesn't depend on
   *  the dashboard module. */
  function categorizeTool(name: string): string {
    if (name.startsWith('memory_') || name === 'working_memory' || name.startsWith('note_')) return 'Memory';
    if (name.startsWith('task_') || name === 'create_plan' || name === 'list_plans' || name === 'update_plan_step' || name === 'discover_work' || name.startsWith('goal_')) return 'Planning';
    if (name.startsWith('execution_')) return 'Executions';
    if (name.startsWith('check_in') || name === 'ask_user_question' || name === 'list_pending_check_ins' || name === 'answer_check_in') return 'Check-ins';
    if (name === 'notify_user') return 'Notifications';
    if (name.startsWith('agent_run') || name.startsWith('user_profile') || name.startsWith('team_') || name.startsWith('create_agent') || name.startsWith('update_agent') || name.startsWith('delete_agent') || name.startsWith('delegate') || name === 'check_delegation') return 'Agents';
    if (name === 'set_timer' || name.startsWith('cron_') || name.startsWith('workflow_') || name === 'trigger_cron_job' || name === 'add_cron_job' || name === 'schedule_list') return 'Automation';
    if (name === 'workspace_config' || name === 'workspace_list' || name === 'workspace_info' || name === 'workspace_roots' || name === 'list_files' || name === 'read_file' || name === 'write_file' || name === 'run_shell_command' || name === 'git_status' || name === 'local_cli_list' || name === 'local_cli_probe') return 'Computer';
    if (name === 'skill_list' || name === 'skill_read') return 'Skills';
    if (name.startsWith('composio_') || name.startsWith('cx_')) return 'Connected Apps';
    if (name.startsWith('browser_harness')) return 'Browser';
    if (name === 'session_history' || name === 'session_pause' || name === 'session_resume') return 'Sessions';
    if (name === 'create_tool') return 'Meta';
    if (name === 'ping') return 'System';
    if (name === 'request_destructive_action') return 'System';
    return 'Other';
  }

  app.get('/api/console/tools', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      // Local MCP tools — from the catalog (string names) plus the
      // SDK-native tools registered in registry.ts (have full schema).
      const sdkTools = (await getCoreToolsAsync({ includeDynamicComposioTools: false }))
        .filter((tool) => tool.type === 'function')
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          category: categorizeTool(tool.name),
          source: 'sdk' as const,
          needsApproval: classifyTool(tool.name) === 'read'
            ? false
            : Boolean((tool as { needsApproval?: unknown }).needsApproval),
        }));

      const sdkNames = new Set(sdkTools.map((t) => t.name));
      const mcpOnlyTools = LOCAL_MCP_TOOL_NAMES
        .filter((name) => !sdkNames.has(name))
        .map((name) => ({
          name,
          description: '',
          category: categorizeTool(name),
          source: 'mcp' as const,
          needsApproval: false,
        }));

      const allTools = [...sdkTools, ...mcpOnlyTools].sort((a, b) =>
        a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
      );

      // Discovered MCP servers (firecrawl, playwright, etc.) from
      // Clementine config plus compatible local MCP client configs.
      const mcpServers = discoverMcpServers().map((server) => ({
        name: server.name,
        description: server.description ?? '',
        enabled: server.enabled !== false,
        source: server.source,
        transport: server.type,
        command: server.command,
        url: server.url,
      }));

      // Installed skills. Surfaced alongside tools so the Workflow
      // Studio picker can offer them as @-mentionable primitives — a
      // step can bind to a skill via usesSkill, which causes the
      // runner to inject the SKILL.md body into the step's prompt.
      // Read-only on this endpoint — install/uninstall lives elsewhere.
      const skills = listSkills().map((s) => ({
        name: s.name,
        description: s.frontmatter.description || '',
        bodyPreview: s.bodyPreview,
        hasScripts: s.hasScripts,
        hasReferences: s.hasReferences,
      }));

      res.json({ tools: allTools, mcpServers, skills });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Local CLIs ────────────────────────────────────────────────
  //
  // Walks the user's $PATH and surfaces installed CLIs so the
  // dashboard can show "yes, sf/gh/aws/etc. are here" without us
  // maintaining a curated allowlist. The agent gets the same data
  // via local_cli_list / local_cli_probe MCP tools.
  //
  // Cached for ~10 min (see src/runtime/cli-discovery.ts). Pass
  // ?refresh=1 to force a fresh scan.

  app.get('/api/console/clis', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      const cached = force ? undefined : readCachedScan();
      const scan = cached ?? await getOrRefreshScan({ force });
      res.json({
        scannedAt: scan.scannedAt,
        cached: !force && !!cached,
        cliCount: scan.clis.length,
        detectedCount: scan.detected.length,
        clis: scan.clis,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/clis/scan', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const scan = await getOrRefreshScan({ force: true });
      res.json({
        scannedAt: scan.scannedAt,
        cliCount: scan.clis.length,
        detectedCount: scan.detected.length,
        clis: scan.clis,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/clis/probe', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const command = typeof req.query.command === 'string' ? req.query.command.trim() : '';
    if (!command || command.length > 60 || /[/\\\s]/.test(command)) {
      res.status(400).json({ error: 'invalid command — pass a bare CLI name like "sf" or "gh"' });
      return;
    }
    try {
      const entry = await probe(command);
      if (!entry) { res.status(404).json({ error: 'not installed', command }); return; }
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // User-saved CLIs — the tools the user has explicitly told Clementine they
  // use (works even when the PATH scan can't see/probe them, e.g. sf).
  app.get('/api/console/clis/saved', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.json({ saved: getSavedClis() });
  });
  app.post('/api/console/clis/saved', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const command = typeof req.body?.command === 'string' ? req.body.command : '';
    try { res.json({ saved: addSavedCli(command) }); }
    catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.delete('/api/console/clis/saved', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const command = typeof req.query.command === 'string' ? req.query.command : '';
    res.json({ saved: removeSavedCli(command) });
  });

  // ─── Projects (workspace) ─────────────────────────────────────

  app.get('/api/console/projects', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const dirs = getWorkspaceDirs();
      const projects = listWorkspaceProjects() || [];
      res.json({ workspaceDirs: dirs, projects });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Inspect one project deeply: README, CLAUDE.md, package.json snippet
   *  to surface relevant metadata for the user without exposing the
   *  whole filesystem.
   *
   *  All filesystem reads are async + bounded by a per-read timeout —
   *  workspace dirs can live on CloudStorage / OneDrive / network mounts
   *  where read() can block indefinitely. A single hung read here used
   *  to freeze the entire daemon event loop and take the dashboard down. */
  app.get('/api/console/projects/inspect', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const root = typeof req.query.path === 'string' ? req.query.path : '';
    if (!root || !existsSync(root)) { res.status(404).json({ error: 'path not found' }); return; }

    const FS_TIMEOUT_MS = 1500;
    const withTimeout = async <T>(work: Promise<T>): Promise<T | undefined> => {
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), FS_TIMEOUT_MS);
      });
      try {
        return await Promise.race([work, timeout]);
      } catch {
        return undefined;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      const result: Record<string, unknown> = { path: root };
      const timedOut: string[] = [];

      // README in any common form.
      for (const name of ['README.md', 'readme.md', 'README', 'README.markdown']) {
        const candidate = path.join(root, name);
        if (!existsSync(candidate)) continue;
        const content = await withTimeout(fs.promises.readFile(candidate, 'utf-8'));
        if (content === undefined) { timedOut.push(name); break; }
        result.readme = content.slice(0, 8000);
        break;
      }

      // CLAUDE.md — both root and .claude/ subdir.
      for (const candidate of [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')]) {
        if (!existsSync(candidate)) continue;
        const content = await withTimeout(fs.promises.readFile(candidate, 'utf-8'));
        if (content === undefined) { timedOut.push('CLAUDE.md'); break; }
        result.claudeMd = content.slice(0, 8000);
        break;
      }

      // package.json — pull a structured snippet.
      const pkgPath = path.join(root, 'package.json');
      if (existsSync(pkgPath)) {
        const content = await withTimeout(fs.promises.readFile(pkgPath, 'utf-8'));
        if (content === undefined) {
          timedOut.push('package.json');
        } else {
          try {
            const pkg = JSON.parse(content);
            result.package = {
              name: pkg.name,
              version: pkg.version,
              description: pkg.description,
              scripts: pkg.scripts ?? {},
              dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
              devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : [],
            };
          } catch { /* malformed JSON — skip */ }
        }
      }

      // Top-level entries.
      const entries = await withTimeout(fs.promises.readdir(root, { withFileTypes: true }));
      if (entries === undefined) {
        timedOut.push('(directory listing)');
      } else {
        result.entries = entries
          .filter((e) => !e.name.startsWith('.'))
          .slice(0, 80)
          .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      }

      if (timedOut.length > 0) {
        result.warning = `Slow filesystem (${timedOut.join(', ')} timed out after ${FS_TIMEOUT_MS}ms). The path may be on CloudStorage / OneDrive / a network mount.`;
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Workspace management (add / remove / browse / search) ─────
  //
  // Lets the user link arbitrary directories as workspace projects
  // from the UI instead of editing WORKSPACE_DIRS in .env by hand.
  // The agent's workspace_list / workspace_info / list_files tools
  // all read from getWorkspaceDirs(), which re-parses .env on every
  // call — so adds/removes take effect immediately on the next agent
  // turn, no daemon restart.

  function writeWorkspaceDirs(dirs: string[]): void {
    // No trim — folder names with significant trailing whitespace
    // must survive a round-trip through the .env. The downstream
    // getWorkspaceDirs() resolver is whitespace-tolerant: it tries
    // the entry as-written first, then trimmed, so CSV entries with
    // " "-padding still work either way.
    const value = dirs.filter((d) => d.length > 0).join(',');
    updateEnvKey('WORKSPACE_DIRS', value);
  }

  function readConfiguredWorkspaceDirs(): string[] {
    const env = readBaseEnv();
    return (env.WORKSPACE_DIRS ?? '').split(',').filter((entry) => entry.length > 0);
  }

  app.post('/api/console/projects/workspace', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const raw = typeof body.path === 'string' ? body.path : '';
    if (!raw.trim()) { res.status(400).json({ error: 'path required' }); return; }
    // Preserve trailing spaces and unusual names — only trim wrapping
    // whitespace the user clearly didn't mean. Resolve so relative or
    // ~/-prefixed paths land on a concrete absolute directory.
    const expanded = raw.startsWith('~')
      ? path.join(os.homedir(), raw.slice(1))
      : raw;
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    if (!existsSync(absolute)) { res.status(404).json({ error: 'path does not exist on disk' }); return; }
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isDirectory()) { res.status(400).json({ error: 'path is not a directory' }); return; }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const existing = readConfiguredWorkspaceDirs();
    if (existing.includes(absolute)) {
      res.json({ ok: true, alreadyLinked: true, workspaceDirs: existing });
      return;
    }
    const next = [...existing, absolute];
    writeWorkspaceDirs(next);
    res.json({ ok: true, workspaceDirs: next });
  });

  app.delete('/api/console/projects/workspace', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) { res.status(400).json({ error: 'path query param required' }); return; }
    const existing = readConfiguredWorkspaceDirs();
    const next = existing.filter((d) => d !== target);
    if (next.length === existing.length) {
      res.status(404).json({ error: 'path was not in WORKSPACE_DIRS' });
      return;
    }
    writeWorkspaceDirs(next);
    res.json({ ok: true, workspaceDirs: next });
  });

  /**
   * Folder browser — list immediate subdirectories at `path`. Used by
   * the workspace-linking UI to let the user drill into their disk
   * without typing absolute paths. Defaults to $HOME if no path is
   * passed. Bounded — never returns more than 200 entries.
   */
  app.get('/api/console/projects/browse', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const requested = typeof req.query.path === 'string' && req.query.path.trim()
      ? req.query.path
      : os.homedir();
    const expanded = requested.startsWith('~')
      ? path.join(os.homedir(), requested.slice(1))
      : requested;
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    if (!existsSync(absolute)) { res.status(404).json({ error: 'path not found' }); return; }
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isDirectory()) { res.status(400).json({ error: 'not a directory' }); return; }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    try {
      const entries = fs
        .readdirSync(absolute, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .slice(0, 200)
        .map((e) => ({ name: e.name, path: path.join(absolute, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({
        path: absolute,
        parent: path.dirname(absolute) === absolute ? null : path.dirname(absolute),
        home: os.homedir(),
        entries,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Fast search for directories matching a query across common spots.
   * Bounded depth + skip-list keeps it from scanning node_modules etc.
   * Used by the "find by name" tab of the workspace-linking UI.
   */
  app.get('/api/console/projects/search', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const query = typeof req.query.query === 'string' ? req.query.query.trim().toLowerCase() : '';
    if (!query) { res.status(400).json({ error: 'query required' }); return; }

    const SEARCH_ROOTS = [
      os.homedir(),
      path.join(os.homedir(), 'Desktop'),
      path.join(os.homedir(), 'Documents'),
      path.join(os.homedir(), 'Downloads'),
      path.join(os.homedir(), 'Developer'),
      path.join(os.homedir(), 'Projects'),
      path.join(os.homedir(), 'code'),
    ].filter((p) => existsSync(p));

    const SKIP = new Set([
      'node_modules', '.git', '.next', '.turbo', 'dist', 'build', '.venv', '.cache',
      '__pycache__', 'venv', 'env', '.DS_Store', 'Library', 'Pictures', 'Movies', 'Music',
    ]);
    const MAX_DEPTH = 4;
    const MAX_RESULTS = 80;
    const hits: { name: string; path: string }[] = [];

    function walk(dir: string, depth: number): void {
      if (hits.length >= MAX_RESULTS) return;
      if (depth > MAX_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= MAX_RESULTS) return;
        if (!e.isDirectory()) continue;
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        if (e.name.toLowerCase().includes(query)) {
          hits.push({ name: e.name, path: path.join(dir, e.name) });
        }
        walk(path.join(dir, e.name), depth + 1);
      }
    }

    for (const root of SEARCH_ROOTS) {
      walk(root, 0);
      if (hits.length >= MAX_RESULTS) break;
    }

    res.json({ query, results: hits });
  });

  // ─── In-project file explorer (read-only, scoped) ─────────────
  //
  // Lets the Projects panel browse a linked project's tree and preview
  // individual files without leaving the app. Read-only and strictly
  // contained: `root` must be a configured workspace dir (or under one),
  // and the resolved target can never escape that root via `../`. This
  // is the same surface the agent already reads — we just give the user
  // a window into it.

  function resolveWithinProject(rawRoot: string, rel: string): ProjectPathGuard {
    const guard = resolveProjectFilePath(getWorkspaceDirs(), os.homedir(), rawRoot, rel);
    if (!guard.ok) return guard;
    if (!existsSync(guard.root)) return { ok: false, status: 404, error: 'root not found' };
    if (!existsSync(guard.target)) return { ok: false, status: 404, error: 'path not found' };
    return guard;
  }

  /** List one directory level inside a project. Dirs first, then files. */
  app.get('/api/console/projects/files', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const guard = resolveWithinProject(
      typeof req.query.root === 'string' ? req.query.root : '',
      typeof req.query.path === 'string' ? req.query.path : '',
    );
    if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
    try {
      const stat = fs.statSync(guard.target);
      if (!stat.isDirectory()) { res.status(400).json({ error: 'not a directory' }); return; }
      const entries = fs
        .readdirSync(guard.target, { withFileTypes: true })
        .filter((e) => e.name !== '.DS_Store')
        .map((e) => {
          let size = 0;
          if (!e.isDirectory()) {
            try { size = fs.statSync(path.join(guard.target, e.name)).size; } catch { /* ignore */ }
          }
          return {
            name: e.name,
            isDir: e.isDirectory(),
            size,
            rel: path.relative(guard.root, path.join(guard.target, e.name)),
          };
        })
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
        .slice(0, 1000);
      res.json({ root: guard.root, path: path.relative(guard.root, guard.target), entries });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Read + preview a single file. Returns text, image data URL, or a
   *  binary/too-large marker — never streams an unbounded blob. */
  app.get('/api/console/projects/file', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const guard = resolveWithinProject(
      typeof req.query.root === 'string' ? req.query.root : '',
      typeof req.query.path === 'string' ? req.query.path : '',
    );
    if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
    try {
      const stat = fs.statSync(guard.target);
      if (stat.isDirectory()) { res.status(400).json({ error: 'is a directory' }); return; }
      const name = path.basename(guard.target);
      const ext = path.extname(guard.target).toLowerCase();
      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
      const MAX_TEXT = 512 * 1024;       // 512KB inline text cap
      const MAX_IMAGE = 4 * 1024 * 1024; // 4MB image cap

      if (IMAGE_EXTS.has(ext)) {
        if (stat.size > MAX_IMAGE) {
          res.json({ kind: 'too-large', name, size: stat.size, ext }); return;
        }
        const buf = fs.readFileSync(guard.target);
        const mime = ext === '.svg' ? 'image/svg+xml'
          : ext === '.ico' ? 'image/x-icon'
          : ext === '.jpg' ? 'image/jpeg'
          : 'image/' + ext.slice(1);
        res.json({ kind: 'image', name, size: stat.size, ext, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
        return;
      }

      if (stat.size > MAX_TEXT) {
        const fd = fs.openSync(guard.target, 'r');
        const buf = Buffer.alloc(MAX_TEXT);
        const read = fs.readSync(fd, buf, 0, MAX_TEXT, 0);
        fs.closeSync(fd);
        res.json({ kind: 'text', name, size: stat.size, ext, truncated: true, content: buf.subarray(0, read).toString('utf-8') });
        return;
      }

      const buf = fs.readFileSync(guard.target);
      if (buf.subarray(0, 8192).includes(0)) {
        res.json({ kind: 'binary', name, size: stat.size, ext });
        return;
      }
      res.json({ kind: 'text', name, size: stat.size, ext, content: buf.toString('utf-8') });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Content search within a project. Bounded walk (depth + skip-list +
   *  caps) so it never scans node_modules or hangs on a huge tree. Pure
   *  walker extracted to `grepProjectFiles` for unit testing. */
  app.get('/api/console/projects/grep', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const guard = resolveWithinProject(
      typeof req.query.root === 'string' ? req.query.root : '',
      '',
    );
    if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (query.trim().length < 2) { res.status(400).json({ error: 'q must be at least 2 characters' }); return; }
    try {
      const result = grepProjectFiles(guard.root, query);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Open a project file in the OS default app / editor (macOS `open`).
   *  Workspace-scoped via the same traversal-safe guard. */
  app.post('/api/console/projects/open', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const guard = resolveWithinProject(
      typeof body.root === 'string' ? body.root : '',
      typeof body.path === 'string' ? body.path : '',
    );
    if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
    if (process.platform !== 'darwin') {
      res.status(501).json({ error: 'open-in-editor is only supported on macOS' });
      return;
    }
    try {
      const child = childProcess.spawn('open', [guard.target], { detached: true, stdio: 'ignore' });
      child.unref();
      res.json({ ok: true, opened: guard.target });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Skills (SKILL.md format) ──────────────────────────────────
  //
  // Skills are reusable prompt modules in the Anthropic Skills format
  // (agentskills.io spec): a folder with SKILL.md (YAML frontmatter +
  // markdown body). They live in ~/.clementine-next/skills/<name>/ and
  // get pulled into the agent's context on demand via the skill_read
  // tool. Install from GitHub at /api/console/skills/install.

  app.get('/api/console/skills', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const skills = listSkills();
      res.json({
        skillsDir: SKILLS_DIR,
        count: skills.length,
        skills: skills.map((s) => ({
          name: s.name,
          description: s.frontmatter.description,
          displayName: s.frontmatter.name,
          bodyPreview: s.bodyPreview,
          hasScripts: s.hasScripts,
          hasReferences: s.hasReferences,
          hasSrc: s.hasSrc,
          source: s.source ?? null,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/skills/install', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const url = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!url) { res.status(400).json({ error: 'pass a GitHub repo URL in { url }' }); return; }
    try {
      const job = startSkillInstall(url);
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/skills/install/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const job = getSkillInstallJob(req.params.id);
    if (!job) { res.status(404).json({ error: 'install job not found' }); return; }
    res.json({ job });
  });

  // Full skill detail — the entire SKILL.md body, so the dashboard can
  // expand a card to read the whole skill (not just the preview).
  app.get('/api/console/skills/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const skill = loadSkill(req.params.name);
    if (!skill) { res.status(404).json({ error: 'skill not found' }); return; }
    res.json({
      name: skill.name,
      displayName: skill.frontmatter.name,
      description: skill.frontmatter.description,
      body: skill.body,
      source: skill.source ?? null,
      hasScripts: skill.hasScripts,
      hasReferences: skill.hasReferences,
      hasSrc: skill.hasSrc,
    });
  });

  app.delete('/api/console/skills/:name', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const name = req.params.name;
    try {
      const ok = uninstallSkill(name);
      if (!ok) { res.status(404).json({ error: 'skill not found' }); return; }
      res.json({ ok: true, name });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Check every installed skill against its source repo (cheap: one
  // `git ls-remote` per unique repo, no clone). Persists the result into
  // each skill's source metadata so GET /skills surfaces the badge.
  // Registered before the parameterized routes so the literal path wins.
  app.post('/api/console/skills/check-updates', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const summary = await checkAllSkillUpdates();
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Re-pull a single installed skill from its source repo. Returns an
  // install job; poll via GET /api/console/skills/install/:id (shared
  // job map). Applying an update is an explicit user action — the daily
  // poll only detects, it never mutates.
  app.post('/api/console/skills/:name/update', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const job = startSkillUpdate(req.params.name);
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Custom Tools (JS plugins) ─────────────────────────────────
  //
  // JS plugins register MCP tools (executable code). They show up here
  // and under the Tools panel — they are NOT skills. Skills are pure
  // prompt knowledge; plugins are tool code.

  app.get('/api/console/plugins', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const plugins = await loadPlugins();
      const items = plugins.map((p) => ({
        name: p.name,
        version: p.version ?? null,
        description: p.description ?? '',
        toolCount: Array.isArray(p.tools) ? p.tools.length : 0,
        tools: (p.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
      }));
      res.json({ plugins: items, pluginsDir: PLUGINS_DIR });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Native Browser Harness ───────────────────────────────────

  app.get('/api/console/browser-harness', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(await getBrowserHarnessStatus());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/browser-harness/install', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json({ job: startBrowserHarnessInstall() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/browser-harness/install/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const job = getInstallJob(req.params.id);
    if (!job) { res.status(404).json({ error: 'install job not found' }); return; }
    res.json({ job });
  });

  app.post('/api/console/install-command', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const command = typeof req.body?.command === 'string' ? req.body.command : '';
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'Install capability';
    try {
      res.json({ job: startApprovedInstallCommand(command, title) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Mobile Access (PWA companion + Cloudflare Tunnel) ───────────
  //
  // GETs are auth-checked but read-only and return JSON. Mutating POSTs
  // (install, login, configure, start/stop tunnel, rotate PIN) are
  // gated by isAuthorized — the Bearer/cookie that lets you reach the
  // console at all is sufficient to drive the wizard.

  app.get('/api/console/mobile-access/status', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(await getMobileAccessStatusPayload());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/mobile-access/install', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const job = await startMobileInstallJob();
      res.json({ job });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/mobile-access/install/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const job = getMobileInstallJob(req.params.id);
    if (!job) { res.status(404).json({ error: 'install job not found' }); return; }
    res.json({ job });
  });

  app.post('/api/console/mobile-access/login', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json({ login: await startMobileLogin() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/mobile-access/login/cancel', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    mobileCancelLogin();
    res.json({ ok: true });
  });

  app.get('/api/console/mobile-access/tunnels', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json({ tunnels: await mobileListTunnels() });
    } catch (err) {
      // Most common: not logged in. Return 200 + empty so the UI can
      // render a "log in first" hint instead of throwing.
      res.json({ tunnels: [], error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/mobile-access/configure', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const tunnelName = typeof req.body?.tunnelName === 'string' ? req.body.tunnelName.trim() : '';
    const hostname = typeof req.body?.hostname === 'string' ? req.body.hostname.trim() : '';
    if (!tunnelName || !hostname) {
      res.status(400).json({ error: 'tunnelName and hostname are required' });
      return;
    }
    try {
      const record = await mobileConfigureTunnel({ tunnelName, hostname });
      res.json({ ok: true, state: record });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/mobile-access/tunnel/start', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const result = await startMobileTunnel();
      if (!result.ok) { res.status(400).json(result); return; }
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/mobile-access/quick/start', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const result = await startMobileQuickTunnel();
      if (!result.ok) { res.status(400).json(result); return; }
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/mobile-access/tunnel/stop', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(await stopMobileTunnel());
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/mobile-access/pin', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
    const { validatePinForSet: validatePin } = await import('../runtime/mobile-pin.js');
    const pinError = validatePin(pin);
    if (pinError) {
      res.status(400).json({ error: pinError.message, code: pinError.code });
      return;
    }
    try {
      const result = await mobileRotatePin(pin);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/console/mobile-access/sessions/:deviceId', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = req.params.deviceId;
    const removed = id.startsWith('dev-')
      ? await revokeMobileSessionByDeviceId(id)
      : await revokeMobileSession(id);
    res.json({ ok: true, removed });
  });

  app.delete('/api/console/mobile-access/sessions', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const removed = await revokeAllMobileSessions();
    res.json({ ok: true, removed });
  });

  app.post('/api/console/mobile-access/access-ack', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const enabled = req.body?.enabled === true;
    try {
      const { setMobileAccessAccessAck } = await import('../runtime/mobile-access-state.js');
      const record = await setMobileAccessAccessAck({ enabled });
      res.json({ ok: true, cloudflareAccess: record.cloudflareAccess ?? null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/mobile-access/qr', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const hostname = typeof req.query.hostname === 'string' ? req.query.hostname : undefined;
    try {
      const result = await mobileGenerateQrSvg(hostname);
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Target-Url', result.targetUrl);
      res.setHeader('X-Target-Mode', result.targetMode);
      res.setHeader('X-Pairing-Expires-At', result.expiresAt);
      res.send(result.svg);
    } catch (err) {
      if (err instanceof MobileQrNotReadyError) {
        res.status(409).json({
          error: err.message,
          code: err.code,
          target: err.target,
        });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── CLI catalog (search-driven curated installs) ─────────────────
  //
  // The dashboard's CLI section is a search box, not a grid. The user
  // types a name (e.g. "salesforce", "railway"), this returns matching
  // entries with their current install status, and the install route
  // wraps startApprovedInstallCommand so the existing job machinery
  // streams output back.

  app.get('/api/console/cli-catalog', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    try {
      // Auto-promote: any catalog CLI installed on PATH but not yet
      // connected (and not explicitly forgotten) gets connected here.
      // This closes the "I had sf already from before Clementine" gap
      // so the friend's install just works — agent sees the auth
      // metadata + dashboard surfaces it as a connected integration.
      const { autoPromoteInstalledClis } = await import('../integrations/cli-catalog/catalog.js');
      const promotion = autoPromoteInstalledClis();
      res.json({
        query: q,
        results: q ? statusForSearchResults(q) : [],
        connected: readConnectedClis(),
        autoPromoted: promotion.promoted,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Reconnect a previously-forgotten catalog CLI. Drops the id from
   * forgotten[] + writes a fresh connected record. Used by the
   * dashboard's "Reconnect" button when the user wants a CLI back
   * after explicitly disconnecting it.
   */
  app.post('/api/console/cli-catalog/reconnect', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    if (!id) { res.status(400).json({ error: 'id required' }); return; }
    try {
      const { reconnectCli } = await import('../integrations/cli-catalog/catalog.js');
      const record = reconnectCli(id);
      if (!record) { res.status(404).json({ error: 'unknown catalog id: ' + id }); return; }
      res.json({ record });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/cli-catalog/install', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    const entry = findCatalogEntry(id);
    if (!entry) { res.status(404).json({ error: 'unknown catalog id: ' + id }); return; }
    try {
      const job = startApprovedInstallCommand(entry.installCommand, `Install ${entry.name}`, { cliCatalogId: entry.id });
      res.json({ job, entry });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/cli-catalog/forget', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    if (!id) { res.status(400).json({ error: 'id required' }); return; }
    try {
      forgetConnectedCli(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/install-jobs/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const job = getInstallJob(req.params.id);
    if (!job) { res.status(404).json({ error: 'install job not found' }); return; }
    if (job.status === 'succeeded' && job.metadata?.cliCatalogId && !job.connectedRecorded) {
      const entry = findCatalogEntry(job.metadata.cliCatalogId);
      if (entry) {
        recordConnectedCli(entry);
        job.connectedRecorded = true;
      }
    }
    res.json({ job });
  });

  app.post('/api/console/browser-harness/doctor', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(await runBrowserHarnessDoctor());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/browser-harness/test', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(await runBrowserHarnessSmokeTest());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/browser-harness/open-chrome-setup', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(await openChromeRemoteDebuggingSetup());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Context / Identity ──────────────────────────────────────────

  app.get('/api/console/context', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const profile = loadUserProfile();
      const files = CONTEXT_FILES.map(readContextFile);
      const facts = listActiveFacts({ limit: 18 });
      const goals = readContextGoals().slice(0, 12);
      const voiceInstructions = buildRealtimeVoiceInstructions('console:home');
      res.json({
        profile,
        files,
        facts,
        goals,
        memory: readMemoryIndexStatus(),
        voiceContext: {
          chars: voiceInstructions.length,
          sections: Array.from(voiceInstructions.matchAll(/^## (.+)$/gm)).map((match) => match[1]),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/context/files/:key', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const def = contextFileForKey(req.params.key);
    if (!def) { res.status(404).json({ error: 'unknown context file' }); return; }
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (content.length > 60000) {
      res.status(400).json({ error: 'context file content is too large' });
      return;
    }
    try {
      ensureDir(path.dirname(def.filePath));
      fs.writeFileSync(def.filePath, content.trimEnd() + (content.trim() ? '\n' : ''), 'utf-8');
      res.json({ file: readContextFile(def) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/context/facts', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const kind = typeof req.body?.kind === 'string' ? req.body.kind : 'user';
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!FACT_KINDS.includes(kind as (typeof FACT_KINDS)[number])) {
      res.status(400).json({ error: 'invalid fact kind' });
      return;
    }
    if (!content) {
      res.status(400).json({ error: 'fact content required' });
      return;
    }
    try {
      const fact = rememberFact({ kind: kind as (typeof FACT_KINDS)[number], content, sessionId: 'console:context' });
      res.json({ fact, facts: listActiveFacts({ limit: 18 }) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/context/goals', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const priority = ['high', 'medium', 'low'].includes(req.body?.priority) ? req.body.priority : 'medium';
    const nextActions = Array.isArray(req.body?.nextActions)
      ? req.body.nextActions.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0).map((item: string) => item.trim()).slice(0, 8)
      : typeof req.body?.nextActions === 'string'
        ? req.body.nextActions.split('\n').map((item: string) => item.trim()).filter(Boolean).slice(0, 8)
        : [];
    if (!title || !description) {
      res.status(400).json({ error: 'title and description required' });
      return;
    }
    try {
      ensureDir(GOALS_DIR);
      const now = new Date().toISOString();
      const goal = {
        id: randomBytes(4).toString('hex'),
        title,
        description,
        owner: 'clementine',
        priority,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        reviewFrequency: 'weekly',
        progressNotes: [],
        nextActions,
        blockers: [],
        linkedCronJobs: [],
      };
      fs.writeFileSync(path.join(GOALS_DIR, `${goal.id}.json`), JSON.stringify(goal, null, 2), 'utf-8');
      res.json({ goal, goals: readContextGoals().slice(0, 12) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Settings ──────────────────────────────────────────────────

  // Role→model registry snapshot for the Models panel: the resolved model +
  // source for each role, the durable bindings, and the available models grouped
  // by CONNECTED provider (so the pickers only offer what you're logged into).
  const buildModelRolesSnapshot = () => {
    return {
      roles: {
        brain: resolveRoleModel('brain'),
        worker: resolveRoleModel('worker'),
        judge: resolveRoleModel('judge'),
      },
      bindings: readDurableBindings(),
      available: connectedModelGroups(),
      roleOptions: {
        worker: connectedModelGroupsForRole('worker'),
        judge: connectedModelGroupsForRole('judge'),
      },
      brainOptions: brainOptions(),
      effectiveBrain: effectiveBrain(),
      effectiveBrainValue: effectiveBrainValue(),
      activeBrain: getActiveAuthMode(),
    };
  };

  app.get('/api/console/settings', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const profile = loadUserProfile();
      const proactivity = getProactivityPolicySnapshot();
      const auth = getAuthStatus();
      const memory = readMemoryIndexStatus();
      const models = getModelSettingsSnapshot();
      const runtimeBudget = getHarnessBudgetSnapshot();
      const byo = getByoBackendConfig();
      const modelBackend = {
        mode: getModelRoutingMode(),
        baseURL: byo.baseURL,
        modelId: byo.primaryId,
        judgeId: byo.judgeId,
        workerModel: getRuntimeEnv('OPENAI_MODEL_WORKER', '') || '',
        providerLabel: byo.providerLabel,
        hasKey: Boolean(byo.apiKey),
        configured: byo.configured,
      };
      const fusionBrains = debateBrainsAvailable();
      const fusion = {
        mode: debateMode(),
        judge: judgeChoice(),
        judgeRole: resolveRoleModel('judge'),
        strategy: fusionStrategy(),
        brainsAvailable: fusionBrains,
        active: debateMode() !== 'off' && ((fusionBrains.claude && fusionBrains.codex) || verifyJudgeAvailable()),
      };
      res.json({ profile, proactivity, auth, memory, models, runtimeBudget, modelBackend, modelProviders: getByoProviderSnapshots(), claudeAuth: getClaudeAuthSnapshot(), activeBrain: getActiveAuthMode(), fusion, modelRoles: buildModelRolesSnapshot(), judgeMetrics: getJudgeMetricsSnapshot(), developerMode: isDevModeEnabled() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Tiny endpoint the dashboard hits on first load to populate the
   * version chip in the header + foot bar. Reads from package.json.
   */
  app.get('/api/console/build-info', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      // Find the daemon's own package.json. The dev tree path
      // (`process.cwd()/package.json`) only works when launched via
      // `npm run dev`. The installed app spawns the daemon as a Node
      // child whose cwd is set by Electron and whose process.resourcesPath
      // is undefined — so we walk UP from this module's own __dirname
      // looking for the first package.json with name === 'clemmy'. This
      // is the same primitive Node uses for require.resolve and survives
      // any spawn cwd / packaging layout.
      const moduleDir = path.dirname(fileURLToPath(import.meta.url));
      const candidates: string[] = [];
      let walk = moduleDir;
      for (let i = 0; i < 8; i += 1) {
        candidates.push(path.join(walk, 'package.json'));
        const parent = path.dirname(walk);
        if (parent === walk) break;
        walk = parent;
      }
      // Keep the legacy candidates as a fallback for dev / odd layouts.
      candidates.push(path.resolve(process.cwd(), 'package.json'));
      candidates.push(path.resolve(process.cwd(), '..', '..', 'package.json'));
      const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      if (resourcesPath) candidates.push(path.resolve(resourcesPath, 'daemon', 'package.json'));

      let version: string | undefined;
      for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        try {
          const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version?: string; name?: string };
          if (pkg.name === 'clemmy' && pkg.version) { version = pkg.version; break; }
        } catch { /* try next */ }
      }
      res.json({ version: version ?? 'unknown', startedAt: new Date(process.uptime() * 1000 * -1 + Date.now()).toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/startup-doctor', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(buildStartupDoctor());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Returns a snapshot of "is Clementine actively working right now?"
   * Used by the desktop auto-updater to decide whether `quitAndInstall`
   * would interrupt user work. Counts:
   *   - Non-chat sessions with status active/paused (workflow + execution + agent)
   *   - Pending harness approvals
   *   - Background tasks in flight (running / pending / awaiting_approval)
   *
   * Chat sessions are excluded — they stay `active` between turns by
   * design (see project_session_status_semantics) and would otherwise
   * always block the update. A multi-hour workflow IS something we
   * want to preserve; a quiet chat dock isn't.
   */
  app.get('/api/console/active-work', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const pendingApprovals = approvalRegistry.listPending({ status: 'pending' });
      const sessionsWithPendingApprovals = new Set(pendingApprovals.map((approval) => approval.sessionId));
      const activeNonChatSessions = listVisibleActiveWorkHarnessSessions(sessionsWithPendingApprovals);
      const activeBackgroundTasks = listBackgroundTasks().filter(
        (task) => task.status === 'running' || task.status === 'pending' || task.status === 'awaiting_approval',
      );
      const total = activeNonChatSessions.length + pendingApprovals.length + activeBackgroundTasks.length;
      const activeWorkItems = [
        ...activeNonChatSessions.map((session) => ({
          type: 'session',
          id: session.id,
          kind: session.kind,
          status: session.status,
          title: session.title || session.objective || session.id,
          updatedAt: session.updatedAt,
        })),
        ...pendingApprovals.map((approval) => ({
          type: 'approval',
          id: approval.approvalId,
          kind: 'harness-approval',
          status: approval.status,
          title: approval.subject || approval.tool || approval.approvalId,
          sessionId: approval.sessionId,
          tool: approval.tool,
          updatedAt: approval.requestedAt,
        })),
        ...activeBackgroundTasks.map((task) => ({
          type: 'background-task',
          id: task.id,
          kind: task.source,
          status: task.status,
          title: task.title,
          updatedAt: task.updatedAt,
          pendingApprovalId: task.pendingApprovalId,
        })),
      ];
      // Build a human-readable summary for the auto-updater dialog so
      // the user sees what's at stake before choosing "Install anyway."
      const summaryParts: string[] = [];
      if (activeNonChatSessions.length > 0) {
        summaryParts.push(`${activeNonChatSessions.length} tracked run${activeNonChatSessions.length === 1 ? '' : 's'} active or paused`);
      }
      if (pendingApprovals.length > 0) {
        summaryParts.push(`${pendingApprovals.length} pending approval${pendingApprovals.length === 1 ? '' : 's'}`);
      }
      if (activeBackgroundTasks.length > 0) {
        summaryParts.push(`${activeBackgroundTasks.length} background task${activeBackgroundTasks.length === 1 ? '' : 's'}`);
      }
      res.json({
        total,
        activeSessions: activeNonChatSessions.length,
        pendingApprovals: pendingApprovals.length,
        activeBackgroundTasks: activeBackgroundTasks.length,
        items: activeWorkItems,
        summary: summaryParts.join(', ') || 'no active work',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Recent tool events for the nav-dock RECENT card. Reads today's
   * NDJSON file (from src/agents/tool-observability.ts) and returns
   * the last N events newest-first.
   */
  app.get('/api/console/tool-events/recent', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const limit = Math.max(1, Math.min(50, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '6', 10) || 6));
    const eventsDir = toolEventsDir();
    try {
      if (!fs.existsSync(eventsDir)) {
        res.json({ events: [] });
        return;
      }
      const files = fs.readdirSync(eventsDir).filter((n) => n.endsWith('.ndjson')).sort();
      if (files.length === 0) { res.json({ events: [] }); return; }
      const events: Record<string, unknown>[] = [];
      for (let i = files.length - 1; i >= 0 && events.length < limit; i--) {
        const lines = fs.readFileSync(path.join(eventsDir, files[i]), 'utf-8').split('\n').filter(Boolean);
        for (let j = lines.length - 1; j >= 0 && events.length < limit; j--) {
          try {
            const obj = JSON.parse(lines[j]) as Record<string, unknown>;
            const phase = obj.phase;
            // Only surface terminal events — start events double the
            // noise without adding signal.
            if (phase === 'end' || phase === 'error' || phase === 'pending-approval') {
              events.push(obj);
            }
          } catch { /* skip malformed lines */ }
        }
      }
      res.json({ events });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Aggregated health snapshot for the nav-dock HEALTH card. Each
   * subsystem is one of 'ok' | 'warn' | 'err' | 'unknown'.
   */
  app.get('/api/console/health', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const snapshot: Record<string, 'ok' | 'warn' | 'err' | 'unknown'> = {
      daemon: 'ok', // if this endpoint is responding, the daemon is up
      memoryDb: 'unknown',
      mcp: 'unknown',
      composio: 'unknown',
    };

    // Build/version self-report — so the dashboard can show (and warn)
    // exactly which build is serving this, packaged vs dev.
    let build: import('../runtime/build-info.js').BuildInfo | undefined;
    try {
      const { getBuildInfo } = await import('../runtime/build-info.js');
      build = getBuildInfo();
    } catch {
      build = undefined;
    }

    try {
      const { openMemoryDb } = await import('../memory/db.js');
      const db = openMemoryDb();
      db.prepare('SELECT 1').get();
      snapshot.memoryDb = 'ok';
    } catch {
      snapshot.memoryDb = 'err';
    }

    try {
      const { discoverMcpServers } = await import('../runtime/mcp-config.js');
      const servers = discoverMcpServers();
      const enabled = servers.filter((s) => s.enabled).length;
      snapshot.mcp = LOCAL_MCP_ENABLED || enabled > 0 ? 'ok' : 'warn';
    } catch {
      snapshot.mcp = 'err';
    }

    try {
      const { getComposioCredentialStatus, listConnectedToolkits } = await import('../integrations/composio/client.js');
      const cred = getComposioCredentialStatus();
      if (!cred.enabled) {
        snapshot.composio = 'warn';
      } else {
        const connections = await listConnectedToolkits();
        const active = connections.filter((c) => c.status === 'ACTIVE').length;
        snapshot.composio = active > 0 ? 'ok' : 'warn';
      }
    } catch {
      snapshot.composio = 'err';
    }

    res.json({ ...snapshot, build });
  });

  app.patch('/api/console/settings/profile', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const updated = saveUserProfile(req.body ?? {});
      res.json({ profile: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/settings/policy', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const updated = saveProactivityPolicy(req.body ?? {});
      res.json({ policy: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Developer feature-flags panel: read the curated CLEMMY_* kill-switch snapshot.
  app.get('/api/console/settings/developer-flags', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json({ developerFlags: buildDevFlagsSnapshot() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Toggle dev mode, or set/clear a single CLEMMY_* flag. Body is one of:
  //   { devMode: boolean }            — reveal/hide the panel
  //   { key: 'CLEMMY_X', value: '…' } — set an override (live + persisted)
  //   { key: 'CLEMMY_X', clear: true }— reset to the code default
  app.patch('/api/console/settings/developer-flags', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const body = (req.body ?? {}) as { devMode?: unknown; key?: unknown; value?: unknown; clear?: unknown };
      if (typeof body.devMode === 'boolean') {
        setDevMode(body.devMode);
      } else if (typeof body.key === 'string') {
        const key = body.key.trim().toUpperCase();
        if (body.clear === true) {
          clearDevFlag(key);
        } else {
          const value = typeof body.value === 'string' ? body.value.trim() : '';
          if (!value) { res.status(400).json({ error: 'value is required (or pass clear:true)' }); return; }
          setDevFlag(key, value);
        }
      } else {
        res.status(400).json({ error: 'pass { devMode } or { key, value } or { key, clear:true }' });
        return;
      }
      res.json({ developerFlags: buildDevFlagsSnapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/settings/models', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const body = (req.body ?? {}) as Partial<Record<ModelTier, unknown>>;
      const tiers: ModelTier[] = ['fast', 'primary', 'deep'];
      for (const tier of tiers) {
        const next = normalizeModelId(body[tier], DEFAULT_MODELS[tier]);
        updateEnvKey(MODEL_ENV_KEYS[tier], next);
      }
      clearAutonomyAgentCache();
      res.json({ models: getModelSettingsSnapshot() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/settings/model-backend', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const body = (req.body ?? {}) as {
        mode?: string; baseURL?: string; apiKey?: string; modelId?: string;
        judgeId?: string; workerModel?: string; providerLabel?: string;
      };
      const mode: ModelRoutingMode = body.mode === 'worker' || body.mode === 'all_in' ? body.mode : 'off';
      const cleanId = (v: unknown): string => {
        const s = typeof v === 'string' ? v.trim() : '';
        return /^[A-Za-z0-9._:/-]*$/.test(s) ? s : '';
      };
      const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
      const modelId = cleanId(body.modelId);
      const judgeId = cleanId(body.judgeId);
      const explicitWorker = cleanId(body.workerModel);
      const providerLabel = typeof body.providerLabel === 'string' ? body.providerLabel.trim().slice(0, 40) : '';

      const prevMode = getModelRoutingMode(); // capture BEFORE the overwrite below
      updateEnvKey('MODEL_ROUTING_MODE', mode);
      process.env.MODEL_ROUTING_MODE = mode; // getRuntimeEnv reads process.env first
      // Keep AUTH_MODE and MODEL_ROUTING_MODE from drifting — the root cause of
      // the "settings says GLM but the brain is actually Claude (token expired)"
      // trap. all_in means the BYO model IS the brain, so the auth mode must be
      // api_key. Conversely, LEAVING all_in (prevMode was all_in) hands the brain
      // back to Codex — but ONLY then: we must not flip a user who was already on
      // api_key for some other reason (e.g. a legacy OpenAI-key install) just
      // because they saved the form in off/worker. (The active-brain picker keeps
      // these consistent too; this closes the legacy form's leak without overreach.)
      if (mode === 'all_in') {
        updateEnvKey('AUTH_MODE', 'api_key'); process.env.AUTH_MODE = 'api_key';
      } else if (prevMode === 'all_in' && getActiveAuthMode() === 'api_key') {
        updateEnvKey('AUTH_MODE', 'codex_oauth'); process.env.AUTH_MODE = 'codex_oauth';
      }
      updateEnvKey('BYO_MODEL_BASE_URL', baseURL);
      updateEnvKey('BYO_MODEL_ID', modelId);
      updateEnvKey('BYO_MODEL_JUDGE_ID', judgeId);
      updateEnvKey('BYO_MODEL_PROVIDER', providerLabel);
      // Only overwrite the key when a non-empty value is supplied — the UI
      // sends blank to keep the existing key untouched.
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        updateEnvKey('BYO_MODEL_API_KEY', body.apiKey.trim());
      }

      // Wire role → tier env vars so the router routes the right roles to
      // the BYO backend. Codex (gpt-5*) tier customizations are preserved
      // on worker/off; all_in points every tier at the BYO ids (fast tier
      // = the cross-model judge).
      const keepCodexOrDefault = (tier: ModelTier): string => {
        const cur = getRuntimeEnv(MODEL_ENV_KEYS[tier], DEFAULT_MODELS[tier]) || DEFAULT_MODELS[tier];
        return cur.startsWith('gpt-5') ? cur : DEFAULT_MODELS[tier];
      };
      if (mode === 'all_in') {
        updateEnvKey(MODEL_ENV_KEYS.primary, modelId || DEFAULT_MODELS.primary);
        updateEnvKey(MODEL_ENV_KEYS.deep, modelId || DEFAULT_MODELS.deep);
        updateEnvKey(MODEL_ENV_KEYS.fast, judgeId || modelId || DEFAULT_MODELS.fast);
        updateEnvKey('OPENAI_MODEL_WORKER', modelId);
      } else if (mode === 'worker') {
        updateEnvKey(MODEL_ENV_KEYS.primary, keepCodexOrDefault('primary'));
        updateEnvKey(MODEL_ENV_KEYS.deep, keepCodexOrDefault('deep'));
        updateEnvKey(MODEL_ENV_KEYS.fast, keepCodexOrDefault('fast'));
        updateEnvKey('OPENAI_MODEL_WORKER', explicitWorker || modelId);
      } else {
        updateEnvKey(MODEL_ENV_KEYS.primary, keepCodexOrDefault('primary'));
        updateEnvKey(MODEL_ENV_KEYS.deep, keepCodexOrDefault('deep'));
        updateEnvKey(MODEL_ENV_KEYS.fast, keepCodexOrDefault('fast'));
        updateEnvKey('OPENAI_MODEL_WORKER', '');
      }

      // Force the harness to re-register its model provider on the next
      // run so the mode switch takes effect without a full daemon restart.
      // Also clear the BYO model client cache if the key changed.
      resetHarnessRuntimeConfig();
      resetByoModelCache();
      clearAutonomyAgentCache();

      const byo = getByoBackendConfig();
      res.json({
        modelBackend: {
          mode: getModelRoutingMode(),
          baseURL: byo.baseURL,
          modelId: byo.primaryId,
          judgeId: byo.judgeId,
          workerModel: getRuntimeEnv('OPENAI_MODEL_WORKER', '') || '',
          providerLabel: byo.providerLabel,
          hasKey: Boolean(byo.apiKey),
          configured: byo.configured,
        },
        models: getModelSettingsSnapshot(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Multi-provider BYO registry ────────────────────────────────────────
  // 'default' IS the legacy BYO_MODEL_* slot; extras live in BYO_PROVIDERS.
  // Adding the FIRST provider (no default yet) writes the legacy slot so
  // getByoBackendConfig stays valid for the all_in check. Each provider's key
  // lives in its own env/vault slot. Every mutation runs the cache-reset trio.
  const normalizeProviderModelIds = (raw: unknown): string[] => {
    const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
    const out: string[] = [];
    for (const item of items) {
      const s = typeof item === 'string' ? item.trim() : '';
      if (s && /^[A-Za-z0-9._:/-]+$/.test(s) && !out.includes(s)) out.push(s);
    }
    return out;
  };

  app.get('/api/console/settings/model-providers', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json({ providers: getByoProviderSnapshots(), mode: getModelRoutingMode() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Live model status for the top-bar chips: Codex/Claude 5h+weekly quota windows
  // (captured from provider rate-limit headers) + connection status for OpenAI and
  // every connected BYO provider (GLM/Z.ai, DeepSeek, MiniMax, Together, ...).
  // Returns only booleans + percentages + reset times + non-secret provider ids.
  app.get('/api/console/model-status', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const rl = getRateLimitSnapshot();
      const claudeConnected = claudeModelsAvailable();
      // Claude windows come from the dedicated oauth/usage endpoint (cached,
      // lazily refreshed) — only poke it when Claude is actually connected.
      const claudeUsage = claudeConnected ? getClaudeUsageSnapshot() : null;
      const byoProviders = getByoProviderSnapshots()
        .filter((p) => p.configured)
        .map((p) => ({
          id: p.id,
          label: p.label || p.id,
          modelIds: p.modelIds,
          connected: true,
        }));
      const togetherConnected = byoProviders.some(
        (p) => p.id === 'together' || p.id === 'together-ai' || /together/i.test(p.label),
      );
      res.json({
        codex: { connected: codexModelsAvailable(), ...(rl.codex ?? {}) },
        claude: { connected: claudeConnected, ...(claudeUsage ?? {}) },
        openai: { connected: Boolean(getOpenAiApiKey()) },
        byoProviders,
        together: { connected: togetherConnected },
        updatedAt: Date.now(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/settings/model-providers', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const body = (req.body ?? {}) as { id?: string; label?: string; baseURL?: string; apiKey?: string; modelIds?: unknown; mode?: string };
      const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 40) : '';
      const modelIds = normalizeProviderModelIds(body.modelIds);
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!baseURL) { res.status(400).json({ error: 'baseURL is required.' }); return; }
      if (modelIds.length === 0) { res.status(400).json({ error: 'At least one model id is required.' }); return; }

      // First provider (no legacy default) or an explicit 'default' → legacy slot.
      const legacy = getByoBackendConfig();
      const wantsDefault = body.id === 'default' || !(legacy.configured || Boolean(legacy.baseURL));
      if (wantsDefault) {
        updateEnvKey('BYO_MODEL_BASE_URL', baseURL);
        updateEnvKey('BYO_MODEL_ID', modelIds[0]);
        updateEnvKey('BYO_MODEL_PROVIDER', label);
        if (modelIds.length > 1) updateEnvKey('BYO_MODEL_JUDGE_ID', modelIds[1]);
        if (apiKey) updateEnvKey('BYO_MODEL_API_KEY', apiKey);
      } else {
        const id = body.id && body.id.trim() ? slugifyProviderId(body.id) : slugifyProviderId(label || baseURL);
        const extras = getByoProviders().filter((p) => p.id !== 'default');
        const next: ByoProvider = { id, label, baseURL, modelIds };
        const merged = extras.some((p) => p.id === id) ? extras.map((p) => (p.id === id ? next : p)) : [...extras, next];
        updateEnvKey('BYO_PROVIDERS', serializeExtraProviders(merged));
        if (apiKey) updateEnvKey(byoProviderKeyEnvKey(id), apiKey);
      }

      // A freshly-connected provider must be routable: bump 'off' → 'worker'.
      // Write BOTH .env and process.env (getRuntimeEnv reads process.env first,
      // so a stale process value from the active-brain route would mask .env).
      const mode = body.mode === 'worker' || body.mode === 'all_in' ? body.mode : undefined;
      const nextMode = mode ?? (getModelRoutingMode() === 'off' ? 'worker' : undefined);
      if (nextMode) { updateEnvKey('MODEL_ROUTING_MODE', nextMode); process.env.MODEL_ROUTING_MODE = nextMode; }

      resetHarnessRuntimeConfig();
      resetByoModelCache();
      clearAutonomyAgentCache();
      res.json({ providers: getByoProviderSnapshots(), mode: getModelRoutingMode() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/console/settings/model-providers/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const id = (req.params.id || '').trim();
      if (!id) { res.status(400).json({ error: 'provider id is required.' }); return; }
      if (id === 'default') {
        for (const k of ['BYO_MODEL_BASE_URL', 'BYO_MODEL_ID', 'BYO_MODEL_JUDGE_ID', 'BYO_MODEL_PROVIDER', 'BYO_MODEL_API_KEY']) updateEnvKey(k, '');
      } else {
        const extras = getByoProviders().filter((p) => p.id !== 'default' && p.id !== id);
        updateEnvKey('BYO_PROVIDERS', serializeExtraProviders(extras));
        updateEnvKey(byoProviderKeyEnvKey(id), '');
      }
      // Never strand the user on an unusable brain: if removing this provider
      // leaves all_in (BYO-brain) mode with no configured backend, step the brain
      // down to 'off' and revert an api_key auth to Codex — mirrors the
      // active-brain route's all_in→off guard (which the DELETE path must match).
      if (getModelRoutingMode() === 'all_in' && !getByoBackendConfig().configured) {
        updateEnvKey('MODEL_ROUTING_MODE', 'off'); process.env.MODEL_ROUTING_MODE = 'off';
        if (getActiveAuthMode() === 'api_key') { updateEnvKey('AUTH_MODE', 'codex_oauth'); process.env.AUTH_MODE = 'codex_oauth'; }
      }
      resetHarnessRuntimeConfig();
      resetByoModelCache();
      clearAutonomyAgentCache();
      res.json({ providers: getByoProviderSnapshots(), mode: getModelRoutingMode() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // List a provider's model catalog (generic — any OpenAI-compatible endpoint).
  // Lets the settings UI offer a PICKER instead of hand-typed ids. For a SAVED
  // provider, pass `providerId` and the key is read from the vault (browser never
  // resends it); for a not-yet-saved one (the add form), pass baseURL + apiKey in
  // the body. The key is never echoed back — only `{ models }` or `{ error }`.
  app.post('/api/console/settings/model-providers/models', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const body = (req.body ?? {}) as { baseURL?: string; apiKey?: string; providerId?: string };
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
      let baseURL = '';
      let apiKey = '';
      if (providerId) {
        const provider = getByoProviders().find((p) => p.id === providerId);
        if (!provider) { res.status(404).json({ error: 'Unknown provider.' }); return; }
        baseURL = provider.baseURL;
        apiKey = getByoProviderApiKey(providerId);
      } else {
        baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
        apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      }
      const result = await discoverProviderModels({ baseURL, apiKey });
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/settings/runtime-budget', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const settings = saveHarnessBudgetSettings(req.body ?? {});
      clearAutonomyAgentCache();
      res.json({ runtimeBudget: { ...getHarnessBudgetSnapshot(), settings } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/managed-clis', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const [composio, github] = await Promise.all([
        getComposioRuntimeStatus(),
        getGitHubCliStatus(),
      ]);
      res.json({ composio, github });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/managed-clis/:kind/:action', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const kind = req.params.kind as ManagedCliKind;
    const action = req.params.action as ManagedCliAction;
    if (kind !== 'composio' && kind !== 'github') {
      res.status(400).json({ error: 'kind must be composio or github' });
      return;
    }
    if (action !== 'install' && action !== 'auth' && action !== 'repair') {
      res.status(400).json({ error: 'action must be install, auth, or repair' });
      return;
    }
    try {
      res.json({ job: startManagedCliJob(kind, action) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/managed-cli-jobs/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const job = getManagedCliJob(req.params.id);
    if (!job) { res.status(404).json({ error: 'job not found' }); return; }
    res.json({ job });
  });

  // ─── Optional Recall.ai desktop meeting capture ───────────────────

  app.get('/api/console/meetings/recall', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const store = await getSecretStore();
      const secret = await store.get('recall_api_key');
      res.json({
        settings: loadRecallMeetingSettings(),
        credential: {
          status: secret.status,
          source: secret.source,
          hasValue: Boolean(secret.value),
        },
        regions: RECALL_REGIONS,
        docsUrl: 'https://docs.recall.ai/docs/desktop-sdk',
        signupUrl: 'https://www.recall.ai/signup',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/meetings/recall/settings', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = (req.body ?? {}) as Partial<RecallMeetingSettings>;
    const region = typeof body.region === 'string' && body.region in RECALL_REGIONS
      ? body.region as RecallRegion
      : undefined;
    try {
      const settings = saveRecallMeetingSettings({
        enabled: body.enabled === true,
        region,
        autoRecord: body.autoRecord === true,
        liveTranscript: body.liveTranscript === true,
        analyzeOnComplete: body.analyzeOnComplete !== false,
      });
      res.json({ settings });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/meetings/recall/upload-token', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const settings = loadRecallMeetingSettings();
      if (!settings.enabled) {
        res.status(409).json({ error: 'Recall meeting capture is disabled.' });
        return;
      }
      const upload = await createRecallSdkUpload({
        liveTranscript: req.body?.liveTranscript === true || settings.liveTranscript || settings.analyzeOnComplete,
      });
      res.json(upload);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/meetings/recall/detected', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const windowId = typeof req.body?.windowId === 'string' ? req.body.windowId : '';
    if (!windowId) { res.status(400).json({ error: 'windowId required' }); return; }
    try {
      const record = noteRecallMeetingDetected({
        windowId,
        recordingId: typeof req.body?.recordingId === 'string' ? req.body.recordingId : undefined,
        platform: typeof req.body?.platform === 'string' ? req.body.platform : undefined,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        status: req.body?.status === 'recording' ? 'recording' : 'detected',
      });
      res.json({ record });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/meetings/recall/transcript-event', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const windowId = typeof req.body?.windowId === 'string' ? req.body.windowId : '';
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!windowId) { res.status(400).json({ error: 'windowId required' }); return; }
    if (!text.trim()) { res.json({ skipped: true }); return; }
    try {
      const record = appendRecallTranscriptSegment({
        windowId,
        recordingId: typeof req.body?.recordingId === 'string' ? req.body.recordingId : undefined,
        event: typeof req.body?.event === 'string' ? req.body.event : 'transcript.data',
        speaker: typeof req.body?.speaker === 'string' ? req.body.speaker : undefined,
        text,
        timestamp: typeof req.body?.timestamp === 'string' ? req.body.timestamp : undefined,
        isFinal: typeof req.body?.isFinal === 'boolean' ? req.body.isFinal : undefined,
      });
      res.json({ record, segmentCount: record.segments.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/meetings/recall/complete', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const windowId = typeof req.body?.windowId === 'string' ? req.body.windowId : '';
    if (!windowId) { res.status(400).json({ error: 'windowId required' }); return; }
    try {
      const result = finalizeRecallMeeting({
        windowId,
        recordingId: typeof req.body?.recordingId === 'string' ? req.body.recordingId : undefined,
        platform: typeof req.body?.platform === 'string' ? req.body.platform : undefined,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      });
      if (result.artifactPath) {
        try { reindexVault(); } catch { /* maintenance will retry */ }
      }
      // Fire-and-forget canonical-transcript backfill. Only fires when
      // we have a recordingId — streaming-only meetings (no SDK upload)
      // can't be backfilled. The function catches all errors and
      // reflects them in the meeting record's canonicalStatus, so a
      // failed backfill never breaks this HTTP response.
      if (result.record.recordingId) {
        startCanonicalTranscriptBackfill({
          windowId: result.record.windowId,
          recordingId: result.record.recordingId,
        });
      }
      const settings = loadRecallMeetingSettings();
      const task = result.artifactPath && settings.analyzeOnComplete
        ? createBackgroundTask({
          title: `Analyze meeting transcript: ${result.record.title || result.record.platform || result.record.id}`,
          prompt: buildAnalyzerPrompt(result.record, result.artifactPath),
          source: 'daemon',
          channel: 'electron:meeting-capture',
          maxMinutes: 30,
        })
        : undefined;
      res.json({
        record: result.record,
        artifactPath: result.artifactPath,
        segmentCount: result.segmentCount,
        queuedTask: task ? { id: task.id, title: task.title } : null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Recent captured meetings — newest first. Drives the dashboard's
   * Meetings panel + the post-recording completion toast (so the
   * "send summary to chat" button can pull the analysis even if the
   * analyzer task hasn't finished yet, in which case `hasAnalysis`
   * stays false and the UI shows "analysis pending").
   */
  app.get('/api/console/meetings/recall/recent', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const limit = Math.max(1, Math.min(100, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '20', 10) || 20));
    try {
      res.json({ meetings: listRecentRecallMeetingSummaries(limit) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Single meeting + analysis. Returns the full record (with
   * transcript segments) plus the structured analysis JSON when
   * available. Used by the meeting drawer's "view" mode and the
   * completion toast.
   */
  app.get('/api/console/meetings/recall/:meetingId', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const meetingId = req.params.meetingId;
    try {
      const record = loadRecallMeetingById(meetingId);
      if (!record) { res.status(404).json({ error: 'meeting not found' }); return; }
      const analysis = loadRecallMeetingAnalysis(meetingId);
      res.json({ record, analysis });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/meetings/recall/:meetingId/chat-prompt', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const meetingId = req.params.meetingId;
    try {
      const record = loadRecallMeetingById(meetingId);
      if (!record) { res.status(404).json({ error: 'meeting not found' }); return; }
      const analysis = loadRecallMeetingAnalysis(meetingId);
      res.json({ prompt: buildMeetingChatPrompt(record, analysis) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // User rename: sets a locked 'user' title and re-files the note (title
  // into frontmatter + heading). File path is unchanged, so the vault
  // index stays consistent — we just reindex to pick up the new text.
  app.patch('/api/console/meetings/recall/:meetingId/title', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const meetingId = req.params.meetingId;
    const title = typeof (req.body?.title) === 'string' ? req.body.title.trim() : '';
    if (!title) { res.status(400).json({ error: 'title required' }); return; }
    try {
      const record = loadRecallMeetingById(meetingId);
      if (!record) { res.status(404).json({ error: 'meeting not found' }); return; }
      const changed = renameMeeting(meetingId, title);
      if (changed) { try { reindexVault(); } catch { /* maintenance will retry */ } }
      res.json({ record: loadRecallMeetingById(meetingId), changed });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Credentials health + management ───────────────────────────
  //
  // Backed by the SecretStore abstraction (src/runtime/secrets). The
  // dashboard never sees raw secret values for env-only or already-
  // stored credentials — only their existence, source, and status.
  //
  // POST endpoints accept a raw value once (when the user enters it)
  // and write it through the store. Migrations and resets call into
  // the existing methods.

  app.get('/api/console/credentials', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const store = await getSecretStore();
      const live = req.query.live === '1' || req.query.live === 'true';
      const rows = await store.health({ passive: !live });
      const descriptors = listSecretDescriptors().reduce<Record<string, { description: string; setupHint?: string; required: boolean; envVarName: string }>>(
        (acc, d) => { acc[d.name] = { description: d.description, setupHint: d.setupHint, required: d.required, envVarName: d.envVarName }; return acc; },
        {},
      );
      // Surface the Discord allow-list alongside the token so the hub can
      // offer a "Discord User ID" field on the discord_bot_token row. A
      // saved token alone makes the bot connect (config.ts auto-enables on
      // token presence) but it stays mute until a user ID is on this list
      // — see shouldRespond() in channels/discord.ts.
      const env = readBaseEnv();
      const discordAllowedUsers = (env.DISCORD_ALLOWED_USERS || env.DISCORD_DM_ALLOWED_USERS || '').trim();
      const slackAllowedUsers = (env.SLACK_ALLOWED_USERS || '').trim();
      res.json({ rows, descriptors, auth: getAuthStatus(), discordAllowedUsers, slackAllowedUsers });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Save the Discord owner / allowed user id(s) without a vault round-trip —
  // these are env values (the allow-list gate), not secrets. Writes BOTH
  // DISCORD_ALLOWED_USERS (channel + DM gate) and DISCORD_DM_ALLOWED_USERS
  // (DM poll loop) so the bot both connects AND replies. Applies on the
  // next daemon restart, like every other updateEnvKey-backed setting.
  app.post('/api/console/credentials/discord-owner', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const raw = typeof req.body?.ownerId === 'string' ? req.body.ownerId : '';
    // Accept a single id or a comma-separated list; keep only plausible
    // Discord snowflakes (17–20 digit ids, with margin) and drop the rest.
    const ids = raw.split(',').map((s: string) => s.trim()).filter((s: string) => /^\d{5,25}$/.test(s));
    if (raw.trim() && ids.length === 0) {
      res.status(400).json({ error: 'Enter a numeric Discord user ID (Developer Mode → right-click your name → Copy User ID).' });
      return;
    }
    try {
      const value = ids.join(',');
      updateEnvKey('DISCORD_ALLOWED_USERS', value);
      updateEnvKey('DISCORD_DM_ALLOWED_USERS', value);
      res.json({ ok: true, discordAllowedUsers: value, appliesOnRestart: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Save the Slack allowed user id(s). Same model as discord-owner: env-backed
  // allow-list gate (not a secret), applies on restart. Slack member IDs are
  // alphanumeric (U…/W…), not numeric — so the validation differs from Discord.
  app.post('/api/console/credentials/slack-owner', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const raw = typeof req.body?.ownerId === 'string' ? req.body.ownerId : '';
    const ids = raw.split(',').map((s: string) => s.trim()).filter((s: string) => /^[UW][A-Z0-9]{6,}$/.test(s));
    if (raw.trim() && ids.length === 0) {
      res.status(400).json({ error: 'Enter a Slack member ID (Profile → ⋮ → Copy member ID). It looks like U01ABCDEF.' });
      return;
    }
    try {
      const value = ids.join(',');
      updateEnvKey('SLACK_ALLOWED_USERS', value);
      res.json({ ok: true, slackAllowedUsers: value, appliesOnRestart: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Live Slack connection status + the setup manifest for the guided panel.
  app.get('/api/console/slack/status', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json({ ...getSlackRuntimeStatus(), manifest: SLACK_APP_MANIFEST_YAML });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/credentials/set', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name : '';
    const value = typeof body.value === 'string' ? body.value : '';
    const descriptors = listSecretDescriptors();
    const descriptor = descriptors.find((d) => d.name === name);
    if (!descriptor) { res.status(400).json({ error: 'unknown credential name' }); return; }
    if (!value) { res.status(400).json({ error: 'value required' }); return; }
    try {
      // Data-driven pre-save validation. Descriptors that supply
      // `validate` (currently composio + openai) get a live probe before
      // the bad value lands in the vault. Services without a cheap
      // probe just save through. Network outages return 'unknown' so
      // the user can still save when the upstream is the one that's
      // down. (Pattern shipped 2026-05-23 after composio_api_key
      // truncation slipped past the silent save path.)
      if (descriptor.validate) {
        const verdict = await descriptor.validate(value);
        if (verdict.result === 'invalid') {
          res.status(400).json({ error: verdict.message ?? 'Rejected by upstream service.', validation: 'invalid' });
          return;
        }
        const store = await getSecretStore();
        const result = await store.set(name as SecretName, value);
        res.json({
          name: result.name,
          source: result.source,
          status: result.status,
          validation: verdict.result,
          ...(verdict.result === 'unknown' ? { warning: verdict.message } : {}),
        });
        return;
      }
      const store = await getSecretStore();
      const result = await store.set(name as SecretName, value);
      res.json({ name: result.name, source: result.source, status: result.status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/credentials/migrate', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name : '';
    const from = body.from === 'env' || body.from === 'file' ? body.from : null;
    const to = body.to === 'keychain' || body.to === 'file' ? body.to : null;
    if (!name || !from || !to) { res.status(400).json({ error: 'name, from, to required' }); return; }
    try {
      const store = await getSecretStore();
      const result = await store.migrate(name as SecretName, from, to);
      res.json({ name: result.name, source: result.source, status: result.status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/credentials/repair-keychain', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const store = await getSecretStore();
      const report = await store.importLegacyKeychainToVault();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/credentials/reset', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    if (body.confirm !== true) {
      res.status(400).json({ error: 'confirm: true required — this deletes all clementine-owned credentials' });
      return;
    }
    try {
      const store = await getSecretStore();
      const report = await store.resetAll();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/console/credentials/:name', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const name = req.params.name;
    const known = listSecretDescriptors().map((d) => d.name as string);
    if (!known.includes(name)) { res.status(400).json({ error: 'unknown credential name' }); return; }
    try {
      const store = await getSecretStore();
      await store.delete(name as SecretName);
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Proactive check-in templates ──────────────────────────────

  app.get('/api/console/check-in-templates', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      ensureSeedTemplates();
      const items = listCheckInTemplates().map((t) => ({ ...t, state: getTemplateState(t.id) }));
      res.json({ templates: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/check-in-templates/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const t = getCheckInTemplate(req.params.id);
    if (!t) { res.status(404).json({ error: 'template not found' }); return; }
    res.json({ template: t, state: getTemplateState(t.id) });
  });

  app.post('/api/console/check-in-templates', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    if (!body.name || !body.trigger || !body.questionTemplate) {
      res.status(400).json({ error: 'name, trigger, questionTemplate required' }); return;
    }
    try {
      const created = createCheckInTemplate({
        name: body.name,
        description: body.description,
        agentSlug: body.agentSlug,
        trigger: body.trigger as TriggerKind,
        schedule: body.schedule,
        blockedHours: body.blockedHours,
        staleDays: body.staleDays,
        inboxThreshold: body.inboxThreshold,
        questionTemplate: body.questionTemplate,
        urgency: body.urgency as CheckInUrgency,
        cooldownHours: body.cooldownHours,
        enabled: body.enabled === true,
      });
      res.json({ template: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/check-in-templates/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const updated = updateCheckInTemplate(req.params.id, req.body ?? {});
    if (!updated) { res.status(404).json({ error: 'template not found' }); return; }
    res.json({ template: updated });
  });

  app.delete('/api/console/check-in-templates/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const ok = deleteCheckInTemplate(req.params.id);
    if (!ok) { res.status(404).json({ error: 'template not found' }); return; }
    res.json({ deleted: true });
  });

  app.post('/api/console/check-in-templates/:id/test', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const bypassCooldown = req.body?.bypassCooldown === true;
    const result = testFireTemplate(req.params.id, { bypassCooldown });
    if (!result.ok) { res.status(400).json(result); return; }
    res.json(result);
  });

  // ─── Agent-drafted check-in proposals ──────────────────────────

  app.get('/api/console/check-in-proposals', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const wanted = (status === 'pending' || status === 'approved' || status === 'rejected' || status === 'all')
      ? status : 'pending';
    try {
      const items = listProposals({ status: wanted, limit: 50 });
      res.json({ proposals: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/check-in-proposals/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const p = getProposal(req.params.id);
    if (!p) { res.status(404).json({ error: 'proposal not found' }); return; }
    res.json({ proposal: p });
  });

  app.post('/api/console/check-in-proposals/:id/approve', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    try {
      const result = approveProposal(req.params.id, {
        overrides: body.overrides && typeof body.overrides === 'object' ? body.overrides : undefined,
        enabledOnInstall: typeof body.enabledOnInstall === 'boolean' ? body.enabledOnInstall : true,
      });
      if (!result) { res.status(404).json({ error: 'proposal not found or already resolved' }); return; }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/check-in-proposals/:id/reject', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const result = rejectProposal(req.params.id, reason);
    if (!result) { res.status(404).json({ error: 'proposal not found' }); return; }
    res.json({ proposal: result });
  });

  app.delete('/api/console/check-in-proposals/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const ok = deleteProposal(req.params.id);
    if (!ok) { res.status(404).json({ error: 'proposal not found' }); return; }
    res.json({ deleted: true });
  });

  // ─── Goals (activated plan-contracts) ───────────────────────────

  app.get('/api/console/goals', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const filter = ['active', 'parked', 'terminal', 'self_driving', 'all'].includes(status ?? '') ? status : 'all';
    try {
      res.json(buildGoalsPayload(filter));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/goals/draft', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    if (notes.length < 8) { res.status(400).json({ error: 'notes required' }); return; }
    const desiredOutcome = typeof req.body?.desiredOutcome === 'string' ? req.body.desiredOutcome.trim() : undefined;
    try {
      res.json({ draft: draftGoalFromNotes({ notes, desiredOutcome }) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/goal-drafts', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const wanted = (status === 'pending' || status === 'created' || status === 'dismissed' || status === 'all')
      ? status
      : 'pending';
    try {
      res.json({ drafts: listGoalDrafts({ status: wanted, limit: 50 }) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/goal-drafts', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    if (notes.length < 8) { res.status(400).json({ error: 'notes required' }); return; }
    const desiredOutcome = typeof req.body?.desiredOutcome === 'string' ? req.body.desiredOutcome.trim() : undefined;
    try {
      const draft = surfaceGoalDraftFromNotes({
        notes,
        desiredOutcome,
        channel: 'console',
        proposedByAgent: 'user',
        notify: req.body?.notify === true,
      });
      res.json({ draft, drafts: listGoalDrafts({ status: 'pending', limit: 50 }) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/goal-drafts/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const draft = getGoalDraft(req.params.id);
    if (!draft) { res.status(404).json({ error: 'goal draft not found' }); return; }
    res.json({ draft });
  });

  app.post('/api/console/goal-drafts/:id/create', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const resumeEveryMinutes = numberFromBody(req.body?.resumeEveryMinutes, 30, 5, 1440);
    const maxResumes = numberFromBody(req.body?.maxResumes ?? req.body?.maxAutoResumes, 12, 1, 100);
    const maxAttempts = numberFromBody(req.body?.maxAttempts, 3, 1, 10);
    const deadlineAt = deadlineFromBody(req.body?.deadlineAt);
    const result = createGoalFromDraft(req.params.id, {
      selfDriving: req.body?.selfDriving === true,
      resumeEveryMs: resumeEveryMinutes * 60_000,
      maxResumes,
      maxAttempts,
      deadlineAt,
      channel: 'console',
    });
    if (!result) { res.status(404).json({ error: 'pending goal draft not found' }); return; }
    res.json({
      draft: result.draft,
      goal: summarizeGoal(result.goal),
      drafts: listGoalDrafts({ status: 'pending', limit: 50 }),
      ...buildGoalsPayload('all'),
    });
  });

  app.post('/api/console/goal-drafts/:id/dismiss', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Dismissed from Goals.';
    const draft = dismissGoalDraft(req.params.id, reason);
    if (!draft) { res.status(404).json({ error: 'pending goal draft not found' }); return; }
    res.json({ draft, drafts: listGoalDrafts({ status: 'pending', limit: 50 }) });
  });

  app.post('/api/console/goals', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
    if (!objective) { res.status(400).json({ error: 'objective required' }); return; }
    const successCriteria = stringsFromBody(req.body?.successCriteria, 8);
    const nextActions = stringsFromBody(req.body?.nextActions, 12);
    const risks = stringsFromBody(req.body?.risks, 8);
    const selfDriving = req.body?.selfDriving === true;
    const resumeEveryMinutes = numberFromBody(req.body?.resumeEveryMinutes, 30, 5, 1440);
    const maxResumes = numberFromBody(req.body?.maxResumes ?? req.body?.maxAutoResumes, 12, 1, 100);
    const maxAttempts = numberFromBody(req.body?.maxAttempts, 3, 1, 10);
    const deadlineAt = deadlineFromBody(req.body?.deadlineAt);
    try {
      const goal = createGoalContract({
        objective,
        successCriteria,
        nextActions,
        risks,
        selfDriving,
        resumeEveryMs: resumeEveryMinutes * 60_000,
        maxResumes,
        maxAttempts,
        deadlineAt,
        channel: 'console',
      });
      if (!goal) { res.status(400).json({ error: 'could not create goal' }); return; }
      res.json({ goal: summarizeGoal(goal), ...buildGoalsPayload('all') });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/goals/:id/self-drive', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const enabled = req.body?.enabled !== false;
    const resumeEveryMinutes = numberFromBody(req.body?.resumeEveryMinutes, 30, 5, 1440);
    const maxResumes = numberFromBody(req.body?.maxResumes ?? req.body?.maxAutoResumes, 12, 1, 100);
    const deadlineAt = deadlineFromBody(req.body?.deadlineAt);
    const goal = enabled
      ? enableGoalSelfDrive(req.params.id, { resumeEveryMs: resumeEveryMinutes * 60_000, maxResumes, deadlineAt })
      : disableGoalSelfDrive(req.params.id);
    if (!goal) { res.status(404).json({ error: 'active goal not found' }); return; }
    res.json({ goal: summarizeGoal(goal), ...buildGoalsPayload('all') });
  });

  app.post('/api/console/goals/:id/park', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : 'Paused from Goals.';
    const goal = parkGoal(req.params.id, 'blocker', note);
    if (!goal) { res.status(404).json({ error: 'active goal not found' }); return; }
    res.json({ goal: summarizeGoal(goal), ...buildGoalsPayload('all') });
  });

  app.post('/api/console/goals/:id/unpark', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const goal = unparkGoal(req.params.id);
    if (!goal) { res.status(404).json({ error: 'active goal not found' }); return; }
    res.json({ goal: summarizeGoal(goal), ...buildGoalsPayload('all') });
  });

  app.post('/api/console/goals/:id/satisfy', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Marked complete from Goals.';
    const goal = satisfyGoal(req.params.id, reason);
    if (!goal) { res.status(404).json({ error: 'active goal not found' }); return; }
    res.json({ goal: summarizeGoal(goal), ...buildGoalsPayload('all') });
  });

  app.post('/api/console/goals/:id/expire', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Stopped from Goals.';
    const goal = expireGoal(req.params.id, reason);
    if (!goal) { res.status(404).json({ error: 'active goal not found' }); return; }
    res.json({ goal: summarizeGoal(goal), ...buildGoalsPayload('all') });
  });

  // ─── Plan proposals (Planner sub-agent → user review) ──────────

  app.get('/api/console/plan-proposals', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const wanted = (status === 'pending' || status === 'approved' || status === 'rejected' || status === 'superseded' || status === 'all')
      ? status : 'pending';
    try {
      const items = listPlanProposals({ status: wanted, limit: 50 });
      res.json({ proposals: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/plan-proposals/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const p = getPlanProposal(req.params.id);
    if (!p) { res.status(404).json({ error: 'plan proposal not found' }); return; }
    res.json({ proposal: p });
  });

  app.post('/api/console/plan-proposals/:id/approve', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const existing = getPlanProposal(req.params.id);
    if (existing && planProposalNeedsUserInput(existing)) {
      res.status(409).json({
        error: 'plan needs user input before approval',
        needsUserInput: existing.plan.needsUserInput,
      });
      return;
    }
    const body = req.body ?? {};
    let editedPlan: ReturnType<typeof PlanSchema.parse> | undefined;
    if (body.editedPlan && typeof body.editedPlan === 'object') {
      const parsed = PlanSchema.safeParse(body.editedPlan);
      if (!parsed.success) {
        res.status(400).json({ error: 'editedPlan did not match PlanSchema', details: parsed.error.message });
        return;
      }
      editedPlan = parsed.data;
    }
    const scopeTtlMs = typeof body.scopeTtlMs === 'number' && body.scopeTtlMs >= 0 ? body.scopeTtlMs : undefined;
    const allowedTools = Array.isArray(body.allowedTools) ? body.allowedTools.filter((t: unknown) => typeof t === 'string') : undefined;
    // Goal-scoped autonomy (B1): "run autonomously" opens a goal-lifetime
    // approval scope + self-drives the goal. Sends still gate unless the user
    // enumerated them in allowedSends; the 5 safety gates never bypass.
    const autonomous = body.autonomous === true;
    const allowedSends = Array.isArray(body.allowedSends)
      ? body.allowedSends.filter((t: unknown) => typeof t === 'string')
      : undefined;
    const result = approvePlanAndQueueBackgroundTask(req.params.id, { editedPlan, scopeTtlMs, allowedTools, autonomous, allowedSends });
    if (!result) { res.status(404).json({ error: 'plan proposal not found or already resolved' }); return; }
    setImmediate(() => {
      processBackgroundTasks(assistant, 1).catch((err) => {
        console.warn('Immediate background task processor failed after plan approval:', err);
      });
    });
    res.json({ proposal: result.proposal, queuedTask: result.task, run: result.run });
  });

  app.post('/api/console/plan-proposals/:id/reject', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const result = rejectPlanProposal(req.params.id, reason);
    if (!result) { res.status(404).json({ error: 'plan proposal not found' }); return; }
    res.json({ proposal: result });
  });

  app.delete('/api/console/plan-proposals/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const ok = deletePlanProposal(req.params.id);
    if (!ok) { res.status(404).json({ error: 'plan proposal not found' }); return; }
    res.json({ deleted: true });
  });

  // ─── Plan scopes (active auto-approval windows) ────────────────

  app.get('/api/console/plan-scopes', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const includeClosed = req.query.includeClosed === 'true' || req.query.includeClosed === '1';
    const scopes = includeClosed ? listAllScopes() : listActiveScopes();
    res.json({ scopes });
  });

  app.post('/api/console/plan-scopes/:sessionId/close', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'revoked by user';
    const scope = closePlanScope(req.params.sessionId, reason);
    if (!scope) { res.status(404).json({ error: 'no scope for that session' }); return; }
    res.json({ scope });
  });

  // ─── Standing grants (B2: durable per-tool auto-approval) ──────

  app.get('/api/console/standing-grants', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.json({ grants: listStandingGrants() });
  });

  app.post('/api/console/standing-grants', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const toolName = typeof req.body?.toolName === 'string' ? req.body.toolName.trim() : '';
    if (!toolName) { res.status(400).json({ error: 'toolName required' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    // Classify so send/admin are refused at write — the side-effect law.
    const kind = classifyTool(toolName);
    const grant = grantStandingApproval(toolName, { kind, note });
    if (!grant) {
      res.status(400).json({ error: `cannot grant a ${kind} tool — sends and admin actions always require an in-the-moment decision` });
      return;
    }
    res.json({ grant });
  });

  app.delete('/api/console/standing-grants/:toolName', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const ok = revokeStandingApproval(req.params.toolName);
    if (!ok) { res.status(404).json({ error: 'no live grant for that tool' }); return; }
    res.json({ revoked: true });
  });

  // ─── MCP servers (manageable from the Integrations Hub) ────────
  //
  // Two sources merge into one list:
  //   - auto-detected from compatible local MCP client configs when enabled
  //   - user-managed in ~/.clementine-next/mcp/servers.json
  // User edits only affect the user-managed file. Auto-detected
  // entries are read-only here; the user toggles them via the user
  // file (key with same name overrides).

  app.get('/api/console/mcp-servers', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const discovered = discoverMcpServers();
      const user = loadUserMcpServers();
      // Enrich each server with connection state + which declared credential keys
      // are still UNSET (names only, never values) so the dashboard can show a
      // "needs credentials" badge + an entry field. Mirrors the mcp_status tool.
      const health = listMcpServerHealth();
      const servers = discovered.map((s) => {
        const h = health.find((x) => x.slug === slugifyServerName(s.name) || x.name === s.name);
        const { declaredEnvKeys, unsetEnvKeys } = serverEnvStatus(s);
        return { ...s, state: h?.state ?? 'unknown', failureCount: h?.failureCount ?? 0, lastError: h?.lastError, declaredEnvKeys, unsetEnvKeys };
      });
      res.json({ servers, userOverrides: user });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Read-only diagnostics endpoint behind the Settings "Show
   * diagnostics" toggle. Returns today's tool-event summary, recent
   * supervisor.log errors (filtered to drop noisy updater XML dumps),
   * and MCP server health. Pure read — no state changes.
   */
  app.get('/api/console/diagnostics', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(collectDiagnostics());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Ruflo-inspired harness audit: read-only scorecard over the concrete
   * Clementine substrate (tools, workflows, approvals, agents, learning).
   * This is intentionally separate from diagnostics: diagnostics shows raw
   * state; the audit turns those signals into prioritized fixes.
   */
  app.get('/api/console/harness/audit', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(collectHarnessAudit());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Agent-system effectiveness: swarm coordination + workflow loop health.
   * Reads existing logs only. This is the measurement spine for deciding when
   * to use fanout/review/debate swarms and when a workflow loop should replan
   * instead of retrying blindly.
   */
  app.get('/api/console/agent-system/metrics', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(collectAgentSystemMetrics());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Live MCP server health snapshot — drives the dashboard's status
   * pill in the header. Fast (no disk I/O — reads an in-memory
   * registry maintained by the namespace shim), safe to poll every
   * 2-3 seconds. Returns per-server slug, name, connection state, and
   * the count of tools the server has surfaced. The dashboard
   * renders a one-glance summary like "MCP · 3 ready · 1 connecting · 1 down".
   */
  app.get('/api/console/mcp/health', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const servers = listMcpServerHealth();
      const summary = {
        total: servers.length,
        connected: servers.filter((s) => s.state === 'connected').length,
        connecting: servers.filter((s) => s.state === 'connecting').length,
        degraded: servers.filter((s) => s.state === 'degraded').length,
        unavailable: servers.filter((s) => s.state === 'unavailable').length,
      };
      res.json({ servers, summary });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/mcp-servers/:name/reconnect', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const name = req.params.name;
    try {
      const server = discoverMcpServers().find((candidate) => candidate.name === name || slugifyServerName(candidate.name) === slugifyServerName(name));
      if (!server) { res.status(404).json({ error: 'server not found' }); return; }
      await invalidateConfiguredMcpServers();
      clearAutonomyAgentCache();
      const servers = listMcpServerHealth();
      res.json({
        ok: true,
        server: server.name,
        message: `MCP connections cleared; "${server.name}" will reconnect on the next tool call.`,
        servers,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/mcp-servers', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || !/^[A-Za-z0-9_.-]{2,40}$/.test(name)) {
      res.status(400).json({ error: 'name required (2-40 chars, alphanumeric / _ . -)' });
      return;
    }
    const type = body.type === 'http' || body.type === 'sse' ? body.type : 'stdio';
    const enabled = body.enabled !== false;
    const description = typeof body.description === 'string' ? body.description : undefined;
    const command = typeof body.command === 'string' ? body.command : undefined;
    const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === 'string') : undefined;
    const url = typeof body.url === 'string' ? body.url : undefined;
    const headers = body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)
      ? Object.fromEntries(Object.entries(body.headers as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : undefined;
    const env = body.env && typeof body.env === 'object' && !Array.isArray(body.env)
      ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : undefined;

    if (type === 'stdio' && !command) {
      res.status(400).json({ error: 'stdio servers require a command (e.g. "npx @modelcontextprotocol/server-filesystem")' });
      return;
    }
    if ((type === 'http' || type === 'sse') && !url) {
      res.status(400).json({ error: `${type} servers require a url` });
      return;
    }

    try {
      const current = loadUserMcpServers();
      current[name] = { name, type, enabled, description, command, args, url, headers, env };
      saveUserMcpServers(current);
      // Drop the cached MCP shim + autonomy agents so the next chat
      // request picks up the new server. No daemon restart needed.
      await invalidateConfiguredMcpServers();
      clearAutonomyAgentCache();
      res.status(201).json({ server: current[name] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/mcp-servers/:name', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const name = req.params.name;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const current = loadUserMcpServers();
      const existing = current[name];
      if (!existing) {
        // Allow toggling an auto-detected server by writing a minimal
        // override that ONLY sets the enabled flag. The discoverer
        // honors user-file values when both exist.
        const discovered = discoverMcpServers().find((s) => s.name === name);
        if (!discovered) { res.status(404).json({ error: 'server not found' }); return; }
        current[name] = {
          name,
          type: discovered.type,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : discovered.enabled,
          description: discovered.description,
          command: discovered.command,
          args: discovered.args,
          url: discovered.url,
          headers: discovered.headers,
          env: discovered.env,
        };
      } else {
        if (typeof body.enabled === 'boolean') existing.enabled = body.enabled;
        if (typeof body.description === 'string') existing.description = body.description;
        if (typeof body.command === 'string') existing.command = body.command;
        if (Array.isArray(body.args)) existing.args = body.args.filter((a: unknown): a is string => typeof a === 'string');
        if (typeof body.url === 'string') existing.url = body.url;
        if (body.type === 'http' || body.type === 'sse' || body.type === 'stdio') existing.type = body.type;
      }
      saveUserMcpServers(current);
      await invalidateConfiguredMcpServers();
      clearAutonomyAgentCache();
      res.json({ server: current[name] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Human-only credential entry for an MCP server. The brain can CREATE/flag a
   * server (mcp_add) but never writes secrets; this is where the human supplies
   * the value. Writes to the daemon .env via updateEnvKey (mirrors process.env +
   * persists 0600) — where the MCP subprocess resolves its declared env keys —
   * then reconnects so the server picks it up. Scoped to the server's DECLARED
   * env keys (no arbitrary env writes). The value is never logged or echoed back.
   */
  app.post('/api/console/mcp-servers/:name/credential', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const name = req.params.name;
    const body = (req.body ?? {}) as { key?: unknown; value?: unknown };
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const value = typeof body.value === 'string' ? body.value : '';
    try {
      if (!key) { res.status(400).json({ error: 'key required' }); return; }
      if (!value) { res.status(400).json({ error: 'value required' }); return; }
      const server = discoverMcpServers().find((s) => s.name === name);
      if (!server) { res.status(404).json({ error: 'server not found' }); return; }
      const { declaredEnvKeys } = serverEnvStatus(server);
      if (!declaredEnvKeys.includes(key)) {
        res.status(400).json({ error: `"${key}" is not a declared env key for "${name}". Declared: ${declaredEnvKeys.join(', ') || '(none)'}` });
        return;
      }
      updateEnvKey(key, value); // writes .env + mirrors process.env (value never logged)
      await invalidateConfiguredMcpServers(); // reconnect picks up the new credential
      res.json({ ok: true, server: name, key, set: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * v0.5.11 — Brain panel endpoints. Read-only views of what the brain
   * has learned (facts, entities, pointers, health stats). All
   * sourced from the memory.db tables introduced in v0.5.11 migration
   * v3 + v4 (see [[project_brain_architecture]] + [[project_brain_phase1_gaps]]).
   */
  app.get('/api/console/brain/facts', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { listActiveFacts, countActiveFacts, listAllFacts, searchFacts } = await import('../memory/facts.js');
      const kindParam = typeof req.query.kind === 'string' ? req.query.kind : '';
      const sort = typeof req.query.sort === 'string' ? req.query.sort : 'stanford';
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const includeForgotten = req.query.includeForgotten === '1' || req.query.includeForgotten === 'true';
      const allowedKinds = new Set(['user', 'project', 'feedback', 'reference']);
      const kind = allowedKinds.has(kindParam) ? (kindParam as 'user' | 'project' | 'feedback' | 'reference') : undefined;
      const limit = 100;
      let facts;
      if (query) {
        // Free-text / semantic search across the fact pool. Same shape as
        // listActiveFacts so the row template renders unchanged.
        facts = await searchFacts(query, { kind, topK: 60 });
        if (!includeForgotten) facts = facts.filter((f) => f.active !== false);
      } else if (includeForgotten) {
        facts = listAllFacts(200).filter((f) => !kind || f.kind === kind);
      } else {
        facts = listActiveFacts({ limit, kind, ranking: sort === 'stanford' ? 'stanford' : 'score' });
      }
      if (!query) {
        if (sort === 'recent') {
          facts = [...facts].sort((a, b) =>
            (b.lastAccessedAt || b.updatedAt || '').localeCompare(a.lastAccessedAt || a.updatedAt || ''),
          );
        } else if (sort === 'important') {
          facts = [...facts].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
        } else if (sort === 'trust') {
          facts = [...facts].sort((a, b) => (b.trustLevel ?? 0) - (a.trustLevel ?? 0));
        }
      }
      res.json({ facts, total: countActiveFacts() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/brain/entities', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { openMemoryDb } = await import('../memory/db.js');
      const db = openMemoryDb();
      const typeParam = typeof req.query.type === 'string' ? req.query.type : '';
      const allowed = new Set(['person', 'company', 'project', 'place', 'thing']);
      const rows = (allowed.has(typeParam)
        ? db.prepare('SELECT * FROM entities WHERE entity_type = ? ORDER BY mention_count DESC, last_seen_at DESC LIMIT 200')
            .all(typeParam)
        : db.prepare('SELECT * FROM entities ORDER BY mention_count DESC, last_seen_at DESC LIMIT 200')
            .all()) as Array<{
        id: number;
        entity_type: string;
        canonical_name: string;
        canonical_name_lc: string;
        aliases_json: string;
        first_seen_at: string;
        last_seen_at: string;
        mention_count: number;
      }>;
      const entities = rows.map((r) => {
        let aliases: string[] = [];
        try {
          const parsed = JSON.parse(r.aliases_json);
          if (Array.isArray(parsed)) aliases = parsed.filter((a) => typeof a === 'string');
        } catch { /* ignore */ }
        return {
          id: r.id,
          entityType: r.entity_type,
          canonicalName: r.canonical_name,
          aliases,
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
          mentionCount: r.mention_count,
        };
      });
      const totalRow = db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number };
      res.json({ entities, total: totalRow?.c ?? 0 });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/brain/pointers', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { openMemoryDb } = await import('../memory/db.js');
      const db = openMemoryDb();
      const rows = db.prepare(
        'SELECT * FROM episodic_pointers ORDER BY created_at DESC, id DESC LIMIT 100',
      ).all() as Array<{
        id: number;
        session_id: string;
        call_id: string;
        label: string;
        tool: string | null;
        source_uri: string | null;
        created_at: string;
      }>;
      const pointers = rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        callId: r.call_id,
        label: r.label,
        tool: r.tool,
        sourceUri: r.source_uri,
        createdAt: r.created_at,
      }));
      res.json({ pointers });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/brain/health', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { openMemoryDb } = await import('../memory/db.js');
      const db = openMemoryDb();
      const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
      const since7d = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

      const factCounts = db.prepare(`
        SELECT
          COUNT(*) AS active_total,
          SUM(CASE WHEN derived_from_call_id IS NOT NULL OR derived_from_session_id IS NOT NULL THEN 1 ELSE 0 END) AS derived,
          AVG(CASE WHEN derived_from_call_id IS NOT NULL THEN importance ELSE NULL END) AS avg_importance
        FROM consolidated_facts WHERE active = 1
      `).get() as { active_total: number; derived: number; avg_importance: number | null };

      const entityTotals = db.prepare(`
        SELECT entity_type, COUNT(*) AS c FROM entities GROUP BY entity_type
      `).all() as Array<{ entity_type: string; c: number }>;
      const entityMap: Record<string, number> = {};
      for (const row of entityTotals) entityMap[row.entity_type] = row.c;
      const entitiesTotal = Object.values(entityMap).reduce((sum, n) => sum + n, 0);

      const pointersTotal = (db.prepare('SELECT COUNT(*) AS c FROM episodic_pointers').get() as { c: number })?.c ?? 0;
      const pointersRecent = (db.prepare('SELECT COUNT(*) AS c FROM episodic_pointers WHERE created_at >= ?').get(since7d) as { c: number })?.c ?? 0;

      // Reflection health is in the per-day tool-events ndjson + the
      // harness.db condenser_applied / fact-conflict events we'd emit.
      // For Phase 1, count successful 'reflection' tool events.
      const reflectionsRow = (() => {
        try {
          const harnessDb = openMemoryDb(); // wrong handle; reflection events are in the harness DB
          // Fall through — we tally from the harness event log.
          return null;
        } catch { return null; }
      })();

      let reflections24h = 0, reflectionsSuccess = 0, reflectionsSkipped = 0, reflectionsFailed = 0;
      try {
        const { openEventLog } = await import('../runtime/harness/eventlog.js');
        const hdb = openEventLog();
        // We emitted reflection lifecycle via recordToolEvent, not harness.db.
        // Read the same configured tool-events home the writer uses.
        const dir = toolEventsDir();
        const today = new Date().toISOString().slice(0, 10);
        const file = path.join(dir, today + '.ndjson');
        if (fs.existsSync(file)) {
          const lines = fs.readFileSync(file, 'utf-8').split('\n');
          for (const line of lines) {
            if (!line.startsWith('{')) continue;
            try {
              const evt = JSON.parse(line) as { toolName?: string; outcome?: string; at?: string };
              if (evt.toolName !== 'reflection') continue;
              if (!evt.at || evt.at < since24h) continue;
              reflections24h += 1;
              if (evt.outcome === 'success') reflectionsSuccess += 1;
              else if (evt.outcome === 'cancelled') reflectionsSkipped += 1;
              else if (evt.outcome === 'error') reflectionsFailed += 1;
            } catch { /* ignore */ }
          }
        }
        // Suppress unused warning
        void hdb;
        void reflectionsRow;
      } catch { /* ignore — health degrades gracefully */ }

      res.json({
        activeFacts: factCounts?.active_total ?? 0,
        derivedFacts: factCounts?.derived ?? 0,
        directFacts: Math.max(0, (factCounts?.active_total ?? 0) - (factCounts?.derived ?? 0)),
        avgImportance: factCounts?.avg_importance ?? null,
        entitiesTotal,
        entitiesPerson: entityMap.person ?? 0,
        entitiesCompany: entityMap.company ?? 0,
        entitiesProject: entityMap.project ?? 0,
        entitiesPlace: entityMap.place ?? 0,
        entitiesThing: entityMap.thing ?? 0,
        pointersTotal,
        pointersRecent,
        reflections24h,
        reflectionsSuccess,
        reflectionsSkipped,
        reflectionsFailed,
        factsUpdated: 0, // tally only available once we emit a dedicated event type for conflict outcomes
        factsDeleted: 0,
        factsNoop: 0,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * v0.5.11 — Approvals panel list endpoint.
   *
   * Returns every pending approval with the full context the user
   * needs to decide: subject (what's being asked), tool, args (what
   * would actually run), source workflow if present, requestedAt for
   * relative-age display, and the approvalId for the action endpoint.
   *
   * Distinct from the runtime's listPendingApprovals() shape — that one
   * exposes only toolName + sessionId, which is what created the
   * "Approval needed: request_approval in sess-abc" noise loop that
   * trained users to ignore the brief. This endpoint reads
   * approval-registry directly so the dashboard sees the same rich
   * shape the DB stores.
   */
  app.get('/api/console/approvals/list', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { listPending } = await import('../runtime/harness/approval-registry.js');
      const harnessRows = listPending({ status: 'pending' });
      const runtimeRows = assistant.getRuntime().listPendingApprovals();
      const backgroundTaskByApprovalId = new Map(
        listBackgroundTasks()
          .filter((task) => task.pendingApprovalId)
          .map((task) => [task.pendingApprovalId as string, task]),
      );

      const harnessApprovals = harnessRows.map((r) => {
        // Resource-fingerprint check: if the approval's args carry a
        // resource id (sheet, doc, etc.) and the active focus has a
        // resource_ref, surface a warning when they DON'T match.
        // Catches the "agent picked the wrong sheet" failure mode
        // (sess-mpjbmoez 2026-05-24) at decision time.
        const resourceId = extractResourceIdFromApprovalArgs(r.args);
        const fingerprint = checkResourceMatchesFocus(resourceId);
        const preview = normalizeApprovalPreview(r.args?.preview);
        return {
          kind: 'harness' as const,
          approvalId: r.approvalId,
          sessionId: r.sessionId,
          channel: r.channel,
          channelId: r.channelId,
          requestedAt: r.requestedAt,
          expiresAt: r.expiresAt,
          subject: r.subject,
          summary: approvalSummaryFromArgs(r.args ?? undefined, r.subject),
          reason: approvalReasonFromArgs(r.args ?? undefined),
          preview,
          contentPreview: extractApprovalContentPreview(r.tool, r.args ?? undefined),
          pendingAction: pendingActionApprovalViewFromArgs(r.args),
          sourceTitle: undefined as string | undefined,
          sourceKind: undefined as string | undefined,
          tool: r.tool,
          args: r.args,
          resourceFingerprint: fingerprint.result === 'unknown' ? undefined : {
            result: fingerprint.result,
            candidateId: resourceId,
            focusRef: fingerprint.focusRef,
            focusTitle: fingerprint.focusTitle,
          },
        };
      });

      // Runtime approvals (request_approval / gated tool calls) previously
      // showed up in Home → NEEDS YOU but NEVER reached the Approvals
      // panel — clicking through to Approvals showed "0 pending" while
      // Home said "4". (Observed 2026-05-23.) Map them to the same shape
      // so this panel is the single authoritative source.
      const runtimeApprovals = runtimeRows.map((approval) => {
        const args = extractRuntimeApprovalArgs(approval);
        const task = backgroundTaskByApprovalId.get(approval.id);
        return {
          kind: 'runtime' as const,
          approvalId: approval.id,
          sessionId: approval.sessionId,
          channel: approval.channel,
          channelId: undefined as string | undefined,
          requestedAt: approval.createdAt,
          expiresAt: undefined as string | undefined,
          subject: `Approve: ${summarizeApprovalAction(approval)}`,
          summary: approvalSummaryFromArgs(args, summarizeApprovalAction(approval)),
          reason: approvalReasonFromArgs(args),
          preview: normalizeApprovalPreview(args?.preview),
          pendingAction: pendingActionApprovalViewFromArgs(args),
          sourceTitle: task?.title,
          sourceKind: task ? 'background task' : undefined,
          tool: approval.toolName,
          args,
        };
      });

      // Newest first across both registries.
      const approvals = [...harnessApprovals, ...runtimeApprovals]
        .sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
      res.json({ approvals, count: approvals.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/demo/agentic-flow', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const reportBackTarget = parseBackgroundReportBackTarget((req.body as { reportBackTarget?: unknown } | undefined)?.reportBackTarget);
      const task = createBackgroundTask({
        title: 'Demo: agentic delivery loop',
        prompt: [
          'Demonstrate Clementine end to end:',
          '- queue a durable background task',
          '- show live task status in the cockpit',
          '- produce a result with evidence and risks',
          '- queue the report-back notification for Slack or Discord routes',
        ].join('\n'),
        source: 'desktop',
        maxMinutes: 5,
        ...(reportBackTarget ? { reportBackTarget } : {}),
      });
      markBackgroundTaskRunning(task.id);
      const result = [
        '# Demo: Agentic Delivery Loop',
        '',
        '## Completed',
        '- Created a durable background task record.',
        '- Advanced it through the same running and completed states used by real autonomous work.',
        '- Queued the completion notification with task metadata so Slack and Discord report-back routing can pick it up.',
        '- Made the task inspectable in the Tasks cockpit with result, notifications, and delivery metadata.',
        '',
        '## Evidence / Verification',
        `- Task ID: ${task.id}`,
        '- Route: POST /api/console/demo/agentic-flow',
        '- Store: state/background-tasks plus state/notifications',
        '',
        '## Remaining Risks',
        '- Live external delivery still depends on configured Slack or Discord routes passing the acceptance runner.',
        '',
        '## Next Step',
        'Open this task in the Tasks board cockpit, then run channel acceptance from Settings.',
      ].join('\n');
      const completed = markBackgroundTaskDone(task.id, result, {
        notificationBody: 'Demo completed. Open the Tasks cockpit to inspect the result, evidence, and delivery metadata.',
      }) ?? getBackgroundTask(task.id) ?? task;
      const detail = getBackgroundTaskStatus(task.id);
      res.json({ ok: true, task: completed, detail });
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/background-tasks/:id', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const task = getBackgroundTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'background task not found' });
        return;
      }
      let resultFull = task.result;
      if (task.resultPath && existsSync(task.resultPath)) {
        const full = readFileSync(task.resultPath, 'utf-8');
        resultFull = full.length > 50_000 ? `${full.slice(0, 50_000)}\n\n...[truncated for console preview]` : full;
      }
      const detail = getBackgroundTaskStatus(task.id);
      // Cockpit vitals: give the drawer a live sense of duration / effort / spend
      // so a running card looks different at 30s vs 30min. All best-effort — a
      // missing field just drops that metric, never fails the response.
      const startMs = Date.parse(task.startedAt ?? task.createdAt);
      const endMs = task.completedAt ? Date.parse(task.completedAt) : Date.now();
      const elapsedMs = Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : undefined;
      // Each tool call emits a 'start' phase then an 'end'/'error' — count starts
      // so paired events aren't double-counted (tool-observability.ts phases).
      const toolCallCount = (detail?.toolEvents ?? []).filter((event) => event.phase === 'start').length;
      let tokensUsed: number | undefined;
      try {
        const { sumUsageTokensForSource } = await import('../runtime/usage-log.js');
        const total = sumUsageTokensForSource(task.runSessionId);
        if (total > 0) tokensUsed = total;
      } catch { /* usage log is best-effort observability */ }
      const vitals = {
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        toolCallCount,
        ...(tokensUsed !== undefined ? { tokensUsed } : {}),
        running: !task.completedAt,
      };
      res.json({ task: { ...task, resultFull }, detail, vitals });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/background-tasks/:id/report-back-target', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const task = getBackgroundTask(req.params.id);
      if (!task) {
        res.status(404).json({ ok: false, reason: 'background task not found' });
        return;
      }
      const target = parseBackgroundReportBackTarget(req.body);
      if (!target) {
        res.status(400).json({ ok: false, reason: 'Valid type plus user_id or channel_id is required.' });
        return;
      }
      const updated = setBackgroundTaskReportBackTarget(task.id, target);
      if (!updated) {
        res.status(400).json({ ok: false, reason: 'Could not save that report-back target.' });
        return;
      }
      res.json({ ok: true, task: updated });
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/background-tasks/:id/repost-result', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      let task = getBackgroundTask(req.params.id);
      if (!task) {
        res.status(404).json({ ok: false, reason: 'background task not found' });
        return;
      }
      const target = parseBackgroundReportBackTarget(req.body);
      if (target) {
        task = setBackgroundTaskReportBackTarget(task.id, target) ?? task;
      }

      const detail = getBackgroundTaskStatus(task.id);
      const result = detail?.task.resultFull ?? task.result ?? '';
      if (!result.trim()) {
        res.status(409).json({ ok: false, reason: 'This task does not have a result to repost yet.' });
        return;
      }

      const notificationId = `${Date.now()}-background-${task.id}-repost`;
      addNotification({
        id: notificationId,
        kind: 'execution',
        title: `Background task result: ${task.title}`,
        body: truncateResultBody(result),
        createdAt: new Date().toISOString(),
        read: false,
        metadata: backgroundTaskNotificationMetadata(task, {
          repostedBackgroundTaskResult: true,
          status: task.status,
        }),
      });
      res.json({ ok: true, task, notificationId });
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Unified background-work board (the desktop "Tasks" Kanban). Aggregates
   * every kind of background work into one flat, UN-filtered, normalized card
   * array — the opposite of /api/command-center, which deliberately filters
   * each source down to "working now / needs you / recent". The board needs
   * everything, including terminal / interrupted / blocked cards, so it owns
   * a dedicated endpoint to keep the command-center contract stable.
   *
   * Sources: background tasks · run records · executions · in-flight workflow
   * runs. Each card carries an `actions` allowlist the frontend uses to gate
   * drag-and-drop (a drop is a REQUEST for an action, never a status write).
   */
  // Queue visibility: the SUB-TASK QUEUE of one workflow run — each step/forEach
  // unit ("check followers", "draft post 3") with its status (done/running/
  // failed/queued/blocked) + what runs next, reconstructed from the durable event
  // log. Lets the Tasks board expand a campaign card into its real queue instead
  // of one opaque "running" pill. Read-only; survives restarts.
  app.get('/api/console/board/run/:slug/:runId/queue', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const slug = String(req.params.slug ?? '');
      const runId = String(req.params.runId ?? '');
      const entry = listWorkflows().find((e) => e.name === slug || e.data.name === slug);
      if (!entry) { res.status(404).json({ error: 'workflow not found' }); return; }
      const run = readWorkflowRunRecord(runId);
      if (!run) { res.status(404).json({ error: 'workflow run not found' }); return; }
      if (run.workflow !== entry.data.name && run.workflow !== entry.name) {
        res.status(404).json({ error: 'workflow run does not belong to this workflow' });
        return;
      }
      const steps = run.targetStepId
        ? (entry.data.steps ?? []).filter((step) => step.id === run.targetStepId)
        : (entry.data.steps ?? []);
      if (run.targetStepId && steps.length === 0) {
        res.status(404).json({ error: 'workflow run target step not found' });
        return;
      }
      res.json(reconstructWorkflowRunQueue(entry.name, runId, steps));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/board', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const now = Date.now();
      const ageMs = (iso?: string): number => {
        const t = iso ? Date.parse(iso) : NaN;
        return Number.isFinite(t) ? Math.max(0, now - t) : 0;
      };
      const cards: BoardCard[] = [];
      const coveredApprovalIds = new Set<string>();
      const workflowByDisplayName = new Map(listWorkflows().map((entry) => [entry.data.name, entry]));
      const workflowBySlug = new Map(listWorkflows().map((entry) => [entry.name, entry]));

      // 1) Background tasks — the autonomous "go do this while I'm away" work.
      //    ?includeArchived=1 surfaces soft-deleted tasks (restore-only) for a
      //    future "Archived" view; default hides them.
      const includeArchived = req.query.includeArchived === '1' || req.query.archived === '1';
      for (const task of listBackgroundTasks({ includeArchived })) {
        const terminal = task.status === 'done' || task.status === 'failed'
          || task.status === 'aborted' || task.status === 'interrupted';
        const sKind = task.archived ? null : staleTaskKind(task, now);
        const column: BoardColumnId =
          task.status === 'pending' ? 'queued'
            : task.status === 'running' || task.status === 'cancelling' ? 'running'
              : task.status === 'awaiting_approval' || task.status === 'awaiting_continue' || task.status === 'blocked' ? 'needs_you'
                : 'done';
        const actions: string[] = [];
        if (task.archived) {
          actions.push('restore');
        } else {
          if (task.status === 'pending') actions.push('promote', 'cancel');
          else if (task.status === 'awaiting_continue') actions.push('resume', 'cancel');
          else if (task.status === 'running' || task.status === 'cancelling'
            || task.status === 'blocked') actions.push('cancel');
          else if (task.status === 'awaiting_approval') actions.push('approve', 'reject', 'cancel');
          else if (task.status === 'interrupted' || task.status === 'failed' || task.status === 'aborted') {
            if (!task.resumedIntoTaskId) actions.push('resume');
          }
          // Archive declutters a finished task, or clears a stale forgotten-parked
          // one — soft-delete, always restorable.
          if (terminal || sKind) actions.push('archive');
        }
        if (task.pendingApprovalId) coveredApprovalIds.add(task.pendingApprovalId);
        const action = boardActionForStatus('background', task.status, Boolean(task.pendingApprovalId));
        cards.push({
          id: task.id,
          sourceKind: 'background',
          title: task.title,
          column,
          status: task.status,
          progressHint: task.lastCheckInMessage || (terminal && task.error ? task.error : '') || '',
          sessionId: task.runSessionId,
          ageMs: ageMs(task.updatedAt),
          updatedAt: task.updatedAt,
          actions,
          primaryAction: action.primaryAction,
          continueMode: action.continueMode,
          approvalId: task.pendingApprovalId,
          nextSafeAction: action.nextSafeAction,
          stale: Boolean(sKind),
          staleKind: sKind ?? undefined,
          archived: task.archived || undefined,
          raw: {
            pendingApprovalId: task.pendingApprovalId,
            error: task.error,
            resultPreview: task.result?.slice(0, 600),
            source: task.source,
            modelRoute: task.effectiveModel || task.modelProvider || task.modelRouteKind || task.modelTransport || task.modelRouteFalloverFrom
              ? {
                  requestedModel: task.requestedModel,
                  effectiveModel: task.effectiveModel,
                  provider: task.modelProvider,
                  routeKind: task.modelRouteKind,
                  transport: task.modelTransport,
                  falloverFrom: task.modelRouteFalloverFrom,
                }
              : undefined,
          },
        });
      }

      // 2) Run records — chat/Discord/CLI/gateway runs. Drop background-backed
      //    runs (id === `run-<taskId>`) so the same work isn't double-emitted.
      for (const run of listRuns(80)) {
        if (run.id.startsWith('run-bg-')) continue; // background task's own run record
        const needsAttention = run.needsAttention === true;
        if (run.pendingApprovalId) coveredApprovalIds.add(run.pendingApprovalId);
        const column: BoardColumnId =
          needsAttention ? 'needs_you'
            : run.status === 'queued' || run.status === 'received' ? 'queued'
              : run.status === 'running' ? 'running'
              : run.status === 'awaiting_approval' ? 'needs_you'
                : 'done';
        const live = column === 'queued' || column === 'running' || column === 'needs_you';
        const workflowName = run.source === 'workflow' ? run.title.replace(/^Workflow:\s*/, '').trim() : '';
        const workflowEntry = workflowName ? workflowByDisplayName.get(workflowName) : undefined;
        const workflowRecovery = workflowEntry ? workflowRunRecovery(workflowEntry.name, run.id) : undefined;
        const action = run.pendingApprovalId
          ? boardActionForStatus('run', run.status, true)
          : workflowRecovery ?? boardActionForStatus('run', run.status, false);
        const actions = run.pendingApprovalId
          ? ['approve', 'reject', ...(live && !needsAttention ? ['cancel'] : [])]
          : (live && !needsAttention ? ['cancel'] : []);
        cards.push({
          id: run.id,
          sourceKind: 'run',
          title: run.title,
          column,
          status: needsAttention ? 'needs_attention' : run.status,
          progressHint: run.outputPreview?.slice(0, 600)
            || run.events[run.events.length - 1]?.message || '',
          sessionId: run.sessionId,
          ageMs: ageMs(run.updatedAt),
          updatedAt: run.updatedAt,
          actions,
          primaryAction: action.primaryAction,
          continueMode: action.continueMode,
          approvalId: run.pendingApprovalId,
          nextSafeAction: action.nextSafeAction,
          artifactSummary: workflowRecovery?.artifactSummary,
          failureSummary: workflowRecovery?.failureSummary ?? (needsAttention ? {
            failedItems: 0,
            retryable: false,
            reason: run.outputPreview || run.error || 'This run needs human review before Clementine continues.',
          } : undefined),
          raw: {
            error: run.error,
            source: run.source,
            pendingApprovalId: run.pendingApprovalId,
            needsAttention: needsAttention || undefined,
            workflowName: workflowEntry?.data.name,
            runId: workflowEntry ? run.id : undefined,
          },
        });
      }

      // 3) Executions — long-running, controller-driven work.
      for (const exec of new ExecutionStore().list(80)) {
        const column: BoardColumnId =
          exec.status === 'active' ? 'running'
            : exec.status === 'paused' || exec.status === 'blocked' ? 'needs_you'
              : 'done';
        const actions: string[] = [];
        if (exec.status === 'active' || exec.status === 'blocked') actions.push('cancel');
        else if (exec.status === 'paused') actions.push('resume', 'cancel');
        const action = boardActionForStatus('execution', exec.status, false);
        cards.push({
          id: exec.id,
          sourceKind: 'execution',
          title: exec.title,
          column,
          status: exec.status,
          progressHint: exec.nextStep || exec.lastAssistantSummary || exec.blocker || '',
          sessionId: exec.sessionId,
          ageMs: ageMs(exec.updatedAt),
          updatedAt: exec.updatedAt,
          actions,
          primaryAction: action.primaryAction,
          continueMode: action.continueMode,
          nextSafeAction: action.nextSafeAction,
          failureSummary: exec.status === 'blocked' ? {
            failedItems: 0,
            retryable: false,
            reason: exec.blocker || 'This goal needs human input before Clementine continues.',
          } : undefined,
          raw: { blocker: exec.blocker, pausedBy: exec.pausedBy, objective: exec.objective },
        });
      }

      // 4) In-flight workflow runs. Terminal workflow runs surface via their
      //    run record (source: 'workflow') in section 2 → Done. Live trace for
      //    these uses the run-events poll, not the session SSE (workflow steps
      //    run under per-step `workflow:<suffix>` sessions we can't address).
      for (const pending of listPendingRuns()) {
        const workflowEntry = workflowBySlug.get(pending.workflowName) ?? workflowByDisplayName.get(pending.workflowName);
        const recovery = workflowRunRecovery(pending.workflowName, pending.runId);
        const column: BoardColumnId = pending.inFlightStepId ? 'running' : 'queued';
        cards.push({
          id: `wf:${pending.workflowName}:${pending.runId}`,
          sourceKind: 'workflow',
          title: workflowEntry?.data.name ?? pending.workflowName,
          column,
          status: pending.inFlightStepId ? `step: ${pending.inFlightStepId}` : 'queued',
          progressHint: pending.inFlightStepId ? `Running step ${pending.inFlightStepId}` : 'Queued',
          sessionId: null,
          ageMs: ageMs(pending.lastEventAt),
          updatedAt: pending.lastEventAt ?? new Date(now).toISOString(),
          actions: recovery.failureSummary?.retryable ? ['retry_failed_items', 'cancel'] : ['cancel'],
          primaryAction: recovery.primaryAction,
          continueMode: recovery.continueMode,
          nextSafeAction: recovery.nextSafeAction,
          artifactSummary: recovery.artifactSummary,
          failureSummary: recovery.failureSummary,
          raw: { workflowName: workflowEntry?.data.name ?? pending.workflowName, workflowSlug: pending.workflowName, runId: pending.runId },
        });
      }

      // 5) Standalone approvals — approvals not already represented by a
      // background task or run still need to be actionable from Tasks.
      for (const row of approvalRegistry.listPending({ status: 'pending' })) {
        if (coveredApprovalIds.has(row.approvalId)) continue;
        coveredApprovalIds.add(row.approvalId);
        const session = getHarnessSession(row.sessionId);
        const isWorkflowApproval = session?.kind === 'workflow';
        const workflowName = typeof session?.metadata?.workflowName === 'string' ? session.metadata.workflowName : undefined;
        const workflowRunId = typeof session?.metadata?.workflowRunId === 'string' ? session.metadata.workflowRunId : undefined;
        cards.push({
          id: `approval:${row.approvalId}`,
          sourceKind: 'approval',
          title: row.subject || 'Approval required',
          column: 'needs_you',
          status: 'awaiting_approval',
          progressHint: approvalSummaryFromArgs(row.args ?? undefined, row.subject),
          sessionId: row.sessionId,
          ageMs: ageMs(row.requestedAt),
          updatedAt: row.requestedAt,
          actions: ['approve', 'reject'],
          primaryAction: 'approve',
          continueMode: 'approval',
          approvalId: row.approvalId,
          nextSafeAction: isWorkflowApproval
            ? 'Approve or reject; the workflow runner resumes the parked step.'
            : 'Approve or reject; Clementine resumes the paused run.',
          contentPreview: extractApprovalContentPreview(row.tool, row.args ?? undefined),
          pendingAction: pendingActionApprovalViewFromArgs(row.args),
          raw: {
            approvalKind: 'harness',
            tool: row.tool,
            reason: approvalReasonFromArgs(row.args ?? undefined),
            workflowName,
            runId: workflowRunId,
          },
        });
      }

      let runtimeApprovals: PendingApproval[] = [];
      try {
        runtimeApprovals = assistant.getRuntime().listPendingApprovals();
      } catch {
        runtimeApprovals = [];
      }
      for (const approval of runtimeApprovals) {
        if (coveredApprovalIds.has(approval.id)) continue;
        coveredApprovalIds.add(approval.id);
        const args = extractRuntimeApprovalArgs(approval);
        cards.push({
          id: `approval:${approval.id}`,
          sourceKind: 'approval',
          title: `Approve: ${summarizeApprovalAction(approval)}`,
          column: 'needs_you',
          status: 'awaiting_approval',
          progressHint: approvalSummaryFromArgs(args, summarizeApprovalAction(approval)),
          sessionId: approval.sessionId,
          ageMs: ageMs(approval.createdAt),
          updatedAt: approval.createdAt,
          actions: ['approve', 'reject'],
          primaryAction: 'approve',
          continueMode: 'approval',
          approvalId: approval.id,
          nextSafeAction: 'Approve or reject; Clementine resumes the paused runtime approval.',
          contentPreview: extractApprovalContentPreview(approval.toolName, args),
          pendingAction: pendingActionApprovalViewFromArgs(args),
          raw: { approvalKind: 'runtime', tool: approval.toolName, reason: approvalReasonFromArgs(args) },
        });
      }

      cards.sort((a, b) => a.ageMs - b.ageMs);
      // Live columns are naturally bounded; Done is not (every task ever is
      // terminal eventually). Cap it to the most-recent 40 so the payload and
      // the board stay lean. `cards` is sorted by ageMs asc, so the kept Done
      // cards are the freshest.
      const DONE_CAP = 40;
      let doneShown = 0;
      const trimmed = cards.filter((c) => c.column !== 'done' || (doneShown += 1) <= DONE_CAP);
      res.json({ cards: trimmed, generatedAt: new Date(now).toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Board drag actions. A drop onto a column is a REQUEST for an action; the
   * server validates it against the card's real state and returns
   * { ok:false, reason } for a snap-back. Status is never written directly —
   * each action calls the canonical store fn and the board re-polls.
   */
  app.post('/api/console/board/background/:id/:action', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const { id, action } = req.params;
    const task = getBackgroundTask(id);
    if (!task) { res.status(404).json({ ok: false, reason: 'background task not found' }); return; }
    try {
      if (action === 'cancel') {
        const updated = cancelBackgroundTask(id, 'Cancelled from the Tasks board.');
        res.json({ ok: true, task: updated });
        return;
      }
      if (action === 'resume') {
        if (task.status !== 'awaiting_continue' && task.status !== 'interrupted' && task.status !== 'failed' && task.status !== 'aborted') {
          res.status(409).json({ ok: false, reason: `Cannot resume a ${task.status} task.` });
          return;
        }
        const resumed = resumeBackgroundTask(id);
        if (!resumed) { res.status(409).json({ ok: false, reason: 'Task could not be resumed.' }); return; }
        res.json({ ok: true, task: resumed });
        return;
      }
      if (action === 'archive') {
        // Only finished or parked tasks may be archived — never an ACTIVE one
        // (archiving a running/queued task would hide it from the drain's
        // concurrency count + the watchdog while its worker is still live).
        if (task.status === 'pending' || task.status === 'running' || task.status === 'cancelling') {
          res.status(409).json({ ok: false, reason: `Cancel the ${task.status} task before archiving it.` });
          return;
        }
        // Soft-delete: drops off the board + every sweep, fully restorable.
        const archived = archiveBackgroundTask(id);
        res.json({ ok: true, task: archived });
        return;
      }
      if (action === 'restore') {
        const restored = restoreBackgroundTask(id);
        if (!restored) { res.status(409).json({ ok: false, reason: 'Task could not be restored.' }); return; }
        res.json({ ok: true, task: restored });
        return;
      }
      if (action === 'promote') {
        if (task.status !== 'pending') {
          res.status(409).json({ ok: false, reason: `Only queued tasks can be started now (this one is ${task.status}).` });
          return;
        }
        // The single-task drain is the "run now" entry point: it pulls the
        // oldest pending task immediately instead of waiting for the next tick.
        setImmediate(() => {
          processBackgroundTasks(assistant, 1).catch((err) => {
            console.warn('Board promote: immediate background processor failed:', err);
          });
        });
        res.json({ ok: true, task });
        return;
      }
      res.status(400).json({ ok: false, reason: `Unknown action: ${action}` });
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/board/execution/:id/transition', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const to = req.body?.to;
    if (to !== 'active' && to !== 'cancelled') {
      res.status(400).json({ ok: false, reason: 'transition `to` must be "active" or "cancelled"' });
      return;
    }
    const store = new ExecutionStore();
    const exec = store.get(req.params.id);
    if (!exec) { res.status(404).json({ ok: false, reason: 'execution not found' }); return; }
    try {
      if (to === 'active') {
        if (exec.status !== 'paused') {
          res.status(409).json({ ok: false, reason: `Only paused work can be resumed (this is ${exec.status}).` });
          return;
        }
        const updated = store.update(exec.id, { status: 'active', pausedBy: undefined });
        res.json({ ok: true, execution: updated });
        return;
      }
      // to === 'cancelled' — ExecutionRecord has no 'cancelled'/'failed' state;
      // 'completed' + a blocker reason is the canonical terminal close (mirrors
      // failExecution / sweepStaleExecutions).
      if (exec.status === 'completed') { res.json({ ok: true, execution: exec }); return; }
      const updated = store.update(exec.id, { status: 'completed', blocker: 'Cancelled from the Tasks board.' });
      res.json({ ok: true, execution: updated });
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/board/run/:id/cancel', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const run = getRun(req.params.id);
    if (!run) { res.status(404).json({ ok: false, reason: 'run not found' }); return; }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      res.json({ ok: true, run });
      return;
    }
    try {
      // Best-effort: also signal the underlying harness session to stop.
      if (run.sessionId) { try { requestHarnessKill(run.sessionId, 'Cancelled from the Tasks board.'); } catch { /* best effort */ } }
      const updated = finishRun(run.id, { status: 'cancelled', message: 'Cancelled from the Tasks board.' });
      res.json({ ok: true, run: updated });
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/board/approval/:id/:decision', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = req.params.id;
    const decision = req.params.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ ok: false, reason: 'decision must be approve or reject' });
      return;
    }
    const approved = decision === 'approve';

    try {
      // Background tasks park the SDK run and need a queued continuation; a
      // direct resolve would skip the task state machine and strand the card.
      const queued = queueBackgroundTaskApprovalResolution(id, approved);
      if (queued) {
        res.json({
          ok: true,
          approvalId: id,
          status: approved ? 'approved' : 'rejected',
          queuedTaskId: queued.id,
          sessionId: queued.runSessionId,
          message: `Queued background task continuation: ${queued.id}.`,
        });
        return;
      }

      const existing = approvalRegistry.get(id);
      if (existing) {
        if (existing.status !== 'pending') {
          res.status(409).json({ ok: false, reason: 'approval already resolved', approval: existing });
          return;
        }
        const auditResolution = approved ? 'approved' : 'rejected';
        const harnessSession = HarnessSession.load(existing.sessionId);
        const sessionRowForKind = getHarnessSession(existing.sessionId);
        const shouldResume = sessionRowForKind?.kind !== 'workflow'
          && !!harnessSession?.loadInterruptState();

        if (!shouldResume) {
          const result = approvalRegistry.resolve(id, auditResolution, 'desktop-tasks-board');
          if (!result.ok) {
            res.status(409).json({ ok: false, reason: result.reason ?? 'could not resolve approval', approval: result.row });
            return;
          }
          res.json({
            ok: true,
            approval: result.row,
            status: sessionRowForKind?.kind === 'workflow' ? 'resolved-workflow-runner-resumes' : 'resolved-stale',
            message: `${approved ? 'Approved' : 'Rejected'} ${id}.`,
          });
          return;
        }

        const auth = await configureHarnessRuntime();
        if (!auth.ok) { res.status(412).json({ ok: false, reason: auth.reason }); return; }

        const result = approvalRegistry.resolve(id, auditResolution, 'desktop-tasks-board');
        if (!result.ok) {
          res.status(409).json({ ok: false, reason: result.reason ?? 'could not resolve approval', approval: result.row });
          return;
        }

        const sessionId = existing.sessionId;
        res.status(202).json({
          ok: true,
          approval: result.row,
          sessionId,
          streamUrl: `/api/sessions/${sessionId}/events`,
          status: 'resuming',
          message: `${approved ? 'Approved' : 'Rejected'} ${id}; resuming the run.`,
        });

        setImmediate(async () => {
          try {
            const agent = await buildOrchestratorAgent({ sessionId });
            await runConversationFromResume({
              agent,
              sessionId,
              decision,
              resolver: 'desktop-tasks-board',
            });
          } catch (err) {
            try {
              appendHarnessEvent({
                sessionId,
                turn: 0,
                role: 'system',
                type: 'run_failed',
                data: {
                  error: err instanceof Error ? err.message : String(err),
                  stage: 'tasks_board_approval_resume',
                },
              });
            } catch { /* best effort */ }
          }
        });
        return;
      }

      const result = await assistant.getRuntime().resolveApproval(id, approved);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/board/workflow/:name/runs/:runId/retry-failed-items', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ ok: false, reason: 'workflow not found' }); return; }
    const runId = req.params.runId;
    const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ ok: false, reason: 'workflow run not found' });
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      if (raw.workflow !== entry.data.name && raw.workflow !== entry.name) {
        res.status(404).json({ ok: false, reason: 'workflow run does not belong to this workflow' });
        return;
      }
      const stepIds = Array.from(new Set(listFinalFailedItems(entry.name, runId).map((item) => item.stepId)));
      const stepId = typeof req.body?.stepId === 'string' && req.body.stepId.trim()
        ? req.body.stepId.trim()
        : stepIds.length === 1 ? stepIds[0] : undefined;
      const result = requeueWorkflowFailedItemsFromRun(runId, {
        stepId,
        source: 'board',
        recoveryIntent: workflowRunRecoveryIntentFromBody(req.body, {
          kind: 'failed_items',
          sourceRunId: runId,
          sourceStepId: stepId,
          requestedFrom: 'board',
          reason: 'retry final failed forEach items',
        }),
      });
      res.status(result.status === 'blocked_readiness' ? 409 : 200).json({
        ok: result.status === 'queued' || result.status === 'duplicate',
        status: result.status,
        id: result.id,
        message: result.message,
        failedItems: result.failedItems ?? [],
        ...(result.status === 'blocked_readiness' ? workflowReadinessBlockedBody(result.message, result.readiness) : {}),
      });
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/board/workflow/:name/runs/:runId/resume-safe', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const target = req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ ok: false, reason: 'workflow not found' }); return; }
    const runId = req.params.runId;
    const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ ok: false, reason: 'workflow run not found' });
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      if (raw.workflow !== entry.data.name && raw.workflow !== entry.name) {
        res.status(404).json({ ok: false, reason: 'workflow run does not belong to this workflow' });
        return;
      }
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    const failedItems = listFinalFailedItems(entry.name, runId);
    if (failedItems.length > 0) {
      res.status(409).json({
        ok: false,
        reason: 'This run has failed forEach items; retry failed items only to avoid duplicating successful work.',
        failedItems,
      });
      return;
    }
    const sourceStepId = typeof req.body?.stepId === 'string' && req.body.stepId.trim()
      ? req.body.stepId.trim()
      : undefined;
    const result = requeueWorkflowFromRun(runId, {
      source: 'board',
      recoveryIntent: workflowRunRecoveryIntentFromBody(req.body, {
        kind: 'safe_rerun',
        sourceRunId: runId,
        sourceStepId,
        requestedFrom: 'board',
        reason: 'safe whole-run rerun',
      }),
    });
    res.status(result.status === 'not_found' ? 404 : result.status === 'blocked_readiness' ? 409 : 200).json({
      ok: result.status === 'queued' || result.status === 'duplicate',
      status: result.status,
      id: result.id,
      message: result.message,
      ...(result.status === 'blocked_readiness' ? workflowReadinessBlockedBody(result.message, result.readiness) : {}),
    });
  });

  /**
   * v0.5.11 — Bulk cancel stale approvals (>1h old). Used by the
   * Approvals panel "CANCEL ALL STALE" button. Marks each row
   * `status='cancelled'` with resolution='cancelled_by_user'. Does NOT
   * touch the underlying workflow sessions — those are independently
   * reapable. The orchestrator that requested each approval will see
   * the cancellation on its next pump and either retry or fail
   * gracefully (per the runtime's resolveApproval contract).
   */
  app.post('/api/console/approvals/cancel-stale', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { listPending, resolve: resolveApprovalRow } = await import('../runtime/harness/approval-registry.js');
      const rows = listPending({ status: 'pending' });
      const cutoff = Date.now() - 60 * 60_000;
      const stale = rows.filter((r) => {
        const t = Date.parse(r.requestedAt);
        return Number.isFinite(t) && t < cutoff;
      });
      let cancelled = 0;
      for (const row of stale) {
        try {
          const result = resolveApprovalRow(
            row.approvalId,
            'cancelled_by_user',
            'dashboard:bulk-cancel-stale',
          );
          if (result.ok) cancelled += 1;
        } catch {
          // Best-effort — one row failing must not block the rest.
        }
      }
      res.json({ cancelled, total: stale.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/harness-approvals/:id/:decision', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = req.params.id;
    const decisionParam = req.params.decision;
    if (decisionParam !== 'approve' && decisionParam !== 'reject' && decisionParam !== 'approve_with_edits') {
      res.status(400).json({ error: 'decision must be approve, reject, or approve_with_edits' });
      return;
    }
    const decision: 'approve' | 'reject' | 'approve_with_edits' = decisionParam;
    // For approve_with_edits, the body carries the user's edited args
    // (JSON-encoded string in `modifiedArgs`). Used by the dashboard
    // EDIT button and Discord edit modal to substitute the tool's args
    // before the SDK approves.
    const modifiedArgs = decision === 'approve_with_edits'
      ? (typeof (req.body as { modifiedArgs?: unknown })?.modifiedArgs === 'string'
          ? (req.body as { modifiedArgs: string }).modifiedArgs
          : undefined)
      : undefined;
    if (decision === 'approve_with_edits' && !modifiedArgs) {
      res.status(400).json({ error: 'approve_with_edits requires modifiedArgs in body (JSON string)' });
      return;
    }
    const existing = approvalRegistry.get(id);
    if (!existing) {
      res.status(404).json({ error: 'approval not found' });
      return;
    }
    if (existing.status !== 'pending') {
      res.status(409).json({ error: 'approval already resolved', approval: existing });
      return;
    }

    // Map any approve-shaped decision to the audit-log "approved"
    // resolution. The `approve_with_edits` flavor still resolves the
    // approval row as approved — the edits are an in-flight
    // substitution, not a separate trust state.
    const auditResolution = decision === 'reject' ? 'rejected' : 'approved';

    const harnessSession = HarnessSession.load(existing.sessionId);
    // Workflow sessions must NOT be resumed from here: their RunState was
    // serialized under the WorkflowStep agent (+ step tool locks), which
    // buildOrchestratorAgent cannot deserialize — RunState.fromString throws
    // "Agent WorkflowStep not found", marks the session failed, and CLEARS the
    // interrupt state the workflow runner needed. The runner owns workflow
    // resumes (reapResolvedParkedRuns / its in-place approval poll rebuilds
    // the correct agent); resolving the approval row here is sufficient.
    const sessionRowForKind = getHarnessSession(existing.sessionId);
    const shouldResume = sessionRowForKind?.kind !== 'workflow'
      && !!harnessSession?.loadInterruptState();
    if (!shouldResume) {
      const result = approvalRegistry.resolve(
        id,
        auditResolution,
        'desktop-command-center',
      );
      if (!result.ok) {
        res.status(409).json({ error: result.reason ?? 'could not resolve approval', approval: result.row });
        return;
      }
      res.json({
        ok: true,
        approval: result.row,
        message: `Approval ${decision === 'reject' ? 'rejected' : (decision === 'approve_with_edits' ? 'approved with edits' : 'approved')}: ${id}`,
        status: sessionRowForKind?.kind === 'workflow' ? 'resolved-workflow-runner-resumes' : 'resolved-stale',
      });
      return;
    }

    const auth = await configureHarnessRuntime();
    if (!auth.ok) { res.status(412).json({ error: auth.reason }); return; }

    const sessionId = existing.sessionId;
    const result = approvalRegistry.resolve(id, auditResolution, 'desktop-command-center');
    if (!result.ok) {
      res.status(409).json({ error: result.reason ?? 'could not resolve approval', approval: result.row });
      return;
    }

    res.status(202).json({
      ok: true,
      approval: result.row,
      sessionId,
      streamUrl: `/api/sessions/${sessionId}/events`,
      status: 'resuming',
      message: `Approval ${decision === 'reject' ? 'rejected' : (decision === 'approve_with_edits' ? 'approved with edits' : 'approved')}: ${id}`,
    });

    setImmediate(async () => {
      try {
        const agent = await buildOrchestratorAgent({ sessionId });
        // v0.5.19 Bug A fix — sticky-approval auto-resume.
        // After the initial resume, the resumed turn may itself trigger
        // a fresh approval pause (e.g. a composio_execute_tool inside the
        // same logical workflow). Previously we resolved those new
        // pending approvals here but never re-entered the runtime,
        // leaving the session paused with all approvals resolved — a
        // state inconsistency that needed a "/continue" nudge to escape.
        // Now: loop resume → auto-resolve → resume until either no new
        // pending approvals remain OR we hit a safety cap of 5 iterations
        // (defense-in-depth against pathological prompts that approve
        // unboundedly). Each iteration's auto-resolve uses the same
        // decision the user originally chose for the first approval —
        // that's the "sticky" semantic the audit event already records.
        const MAX_STICKY_RESUMES = 5;
        let resumeIter = 0;
        // First resume always runs with the user's decision + modifiedArgs.
        let currentDecision = decision;
        let currentModifiedArgs = modifiedArgs;
        while (resumeIter < MAX_STICKY_RESUMES) {
          resumeIter += 1;
          await runConversationFromResume({
            agent,
            sessionId,
            decision: currentDecision,
            modifiedArgs: currentModifiedArgs,
            resolver: 'desktop-command-center',
          });
          const pending = approvalRegistry.listPending({ sessionId, status: 'pending' });
          if (pending.length === 0) break;
          // Auto-resolve new pending approvals using the same audit
          // resolution as the user's original choice, then loop to
          // re-enter the runtime. After the first auto-resume,
          // modifiedArgs no longer applies (the edit was a one-shot for
          // the specific call the user reviewed).
          for (const row of pending) {
            approvalRegistry.resolve(row.approvalId, auditResolution, 'desktop-command-center');
          }
          currentDecision = decision === 'approve_with_edits' ? 'approve' : decision;
          currentModifiedArgs = undefined;
        }
        if (resumeIter === MAX_STICKY_RESUMES) {
          try {
            appendHarnessEvent({
              sessionId,
              turn: 0,
              role: 'system',
              type: 'run_failed',
              data: {
                error: `Sticky-resume safety cap (${MAX_STICKY_RESUMES}) reached — agent kept creating new approvals every turn`,
                stage: 'sticky_resume_cap',
                resumeIter,
              },
            });
          } catch {
            // best effort
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          appendHarnessEvent({
            sessionId,
            turn: 0,
            role: 'system',
            type: 'run_failed',
            data: { error: message, stage: 'approval_resume' },
          });
        } catch {
          // best effort
        }
      }
    });
  });

  // ─── Home panel ────────────────────────────────────────────────

  /**
   * Dismiss a "Needs you" card the user doesn't want to act on. Routes to
   * the owning store: check-ins close (audit reason), plan proposals
   * supersede (no negative-feedback signal), check-in template proposals
   * reject. Approvals are deliberately NOT dismissable — decide those.
   */
  app.post('/api/console/inbox/dismiss', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
    const id = typeof req.body?.id === 'string' ? req.body.id.slice(0, 120) : '';
    if (!id) { res.status(400).json({ error: 'id required' }); return; }
    try {
      if (kind === 'checkin') {
        const closed = closeCheckIn(id, 'Dismissed by user from the inbox.');
        res.json({ ok: Boolean(closed), kind, id });
        return;
      }
      if (kind === 'plan') {
        const superseded = supersedePlanProposal(id, 'dismissed from inbox');
        res.json({ ok: Boolean(superseded), kind, id });
        return;
      }
      if (kind === 'proposal') {
        const rejected = rejectProposal(id, 'Dismissed from inbox.');
        res.json({ ok: Boolean(rejected), kind, id });
        return;
      }
      if (kind === 'notif') {
        // "Needs you" cards backed by a needs-attention notification dismiss
        // by marking the notification read — the command-center feed only
        // surfaces unread ones, so the card disappears everywhere at once.
        // Group-read: the feed dedupes by title/workflow, so the twins
        // behind the surfaced card must clear too or they pop right back.
        const marked = markNotificationGroupRead(id);
        res.json({ ok: marked.length > 0, kind, id, cleared: marked.length });
        return;
      }
      res.status(400).json({ error: `kind "${kind}" is not dismissable` });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/home/command-center', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const memory = readMemoryIndexStatus();
      const runs = listRuns(50);
      const approvals = assistant.getRuntime().listPendingApprovals();
      const harnessApprovals = approvalRegistry.listPending({ status: 'pending' });
      const planProposals = listPlanProposals({ status: 'pending', limit: 20 });
      const checkInProposals = listProposals({ status: 'pending', limit: 20 });
      const openCheckIns = listOpenCheckIns();
      // For WORKING NOW we only want executions the daemon is RUNNING
      // right now. Blocked/paused are stalled — they show in Activity.
      const executions = new ExecutionStore().list(60)
        .filter((execution) => execution.status === 'active');
      const backgroundTasks = listBackgroundTasks().slice(0, 60);
      const pendingApprovalIds = new Set<string>([
        ...approvals.map((approval) => approval.id),
        ...harnessApprovals.map((approval) => approval.approvalId),
      ]);
      try {
        markStaleApprovalNotificationsRead(pendingApprovalIds, {
          approvalStatus: 'not_pending',
          reconciledBy: 'command-center',
        });
      } catch {
        // Best-effort dashboard cleanup. The live approval stores above
        // remain the source of truth for actionable decisions.
      }
      const activeBackgroundTasks = backgroundTasks.filter((task) => {
        if (task.status === 'awaiting_approval') {
          return task.pendingApprovalId ? pendingApprovalIds.has(task.pendingApprovalId) : true;
        }
        // WORKING NOW = genuinely active only. 'interrupted' tasks are
        // stalled (often zombie tasks from a daemon restart) — they were
        // cluttering Home as fake active work; they remain visible in
        // Activity for resume/clear.
        return task.status === 'pending' || task.status === 'running';
      });
      const backgroundTaskByApprovalId = new Map(
        backgroundTasks
          .filter((task) => task.pendingApprovalId)
          .map((task) => [task.pendingApprovalId as string, task]),
      );
      const credentialHealth = await (await getSecretStore()).health({ passive: true });
      const runtimeAuth = getAuthStatus();
      const policy = getProactivityPolicySnapshot();
      const pendingWorkflowRuns = listPendingRuns();
      const recentHarnessSessions = listHarnessSessions({ limit: 60 }).filter(isConsoleVisibleHarnessSession);
      // Chat sessions stay status='active' BETWEEN turns (see
      // project_session_status_semantics memory: that's what session
      // 'active' actually means — open + addressable, not necessarily
      // executing). For WORKING NOW we want only sessions the daemon
      // is mid-turn on RIGHT NOW. Heuristic: status='active' AND last
      // event within the last 60s (covers an LLM turn + a slow tool
      // call). Idle sessions, even if 'active', live in Activity for
      // resume/clear actions.
      const activeWindowMs = 60_000;
      const activeWindowCutoff = Date.now() - activeWindowMs;
      const activeHarnessSessions = recentHarnessSessions.filter((session) =>
        isHarnessSessionCurrentlyWorking(session, activeWindowCutoff),
      );

      // Uncapped per-source (was sliced) — the NEEDS YOU header count
      // (counts.waiting = needsYou.length) is computed from this array,
      // so capping silently dropped items and the header understated
      // what's actually pending. (Observed 2026-05-23 alongside the
      // approvals-panel/home mismatch.) Outer slice removed too.
      const needsYou = [
        ...approvals.map((approval) => {
          const args = extractRuntimeApprovalArgs(approval);
          const task = backgroundTaskByApprovalId.get(approval.id);
          const summary = approvalSummaryFromArgs(args, summarizeApprovalAction(approval));
          const reason = approvalReasonFromArgs(args);
          const preview = normalizeApprovalPreview(args?.preview);
          const previewMeta = typeof preview?.count === 'number' ? `${preview.count} item${preview.count === 1 ? '' : 's'}` : '';
          return {
            kind: task ? 'background-approval' : 'approval',
            title: `Approve: ${summary}`,
            meta: [
              task ? `background ${task.id}` : approval.toolName,
              reason ? `why: ${trimConsoleTitle(reason, 90)}` : '',
              previewMeta,
            ].filter(Boolean).join(' · ') || `${approval.sessionId || approval.id}`,
            panel: 'approvals',
            urgency: 'high',
            approvalKind: 'runtime',
            approvalId: approval.id,
          };
        }),
        ...harnessApprovals.map((approval) => {
          const reason = approvalReasonFromArgs(approval.args ?? undefined);
          const preview = normalizeApprovalPreview(approval.args?.preview);
          const previewMeta = typeof preview?.count === 'number' ? `${preview.count} item${preview.count === 1 ? '' : 's'}` : '';
          return {
            kind: 'harness-approval',
            title: `Approve: ${approvalSummaryFromArgs(approval.args ?? undefined, approval.subject)}`,
            meta: [
              approval.approvalId,
              approval.tool || approval.sessionId,
              reason ? `why: ${trimConsoleTitle(reason, 90)}` : '',
              previewMeta,
            ].filter(Boolean).join(' · '),
            panel: 'approvals',
            urgency: 'high',
            approvalKind: 'harness',
            approvalId: approval.approvalId,
            // Drill-target: when the user clicks this NEEDS YOU item body,
            // the dashboard switches to Activity AND loads the inspector
            // for this exact session. Without this attribute the user
            // landed on Activity showing "everything" with no anchor to
            // the specific approval that brought them here (the visibility
            // gap Nathan flagged 2026-05-21).
            targetSessionId: approval.sessionId,
            // Pass the tool name + args so the EDIT button can render a
            // pre-filled textarea. For composio_execute_tool we surface
            // the INNER args JSON (the actual tool payload).
            approvalTool: approval.tool,
            approvalArgs: approval.tool === 'composio_execute_tool'
              && approval.args
              && typeof (approval.args as { arguments?: unknown }).arguments === 'string'
              ? (approval.args as { arguments: string }).arguments
              : (approval.args ? JSON.stringify(approval.args, null, 2) : ''),
          };
        }),
        ...planProposals.map((proposal) => ({
          kind: 'plan',
          title: proposal.plan?.objective || proposal.originatingRequest || proposal.id,
          meta: `plan ${proposal.id}`,
          panel: 'settings',
          urgency: 'high',
          dismissKind: 'plan',
          dismissId: proposal.id,
        })),
        ...checkInProposals.map((proposal) => ({
          kind: 'proposal',
          title: proposal.name || proposal.description || proposal.id,
          meta: 'check-in proposal',
          panel: 'settings',
          urgency: 'normal',
          dismissKind: 'proposal',
          dismissId: proposal.id,
        })),
        ...openCheckIns.map((checkIn) => ({
          kind: 'checkin',
          title: checkIn.question || '(check-in)',
          meta: checkIn.urgency !== 'normal' ? `${checkIn.urgency} · ${checkIn.askedAt.slice(11, 16)}` : `asked ${checkIn.askedAt.slice(11, 16)}`,
          panel: 'settings',
          urgency: checkIn.urgency === 'high' ? 'high' : 'normal',
          dismissKind: 'checkin',
          dismissId: checkIn.id,
        })),
        ...activeBackgroundTasks.filter((task) => task.status === 'awaiting_approval' && !task.pendingApprovalId).map((task) => ({
          kind: 'background',
          title: task.title,
          meta: task.id,
          panel: 'approvals',
          urgency: 'high',
        })),
      ].map((item) => ({
        ...item,
        title: trimConsoleTitle(stripConsoleIds(item.title), 140),
        meta: trimConsoleTitle(stripConsoleIds((item as { meta?: string }).meta || ''), 100),
      }));

      // WORKING NOW shows anything the daemon has accepted as active
      // or queued work. A plan-approved background task can sit
      // pending for one daemon tick before it starts; hiding that made
      // the chat say "queued" while Home looked empty.
      const workingNow = [
        ...activeBackgroundTasks.map((task) => {
          const runtimeApproval = task.pendingApprovalId
            ? approvals.find((approval) => approval.id === task.pendingApprovalId)
            : undefined;
          const args = runtimeApproval ? extractRuntimeApprovalArgs(runtimeApproval) : undefined;
          const summary = runtimeApproval
            ? approvalSummaryFromArgs(args, summarizeApprovalAction(runtimeApproval))
            : task.title;
          // Clean meta: a short check-in line (ids stripped) or a relative
          // age — never the raw bg-… id.
          const checkin = task.lastCheckInMessage ? stripConsoleIds(task.lastCheckInMessage) : '';
          const age = relAge(task.lastCheckInAt || task.startedAt || task.updatedAt);
          return {
            kind: task.status === 'pending' ? 'queued' : task.status,
            title: task.status === 'awaiting_approval'
              ? `Waiting for approval: ${stripConsoleIds(summary)}`
              : stripConsoleIds(task.title),
            meta: checkin || age || (task.status === 'pending' ? 'queued' : 'running'),
            panel: task.status === 'awaiting_approval' ? 'approvals' : 'activity',
            approvalKind: runtimeApproval ? 'runtime' : undefined,
            approvalId: runtimeApproval?.id,
          };
        }),
        ...pendingWorkflowRuns.filter((run) => {
          // Drop stale "in-flight" runs — the daemon keeps trying to resume
          // runs that stalled days ago; those are not "working now". Keep a
          // run only if it has progressed within the last 2 hours (or has
          // no event yet — freshly queued).
          if (!run.lastEventAt) return true;
          const t = Date.parse(run.lastEventAt);
          return Number.isFinite(t) && (Date.now() - t) < 2 * 60 * 60 * 1000;
        }).map((run) => {
          const workflow = readWorkflow(run.workflowName);
          const title = workflow?.data?.name ?? run.workflowName;
          return {
            kind: 'workflow',
            title: run.inFlightStepId ? `${title} · ${run.inFlightStepId.replace(/_/g, ' ')}` : title,
            meta: run.lastEventAt ? relAge(run.lastEventAt) || 'running' : 'running',
            panel: 'workflows',
            actionKind: 'workflow-run',
            workflowName: run.workflowName,
            runId: run.runId,
          };
        }),
        ...executions.map((execution) => ({
          kind: execution.status,
          title: execution.title || execution.objective || '(execution)',
          meta: execution.nextStep ? `next: ${execution.nextStep}` : execution.status,
          panel: 'activity',
        })),
        ...activeHarnessSessions.map((session) => ({
          kind: isDiscordHarnessSession(session) ? 'discord' : session.kind,
          title: session.title || session.objective || (isDiscordHarnessSession(session) ? 'Discord conversation' : 'Clementine run'),
          meta: `${harnessSessionSourceLabel(session)} · ${session.status} · ${session.updatedAt.slice(11, 16)}`,
          panel: 'activity',
          actionKind: 'harness-session',
          sessionId: session.id,
        })),
      ].map((item) => ({ ...item, title: trimConsoleTitle(item.title, 140), meta: trimConsoleTitle(item.meta || '', 100) }));

      const recentCompleted = [
        ...backgroundTasks.filter((task) => task.status === 'done').slice(0, 5).map((task) => ({
          kind: 'done',
          title: stripConsoleIds(task.title),
          meta: task.result
            ? stripConsoleIds(trimConsoleTitle(task.result.replace(/^#+\s*/gm, '').split('\n').find((line) => line.trim() && !line.includes('/Users/')) || task.result, 120))
            : relAge(task.completedAt) || 'done',
          panel: 'activity',
          actionKind: 'background-task',
          taskId: task.id,
        })),
        ...runs.filter((run) => run.status === 'completed').slice(0, 5).map((run) => ({
          kind: 'done',
          title: stripConsoleIds(run.title || run.input || 'Completed run'),
          meta: relAge(run.completedAt) || 'done',
          panel: 'activity',
          targetRunId: run.id,
        })),
        ...recentHarnessSessions.filter((session) => session.status === 'completed').slice(0, 5).map((session) => ({
          kind: 'done',
          title: session.title || session.objective || 'Clementine conversation',
          meta: `${harnessSessionSourceLabel(session)} done ${session.updatedAt.slice(11, 16)}`,
          panel: 'activity',
          targetSessionId: session.id,
        })),
      ].slice(0, 6).map((item) => ({ ...item, title: trimConsoleTitle(item.title, 120), meta: trimConsoleTitle(item.meta || '', 100) }));

      // ── Inbox feed from the notifications store ──────────────────────────
      // The notifications store is the canonical log of everything Clem has
      // REPORTED BACK: workflow/task completions, notify_user reports, blocked
      // runs, and system alerts. The task/exec/run sources above MISS scheduled
      // workflow report-backs (e.g. the hourly Outlook triage), so completed
      // work was silently absent from Home. Fold the store in here. Drop
      // lifecycle noise: silent records + "still running" heartbeats. (This is
      // the first slice of the unified inbox; the full panel + read/unread +
      // not-delivered backstop builds on this same feed.)
      const rawNotifs = listNotifications(300);
      const inboxNotifs = rawNotifs.filter(
        (notification) => !notification.silent && notification.metadata?.heartbeat !== true,
      );
      const notifFirstLine = (body: string): string =>
        (body || '')
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('#') && !/^[{}\[\]\-=*`>|"',:]+$/.test(line)) || '';
      // Shared with markNotificationGroupRead so dismiss clears exactly the
      // set of notifications this feed would surface.
      const isNeedsAttentionNotif = isNeedsAttentionNotification;
      // Collapse the generic "Workflow completed/needs attention: <name>"
      // echo when a richer notify_user report already covers the same run —
      // otherwise every run double-reports (the clutter the inbox must avoid).
      const reportedRunIds = new Set(
        inboxNotifs
          .filter((notification) => notification.metadata?.source === 'notify_user_tool')
          .map((notification) => String(notification.metadata?.workflowRunId || notification.metadata?.runId || ''))
          .filter(Boolean),
      );
      const isGenericWorkflowEcho = (notification: { title: string; metadata?: Record<string, unknown> }): boolean =>
        notification.metadata?.source !== 'notify_user_tool' &&
        /workflow (completed|needs attention|still running)/i.test(notification.title) &&
        reportedRunIds.has(String(notification.metadata?.runId || notification.metadata?.workflowRunId || ''));
      const dedupeByTitle = <T extends { title: string }>(items: T[], cap: number): T[] => {
        const seen = new Set<string>();
        const out: T[] = [];
        for (const item of items) {
          const key = (item.title || '').toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(item);
          if (out.length >= cap) break;
        }
        return out;
      };
      // Collapse one ITEM PER WORKFLOW (latest state), across both the
      // generic "Workflow …" echoes and the richer notify_user reports.
      // Build runId → workflow from notifications that carry both, so a
      // notify_user report (which lacks a workflow field) can still be keyed
      // to its workflow and deduped against that workflow's other rows.
      const runIdToWorkflow = new Map<string, string>();
      for (const notification of rawNotifs) {
        const runId = String(notification.metadata?.runId || notification.metadata?.workflowRunId || '');
        const workflowName = typeof notification.metadata?.workflow === 'string' ? notification.metadata.workflow : '';
        if (runId && workflowName) runIdToWorkflow.set(runId, workflowName);
      }
      const workflowKeyOf = (notification: { metadata?: Record<string, unknown> }): string => {
        const workflowName = typeof notification.metadata?.workflow === 'string' ? notification.metadata.workflow : '';
        if (workflowName) return 'wf:' + workflowName.toLowerCase();
        const runId = String(notification.metadata?.workflowRunId || notification.metadata?.runId || '');
        const mapped = runId ? runIdToWorkflow.get(runId) : '';
        return mapped ? 'wf:' + mapped.toLowerCase() : '';
      };
      const isReportNotif = (notification: { metadata?: Record<string, unknown> }): boolean =>
        notification.metadata?.source === 'notify_user_tool';
      // Keep one per workflow: richest report first, then newest. Items with
      // no workflow association fall back to title dedup. Restore newest-first
      // order for display.
      const dedupeByWorkflow = <T extends { title: string; createdAt: string; metadata?: Record<string, unknown> }>(items: T[], cap: number): T[] => {
        const ordered = [...items].sort((a, b) => {
          const ra = isReportNotif(a) ? 1 : 0;
          const rb = isReportNotif(b) ? 1 : 0;
          if (ra !== rb) return rb - ra;
          return b.createdAt.localeCompare(a.createdAt);
        });
        const seenWorkflow = new Set<string>();
        const seenTitle = new Set<string>();
        const out: T[] = [];
        for (const notification of ordered) {
          const workflowKey = workflowKeyOf(notification);
          const titleKey = notification.title.toLowerCase().trim();
          // Collapse if EITHER the workflow OR the exact title was already
          // seen — handles the dual-notification styles (generic echo vs
          // notify_user report) and repeated same-title runs in one pass.
          if ((workflowKey && seenWorkflow.has(workflowKey)) || seenTitle.has(titleKey)) continue;
          if (workflowKey) seenWorkflow.add(workflowKey);
          seenTitle.add(titleKey);
          out.push(notification);
          if (out.length >= cap) break;
        }
        return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      };
      const notifNeedsYou = dedupeByWorkflow(
        // Unread only: a read needs-attention notification is one the user
        // has already seen/dismissed — leaving it here made stale "Workflow
        // needs attention" cards immortal on Home (clicking led to an empty
        // approvals tab; observed 2026-06-11).
        inboxNotifs.filter((notification) => !notification.read && isNeedsAttentionNotif(notification) && !isGenericWorkflowEcho(notification)),
        6,
      ).map((notification) => ({
        kind: 'workflow',
        title: trimConsoleTitle(stripConsoleIds(notification.title.replace(/^[⚠️️\s]+/, '')), 140),
        meta: trimConsoleTitle([notification.createdAt.slice(11, 16), notifFirstLine(notification.body)].filter(Boolean).join(' · '), 100),
        panel: 'activity',
        urgency: 'high',
        notifId: notification.id,
        body: (notification.body || '').slice(0, 4000),
        createdAt: notification.createdAt,
        runId: String(notification.metadata?.workflowRunId || notification.metadata?.runId || ''),
        // Dismiss (X) marks the notification read via /api/console/inbox/dismiss.
        dismissKind: 'notif',
        dismissId: notification.id,
      }));
      const notifRecent = dedupeByWorkflow(
        inboxNotifs.filter((notification) => !isNeedsAttentionNotif(notification) && !isGenericWorkflowEcho(notification)),
        12,
      ).map((notification) => {
        const undelivered = !notification.deliveredAt && (Boolean(notification.deliveryError) || (notification.deliveryAttempts || 0) > 0);
        return {
          kind: undelivered ? 'exec' : 'done',
          title: trimConsoleTitle(stripConsoleIds(notification.title.replace(/^[✓✅\s]+/, '')), 120),
          meta: trimConsoleTitle([notification.createdAt.slice(11, 16), undelivered ? 'NOT DELIVERED' : '', notifFirstLine(notification.body)].filter(Boolean).join(' · '), 120),
          panel: 'activity',
          notifId: notification.id,
          read: notification.read,
          body: (notification.body || '').slice(0, 4000),
          createdAt: notification.createdAt,
          runId: String(notification.metadata?.workflowRunId || notification.metadata?.runId || ''),
          notDelivered: undelivered,
        };
      });
      // Notifications LEAD (they hold the real report-backs), then the
      // task/exec/run completions; deduped by title, capped for the rail.
      const recentMerged = dedupeByTitle([...notifRecent, ...recentCompleted], 8);
      const needsYouMerged = [...needsYou, ...notifNeedsYou];

      const credentialRows = credentialHealth
        .filter((row) => ['openai_api_key', 'discord_bot_token', 'composio_api_key', 'recall_api_key', 'browser_use_api_key', 'codex_oauth_access_token', 'codex_oauth_refresh_token'].includes(row.name))
        .map((row) => ({
          name: row.name,
          label: row.name === 'openai_api_key' ? 'OpenAI API'
            : row.name === 'discord_bot_token' ? 'Discord'
              : row.name === 'composio_api_key' ? 'Composio'
                : row.name === 'recall_api_key' ? 'Recall'
                  : row.name === 'browser_use_api_key' ? 'Browser Use'
                    : row.name === 'codex_oauth_access_token' ? 'Codex access'
                      : 'Codex refresh',
          status: row.status,
          hasValue: row.hasValue,
          required: listSecretDescriptors().find((descriptor) => descriptor.name === row.name)?.required ?? false,
          source: row.source,
          driftDetected: row.driftDetected,
        }));
      const requiredMissing = credentialHealth.filter((row) => {
        const descriptor = listSecretDescriptors().find((item) => item.name === row.name);
        return descriptor?.required && !row.hasValue;
      }).length;
      const connectedCredentialCount = credentialRows.filter((row) => row.hasValue).length;
      const memoryWarnings = [
        memory.dbPresent ? '' : 'memory db missing',
        memory.embeddingsEnabled && memory.embeddingsCoverage < 0.99 ? 'embedding backfill incomplete' : '',
        memory.activeFacts === 0 ? 'no durable facts yet' : '',
      ].filter(Boolean);

      // counts.active mirrors the WORKING NOW list scope exactly: chat
      // sessions + workflow runs/executions only. Background tasks and
      // legacy channel runs have their own surfaces.
      const activeCount = workingNow.length;
      const waitingCount = needsYouMerged.length;
      const currentObjective = workingNow[0]?.title
        ?? needsYouMerged[0]?.title
        ?? (memoryWarnings.length ? 'Memory needs attention before the graph is fully trustworthy.' : 'Standing by for the next useful task.');

      res.json({
        presence: {
          status: waitingCount > 0 ? 'needs_you' : activeCount > 0 ? 'working' : 'online',
          label: waitingCount > 0 ? 'needs you' : activeCount > 0 ? 'working' : 'online',
          awayMessage: currentObjective,
          mode: policy.policy.mode,
          autoApproveScope: policy.policy.autoApproveScope,
        },
        counts: {
          active: activeCount,
          waiting: waitingCount,
          approvals: approvals.length + harnessApprovals.length,
          harnessApprovals: harnessApprovals.length,
          planProposals: planProposals.length,
          checkInProposals: checkInProposals.length,
          checkIns: openCheckIns.length,
          runningRuns: runs.filter((run) => run.status === 'running' || run.status === 'received').length,
          runningWorkflows: pendingWorkflowRuns.length,
          backgroundActive: activeBackgroundTasks.length,
          requiredSetupMissing: requiredMissing,
        },
        needsYou: needsYouMerged,
        workingNow,
        recentCompleted: recentMerged,
        memory: {
          chunks: memory.chunks,
          indexedFiles: memory.indexedFiles,
          activeFacts: memory.activeFacts,
          totalFacts: memory.totalFacts,
          embeddingsEnabled: memory.embeddingsEnabled,
          embeddingsCoverage: memory.embeddingsCoverage,
          warnings: memoryWarnings,
        },
        integrations: {
          connected: connectedCredentialCount,
          total: credentialRows.length,
          requiredMissing,
          runtimeAuth,
          credentials: credentialRows,
        },
        // Current Focus snapshot — the working-memory attention pointer
        // (separate from goals + facts). Tile + header chip read from
        // here. Snapshot is cheap (one indexed SQL read).
        focus: (() => {
          try {
            const snap = getFocusSnapshot();
            return {
              active: snap.active,
              parked: snap.parked,
              parkedCount: snap.parked.length,
              needsConfirm: snap.needsConfirm,
            };
          } catch {
            return null;
          }
        })(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Current Focus endpoints — used by the Home tile and the focus
  // chip in the header to view + manage the active focus.
  app.get('/api/console/focus', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const snap = getFocusSnapshot();
      res.json({
        active: snap.active,
        parked: snap.parked,
        needsConfirm: snap.needsConfirm,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/focus/:id/park', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'paused from dashboard';
    const row = parkFocusRow(id, reason);
    if (!row) { res.status(404).json({ error: 'focus not found' }); return; }
    res.json({ focus: row });
  });

  app.post('/api/console/focus/:id/activate', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    const row = activateFocusRow(id);
    if (!row) { res.status(404).json({ error: 'focus not found or not parked' }); return; }
    res.json({ focus: row });
  });

  app.post('/api/console/focus/:id/clear', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    const resolution = req.body?.resolution === 'abandoned' ? 'abandoned' as const : 'completed' as const;
    const row = clearFocusRow(id, resolution);
    if (!row) { res.status(404).json({ error: 'focus not found' }); return; }
    res.json({ focus: row });
  });

  /**
   * Today's agenda + completed-today, aggregated across the most useful
   * surfaces for a single "what's the shape of today" view:
   *   - pending tasks (TASKS.md)
   *   - active executions (in_progress)
   *   - open check-ins waiting on the user
   *   - completed today: tasks marked done, executions completed,
   *     runs that finished today.
   */
  app.get('/api/console/home/agenda', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const today = new Date().toISOString().slice(0, 10);
      const agenda: Array<{ kind: string; title: string; meta?: string; sortKey: number }> = [];
      const done: Array<{ kind: string; title: string; meta?: string; sortKey: number }> = [];

      /**
       * Tasks/executions created by autonomy agents often:
       *   - reference T-IDs ("T-019", "T-022")
       *   - start with "You are the X agent" (instruction dumps)
       *   - say "Cron job:" (scheduled-run executions)
       *   - are very long (>180 chars)
       * These are real commitments but not what the user wants on home.
       * Score them lower so user-flavored items float up. We don't drop
       * them entirely — just push them to the "view all" tail.
       */
      function looksAgentTracked(text: string): boolean {
        if (!text) return true; // empty descriptions are noise
        // Markdown leaks from headers / bold lines that parsed as tasks.
        if (/^\*\*/.test(text)) return true;
        if (/^You are (the|operating as)\b/.test(text)) return true;
        if (/^Cron job:/.test(text)) return true;
        if (/Execution source:\s*schedule/i.test(text)) return true;
        // The autonomy loop uses these verbs for its tracking
        // commitments — they aren't language a user types.
        // Past-tense agent-commitment verbs — these are how the
        // autonomy loop logs what it did, not how a user writes a task.
        if (/^(Reasserted|Reconfirmed|Confirmed|Re-pushed|Repushed|Re-escalated|Locked|Reviewed again|Retain (as|only)|Superseded|Explicitly required|Required (that|same|thread-by-thread)|Forced exact|Keep existing step|Reported|Captured|Acknowledged|Tracked|Promoted|Demoted|Closed out|Marked)\b/.test(text)) return true;
        // Lane / gate / closeout / output= jargon.
        if (/\b(lane-closing|bundled operations|blocker-based closeout|gate line|output=(yes|no)|in-thread artifact|scorpion-live-transcript|proposal-brief-builder|kickoff gate|mirrored-diff)\b/i.test(text)) return true;
        const tIdCount = (text.match(/\bT-\d{2,}\b/g) ?? []).length;
        return tIdCount >= 1 || text.length > 180;
      }

      function trimTitle(text: string, max = 120): string {
        const clean = text.replace(/\s+/g, ' ').trim();
        return clean.length > max ? clean.slice(0, max) + '…' : clean;
      }

      // Tasks. Most tasks in this file are agent-tracked operational
      // commitments (lane closures, blocker tracking, etc.) that aren't
      // meaningful for a user "what's on my plate" view. Filter by
      // content shape rather than priority — the autonomy loop tags
      // everything as !!high, so priority is unreliable here.
      let pendingTaskCount = 0;
      let completedTaskCount = 0;
      if (fs.existsSync(TASKS_FILE)) {
        const body = fs.readFileSync(TASKS_FILE, 'utf-8');
        const tasks = parseTasks(body);
        for (const t of tasks) {
          const isAgentNoise = looksAgentTracked(t.description);
          if (t.status === 'pending') {
            pendingTaskCount++;
            if (isAgentNoise) continue;
            const title = trimTitle(t.description || '(untitled task)', 120);
            agenda.push({
              kind: 'task',
              title,
              meta: [t.id, t.priority === 'high' ? '!!high' : '', t.dueDate ? `📅 ${t.dueDate}` : '', t.project ? `#${t.project}` : ''].filter(Boolean).join(' · '),
              sortKey: 800,
            });
          } else if (t.status === 'completed') {
            completedTaskCount++;
            if (isAgentNoise) continue;
            const title = trimTitle(t.description || '(untitled task)', 120);
            done.push({
              kind: 'task',
              title,
              meta: t.id,
              sortKey: 500,
            });
          }
        }
      }

      // Executions — active work is high-signal, surface above tasks.
      // We skip cron-spawned + autonomy-prompt-shaped executions; those
      // are agent self-management, not user-facing items.
      let hiddenAgentExecs = 0;
      try {
        const executionStore = new ExecutionStore();
        const all = executionStore.list(50);
        for (const exec of all) {
          const rawTitle = exec.title || exec.objective || '(execution)';
          if (looksAgentTracked(rawTitle)) {
            hiddenAgentExecs++;
            continue;
          }
          const title = trimTitle(rawTitle);
          if (exec.status === 'active' || exec.status === 'paused' || exec.status === 'blocked') {
            agenda.push({
              kind: 'exec',
              title,
              meta: exec.nextStep ? `next: ${trimTitle(exec.nextStep, 80)}` : exec.status,
              sortKey: 1500,
            });
          } else if (exec.status === 'completed' && exec.updatedAt && exec.updatedAt.startsWith(today)) {
            done.push({
              kind: 'exec',
              title,
              meta: `completed ${exec.updatedAt.slice(11, 16)}`,
              sortKey: 1500,
            });
          }
        }
      } catch { /* ignore — execution store may not exist yet */ }

      // Open check-ins — these are waiting on the user, surface FIRST.
      try {
        const open = listOpenCheckIns();
        for (const c of open) {
          agenda.push({
            kind: 'checkin',
            title: c.question || '(check-in)',
            meta: c.urgency !== 'normal' ? `[${c.urgency}] asked ${c.askedAt.slice(11, 16)}` : `asked ${c.askedAt.slice(11, 16)}`,
            sortKey: 2000,
          });
        }
      } catch { /* ignore */ }

      // Sort highest-sortKey first (user-flavored, recent, high-priority).
      agenda.sort((a, b) => b.sortKey - a.sortKey);
      done.sort((a, b) => b.sortKey - a.sortKey);

      res.json({
        agenda: agenda.slice(0, 15).map(({ sortKey, ...rest }) => rest),
        done: done.slice(0, 10).map(({ sortKey, ...rest }) => rest),
        // Counts so the dashboard can show "X total" + "+ N more" hints.
        totals: {
          pendingTasks: pendingTaskCount,
          completedTasks: completedTaskCount,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Chat-with-Clementine endpoint for the Home panel. Wraps
   * assistant.respond with a stable session id so the conversation
   * carries across reloads.
   */

  /**
   * Server-Sent Events stream of every action the daemon takes —
   * tool calls, run lifecycle events, approval transitions,
   * notifications, execution state changes. The dashboard's right
   * rail subscribes here for sub-second visibility. Persistence
   * still lives in the underlying JSON stores (runs.json,
   * approvals.json, notifications.json) — this is a fan-out signal
   * layer only.
   *
   * On connect we emit a single `replay` event with the last 20
   * run events + every pending approval + the most recent 10
   * notifications so the rail isn't blank for users who arrive
   * after the daemon was already busy. Then live events stream
   * through the action-bus subscription.
   */
  app.get('/api/console/actions/stream', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    const writeEvent = (eventName: string, payload: unknown): void => {
      if (closed || res.destroyed) return;
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Replay buffer: pull the last 20 run events, currently-pending
    // approvals, and recent notifications from disk so the client
    // can render history immediately.
    try {
      const replayRunEvents: ActionEvent[] = [];
      const recentRuns = listRuns(30);
      for (const run of recentRuns) {
        for (const event of run.events.slice(-3)) {
          replayRunEvents.push({
            kind: 'run.event',
            runId: run.id,
            sessionId: run.sessionId,
            runTitle: run.title,
            runStatus: run.status,
            event,
          });
        }
      }
      replayRunEvents.sort((a, b) => {
        if (a.kind !== 'run.event' || b.kind !== 'run.event') return 0;
        return a.event.createdAt.localeCompare(b.event.createdAt);
      });
      const replayHarnessEvents: ActionEvent[] = [];
      const recentHarnessSessions = listHarnessSessions({ limit: 25 }).filter(isConsoleVisibleHarnessSession);
      for (const session of recentHarnessSessions) {
        const events = listHarnessEvents(session.id, { limit: 500, desc: true })
          .filter((event) => CONSOLE_HARNESS_REPLAY_TYPES.has(event.type))
          .slice(-8);
        for (const event of events) {
          replayHarnessEvents.push({
            kind: 'harness.event',
            sessionId: session.id,
            event,
            session: summarizeSessionForSignal(session),
          });
        }
      }
      replayHarnessEvents.sort((a, b) => actionEventTime(a).localeCompare(actionEventTime(b)));
      const replayTimeline = [
        ...replayRunEvents.slice(-20),
        ...replayHarnessEvents.slice(-30),
      ].sort((a, b) => actionEventTime(a).localeCompare(actionEventTime(b)));
      const replay: ActionEvent[] = [
        ...replayTimeline.slice(-40),
        ...assistant.getRuntime().listPendingApprovals().map((approval) => ({
          kind: 'approval.created' as const,
          approval,
        })),
        ...listNotifications(10).map((notification) => ({
          kind: 'notification.created' as const,
          notification,
        })),
      ];
      writeEvent('replay', replay);
    } catch (err) {
      writeEvent('replay', []);
    }

    const unsubscribe = actionBus.subscribe((event) => {
      writeEvent(event.kind, event);
    });

    // Heartbeat every 15s. Some proxies (and Electron's net stack
    // under certain configs) drop idle keep-alive connections after
    // ~30s — a comment ping keeps the channel warm without showing
    // up as an event in the client.
    const heartbeat = setInterval(() => {
      if (closed || res.destroyed) return;
      res.write(`: ping\n\n`);
    }, 15_000);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  /**
   * Operational telemetry query — the 100%-observability read API (Phase A).
   * Returns the canonical operational_events (workflow/model/workspace/memory/
   * safety/tool) filtered by source/type/workspace/run/session/since. Read-only;
   * fail-open store. The dashboard observability panel + audits query this.
   */
  const OPERATIONAL_SOURCES: ReadonlySet<string> = new Set<OperationalEventSource>([
    'workflow', 'model', 'workspace', 'memory', 'safety', 'tool', 'harness', 'scheduler',
  ]);
  app.get('/api/console/telemetry', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const q = req.query as Record<string, string | undefined>;
      const opts: ListOperationalEventsOptions = {};
      if (q.source && OPERATIONAL_SOURCES.has(q.source)) opts.source = q.source as OperationalEventSource;
      if (q.type && isOperationalEventType(q.type)) opts.type = q.type;
      if (q.workspaceId) opts.workspaceId = q.workspaceId;
      if (q.workflowRunId) opts.workflowRunId = q.workflowRunId;
      if (q.sessionId) opts.sessionId = q.sessionId;
      if (q.since) opts.since = q.since;
      const limitRaw = q.limit ? Number(q.limit) : NaN;
      if (Number.isFinite(limitRaw)) opts.limit = Math.max(1, Math.min(limitRaw, 1000));
      res.json({ events: listOperationalEvents(opts) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Trace Lab — deterministic harness trace reconstruction from harness.db.
   * Unlike the live operational feed, this is complete per-session audit history
   * suitable for replay previews and regression debugging.
   */
  const TRACE_KINDS = new Set(['chat', 'execution', 'workflow', 'agent']);
  const TRACE_STATUSES = new Set(['active', 'paused', 'completed', 'failed', 'cancelled', 'any']);
  app.get('/api/console/traces', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const q = req.query as Record<string, string | undefined>;
      const opts: ListTraceOptions = {};
      const limitRaw = q.limit ? Number(q.limit) : NaN;
      if (Number.isFinite(limitRaw)) opts.limit = Math.max(1, Math.min(limitRaw, 200));
      if (q.kind && TRACE_KINDS.has(q.kind)) opts.kind = q.kind as ListTraceOptions['kind'];
      if (q.status && TRACE_STATUSES.has(q.status)) opts.status = q.status as ListTraceOptions['status'];
      res.json({ traces: listTraceSummaries(opts) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/traces/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const trace = buildTraceDetail(String(req.params.id ?? ''));
      if (!trace) { res.status(404).json({ error: 'trace not found' }); return; }
      res.json({ trace });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/traces/:id/replay-preview', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const replay = buildTraceReplayPreview(String(req.params.id ?? ''));
      if (!replay) { res.status(404).json({ error: 'trace not found' }); return; }
      res.json({ replay });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Operational telemetry live stream (SSE). Replays the most recent operational
   * events on connect, then forwards every new `operational.event` from the
   * action bus — the real-time operator view of tool calls, workflow node
   * transitions, model routing, memory consolidation, and safety guards.
   */
  app.get('/api/console/telemetry/stream', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    const writeEvent = (eventName: string, payload: unknown): void => {
      if (closed || res.destroyed) return;
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const sourceFilter = typeof req.query.source === 'string' && OPERATIONAL_SOURCES.has(req.query.source)
        ? (req.query.source as OperationalEventSource) : undefined;
      // Replay oldest→newest so the client renders a forward-ordered timeline.
      const replay = listOperationalEvents({ source: sourceFilter, limit: 50 }).reverse();
      writeEvent('replay', replay);
    } catch {
      writeEvent('replay', []);
    }

    const unsubscribe = actionBus.subscribe((event) => {
      if (event.kind !== 'operational.event') return;
      writeEvent('operational.event', event);
    });

    const heartbeat = setInterval(() => {
      if (closed || res.destroyed) return;
      res.write(`: ping\n\n`);
    }, 15_000);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  /**
   * Per-session harness event stream.
   *
   * Used by the desktop chat and the Discord bot to watch a long-
   * running 0.3 harness conversation. Each connection:
   *   1. Replays existing events for this session from SQLite, so
   *      subscribers that connect mid-run render history immediately.
   *   2. Subscribes to actionBus and forwards every 'harness.event'
   *      matching this sessionId.
   *   3. Heartbeats every 15s so proxies/Electron don't close the
   *      idle keep-alive.
   *
   * Query params:
   *   ?sinceSeq=N  — only replay events with seq > N (resume mode).
   */
  app.get('/api/sessions/:sessionId/events', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const sessionId = req.params.sessionId;
    const session = getHarnessSession(sessionId);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }
    const sinceSeqRaw = typeof req.query.sinceSeq === 'string' ? Number(req.query.sinceSeq) : 0;
    const sinceSeq = Number.isFinite(sinceSeqRaw) && sinceSeqRaw > 0 ? sinceSeqRaw : 0;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    const writeEvent = (eventName: string, payload: unknown): void => {
      if (closed || res.destroyed) return;
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // 1) Replay existing events. Cap at 500 so a very long session
    // doesn't flood the initial frame; subscribers can reconnect
    // with ?sinceSeq= for older slices if needed.
    try {
      const replay = listHarnessEvents(sessionId, { sinceSeq, limit: 500 });
      writeEvent('replay', { sessionId, sessionStatus: session.status, events: replay });
    } catch (err) {
      writeEvent('replay', { sessionId, events: [], error: (err as Error).message });
    }

    // 2) Live subscription.
    const unsubscribe = actionBus.subscribe((event) => {
      if (event.kind !== 'harness.event') return;
      if (event.sessionId !== sessionId) return;
      writeEvent('event', event.event);
    });

    // 3) Heartbeat. The existing console-actions stream uses 15s.
    const heartbeat = setInterval(() => {
      if (closed || res.destroyed) return;
      res.write(`: ping\n\n`);
    }, 15_000);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  /**
   * JSON replay fallback for the chat dock. EventSource can fail before
   * exposing an HTTP status to the renderer (auth cookie race, transient
   * network restart, sleeping tab), and the previous UI would remain on
   * "Clem is starting up..." even though the backend had completed the
   * run. This endpoint lets the client poll/replay the same session
   * events over normal fetch auth and recover the visible turn.
   */
  app.get('/api/sessions/:sessionId/events/recent', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const sessionId = req.params.sessionId;
    const session = getHarnessSession(sessionId);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }
    const sinceSeqRaw = typeof req.query.sinceSeq === 'string' ? Number(req.query.sinceSeq) : 0;
    const sinceSeq = Number.isFinite(sinceSeqRaw) && sinceSeqRaw > 0 ? sinceSeqRaw : 0;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 500;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 500;
    try {
      const events = listHarnessEvents(sessionId, { sinceSeq, limit });
      res.json({
        sessionId,
        sessionStatus: session.status,
        latestSeq: getLatestHarnessEventSeq(sessionId),
        events,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/harness-sessions/:sessionId/cancel', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const sessionId = req.params.sessionId;
    const session = getHarnessSession(sessionId);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }
    try {
      requestHarnessKill(sessionId, 'cancelled from desktop command center');
      const harnessSession = HarnessSession.load(sessionId);
      const { listPending: listPendingApprovals, resolve: resolveApproval } =
        await import('../runtime/harness/approval-registry.js');
      const pending = listPendingApprovals({ sessionId, status: 'pending' });
      for (const row of pending) {
        resolveApproval(row.approvalId, 'cancelled_by_user', 'desktop-command-center');
      }
      try {
        harnessSession?.clearInterruptState();
        harnessSession?.markStatus('cancelled');
      } catch { /* best effort */ }
      appendHarnessEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'conversation_completed',
        data: {
          summary: 'Cancelled from the desktop command center.',
          reason: 'cancelled_by_user',
          approvalsCancelled: pending.length,
        },
      });
      res.json({ ok: true, sessionId, cancelledApprovals: pending.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Re-authenticate Codex via the DAEMON's proven native OAuth flow (the same
   * path as `clementine auth login-native`). The desktop RE-AUTHENTICATE button
   * calls this instead of the Electron-side codex-oauth.ts port — one OAuth
   * implementation, no divergence, and it writes Clementine's OWN vault only
   * (loginWithNativeOAuth no longer touches ~/.codex/auth.json). The request
   * awaits the full browser flow (the daemon opens the browser + runs the
   * localhost callback), so the button shows a spinner until the user finishes
   * signing in; loginWithNativeCodexOAuth caps the wait at 15 min.
   */
  app.post('/api/console/auth/codex-login', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const result = await loginWithNativeOAuth();
      if (result.ok) {
        // Clear in-app confirmation (the button label flips for only ~2s and is
        // easy to miss). Also clears the 'codex-auth-revoked' alert's relevance.
        try {
          addNotification({
            id: `codex-reauth-success-${new Date().toISOString()}`,
            kind: 'system',
            title: 'Codex sign-in refreshed',
            body: 'Clementine re-authenticated with ChatGPT/Codex. You can resume where you left off.',
            createdAt: new Date().toISOString(),
            read: false,
            metadata: { reason: 'codex_reauth_success' },
          });
        } catch { /* notification is best-effort */ }
      }
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * REMOTE re-authentication via the OpenAI device-code flow. Unlike
   * /api/console/auth/codex-login (which opens a browser + binds a loopback
   * callback ON THE DAEMON, so it only works for someone physically at the
   * machine), this works from any device: begin() returns a short code + a URL
   * to display (link/QR); the user signs in on their phone/laptop; the client
   * polls until the daemon has the tokens. No loopback, no tunnel redirect — the
   * same flow the Codex CLI's `--device-auth` and Hermes use. PKCE/poll handles
   * stay server-side keyed by loginId.
   */
  app.post('/api/console/auth/codex-device/begin', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const start = await beginCodexDeviceLogin();
      res.json(start);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/auth/codex-device/poll', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const loginId = typeof req.body?.loginId === 'string' ? req.body.loginId : '';
    if (!loginId) { res.status(400).json({ error: 'loginId required' }); return; }
    try {
      const result = await pollCodexDeviceLogin(loginId);
      if (result.status === 'complete') {
        try {
          addNotification({
            id: `codex-reauth-success-${new Date().toISOString()}`,
            kind: 'system',
            title: 'Codex sign-in refreshed',
            body: 'Clementine re-authenticated with ChatGPT/Codex (device code). You can resume where you left off.',
            createdAt: new Date().toISOString(),
            read: false,
            metadata: { reason: 'codex_reauth_success' },
          });
        } catch { /* notification is best-effort */ }
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });

  // Claude (Anthropic) subscription OAuth login — PKCE paste-the-code, peer to
  // the Codex device flow. Flow state (verifier+state) held in-memory, 15-min
  // TTL. The pasted code exchanges to an oat01 subscription token stored in our
  // own vault (decoupled from the Claude Code CLI login).
  const claudeLoginFlows = new Map<string, { verifier: string; state: string; createdAt: number }>();
  app.post('/api/console/auth/claude/begin', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { authorizeUrl, verifier, state } = beginClaudeLogin();
      const flowId = randomBytes(16).toString('hex');
      for (const [k, v] of claudeLoginFlows) if (Date.now() - v.createdAt > 15 * 60_000) claudeLoginFlows.delete(k);
      claudeLoginFlows.set(flowId, { verifier, state, createdAt: Date.now() });
      res.json({ flowId, authorizeUrl });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/console/auth/claude/complete', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const flowId = typeof req.body?.flowId === 'string' ? req.body.flowId : '';
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const flow = claudeLoginFlows.get(flowId);
    if (!flow) { res.status(400).json({ error: 'Login flow expired or not found — start the Claude sign-in again.' }); return; }
    if (!code.trim()) { res.status(400).json({ error: 'Paste the code from the Claude authorize page.' }); return; }
    try {
      const tokens = await completeClaudeLogin(code, flow.verifier, flow.state);
      saveClaudeTokens(tokens);
      claudeLoginFlows.delete(flowId);
      resetHarnessRuntimeConfig(); // re-register the Claude provider on the next run
      resetClaudeModelCache(); // drop the cached (pre-login) token so the new grant takes effect immediately
      res.json({ ok: true, snapshot: getClaudeAuthSnapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Switch the active brain (Codex ↔ Claude) LIVE — no daemon restart. Persists
  // AUTH_MODE to .env (survives restart) AND mutates process.env so the harness'
  // fresh-reading getActiveAuthMode() picks it up on the very next turn (chat,
  // workflow, and Discord all call configureHarnessRuntime() per-run). Switching
  // TO Claude fail-closes exactly as the harness does — a missing/expired token
  // or an api03 API key is refused BEFORE we persist, so a user is never
  // stranded on an unusable brain nor silently pay-per-token billed.
  app.patch('/api/console/settings/active-brain', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const raw = typeof req.body?.brain === 'string' ? req.body.brain : '';
      const brain = raw === 'claude_oauth' ? 'claude_oauth' : raw === 'codex_oauth' ? 'codex_oauth' : raw === 'api_key' ? 'api_key' : '';
      if (!brain) { res.status(400).json({ error: 'brain must be "codex_oauth", "claude_oauth", or "api_key" (a BYO model).' }); return; }
      // Optional: which SPECIFIC connected BYO model orchestrates (so any provider's
      // model — e.g. a Together AI model in an extra slot — can be the brain, not
      // just the default slot). The router routes this id to its owning provider.
      const brainModelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';

      // A BYO brain runs all-in (every role on the BYO backend unless a role is
      // bound elsewhere); a Codex/Claude brain cannot coexist with all-in, so step
      // it down to 'off' (BYO providers stay connected and routable via role pins).
      if (brain === 'api_key') {
        if (!getByoBackendConfig().configured) {
          res.status(409).json({ error: 'No BYO model is configured. Add one under Settings → Models → Connected models first.', needsLogin: true });
          return;
        }
        // Pin the chosen model as the brain. Validate it against the eligible set
        // (every connected, configured BYO model) so a stale/unknown id can't be
        // written. Empty modelId → clear the override (default slot is the brain).
        if (brainModelId) {
          const eligible = brainOptions().some((o) => o.id === 'api_key' && o.modelId === brainModelId);
          if (!eligible) {
            res.status(400).json({ error: `Model "${brainModelId}" is not a connected BYO model. Add it to a provider in Settings → Models first.` });
            return;
          }
          updateEnvKey('BYO_BRAIN_MODEL_ID', brainModelId);
          process.env.BYO_BRAIN_MODEL_ID = brainModelId;
        } else {
          removeEnvKey('BYO_BRAIN_MODEL_ID');
          delete process.env.BYO_BRAIN_MODEL_ID;
        }
        updateEnvKey('MODEL_ROUTING_MODE', 'all_in');
        process.env.MODEL_ROUTING_MODE = 'all_in';
      } else {
        // Switching to a Codex/Claude brain: drop the BYO brain-model override so a
        // later switch back to a BYO brain doesn't silently reuse a stale model.
        removeEnvKey('BYO_BRAIN_MODEL_ID');
        delete process.env.BYO_BRAIN_MODEL_ID;
        if (getModelRoutingMode() === 'all_in') {
          updateEnvKey('MODEL_ROUTING_MODE', 'off');
          process.env.MODEL_ROUTING_MODE = 'off';
        }
        if (brain === 'codex_oauth') {
          // A Codex brain orchestrates with a gpt-5.x model. Two jobs:
          //  (1) honor an explicit model pick from the brain dropdown
          //      (value `codex_oauth:<id>` → brainModelId), e.g. gpt-5.5; and
          //  (2) SCRUB any BYO model id that leaked into the OPENAI_MODEL_* slots
          //      (e.g. glm-5.2 from a prior BYO brain) back to the Codex default —
          //      otherwise the "Codex" brain resolves to (and the router sends it to)
          //      the BYO endpoint, or codexSafePrimary pins it to the gpt-5.4 fallback
          //      forever. A valid gpt-5.x slot is left exactly as-is.
          const wantedPrimary = /^gpt-5/i.test(brainModelId) ? brainModelId : '';
          for (const key of ['OPENAI_MODEL_PRIMARY', 'OPENAI_MODEL_FAST', 'OPENAI_MODEL_DEEP', 'OPENAI_MODEL_WORKER'] as const) {
            const cur = (getRuntimeEnv(key, '') || '').trim();
            const polluted = cur !== '' && resolveProvider(cur) !== 'codex';
            const next = key === 'OPENAI_MODEL_PRIMARY' && wantedPrimary
              ? wantedPrimary
              : (polluted ? DEFAULT_CODEX_MODEL : cur);
            if (next && next !== cur) { updateEnvKey(key, next); process.env[key] = next; }
          }
        }
      }

      if (brain === 'claude_oauth') {
        // A Claude brain orchestrates with a specific Claude model. Honor an
        // explicit pick from the brain dropdown (value `claude_oauth:<id>` →
        // brainModelId, e.g. claude-sonnet-5) by persisting CLAUDE_MODEL, which
        // getClaudeBrainModel() reads. Validate it's a real Claude model so a
        // stale/unknown id can't be written; an empty/non-Claude id leaves the
        // current CLAUDE_MODEL (default Opus) untouched.
        if (brainModelId && resolveProvider(brainModelId) === 'claude') {
          const eligible = brainOptions().some((o) => o.id === 'claude_oauth' && o.modelId === brainModelId);
          if (!eligible) {
            res.status(400).json({ error: `Model "${brainModelId}" is not a connected Claude model.` });
            return;
          }
          updateEnvKey('CLAUDE_MODEL', brainModelId);
          process.env.CLAUDE_MODEL = brainModelId;
        }
        // Preflight BEFORE persisting; refresh a near-expiry vault token so the
        // harness' own sync check at configure-time also passes next turn.
        try {
          await loadFreshClaudeAccessToken();
        } catch (err) {
          const kind = err instanceof ClaudeAuthError ? err.kind : 'missing';
          res.status(409).json({
            error: err instanceof Error ? err.message : 'Claude subscription auth is not ready.',
            kind,
            needsLogin: true,
          });
          return;
        }
      }

      updateEnvKey('AUTH_MODE', brain);
      process.env.AUTH_MODE = brain; // so getActiveAuthMode() reflects it THIS session

      // Force the next harness turn to re-register the chosen provider, and drop
      // brain-specific caches so a Codex→Claude→Codex round-trip leaves no stale
      // provider/client behind.
      resetHarnessRuntimeConfig();
      resetClaudeModelCache();
      resetByoModelCache();
      clearAutonomyAgentCache();

      res.json({ activeBrain: getActiveAuthMode(), claudeAuth: getClaudeAuthSnapshot() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Role→model binding write path (worker + judge). The BRAIN is a provider
  // LOGIN switch — set it via /settings/active-brain — so this route handles the
  // model-within bindings that live in CLEMMY_MODEL_ROLES. Clearing (no modelId
  // or clear:true) reverts the role to its provider-derived default. The judge
  // also keeps the claude-vs-codex branch (CLEMMY_DEBATE_JUDGE) in sync with the
  // chosen model's provider so resolveDebateBrains actually routes there.
  app.patch('/api/console/settings/models/roles', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const body = (req.body ?? {}) as { role?: unknown; modelId?: unknown; whenIntent?: unknown; clear?: unknown };
      const role = (body.role === 'worker' || body.role === 'judge') ? (body.role as ModelRole) : '';
      if (!role) {
        res.status(400).json({ error: 'role must be "worker" or "judge" (set the brain via /settings/active-brain)' });
        return;
      }
      const cleanId = (v: unknown): string => {
        const s = typeof v === 'string' ? v.trim() : '';
        return /^[A-Za-z0-9._:/-]*$/.test(s) ? s : '';
      };
      const rawModelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
      const modelId = cleanId(body.modelId);
      if (rawModelId && !modelId) { res.status(400).json({ error: 'modelId contains unsupported characters.' }); return; }
      // Optional intent scope ("design", "writing", …) — same slug form the chat
      // tool (set_model_role) writes, so Settings and chat share one binding store.
      const whenIntentRaw = typeof body.whenIntent === 'string' ? body.whenIntent.trim() : '';
      const slug = whenIntentRaw ? slugifyIntent(whenIntentRaw) : '';
      if (whenIntentRaw && !slug) { res.status(400).json({ error: 'whenIntent is empty after normalization' }); return; }
      const clear = body.clear === true || rawModelId === '';
      if (!clear && !modelId) { res.status(400).json({ error: 'modelId required (or clear:true to reset to default)' }); return; }
      if (!clear) {
        const validation = validateRoleModelBinding(role, modelId);
        if (!validation.ok) { res.status(400).json({ error: validation.reason }); return; }
      }

      // Upsert the binding. An intent-scoped binding (whenIntent) routes only that
      // user-named category (e.g. "design") to the model; a role-wide binding (no
      // whenIntent) is the role default. Both write to the SAME CLEMMY_MODEL_ROLES
      // store the chat tool uses, so Settings and chat stay one source of truth.
      const current = readDurableBindings();
      const next: RoleBinding[] = slug
        ? current.filter((b) => !(b.role === role && b.whenIntent && slugifyIntent(b.whenIntent) === slug))
        : current.filter((b) => !(b.role === role && !b.whenIntent));
      if (!clear) {
        next.push(slug
          ? { role, modelId, whenIntent: slug, scope: 'durable', source: 'settings' }
          : { role, modelId, scope: 'durable', source: 'settings' });
      }
      updateEnvKey('CLEMMY_MODEL_ROLES', JSON.stringify(next));

      // The fusion judge BRANCH is GLOBAL (which provider reconciles), so only a
      // role-WIDE judge binding flips it — an intent-scoped judge rule must not.
      if (role === 'judge' && !slug) {
        if (clear) {
          updateEnvKey('CLEMMY_DEBATE_JUDGE', '');
          delete process.env.CLEMMY_DEBATE_JUDGE;
        } else {
          const prov = resolveProvider(modelId);
          const branch = prov === 'codex' ? 'codex' : 'claude';
          updateEnvKey('CLEMMY_DEBATE_JUDGE', branch);
          process.env.CLEMMY_DEBATE_JUDGE = branch;
        }
      }

      // Re-resolve next turn (no restart).
      resetHarnessRuntimeConfig();
      resetClaudeModelCache();
      resetByoModelCache();
      clearAutonomyAgentCache();

      res.json({ modelRoles: buildModelRolesSnapshot() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Fusion (multi-model) settings — a LIVE toggle (no daemon restart).
   * CLEMMY_DEBATE_MODE picks how often Second opinion runs
   * (off | high-stakes | all). The main Settings UI leaves the judge provider
   * on the automatic role resolver; legacy callers can still pass `judge` to pin
   * CLEMMY_DEBATE_JUDGE explicitly.
   * updateEnvKey persists it, process.env makes it live this session, and
   * resetHarnessRuntimeConfig forces the next turn's configureHarnessRuntime to
   * re-register so maybeWrapDebate re-evaluates fusion on/off.
   */
  app.patch('/api/console/settings/fusion', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const body = (req.body ?? {}) as { mode?: unknown; judge?: unknown; strategy?: unknown };
      const rawMode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : '';
      const mode = rawMode === 'all' ? 'all' : rawMode === 'high' ? 'high' : 'off';
      const rawJudge = typeof body.judge === 'string' ? body.judge.trim().toLowerCase() : '';
      const hasJudge = rawJudge.length > 0;
      const judge = hasJudge && rawJudge === 'codex' ? 'codex' : 'claude';
      const rawStrategy = typeof body.strategy === 'string' ? body.strategy.trim().toLowerCase() : '';
      const strategy = rawStrategy === 'debate' ? 'debate' : 'verify';

      updateEnvKey('CLEMMY_DEBATE_MODE', mode);
      process.env.CLEMMY_DEBATE_MODE = mode;
      if (hasJudge) {
        updateEnvKey('CLEMMY_DEBATE_JUDGE', judge);
        process.env.CLEMMY_DEBATE_JUDGE = judge;
      }
      updateEnvKey('CLEMMY_FUSION_STRATEGY', strategy);
      process.env.CLEMMY_FUSION_STRATEGY = strategy;

      // Reconcile ONLY the old claude↔codex Fusion judge control. If the role
      // card/chat pinned the judge to the OTHER flagship, drop that binding so
      // this control stays truthful; KEEP a same-provider model pin (e.g. Opus
      // over default Sonnet). NEVER drop a BYO judge binding — it isn't
      // representable by this 2-valued control, and resolveDebateBrains
      // dispatches it by its own provider regardless of CLEMMY_DEBATE_JUDGE.
      // (Before this guard, every FusionForm Save silently destroyed it.)
      if (hasJudge) {
        const bindings = readDurableBindings();
        const nextBindings = bindings.filter((b) => {
          if (!(b.role === 'judge' && !b.whenIntent)) return true;
          const prov = resolveProvider(b.modelId);
          if (prov === 'byo') return true;
          return prov === judge;
        });
        if (nextBindings.length !== bindings.length) {
          updateEnvKey('CLEMMY_MODEL_ROLES', JSON.stringify(nextBindings));
        }
      }

      // Re-register the provider next turn so debate wrapping flips on/off live.
      resetHarnessRuntimeConfig();

      const brains = debateBrainsAvailable();
      res.json({
        fusion: {
          mode: debateMode(),
          judge: judgeChoice(),
          judgeRole: resolveRoleModel('judge'),
          strategy: fusionStrategy(),
          brainsAvailable: brains,
          active: mode !== 'off' && ((brains.claude && brains.codex) || verifyJudgeAvailable()),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Fusion observability — recent debate traces (both drafts + divergence + the
   * judge's final) plus live fusion status, for a "Fusion" view in the console.
   * Read-only and best-effort: tolerates an absent/partial trace file.
   */
  app.get('/api/console/debate-traces', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '40'), 10) || 40));
      const brains = debateBrainsAvailable();
      res.json({
        fusion: {
          mode: debateMode(),
          judge: judgeChoice(),
          judgeRole: resolveRoleModel('judge'),
          strategy: fusionStrategy(),
          brainsAvailable: brains,
          active: debateMode() !== 'off' && ((brains.claude && brains.codex) || verifyJudgeAvailable()),
        },
        traces: readRecentDebateTraces(limit),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * File attachment upload + convert. The composer POSTs the raw file bytes
   * (application/octet-stream) with ?name=… so the global 1mb JSON parser is
   * bypassed; we use a route-scoped raw parser at 30mb. The file is ingested
   * (saved + converted to Markdown via the markitdown runtime) and stored in
   * the inbox; the returned id is included in the next /api/harness/chat send.
   */
  app.post('/api/attach', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const name = typeof req.query.name === 'string' ? req.query.name : 'attachment';
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    const bytes = Buffer.isBuffer(req.body) && req.body.length > 0 ? (req.body as Buffer) : undefined;
    if (!bytes && !url) { res.status(400).json({ error: 'file bytes or url required' }); return; }
    try {
      const ingested = await ingestAttachment(bytes ? { name, bytes } : { name, url });
      const id = saveIngestedToInbox(ingested);
      res.json({
        id,
        name: ingested.name,
        ok: !ingested.error,
        error: ingested.error ?? null,
        chars: ingested.markdown?.length ?? 0,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Background-mode harness chat handler.
   *
   * The desktop UI and Discord bot POST here to start (or continue)
   * a 0.3 conversation. The response returns immediately with a
   * session id + the SSE stream URL — execution happens in the
   * background. The caller renders progress by subscribing to
   * `/api/sessions/:sessionId/events`.
   *
   * Request body:
   *   { input: string, sessionId?: string }
   *
   * Response (202 Accepted):
   *   { sessionId, streamUrl, status: 'started' }
   *
   * If auth (codex OAuth) is missing, returns 412 with the message
   * the CLI already prints; the caller surfaces it as a banner.
   */
  app.post('/api/harness/chat', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }

    const body = req.body ?? {};
    const input = typeof body.input === 'string' ? body.input.trim() : '';
    const attachmentIds: string[] = Array.isArray(body.attachments)
      ? body.attachments.filter((a: unknown): a is string => typeof a === 'string').slice(0, 10)
      : [];
    if (!input && attachmentIds.length === 0) { res.status(400).json({ error: 'input required' }); return; }

    const existingId = typeof body.sessionId === 'string' ? body.sessionId : '';
    let session = existingId ? getHarnessSession(existingId) : null;
    const freshSession = !session;
    // A Workspace's floating dock binds a STABLE per-workspace session id
    // (space-<slug>) so the dock + re-engage share one continuous thread — but
    // that session may not exist until the first message. Create it with the
    // given id instead of 404ing. Other unknown ids are still rejected (don't
    // resurrect arbitrary sessions).
    if (existingId && !session && /^space-[a-z0-9][a-z0-9-]*$/.test(existingId)) {
      const seed = input || (attachmentIds.length ? 'Attached file' : 'Workspace');
      session = createHarnessSession({
        id: existingId,
        kind: 'chat',
        title: seed.length > 80 ? `${seed.slice(0, 77)}...` : seed,
        metadata: { source: 'workspace', spaceSlug: existingId.slice('space-'.length) },
      });
    }
    if (existingId && !session) { res.status(404).json({ error: 'session not found' }); return; }
    if (!session) {
      const titleSeed = input || (attachmentIds.length ? 'Attached file' : '');
      session = createHarnessSession({
        kind: 'chat',
        title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
        metadata: { source: 'desktop' },
      });
    }

    const auth = await configureHarnessRuntime();
    if (!auth.ok) { res.status(412).json({ error: auth.reason }); return; }

    const sessionId = session.id;
    const streamUrl = `/api/sessions/${sessionId}/events`;

    // /cancel, /new, and /continue commands — handled BEFORE the
    // approval-resume path so a user typing "cancel" gets to abandon
    // the pause instead of being routed through reject. /continue
    // is the T1.3 graceful-continue path: when the loop hits a step
    // or wall-clock budget, it emits a "Reply `continue` to keep
    // going" message; the user typing `continue` rewrites the prompt
    // into a structured continuation directive and falls through to
    // the normal turn path.
    const command = parseHarnessCommand(input);
    if (command === 'cancel') {
      const harnessSessionForCancel = HarnessSession.load(sessionId);
      const sinceSeq = getLatestHarnessEventSeq(sessionId);
      const { listPending: listPendingApprovals, resolve: resolveApproval } =
        await import('../runtime/harness/approval-registry.js');
      const pending = listPendingApprovals({ sessionId, status: 'pending' });
      let cancelledCount = 0;
      for (const row of pending) {
        const r = resolveApproval(row.approvalId, 'cancelled_by_user', 'chat-dock-user');
        if (r.ok) cancelledCount++;
      }
      try {
        harnessSessionForCancel?.clearInterruptState();
        harnessSessionForCancel?.markStatus('cancelled');
      } catch { /* best effort */ }
      const { appendEvent } = await import('../runtime/harness/eventlog.js');
      try {
        appendEvent({
          sessionId,
          turn: 0,
          role: 'system',
          type: 'conversation_completed',
          data: {
            summary: cancelledCount > 0
              ? `Cancelled. Abandoned ${cancelledCount} pending approval${cancelledCount === 1 ? '' : 's'}. Send a new message to start fresh.`
              : 'Cancelled. Session cleared. Send a new message to start fresh.',
            reason: 'cancelled_by_user',
            approvalsCancelled: cancelledCount,
          },
        });
      } catch { /* best effort */ }
      res.status(202).json({ sessionId, streamUrl, status: 'cancelled', mode: 'command', sinceSeq });
      return;
    }
    if (command === 'new') {
      // The chat-dock client owns the sessionId reference, so /new is
      // a hint to start a fresh session on the next message. Confirm
      // and return; the next POST without sessionId creates a new one.
      const { appendEvent } = await import('../runtime/harness/eventlog.js');
      const sinceSeq = getLatestHarnessEventSeq(sessionId);
      try {
        appendEvent({
          sessionId,
          turn: 0,
          role: 'system',
          type: 'conversation_completed',
          data: {
            summary: 'Fresh session ready. Your next message will start a new conversation.',
            reason: 'new_requested',
          },
        });
      } catch { /* best effort */ }
      res.status(202).json({ sessionId, streamUrl, status: 'new-pending', mode: 'command', sinceSeq });
      return;
    }

    // /continue — rewrite the bare keyword into a structured
    // continuation directive when the session's last completion was
    // a limit/continue completion. Falls through to the
    // normal turn path with the rewritten input.
    let turnInput = input;
    if (command === 'continue') {
      const { isContinueCompletionReason, readLastConversationCompletion } = await import('../channels/discord-harness.js');
      const lastCompletion = readLastConversationCompletion(sessionId);
      if (lastCompletion && isContinueCompletionReason(lastCompletion.reason)) {
        const summaryHint = lastCompletion.lastDecisionSummary
          ? `Your last summary on the prior turn was: "${lastCompletion.lastDecisionSummary.slice(0, 400)}".`
          : 'Use the conversation history above to figure out where you were.';
        turnInput = [
          'You hit a step / time budget on the previous turn and the user has now replied `continue`.',
          'Pick up where you left off; do not restart the workflow from scratch.',
          summaryHint,
          'Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.',
        ].join('\n\n');
      }
    }

    // Fold any attachments (uploaded files, resolved from the inbox by id) and
    // pasted YouTube links into the agent-facing turn. `input` stays raw for
    // command/title/intent parsing; only `turnInput` carries the converted
    // content so the agent sees the file/video contents inline.
    {
      const ingested: IngestedAttachment[] = attachmentIds
        .map((id) => loadInboxAttachment(id))
        .filter((a): a is IngestedAttachment => a !== null);
      for (const url of extractYouTubeUrls(input).slice(0, 3)) {
        ingested.push(await ingestAttachment({ name: url, url }));
      }
      if (ingested.length > 0) {
        turnInput = foldAttachmentsIntoMessage(turnInput, ingested);
      }
    }

    // If this session is paused on an SDK approval interrupt and the
    // user's message is an approve/reject intent, take the RESUME path
    // instead of starting a new turn. Mirrors the Discord-side
    // tryHandleHarnessApprovalReply pattern — without this, the chat
    // dock had no way to resume a paused session, the SEND button sat
    // in THINKING forever, and the user couldn't continue the workflow.
    const harnessSession = HarnessSession.load(sessionId);
    // Workspace dock: seed a one-time context primer (idempotent by prefix) so
    // Clem knows WHICH Workspace this thread is about and how to edit it.
    // Without it the dock is a contextless generic assistant (it asked "which
    // app? send me the file path" instead of knowing it's this Workspace).
    if (harnessSession && /^space-[a-z0-9][a-z0-9-]*$/.test(sessionId)) {
      try {
        // Single source of truth for BOTH lanes — buildWorkspaceContextPrimer is
        // the same primer the Claude SDK lane appends to its system prompt. (Was a
        // hardcoded copy here, which drifted: a primer rewrite missed the Codex
        // lane until this was collapsed.)
        const slug = sessionId.slice('space-'.length);
        const primer = buildWorkspaceContextPrimer(slug);
        if (primer) harnessSession.setContextPrimer('[workspace-context]', primer);
      } catch { /* best-effort primer */ }
    }
    const isPausedOnApproval = !!harnessSession && !!harnessSession.loadInterruptState();
    // The Agent SDK brain lane pauses in the approval registry (its still-alive
    // query() awaits a poll), NOT in RunState. Detect that separately so a typed
    // approve/reject resolves the registry row instead of trying (and failing) to
    // rehydrate a RunState that does not exist.
    const sdkApprovalPending = !isPausedOnApproval
      && approvalRegistry.listPending({ sessionId, status: 'pending' }).length > 0;
    const intent = (isPausedOnApproval || sdkApprovalPending) ? parseApprovalIntent(input) : null;
    const sinceSeq = getLatestHarnessEventSeq(sessionId);
    const autonomy = loadProactivityPolicy().autoApproveScope;
    const planFirst = !intent && shouldUsePlanFirst({ input: turnInput, freshSession, autonomy });

    res.status(202).json({
      sessionId,
      streamUrl,
      status: intent ? 'resuming' : planFirst ? 'planning' : 'started',
      mode: intent ? `approval-${intent.decision}` : planFirst ? 'plan-first' : 'fresh',
      sinceSeq,
    });

    setImmediate(async () => {
      try {
        // /goal slash command (goal-contract P3): pin/inspect/cancel the
        // session's parked goal. status/cancel are reply-only; start/resume
        // swap the run input so work begins immediately on the normal loop.
        const goalCmd = !intent ? parseGoalCommand(turnInput) : null;
        let goalRunInput: string | null = null;
        if (goalCmd) {
          const outcome = handleGoalContractCommand({ command: goalCmd, sessionId, channel: 'desktop' });
          if (!outcome.runInput) {
            appendHarnessEvent({
              sessionId,
              turn: 0,
              role: 'Clem',
              type: 'conversation_completed',
              data: { reason: 'goal_command', summary: outcome.reply, reply: outcome.reply, steps: 0 },
            });
            return;
          }
          goalRunInput = outcome.runInput;
        }
        if (!intent) {
          const continuity = await routeOpenQuestionPlan({
            channel: 'desktop',
            input: turnInput,
            sessionId,
            autonomy,
            // Surface continuity notes (workflow resumed, set-aside, re-ask)
            // into the desktop stream the same way the cancel path does, so
            // desktop reaches parity with Discord's sendFollowup.
            sendNote: async (message: string) => {
              try {
                appendHarnessEvent({
                  sessionId,
                  turn: 0,
                  role: 'system',
                  type: 'conversation_completed',
                  data: { summary: message, reason: 'plan_continuity_note', steps: 0 },
                });
              } catch { /* note is best-effort */ }
            },
          });
          if (continuity.handled) return;
        }
        // Durable background promotion (gap C1): explicit durable asks AND
        // high-confidence unattended data pipelines go to the daemon's durable
        // lane instead of an ephemeral in-process run. The task then survives a
        // window close / daemon restart, surfaces on the Tasks board, and reports
        // back into THIS session on completion (originSessionId). Plain asks fall
        // through to the normal foreground run below. The intent decision runs on
        // the RAW `input` (not attachment-folded `turnInput`) so dropped-file
        // contents can't trip it; the FULL `turnInput` is what the worker receives.
        // Skips approval-resume, a session paused on approval, and /goal runs.
        if (!intent && !isPausedOnApproval && !goalRunInput && shouldPromoteToDurable(input)) {
          const task = enqueueDurableChatTask({
            message: turnInput,
            sessionId,
            channel: 'desktop',
            source: 'desktop',
          });
          const queuedReply = renderDurableTaskQueued(task);
          appendHarnessEvent({
            sessionId,
            turn: 0,
            role: 'Clem',
            type: 'conversation_completed',
            data: {
              reason: 'queued_background',
              summary: queuedReply,
              reply: queuedReply,
              steps: 0,
              queuedTaskId: task.id,
            },
          });
          return;
        }
        // Stream CLEAN text, not raw structured-output JSON: extract the
        // reply (chat decisions) / objective+actions (streamed plans) as
        // they form. Non-JSON model output emits nothing — the final reply
        // always lands via conversation_completed.
        const emitToken = (delta: string) => {
          actionBus.emit({
            kind: 'harness.event',
            sessionId,
            event: {
              seq: 0,
              sessionId,
              turn: 0,
              role: 'assistant',
              type: 'stream_token',
              data: { delta },
            } as any,
          });
        };
        const onChunk = createJsonFieldStreamer(['reply', 'objective', 'action'], emitToken);
        // A /goal start already pinned its goal — skip plan-first and run
        // the objective directly on the normal loop.
        if (planFirst && !goalRunInput) {
          const preflight = await runPlanFirstPreflight({
            input: turnInput,
            sessionId,
            channel: 'desktop',
            freshSession,
            autonomy,
            onChunk,
          });
          if (preflight.surfaced) return;
        }
        const effectiveInput = goalRunInput ?? turnInput;
        if (intent && harnessSession && session?.kind === 'workflow') {
          // A workflow session's RunState deserializes only under the
          // WorkflowStep agent — driving the resume here with the chat
          // orchestrator fails AND clears the interrupt state the workflow
          // runner needs (approval treadmill). Resolve the approvals and let
          // the runner resume with the right agent (same rule as Discord's
          // tryHandleHarnessApprovalReply and the /harness-approvals route).
          const resolution = intent.decision === 'approve' ? 'approved' : 'rejected';
          const resolvedIds: string[] = [];
          for (const row of approvalRegistry.listPending({ sessionId, status: 'pending' })) {
            const r = approvalRegistry.resolve(row.approvalId, resolution, 'chat-dock-user');
            if (r.ok) resolvedIds.push(row.approvalId);
          }
          appendHarnessEvent({
            sessionId,
            turn: 0,
            role: 'Clem',
            type: 'conversation_completed',
            data: {
              reason: 'workflow_approval_resolved',
              summary: `${resolution} ${resolvedIds.join(', ') || '(no pending approvals)'} — the workflow resumes on its own`,
              reply: `${resolution === 'approved' ? 'Approved' : 'Rejected'} — the workflow picks this up and resumes by itself.`,
              steps: 0,
            },
          });
          return;
        }
        // Agent SDK brain lane: a paused run awaits in the approval registry (no
        // RunState interrupt). A typed approve/reject resolves the registry row;
        // the original still-alive query() picks it up via its poll and continues,
        // delivering its own final reply. Do NOT runConversationFromResume here —
        // there is no RunState to rehydrate (that would fail + clear state).
        if (intent && sdkApprovalPending) {
          const resolution = intent.decision === 'approve' ? 'approved' : 'rejected';
          let resolved = 0;
          for (const row of approvalRegistry.listPending({ sessionId, status: 'pending' })) {
            const r = approvalRegistry.resolve(row.approvalId, resolution, 'chat-dock-user');
            if (r.ok) resolved += 1;
          }
          appendHarnessEvent({
            sessionId,
            turn: 0,
            role: 'Clem',
            type: 'conversation_step',
            data: {
              reason: 'sdk_approval_resolved',
              summary: resolved > 0
                ? `${resolution === 'approved' ? 'Approved' : 'Rejected'} — continuing.`
                : '(no pending approval to resolve)',
              steps: 0,
            },
          });
          return;
        }
        // Agentic Claude brain lane (claude_oauth + CLEMMY_CLAUDE_AGENT_SDK_BRAIN):
        // run the turn through the official Anthropic Agent SDK on the user's Claude
        // subscription. The SDK owns its own tool loop; mutations route through the
        // harness gate chain (gated-mutating-tools) + the async approval gate
        // (claude-agent-approval). The brain emits its OWN terminal events —
        // conversation_completed (desktop SSE stream + session history) and
        // runtime.completed (Tasks board / report-back / watchdog) — so we do NOT
        // emit conversation_completed here. A second one double-renders the reply on
        // reopen, since reconstructHarnessTranscript maps each conversation_completed
        // to its own assistant turn. Flag-gated + auth-gated, so Codex / API-key
        // users are byte-identical (branch never taken).
        if (!intent && claudeAgentSdkBrainEnabled('home')) {
          // Stream brain text deltas to the desktop SSE (raw — the brain emits
          // plain prose, not the {reply,…} JSON the field-streamer parses).
          // Final reply still arrives via the conversation_completed event.
          const brainReq = {
            message: effectiveInput,
            sessionId,
            channel: 'desktop',
            userId: 'desktop',
            onChunk: emitToken,
          };
          try {
            await respondPreferHarness('home', brainReq, (req) => respondViaClaudeAgentSdkBrain('home', req));
          } catch (err) {
            appendHarnessEvent({
              sessionId,
              turn: 0,
              role: 'system',
              type: 'run_failed',
              data: {
                error: err instanceof Error ? err.message : String(err),
                stage: 'respond_bridge',
              },
            });
          }
          return;
        }
        if (intent && harnessSession) {
          const agent = await buildOrchestratorAgent({ userInput: effectiveInput, sessionId });
          await runConversationFromResume({
            agent,
            sessionId,
            decision: intent.decision,
            resolver: 'chat-dock-user',
            onChunk,
          });
          return;
        }
        // Non-Claude brains (codex/GLM/BYO) route through the SAME bridge spine
        // as every other chat surface — turn_model_routed marker, mid-run brain
        // fallover wiring, and the parse-exhaustion recovery that re-runs a
        // no_structured_output dead turn on the next brain instead of shipping
        // the "couldn't be structured" apology. Previously this path called
        // runConversation directly, so the desktop dock was the ONE chat
        // surface without that recovery (live incident 2026-07-03, codex
        // salesforce turn). The legacy closure preserves the old direct call as
        // the bridge's own pre-run fallback (surface flag off / unenforceable
        // excludes / auth not ready) — never taken after a harness run starts.
        await respondPreferHarness(
          'home',
          { message: effectiveInput, sessionId, channel: 'desktop', userId: 'desktop', onChunk },
          async (req) => {
            const agent = await buildOrchestratorAgent({ userInput: req.message, sessionId });
            const result = await runConversation({ agent, sessionId, input: req.message, judgeCompletion: true, onChunk });
            const replyText = (result.lastDecision?.reply && result.lastDecision.reply.trim())
              ? result.lastDecision.reply
              : (result.lastDecision?.summary ?? '');
            return { text: replyText, sessionId };
          },
        );
      } catch (err) {
        // The loop emits its own run_failed when a turn throws. If we
        // got here, the throw happened BEFORE any turn started
        // (typically inside buildOrchestratorAgent / handoff catalog
        // build). Emit run_failed so the SSE stream surfaces it.
        const message = err instanceof Error ? err.message : String(err);
        try {
          appendHarnessEvent({
            sessionId,
            turn: 0,
            role: 'system',
            type: 'run_failed',
            data: { error: message, stage: 'pre_first_turn' },
          });
        } catch {
          // last-ditch — swallow to avoid an unhandled rejection
        }
      }
    });
  });

  app.post('/api/console/home/chat/stream', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) { res.status(400).json({ error: 'message required' }); return; }

    // Resolve the conversation id. Back-compat: a missing sessionId keeps
    // the single rolling 'console:home' (legacy console + voice). The new
    // React console always supplies a per-conversation id. Reject internal
    // ids so the desktop can't hijack cron:/agent:/execution: sessions.
    const requestedId = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, 120) : '';
    if (requestedId && isInternalSessionId(requestedId)) {
      res.status(400).json({ error: 'invalid sessionId' });
      return;
    }
    const sessionId = requestedId || 'console:home';

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => { closed = true; });
    const writeEvent = (event: Record<string, unknown>) => {
      if (closed || res.destroyed) return;
      res.write(`${JSON.stringify(event)}\n`);
    };

    try {

      writeEvent({ type: 'status', text: 'Clementine run started.' });
      const streamReq: AssistantRequest = {
        message,
        sessionId,
        channel: 'cli',
        userId: 'console',
        onChunk: (delta) => {
          writeEvent({ type: 'chunk', delta });
        },
        onToolActivity: (activity) => {
          writeEvent({
            type: 'tool',
            toolName: activity.toolName,
            input: activity.input,
          });
        },
        onReasoning: (text) => {
          writeEvent({ type: 'status', text: text || 'Clementine is planning the next step.' });
        },
        shouldCancel: () => closed,
      };
      const response = await respondPreferHarness('home', streamReq, (req) => assistant.respond(req));
      const route = routeDiagnosticsFromResponse(response);
      writeEvent({
        type: 'done',
        sessionId,
        text: response.text,
        pendingApprovalId: response.pendingApprovalId ?? null,
        // Surface why the run stopped so the dashboard can render the
        // right affordance ([Continue] for max-turns-with-grace, etc.).
        stoppedReason: response.stoppedReason ?? 'success',
        turnsUsed: response.turnsUsed ?? null,
        route: route ?? null,
      });
      res.end();
    } catch (err) {
      writeEvent({ type: 'error', error: err instanceof Error ? err.message : String(err) });
      res.end();
    }
  });

  /**
   * Trim-control endpoint — the dashboard's Usage panel posts here to
   * toggle individual cost sources without the user having to hand-edit
   * config files. Currently supports:
   *   - cron jobs (enable/disable individual entries in CRON.md)
   *   - proactivity policy (enable/disable proactive briefs)
   * Each toggle is reversible and never disables chat/harness — only
   * paces or pauses the cost-heavy background loops.
   */
  app.post('/api/console/usage/trim', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const action = typeof body.action === 'string' ? body.action : '';
    const target = typeof body.target === 'string' ? body.target : '';
    try {
      if (kind === 'cron') {
        // Toggle a cron job's `enabled` flag inside CRON.md frontmatter.
        const mat = (await import('gray-matter')).default;
        const cronPath = path.join(BASE_DIR, 'vault', '00-System', 'CRON.md');
        if (!existsSync(cronPath)) { res.status(404).json({ error: 'CRON.md not found' }); return; }
        const parsed = mat(readFileSync(cronPath, 'utf-8'));
        const jobs = Array.isArray((parsed.data as { jobs?: unknown }).jobs)
          ? (parsed.data as { jobs: Record<string, unknown>[] }).jobs
          : [];
        const job = jobs.find((j) => j.name === target);
        if (!job) { res.status(404).json({ error: 'cron job not found' }); return; }
        job.enabled = action === 'enable';
        fs.writeFileSync(cronPath, mat.stringify(parsed.content, parsed.data), 'utf-8');
        res.json({ ok: true, name: target, enabled: job.enabled });
        return;
      }
      if (kind === 'proactivity') {
        const file = path.join(BASE_DIR, 'state', 'proactivity-policy.json');
        if (!existsSync(file)) { res.status(404).json({ error: 'proactivity-policy.json not found' }); return; }
        const policy = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
        policy.enabled = action === 'enable';
        fs.writeFileSync(file, JSON.stringify(policy, null, 2), 'utf-8');
        res.json({ ok: true, enabled: policy.enabled });
        return;
      }
      res.status(400).json({ error: 'unknown trim kind' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * List trim targets currently available (cron jobs + proactivity state).
   * Used by the Usage panel to render the "Trim Controls" rows so they
   * always reflect the latest enabled-state without the user reloading.
   */
  app.get('/api/console/usage/trim', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const mat = (await import('gray-matter')).default;
      const cronPath = path.join(BASE_DIR, 'vault', '00-System', 'CRON.md');
      const crons: Array<{ name: string; schedule: string; enabled: boolean }> = [];
      if (existsSync(cronPath)) {
        const parsed = mat(readFileSync(cronPath, 'utf-8'));
        const jobs = Array.isArray((parsed.data as { jobs?: unknown }).jobs)
          ? (parsed.data as { jobs: Record<string, unknown>[] }).jobs
          : [];
        for (const job of jobs) {
          crons.push({
            name: String(job.name ?? ''),
            schedule: String(job.schedule ?? ''),
            enabled: job.enabled !== false,
          });
        }
      }
      const proacFile = path.join(BASE_DIR, 'state', 'proactivity-policy.json');
      const proactivityEnabled = existsSync(proacFile)
        ? Boolean((JSON.parse(readFileSync(proacFile, 'utf-8')) as { enabled?: boolean }).enabled)
        : false;
      res.json({ crons, proactivityEnabled });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Token-usage rollup for the Usage panel. Reads today's NDJSON log
   * and aggregates into a dashboard-friendly shape. Cheap — single
   * day's data is at most a few thousand lines.
   */
  app.get('/api/console/usage', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      // Lazy-import so dashboard-routes doesn't take a hard dep at
      // module load time. Same pattern as other recent dashboard reads.
      const { readUsageEventsForDate, rollupUsage, listUsageDates } = await import('../runtime/usage-log.js');
      const dateParam = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? new Date(req.query.date + 'T00:00:00')
        : new Date();
      const events = readUsageEventsForDate(dateParam);
      const rollup = rollupUsage(events, dateParam);
      res.json({
        date: dateParam.toISOString().slice(0, 10),
        availableDates: listUsageDates(),
        ...rollup,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Auto-compact summary for the Usage panel. Counts compactions in the
   * last 24h across all sessions, summarizes layers / tokens / hallucinated
   * call_ids, and lists the most recent 8 with per-session detail. Used
   * by the dashboard "AUTO-COMPACT" block under Usage.
   */
  app.get('/api/console/usage/compaction', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const { openEventLog } = await import('../runtime/harness/eventlog.js');
      const db = openEventLog();
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rows = db.prepare(
        `SELECT session_id, data_json, created_at FROM events
         WHERE type = 'condenser_applied' AND created_at >= ?
         ORDER BY seq DESC
         LIMIT 200`,
      ).all(since) as Array<{ session_id: string; data_json: string; created_at: string }>;

      let totalClipped = 0;
      let totalSummaries = 0;
      let hallucinatedCallIds = 0;
      const recent: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        let d: { layer1?: { applied?: boolean; clipped?: number }; layer2?: { applied?: boolean; removedItems?: number; hallucinatedCallIds?: string[] }; layer3?: { forkRequested?: boolean }; beforeTokens?: number; afterTokens?: number } = {};
        try { d = JSON.parse(row.data_json) as typeof d; } catch { /* ignore */ }
        const l1Clipped = d.layer1?.clipped ?? 0;
        const l2Removed = d.layer2?.removedItems ?? 0;
        const hallucinated = (d.layer2?.hallucinatedCallIds ?? []).length;
        totalClipped += l1Clipped;
        if (d.layer2?.applied) totalSummaries += 1;
        hallucinatedCallIds += hallucinated;
        recent.push({
          sessionId: row.session_id,
          at: row.created_at,
          layer1: Boolean(d.layer1?.applied),
          layer1Clipped: l1Clipped,
          layer2: Boolean(d.layer2?.applied),
          layer2RemovedItems: l2Removed,
          layer3: Boolean(d.layer3?.forkRequested),
          beforeTokens: d.beforeTokens ?? null,
          afterTokens: d.afterTokens ?? null,
        });
      }

      // Recall invocations: count tool_called events for recall_tool_result.
      let recallInvocations = 0;
      try {
        const r = db.prepare(
          `SELECT COUNT(*) AS c FROM events
           WHERE type = 'tool_called'
             AND created_at >= ?
             AND json_extract(data_json, '$.tool') = 'recall_tool_result'`,
        ).get(since) as { c?: number } | undefined;
        recallInvocations = r?.c ?? 0;
      } catch {
        recallInvocations = 0;
      }

      res.json({
        totalCompactions: rows.length,
        totalClipped,
        totalSummaries,
        hallucinatedCallIds,
        recallInvocations,
        recent,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Cheap goal-state read for the dashboard's nav-dock GOAL card.
   *
   * The card used to refresh by POSTing `/goal status` to /chat every
   * 5 seconds — a full LLM turn + 4 status-list tool calls per fetch.
   * Observed today: 6097 cumulative tool calls and roughly 1700 LLM
   * turns on a single dashboard session because the user left the
   * window open all day. Reading the goal state file directly is
   * free and gives the dock all the data it needs.
   */
  app.get('/api/console/home/goal-status', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      // Goal-contract store read (goal-loop.ts deleted in goal-contract P3).
      // Shape kept legacy-compatible for the home dock card.
      const { getActiveGoalForSession } = await import('../agents/plan-proposals.js');
      const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.trim()
        ? req.query.sessionId.trim().slice(0, 120)
        : 'console:home';
      const goal = getActiveGoalForSession(sessionId);
      const plan = goal ? (goal.approvedPlan ?? goal.plan) : null;
      res.json({
        goal: goal && plan
          ? {
              sessionId,
              objective: plan.objective,
              status: 'pursuing',
              turnsUsed: goal.attempt ?? 0,
              turnsLimit: goal.maxAttempts ?? 3,
              startedAt: goal.proposedAt,
              updatedAt: goal.lastActivityAt ?? goal.proposedAt,
            }
          : null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/home/chat', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = req.body ?? {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) { res.status(400).json({ error: 'message required' }); return; }
    const requestedId = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, 120) : '';
    if (requestedId && isInternalSessionId(requestedId)) {
      res.status(400).json({ error: 'invalid sessionId' });
      return;
    }
    const sessionId = requestedId || 'console:home';
    // Background needs_input round-trip: if exactly one background task is parked
    // on a clarifying question for THIS chat, route the user's reply as the
    // answer and resume it (mirrors how an approval button short-circuits). Only
    // fires while a task is parked here, so the mis-route window is narrow.
    const parkedTask = findSoleAwaitingInputTaskForOrigin(sessionId);
    if (parkedTask?.pendingQuestionId) {
      queueBackgroundTaskInputResolution(parkedTask.pendingQuestionId, message);
      res.json({
        sessionId,
        text: `Got it — I passed that to your background task "${parkedTask.title}". It's resuming now and will report back here when it's done.`,
      });
      return;
    }
    if (/^\/?(continue|resume|keep going)$/i.test(message)) {
      const continueTask = findSoleAwaitingContinueTaskForOrigin(sessionId);
      if (continueTask) {
        queueBackgroundTaskContinue(continueTask.id);
        res.json({
          sessionId,
          text: `Continuing background task "${continueTask.title}". It will report back here when it's done.`,
        });
        return;
      }
    }
    // User-initiated "background it" control (Claude Code ctrl+b model): push the
    // currently-running foreground task to the background on demand, freeing the
    // chat. Handled here (before the model) so it works even mid-run.
    if (detectBackgroundItIntent(message)) {
      const detached = detachRunningTurnToBackground(sessionId);
      if (detached) {
        res.json({ sessionId, text: detached.text });
        return;
      }
    }
    try {
      // FORK collapse (staged): interactive console home chat through the gated
      // harness loop (judgeCompletion ON for desktop/Discord parity). Default-OFF
      // `home` staging surface → byte-identical to legacy until
      // CLEMMY_HARNESS_HOME=on, then live-verified + baked in.
      const response = await respondPreferHarness(
        'home',
        { message, sessionId, channel: 'cli', userId: 'console' },
        (req) => assistant.respond(req),
      );
      res.json({ sessionId, text: response.text, pendingApprovalId: response.pendingApprovalId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Unified Conversations API ─────────────────────────────────────────
  // One list over both session engines (desktop chats + harness/Discord/
  // workflow), with reopen/continue routing decided per-session by origin.

  app.get('/api/console/sessions', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const sessions = buildUnifiedSessionList({ q, tag, source, includeArchived, limit });
      res.json({ sessions, total: sessions.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/console/sessions/:id', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const detail = getUnifiedSessionDetail(req.params.id);
      if (!detail) { res.status(404).json({ error: 'session not found' }); return; }
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/console/sessions/:id', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const body = req.body ?? {};
      const patch: { title?: string; pinned?: boolean; tags?: string[]; archived?: boolean } = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
      if (typeof body.archived === 'boolean') patch.archived = body.archived;
      if (Array.isArray(body.tags)) patch.tags = body.tags.filter((t: unknown): t is string => typeof t === 'string');
      const updated = patchUnifiedSession(req.params.id, patch);
      if (!updated) { res.status(404).json({ error: 'session not found' }); return; }
      res.json({ session: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/console/sessions/:id', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const hard = req.query.hard === '1' || req.query.hard === 'true';
      const result = deleteUnifiedSession(req.params.id, hard);
      if (!result) { res.status(404).json({ error: 'session not found' }); return; }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Mint a short-lived Realtime client secret for the Electron/browser
   * home voice panel. The renderer never receives the long-lived
   * OpenAI API key; it only receives the ephemeral secret returned by
   * OpenAI's Realtime API.
   */
  app.post('/api/console/realtime/session', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }

    const apiKey = getOpenAiApiKey();
    if (!apiKey) {
      res.status(400).json({
        error: 'Live voice needs the optional OpenAI API key. Codex OAuth can still run the agent; add the key in Settings → Runtime Auth & Capability Keys to enable voice.',
      });
      return;
    }

    const body = req.body ?? {};
    const requestedVoice = typeof body.voice === 'string' ? body.voice : '';
    const requestedModel = typeof body.model === 'string' ? body.model : '';
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
      ? body.sessionId.trim().slice(0, 120)
      : 'console:home';
    const voice = requestedVoice || getRuntimeEnv('OPENAI_REALTIME_VOICE', 'marin');
    const model = requestedModel || getRuntimeEnv('OPENAI_REALTIME_MODEL', 'gpt-realtime');
    const transcriptionModel = getRuntimeEnv('OPENAI_REALTIME_TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe');

    // Turn-taking (VAD) parameters: env vars are the default, but the voice
    // settings UI may override them per-session via the request body. The
    // shared resolver clamps every value to the same safe range as the env
    // path so UI input can never push out-of-range numbers into the session.
    const { vadThreshold, prefixPaddingMs, silenceMs } = resolveRealtimeVad(body, {
      vadThreshold: realtimeNumberEnv('OPENAI_REALTIME_VAD_THRESHOLD', 0.55, 0.1, 0.95),
      prefixPaddingMs: realtimeNumberEnv('OPENAI_REALTIME_PREFIX_PADDING_MS', 350, 0, 1500),
      silenceMs: realtimeNumberEnv('OPENAI_REALTIME_SILENCE_MS', 430, 150, 2000),
    });

    // Client-honored feature flags (kill-switches). The renderer drives the
    // spoken-progress, reconnect/swap, and one-loop behavior, so the server is
    // the single source of truth and hands the resolved flags back in the
    // session payload.
    const voiceProgress = (getRuntimeEnv('CLEMMY_VOICE_PROGRESS', 'off') || 'off').toLowerCase() === 'on';
    const voiceReconnect = (getRuntimeEnv('CLEMMY_VOICE_RECONNECT', 'on') || 'on').toLowerCase() !== 'off';
    // One-loop: the realtime model becomes ears+mouth only and the REAL agent
    // (the chat loop) does the thinking + talking. Off → the legacy persona.
    const voiceOneLoop = (getRuntimeEnv('CLEMMY_VOICE_ONE_LOOP', 'off') || 'off').toLowerCase() === 'on';

    // In one-loop mode the model decides nothing, so it gets a thin voice-
    // delivery instruction instead of the heavy memory/goals context (the
    // brain owns that). The persona path keeps the full injected context.
    const instructions = voiceOneLoop ? VOICE_DELIVERY_INSTRUCTIONS : buildRealtimeVoiceInstructions(sessionId);

    const session = buildRealtimeSessionConfig({
      model,
      voice,
      transcriptionModel,
      instructions,
      vad: { vadThreshold, prefixPaddingMs, silenceMs },
      idleTimeoutMs: realtimeNumberEnv('OPENAI_REALTIME_IDLE_TIMEOUT_MS', 6500, 1000, 30000),
      oneLoop: voiceOneLoop,
    });

    try {
      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(session),
      });

      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }

      if (!response.ok) {
        res.status(response.status).json({
          error: 'Failed to create Realtime client secret.',
          details: payload,
        });
        return;
      }

      res.json({
        ...(payload && typeof payload === 'object' ? payload as Record<string, unknown> : { value: payload }),
        model,
        voice,
        vad: { threshold: vadThreshold, silenceMs, prefixPaddingMs },
        features: { progressUpdates: voiceProgress, reconnect: voiceReconnect, oneLoop: voiceOneLoop },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/console/mcp-servers/:name', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const name = req.params.name;
    try {
      const current = loadUserMcpServers();
      if (!current[name]) { res.status(404).json({ error: 'server not in user overrides' }); return; }
      delete current[name];
      saveUserMcpServers(current);
      await invalidateConfiguredMcpServers();
      clearAutonomyAgentCache();
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
